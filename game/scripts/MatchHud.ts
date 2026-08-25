/**
 * MatchHud — in-match readout, damage feedback and pause. (T-6.11, T-6.12, T-6.13)
 *
 * Attach to one marker entity per fighting scene (Name `MatchHud`). Like
 * VfxDirector and MatchTelemetry it is a **pure consumer** of the `battlebots.*`
 * channels — it queries physics only to place the directional damage indicator, and
 * writes to no bot except to freeze them on pause.
 *
 * T-6.11 — WHAT IS ON SCREEN
 *   Two columns, player left and opponent right: overall condition, then a row per
 *   socket showing its health as a bar of blocks and its state by colour. Weapon
 *   state (spin-up / ready / jammed / striking) sits under each.
 *   The **match timer is deliberately not here** — MatchDirector already owns the
 *   top strip and its countdown, and two clocks that can disagree is worse than one.
 *
 * T-6.12 — FEEDBACK, AND WHY IT IS SPARSE
 *   Three signals, each tied to something the player must react to:
 *     hit flash        the struck row flashes white, so damage has a location
 *     direction        four edge marks; the one facing the blow lights up, from the
 *                      contact point taken into the chassis' own frame — the same
 *                      trick directional armour uses (T-5.4)
 *     part-lost call   a large centred callout when a mount lets go
 *   Anything more competes with the fight for attention. A screen-wide flash was
 *   tried first and it made the arena harder to read, not easier.
 *
 * T-6.13 — PAUSE
 *   Esc (`ui.pause`) toggles an overlay and freezes both bots through BotDrive's
 *   `frozen` param — the same flag MatchDirector's countdown uses, so pause and
 *   countdown cannot fight each other. Weapons keep spinning down naturally, which
 *   is what already happens during a countdown.
 *
 * COST
 *   The report is pulled at 5 Hz, not per frame: it is a full part table and nothing
 *   on screen changes faster than a person can read.
 */

const COL_PANEL = 0x12161c;
const COL_TEXT = 0xe8e8ea;
const COL_DIM = 0x8b929b;
const COL_OK = 0x66dd88;
const COL_WARN = 0xd8b23a;
const COL_BAD = 0xdd6666;
const COL_FLASH = 0xffffff;
const COL_BTN = 0x2a3441;

const ROWS = 8;                 // socket rows per bot; a full bot is 7 parts + chassis
const REPORT_HZ = 5;
const FLASH_SECONDS = 0.18;
const CALLOUT_SECONDS = 1.6;
const EDGE_SECONDS = 0.35;

/** Rotate v by quaternion q, and its inverse — for "which side was I hit on". */
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
function invRotate(q, v) { return rotate([-q[0], -q[1], -q[2], q[3]], v); }

/**
 * Type scale. (T-6.15)
 *
 * The UI lays out in ANCHOR space — every panel and button is a fraction of the
 * screen — but font sizes were written as absolute pixels. Those two do not agree:
 * on a 2560-wide deployment the panels grow to match the screen and the text stays
 * 14px, so the menu renders as tiny writing marooned in oversized boxes. It reads as
 * "squished", and it is invisible while authoring, because the editor's game view
 * happens to be about the size the numbers were picked against.
 *
 * So sizes below are DESIGN pixels against a 720p reference, and `uiPx` converts
 * them to real ones. The reference height is measured off the largest canvas in the
 * document rather than the window: in a deployed build that is the full-screen
 * viewport, and in the editor it is the game view panel, which is the number that
 * actually matters in each case. The clamp stops a very tall or very short window
 * turning the whole interface into either billboards or ants.
 *
 * Duplicated in every UI script on purpose — scripts cannot import each other
 * (engine-fixes.md LIM-002), and the alternative is routing type through a spawner
 * marker, which is the indirection `Script.params` exists to remove.
 */
const UI_DESIGN_HEIGHT = 720;

/**
 * Smallest canvas height we will believe. A canvas that has not been laid out yet
 * reports its default 150px, and a UI built against that number comes out at the
 * minimum scale — which is the "it boots squished" bug. Anything under this is
 * treated as "not measured" rather than as a very short window.
 */
const UI_MIN_BELIEVABLE_H = 240;

function uiPx(size) {
  let h = 0;
  try {
    const canvases = (typeof document !== "undefined" && document.querySelectorAll)
      ? document.querySelectorAll("canvas") : [];
    for (const c of canvases) {
      const ch = c.clientHeight || 0;
      if (ch >= UI_MIN_BELIEVABLE_H) h = Math.max(h, ch);
    }
    // The window is laid out before any script runs, so it is the reliable fallback
    // when the canvas is not measurable yet. It is the second choice rather than the
    // first because in the editor it is the whole browser window, not the game view.
    if (!h) {
      const w = (typeof globalThis !== "undefined" && globalThis.innerHeight) || 0;
      h = w >= UI_MIN_BELIEVABLE_H ? w : UI_DESIGN_HEIGHT;
    }
  } catch (err) {
    h = UI_DESIGN_HEIGHT;
  }
  const k = Math.max(0.75, Math.min(2.5, h / UI_DESIGN_HEIGHT));
  return Math.round(size * k);
}

export default function create() {
  let ui = { canvas: 0, cols: {}, callout: 0, edges: {}, pausePanel: 0, hint: 0 };
  let playerRole = "player";
  let versus = false;
  let reportTimer = 0;
  let latest = null;
  let paused = false;
  let wasPauseHeld = false;
  let calloutTimer = 0;
  /** entity -> seconds of flash left, keyed by the row it maps to */
  const flash = new Map();
  const edgeTimer = { front: 0, back: 0, left: 0, right: 0 };
  /** role -> last weapon line */
  const weapon = new Map();
  /** role -> chassis entity, learned from the report */
  const chassisOf = new Map();
  const offs = [];

  function bar(frac) {
    const n = Math.max(0, Math.min(10, Math.round(frac * 10)));
    return "[" + "#".repeat(n) + ".".repeat(10 - n) + "]";
  }

  function build(call) {
    const panel = (min, max, bg) => ({
      props: { kind: "panel", visible: true, backgroundColor: bg != null ? bg : COL_PANEL,
        layout: { anchorMin: min, anchorMax: max, offsetMin: [0, 0], offsetMax: [0, 0] } },
      children: [],
    });
    const text = (min, max, t, size, color) => ({
      props: { kind: "text", visible: true, text: t, color: color || COL_TEXT, fontSize: uiPx(size || 11),
        layout: { anchorMin: min, anchorMax: max, offsetMin: [0, 0], offsetMax: [0, 0] } },
    });
    const button = (min, max, t, actionId) => ({
      props: { kind: "button", visible: true, text: t, actionId, color: COL_TEXT,
        backgroundColor: COL_BTN, fontSize: uiPx(12),
        layout: { anchorMin: min, anchorMax: max, offsetMin: [0, 0], offsetMax: [0, 0] } },
    });

    ui.canvas = call("ui.createCanvas", { visible: true }).content.canvas;
    const graft = (spec) => call("ui.createTree", { canvas: ui.canvas, visible: true, spec }).content.elements;

    for (const [role, x0, x1] of [["player", 0.005, 0.235], ["opponent", 0.765, 0.995]]) {
      const col = panel([x0, 0.1], [x1, 0.62]);
      col.children.push(text([0.04, 0.02], [0.96, 0.1], "", 13));      // name
      col.children.push(text([0.04, 0.11], [0.96, 0.19], "", 11, COL_DIM)); // condition
      for (let i = 0; i < ROWS; i++) {
        const y0 = 0.21 + i * 0.083;
        col.children.push(text([0.04, y0], [0.96, y0 + 0.08], "", 10));
      }
      col.children.push(text([0.04, 0.89], [0.96, 0.98], "", 10, COL_DIM)); // weapon
      const e = graft(col);
      ui.cols[role] = { name: e[1], cond: e[2], rows: e.slice(3, 3 + ROWS), weapon: e[3 + ROWS] };
    }

    // T-6.12 — four edge marks around the player's side of the screen.
    const mk = (min, max) => {
      const p = panel(min, max, COL_PANEL);
      p.props.visible = false;
      return graft(p)[0];
    };
    ui.edges.front = mk([0.3, 0.085], [0.7, 0.1]);
    ui.edges.back = mk([0.3, 0.9], [0.7, 0.915]);
    ui.edges.left = mk([0.245, 0.2], [0.258, 0.8]);
    ui.edges.right = mk([0.742, 0.2], [0.755, 0.8]);

    const callout = panel([0.34, 0.66], [0.66, 0.74]);
    callout.children.push(text([0.02, 0.1], [0.98, 0.9], "", 18, COL_BAD));
    const c = graft(callout);
    ui.callout = c[1];
    call("ui.setProps", { entity: c[0], props: { visible: false } });
    ui.calloutPanel = c[0];

    const pause = panel([0.34, 0.3], [0.66, 0.7]);
    pause.children.push(text([0.04, 0.05], [0.96, 0.18], "PAUSED", 22));
    pause.children.push(text([0.06, 0.22], [0.96, 0.31], "W / S      drive", 12, COL_DIM));
    pause.children.push(text([0.06, 0.32], [0.96, 0.41], "A / D      turn", 12, COL_DIM));
    pause.children.push(text([0.06, 0.42], [0.96, 0.51], "E          weapon (toggle)", 12, COL_DIM));
    pause.children.push(text([0.06, 0.52], [0.96, 0.61], "R          self-right", 12, COL_DIM));
    pause.children.push(text([0.06, 0.62], [0.96, 0.71], "F3         AI overlay", 12, COL_DIM));
    pause.children.push(button([0.1, 0.76], [0.48, 0.9], "Resume", "hud:resume"));
    pause.children.push(button([0.52, 0.76], [0.9, 0.9], "Main Menu", "hud:menu"));
    const p = graft(pause);
    ui.pausePanel = p[0];
    call("ui.setProps", { entity: ui.pausePanel, props: { visible: false } });
  }

  function setFrozen(call, on) {
    for (const [, ent] of chassisOf) {
      const cur = call("scene.getComponent", { entity: ent, component: "Script" });
      const existing = cur && !cur.isError && cur.content && cur.content.params ? cur.content.params : {};
      // Read-modify-write: params is one field, and AiDriver writes `intent` into it.
      call("scene.setComponent", { entity: ent, component: "Script",
        patch: { params: Object.assign({}, existing, { frozen: on }) } });
    }
  }

  function setPaused(call, engine, on) {
    if (paused === on) return;
    paused = on;
    call("ui.setProps", { entity: ui.pausePanel, props: { visible: on } });
    setFrozen(call, on);
    engine.mcp.emit("battlebots.paused", { paused: on });
  }

  function refresh(call) {
    if (!latest) return;
    const byRole = new Map();
    for (const row of latest.parts) {
      if (!byRole.has(row.role)) byRole.set(row.role, []);
      byRole.get(row.role).push(row);
      if (row.socket === "chassis") chassisOf.set(row.role, row.entity);
    }
    for (const role of Object.keys(ui.cols)) {
      const col = ui.cols[role];
      const rows = byRole.get(role) || [];
      let hp = 0, max = 0;
      for (const r of rows) { hp += r.hp; max += r.maxHp; }
      const frac = max ? hp / max : 0;
      const label = versus ? (role === "player" ? "PLAYER 1" : "PLAYER 2")
        : role === playerRole ? "YOU" : "OPPONENT";
      call("ui.setProps", { entity: col.name, props: { text: label, color: COL_TEXT } });
      call("ui.setProps", { entity: col.cond, props: {
        text: bar(frac) + " " + Math.round(frac * 100) + "%",
        color: frac > 0.6 ? COL_OK : frac > 0.3 ? COL_WARN : COL_BAD } });

      for (let i = 0; i < col.rows.length; i++) {
        const r = rows[i];
        if (!r) { call("ui.setProps", { entity: col.rows[i], props: { text: "" } }); continue; }
        const f = r.maxHp ? r.hp / r.maxHp : 0;
        const flashing = (flash.get(r.entity) || 0) > 0;
        const color = flashing ? COL_FLASH
          : r.state === "destroyed" ? COL_BAD : r.state === "damaged" ? COL_WARN : COL_TEXT;
        const name = (r.socket + "         ").slice(0, 10);
        call("ui.setProps", { entity: col.rows[i], props: { text: name + bar(f), color } });
      }
      call("ui.setProps", { entity: col.weapon, props: {
        text: weapon.get(role) || "no weapon", color: COL_DIM } });
    }
  }

  /** Which face of the player's chassis a hit landed on (T-6.12). */
  function markDirection(call, victimEntity, point) {
    const chassis = chassisOf.get(playerRole);
    if (!chassis || !point) return;
    const res = call("physics.bodyState", { entity: chassis });
    const b = res && !res.isError ? res.content : null;
    if (!b || !b.rotation || !b.position) return;
    const q = [b.rotation.x, b.rotation.y, b.rotation.z, b.rotation.w];
    const local = invRotate(q, [point.x - b.position.x, point.y - b.position.y, point.z - b.position.z]);
    // Chassis nose is -Z (the convention BotDrive drives on).
    if (Math.abs(local[2]) >= Math.abs(local[0])) {
      if (local[2] < 0) edgeTimer.front = EDGE_SECONDS; else edgeTimer.back = EDGE_SECONDS;
    } else if (local[0] < 0) edgeTimer.left = EDGE_SECONDS;
    else edgeTimer.right = EDGE_SECONDS;
  }

  return {
    onStart({ engine, call, params }) {
      playerRole = params.playerRole || "player";
      // In versus there is no single "you", so the columns are named by seat and the
      // directional indicator is suppressed — it can only point for one of them.
      versus = false;
      const sres = call("project.readFile", { path: "/data/session.json" });
      if (sres && !sres.isError && sres.content) {
        try { versus = JSON.parse(sres.content.text).players === 2; } catch (err) { versus = false; }
      }
      paused = false;
      latest = null;
      flash.clear();
      weapon.clear();
      chassisOf.clear();
      build(call);

      offs.push(engine.mcp.on("battlebots.damageReport", (p) => { latest = p; }));

      offs.push(engine.mcp.on("battlebots.weaponHit", (p) => {
        if (!p) return;
        if (p.victim) flash.set(p.victim, FLASH_SECONDS);
        // Only the player's own damage gets a direction — an indicator for a hit the
        // player did not take is noise.
        if (!versus && p.role !== playerRole) markDirection(call, p.victim, p.point);
      }));

      offs.push(engine.mcp.on("battlebots.partDetached", (p) => {
        if (!p) return;
        const mine = p.role === playerRole;
        call("ui.setProps", { entity: ui.calloutPanel, props: { visible: true } });
        call("ui.setProps", { entity: ui.callout, props: {
          text: (mine ? "LOST " : "TORE OFF ") + String(p.socketId || "").toUpperCase().replace("_", " "),
          color: mine ? COL_BAD : COL_OK } });
        calloutTimer = CALLOUT_SECONDS;
      }));

      offs.push(engine.mcp.on("battlebots.weaponState", (p) => {
        if (!p || !p.role) return;
        const rpm = p.rpm ? "  " + p.rpm + " rpm" : "";
        weapon.set(p.role, "weapon: " + p.state + rpm);
      }));

      offs.push(engine.mcp.on("ui.clicked", (p) => {
        const id = p && p.actionId;
        if (id === "hud:resume") { setPaused(call, engine, false); return; }
        if (id === "hud:menu") { call("project.loadScene", { name: "MainMenu" }); return; }
      }));

      engine.console.log("[Hud] ready — canvas " + ui.canvas);
    },

    onDestroy({ call }) {
      for (const off of offs) off();
      offs.length = 0;
      if (ui.canvas) {
        try { call("ui.remove", { entity: ui.canvas }); } catch (err) { /* already gone */ }
        ui.canvas = 0;
      }
    },

    onUpdate({ engine, call, dt }) {
      // Pause is read on the FRAME hook, not the fixed one: while paused the match
      // is frozen but frames keep coming, and a fixed-step read would still work —
      // this just keeps the key feeling immediate.
      const held = engine.input.actionHeld("ui.pause");
      if (held && !wasPauseHeld) setPaused(call, engine, !paused);
      wasPauseHeld = held;

      for (const k of Object.keys(edgeTimer)) {
        if (edgeTimer[k] <= 0) continue;
        edgeTimer[k] -= dt;
        call("ui.setProps", { entity: ui.edges[k], props: { visible: edgeTimer[k] > 0 } });
      }
      if (calloutTimer > 0) {
        calloutTimer -= dt;
        if (calloutTimer <= 0) call("ui.setProps", { entity: ui.calloutPanel, props: { visible: false } });
      }
      for (const [e, left] of Array.from(flash)) {
        const next = left - dt;
        if (next <= 0) flash.delete(e); else flash.set(e, next);
      }

      reportTimer -= dt;
      if (reportTimer > 0) return;
      reportTimer = 1 / REPORT_HZ;
      engine.mcp.emit("battlebots.requestReport", {});
      refresh(call);
    },
  };
}
