/**
 * UtilityAi — scored opponent AI. (T-5.15 – T-5.18, T-5.20, T-5.21)
 *
 * Replaces `AiDriver`'s hand-ordered priority list with a scored one. Same seat, same
 * contract: attached to a "brain" child of the bot it drives, and it writes
 * `intent = { throttle, turn, selfRight }` into the chassis's `Script.params` for
 * BotDrive to actuate. Nothing here applies an impulse or knows a drive constant —
 * that is the split T-3.13 set up, and it is why this file could be written without
 * touching the drivetrain.
 *
 * params:
 *   role         this bot's role, e.g. "opponent"
 *   target       role to fight, default "player"
 *   personality  weight set from data/ai/weights.json, default "aggressive"
 *
 * WHY SCORING BEATS THE PRIORITY LIST
 *   `AiDriver` had to encode "attack unless too close unless stuck unless near a pit"
 *   as nested early-returns, so every new behaviour meant deciding where in the chain
 *   it went, and two behaviours could never be *compared* — only ordered. Here each
 *   action scores itself against the same world state and the best one wins, so
 *   "charge" and "push-to-hazard" can trade places purely because the numbers moved.
 *   `AiDriver` stays in the repo as the scripted baseline to measure against.
 *
 * TWO STATES ARE GATED, NOT SCORED
 *   Knocked out, and flipped, bypass scoring entirely. A mis-tuned weight file should
 *   not be able to make a bot lie on its back deciding whether to get up — that is a
 *   correctness property, not a preference. Everything else is scored.
 *
 * HYSTERESIS (T-5.17)
 *   Two mechanisms, because they solve different problems. `minDwellSeconds` stops
 *   sub-frame dithering between two near-equal scores; `hysteresisBonus` gives the
 *   incumbent action a standing edge so a behaviour has to be beaten clearly, not
 *   just narrowly. Without the bonus the bot twitches between charge and strafe at
 *   the exact range where they cross.
 *
 * WEAPON (deliberate spin management)
 *   Each action declares whether it wants the blade turning, written as `spinCommand`
 *   into the weapon's own params — only on change, so this is not a per-step write.
 *   The assembler no longer hands the AI's weapon `autoSpin`, because "always on" is
 *   exactly the decision this AI exists to make.
 *
 * NAV — still none (T-3.14). Direct steering in a bare box; pits are a repulsion
 * consideration rather than a pathing problem.
 */

const WEIGHTS_PATH = "/data/ai/weights.json";

/** Corner pit centres, from Arena01 (T-1.1). */
const PITS = [[-5, -5], [5, -5], [-5, 5], [5, 5]];

const COL_PANEL = 0x14161c;
const COL_TEXT = 0xe8e8ee;
const COL_DIM = 0x9aa0ad;
const COL_WIN = 0xd8a021;

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

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp1 = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);

export default function create() {
  let chassis = 0;
  let targetChassis = 0;
  let weaponEntity = 0;
  let weights = null;
  let tune = null;
  let personality = "aggressive";

  let knockedOut = false;
  let offKo = null;
  let offReport = null;
  let latestReport = null;

  let current = "spin-up";
  let lastAction = "";
  let dwell = 0;
  let stuckTimer = 0;
  let engagedTimer = 0;
  let lastThrottle = 0;
  let healthTimer = 0;
  let ownHealth = 1;
  let foeHealth = 1;
  let spinFraction = 0;
  let offWeapon = null;
  let offPart = null;
  let lastSpinCommand = null;
  // A weapon only counts as usable once its controller has spoken for it: a passive
  // wedge has a part entity but no WeaponController, so entity-exists is not enough.
  let sawWeaponState = false;
  let weaponDestroyed = false;

  // debug overlay (T-5.21)
  let debugOn = false;
  let debugPrev = false;
  const ui = { canvas: 0, rows: [], title: 0 };
  let lastScores = [];

  /**
   * The action set (T-5.16). Each entry turns the gathered state into an intent, so
   * the scoring layer never touches steering maths and the steering never looks at a
   * weight. `spin` is what this action wants the blade doing.
   *
   * `charge` and `ram` differ only in intent: charge is for when the blade is up and
   * wants a clean line, ram commits regardless and is what a bot with no working
   * weapon is left with.
   */
  const ACTIONS = [
    {
      id: "attack", spin: true,
      intent: (s) => ({ throttle: 0.8, turn: clamp1(s.headingError * 0.8), selfRight: false }),
    },
    {
      id: "charge", spin: true,
      intent: (s) => ({
        throttle: Math.abs(s.headingError) < tune.alignToleranceRad ? 1 : 0.35,
        turn: clamp1(s.headingError * 1.6),
        selfRight: false,
      }),
    },
    {
      id: "circle-strafe", spin: true,
      // Aim off the target by a fixed bias so it orbits instead of converging, and
      // back off while doing it if we are already inside engagement range. Driving
      // forward on the arc unconditionally does not orbit two heavy bots that are
      // touching — it just leans on them, which pinned `proximity` high, kept
      // `engaged` saturated, and left the defensive and opportunist sets circling
      // forever because attacking stayed penalised. Orbiting has to actually open
      // the range for the behaviour to mean what it is named.
      intent: (s) => ({
        throttle: s.range < tune.engageRangeM ? -0.35 : 0.6,
        turn: clamp1(angleDelta(0, s.headingError + tune.strafeBiasRad * s.orbitDir) * 1.4),
        selfRight: false,
      }),
    },
    {
      id: "retreat", spin: true,
      intent: (s) => ({ throttle: -0.85, turn: clamp1(0.35 * s.orbitDir), selfRight: false }),
    },
    {
      id: "spin-up", spin: true,
      // Hold off while the blade comes up, but keep the nose on the target so the
      // moment it is ready the bot is already pointed the right way.
      intent: (s) => ({ throttle: 0.1, turn: clamp1(s.headingError * 1.4), selfRight: false }),
    },
    {
      id: "ram", spin: false,
      intent: (s) => ({ throttle: 1, turn: clamp1(s.headingError * 1.2), selfRight: false }),
    },
    {
      id: "push-to-hazard", spin: true,
      // Drive at the target while it is between us and the pit, which shoves it in.
      intent: (s) => ({ throttle: 1, turn: clamp1(s.headingError * 1.5), selfRight: false }),
    },
  ];

  function findByName(call, name) {
    for (const e of call("scene.query", { components: ["Name"] }).content.entities) {
      const r = call("scene.getComponent", { entity: e, component: "Name" });
      if (r && !r.isError && r.content && r.content.value === name) return e;
    }
    return 0;
  }

  function findWeapon(call, role) {
    const prefix = "Bot_" + role + "_weapon";
    for (const e of call("scene.query", { components: ["Name"] }).content.entities) {
      const r = call("scene.getComponent", { entity: e, component: "Name" });
      const n = r && !r.isError && r.content ? r.content.value : "";
      if (n.indexOf(prefix) === 0) return e;
    }
    return 0;
  }

  /** Mean part-hp fraction per role, from DamageSystem's report. */
  function pollHealth(engine, role, target) {
    latestReport = null;
    engine.mcp.emit("battlebots.requestReport", {});
    const rep = latestReport;
    if (!rep || !rep.parts) return;
    let mine = [0, 0];
    let theirs = [0, 0];
    for (const p of rep.parts) {
      const bucket = p.role === role ? mine : p.role === target ? theirs : null;
      if (!bucket) continue;
      bucket[0] += p.maxHp > 0 ? p.hp / p.maxHp : 0;
      bucket[1] += 1;
    }
    if (mine[1]) ownHealth = mine[0] / mine[1];
    if (theirs[1]) foeHealth = theirs[0] / theirs[1];
  }

  /** World model + the normalised considerations (T-5.15). */
  function gather(call, dtLast) {
    const me = call("physics.bodyState", { entity: chassis });
    const them = call("physics.bodyState", { entity: targetChassis });
    if (!me || me.isError || !me.content || !them || them.isError || !them.content) return null;
    const a = me.content;
    const b = them.content;
    if (!a.rotation || !a.linearVelocity) return null;

    const q = [a.rotation.x, a.rotation.y, a.rotation.z, a.rotation.w];
    const fwd = rotate(q, [0, 0, -1]);
    const up = rotate(q, [0, 1, 0]);

    const dx = b.position.x - a.position.x;
    const dz = b.position.z - a.position.z;
    const range = Math.hypot(dx, dz);
    const myHeading = Math.atan2(fwd[0], -fwd[2]);
    const headingError = angleDelta(myHeading, Math.atan2(dx, -dz));

    const nearestPit = (x, z) => {
      let best = 99;
      for (const p of PITS) {
        const d = Math.hypot(p[0] - x, p[1] - z);
        if (d < best) best = d;
      }
      return best;
    };
    const pitRange = nearestPit(a.position.x, a.position.z);
    const foePitRange = nearestPit(b.position.x, b.position.z);
    const wall = Math.max(Math.abs(a.position.x), Math.abs(a.position.z));

    const speed = Math.hypot(a.linearVelocity.x, a.linearVelocity.z);
    const proximity = 1 - clamp01(range / tune.maxRangeM);

    // Advanced here rather than in the caller so `engaged` is consistent with the
    // range it was measured from. Decays at twice the rate it builds, so breaking
    // off briefly is enough to make attacking attractive again — that asymmetry is
    // what produces a rhythm of runs rather than one long grind.
    //
    // The threshold is nose-to-nose, NOT merely close: circling at engagement range
    // is itself a way of disengaging, and at a lower threshold it kept the timer
    // pinned, so the defensive and opportunist sets orbited forever instead of ever
    // coming back in.
    if (proximity > tune.engagedProximity) engagedTimer = Math.min(tune.attackDwellSeconds * 1.5, engagedTimer + dtLast);
    else engagedTimer = Math.max(0, engagedTimer - dtLast * 2);

    return {
      range,
      headingError,
      speed,
      upright: up[1],
      // Orbit the way we are already turning, so strafing does not reverse direction
      // every time the heading error crosses zero.
      orbitDir: headingError >= 0 ? 1 : -1,
      cons: {
        proximity,
        alignment: 1 - clamp01(Math.abs(headingError) / Math.PI),
        ownHealth: clamp01(ownHealth),
        foeHealth: clamp01(foeHealth),
        weaponSpin: clamp01(spinFraction),
        hazardNear: 1 - clamp01(pitRange / tune.hazardRadiusM),
        wallNear: clamp01(wall / tune.arenaHalfM),
        foeHazard: 1 - clamp01(foePitRange / tune.hazardRadiusM),
        stuck: lastThrottle > 0.3 && speed < tune.stuckSpeedMps ? clamp01(stuckTimer / tune.stuckSeconds) : 0,
        engaged: clamp01(engagedTimer / tune.attackDwellSeconds),
        bladeDown: 1 - clamp01(spinFraction),
        weaponLost: !weaponEntity || weaponDestroyed || !sawWeaponState ? 1 : 0,
      },
    };
  }

  function scoreOf(actionId, cons) {
    const w = weights[actionId];
    if (!w) return -99;
    let s = typeof w.bias === "number" ? w.bias : 0;
    for (const key of Object.keys(cons)) {
      const weight = w[key];
      if (typeof weight === "number") s += weight * cons[key];
    }
    return s;
  }

  /**
   * Score everything, then let the incumbent keep it unless clearly beaten. The
   * hazard consideration is applied as a veto on top rather than as a weight: a pit
   * is instant death, and no weight file should be able to price that in as merely
   * expensive.
   */
  function choose(state, dt) {
    const scores = ACTIONS.map((a) => ({ id: a.id, score: scoreOf(a.id, state.cons) }));

    // Pit veto: anything that drives forward while we are on a lip loses to retreat.
    if (state.cons.hazardNear > tune.pitVetoAt) {
      for (const s of scores) if (s.id !== "retreat") s.score -= 2;
    }

    let best = scores[0];
    for (const s of scores) if (s.score > best.score) best = s;

    const incumbent = scores.find((s) => s.id === current);
    dwell += dt;
    const locked = dwell < tune.minDwellSeconds;
    const holds = incumbent && incumbent.score + tune.hysteresisBonus >= best.score;
    if (!locked && !holds) {
      current = best.id;
      dwell = 0;
    }
    lastScores = scores;
    return ACTIONS.find((a) => a.id === current) || ACTIONS[0];
  }

  function publishIntent(call, intent, action) {
    const cur = call("scene.getComponent", { entity: chassis, component: "Script" });
    const existing = cur && !cur.isError && cur.content && cur.content.params ? cur.content.params : {};
    call("scene.setComponent", {
      entity: chassis,
      component: "Script",
      patch: {
        params: Object.assign({}, existing, {
          intent: { throttle: intent.throttle, turn: intent.turn, selfRight: intent.selfRight },
          aiAction: action,
        }),
      },
    });
  }

  /** Only written when it changes — the weapon does not need a per-step message. */
  function commandWeapon(call, wants) {
    if (!weaponEntity || wants === lastSpinCommand) return;
    lastSpinCommand = wants;
    const cur = call("scene.getComponent", { entity: weaponEntity, component: "Script" });
    if (!cur || cur.isError || !cur.content) return;
    call("scene.setComponent", {
      entity: weaponEntity,
      component: "Script",
      patch: { params: Object.assign({}, cur.content.params || {}, { spinCommand: wants }) },
    });
  }

  // ── debug overlay (T-5.21) ────────────────────────────────────────────────
  function buildOverlay(call) {
    const at = (min, max) => ({ anchorMin: min, anchorMax: max, offsetMin: [0, 0], offsetMax: [0, 0] });
    ui.canvas = call("ui.createCanvas", { visible: true }).content.canvas;
    const spec = {
      props: { kind: "panel", visible: true, backgroundColor: COL_PANEL, layout: at([0.30, 0.12], [0.545, 0.72]) },
      children: [{ props: { kind: "text", visible: true, text: "AI", color: COL_TEXT, fontSize: 13, layout: at([0.05, 0.01], [0.95, 0.07]) } }],
    };
    // one row per consideration, then one per action score
    const rows = 9 + ACTIONS.length + 1;
    for (let i = 0; i < rows; i++) {
      const y0 = 0.08 + i * (0.9 / rows);
      spec.children.push({ props: { kind: "text", visible: true, text: "", color: COL_DIM, fontSize: 11, layout: at([0.05, y0], [0.97, y0 + 0.9 / rows - 0.004]) } });
    }
    const els = call("ui.createTree", { canvas: ui.canvas, visible: true, spec }).content.elements;
    ui.title = els[1];
    ui.rows = els.slice(2);
  }

  function refreshOverlay(call, state) {
    if (!ui.canvas) return;
    call("ui.setProps", { entity: ui.title, props: { text: "AI  " + personality + "  ->  " + current } });
    const lines = [];
    for (const k of Object.keys(state.cons)) {
      lines.push(k + "  " + state.cons[k].toFixed(2));
    }
    lines.push("--- scores ---");
    const sorted = lastScores.slice().sort((a, b) => b.score - a.score);
    for (const s of sorted) lines.push((s.id === current ? "> " : "  ") + s.id + "  " + s.score.toFixed(2));
    for (let i = 0; i < ui.rows.length; i++) {
      const t = lines[i] || "";
      call("ui.setProps", {
        entity: ui.rows[i],
        props: { text: t, color: t.charAt(0) === ">" ? COL_WIN : COL_DIM },
      });
    }
  }

  function teardownOverlay(call) {
    if (!ui.canvas) return;
    try { call("ui.remove", { entity: ui.canvas }); } catch (err) { /* gone */ }
    ui.canvas = 0;
    ui.rows = [];
  }

  return {
    onStart({ engine, call, params }) {
      const role = params.role || "opponent";
      const target = params.target || "player";
      personality = params.personality || "aggressive";

      const raw = call("project.readFile", { path: WEIGHTS_PATH });
      if (!raw || raw.isError) {
        engine.console.log("[AI] no weights at " + WEIGHTS_PATH + " — brain idle");
        return;
      }
      const file = JSON.parse(raw.content.text);
      tune = file.tuning;
      weights = file.personalities[personality];
      if (!weights) {
        engine.console.log("[AI] unknown personality '" + personality + "' — falling back to aggressive");
        personality = "aggressive";
        weights = file.personalities.aggressive;
      }

      chassis = findByName(call, "Bot_" + role + "_Chassis");
      targetChassis = findByName(call, "Bot_" + target + "_Chassis");
      weaponEntity = findWeapon(call, role);
      knockedOut = false;
      weaponDestroyed = false;
      sawWeaponState = false;
      current = "spin-up";
      dwell = 0;

      offKo = engine.mcp.on("battlebots.knockout", (p) => {
        if (p && p.role === role) knockedOut = true;
      });
      offReport = engine.mcp.on("battlebots.damageReport", (p) => { latestReport = p; });
      offWeapon = engine.mcp.on("battlebots.weaponState", (p) => {
        if (p && p.entity === weaponEntity && typeof p.spinFraction === "number") {
          spinFraction = p.spinFraction;
          sawWeaponState = true;
        }
      });
      offPart = engine.mcp.on("battlebots.partState", (p) => {
        if (p && p.entity === weaponEntity && p.state === "destroyed") weaponDestroyed = true;
      });

      engine.console.log("[AI] " + role + " utility brain up (" + personality + ") — chassis "
        + chassis + ", target " + targetChassis + ", weapon " + (weaponEntity || "none"));
    },

    onDestroy({ call }) {
      if (offKo) { offKo(); offKo = null; }
      if (offReport) { offReport(); offReport = null; }
      if (offWeapon) { offWeapon(); offWeapon = null; }
      if (offPart) { offPart(); offPart = null; }
      teardownOverlay(call);
    },

    onFixedUpdate({ engine, call, dt, params }) {
      if (!weights) return;
      const role = params.role || "opponent";
      if (!chassis) chassis = findByName(call, "Bot_" + role + "_Chassis");
      if (!targetChassis) targetChassis = findByName(call, "Bot_" + (params.target || "player") + "_Chassis");
      if (!chassis || !targetChassis) return;

      // F3 toggles the overlay; `params.debug` forces it on so a scene — or a live
      // poke at the params — can enable it without a keypress. Built lazily so a match
      // that never asks for it never pays for it, and torn down again so it cannot
      // pile up canvases across toggles.
      const held = engine.input.actionHeld("ai.debug");
      if (held && !debugPrev) debugOn = !debugOn;
      debugPrev = held;
      const wantOverlay = debugOn || params.debug === true;
      if (wantOverlay && !ui.canvas) buildOverlay(call);
      else if (!wantOverlay && ui.canvas) teardownOverlay(call);

      healthTimer -= dt;
      if (healthTimer <= 0) {
        healthTimer = tune.healthPollSeconds;
        pollHealth(engine, role, params.target || "player");
      }

      const state = gather(call, dt);
      if (!state) return;

      // ── gated states ────────────────────────────────────────────────────
      if (knockedOut) {
        commandWeapon(call, false);
        publishIntent(call, { throttle: 0, turn: 0, selfRight: false }, "knocked-out");
        lastThrottle = 0;
        return;
      }
      if (state.upright < tune.uprightDot) {
        commandWeapon(call, false);
        publishIntent(call, { throttle: 0, turn: 0, selfRight: true }, "self-right");
        lastThrottle = 0;
        if (debugOn) refreshOverlay(call, state);
        return;
      }

      // ── scored states ───────────────────────────────────────────────────
      if (state.cons.stuck > 0) stuckTimer += dt; else stuckTimer = 0;

      const action = choose(state, dt);
      const intent = action.intent(state);
      lastThrottle = intent.throttle;
      commandWeapon(call, action.spin);
      publishIntent(call, intent, action.id);
      if (debugOn) refreshOverlay(call, state);

      if (action.id !== lastAction) {
        lastAction = action.id;
        engine.mcp.emit("battlebots.aiAction", {
          role, action: action.id, personality,
          range: Math.round(state.range * 100) / 100,
          score: Math.round((lastScores.find((s) => s.id === action.id) || { score: 0 }).score * 100) / 100,
        });
      }
    },
  };
}
