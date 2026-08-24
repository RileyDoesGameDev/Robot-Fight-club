/**
 * BotSelectController — the Create stage after the 2026-08-19 descope. (T-2.21)
 *
 * Attach to a marker entity named `BotSelect`. Shows the prebuilt roster, previews
 * the highlighted bot on a turntable, and writes the confirmed choice where the
 * arena can pick it up.
 *
 * WHY THIS REPLACES BUILDING
 *   The player-facing build system was cut (DESIGN.md §0). The socket model stays —
 *   every bot here is a BotBlueprint over PartDefs — but the designer authors them,
 *   not the player.
 *
 * PREVIEW
 *   Same path as the Workshop: write nothing, just spawn a marker named
 *   `BotSpawn:<id>:select` and let BotAssembler build it. Role `select` is inert, so
 *   the preview gets no drivetrain and no AI brain.
 *
 *   Rebuilding deletes the marker and makes a new one. That is safe now: deleting a
 *   Script-bearing entity from inside a hook used to kill the frame loop (BUG-011),
 *   which is why the Workshop still carries a 3-frame workaround it no longer needs.
 *
 * HAND-OFF (T-2.22)
 *   Confirm writes the chosen blueprint to `/data/bots/__selected.json`. `Arena01`'s
 *   player spawner is `BotSpawn:__selected:player`, and BotAssembler already resolves
 *   an id from `/data/bots/<id>.json` when it is not in the bundle — so the selection
 *   flows through machinery that already existed. Actual scene switching is T-6.2.
 */

const BUNDLE_PATH = "/data/bundle.json";
const SELECTION_PATH = "/data/bots/__selected.json";
/** Arena01's stock challenger, preserved from when its spawner named it directly. */
const DEFAULT_ARENA_FOE = "opp-wedge";
const TURNTABLE_TOP_Y = 0.12;
const ROSTER_ROWS = 8;
const CARD_ROWS = 7;

const COL_PANEL = 0x14161c;
const COL_BTN = 0x272b36;
const COL_BTN_ON = 0x2d6cdf;
const COL_TEXT = 0xe8e8ee;
const COL_DIM = 0x9aa0ad;
const COL_OK = 0x4fb36a;

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
  let bundle = null;
  let roster = [];          // [{ id, bp }] sorted by mass
  let index = 0;
  let marker = 0;
  let confirmedId = null;
  let off = null;
  const ui = { canvas: 0, rows: [], card: [], title: 0, hint: 0 };

  function named(call) {
    return call("scene.query", { components: ["Name"] }).content.entities.map((e) => ({
      e, n: call("scene.getComponent", { entity: e, component: "Name" }).content.value,
    }));
  }

  /** Rest height so the bot sits on the turntable rather than through it. */
  function spawnHeight(bp) {
    let maxR = 0.12;
    for (const a of bp.attachments) {
      const def = bundle.parts[a.partId];
      if (def && def.category === "wheel" && def.colliderSpec.radius > maxR) maxR = def.colliderSpec.radius;
    }
    return TURNTABLE_TOP_Y + maxR + 0.06;
  }

  function clearPreview(call) {
    for (const x of named(call)) {
      if (/^Bot_select_/.test(x.n) && /Visual/.test(x.n)) call("scene.deleteEntity", { entity: x.e });
    }
    for (const x of named(call)) {
      if (/^Bot_select_/.test(x.n)) call("scene.deleteEntity", { entity: x.e });
    }
    for (const x of named(call)) {
      if (/^BotSpawn(ed)?:.*:select$/.test(x.n)) call("scene.deleteEntity", { entity: x.e });
    }
    marker = 0;
  }

  function showPreview(call) {
    const entry = roster[index];
    if (!entry) return;
    clearPreview(call);
    marker = call("scene.createEntity", {
      components: {
        Name: { value: "BotSpawn:" + entry.id + ":select" },
        Transform: { position: [0, spawnHeight(entry.bp), 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      },
    }).content.entity;
    call("script.attach", { entity: marker, behavior: "BotAssembler", enabled: true, params: {} });
  }

  function weaponOf(bp) {
    for (const a of bp.attachments) {
      const def = bundle.parts[a.partId];
      if (def && def.category === "weapon") return def;
    }
    return null;
  }

  /**
   * Speed estimate: the MEASURED 4.46 m/s (98 kg reference build) scaled by motor
   * multiplier and inverse mass, then clamped to BotDrive's own MAX_SPEED. Without
   * the clamp the extrapolation runs away on light bots — Hornet read 8.23 m/s,
   * which the drivetrain cannot actually reach. It is a comparison aid between
   * bots, not a simulation.
   */
  function estSpeed(bp) {
    const DRIVE_MAX_SPEED = 7.0; // must track BotDrive.MAX_SPEED
    let mult = 1;
    for (const a of bp.attachments) {
      const def = bundle.parts[a.partId];
      if (def && def.category === "motor" && def.stats && def.stats.maxSpeedMultiplier) {
        mult = def.stats.maxSpeedMultiplier;
      }
    }
    return Math.min(DRIVE_MAX_SPEED, 4.46 * mult * (98 / bp.derived.totalMassKg));
  }

  function buildUi(call) {
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
        backgroundColor: COL_BTN, fontSize: uiPx(12),
        layout: { anchorMin: min, anchorMax: max, offsetMin: [0, 0], offsetMax: [0, 0] } },
    });

    const left = panel([0.005, 0.02], [0.27, 0.985]);
    left.children.push(text([0.05, 0.015], [0.95, 0.07], "CHOOSE YOUR BOT", 15));
    for (let i = 0; i < ROSTER_ROWS; i++) {
      const y0 = 0.09 + i * 0.105;
      left.children.push(button([0.04, y0], [0.96, y0 + 0.092], "-", "pick:" + i));
    }

    const right = panel([0.73, 0.02], [0.995, 0.72]);
    right.children.push(text([0.05, 0.02], [0.95, 0.1], "SPECS", 15));
    for (let i = 0; i < CARD_ROWS; i++) {
      const y0 = 0.13 + i * 0.115;
      right.children.push(text([0.06, y0], [0.97, y0 + 0.105], "", 12));
    }

    const bar = panel([0.26, 0.88], [0.74, 0.975]);
    bar.children.push(button([0.015, 0.15], [0.17, 0.85], "< Prev", "cmd:prev"));
    bar.children.push(button([0.185, 0.15], [0.34, 0.85], "Next >", "cmd:next"));
    bar.children.push(button([0.36, 0.15], [0.5, 0.85], "Menu", "cmd:menu"));
    bar.children.push(button([0.52, 0.15], [0.68, 0.85], "PRACTICE", "cmd:practice"));
    bar.children.push(button([0.7, 0.15], [0.84, 0.85], "FIGHT", "cmd:fight"));
    bar.children.push(button([0.86, 0.15], [0.985, 0.85], "VERSUS", "cmd:versus"));

    const head = panel([0.3, 0.02], [0.7, 0.11]);
    head.children.push(text([0.02, 0.05], [0.98, 0.55], "BOT SELECT", 16));
    head.children.push(text([0.02, 0.55], [0.98, 0.98], "", 12, COL_DIM));

    // `visible` is passed explicitly: a handler reached directly would skip zod and
    // create a hidden canvas. ctx.call parses, but being explicit costs nothing.
    ui.canvas = call("ui.createCanvas", { visible: true }).content.canvas;
    const graft = (spec) => call("ui.createTree", { canvas: ui.canvas, visible: true, spec }).content.elements;

    const l = graft(left);
    ui.rows = l.slice(2, 2 + ROSTER_ROWS);
    const r = graft(right);
    ui.card = r.slice(2, 2 + CARD_ROWS);
    graft(bar);
    const h = graft(head);
    ui.title = h[1];
    ui.hint = h[2];
  }

  function refresh(call) {
    for (let i = 0; i < ROSTER_ROWS; i++) {
      const entry = roster[i];
      call("ui.setProps", {
        entity: ui.rows[i],
        props: entry
          ? {
              visible: true, disabled: false,
              text: entry.bp.name + "  " + entry.bp.derived.totalMassKg + "kg"
                + (confirmedId === entry.id ? "  *" : ""),
              actionId: "pick:" + i,
              backgroundColor: i === index ? COL_BTN_ON : COL_BTN,
            }
          : { visible: false, disabled: true, text: "", actionId: "pick:" + i },
      });
    }

    const entry = roster[index];
    if (!entry) return;
    const bp = entry.bp;
    const weapon = weaponOf(bp);
    const cls = bundle.weightClasses.classes.find((c) => c.id === bp.derived.weightClass);
    const rows = [
      bp.name,
      (cls ? cls.displayName : bp.derived.weightClass) + "  ·  " + bp.derived.totalMassKg + " kg",
      "Weapon: " + (weapon ? weapon.displayName : "none"),
      "Armour: " + bp.derived.armorTotal,
      "Est. top speed: " + estSpeed(bp).toFixed(2) + " m/s",
      "Chassis: " + bundle.parts[bp.chassisId].displayName,
      bp.blurb || "",
    ];
    for (let i = 0; i < CARD_ROWS; i++) {
      call("ui.setProps", {
        entity: ui.card[i],
        props: { text: rows[i] || "", color: i === 0 ? COL_TEXT : COL_DIM, fontSize: uiPx(i === 0 ? 15 : 12) },
      });
    }
  }

  function setHint(call, t, ok) {
    call("ui.setProps", { entity: ui.hint, props: { text: t, color: ok ? COL_OK : COL_DIM } });
  }

  function move(call, delta) {
    if (!roster.length) return;
    index = (index + delta + roster.length) % roster.length;
    showPreview(call);
    refresh(call);
    setHint(call, roster[index].bp.name + " — PRACTICE to spar, FIGHT for a timed match", false);
  }

  /**
   * Local multiplayer selection (T-6.8). VERSUS is a two-STAGE use of this one
   * screen rather than a second screen: stage 1 writes player 1's bot to
   * __selected.json, stage 2 writes player 2's to __opponent.json, and the launch
   * happens at the end of stage 2. A separate 2P select screen would have been a
   * near-copy of this one, and the roster, the preview and the spec card are the
   * whole value here.
   */
  let versusStage = 0;   // 0 = not in versus, 1 = picking P1, 2 = picking P2

  function writeSession(call, players, intent) {
    call("project.writeFile", { path: "/data/session.json",
      text: JSON.stringify({ intent, players }, null, 2) + "\n" });
  }

  function confirm(call, engine) {
    const entry = roster[index];
    if (!entry) return;
    // Persist the choice where BotAssembler will resolve it: Arena01's player
    // spawner is `BotSpawn:__selected:player`, and the assembler already falls back
    // to /data/bots/<id>.json for anything not in the bundle.
    call("project.writeFile", { path: SELECTION_PATH, text: JSON.stringify(entry.bp, null, 2) });
    confirmedId = entry.id;
    refresh(call);
    setHint(call, "Selected " + entry.bp.name + " — load Arena01 to fight", true);
    engine.mcp.emit("battlebots.botSelected", { id: entry.id, name: entry.bp.name });
    engine.console.log("[Select] confirmed " + entry.id + " (" + entry.bp.name + ")");
  }

  return {
    onStart({ engine, call }) {
      bundle = JSON.parse(call("project.readFile", { path: BUNDLE_PATH }).content.text);
      roster = Object.keys(bundle.bots)
        .map((id) => ({ id, bp: bundle.bots[id] }))
        .sort((a, b) => a.bp.derived.totalMassKg - b.bp.derived.totalMassKg);

      // Reflect an existing selection so the screen opens on what is already chosen.
      try {
        const cur = JSON.parse(call("project.readFile", { path: SELECTION_PATH }).content.text);
        const found = roster.findIndex((r) => r.bp.name === cur.name);
        if (found >= 0) { index = found; confirmedId = roster[found].id; }
      } catch (err) {
        // no selection yet
      }

      buildUi(call);
      showPreview(call);
      refresh(call);
      let intent = "browse";
      const sess = call("project.readFile", { path: "/data/session.json" });
      if (sess && !sess.isError && sess.content) {
        try { intent = JSON.parse(sess.content.text).intent || "browse"; } catch (err) { intent = "browse"; }
      }
      setHint(call, intent === "practice"
        ? roster.length + " bots — pick one, then PRACTICE to spar in the Demo Center"
        : intent === "fight"
          ? roster.length + " bots — pick one, then FIGHT for a timed match in the arena"
          : roster.length + " bots — browse, then PRACTICE to spar or FIGHT for a timed match", false);

      off = engine.mcp.on("ui.clicked", (p) => {
        const id = p && p.actionId;
        if (!id) return;
        if (id.indexOf("pick:") === 0) {
          const i = parseInt(id.slice(5), 10);
          if (i >= 0 && i < roster.length) { index = i; showPreview(call); refresh(call);
            setHint(call, roster[index].bp.name + " — PRACTICE to spar, FIGHT for a timed match", false); }
          return;
        }
        if (id === "cmd:prev") return move(call, -1);
        if (id === "cmd:next") return move(call, 1);
        if (id === "cmd:menu") { call("project.loadScene", { name: "MainMenu" }); return; }
        if (id === "cmd:versus") {
          const entry = roster[index];
          if (!entry) return;
          if (versusStage <= 1) {
            call("project.writeFile", { path: SELECTION_PATH, text: JSON.stringify(entry.bp, null, 2) });
            versusStage = 2;
            setHint(call, "P1 takes " + entry.bp.name + " — now PLAYER 2, pick yours and press VERSUS", true);
            return;
          }
          // Stage 2: player 2's bot goes to the opponent seat, and the session tells
          // BotAssembler to put a human in it instead of a brain.
          call("project.writeFile", { path: "/data/bots/__opponent.json", text: JSON.stringify(entry.bp, null, 2) });
          writeSession(call, 2, "versus");
          engine.console.log("[Select] versus — P2 takes " + entry.bp.name + ", launching Arena01");
          call("project.loadScene", { name: "Arena01" });
          return;
        }
        if (id === "cmd:practice" || id === "cmd:fight") {
          // Launching is confirming: persist the choice, then hand off. Arena01 and
          // DemoCenter both read /data/bots/__selected.json through their player
          // spawner, so neither scene needs to know this screen exists.
          confirm(call, engine);
          // Any single-player launch clears a half-finished versus pick, so a
          // stranded stage-1 selection cannot leak into the next match.
          versusStage = 0;
          writeSession(call, 1, id === "cmd:fight" ? "fight" : "practice");
          // Arena01's opponent spawner reads __opponent.json (it used to name
          // `opp-wedge` directly, which meant a versus P2 pick was ignored there).
          // Filling it on the single-player path too keeps the arena's default
          // challenger exactly what it has always been.
          if (id === "cmd:fight") {
            const foe = bundle.bots[DEFAULT_ARENA_FOE];
            if (foe) call("project.writeFile", { path: "/data/bots/__opponent.json", text: JSON.stringify(foe, null, 2) });
          }
          const target = id === "cmd:fight" ? "Arena01" : "DemoCenter";
          engine.console.log("[Select] launching " + target);
          call("project.loadScene", { name: target });
          return;
        }
      });

      engine.console.log("[Select] ready — " + roster.length + " bots, canvas " + ui.canvas);
    },

    onDestroy({ call }) {
      // Both matter on hot reload: an un-removed listener would double every click,
      // and an un-removed canvas would leave a second UI stacked on the first.
      if (off) { off(); off = null; }
      if (ui.canvas) {
        try { call("ui.remove", { entity: ui.canvas }); } catch (err) { /* already gone */ }
        ui.canvas = 0;
      }
    },
  };
}
