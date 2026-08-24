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
 * WHO COMMANDS IT
 *   `params.inputDriven: true` reads the keyboard — that is a human's bot. The
 *   BINDINGS themselves are applied by MatchDirector, not here (T-2.26): they are
 *   a global registry that must exist before any bot does, and a bot is the wrong
 *   owner for it.
 *   `params.playerIndex` (1 or 2) picks WHICH human: player 2's actions are the
 *   same names behind a `p2.` prefix, so one code path serves both and the two key
 *   sets cannot collide (T-6.6).
 *   Otherwise it reads `params.intent = { throttle, turn, selfRight }`, written by a
 *   decision layer such as AiDriver. Keeping actuation here means the drive tuning
 *   that was measured in week 1 lives in exactly one place; the AI supplies only
 *   *what* to do, never *how*. That is the split T-3.13 asks for, so the week-5
 *   Utility AI replaces the decision layer without touching this file.
 *
 * MOTOR TRADEOFF (T-4.10)
 *   `params.driveForceMultiplier` / `turnTorqueMultiplier` / `maxSpeedMultiplier` come
 *   from the fitted motor PartDef, resolved by BotAssembler. Sprint drive trades turn
 *   rate for speed, Grinder drive the reverse. They are params rather than a lookup
 *   here so this file stays a pure actuator with one tuning source.
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

  return {
    onFixedUpdate({ entity, engine, call, dt, params }) {
      const res = call("physics.bodyState", { entity });
      // Before the first play-mode enable the physics provider answers with an
      // isError whose content is a string, not a body — guard on the shape.
      // A body can also come back with a rotation but no velocities (seen on the
      // first fixed step after assembly, before the body joins the physics world),
      // so check every field this hook dereferences, not just the first one.
      const body = res && !res.isError ? res.content : null;
      if (!body || !body.rotation || !body.linearVelocity || !body.angularVelocity) return;

      const q = [body.rotation.x, body.rotation.y, body.rotation.z, body.rotation.w];
      const forward = rotate(q, [0, 0, -1]); // chassis nose is -Z
      const up = rotate(q, [0, 1, 0]);
      const input = engine.input;

      // --- tank drive -------------------------------------------------------
      // Input collapses to left/right track throttle, then recombines into a
      // forward and a yaw component, so a future two-stick mapping and this
      // keyboard mapping drive the exact same code path.
      const intent = params.intent && typeof params.intent === "object" ? params.intent : null;
      const clamp1 = (v) => Math.max(-1, Math.min(1, typeof v === "number" ? v : 0));

      let fwdAxis = 0;
      let turnAxis = 0;
      let wantSelfRight = false;
      // `frozen` is the match director's hold — during a countdown, or once a match
      // is over, neither the keyboard nor an AI intent should move the bot. Weapons
      // are deliberately NOT frozen: pre-spinning during the countdown is a real
      // tactic and reads well on screen.
      const frozen = params.frozen === true;
      if (frozen) {
        // fall through with zeroed axes
      } else if (params.inputDriven === true) {
        // One code path for both humans; the prefix is the only difference (T-6.6).
        const p = params.playerIndex === 2 ? "p2." : "";
        fwdAxis = (input.actionHeld(p + "drive.forward") ? 1 : 0) - (input.actionHeld(p + "drive.back") ? 1 : 0);
        turnAxis = (input.actionHeld(p + "turn.right") ? 1 : 0) - (input.actionHeld(p + "turn.left") ? 1 : 0);
        wantSelfRight = input.actionHeld(p + "bot.selfRight");
      } else if (intent) {
        fwdAxis = clamp1(intent.throttle);
        turnAxis = clamp1(intent.turn);
        wantSelfRight = intent.selfRight === true;
      }

      // T-4.10 — the motor part's contribution. Written into params by the assembler,
      // so this stays a pure actuator: it scales, it does not look parts up.
      const num = (v, dflt) => (typeof v === "number" && isFinite(v) ? v : dflt);
      const mForce = num(params.driveForceMultiplier, 1);
      const mTurn = num(params.turnTorqueMultiplier, 1);
      const mSpeed = num(params.maxSpeedMultiplier, 1);

      const scaleL = typeof params.driveLeft === "number" ? params.driveLeft : 1;
      const scaleR = typeof params.driveRight === "number" ? params.driveRight : 1;
      const left = Math.max(-1, Math.min(1, fwdAxis + turnAxis)) * scaleL;
      const right = Math.max(-1, Math.min(1, fwdAxis - turnAxis)) * scaleR;
      const drive = (left + right) * 0.5;
      const yaw = (right - left) * 0.5;

      // --- soft caps --------------------------------------------------------
      const v = body.linearVelocity;
      const speedAlongForward = v.x * forward[0] + v.y * forward[1] + v.z * forward[2];
      const speedFade = Math.max(0, 1 - Math.abs(speedAlongForward) / (MAX_SPEED * mSpeed));
      const yawFade = Math.max(0, 1 - Math.abs(body.angularVelocity.y) / MAX_YAW_RATE);

      // Traction only exists while upright — a flipped bot must not scoot.
      const grounded = up[1] > UPRIGHT_DOT;

      if (grounded && drive !== 0) {
        const j = DRIVE_FORCE * mForce * drive * speedFade * dt;
        call("physics.applyImpulse", {
          entity,
          impulse: { x: forward[0] * j, y: forward[1] * j, z: forward[2] * j },
        });
      }

      if (grounded && yaw !== 0) {
        call("physics.applyTorque", {
          entity,
          torque: { x: 0, y: TURN_TORQUE * mTurn * yaw * yawFade * dt, z: 0 },
        });
      }

      // --- self-righting (T-1.12) ------------------------------------------
      if (selfRightTimer > 0) selfRightTimer -= dt;
      if (!grounded && selfRightTimer <= 0 && wantSelfRight) {
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
