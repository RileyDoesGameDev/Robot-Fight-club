/**
 * WeaponController — spin-up, RPM, energy loss and jam for a powered weapon. (T-3.9)
 *
 * Attached by BotAssembler to any weapon part whose PartDef declares an `axis`
 * and a `targetRpm` (i.e. a powered weapon, not a passive wedge).
 *
 * params:
 *   role      "player" | "opponent" | …  — whose weapon this is
 *   partId    the PartDef id, so stats are read from the bundle
 *   autoSpin  true to hold the weapon at speed without input (the AI opponent
 *             uses this until AiDriver lands in T-3.13)
 *   action    input action that commands spin-up, default "weapon.primary"
 *
 * HOW THE MOTOR IS DRIVEN
 *   The assembler authors the revolute joint with a velocity motor at
 *   `targetVelocity: 0`. This controller finds its own joint by id — it is the
 *   `a` side of its revolute joint — and writes the motor through
 *   `physics.setJointMotor`, which is the runtime path designed for per-step
 *   updates. Patching `Joint.joints[].motor` with `scene.setComponent` would work
 *   but rewrites the authored array every frame, and the physics system would
 *   reconcile a constraint change each time.
 *
 * TWO MODES, ONE INTERFACE (T-4.5)
 *   `stats.mode` picks the actuator. Everything else about a weapon — how it is
 *   commanded, what it reports, how the damage model reads it — is identical, which
 *   is what lets the AI and the input layer treat all four weapons the same way.
 *
 *     spin   (T-3.9, T-4.1)  a revolute VELOCITY motor held at `targetRpm`.
 *                            Horizontal bar spinner and vertical drum.
 *     swing  (T-4.2, T-4.3)  a revolute POSITION motor driven between
 *                            `restAngleRad` and `strikeAngleRad`. Axe and flipper.
 *     (none)                 a passive wedge gets no controller at all — it wins on
 *                            geometry (T-4.4), and there is nothing to actuate.
 *
 *   The shared contract is `battlebots.weaponState.spinFraction`: 0..1 of "how live
 *   is this weapon right now". DamageSystem scales weapon damage by it and knows
 *   nothing about modes. For a spinner that is rpm over target; for a swing weapon
 *   it is 1 during the strike stroke and 0 otherwise, so an axe hits hard for the
 *   ~0.16 s it is falling and is a bar of metal the rest of the time.
 *
 * STATE MACHINE
 *   idle ──command──▶ spinup ──at speed──▶ ready
 *     ▲                 │                   │
 *     └──release────────┴───────────────────┘
 *                       │
 *              rpm collapses while
 *              commanded (after a
 *              grace period)  ──▶ jammed ──cooldown──▶ spinup
 *
 * ENERGY LOSS
 *   `battlebots.weaponHit` (emitted by DamageSystem, which already filters
 *   contacts by role) bleeds `energyLossPerHit` off the *commanded* ramp, so a
 *   weapon that keeps connecting never reaches full speed. Bleeding the command
 *   rather than the body's velocity lets the motor fight back, which is what a
 *   real spinner does.
 *
 * DAMAGE COUPLING (T-3.6)
 *   A `damaged` weapon is capped at `damagedWeaponRpmMultiplier` of target;
 *   a `destroyed` one stops entirely. Tracked from `battlebots.partState`.
 */

const BUNDLE_PATH = "/data/bundle.json";
const RPM_TO_RAD = Math.PI / 30; // rpm → rad/s
const READY_FRACTION = 0.9;      // of commanded speed before we call it "ready"

/** Rotate vector v by quaternion q (x,y,z,w). */
function rotate(q, v) {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}

export default function create() {
  let stats = null;
  let dmg = null;
  let jointId = -1;
  let axis = [0, 1, 0];

  let mode = "spin";        // spin | swing
  let state = "idle";       // idle | spinup | ready | jammed | cocked | striking | recovering
  let swingTimer = 0;       // seconds left in the current swing phase
  let cooldown = 0;         // seconds until the next strike is allowed
  let wasCommanded = false; // edge detection: a swing fires on press, not on hold
  let commandedRpm = 0;     // what we are asking for, before motor slip
  let jamTimer = 0;
  let commandTime = 0;      // how long we have been commanded to spin
  let partState = "intact";
  let offHit = null;
  let offState = null;
  let lastReported = "";

  /** Our joint is the revolute one whose `a` side is this entity. */
  function findJoint(call, entity) {
    const res = call("physics.listJoints", {});
    if (!res || res.isError) return -1;
    const list = Array.isArray(res.content) ? res.content : res.content.joints;
    if (!list) return -1;
    for (const j of list) {
      if (j.a === entity && j.kind === "revolute") return j.id;
    }
    return -1;
  }

  /** Live spin rate in rpm, from the body's angular velocity about the joint axis. */
  function currentRpm(call, entity) {
    const res = call("physics.bodyState", { entity });
    if (!res || res.isError || !res.content || !res.content.angularVelocity) return 0;
    const b = res.content;
    const q = [b.rotation.x, b.rotation.y, b.rotation.z, b.rotation.w];
    const worldAxis = rotate(q, axis); // the axis tilts with the bot
    const w = b.angularVelocity;
    const along = w.x * worldAxis[0] + w.y * worldAxis[1] + w.z * worldAxis[2];
    return Math.abs(along) / RPM_TO_RAD;
  }

  /**
   * `free: true` releases the joint instead of holding it at zero. A velocity
   * motor told to reach 0 rpm with full tracking force is a brake: release measured
   * 1396 -> 1 rpm in under a second. A real spinner coasts, so on release we hand
   * the joint back to friction by zeroing maxForce rather than the target.
   */
  function writeMotor(call, rpm, free) {
    if (jointId < 0) return;
    call("physics.setJointMotor", {
      joint: jointId,
      targetVelocity: free ? 0 : rpm * RPM_TO_RAD,
      maxForce: free ? 0 : (stats.motorMaxForce != null ? stats.motorMaxForce : 500),
      stiffness: 0,
      damping: 0,
    });
  }

  /**
   * Drive the arm to an angle (T-4.2, T-4.3). A POSITION motor rather than a
   * velocity one: a swing weapon is defined by where it starts and where it stops,
   * and asking for an angle lets the solver do the acceleration.
   */
  function writeAngle(call, radians, force) {
    if (jointId < 0) return;
    call("physics.setJointMotorPosition", {
      joint: jointId,
      targetPosition: radians,
      maxForce: force != null ? force : (stats.motorMaxForce != null ? stats.motorMaxForce : 2000),
      stiffness: stats.motorStiffness != null ? stats.motorStiffness : 900,
      damping: stats.motorDamping != null ? stats.motorDamping : 60,
    });
  }

  /** Ceiling on commanded speed, given this weapon's own damage state. */
  function ceilingRpm() {
    if (partState === "destroyed") return 0;
    if (partState === "damaged") return stats.targetRpm * dmg.damagedWeaponRpmMultiplier;
    return stats.targetRpm;
  }

  return {
    onStart({ entity, engine, call, params }) {
      const bundle = JSON.parse(call("project.readFile", { path: BUNDLE_PATH }).content.text);
      dmg = bundle.damage;
      const def = bundle.parts[params.partId];
      stats = (def && def.stats) || {};
      if (stats.axis) axis = stats.axis;

      mode = stats.mode === "swing" ? "swing" : "spin";
      jointId = findJoint(call, entity);
      state = "idle";
      commandedRpm = 0;
      swingTimer = 0;
      cooldown = 0;
      wasCommanded = false;
      if (mode === "swing") writeAngle(call, stats.restAngleRad != null ? stats.restAngleRad : 0);
      else writeMotor(call, 0);

      offHit = engine.mcp.on("battlebots.weaponHit", (p) => {
        if (!p || p.weapon !== entity) return;
        // Bleed the COMMAND, not the body — the motor should have to win it back.
        const loss = stats.energyLossPerHit != null ? stats.energyLossPerHit : 0.3;
        commandedRpm *= 1 - loss;
      });

      offState = engine.mcp.on("battlebots.partState", (p) => {
        if (!p || p.entity !== entity) return;
        partState = p.state;
      });

      engine.console.log("[Weapon] " + (params.role || "?") + " " + params.partId
        + " ready — joint " + jointId + ", mode " + mode
        + (mode === "swing" ? ", arc " + (stats.restAngleRad || 0).toFixed(2) + " -> "
            + (stats.strikeAngleRad || 0).toFixed(2) + " rad"
          : ", target " + stats.targetRpm + " rpm"));
    },

    onDestroy() {
      if (offHit) { offHit(); offHit = null; }
      if (offState) { offState(); offState = null; }
    },

    onFixedUpdate({ entity, engine, call, dt, params }) {
      if (jointId < 0) {
        // The joint may not exist yet on the first frames, or may have sheared off.
        jointId = findJoint(call, entity);
        if (jointId < 0) {
          if (state !== "idle") { state = "idle"; commandedRpm = 0; }
          return;
        }
      }

      // Three command sources, most specific first. `spinCommand` is written by
      // UtilityAi, which manages spin deliberately (hold it up for a charge, drop it
      // to save the motor) — so it has to outrank `autoSpin`, which only ever means
      // "always on" and is now reserved for display roles like the select turntable.
      const commanded = typeof params.spinCommand === "boolean"
        ? params.spinCommand && partState !== "destroyed"
        : params.autoSpin === true
          ? partState !== "destroyed"
          : engine.input.actionHeld(params.action || "weapon.primary");

      // ── swing weapons (T-4.2, T-4.3) ─────────────────────────────────
      // A distinct cycle rather than a special case of the spin machine: a hammer
      // has no notion of "at speed", and a jam means nothing to it.
      if (mode === "swing") {
        const rest = stats.restAngleRad != null ? stats.restAngleRad : 0;
        const strike = stats.strikeAngleRad != null ? stats.strikeAngleRad : 1;
        const dead = partState === "destroyed";
        if (cooldown > 0) cooldown -= dt;
        if (swingTimer > 0) swingTimer -= dt;

        if (dead) {
          // A destroyed arm falls limp; no force, no strike.
          if (state !== "idle") { state = "idle"; writeAngle(call, rest, 0); }
        } else if (state === "striking") {
          if (swingTimer <= 0) {
            state = "recovering";
            swingTimer = stats.recoverSeconds != null ? stats.recoverSeconds : 0.5;
            // Recover gently — hauling the arm back at strike force would let a
            // flipper launch itself off its own return stroke.
            writeAngle(call, rest, (stats.motorMaxForce || 2000) * 0.35);
          }
        } else if (state === "recovering") {
          if (swingTimer <= 0) state = "idle";
        } else if (commanded && cooldown <= 0) {
          // Fires whenever it is commanded and the cooldown has elapsed — NOT on the
          // press edge. Edge-firing was the first build and it was wrong for the AI:
          // UtilityAi holds `spinCommand` for as long as it wants the weapon live, so
          // an axe swung once per engagement instead of once per cooldown. The
          // cooldown is already the rate limit, which makes the edge check redundant
          // for the human too.
          state = "striking";
          swingTimer = stats.strikeSeconds != null ? stats.strikeSeconds : 0.15;
          cooldown = stats.cooldownSeconds != null ? stats.cooldownSeconds : 1;
          const damagedForce = partState === "damaged" ? dmg.damagedWeaponRpmMultiplier : 1;
          writeAngle(call, strike, (stats.motorMaxForce || 2000) * damagedForce);
          engine.mcp.emit("battlebots.weaponSwing", { entity, role: params.role, arc: strike - rest });
        }
        wasCommanded = commanded;

        // The shared contract: 1 while the stroke is live, 0 otherwise. This is what
        // makes an axe a burst weapon in the damage model without the damage model
        // knowing what an axe is.
        const live = state === "striking" ? 1 : 0;
        const tag = state + ":" + live;
        if (tag !== lastReported) {
          lastReported = tag;
          engine.mcp.emit("battlebots.weaponState", {
            entity, role: params.role, state, rpm: 0, commandedRpm: 0, partState,
            spinFraction: live,
          });
        }
        return;
      }

      const ceiling = ceilingRpm();
      const rpm = currentRpm(call, entity);

      if (state === "jammed") {
        jamTimer -= dt;
        commandedRpm = 0;
        writeMotor(call, 0, true);
        if (jamTimer <= 0) state = commanded ? "spinup" : "idle";
      } else if (!commanded || ceiling <= 0) {
        // Released: ramp the command DOWN rather than cutting it. Zeroing the
        // motor does not coast — a velocity motor told to reach 0 is a brake, and
        // `maxForce: 0` did not release the joint either (measured: 1396 -> 1 rpm
        // in well under a second). A scripted spin-down is deterministic, tunable,
        // and reads correctly on screen.
        commandTime = 0;
        const downPerSecond = stats.spinDownSeconds > 0
          ? stats.targetRpm / stats.spinDownSeconds
          : stats.targetRpm;
        commandedRpm = Math.max(0, commandedRpm - downPerSecond * dt);
        state = commandedRpm > 1 ? "spindown" : "idle";
        writeMotor(call, commandedRpm, commandedRpm <= 1);
      } else {
        commandTime += dt;
        const rampPerSecond = stats.spinUpSeconds > 0 ? stats.targetRpm / stats.spinUpSeconds : stats.targetRpm;
        commandedRpm = Math.min(ceiling, commandedRpm + rampPerSecond * dt);
        writeMotor(call, commandedRpm);

        // Stall detection: commanded for longer than the grace period but the
        // blade is barely turning — something is holding it.
        // Stall is RELATIVE: the blade is far below what we are asking for. An
        // absolute rpm threshold false-positives on any target whose ramp has not
        // yet passed it within the grace period — a 400 rpm weapon would jam on
        // every spin-up while a 1400 rpm one would not.
        const grace = stats.spinUpGraceSeconds != null ? stats.spinUpGraceSeconds : 0.8;
        const jamFraction = stats.jamFraction != null ? stats.jamFraction : 0.35;
        const floor = stats.jamThresholdRpm != null ? stats.jamThresholdRpm : 150;
        const stalled = commandedRpm > floor && rpm < commandedRpm * jamFraction;
        if (commandTime > grace && stalled) {
          state = "jammed";
          jamTimer = stats.jamCooldownSeconds != null ? stats.jamCooldownSeconds : 1.5;
          commandTime = 0;
          commandedRpm = 0;
          writeMotor(call, 0, true);
          engine.mcp.emit("battlebots.weaponJammed", { entity, role: params.role, rpm });
        } else {
          state = rpm >= commandedRpm * READY_FRACTION && commandedRpm > 0 ? "ready" : "spinup";
        }
      }

      // Report only on change, so the HUD (T-6.11) can listen cheaply.
      const tag = state + ":" + Math.round(rpm / 25);
      if (tag !== lastReported) {
        lastReported = tag;
        engine.mcp.emit("battlebots.weaponState", {
          entity, role: params.role, state, rpm: Math.round(rpm),
          commandedRpm: Math.round(commandedRpm), partState,
          // Damage scales with how fast the blade is ACTUALLY turning. The collider
          // is the swept disc, so it makes contact even when stopped — without this
          // a dead blade would hit as hard as a live one.
          spinFraction: stats.targetRpm > 0 ? Math.min(1, rpm / stats.targetRpm) : 0,
        });
      }
    },
  };
}
