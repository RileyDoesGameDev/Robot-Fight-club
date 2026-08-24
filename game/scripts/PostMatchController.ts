/**
 * PostMatchController — the breakdown after a match. (T-6.4, closing T-6.2)
 *
 * Attach to one marker entity in `PostMatch` (Name `PostMatch`).
 *
 * WHY IT READS A FILE INSTEAD OF ASKING
 *   Everything on this screen — part health, damage dealt, what came off — lives in
 *   DamageSystem's own Map, and that Map is per-instance by design (T-5.8): health
 *   resetting on scene load is exactly what makes Rematch a single `loadScene` call.
 *   The consequence is that a post-match screen in a *different* scene has nothing
 *   to ask. So MatchDirector writes `/data/last-match.json` at `finish()`, while it
 *   still has the report, and this screen reads it. The same hand-off shape as the
 *   blueprint one: a file, so neither scene knows the other exists.
 *
 * THE WAYS OUT
 *   REMATCH      back to the scene named in `/data/return-to.json`
 *   REVISE BOT   to Bot Select — the proposal says "back into the Workshop", and
 *                since the Workshop was cut (DESIGN §0) the equivalent act is
 *                choosing a different bot
 *   MAIN MENU    to MainMenu
 */

const COL_PANEL = 0x161a20;
const COL_TEXT = 0xe8e8ea;
const COL_DIM = 0x9aa0a8;
const COL_BTN = 0x2a3441;
const COL_WIN = 0x66dd88;
const COL_LOSE = 0xdd6666;

const PART_ROWS = 10;

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
  let ui = { canvas: 0, verdict: 0, sub: 0, stats: [], rows: [] };
  let off = null;
  let record = null;
  let returnTo = { scene: "Arena01", mode: "match" };

  function readJson(call, path, fallback) {
    const r = call("project.readFile", { path });
    if (!r || r.isError || !r.content) return fallback;
    try { return JSON.parse(r.content.text); } catch (err) { return fallback; }
  }

  function build(call) {
    const panel = (min, max) => ({
      props: { kind: "panel", visible: true, backgroundColor: COL_PANEL,
        layout: { anchorMin: min, anchorMax: max, offsetMin: [0, 0], offsetMax: [0, 0] } },
      children: [],
    });
    const text = (min, max, t, size, color) => ({
      props: { kind: "text", visible: true, text: t, color: color || COL_TEXT, fontSize: uiPx(size || 12),
        layout: { anchorMin: min, anchorMax: max, offsetMin: [0, 0], offsetMax: [0, 0] } },
    });
    const button = (min, max, t, actionId) => ({
      props: { kind: "button", visible: true, text: t, actionId, color: COL_TEXT,
        backgroundColor: COL_BTN, fontSize: uiPx(13),
        layout: { anchorMin: min, anchorMax: max, offsetMin: [0, 0], offsetMax: [0, 0] } },
    });

    ui.canvas = call("ui.createCanvas", { visible: true }).content.canvas;
    const graft = (spec) => call("ui.createTree", { canvas: ui.canvas, visible: true, spec }).content.elements;

    const head = panel([0.25, 0.04], [0.75, 0.19]);
    head.children.push(text([0.02, 0.06], [0.98, 0.6], "", 22));
    head.children.push(text([0.02, 0.62], [0.98, 0.95], "", 12, COL_DIM));
    const h = graft(head);
    ui.verdict = h[1];
    ui.sub = h[2];

    // Left: the numbers the proposal asks for by name.
    const left = panel([0.16, 0.22], [0.49, 0.78]);
    left.children.push(text([0.05, 0.03], [0.95, 0.13], "SCORECARD", 15));
    for (let i = 0; i < 6; i++) {
      const y0 = 0.16 + i * 0.13;
      left.children.push(text([0.06, y0], [0.96, y0 + 0.12], "", 12));
    }
    const l = graft(left);
    ui.stats = l.slice(2, 8);

    // Right: what actually came off, which is the part players argue about.
    const right = panel([0.51, 0.22], [0.84, 0.78]);
    right.children.push(text([0.05, 0.03], [0.95, 0.13], "YOUR BOT", 15));
    for (let i = 0; i < PART_ROWS; i++) {
      const y0 = 0.15 + i * 0.082;
      right.children.push(text([0.06, y0], [0.96, y0 + 0.078], "", 11));
    }
    const r = graft(right);
    ui.rows = r.slice(2, 2 + PART_ROWS);

    const bar = panel([0.22, 0.81], [0.78, 0.93]);
    bar.children.push(button([0.02, 0.14], [0.32, 0.86], "Rematch", "pm:rematch"));
    bar.children.push(button([0.35, 0.14], [0.65, 0.86], "Revise Bot", "pm:revise"));
    bar.children.push(button([0.68, 0.14], [0.98, 0.86], "Main Menu", "pm:menu"));
    graft(bar);
  }

  function refresh(call) {
    const set = (e, t, c) => call("ui.setProps", { entity: e, props: c != null ? { text: t, color: c } : { text: t } });

    if (!record) {
      set(ui.verdict, "NO MATCH RECORDED", COL_DIM);
      set(ui.sub, "play a match first — this screen reads /data/last-match.json");
      return;
    }
    const role = record.playerRole || "player";
    const won = record.winner === role;
    const drew = !record.winner;
    set(ui.verdict, drew ? "DRAW" : won ? "YOU WIN" : "YOU LOSE", drew ? COL_DIM : won ? COL_WIN : COL_LOSE);
    const mine = (record.bots && record.bots.player) || "your bot";
    const theirs = (record.bots && record.bots.opponent) || "opponent";
    set(ui.sub, mine + "  vs  " + theirs + "   —   " + (record.reason || "") + "   —   "
      + (record.elapsedSeconds != null ? record.elapsedSeconds + " s" : ""));

    const foe = role === "player" ? "opponent" : "player";
    const dealt = record.damageDealt || {};
    const lost = record.partsLost || {};
    const rows = [
      "damage dealt      " + Math.round(dealt[role] || 0),
      "damage taken      " + Math.round(dealt[foe] || 0),
      "parts lost        " + (lost[role] || 0),
      "parts torn off it " + (lost[foe] || 0),
      "ended by          " + (record.reason || "-"),
      "arena             " + (record.scene || "-") + "  (" + (record.mode || "-") + ")",
    ];
    for (let i = 0; i < ui.stats.length; i++) set(ui.stats[i], rows[i] || "");

    const parts = (record.parts || []).filter((p) => p.role === role);
    for (let i = 0; i < ui.rows.length; i++) {
      const p = parts[i];
      if (!p) { set(ui.rows[i], ""); continue; }
      const pct = p.maxHp ? Math.round((p.hp / p.maxHp) * 100) : 0;
      const col = p.state === "destroyed" ? COL_LOSE : p.state === "damaged" ? 0xd8b23a : COL_TEXT;
      set(ui.rows[i], (p.socket + "            ").slice(0, 13) + " " + String(pct).padStart(3) + "%  " + p.state, col);
    }
  }

  return {
    onStart({ engine, call }) {
      record = readJson(call, "/data/last-match.json", null);
      returnTo = readJson(call, "/data/return-to.json", returnTo) || returnTo;
      build(call);
      refresh(call);

      off = engine.mcp.on("ui.clicked", (p) => {
        const id = p && p.actionId;
        if (!id) return;
        if (id === "pm:rematch") { call("project.loadScene", { name: returnTo.scene || "Arena01" }); return; }
        if (id === "pm:revise") { call("project.loadScene", { name: "BotSelect" }); return; }
        if (id === "pm:menu") { call("project.loadScene", { name: "MainMenu" }); return; }
      });

      engine.console.log("[PostMatch] ready — " + (record ? "winner=" + (record.winner || "draw") : "no record"));
    },

    onDestroy({ call }) {
      if (off) { off(); off = null; }
      if (ui.canvas) {
        try { call("ui.remove", { entity: ui.canvas }); } catch (err) { /* already gone */ }
        ui.canvas = 0;
      }
    },
  };
}
