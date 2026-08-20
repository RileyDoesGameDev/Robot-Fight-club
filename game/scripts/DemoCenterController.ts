/**
 * DemoCenterController — the Test stage. (T-3.15)
 *
 * Attach to a marker named `DemoCenter`. Adds the two things practice needs that a
 * real match does not: a way to pick who you are sparring against, and a reminder of
 * the controls. Restart comes from MatchDirector's practice mode.
 *
 * OPPONENT SELECT
 *   The scene's opponent spawner is `BotSpawn:__opponent:opponent`, so choosing an
 *   opponent is just writing `/data/bots/__opponent.json` and reloading — the same
 *   pattern Bot Select uses for the player's bot, and it needs no new machinery in
 *   the assembler.
 *
 * WHY RELOAD RATHER THAN SWAP IN PLACE
 *   Swapping a live bot would mean tearing down eight jointed bodies and rebuilding
 *   them while the damage system holds references to them. Reloading the scene is
 *   one call, cannot leave a dangling reference, and resets part health too — which
 *   is what you want between practice rounds anyway.
 */

const BUNDLE_PATH = "/data/bundle.json";
const OPPONENT_PATH = "/data/bots/__opponent.json";
const OPP_ROWS = 8;

const COL_PANEL = 0x14161c;
const COL_BTN = 0x272b36;
const COL_BTN_ON = 0xd8a021;
const COL_TEXT = 0xe8e8ee;
const COL_DIM = 0x9aa0ad;

/**
 * The Demo Center's primer (T-6.14). Controls first, then the four things that
 * actually decide a match and are not discoverable by pressing buttons: the pit,
 * the floor spinners, what losing a part costs you, and the fact that a weapon has
 * to be at speed to matter. Kept to one screen — a panel nobody finishes reading
 * teaches nothing.
 */
const TIPS = [
  "W / S — drive forward and back",
  "A / D — turn (tank steer)",
  "Space — weapon: hold to spin up, or to swing",
  "R — self-right when flipped",
  "Esc — pause    F3 — AI debug overlay",
  "",
  "The corner pits are real. Fall in and you lose.",
  "Red floor discs bite — they can tear a wheel off.",
  "Lose 3 of 4 wheels or your motor and you stop.",
  "A blade at rest only shoves. Spin up before you commit.",
];

export default function create() {
  let bundle = null;
  let roster = [];
  let currentName = null;
  let off = null;
  const ui = { canvas: 0, rows: [] };

  function buildUi(call) {
    const panel = (min, max) => ({
      props: { kind: "panel", visible: true, backgroundColor: COL_PANEL,
        layout: { anchorMin: min, anchorMax: max, offsetMin: [0, 0], offsetMax: [0, 0] } },
      children: [],
    });
    const text = (min, max, t, size, color) => ({
      props: { kind: "text", visible: true, text: t, color: color || COL_TEXT, fontSize: size || 12,
        layout: { anchorMin: min, anchorMax: max, offsetMin: [0, 0], offsetMax: [0, 0] } },
    });
    const button = (min, max, t, actionId) => ({
      props: { kind: "button", visible: true, text: t, actionId, color: COL_TEXT,
        backgroundColor: COL_BTN, fontSize: 12,
        layout: { anchorMin: min, anchorMax: max, offsetMin: [0, 0], offsetMax: [0, 0] } },
    });

    ui.canvas = call("ui.createCanvas", { visible: true }).content.canvas;
    const graft = (spec) => call("ui.createTree", { canvas: ui.canvas, visible: true, spec }).content.elements;

    // left: who am I sparring with
    const left = panel([0.005, 0.02], [0.24, 0.62]);
    left.children.push(text([0.05, 0.02], [0.95, 0.11], "SPAR AGAINST", 14));
    for (let i = 0; i < OPP_ROWS; i++) {
      const y0 = 0.14 + i * 0.105;
      left.children.push(button([0.05, y0], [0.95, y0 + 0.09], "-", "opp:" + i));
    }
    const l = graft(left);
    ui.rows = l.slice(2, 2 + OPP_ROWS);

    // left-bottom: controls
    const tips = panel([0.005, 0.55], [0.24, 0.985]);
    tips.children.push(text([0.05, 0.03], [0.95, 0.13], "CONTROLS", 14));
    for (let i = 0; i < TIPS.length; i++) {
      const y0 = 0.12 + i * 0.086;
      tips.children.push(text([0.06, y0], [0.97, y0 + 0.08], TIPS[i], 10, COL_DIM));
    }
    graft(tips);
  }

  function refresh(call) {
    for (let i = 0; i < OPP_ROWS; i++) {
      const entry = roster[i];
      call("ui.setProps", {
        entity: ui.rows[i],
        props: entry
          ? {
              visible: true, disabled: false,
              text: entry.bp.name + "  " + entry.bp.derived.totalMassKg + "kg",
              actionId: "opp:" + i,
              backgroundColor: entry.bp.name === currentName ? COL_BTN_ON : COL_BTN,
            }
          : { visible: false, disabled: true, text: "", actionId: "opp:" + i },
      });
    }
  }

  return {
    onStart({ engine, call }) {
      bundle = JSON.parse(call("project.readFile", { path: BUNDLE_PATH }).content.text);
      roster = Object.keys(bundle.bots)
        .map((id) => ({ id, bp: bundle.bots[id] }))
        .sort((a, b) => a.bp.derived.totalMassKg - b.bp.derived.totalMassKg);

      try {
        currentName = JSON.parse(call("project.readFile", { path: OPPONENT_PATH }).content.text).name;
      } catch (err) {
        currentName = null;
      }

      buildUi(call);
      refresh(call);

      off = engine.mcp.on("ui.clicked", (p) => {
        const id = p && p.actionId;
        if (!id || id.indexOf("opp:") !== 0) return;
        const i = parseInt(id.slice(4), 10);
        const entry = roster[i];
        if (!entry) return;
        call("project.writeFile", { path: OPPONENT_PATH, text: JSON.stringify(entry.bp, null, 2) });
        engine.console.log("[Demo] sparring against " + entry.bp.name + " — reloading");
        call("project.loadScene", { name: "DemoCenter" });
      });

      engine.console.log("[Demo] ready — " + roster.length + " opponents, current " + currentName);
    },

    onDestroy({ call }) {
      if (off) { off(); off = null; }
      if (ui.canvas) {
        try { call("ui.remove", { entity: ui.canvas }); } catch (err) { /* gone */ }
        ui.canvas = 0;
      }
    },
  };
}
