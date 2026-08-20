/**
 * BotDrive — tank-style drivetrain for a Battle Bots chassis. (T-1.8)
 *
 * DRIVETRAIN MODEL (T-1.7 decision)
 *   Propulsion is a per-step IMPULSE on the chassis body. Wheels are real dynamic
 *   bodies on breakable fixed joints, but they do NOT propel — they exist so they
 *   can be damaged and sheared off (T-5.4). A lost or damaged wheel shows up as a
 *   per-side multiplier, not as a change in traction.
 *   Rejected: revolute wheel joints with velocity motors — four extra motorised
 *   constraints per bot, and drive feel coupled to joint stiffness.
 *
 * DEGRADATION CHANNEL (T-3.6)
 *   `ctx.params.driveLeft` / `driveRight` (0..1) scale each track. DamageSystem
 *   writes them with `scene.setComponent` on this entity's Script component;
 *   params are read fresh every hook, so it lands on the next tick with no
 *   reattach. That is the sanctioned cross-script channel now that per-instance
 *   params exist — no custom events, no encoding state into `Name`, and it
 *   serializes with the scene.
 *
 * PHYSICS ACCESS
 *   `ctx.call(tool, args)` — synchronous, zod-parsed, undo-aware. This replaces
 *   the old `engine.mcp.toolMap` workaround, which reached into a private field
 *   and silently skipped schema defaults.
 *
 * WHY IMPULSES, NOT FORCES
 *   `physics.applyForce` is now genuinely per-step (the accumulator is cleared
 *   after each step), so it would work — but a drivetrain wants an impulse it can
 *   size directly, and `applyTorque` is a torque *impulse* (N·m·s) regardless. We
 *   use impulses for both so the two axes are expressed in the same terms.
 *   Impulse = force x dt, converted at the call site.
 */

// Tuning — named constants so the numbers stay reviewable (T-1.10).
const DRIVE_FORCE = 2200;        // N at full throttle (converted to an impulse)
const TURN_TORQUE = 1500;        // N·m at full yaw (converted to a torque impulse)
const MAX_SPEED = 7.0;           // m/s soft cap; drive fades to zero at it
const MAX_YAW_RATE = 3.0;        // rad/s soft cap on spin
const SELF_RIGHT_IMPULSE = 700;  // N·s upward kick used to un-flip
const SELF_RIGHT_TORQUE = 1600;  // N·m·s roll torque paired with the kick
const SELF_RIGHT_COOLDOWN = 2.0; // s
const UPRIGHT_DOT = 0.35;        // up.y below this means flipped

const BUNDLE_PATH = "/data/bundle.json";

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
  let selfRightTimer = 0;
  let bindingsReady = false;

  /**
   * Input action bindings are RUNTIME state — `input.mapAction` is not serialized
   * with the scene, so a scene load leaves the editor's defaults and none of this
   * game's actions. Applying them here keeps a bot self-sufficient. A proper
   * bootstrap belongs with the scene-flow work (T-6.2); until then this is its home.
   */
  function ensureBindings(call, engine) {
    if (bindingsReady) return;
    bindingsReady = true;
    const existing = call("input.listActions", {}).content || [];
    if (existing.some((a) => a.action === "drive.forward")) return;
    let map = null;
    try {
      map = JSON.parse(call("project.readFile", { path: BUNDLE_PATH }).content.text).inputMap.player1;
    } catch (err) {
      map = null;
    }
    if (!map) return;
    for (const action of Object.keys(map)) {
      call("input.mapAction", { action, codes: map[action] });
    }
    engine.console.log("[BotDrive] applied " + Object.keys(map).length + " input bindings");
  }

  return {
    onStart({ engine, call }) {
      ensureBindings(call, engine);
    },

    onFixedUpdate({ entity, engine, call, dt, params }) {
      const res = call("physics.bodyState", { entity });
      // Before the first play-mode enable the physics provider answers with an
      // isError whose content is a string, not a body — guard on the shape.
      const body = res && !res.isError ? res.content : null;
      if (!body || !body.rotation) return;

      const q = [body.rotation.x, body.rotation.y, body.rotation.z, body.rotation.w];
      const forward = rotate(q, [0, 0, -1]); // chassis nose is -Z
      const up = rotate(q, [0, 1, 0]);
      const input = engine.input;

      // --- tank drive -------------------------------------------------------
      // Input collapses to left/right track throttle, then recombines into a
      // forward and a yaw component, so a future two-stick mapping and this
      // keyboard mapping drive the exact same code path.
      const fwdAxis =
        (input.actionHeld("drive.forward") ? 1 : 0) - (input.actionHeld("drive.back") ? 1 : 0);
      const turnAxis =
        (input.actionHeld("turn.right") ? 1 : 0) - (input.actionHeld("turn.left") ? 1 : 0);

      const scaleL = typeof params.driveLeft === "number" ? params.driveLeft : 1;
      const scaleR = typeof params.driveRight === "number" ? params.driveRight : 1;
      const left = Math.max(-1, Math.min(1, fwdAxis + turnAxis)) * scaleL;
      const right = Math.max(-1, Math.min(1, fwdAxis - turnAxis)) * scaleR;
      const drive = (left + right) * 0.5;
      const yaw = (right - left) * 0.5;

      // --- soft caps --------------------------------------------------------
      const v = body.linearVelocity;
      const speedAlongForward = v.x * forward[0] + v.y * forward[1] + v.z * forward[2];
      const speedFade = Math.max(0, 1 - Math.abs(speedAlongForward) / MAX_SPEED);
      const yawFade = Math.max(0, 1 - Math.abs(body.angularVelocity.y) / MAX_YAW_RATE);

      // Traction only exists while upright — a flipped bot must not scoot.
      const grounded = up[1] > UPRIGHT_DOT;

      if (grounded && drive !== 0) {
        const j = DRIVE_FORCE * drive * speedFade * dt;
        call("physics.applyImpulse", {
          entity,
          impulse: { x: forward[0] * j, y: forward[1] * j, z: forward[2] * j },
        });
      }

      if (grounded && yaw !== 0) {
        call("physics.applyTorque", {
          entity,
          torque: { x: 0, y: TURN_TORQUE * yaw * yawFade * dt, z: 0 },
        });
      }

      // --- self-righting (T-1.12) ------------------------------------------
      if (selfRightTimer > 0) selfRightTimer -= dt;
      if (!grounded && selfRightTimer <= 0 && input.actionHeld("bot.selfRight")) {
        selfRightTimer = SELF_RIGHT_COOLDOWN;
        call("physics.applyImpulse", { entity, impulse: { x: 0, y: SELF_RIGHT_IMPULSE, z: 0 } });
        // Roll about the chassis' own long axis so the kick has a direction.
        const axis = rotate(q, [0, 0, 1]);
        call("physics.applyTorque", {
          entity,
          torque: {
            x: axis[0] * SELF_RIGHT_TORQUE,
            y: axis[1] * SELF_RIGHT_TORQUE,
            z: axis[2] * SELF_RIGHT_TORQUE,
          },
        });
      }
    },
  };
}
