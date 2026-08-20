/**
 * MatchTelemetry — records what happened in a match, for AI tuning. (T-5.14)
 *
 * Attach to one marker entity per fighting scene (Name `MatchTelemetry`). Risk R5
 * is that no telemetry exists before the AI is tuned, so the "weights shaped by
 * real player data" claim has nothing behind it. This is what closes that: every
 * match writes one JSON file, and `data/ai/aggregate.js` (T-5.19) turns a pile of
 * them into suggested weights.
 *
 * WHAT IT RECORDS, AND WHY EACH PIECE
 *   samples[]  a periodic snapshot per bot — what it was DOING (the human's held
 *              inputs, the AI's chosen action), where it was, and how healthy it
 *              was. Sampled rather than logged per frame because the tuning
 *              questions are all distributional ("how often does aggressive end up
 *              at knife range?"), and a 60 Hz log of a 120 s match is 7 200 rows
 *              per bot for no extra answer.
 *   events[]   the discrete things: hits, part losses, knockouts. These are the
 *              outcomes samples get correlated against.
 *   result     winner, reason, duration, damage dealt, parts lost.
 *
 * IT IS A PURE CONSUMER
 *   Everything here arrives on `battlebots.*` channels that already existed for the
 *   HUD and the match director. Nothing polls physics, nothing writes to a bot.
 *   Detaching this script changes no gameplay, which is the property that lets it
 *   ship enabled by default.
 *
 * WRITING
 *   One `project.writeFile` at match end, to `/telemetry/<scene>-<stamp>.json`.
 *   Never mid-match: a write per event would put file IO on the fixed step. If the
 *   match never formally ends (the editor is stopped mid-fight) the record is simply
 *   lost, which is the right trade — a partial match is not tuning data.
 *
 * params:
 *   sampleSeconds   how often to snapshot, default 0.5
 *   enabled         false to record nothing (kept for the perf comparison in T-5.23)
 */

const TELEMETRY_DIR = "/telemetry/";
const FORMAT_VERSION = 1;

export default function create() {
  let on = true;
  let sampleEvery = 0.5;
  let sampleTimer = 0;
  let elapsed = 0;
  let recording = false;
  let scene = "unknown";
  let mode = "match";

  const samples = [];
  const events = [];
  /** role -> its last known AI action, carried into each sample */
  const aiAction = new Map();
  /** role -> chassis entity, resolved lazily from the damage report */
  const chassisOf = new Map();
  let latestReport = null;
  const offs = [];

  const t = () => Math.round(elapsed * 100) / 100;

  function note(kind, data) {
    if (!recording) return;
    events.push(Object.assign({ t: t(), kind }, data));
  }

  /**
   * The human's bot has no `aiAction`, so its "decision" is the input it is holding.
   * Recording the same shape for both is what makes a player trace and an AI trace
   * comparable, which is the whole point of T-7.5.
   */
  function humanIntent(engine) {
    const held = (a) => (engine.input.actionHeld(a) ? 1 : 0);
    const throttle = held("drive.forward") - held("drive.back");
    const turn = held("turn.right") - held("turn.left");
    return { throttle, turn, spin: held("weapon.primary") };
  }

  function snapshot(engine, call) {
    // The damage report is the one place part health is authoritative, and asking
    // for it is a synchronous round-trip on the same bus.
    latestReport = null;
    engine.mcp.emit("battlebots.requestReport", {});
    const rep = latestReport;
    if (!rep) return;

    const hpByRole = new Map();
    for (const row of rep.parts) {
      const acc = hpByRole.get(row.role) || { hp: 0, max: 0 };
      acc.hp += row.hp; acc.max += row.maxHp;
      hpByRole.set(row.role, acc);
      if (row.socket === "chassis") chassisOf.set(row.role, row.entity);
    }

    const positions = new Map();
    for (const [role, ent] of chassisOf) {
      const b = call("physics.bodyState", { entity: ent });
      const s = b && !b.isError ? b.content : null;
      if (s && s.position) positions.set(role, s.position);
    }

    for (const bot of rep.bots) {
      const acc = hpByRole.get(bot.role) || { hp: 0, max: 1 };
      const me = positions.get(bot.role);
      let foeRange = null;
      for (const [other, p] of positions) {
        if (other === bot.role || !me) continue;
        foeRange = Math.round(Math.hypot(p.x - me.x, p.z - me.z) * 100) / 100;
      }
      const row = {
        t: t(),
        role: bot.role,
        action: aiAction.get(bot.role) || null,
        health: Math.round((acc.hp / Math.max(1, acc.max)) * 1000) / 1000,
        dealt: bot.damageDealt,
        range: foeRange,
        x: me ? Math.round(me.x * 100) / 100 : null,
        z: me ? Math.round(me.z * 100) / 100 : null,
      };
      // Only the human's bot carries an input trace; the AI's is its action.
      if (!aiAction.has(bot.role)) Object.assign(row, humanIntent(engine));
      samples.push(row);
    }
  }

  function write(call, engine, result) {
    const partsLost = {};
    for (const e of events) {
      if (e.kind !== "detached") continue;
      partsLost[e.role] = (partsLost[e.role] || 0) + 1;
    }
    const dealt = {};
    if (latestReport) for (const b of latestReport.bots) dealt[b.role] = b.damageDealt;

    const record = {
      formatVersion: FORMAT_VERSION,
      scene, mode,
      durationSeconds: t(),
      result: result || { winner: null, reason: "unfinished" },
      damageDealt: dealt,
      partsLost,
      samples,
      events,
    };
    // Stamp from the frame count, not a clock: scripts have no wall clock they can
    // rely on, and a monotonic frame index is enough to keep filenames unique and
    // ordered within a session.
    const stamp = String(Math.round(elapsed * 1000)) + "-" + String(samples.length);
    const path = TELEMETRY_DIR + scene + "-" + stamp + ".json";
    const res = call("project.writeFile", { path, text: JSON.stringify(record, null, 2) + "\n" });
    if (res && res.isError) { engine.console.log("[Telemetry] write FAILED " + path); return; }
    engine.console.log("[Telemetry] wrote " + path + " — " + samples.length + " samples, "
      + events.length + " events, " + record.durationSeconds + " s");
  }

  return {
    onStart({ engine, call, params }) {
      on = params.enabled !== false;
      sampleEvery = typeof params.sampleSeconds === "number" ? params.sampleSeconds : 0.5;
      samples.length = 0;
      events.length = 0;
      aiAction.clear();
      chassisOf.clear();
      elapsed = 0;
      sampleTimer = 0;
      recording = false;
      latestReport = null;
      scene = typeof params.sceneName === "string" && params.sceneName ? params.sceneName : "match";
      if (!on) { engine.console.log("[Telemetry] disabled by params"); return; }

      offs.push(engine.mcp.on("battlebots.damageReport", (p) => { latestReport = p; }));

      offs.push(engine.mcp.on("battlebots.matchState", (p) => {
        if (!p || p.state !== "fighting") return;
        mode = p.mode || mode;
        recording = true;
        elapsed = 0;
        note("matchStart", { mode });
      }));

      offs.push(engine.mcp.on("battlebots.aiAction", (p) => {
        if (!p || !p.role) return;
        aiAction.set(p.role, p.action);
        note("aiAction", { role: p.role, action: p.action, personality: p.personality, range: p.range, score: p.score });
      }));

      offs.push(engine.mcp.on("battlebots.weaponHit", (p) => {
        if (!p) return;
        note("hit", { role: p.role, force: Math.round(p.force || 0) });
      }));

      offs.push(engine.mcp.on("battlebots.partState", (p) => {
        if (!p || p.state === "intact") return;
        note("partState", { role: p.role, socket: p.socketId, part: p.partId, state: p.state });
      }));

      offs.push(engine.mcp.on("battlebots.partDetached", (p) => {
        if (!p) return;
        note("detached", { role: p.role, socket: p.socketId, part: p.partId, reason: p.reason });
      }));

      offs.push(engine.mcp.on("battlebots.knockout", (p) => {
        if (!p) return;
        note("knockout", { role: p.role, reason: p.reason });
      }));

      offs.push(engine.mcp.on("battlebots.matchResult", (p) => {
        if (!recording) return;
        recording = false;
        note("matchResult", { winner: p.winner, reason: p.reason });
        // Refresh the damage totals so the written record ends on final numbers.
        engine.mcp.emit("battlebots.requestReport", {});
        write(call, engine, { winner: p.winner, loser: p.loser, reason: p.reason });
      }));

      engine.console.log("[Telemetry] armed — " + scene + ", sampling every " + sampleEvery + " s");
    },

    onDestroy() {
      for (const off of offs) off();
      offs.length = 0;
    },

    onFixedUpdate({ engine, call, dt }) {
      if (!on || !recording) return;
      elapsed += dt;
      sampleTimer -= dt;
      if (sampleTimer > 0) return;
      sampleTimer = sampleEvery;
      snapshot(engine, call);
    },
  };
}
