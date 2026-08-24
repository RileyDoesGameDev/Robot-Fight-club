#!/usr/bin/env node
/**
 * Makes an exported SMPL-Engine build actually playable. (T-8.2, stopgap)
 *
 *   node tools/shim-build.js build/battle-bots
 *
 * WHY THIS EXISTS
 *   `build.export` produces a build that cannot run this game. Two facts collide:
 *
 *   1. The engine gates its project-filesystem tools behind a capability, and the
 *      capability is only granted to the editor profile:
 *
 *        function hb(t) { return t === "editor" ? lb : cb; }   // lb has hasFilesystem: true
 *
 *      Everything with `requires: ["hasFilesystem"]` — `project.loadScene`,
 *      `project.readFile`, `project.writeFile` — is therefore never registered in a
 *      deployed build.
 *
 *   2. This game is built entirely on those three. Every script loads its data from
 *      `/data/bundle.json`; scene flow is `project.loadScene`; bot selection, session
 *      state, match history and the post-match hand-off are all files.
 *
 *   The result is a build that renders whatever scene was live at export time and
 *   responds to nothing — the menu draws because its UI entities were baked into the
 *   scene, and every button fails silently on the first `loadScene`.
 *
 *   The player already ships a complete in-memory filesystem (`class fv`, with a
 *   constructor that accepts a seed map). It is simply empty, and the tools that
 *   would use it are switched off. So the fix is two lines.
 *
 * WHAT IT PATCHES
 *   1. The capability gate, so a deployed build gets the project filesystem — and
 *      only that. Granting the whole editor capability set instead also enables
 *      `hasSubprocess` and `hasMCPManager`, which wedge the main thread on boot.
 *   2. The filesystem constructor, so it falls back to `globalThis.__SMPL_SEED_FILES__`
 *      when constructed with no seed — which `seed.js` sets before `player.js` runs.
 *
 * THIS IS A STOPGAP AND SHOULD NOT SURVIVE
 *   It rewrites a vendored build artifact with two string replacements. It will break
 *   the moment the engine's minified identifiers change, and it grants a deployed page
 *   capabilities the engine deliberately withholds — `hasSubprocess` and
 *   `hasMCPManager` come along with the same object, and neither means anything in a
 *   browser, but the honest version of this is an engine feature, not a patch.
 *
 *   The real fix is one of: a `files` key in the bundle format that the player seeds
 *   its FS from, a capability profile for "deployed game" that includes a virtual FS,
 *   or making this game self-contained so it needs none of it. Filed as LIM-009.
 *
 *   Every replacement below is asserted to match exactly once. If the engine is
 *   updated and a pattern stops matching, this fails loudly rather than producing a
 *   build that looks fine and is subtly dead — which is the failure mode that made
 *   this necessary in the first place.
 */
const fs = require("fs");
const path = require("path");

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node tools/shim-build.js <build-dir>");
  process.exit(1);
}

const playerPath = path.join(dir, "player.js");
const indexPath = path.join(dir, "index.html");
const seedPath = path.join(dir, "seed.js");

for (const p of [playerPath, indexPath, seedPath]) {
  if (!fs.existsSync(p)) {
    console.error(`FAIL: ${p} not found — run the export and write seed.js first`);
    process.exit(1);
  }
}

/** Replace exactly once, or fail loudly. */
function replaceOnce(src, find, repl, label) {
  return replaceCount(src, find, repl, 1, label);
}

/** Replace an exact number of occurrences, or fail loudly. */
function replaceCount(src, find, repl, expected, label) {
  const n = src.split(find).length - 1;
  if (n !== expected) {
    console.error(`FAIL: ${label} matched ${n} times, expected exactly ${expected}.`);
    console.error("      The engine build has changed; re-derive this patch rather than loosening it.");
    process.exit(1);
  }
  console.log(`  patched: ${label}${expected > 1 ? ` (${expected} sites)` : ""}`);
  return src.split(find).join(repl);
}

/**
 * The script-context prelude.
 *
 * The runtime's script host hands hooks `{ entity, world, dt, engine }`. The editor
 * hands them `{ entity, world, dt, engine, call, params }`. Every script in this game
 * is written against the editor's contract — `call` is how they reach every engine
 * tool, and `params` is how per-instance configuration arrives (the bot's role, the
 * camera's distances, the AI's personality and difficulty). Without them, every
 * script throws `call is not a function` on its first line of `onStart` and the game
 * is five entities and a black screen.
 *
 * `call` is rebuilt here from parts the runtime already has: tool handlers in
 * `mcp.toolMap` are plain synchronous functions, even though `mcp.callTool` itself is
 * async-only. So a synchronous dispatch is a lookup, a schema parse, and an invoke.
 * Async handlers are refused with the same shape of error the editor gives, rather
 * than silently returning a Promise that every caller would misread as a result —
 * `audio.loadClip` is the one tool in this game that hits that path, and it already
 * goes through `engine.mcp.callTool` for exactly this reason.
 */
const PRELUDE = `
/* __SMPL_SHIMMED__ script-context prelude — see tools/shim-build.js */
function __smplCall(engine) {
  if (engine.__smplCallFn) return engine.__smplCallFn;
  const fn = function (name, args) {
    const tm = engine.mcp.toolMap;
    const tool = tm instanceof Map ? tm.get(name) : tm[name];
    if (!tool) return { content: "no such tool: " + name, isError: true };
    let input = args || {};
    if (tool.inputSchema && typeof tool.inputSchema.parse === "function") {
      try { input = tool.inputSchema.parse(input); }
      catch (err) { return { content: "invalid input for " + name + ": " + (err && err.message), isError: true }; }
    }
    try {
      const res = tool.handler(input);
      if (res && typeof res.then === "function") {
        return { content: "MCP tool " + name + " is async and cannot be called synchronously", isError: true };
      }
      /* LIM-001 backport. The runtime's script.attach schema is {entity, behavior,
         enabled} — it predates Script.params, so zod strips params on the way in and
         every bot is assembled without its role, motor multipliers, AI personality or
         difficulty. The Script COMPONENT already stores params fine (its create()
         passes them straight through); only this tool's schema is behind. Write them
         on afterwards rather than loosening the parse for every tool. */
      if (name === "script.attach" && args && args.params && !(res && res.isError)) {
        try {
          const stores = engine.world.stores;
          const store = stores instanceof Map ? stores.get("Script") : stores["Script"];
          const rec = store && typeof store.get === "function" ? store.get(args.entity) : null;
          if (rec) rec.params = args.params;
        } catch (err) { /* leave params unset rather than fail the attach */ }
      }
      return res;
    } catch (err) {
      return { content: String((err && err.message) || err), isError: true };
    }
  };
  engine.__smplCallFn = fn;
  return fn;
}
function __smplParams(engine, entity) {
  try {
    const stores = engine.world.stores;
    const store = stores instanceof Map ? stores.get("Script") : stores["Script"];
    const rec = store && typeof store.get === "function" ? store.get(entity) : null;
    return (rec && rec.params) || {};
  } catch (err) { return {}; }
}
`;

// ---- player.js -------------------------------------------------------------------

let player = fs.readFileSync(playerPath, "utf8");

if (player.indexOf("__SMPL_SHIMMED__") >= 0) {
  console.log("player.js is already shimmed — nothing to do.");
} else {
  player = replaceOnce(
    player,
    'function hb(t) {\n  return t === "editor" ? lb : cb;\n}',
    'function hb(t) {\n  /* __SMPL_SHIMMED__ grant ONLY the project filesystem to a deployed build.\n     Returning the whole editor set (lb) also switches on hasSubprocess and\n     hasMCPManager. Neither means anything in a browser, and together they wedge\n     the main thread on boot — the page reaches engine-ready, drops the splash,\n     and then freezes with no error at all. This is the narrowest change that\n     registers the project.* tools. */\n  return t === "editor" ? lb : { ...cb, hasFilesystem: !0 };\n}',
    "capability gate -> filesystem only",
  );

  // Debug affordance, not a hack to work around anything. A deployed build exposes
  // nothing on `window`, and the engine keeps its own console in an internal buffer
  // rather than the browser's — so when a script fails during `onStart` the page goes
  // quietly blank and there is no way in from the outside. This makes the running
  // engine reachable, which is the difference between diagnosing a shimmed build and
  // guessing at it.
  player = replaceOnce(
    player,
    "this.profile = A.profile, this.capabilities = hb(A.profile),",
    "this.profile = A.profile, globalThis.__SMPL_ENGINE__ = this, this.capabilities = hb(A.profile),",
    "expose the engine on globalThis for debugging",
  );

  player = replaceOnce(
    player,
    "constructor(A) {\n    if (A)\n      for (const [e, g] of Object.entries(A))",
    "constructor(A) {\n    /* __SMPL_SHIMMED__ seed the in-memory FS from the page when none was passed. */\n    if (!A && typeof globalThis !== \"undefined\" && globalThis.__SMPL_SEED_FILES__) A = globalThis.__SMPL_SEED_FILES__;\n    if (A)\n      for (const [e, g] of Object.entries(A))",
    "filesystem constructor -> seed from globalThis",
  );

  // The script context. Three distinct shapes across six hook call sites; each gets
  // `call` and `params` appended so the runtime matches the editor's contract.
  player = replaceCount(
    player,
    "{ entity: e, world: this.engine.world, dt: 0, engine: this.engine })",
    "{ entity: e, world: this.engine.world, dt: 0, engine: this.engine, call: __smplCall(this.engine), params: __smplParams(this.engine, e) })",
    1,
    "script ctx (onDestroy, entity e) -> + call/params",
  );
  player = replaceCount(
    player,
    "{ entity: g, world: this.engine.world, dt: 0, engine: this.engine })",
    "{ entity: g, world: this.engine.world, dt: 0, engine: this.engine, call: __smplCall(this.engine), params: __smplParams(this.engine, g) })",
    1,
    "script ctx (onDestroy, entity g) -> + call/params",
  );
  player = replaceCount(
    player,
    "{ entity: g, world: A, dt: e, engine: this.engine })",
    "{ entity: g, world: A, dt: e, engine: this.engine, call: __smplCall(this.engine), params: __smplParams(this.engine, g) })",
    4,
    "script ctx (start/update/fixedUpdate/destroy) -> + call/params",
  );

  // BUG-011 backport, and the most important patch in this file.
  //
  // The runtime's script loop reads a Script component off every queried entity and
  // dereferences it without a guard. Delete a Script-bearing entity from inside a hook
  // and the next iteration reads `undefined.enabled` and takes the whole frame loop
  // down — the game freezes, with one uncaught error.
  //
  // This is not hypothetical here. `DamageSystem` culls debris from `onFixedUpdate`,
  // and a sheared-off weapon IS debris that carries `WeaponController`. So any match
  // that runs long enough for a weapon to come off and then expire — or for one to be
  // knocked into a pit — freezes the deployed build. `engine-fixes.md` records BUG-011
  // as fixed, and it is: in the editor. The runtime never got it, like `ctx.call` and
  // `Script.params` before it.
  //
  // The editor's fix is a guarded read. This is the same guard.
  player = replaceOnce(
    player,
    'for (const g of A.query(["Script"])) {\n      const I = A.getComponent(g, ch);\n      if (!I.enabled || I.behavior === "")\n        continue;',
    'for (const g of A.query(["Script"])) {\n      const I = A.getComponent(g, ch);\n      /* __SMPL_SHIMMED__ BUG-011: an entity deleted from inside a hook is still in\n         this query, and reading .enabled off nothing kills the frame loop. */\n      if (!I || !I.enabled || I.behavior === "")\n        continue;',
    "script loop -> guard against entities deleted mid-hook (BUG-011)",
  );

  // LIM-001 backport, second half. `BotAssembler` does not go through `ctx.call` at
  // all — it pulls raw handlers straight out of `engine.mcp.toolMap`, which is the
  // documented way to skip zod (BUG-004). So the backport inside __smplCall never
  // fires for the one script that assembles every bot in the game, and its weapons,
  // drivetrains and AI brains all come up unconfigured. Patching the handler itself
  // covers both callers: raw handler calls pass `params` straight through, and the
  // ctx.call path is still covered by the post-write in the prelude because zod
  // strips `params` before the handler ever sees it.
  player = replaceOnce(
    player,
    '"Script", {\n          behavior: s.behavior,\n          enabled: s.enabled\n        })',
    '"Script", {\n          behavior: s.behavior,\n          enabled: s.enabled,\n          params: s.params\n        })',
    "script.attach handler -> carry params onto the component",
  );

  player = PRELUDE + player;
  console.log("  patched: script-context prelude prepended");

  fs.writeFileSync(playerPath, player);
}

// ---- index.html ------------------------------------------------------------------

let html = fs.readFileSync(indexPath, "utf8");

if (html.indexOf("seed.js") >= 0) {
  console.log("index.html already loads seed.js — nothing to do.");
} else {
  html = replaceOnce(
    html,
    '<script type="module" src="./player.js"></script>',
    // Classic script, not a module: it must run and assign the global BEFORE the
    // module graph is evaluated, and module scripts are deferred.
    '<script src="./seed.js"></script>\n<script type="module" src="./player.js"></script>',
    "index.html -> load seed.js before player.js",
  );
  fs.writeFileSync(indexPath, html);
}

// ---- verify ----------------------------------------------------------------------

const seed = fs.readFileSync(seedPath, "utf8");
const m = seed.match(/^globalThis\.__SMPL_SEED_FILES__ = /);
if (!m) {
  console.error("FAIL: seed.js does not assign globalThis.__SMPL_SEED_FILES__");
  process.exit(1);
}
let seedObj;
try {
  seedObj = JSON.parse(seed.replace(/^globalThis\.__SMPL_SEED_FILES__ = /, "").replace(/;\s*$/, ""));
} catch (e) {
  console.error("FAIL: seed.js payload is not valid JSON:", e.message);
  process.exit(1);
}

const need = ["/data/bundle.json", "/scenes/MainMenu.scene.json", "/scenes/Arena01.scene.json"];
const missing = need.filter((k) => !seedObj[k]);
if (missing.length) {
  console.error("FAIL: seed is missing files the game cannot start without:", missing.join(", "));
  process.exit(1);
}
try {
  JSON.parse(seedObj["/data/bundle.json"]);
} catch (e) {
  console.error("FAIL: seeded /data/bundle.json is not valid JSON:", e.message);
  process.exit(1);
}

const finalPlayer = fs.readFileSync(playerPath, "utf8");
const finalHtml = fs.readFileSync(indexPath, "utf8");
const checks = [
  ["capability gate grants the filesystem", finalPlayer.indexOf("__SMPL_SHIMMED__ grant ONLY the project filesystem") >= 0],
  // Guard the narrowing itself: re-granting the full editor set is the exact
  // mistake that froze the first build, and it is invisible from the outside.
  ["and does NOT grant the full editor set", !/return\s+lb;/.test(finalPlayer.slice(0, 2000))],
  ["FS constructor reads the global", finalPlayer.indexOf("__SMPL_SHIMMED__ seed the in-memory FS") >= 0],
  ["seed.js loads before player.js", finalHtml.indexOf('src="./seed.js"') < finalHtml.indexOf('src="./player.js"')],
  ["seed carries the data bundle", !!seedObj["/data/bundle.json"]],
  ["engine exposed for debugging", finalPlayer.indexOf("globalThis.__SMPL_ENGINE__ = this") >= 0],
  ["script ctx provides call", (finalPlayer.split("call: __smplCall(this.engine)").length - 1) === 6],
  ["script ctx provides params", (finalPlayer.split("params: __smplParams(this.engine").length - 1) === 6],
  ["script.attach carries params", finalPlayer.indexOf("params: s.params") >= 0],
  ["script loop guards deleted entities", finalPlayer.indexOf("BUG-011: an entity deleted from inside a hook") >= 0],
  ["prelude defines the helpers", finalPlayer.indexOf("function __smplCall(engine)") >= 0 && finalPlayer.indexOf("function __smplParams(engine") >= 0],
];
let bad = 0;
for (const [label, okv] of checks) {
  console.log(`  ${okv ? "ok  " : "FAIL"}  ${label}`);
  if (!okv) bad++;
}

console.log(`\n  ${Object.keys(seedObj).length} files seeded, ${(seed.length / 1024).toFixed(1)} KB`);
console.log(bad ? "\nFAIL" : "\nPASS — build shimmed and playable");
process.exit(bad ? 1 : 0);
