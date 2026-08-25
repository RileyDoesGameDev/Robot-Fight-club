#!/usr/bin/env node
/**
 * Rebuild and redeploy the playable container, end to end. (T-8.2)
 *
 *   node tools/rebuild-game.mjs
 *
 * Run this after changing anything under `game/`. It:
 *
 *   1. validates the data and regenerates `game/data/bundle.json`
 *   2. pushes every script, scene and data file from THIS REPO into the live engine
 *      project — the repo is the source of truth (README §"Repo ↔ engine project"),
 *      and skipping this step is how BB-001 happened: a stale but valid data file in
 *      the working copy loads perfectly and just plays wrong
 *   3. compiles the scripts and fails if any of them has a diagnostic
 *   4. exports a `site` build from a stopped `MainMenu`
 *   5. writes `seed.js` with every `/data/**` and `/scenes/**` file
 *   6. runs `tools/shim-build.js` over the result
 *   7. restarts the `battle-bots` container
 *
 * It talks to the running editor over the MCP bridge on ws://localhost:8765, so the
 * Docker stack must be up and the editor must have the project open with **Expose**
 * enabled — the same preconditions as any other agent-driven step in this project.
 *
 * If the bridge is not reachable this exits with instructions rather than half a
 * build. Every step that can fail, fails loudly: the failure mode this whole
 * pipeline is designed against is a build that reports success and is quietly dead
 * (engine-fixes.md LIM-009).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const OUT = join(REPO, "build", "battle-bots");
const CONTAINER = "battle-bots";

const step = (n, msg) => console.log(`\n[${n}] ${msg}`);
function die(msg, hint) {
  console.error(`\nFAIL: ${msg}`);
  if (hint) console.error(`      ${hint}`);
  process.exit(1);
}
/**
 * Quote an argument for a shelled-out command.
 *
 * `spawnSync` with `shell: true` CONCATENATES argv rather than passing it through, so
 * anything containing a space is silently split. This repo lives under a path with a
 * space in it (T-0.5), so that is not hypothetical: `docker save -o <path>` failed
 * with "open C:\Users\.tmp-KOBI...: Access is denied", which reads like a permissions
 * problem and is a quoting one.
 *
 * shell:true is needed on Windows to find `docker` on PATH, so the quoting has to
 * happen here rather than being avoided.
 */
function q(a) {
  return process.platform === "win32" && /\s/.test(a) ? `"${a}"` : a;
}

function run(cmd, args, label) {
  const r = spawnSync(cmd, args.map(q), { cwd: REPO, encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) {
    console.error(r.stdout || "");
    console.error(r.stderr || "");
    die(`${label} failed`);
  }
  return r.stdout || "";
}

// ---- 1. data ---------------------------------------------------------------------

step(1, "validate + bundle");
process.stdout.write(run("node", ["game/data/validate.js"], "validate.js").trim().split("\n").pop() + "\n");
process.stdout.write(run("node", ["game/data/build-bundle.js"], "build-bundle.js"));

// ---- 2..5. everything that needs the live engine ---------------------------------

step(2, "push repo -> engine project, compile, export");

const SCRIPTS = [
  "AiDriver", "AudioDirector", "BotAssembler", "BotDrive", "BotSelectController",
  "DamageSystem", "DemoCenterController", "HazardSpinner", "MainMenuController",
  "MatchCamera", "MatchDirector", "MatchHud", "MatchTelemetry", "PostMatchController",
  "UtilityAi", "VfxDirector", "WeaponController", "WorkshopController",
];
const SCENES = ["MainMenu", "BotSelect", "DemoCenter", "Arena01", "PostMatch", "Workshop"];

const payload = {
  scripts: Object.fromEntries(SCRIPTS.map((id) => [id, readFileSync(join(REPO, "game/scripts", `${id}.ts`), "utf8")])),
  scenes: Object.fromEntries(SCENES.map((n) => [n, readFileSync(join(REPO, "game/scenes", `${n}.scene.json`), "utf8")])),
  bundle: readFileSync(join(REPO, "game/data/bundle.min.json"), "utf8"),
  weights: readFileSync(join(REPO, "game/data/ai/weights.json"), "utf8"),
};

console.log(`    ${SCRIPTS.length} scripts, ${SCENES.length} scenes, ${(payload.bundle.length / 1024).toFixed(1)} KB bundle`);
console.log(`
    This step needs the live editor. Run the block below through the MCP bridge
    (or paste it into the editor's script console), then re-run this tool with
    --skip-engine to finish packaging:

      node tools/rebuild-game.mjs --skip-engine
`);

const ENGINE_STEPS = `
// --- paste into script.eval against the live editor ---
const REPO = "http://localhost:8799";   // serve the repo root first
for (const id of ${JSON.stringify(SCRIPTS)}) {
  const src = await (await fetch(REPO + "/game/scripts/" + id + ".ts")).text();
  await call("script.edit", { id, source: src });
  const c = await call("script.compile", { id });
  if (c.isError || (c.content.diagnostics || []).length) throw new Error(id + ": " + JSON.stringify(c.content));
  await call("script.hotReload", { id });
}
for (const n of ${JSON.stringify(SCENES)}) {
  const text = await (await fetch(REPO + "/game/scenes/" + n + ".scene.json")).text();
  await call("project.writeFile", { path: "/scenes/" + n + ".scene.json", text });
}
await call("project.writeFile", { path: "/data/bundle.json",
  text: await (await fetch(REPO + "/game/data/bundle.min.json")).text() });
await call("project.writeFile", { path: "/data/ai/weights.json",
  text: await (await fetch(REPO + "/game/data/ai/weights.json")).text() });
await call("project.writeFile", { path: "/data/session.json",
  text: JSON.stringify({ intent: "test", difficulty: "normal" }, null, 2) + "\\n" });

await call("editor.setRunning", { running: false });
await call("project.loadScene", { name: "MainMenu" });
const ex = await call("build.export", { name: "battle-bots", title: "Battle Bots", format: "site" });
if (ex.isError) throw new Error("export failed");

// hand the artifacts + a seed of every project file back to the repo
for (const f of ["index.html", "bundle.json", "player.js"]) {
  const txt = (await call("project.readFile", { path: "/build/battle-bots/" + f })).content.text;
  await fetch(REPO + "/build/battle-bots/" + f, { method: "PUT", body: txt });
}
const seed = {};
for (const key of engine.project.files.keys()) {
  if (key.indexOf("/data/") !== 0 && key.indexOf("/scenes/") !== 0) continue;
  seed[key] = (await call("project.readFile", { path: key })).content.text;
}
await fetch(REPO + "/build/battle-bots/seed.js", { method: "PUT",
  body: "globalThis.__SMPL_SEED_FILES__ = " + JSON.stringify(seed) + ";\\n" });
return ex.content.report;
`;

if (!process.argv.includes("--skip-engine")) {
  writeFileSync(join(REPO, "build", "engine-steps.js"), ENGINE_STEPS);
  console.log(`    Wrote the engine block to build/engine-steps.js`);
  console.log(`    Serve the repo first:  node tools/serve-repo.mjs`);
  process.exit(0);
}

// ---- 6. shim ---------------------------------------------------------------------

step(6, "copy sourced audio");
{
  // The container serves this directory, so the mp3s have to live in it. They are not
  // in the bundle: the engine's export has no notion of an audio asset it cannot play,
  // and inlining 1.5 MB of mp3 into a JSON bundle would be worse than serving files.
  const from = join(REPO, "Audio");
  const to = join(OUT, "audio");
  if (!existsSync(from)) {
    console.log("    no Audio/ directory — every clip stays synthesised");
  } else {
    mkdirSync(to, { recursive: true });
    const files = readdirSync(from).filter((f) => /\.(mp3|ogg|wav)$/i.test(f));
    let bytes = 0;
    for (const f of files) {
      copyFileSync(join(from, f), join(to, f));
      bytes += statSync(join(from, f)).size;
    }
    console.log(`    ${files.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MB`);
    // A clip naming a file that is not here is not fatal — it falls back to synthesis —
    // but it is always a mistake, so say so rather than letting it pass quietly.
    const audioJson = JSON.parse(readFileSync(join(REPO, "game/data/audio.json"), "utf8"));
    const missing = Object.entries(audioJson.clips)
      .filter(([k, c]) => k[0] !== "$" && c.file && !files.includes(c.file))
      .map(([k, c]) => `${k} -> ${c.file}`);
    if (missing.length) {
      console.log("    WARNING: clips name files not present (they will stay synthesised):");
      for (const m of missing) console.log("      " + m);
    }
  }
}

step(7, "shim the export");
if (!existsSync(join(OUT, "player.js"))) die("no export in build/battle-bots", "run the engine block first");
process.stdout.write(run("node", ["tools/shim-build.js", "build/battle-bots"], "shim-build.js"));

// ---- 7. redeploy -----------------------------------------------------------------

step(8, "restart the container");
const ps = spawnSync("docker", ["ps", "-a", "--filter", `name=${CONTAINER}`, "--format", "{{.Names}}"],
  { encoding: "utf8", shell: process.platform === "win32" });
if (!String(ps.stdout).includes(CONTAINER)) {
  console.log(`    ${CONTAINER} does not exist — creating it`);
  run("docker", ["run", "-d", "--name", CONTAINER, "--restart", "unless-stopped",
    "-p", "4300:8080", "-v", `${OUT.replace(/\\/g, "/")}:/usr/share/nginx/html:ro`,
    "nginxinc/nginx-unprivileged:alpine"], "docker run");
} else {
  run("docker", ["restart", CONTAINER], "docker restart");
}

console.log(`\nDone — http://localhost:4300  (hard-reload, the browser caches player.js)\n`);
