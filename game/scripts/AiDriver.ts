/**
 * AiDriver — scripted opponent. (T-3.13)
 *
 * Attached to a "brain" child entity of the bot it drives, NOT to the chassis:
 * an entity can hold only one Script, and the chassis already carries BotDrive.
 *
 * params:
 *   role     this bot's role, e.g. "opponent"
 *   target   role to fight, default "player"
 *
 * DECISION LAYER ONLY
 *   This writes `intent = { throttle, turn, selfRight }` into the chassis's
 *   `Script.params`; BotDrive actuates it. Nothing here applies an impulse or
 *   knows a drive constant, which is the split T-3.13 calls for — the week-5
 *   Utility AI replaces `decide()` and leaves actuation and this plumbing alone.
 *
 *   `decide()` is deliberately a pure-ish function of a gathered `state` object.
 *   Utility scoring drops in by replacing its body.
 *
 * NAV (T-3.14 — decided: no nav grid)
 *   Direct steering only. The arena is a bare 12 x 12 m box whose sole obstacle is
 *   the other bot; a grid and A* would buy nothing a heading error cannot express,
 *   and half-building both was the thing T-3.14 warns against. The corner pits are
 *   avoided by a repulsion term rather than by pathing.
 *
 * WEAPON
 *   Not commanded here. The assembler gives a non-player weapon `autoSpin: true`,
 *   so it holds speed on its own. Deliberate spin management (save energy, spin up
 *   before a charge) is a utility-AI behaviour, not a scripted-baseline one.
 */

const ALIGN_TOLERANCE = 0.30;   // rad — inside this, drive straight at the target
const ENGAGE_RANGE = 2.2;       // m — close enough to attack
const BACKOFF_RANGE = 0.75;     // m — too close; reverse to get a run-up
const PIT_AVOID_RADIUS = 2.4;   // m — start steering away from a corner pit
const ARENA_HALF = 5.6;         // m — inside the walls
const REVERSE_SECONDS = 0.8;    // how long a back-off lasts once triggered
const STUCK_SPEED = 0.35;       // m/s below which we may be jammed on something
const STUCK_SECONDS = 1.2;
const ATTACK_DWELL = 2.5;       // s of continuous attacking before backing off for another run

// Corner pit centres, from Arena01 (T-1.1).
const PITS = [[-5, -5], [5, -5], [-5, 5], [5, 5]];

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

/** Signed shortest angle from `from` to `to`, in radians. */
function angleDelta(from, to) {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export default function create() {
  let chassis = 0;
  let targetChassis = 0;
  let reverseTimer = 0;
  let stuckTimer = 0;
  let knockedOut = false;
  let offKo = null;
  let lastAction = "";
  let lastThrottle = 0;
  let attackTime = 0;

  function findChassis(call, role) {
    const ents = call("scene.query", { components: ["Name"] }).content.entities;
    for (const e of ents) {
      const r = call("scene.getComponent", { entity: e, component: "Name" });
      if (r && !r.isError && r.content && r.content.value === "Bot_" + role + "_Chassis") return e;
    }
    return 0;
  }

  /**
   * The whole world model the decision uses. Kept as one flat object so the
   * week-5 utility AI can score considerations straight off it.
   */
  function gather(call) {
    const me = call("physics.bodyState", { entity: chassis });
    const them = call("physics.bodyState", { entity: targetChassis });
    if (!me || me.isError || !me.content || !them || them.isError || !them.content) return null;
    const a = me.content;
    const b = them.content;
    const q = [a.rotation.x, a.rotation.y, a.rotation.z, a.rotation.w];
    const fwd = rotate(q, [0, 0, -1]);
    const up = rotate(q, [0, 1, 0]);

    const dx = b.position.x - a.position.x;
    const dz = b.position.z - a.position.z;
    const range = Math.hypot(dx, dz);
    // Heading is measured in the XZ plane; atan2(x, -z) matches a -Z-forward bot.
    const myHeading = Math.atan2(fwd[0], -fwd[2]);
    const toTarget = Math.atan2(dx, -dz);

    // Nearest pit, and which way to turn to avoid it.
    let pitRange = 99;
    let pitBearing = 0;
    for (const p of PITS) {
      const pdx = p[0] - a.position.x;
      const pdz = p[1] - a.position.z;
      const d = Math.hypot(pdx, pdz);
      if (d < pitRange) { pitRange = d; pitBearing = Math.atan2(pdx, -pdz); }
    }
    const wallProximity = Math.max(Math.abs(a.position.x), Math.abs(a.position.z));

    return {
      range,
      headingError: angleDelta(myHeading, toTarget),
      speed: Math.hypot(a.linearVelocity.x, a.linearVelocity.z),
      upright: up[1],
      pitRange,
      pitError: angleDelta(myHeading, pitBearing),
      nearWall: wallProximity > ARENA_HALF - 0.9,
      myPos: [a.position.x, a.position.z],
    };
  }

  /**
   * SCRIPTED decision layer. Returns an intent plus a label for the debug overlay
   * (T-5.21). Replace this body with utility scoring in week 5; everything around
   * it stays.
   */
  function decide(state, dt) {
    if (knockedOut) return { throttle: 0, turn: 0, selfRight: false, action: "knocked-out" };

    // Flipped: nothing else matters until it is upright again.
    if (state.upright < 0.35) {
      return { throttle: 0, turn: 0, selfRight: true, action: "self-right" };
    }

    // Pits are lethal, so avoiding one outranks attacking.
    if (state.pitRange < PIT_AVOID_RADIUS) {
      // Steer AWAY from the pit: push the turn opposite to its bearing.
      const away = state.pitError > 0 ? -1 : 1;
      return { throttle: 0.55, turn: away, selfRight: false, action: "avoid-pit" };
    }

    // Wedged against something: back off so the next charge has a run-up.
    if (reverseTimer > 0) {
      reverseTimer -= dt;
      return { throttle: -0.85, turn: 0.35, selfRight: false, action: "back-off" };
    }
    // Stuck = we asked to drive forward and barely moved. Gated on the PREVIOUS
    // intent so pivoting in place (a legitimately stationary manoeuvre) is not
    // mistaken for being wedged.
    if (lastThrottle > 0.3 && state.speed < STUCK_SPEED) {
      stuckTimer += dt;
      if (stuckTimer > STUCK_SECONDS) { stuckTimer = 0; reverseTimer = REVERSE_SECONDS; }
    } else {
      stuckTimer = 0;
    }

    // Long enough on the attack: break off and set up another run, win or lose.
    if (attackTime > ATTACK_DWELL) {
      attackTime = 0;
      reverseTimer = REVERSE_SECONDS;
      return { throttle: -0.85, turn: 0.4, selfRight: false, action: "break-off" };
    }

    // Nose-to-nose: reverse to open the distance rather than grind.
    if (state.range < BACKOFF_RANGE) {
      reverseTimer = REVERSE_SECONDS * 0.6;
      return { throttle: -0.8, turn: 0, selfRight: false, action: "disengage" };
    }

    // Turn toward the target; a front-mounted weapon means aiming IS aligning.
    // Proportional so it settles instead of oscillating, and it is what corrects
    // the yaw drift the spinner's reaction torque produces.
    const turn = Math.max(-1, Math.min(1, state.headingError * 1.6));
    const aligned = Math.abs(state.headingError) < ALIGN_TOLERANCE;

    if (!aligned) {
      // Creep while turning when far, pivot in place when close, so it does not
      // circle the target forever.
      const creep = state.range > ENGAGE_RANGE ? 0.35 : 0;
      return { throttle: creep, turn, selfRight: false, action: "align" };
    }
    const closing = state.range > ENGAGE_RANGE;
    if (!closing) attackTime += dt; else attackTime = 0;
    return {
      throttle: closing ? 1 : 0.8,
      turn: turn * 0.5,
      selfRight: false,
      action: closing ? "close" : "attack",
    };
  }

  /** Write the intent where BotDrive will read it, preserving other params. */
  function publish(call, intent) {
    const cur = call("scene.getComponent", { entity: chassis, component: "Script" });
    const existing = cur && !cur.isError && cur.content && cur.content.params ? cur.content.params : {};
    call("scene.setComponent", {
      entity: chassis,
      component: "Script",
      patch: {
        params: Object.assign({}, existing, {
          intent: { throttle: intent.throttle, turn: intent.turn, selfRight: intent.selfRight },
          aiAction: intent.action,
        }),
      },
    });
  }

  return {
    onStart({ engine, call, params }) {
      chassis = findChassis(call, params.role || "opponent");
      targetChassis = findChassis(call, params.target || "player");
      knockedOut = false;

      offKo = engine.mcp.on("battlebots.knockout", (p) => {
        if (p && p.role === (params.role || "opponent")) knockedOut = true;
      });

      engine.console.log("[AI] " + (params.role || "opponent") + " brain up — chassis "
        + chassis + ", target " + targetChassis);
    },

    onDestroy() {
      if (offKo) { offKo(); offKo = null; }
    },

    onFixedUpdate({ engine, call, dt, params }) {
      if (!chassis) chassis = findChassis(call, params.role || "opponent");
      if (!targetChassis) targetChassis = findChassis(call, params.target || "player");
      if (!chassis || !targetChassis) return;

      const state = gather(call);
      if (!state) return;

      const intent = decide(state, dt);
      lastThrottle = intent.throttle;
      publish(call, intent);

      if (intent.action !== lastAction) {
        lastAction = intent.action;
        engine.mcp.emit("battlebots.aiAction", {
          role: params.role || "opponent",
          action: intent.action,
          range: Math.round(state.range * 100) / 100,
          headingError: Math.round(state.headingError * 100) / 100,
        });
      }
    },
  };
}
