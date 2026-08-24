/**
 * WorkshopController — the Create stage. (T-2.13 – T-2.18, plus T-2.10)
 *
 * Attach to a marker entity named `Workshop` in the Workshop scene.
 *
 * INTERACTION MODEL (T-2.14)
 *   Click a socket to select it, then click a part to fit it. Fitting into an
 *   occupied socket swaps (T-2.15). "Remove" clears the selected socket.
 *   Every fit applies IMMEDIATELY and rebuilds the preview bot, so the live bot
 *   on the turntable *is* the preview — there is no separate translucent ghost.
 *   That is a deliberate deviation: an immediate, undoable apply is both simpler
 *   and better feedback than a ghost you must confirm. Undo/redo is the safety
 *   net instead (T-2.16).
 *
 * WHY IT REBUILDS THROUGH BotAssembler
 *   The scripting layer has no imports, so duplicating assembly here would mean
 *   two copies of the socket/joint logic. Instead the draft blueprint is written
 *   to `/data/bots/__draft.json` and a spawner marker re-enters BotAssembler,
 *   which resolves blueprints from the bundle *or* from /data/bots/<id>.json.
 *   One assembler, one definition of what a bot is.
 *
 * WHY THE REBUILD IS A 3-FRAME STATE MACHINE (engine bug workaround)
 *   `ScriptSystem.frameUpdate` does `world.getComponent(entity, Script)!` with a
 *   non-null assertion while iterating `world.query(["Script"])`. Deleting a
 *   Script-bearing entity from inside a script hook therefore crashes the whole
 *   frame loop with "Cannot read properties of undefined (reading 'enabled')".
 *   So the spawner marker is created ONCE and never deleted; to re-run its
 *   BotAssembler we disable its Script on one frame and re-enable it on the next,
 *   which makes ScriptSystem tear the instance down and build a fresh one
 *   (onStart runs again). Only the assembled bodies — which carry no Script — are
 *   ever deleted. See docs/engine-bugs.md BUG-011.
 *
 * PERSISTENCE (T-2.18 decision)
 *   Blueprints are plain JSON under `/data/bots/<slug>.json`, with the roster in
 *   `/data/roster.json`. Chosen over `game.saveSlot` because a blueprint is
 *   authored content that must be diffable and exportable to the repo, not
 *   opaque save-game state.
 */

const BUNDLE_PATH = "/data/bundle.json";
const DRAFT_ID = "__draft";
const ROSTER_PATH = "/data/roster.json";
const TURNTABLE_TOP_Y = 0.12;
const ARMED_NAME = "BotSpawn:" + DRAFT_ID + ":workshop";

const CATEGORIES = ["chassis", "wheel", "weapon", "armor", "motor"];
const PART_ROWS = 6;    // most parts in any one category, plus headroom
const SOCKET_ROWS = 10; // every chassis exposes ten sockets
const STAT_ROWS = 6;

const COL_PANEL = 0x14161c;
const COL_BTN = 0x272b36;
const COL_BTN_ON = 0x2d6cdf;
const COL_TEXT = 0xe8e8ee;
const COL_WARN = 0xd8503f;

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unnamed";
}

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
  let H = null;
  let engineRef = null;
  let bundle = null;
  let off = null; // ui.clicked unsubscribe

  // ── authoring state ───────────────────────────────────────────────────────
  let draft = null; // { name, chassisId, paint, attachments[] }
  let selectedSocket = null;
  let currentId = null; // id the draft was loaded from; distinct from slugify(name)
  let activeCategory = "wheel";
  const history = []; // draft snapshots for undo/redo (T-2.16)
  let historyIndex = -1;

  // ── preview rebuild machine ───────────────────────────────────────────────
  let marker = 0;
  let pending = 0; // 0 idle, 1 clear+disable, 2 re-arm+enable

  const ui = { canvas: 0, catBtns: [], partRows: [], socketRows: [], statRows: [], title: 0, hint: 0 };

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const log = (m) => engineRef.console.log("[Workshop] " + m);

  function namedEntities() {
    return H("scene.query")({ components: ["Name"] }).content.entities.map((e) => ({
      e,
      n: H("scene.getComponent")({ entity: e, component: "Name" }).content.value,
    }));
  }

  // ── derived stats (T-2.17) ────────────────────────────────────────────────
  function stats() {
    const parts = bundle.parts;
    const chassis = parts[draft.chassisId];
    let mass = chassis.mass;
    let armorTotal = 0;
    let weaponRating = 0;
    let speedMult = 1;
    let wheels = 0;
    let maxWheelRadius = 0.12;
    for (const a of draft.attachments) {
      const def = parts[a.partId];
      if (!def) continue;
      mass += def.mass;
      if (def.category === "armor") armorTotal += def.hp;
      if (def.category === "weapon") weaponRating += def.hp;
      if (def.category === "motor" && def.stats && def.stats.maxSpeedMultiplier) {
        speedMult = def.stats.maxSpeedMultiplier;
      }
      if (def.category === "wheel") {
        wheels++;
        if (def.colliderSpec.radius > maxWheelRadius) maxWheelRadius = def.colliderSpec.radius;
      }
    }
    const cls = bundle.weightClasses.classes.find((c) => mass <= c.maxMassKg);
    // Estimate only: 4.46 m/s was MEASURED on the 98 kg player-slice build, then
    // scaled by the motor multiplier and inverse mass. Not a simulation.
    const estSpeed = 4.46 * speedMult * (98 / mass);
    return {
      mass,
      weightClass: cls ? cls.id : "OVER CAP",
      overCap: !cls,
      armorTotal,
      weaponRating,
      estSpeed,
      wheels,
      maxWheelRadius,
    };
  }

  function withDerived(d) {
    const s = stats();
    return {
      name: d.name,
      chassisId: d.chassisId,
      paint: d.paint,
      attachments: d.attachments,
      derived: {
        totalMassKg: s.mass,
        weightClass: s.weightClass,
        armorTotal: s.armorTotal,
        weaponRating: s.weaponRating,
      },
    };
  }

  function writeDraftFile() {
    H("project.writeFile")({
      path: "/data/bots/" + DRAFT_ID + ".json",
      text: JSON.stringify(withDerived(draft), null, 2),
    });
  }

  /** Only assembled BODIES are deleted — none of them carry a Script. */
  function clearPreviewBodies() {
    const doomed = namedEntities().filter((x) => /^Bot_workshop_/.test(x.n));
    for (const x of doomed.filter((x) => /Visual/.test(x.n))) H("scene.deleteEntity")({ entity: x.e });
    for (const x of doomed.filter((x) => !/Visual/.test(x.n))) H("scene.deleteEntity")({ entity: x.e });
  }

  function ensureMarker() {
    const found = namedEntities().find((x) => /^BotSpawn(ed)?:__draft:workshop$/.test(x.n));
    if (found) {
      marker = found.e;
      return;
    }
    const s = stats();
    marker = H("scene.createEntity")({
      components: {
        Name: { value: ARMED_NAME },
        Transform: {
          position: [0, TURNTABLE_TOP_Y + s.maxWheelRadius + 0.06, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
    }).content.entity;
    H("script.attach")({ entity: marker, behavior: "BotAssembler", enabled: true });
  }

  /** Queue a rebuild; the work happens across the next two onUpdate frames. */
  function requestRebuild() {
    writeDraftFile();
    pending = 1;
  }

  function pumpRebuild() {
    if (!pending || !marker) return;
    if (pending === 1) {
      clearPreviewBodies();
      H("scene.setComponent")({ entity: marker, component: "Script", patch: { enabled: false } });
      // Keep the spawn height correct for the current wheel size.
      const s = stats();
      H("scene.setComponent")({
        entity: marker,
        component: "Transform",
        patch: { position: [0, TURNTABLE_TOP_Y + s.maxWheelRadius + 0.06, 0], rotation: [0, 0, 0, 1] },
      });
      pending = 2;
      return;
    }
    // pending === 2 — re-arm the name so BotAssembler's idempotency guard passes,
    // then re-enable so ScriptSystem builds a fresh instance and runs onStart.
    H("scene.setComponent")({ entity: marker, component: "Name", patch: { value: ARMED_NAME } });
    H("scene.setComponent")({ entity: marker, component: "Script", patch: { enabled: true } });
    pending = 0;
  }

  // ── T-2.10 reverse path: live scene → BotBlueprint ────────────────────────
  /**
   * Rebuild a blueprint by reading the live entity tree rather than the
   * in-memory draft. Entity names carry `Bot_workshop_<socketId>_<partId>`, so
   * the scene is genuinely round-trippable instead of trusted to match.
   */
  function readBackFromScene() {
    const named = namedEntities();
    const chassisEnt = named.find((x) => x.n === "Bot_workshop_Chassis");
    if (!chassisEnt) return null;

    // Recover the chassis id by matching collider half-extents against the defs.
    const col = H("scene.getComponent")({ entity: chassisEnt.e, component: "Collider" }).content;
    let chassisId = null;
    for (const id of Object.keys(bundle.parts)) {
      const def = bundle.parts[id];
      if (def.category !== "chassis") continue;
      const he = def.colliderSpec.halfExtents;
      if (
        he &&
        Math.abs(he[0] - col.halfExtents[0]) < 1e-6 &&
        Math.abs(he[1] - col.halfExtents[1]) < 1e-6 &&
        Math.abs(he[2] - col.halfExtents[2]) < 1e-6
      ) {
        chassisId = id;
        break;
      }
    }

    const attachments = [];
    for (const x of named) {
      if (!/^Bot_workshop_/.test(x.n) || /Visual|Chassis$/.test(x.n)) continue;
      const body = x.n.replace("Bot_workshop_", "");
      // socketId may contain underscores, partId is the trailing known id
      let socketId = null;
      let partId = null;
      for (const s of bundle.parts[draft.chassisId].sockets || []) {
        if (body.indexOf(s.id + "_") === 0) {
          socketId = s.id;
          partId = body.slice(s.id.length + 1);
          break;
        }
      }
      if (socketId && bundle.parts[partId]) attachments.push({ socketId, partId });
    }
    return { name: draft.name, chassisId, paint: draft.paint, attachments };
  }

  // ── history ───────────────────────────────────────────────────────────────
  function pushHistory() {
    history.splice(historyIndex + 1); // drop the redo tail
    history.push(clone(draft));
    historyIndex = history.length - 1;
  }

  function mutate(fn) {
    H("undo.beginTransaction")({ label: "workshop edit" });
    fn();
    pushHistory();
    requestRebuild();
    H("undo.commit")({});
    refresh();
  }

  // ── ui construction (T-2.13) ──────────────────────────────────────────────
  function buildUi() {
    const panel = (min, max) => ({
      props: {
        kind: "panel",
        visible: true,
        backgroundColor: COL_PANEL,
        layout: { anchorMin: min, anchorMax: max, offsetMin: [0, 0], offsetMax: [0, 0] },
      },
      children: [],
    });
    const text = (min, max, t, size) => ({
      props: {
        kind: "text",
        visible: true,
        text: t,
        color: COL_TEXT,
        fontSize: uiPx(size || 13),
        layout: { anchorMin: min, anchorMax: max, offsetMin: [0, 0], offsetMax: [0, 0] },
      },
    });
    const button = (min, max, t, actionId) => ({
      props: {
        kind: "button",
        visible: true,
        text: t,
        actionId,
        color: COL_TEXT,
        backgroundColor: COL_BTN,
        fontSize: uiPx(12),
        layout: { anchorMin: min, anchorMax: max, offsetMin: [0, 0], offsetMax: [0, 0] },
      },
    });

    // left: category tabs + part list
    const left = panel([0.005, 0.02], [0.245, 0.985]);
    left.children.push(text([0.05, 0.015], [0.95, 0.06], "PARTS", 15));
    for (let i = 0; i < CATEGORIES.length; i++) {
      const x0 = 0.02 + i * 0.194;
      left.children.push(button([x0, 0.07], [x0 + 0.184, 0.125], CATEGORIES[i].slice(0, 5), "cat:" + CATEGORIES[i]));
    }
    for (let i = 0; i < PART_ROWS; i++) {
      const y0 = 0.15 + i * 0.075;
      left.children.push(button([0.04, y0], [0.96, y0 + 0.065], "-", "part:slot" + i));
    }

    // right: socket list
    const right = panel([0.755, 0.02], [0.995, 0.66]);
    right.children.push(text([0.05, 0.02], [0.95, 0.08], "SOCKETS", 15));
    for (let i = 0; i < SOCKET_ROWS; i++) {
      const y0 = 0.1 + i * 0.088;
      right.children.push(button([0.04, y0], [0.96, y0 + 0.078], "-", "socket:slot" + i));
    }

    // right-bottom: live stats
    const stat = panel([0.755, 0.675], [0.995, 0.985]);
    stat.children.push(text([0.05, 0.03], [0.95, 0.14], "STATS", 15));
    for (let i = 0; i < STAT_ROWS; i++) {
      const y0 = 0.18 + i * 0.13;
      stat.children.push(text([0.06, y0], [0.97, y0 + 0.12], "", 12));
    }

    // bottom bar: commands
    const bar = panel([0.26, 0.9], [0.74, 0.985]);
    const cmds = [
      ["Save", "cmd:save"],
      ["Load", "cmd:load"],
      ["Test", "cmd:test"],
      ["Remove", "cmd:remove"],
      ["Undo", "cmd:undo"],
      ["Redo", "cmd:redo"],
    ];
    for (let i = 0; i < cmds.length; i++) {
      const x0 = 0.015 + i * 0.164;
      bar.children.push(button([x0, 0.18], [x0 + 0.154, 0.82], cmds[i][0], cmds[i][1]));
    }

    // top-centre: title + hint line
    const head = panel([0.26, 0.02], [0.74, 0.1]);
    head.children.push(text([0.02, 0.05], [0.98, 0.55], "WORKSHOP", 16));
    head.children.push(text([0.02, 0.55], [0.98, 0.98], "", 12));

    // Each panel is grafted directly onto the canvas. A wrapper root would have to
    // be full-bleed for its children's fractional anchors to resolve to anything,
    // and a full-bleed panel paints over the 3D view — so there is no wrapper.
    // Building one tree per panel also keeps element mapping local rather than one
    // fragile global DFS index.
    //
    // `visible` MUST be passed explicitly: calling a tool handler straight out of
    // toolMap skips zod, so the schema's `visible: default(true)` does not apply
    // and the canvas is created hidden — after which ui.click refuses every button
    // with "on hidden canvas". See docs/engine-bugs.md BUG-004.
    ui.canvas = H("ui.createCanvas")({ visible: true }).content.canvas;
    const graft = (spec) => H("ui.createTree")({ canvas: ui.canvas, visible: true, spec }).content.elements;

    const l = graft(left);
    ui.catBtns = l.slice(2, 2 + CATEGORIES.length);
    ui.partRows = l.slice(2 + CATEGORIES.length, 2 + CATEGORIES.length + PART_ROWS);

    const r = graft(right);
    ui.socketRows = r.slice(2, 2 + SOCKET_ROWS);

    const s = graft(stat);
    ui.statRows = s.slice(2, 2 + STAT_ROWS);

    graft(bar);

    const hd = graft(head);
    ui.title = hd[1];
    ui.hint = hd[2];
  }

  function setHint(t) {
    H("ui.setText")({ entity: ui.hint, text: t });
  }

  // ── ui refresh ────────────────────────────────────────────────────────────
  function refresh() {
    const setProps = H("ui.setProps");
    const parts = bundle.parts;

    for (let i = 0; i < CATEGORIES.length; i++) {
      setProps({
        entity: ui.catBtns[i],
        props: { backgroundColor: CATEGORIES[i] === activeCategory ? COL_BTN_ON : COL_BTN },
      });
    }

    const list = Object.keys(parts)
      .map((k) => parts[k])
      .filter((p) => p.category === activeCategory);
    for (let i = 0; i < PART_ROWS; i++) {
      const p = list[i];
      setProps({
        entity: ui.partRows[i],
        props: p
          ? {
              visible: true,
              disabled: false,
              text: p.displayName + "  " + p.mass + "kg",
              actionId: "part:" + p.id,
              backgroundColor: COL_BTN,
            }
          : { visible: false, disabled: true, text: "", actionId: "part:slot" + i },
      });
    }

    const sockets = parts[draft.chassisId].sockets || [];
    const filled = {};
    for (const a of draft.attachments) filled[a.socketId] = a.partId;
    for (let i = 0; i < SOCKET_ROWS; i++) {
      const s = sockets[i];
      if (!s) {
        setProps({ entity: ui.socketRows[i], props: { visible: false, disabled: true, actionId: "socket:slot" + i } });
        continue;
      }
      const fittedId = filled[s.id];
      setProps({
        entity: ui.socketRows[i],
        props: {
          visible: true,
          disabled: false,
          text: s.id + ": " + (fittedId ? parts[fittedId].displayName : "(empty)"),
          actionId: "socket:" + s.id,
          backgroundColor: s.id === selectedSocket ? COL_BTN_ON : COL_BTN,
        },
      });
    }

    const st = stats();
    const rows = [
      "Name: " + draft.name,
      "Chassis: " + parts[draft.chassisId].displayName,
      "Mass: " + st.mass.toFixed(0) + " kg  [" + st.weightClass + "]",
      "Armour: " + st.armorTotal + "   Weapon: " + st.weaponRating,
      "Est. top speed: " + st.estSpeed.toFixed(2) + " m/s",
      "Wheels: " + st.wheels + (st.wheels < 2 ? "  (cannot drive!)" : ""),
    ];
    for (let i = 0; i < STAT_ROWS; i++) {
      const warn = (i === 2 && st.overCap) || (i === 5 && st.wheels < 2);
      setProps({ entity: ui.statRows[i], props: { text: rows[i] || "", color: warn ? COL_WARN : COL_TEXT } });
    }
  }

  // ── commands ──────────────────────────────────────────────────────────────
  function fitPart(partId) {
    const parts = bundle.parts;
    const def = parts[partId];
    if (!def) return;

    if (def.category === "chassis") {
      mutate(() => {
        draft.chassisId = partId;
      });
      setHint("Chassis: " + def.displayName);
      return;
    }
    if (!selectedSocket) {
      setHint("Select a socket first");
      return;
    }
    const socket = (parts[draft.chassisId].sockets || []).find((s) => s.id === selectedSocket);
    if (!socket || !socket.accepts.includes(def.category)) {
      setHint("Socket '" + selectedSocket + "' does not accept a " + def.category);
      return;
    }
    const socketId = selectedSocket;
    mutate(() => {
      draft.attachments = draft.attachments.filter((a) => a.socketId !== socketId); // swap (T-2.15)
      draft.attachments.push({ socketId, partId });
    });
    setHint("Fitted " + def.displayName + " to " + socketId);
  }

  function removeSelected() {
    if (!selectedSocket) {
      setHint("Select a socket first");
      return;
    }
    const socketId = selectedSocket;
    if (!draft.attachments.some((a) => a.socketId === socketId)) {
      setHint("Socket '" + socketId + "' is already empty");
      return;
    }
    mutate(() => {
      draft.attachments = draft.attachments.filter((a) => a.socketId !== socketId);
    });
    setHint("Cleared " + socketId);
  }

  function save() {
    const st = stats();
    if (st.overCap) {
      setHint("Cannot save: " + st.mass.toFixed(0) + " kg is over every class cap");
      return;
    }
    // Save what the SCENE actually contains, which exercises the reverse path.
    const fromScene = readBackFromScene();
    const payload = withDerived(fromScene || draft);
    const slug = slugify(draft.name);
    currentId = slug;
    H("project.writeFile")({ path: "/data/bots/" + slug + ".json", text: JSON.stringify(payload, null, 2) });

    let roster = [];
    try {
      roster = JSON.parse(H("project.readFile")({ path: ROSTER_PATH }).content.text);
    } catch (err) {
      roster = [];
    }
    if (roster.indexOf(slug) < 0) roster.push(slug);
    H("project.writeFile")({ path: ROSTER_PATH, text: JSON.stringify(roster, null, 2) });

    const key = (list) =>
      JSON.stringify(
        list
          .map((a) => a.socketId + "=" + a.partId)
          .slice()
          .sort(),
      );
    const matches = !!fromScene && key(fromScene.attachments) === key(draft.attachments);
    setHint("Saved " + slug + (matches ? " (scene round-trip ok)" : " (WARNING: scene/draft mismatch)"));
    log("saved " + slug + " roundTripMatches=" + matches);
  }

  function loadNext() {
    let roster = [];
    try {
      roster = JSON.parse(H("project.readFile")({ path: ROSTER_PATH }).content.text);
    } catch (err) {
      roster = [];
    }
    const pool = roster.concat(Object.keys(bundle.bots));
    if (!pool.length) {
      setHint("Nothing saved yet");
      return;
    }
    const idx = pool.indexOf(currentId || slugify(draft.name));
    const next = pool[(idx + 1) % pool.length];
    let bp = bundle.bots[next];
    if (!bp) {
      try {
        bp = JSON.parse(H("project.readFile")({ path: "/data/bots/" + next + ".json" }).content.text);
      } catch (err) {
        bp = null;
      }
    }
    if (!bp) {
      setHint("Could not load " + next);
      return;
    }
    mutate(() => {
      draft = {
        name: bp.name,
        chassisId: bp.chassisId,
        paint: bp.paint || draft.paint,
        attachments: clone(bp.attachments),
      };
    });
    currentId = next;
    setHint("Loaded " + next);
  }

  function test() {
    // Full scene hand-off is T-6.2. For now publish the draft as the active
    // player blueprint so an arena spawner can pick it up by id.
    H("project.writeFile")({ path: "/data/bots/__player.json", text: JSON.stringify(withDerived(draft), null, 2) });
    setHint("Published as __player — load Arena01 with BotSpawn:__player:player");
    log("published draft as __player");
  }

  function undo() {
    if (historyIndex <= 0) {
      setHint("Nothing to undo");
      return;
    }
    historyIndex--;
    draft = clone(history[historyIndex]);
    requestRebuild();
    refresh();
    setHint("Undo");
  }

  function redo() {
    if (historyIndex >= history.length - 1) {
      setHint("Nothing to redo");
      return;
    }
    historyIndex++;
    draft = clone(history[historyIndex]);
    requestRebuild();
    refresh();
    setHint("Redo");
  }

  return {
    onStart({ engine }) {
      engineRef = engine;
      const tm = engine.mcp.toolMap;
      H = (n) => tm.get(n).handler;
      bundle = JSON.parse(H("project.readFile")({ path: BUNDLE_PATH }).content.text);

      const seed = bundle.bots["player-slice"];
      draft = {
        name: "New Bot",
        chassisId: seed.chassisId,
        paint: clone(seed.paint),
        attachments: clone(seed.attachments),
      };
      history.length = 0;
      history.push(clone(draft));
      historyIndex = 0;

      buildUi();
      ensureMarker();
      requestRebuild();
      refresh();
      setHint("Click a socket, then a part");

      off = engine.mcp.on("ui.clicked", (payload) => {
        const id = payload && payload.actionId;
        if (!id) return;
        if (id.indexOf("cat:") === 0) {
          activeCategory = id.slice(4);
          refresh();
          return;
        }
        if (id.indexOf("socket:") === 0) {
          selectedSocket = id.slice(7);
          refresh();
          setHint("Socket '" + selectedSocket + "' selected — pick a part");
          return;
        }
        if (id.indexOf("part:") === 0) return fitPart(id.slice(5));
        if (id === "cmd:remove") return removeSelected();
        if (id === "cmd:save") return save();
        if (id === "cmd:load") return loadNext();
        if (id === "cmd:test") return test();
        if (id === "cmd:undo") return undo();
        if (id === "cmd:redo") return redo();
      });

      log("ready — canvas " + ui.canvas + ", marker " + marker);
    },

    onUpdate() {
      pumpRebuild();
    },

    onDestroy() {
      if (off) {
        off();
        off = null;
      }
      // The marker is deliberately NOT deleted — see the header note. Just park it.
      if (marker) {
        try {
          H("scene.setComponent")({ entity: marker, component: "Script", patch: { enabled: false } });
        } catch (err) {
          /* entity already gone */
        }
      }
      if (ui.canvas) {
        try {
          H("ui.remove")({ entity: ui.canvas });
        } catch (err) {
          /* already removed */
        }
      }
    },
  };
}
