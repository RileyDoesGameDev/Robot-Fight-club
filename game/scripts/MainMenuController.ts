/**
 * MainMenuController — the front door. (T-6.1, and the missing leg of T-6.2)
 *
 * Attach to one marker entity in `MainMenu` (Name `MainMenu`).
 *
 * THE FIVE ENTRIES, AND WHAT THEY MEAN NOW
 *   The proposal's menu was Create / Test / Destroy / Options / Quit, written when
 *   Create meant a part-fitting Workshop. That was cut (DESIGN §0), so Create now
 *   means *choose* a bot, and all three play entries funnel through Bot Select
 *   rather than three separate paths:
 *
 *     CREATE   -> BotSelect, browsing mode
 *     TEST     -> BotSelect carrying intent `practice` (spar in the Demo Center)
 *     DESTROY  -> BotSelect carrying intent `fight` (timed match in Arena01)
 *     OPTIONS  -> an in-place panel, not a scene (T-6.13)
 *     QUIT     -> see below
 *
 *   Intent rides `/data/session.json`, the same trick the blueprint hand-off uses:
 *   the destination reads a file, so no scene needs to know this one exists.
 *
 * QUIT IN A BROWSER
 *   There is no quit. `window.close()` is refused for pages the script did not
 *   open, and the build is a web page. Pretending otherwise would ship a button
 *   that silently does nothing, so it says what is actually true and leaves the
 *   tab alone. If this ever ships as a desktop wrapper, this is the one line to
 *   change.
 *
 * THE RECORD LINE
 *   Read from `/data/history.json` (T-6.5), which MatchDirector appends to. It is
 *   the only reason the menu touches persistence at all.
 */

const COL_PANEL = 0x161a20;
const COL_TEXT = 0xe8e8ea;
const COL_DIM = 0x9aa0a8;
const COL_BTN = 0x2a3441;
const COL_ACCENT = 0xffcc33;

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

function uiPx(size) {
  let h = 0;
  try {
    const canvases = (typeof document !== "undefined" && document.querySelectorAll)
      ? document.querySelectorAll("canvas") : [];
    for (const c of canvases) h = Math.max(h, c.clientHeight || 0);
    if (!h) h = (typeof globalThis !== "undefined" && globalThis.innerHeight) || UI_DESIGN_HEIGHT;
  } catch (err) {
    h = UI_DESIGN_HEIGHT;
  }
  const k = Math.max(0.75, Math.min(2.5, h / UI_DESIGN_HEIGHT));
  return Math.round(size * k);
}

export default function create() {
  let ui = { canvas: 0, record: 0, hint: 0, options: 0 };
  let off = null;
  let optionsOpen = false;

  function readJson(call, path, fallback) {
    const r = call("project.readFile", { path });
    if (!r || r.isError || !r.content) return fallback;
    try { return JSON.parse(r.content.text); } catch (err) { return fallback; }
  }

  function setIntent(call, intent) {
    call("project.writeFile", { path: "/data/session.json",
      text: JSON.stringify({ intent }, null, 2) + "\n" });
  }

  function build(call) {
    const panel = (min, max) => ({
      props: { kind: "panel", visible: true, backgroundColor: COL_PANEL,
        layout: { anchorMin: min, anchorMax: max, offsetMin: [0, 0], offsetMax: [0, 0] } },
      children: [],
    });
    const text = (min, max, t, size, color) => ({
      props: { kind: "text", visible: true, text: t, color: color || COL_TEXT, fontSize: uiPx(size || 13),
        layout: { anchorMin: min, anchorMax: max, offsetMin: [0, 0], offsetMax: [0, 0] } },
    });
    const button = (min, max, t, actionId) => ({
      props: { kind: "button", visible: true, text: t, actionId, color: COL_TEXT,
        backgroundColor: COL_BTN, fontSize: uiPx(14),
        layout: { anchorMin: min, anchorMax: max, offsetMin: [0, 0], offsetMax: [0, 0] } },
    });

    ui.canvas = call("ui.createCanvas", { visible: true }).content.canvas;
    const graft = (spec) => call("ui.createTree", { canvas: ui.canvas, visible: true, spec }).content.elements;

    const title = panel([0.3, 0.06], [0.7, 0.22]);
    title.children.push(text([0.02, 0.08], [0.98, 0.6], "BATTLE BOTS", 26, COL_ACCENT));
    title.children.push(text([0.02, 0.62], [0.98, 0.95], "physics-based robot combat", 12, COL_DIM));
    graft(title);

    const menu = panel([0.36, 0.26], [0.64, 0.78]);
    const rows = [
      ["CREATE", "menu:create"],
      ["TEST", "menu:test"],
      ["DESTROY", "menu:destroy"],
      ["OPTIONS", "menu:options"],
      ["QUIT", "menu:quit"],
    ];
    for (let i = 0; i < rows.length; i++) {
      const y0 = 0.04 + i * 0.192;
      menu.children.push(button([0.08, y0], [0.92, y0 + 0.165], rows[i][0], rows[i][1]));
    }
    graft(menu);

    const foot = panel([0.28, 0.82], [0.72, 0.95]);
    foot.children.push(text([0.02, 0.06], [0.98, 0.5], "", 12, COL_DIM));
    foot.children.push(text([0.02, 0.52], [0.98, 0.95], "", 11, COL_DIM));
    const f = graft(foot);
    ui.record = f[1];
    ui.hint = f[2];

    // Options is a panel rather than a scene: it is four lines of read-only text
    // until there is an audio bus to attach a slider to (T-6.13, T-6.20).
    const opts = panel([0.28, 0.26], [0.72, 0.78]);
    opts.children.push(text([0.04, 0.04], [0.96, 0.16], "OPTIONS", 16));
    opts.children.push(text([0.06, 0.2], [0.96, 0.31], "Drive        W / S", 12, COL_DIM));
    opts.children.push(text([0.06, 0.32], [0.96, 0.43], "Turn         A / D", 12, COL_DIM));
    opts.children.push(text([0.06, 0.44], [0.96, 0.55], "Weapon       Space", 12, COL_DIM));
    opts.children.push(text([0.06, 0.56], [0.96, 0.67], "Self-right   R", 12, COL_DIM));
    opts.children.push(text([0.06, 0.68], [0.96, 0.79], "AI overlay   F3        Pause  Esc", 12, COL_DIM));
    opts.children.push(button([0.34, 0.83], [0.66, 0.95], "Back", "menu:optionsback"));
    const o = graft(opts);
    ui.options = o[0];
    call("ui.setProps", { entity: ui.options, props: { visible: false } });
  }

  function refresh(call) {
    const history = readJson(call, "/data/history.json", []);
    const played = Array.isArray(history) ? history.length : 0;
    const won = Array.isArray(history) ? history.filter((h) => h.playerWon).length : 0;
    call("ui.setProps", { entity: ui.record, props: {
      text: played ? "record  " + won + "W / " + (played - won) + "L  over " + played + " matches"
                   : "no matches played yet" } });
    const sel = readJson(call, "/data/bots/__selected.json", null);
    call("ui.setProps", { entity: ui.hint, props: {
      text: sel && sel.name ? "current bot: " + sel.name : "no bot chosen yet" } });
  }

  function showOptions(call, on) {
    optionsOpen = on;
    call("ui.setProps", { entity: ui.options, props: { visible: on } });
  }

  return {
    onStart({ engine, call }) {
      build(call);
      refresh(call);
      showOptions(call, false);

      off = engine.mcp.on("ui.clicked", (p) => {
        const id = p && p.actionId;
        if (!id) return;
        if (id === "menu:create") { setIntent(call, "browse"); call("project.loadScene", { name: "BotSelect" }); return; }
        if (id === "menu:test") { setIntent(call, "practice"); call("project.loadScene", { name: "BotSelect" }); return; }
        if (id === "menu:destroy") { setIntent(call, "fight"); call("project.loadScene", { name: "BotSelect" }); return; }
        if (id === "menu:options") { showOptions(call, true); return; }
        if (id === "menu:optionsback") { showOptions(call, false); return; }
        if (id === "menu:quit") {
          // Honest about the platform rather than shipping a dead button.
          call("ui.setProps", { entity: ui.hint, props: {
            text: "this build runs in a browser — close the tab to quit", color: COL_ACCENT } });
          return;
        }
      });

      engine.console.log("[Menu] ready — canvas " + ui.canvas);
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
