/**
 * MatchDirector — countdown, timer, victory and scene flow. (T-6.3, T-6.2)
 *
 * Attach to a marker entity in any fighting scene.
 *
 * params:
 *   mode            "match" (timed, ends) | "practice" (untimed, restartable)
 *   sceneName       this scene's name, so Rematch can reload it
 *   matchSeconds    match length, default 120
 *   countdownSeconds default 3
 *   playerRole      default "player"
 *
 * STATE
 *   countdown → fighting → over
 *   Both bots are frozen during the countdown and again once it is over, through
 *   `BotDrive`'s `params.frozen`. Weapons are deliberately left running: spinning up
 *   during the countdown is a real tactic and it reads well.
 *
 * HOW A MATCH ENDS
 *   - `battlebots.knockout` from DamageSystem — the knocked-out role loses.
 *   - Time expiry in match mode — decided on damage dealt, which DamageSystem
 *     already tracks. The director asks for a report and compares; it does not keep
 *     its own tally, so there is one source of truth for "who was winning".
 *
 * SCENE FLOW (T-6.2)
 *   Calling `project.loadScene` from inside a script hook is safe — verified: the
 *   ScriptSystem drops its instances on `world.reloaded` and the engine keeps
 *   stepping. So the buttons switch scenes directly rather than going through a
 *   deferred request queue.
 *
 * The engine's own `game.*` session state is driven alongside ours so the host
 * reflects reality; those transitions are legality-checked, hence the status probe.
 */

const COL_PANEL = 0x14161c;
const COL_TEXT = 0xe8e8ee;
const COL_DIM = 0x9aa0ad;
const COL_WIN = 0x4fb36a;
const COL_LOSE = 0xd8503f;
const COL_BTN = 0x272b36;

/**
 * Apply this game's input bindings. (T-2.26)
 *
 * `input.mapAction` is RUNTIME state — bindings are not serialized with the scene, so
 * every scene load starts with the editor's defaults and none of this game's actions.
 * Something has to re-apply them, and it used to be `BotDrive.onStart`, which made a
 * bot responsible for a global registry: in a versus match whichever bot started
 * second found the flag already set and never bound its own keys.
 *
 * The scene director is the right owner. It exists once per gameplay scene, it starts
 * before anything is driveable, and it already owns the rest of scene setup (T-6.2).
 *
 * The map is APPLIED IN FULL every time, overwriting whatever is bound. Two earlier
 * versions of this were wrong in the same direction and both hid a rebinding:
 *
 *   1. Gating the whole map on one action already existing meant any action added
 *      later never bound at all — how the F3 AI overlay silently went missing.
 *   2. Gating each action on itself already existing fixed that but still made a
 *      binding permanent once set. A deployed build bakes the editor's action table
 *      into its bundle, so changing a key in `input-map.json` had no effect on the
 *      thing anyone actually plays — the stale baked binding always won.
 *
 * There is no case where an existing binding should beat the file: the file is the
 * source of truth, and re-applying a dozen bindings on scene load costs nothing.
 */
function applyInputMap(call, engine) {
  let maps = [];
  const res = call("project.readFile", { path: "/data/bundle.json" });
  if (!res || res.isError || !res.content) return;
  try {
    const im = JSON.parse(res.content.text).inputMap;
    // EVERY map, not just this scene's player. Bindings are one global registry and
    // player 2's keys have to exist before player 2's bot does.
    for (const k of Object.keys(im)) if (k[0] !== "$") maps.push(im[k]);
  } catch (err) {
    return;
  }

  let bound = 0;
  for (const map of maps) {
    for (const action of Object.keys(map)) {
      call("input.mapAction", { action, codes: map[action] });
      bound++;
    }
  }
  if (bound) engine.console.log("[Match] applied " + bound + " input bindings");
}

export default function create() {
  let state = "countdown";
  let clock = 0;              // counts down in countdown, up while fighting
  let result = null;          // { winner, loser, reason }
  let bots = [];              // chassis entities by role
  let offKo = null;
  let offReport = null;
  let offClick = null;
  let latestReport = null;
  let ui = { canvas: 0, banner: 0, sub: 0, btnA: 0, btnB: 0, btnC: 0 };
  let sceneName = "Arena01";
  let mode = "match";
  let matchSeconds = 120;
  let countdownSeconds = 3;
  let playerRole = "player";
  let versus = false;

  function findBots(call) {
    const out = [];
    for (const e of call("scene.query", { components: ["Name"] }).content.entities) {
      const r = call("scene.getComponent", { entity: e, component: "Name" });
      const n = r && !r.isError && r.content ? r.content.value : "";
      const m = /^Bot_([A-Za-z0-9]+)_Chassis$/.exec(n);
      if (m) out.push({ role: m[1], entity: e });
    }
    return out;
  }

  /** Read-modify-write, because `params` is one field shared with other writers. */
  function setFrozen(call, frozen) {
    for (const b of bots) {
      const cur = call("scene.getComponent", { entity: b.entity, component: "Script" });
      if (!cur || cur.isError || !cur.content) continue;
      const existing = cur.content.params || {};
      call("scene.setComponent", {
        entity: b.entity,
        component: "Script",
        patch: { params: Object.assign({}, existing, { frozen }) },
      });
    }
  }

  function gameState(call, verb) {
    // These transitions are legality-checked by the pack, so probe first and let a
    // rejected transition be a no-op rather than an error in the log.
    const st = call("game.status", {});
    const phase = st && !st.isError && st.content ? st.content.state || st.content.phase : null;
    if (verb === "start" && phase === "playing") return;
    if (verb === "end" && phase !== "playing" && phase !== "paused") return;
    call("game." + verb, {});
  }

  function buildUi(call) {
    const panel = (min, max) => ({
      props: { kind: "panel", visible: true, backgroundColor: COL_PANEL,
        layout: { anchorMin: min, anchorMax: max, offsetMin: [0, 0], offsetMax: [0, 0] } },
      children: [],
    });
    const text = (min, max, t, size, color) => ({
      props: { kind: "text", visible: true, text: t, color: color || COL_TEXT, fontSize: size || 14,
        layout: { anchorMin: min, anchorMax: max, offsetMin: [0, 0], offsetMax: [0, 0] } },
    });
    const button = (min, max, t, actionId) => ({
      props: { kind: "button", visible: false, text: t, actionId, color: COL_TEXT,
        backgroundColor: COL_BTN, fontSize: 13,
        layout: { anchorMin: min, anchorMax: max, offsetMin: [0, 0], offsetMax: [0, 0] } },
    });

    ui.canvas = call("ui.createCanvas", { visible: true }).content.canvas;
    const graft = (spec) => call("ui.createTree", { canvas: ui.canvas, visible: true, spec }).content.elements;

    // top strip: clock / countdown
    const top = panel([0.38, 0.015], [0.62, 0.085]);
    top.children.push(text([0.02, 0.05], [0.98, 0.95], "", 18));
    const t = graft(top);
    ui.banner = t[1];

    // centre: result + the two ways out
    const mid = panel([0.3, 0.4], [0.7, 0.6]);
    mid.children.push(text([0.02, 0.06], [0.98, 0.44], "", 16));
    mid.children.push(button([0.04, 0.55], [0.34, 0.92], "Rematch", "match:rematch"));
    mid.children.push(button([0.36, 0.55], [0.66, 0.92], "Change Bot", "match:changebot"));
    mid.children.push(button([0.68, 0.55], [0.96, 0.92], "Results", "match:results"));
    const m = graft(mid);
    ui.sub = m[1];
    ui.btnA = m[2];
    ui.btnB = m[3];
    ui.btnC = m[4];
    // the centre panel only matters once the match is over
    call("ui.setProps", { entity: m[0], props: { visible: false } });
    ui.midPanel = m[0];
  }

  /** In versus both seats are human, so "YOU" is meaningless — name the seats. */
  function seatLabel(role) {
    if (!versus) return role === playerRole ? "YOU" : "OPPONENT";
    return role === "player" ? "PLAYER 1" : "PLAYER 2";
  }

  function showResult(call, engine) {
    const won = result && result.winner === playerRole;
    call("ui.setProps", { entity: ui.midPanel, props: { visible: true } });
    call("ui.setProps", {
      entity: ui.sub,
      props: {
        text: (versus
            ? (result && result.winner ? seatLabel(result.winner) + " WINS" : "DRAW")
            : won ? "YOU WIN" : result && result.winner ? "YOU LOSE" : "DRAW")
          + "  —  " + (result ? result.reason : ""),
        color: won ? COL_WIN : COL_LOSE,
      },
    });
    call("ui.setProps", { entity: ui.btnA, props: { visible: true, disabled: false } });
    call("ui.setProps", { entity: ui.btnB, props: { visible: true, disabled: false } });
    call("ui.setProps", { entity: ui.btnC, props: { visible: true, disabled: false } });
    call("ui.setProps", { entity: ui.banner, props: { text: "MATCH OVER", color: COL_DIM } });
  }

  /**
   * Persist the result (T-6.5). Two files, deliberately:
   *   /data/last-match.json  the match just played, which PostMatch reads
   *   /data/history.json     an append-only log, capped, which the menu reads
   * Written here because `finish` is the only place that knows a match ended, and
   * because everything it needs dies with the scene — DamageSystem's health table
   * is per-instance by design (T-5.8), so a post-match screen in another scene has
   * no way to ask for it after the fact.
   */
  function persist(call, engine, winner, loser, reason) {
    let dealt = {};
    let parts = [];
    latestReport = null;
    engine.mcp.emit("battlebots.requestReport", {});
    if (latestReport) {
      for (const b of latestReport.bots) dealt[b.role] = Math.round(b.damageDealt * 10) / 10;
      parts = latestReport.parts.map((p) => ({ role: p.role, socket: p.socket, part: p.part,
        hp: p.hp, maxHp: p.maxHp, state: p.state }));
    }
    const lost = {};
    for (const p of parts) if (p.state === "destroyed") lost[p.role] = (lost[p.role] || 0) + 1;

    // Names come from the SPAWNER markers, not from a fixed pair of files. Reading
    // /data/bots/__opponent.json is wrong in Arena01, whose spawner names a blueprint
    // directly (`BotSpawn:opp-wedge:opponent`) and never touches that file — it
    // reported whichever opponent the Demo Center had last written. The marker is
    // renamed `BotSpawned:<blueprintId>:<role>` once the bot exists, so it is the
    // only thing that knows what was actually built.
    // Bundle first, then the loose file, then the raw id. A roster blueprint like
    // `opp-wedge` exists only inside the bundle — the engine project's /data/bots
    // holds just the scratch ids (__selected, __opponent) the select screen writes —
    // so a file-only lookup gave the display name as "opp-wedge" instead of
    // "Doorstop".
    let bundleBots = {};
    const bres = call("project.readFile", { path: "/data/bundle.json" });
    if (bres && !bres.isError && bres.content) {
      try { bundleBots = JSON.parse(bres.content.text).bots || {}; } catch (err) { bundleBots = {}; }
    }
    const bots = {};
    for (const e of call("scene.query", { components: ["Name"] }).content.entities) {
      const n = call("scene.getComponent", { entity: e, component: "Name" });
      const v = n && !n.isError && n.content ? n.content.value : null;
      const m = v ? /^BotSpawned:(.+):(player|opponent)$/.exec(v) : null;
      if (!m) continue;
      const id = m[1];
      let name = bundleBots[id] && bundleBots[id].name ? bundleBots[id].name : null;
      if (!name) {
        const r = call("project.readFile", { path: "/data/bots/" + id + ".json" });
        if (r && !r.isError && r.content) {
          try { name = JSON.parse(r.content.text).name; } catch (err) { name = null; }
        }
      }
      bots[m[2]] = name || id;
    }

    const record = {
      scene: sceneName, mode,
      winner: winner || null, loser: loser || null, reason,
      playerRole, bots, versus,
      damageDealt: dealt, partsLost: lost, parts,
      elapsedSeconds: Math.round(clock * 10) / 10,
    };
    call("project.writeFile", { path: "/data/last-match.json", text: JSON.stringify(record, null, 2) + "\n" });

    // History is append-only but capped: it is read by a menu, not analysed, and an
    // unbounded log in browser storage is a slow leak. Telemetry (T-5.14) is where
    // the full record lives if anyone wants depth.
    let history = [];
    const h = call("project.readFile", { path: "/data/history.json" });
    if (h && !h.isError && h.content) {
      try { const p = JSON.parse(h.content.text); if (Array.isArray(p)) history = p; } catch (err) { history = []; }
    }
    history.push({ scene: sceneName, mode, winner: record.winner, reason,
      playerWon: record.winner === playerRole, bots, elapsedSeconds: record.elapsedSeconds });
    if (history.length > 50) history = history.slice(history.length - 50);
    call("project.writeFile", { path: "/data/history.json", text: JSON.stringify(history, null, 2) + "\n" });
    engine.console.log("[Match] persisted — history " + history.length + " entries");
  }

  function finish(call, engine, winner, loser, reason) {
    if (state === "over") return;
    state = "over";
    result = { winner, loser, reason };
    setFrozen(call, true);
    gameState(call, "end");
    showResult(call, engine);
    engine.mcp.emit("battlebots.matchResult", { winner, loser, reason, mode });
    // After the event, so MatchTelemetry's own listener has already run and the
    // damage report it triggers is the final one.
    persist(call, engine, winner, loser, reason);
    engine.console.log("[Match] over — winner=" + (winner || "draw") + " (" + reason + ")");
  }

  /** Time ran out: whoever dealt more damage takes it. */
  function judgeOnDamage(call, engine) {
    latestReport = null;
    engine.mcp.emit("battlebots.requestReport", {});
    const rep = latestReport;
    if (!rep || !rep.bots || !rep.bots.length) return finish(call, engine, null, null, "time expired, no data");
    const ranked = rep.bots.slice().sort((a, b) => b.damageDealt - a.damageDealt);
    if (ranked.length < 2 || Math.abs(ranked[0].damageDealt - ranked[1].damageDealt) < 0.5) {
      return finish(call, engine, null, null, "time expired, damage even");
    }
    finish(call, engine, ranked[0].role, ranked[1].role,
      "time expired on damage " + ranked[0].damageDealt.toFixed(0) + " vs " + ranked[1].damageDealt.toFixed(0));
  }

  return {
    onStart({ engine, call, params }) {
      // Before anything else: a driveable scene with no bindings is a dead controller.
      applyInputMap(call, engine);

      mode = params.mode === "practice" ? "practice" : "match";
      sceneName = params.sceneName || "Arena01";
      // The session, not the scene, decides whether this is a versus match — Arena01
      // serves both modes unchanged (T-6.9).
      versus = false;
      const sres = call("project.readFile", { path: "/data/session.json" });
      if (sres && !sres.isError && sres.content) {
        try { versus = JSON.parse(sres.content.text).players === 2; } catch (err) { versus = false; }
      }
      matchSeconds = typeof params.matchSeconds === "number" ? params.matchSeconds : 120;
      countdownSeconds = typeof params.countdownSeconds === "number" ? params.countdownSeconds : 3;
      playerRole = params.playerRole || "player";

      state = "countdown";
      clock = countdownSeconds;
      result = null;
      bots = findBots(call);
      buildUi(call);
      setFrozen(call, true);

      offKo = engine.mcp.on("battlebots.knockout", (p) => {
        if (!p || !p.role || state === "over") return;
        const winner = bots.map((b) => b.role).find((r) => r !== p.role) || null;
        finish(call, engine, winner, p.role, p.reason || "knockout");
      });
      offReport = engine.mcp.on("battlebots.damageReport", (p) => { latestReport = p; });

      offClick = engine.mcp.on("ui.clicked", (p) => {
        const id = p && p.actionId;
        if (id === "match:rematch") {
          // Reloading the scene is the reset: part health lives in DamageSystem's
          // own map and force-broken joints are runtime state, so a fresh load
          // restores both without any bespoke teardown (T-5.8).
          engine.console.log("[Match] rematch — reloading " + sceneName);
          call("project.loadScene", { name: sceneName });
        } else if (id === "match:changebot") {
          engine.console.log("[Match] back to bot select");
          call("project.loadScene", { name: "BotSelect" });
          return;
        }
        if (id === "match:results") {
          // The breakdown lives in its own scene (T-6.4) reading /data/last-match.json,
          // because everything it shows dies with this one.
          call("project.writeFile", { path: "/data/return-to.json",
            text: JSON.stringify({ scene: sceneName, mode }) + "\n" });
          call("project.loadScene", { name: "PostMatch" });
        }
      });

      // Practice has no clock and no verdict, so its way out has to be permanent.
      if (mode === "practice") {
        call("ui.setProps", { entity: ui.btnA, props: { visible: true, disabled: false, text: "Restart" } });
        call("ui.setProps", { entity: ui.btnB, props: { visible: true, disabled: false } });
        call("ui.setProps", { entity: ui.midPanel, props: { visible: true } });
        call("ui.setProps", { entity: ui.sub, props: { text: "Practice — no clock, no verdict", color: COL_DIM } });
      }

      engine.console.log("[Match] " + mode + " in " + sceneName + " — "
        + bots.length + " bots, " + (mode === "match" ? matchSeconds + "s" : "untimed"));
    },

    onDestroy({ call }) {
      if (offKo) { offKo(); offKo = null; }
      if (offReport) { offReport(); offReport = null; }
      if (offClick) { offClick(); offClick = null; }
      if (ui.canvas) {
        try { call("ui.remove", { entity: ui.canvas }); } catch (err) { /* gone */ }
        ui.canvas = 0;
      }
    },

    onUpdate({ engine, call, dt }) {
      if (!bots.length) bots = findBots(call);

      if (state === "countdown") {
        clock -= dt;
        const n = Math.max(0, Math.ceil(clock));
        call("ui.setProps", { entity: ui.banner, props: { text: n > 0 ? String(n) : "FIGHT", color: COL_TEXT } });
        if (clock <= 0) {
          state = "fighting";
          clock = 0;
          setFrozen(call, false);
          gameState(call, "start");
          engine.mcp.emit("battlebots.matchState", { state: "fighting", mode });
        }
        return;
      }

      if (state === "fighting") {
        clock += dt;
        if (mode === "match") {
          const left = Math.max(0, matchSeconds - clock);
          const mm = Math.floor(left / 60);
          const ss = Math.floor(left % 60);
          call("ui.setProps", { entity: ui.banner, props: { text: mm + ":" + (ss < 10 ? "0" : "") + ss, color: COL_TEXT } });
          if (left <= 0) judgeOnDamage(call, engine);
        } else {
          const mm = Math.floor(clock / 60);
          const ss = Math.floor(clock % 60);
          call("ui.setProps", { entity: ui.banner, props: { text: "PRACTICE  " + mm + ":" + (ss < 10 ? "0" : "") + ss, color: COL_DIM } });
        }
      }
    },
  };
}
