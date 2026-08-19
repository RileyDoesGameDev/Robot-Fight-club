/**
 * BotDrive — tank-style drivetrain for a Battle Bots chassis. (T-1.8)
 *
 * DRIVETRAIN MODEL (T-1.7 decision):
 *   Propulsion is applied to the CHASSIS body directly, as a per-step impulse.
 *   Wheels are real dynamic bodies on breakable fixed joints, but they do NOT
 *   propel — they exist so they can be damaged and sheared off (T-5.4), and a
 *   lost wheel is modelled as a torque/force multiplier via `driveScale`.
 *   Rejected alternative: revolute wheel joints with velocity motors. More
 *   physically honest, but it adds four motorised constraints of solver work per
 *   bot and couples drive feel to joint stiffness. Revisit only if traction
 *   nuance turns out to matter more than the frame budget (see T-1.17).
 *
 * PHYSICS ACCESS (T-1.16):
 *   The `physics.*` MCP tools are NOT exposed over the editor bridge in this
 *   build, so scripts are the only path to Rapier. `engine.mcp.callTool` is
 *   async and therefore unusable inside a fixed step — instead we resolve the
 *   SYNCHRONOUS handlers out of `engine.mcp.toolMap` once in onStart and call
 *   them directly each step. Calling a handler directly skips zod parsing, so
 *   every argument must be passed explicitly (no schema defaults apply).
 *
 * WHY IMPULSES, NOT FORCES (engine gotcha, KB worth remembering):
 *   `physics.applyForce` maps to Rapier's `body.addForce`, and the engine never
 *   calls `resetForces()`. The force therefore LATCHES and accumulates across
 *   every subsequent step — calling it once per frame ramps a body to hundreds
 *   of m/s within a second. Its description ("for the next step") is wrong.
 *   `applyImpulse` / `applyTorqueImpulse` are per-step and are what a drivetrain
 *   wants. Impulse = force x dt, so the tuning constants below stay in N / N·m
 *   and are converted at the call site.
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
  let applyImpulse = null;
  let applyTorque = null;
  let bodyState = null;

  /**
   * Per-side drive authority, 0..1. The damage system lowers these as wheels
   * are damaged or sheared off (T-3.6 / T-5.4); nothing writes them yet.
   */
  const driveScale = { left: 1, right: 1 };

  return {
    onStart({ engine }) {
      const tm = engine.mcp.toolMap;
      applyImpulse = tm.get("physics.applyImpulse").handler;
      applyTorque = tm.get("physics.applyTorque").handler;
      bodyState = tm.get("physics.bodyState").handler;
    },

    onFixedUpdate({ entity, engine, dt }) {
      if (!bodyState) return;
      const body = bodyState({ entity }).content;
      if (!body) return;

      const q = [body.rotation.x, body.rotation.y, body.rotation.z, body.rotation.w];
      const forward = rotate(q, [0, 0, -1]); // chassis nose is -Z
      const up = rotate(q, [0, 1, 0]);
      const input = engine.input;

      // --- tank drive -------------------------------------------------------
      // Input is collapsed to left/right track throttle, then recombined into a
      // forward and a yaw component, so a future two-stick mapping and this
      // keyboard mapping drive the exact same code path.
      const fwdAxis =
        (input.actionHeld("drive.forward") ? 1 : 0) - (input.actionHeld("drive.back") ? 1 : 0);
      const turnAxis =
        (input.actionHeld("turn.right") ? 1 : 0) - (input.actionHeld("turn.left") ? 1 : 0);

      const left = Math.max(-1, Math.min(1, fwdAxis + turnAxis)) * driveScale.left;
      const right = Math.max(-1, Math.min(1, fwdAxis - turnAxis)) * driveScale.right;
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
        applyImpulse({
          entity,
          impulse: { x: forward[0] * j, y: forward[1] * j, z: forward[2] * j },
        });
      }

      if (grounded && yaw !== 0) {
        applyTorque({
          entity,
          torque: { x: 0, y: TURN_TORQUE * yaw * yawFade * dt, z: 0 },
        });
      }

      // --- self-righting (T-1.12) ------------------------------------------
      if (selfRightTimer > 0) selfRightTimer -= dt;
      if (!grounded && selfRightTimer <= 0 && input.actionHeld("bot.selfRight")) {
        selfRightTimer = SELF_RIGHT_COOLDOWN;
        applyImpulse({ entity, impulse: { x: 0, y: SELF_RIGHT_IMPULSE, z: 0 } });
        // Roll about the chassis' own long axis so the kick has a direction.
        const axis = rotate(q, [0, 0, 1]);
        applyTorque({
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
