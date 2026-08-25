#!/usr/bin/env node
/**
 * Package the game as a self-contained Docker image other people can run. (T-8.2)
 *
 *   node tools/package-game.mjs             build the image and start it
 *   node tools/package-game.mjs --save      ...and write a shareable .tar
 *   node tools/package-game.mjs --no-run    build only
 *
 * WHAT THIS PRODUCES
 *   An image with the whole game baked in — engine player, scene bundle, seeded
 *   project files and audio. No host mount, no volume, no network at runtime. The
 *   recipient needs Docker and nothing else: no Node, no engine, no repo checkout.
 *
 * WHAT IT DOES NOT DO
 *   It does not rebuild the game. The build lives in `build/battle-bots` and is
 *   produced by the editor over the MCP bridge (`tools/rebuild-game.mjs`), which
 *   needs the engine running — so it cannot be folded in here without making
 *   packaging depend on a live editor. Instead this REFUSES to package a build that
 *   looks stale or incomplete, which is the failure that actually matters: shipping
 *   somebody a container that quietly runs last week's game.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const OUT = join(REPO, "build", "battle-bots");
const IMAGE = "battle-bots:latest";
const CONTAINER = "battle-bots";
const PORT = process.env.PORT || "4300";

const args = new Set(process.argv.slice(2));
const step = (n, m) => console.log(`\n[${n}] ${m}`);
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

function run(cmd, argv, label, opts = {}) {
  const r = spawnSync(cmd, argv.map(q), {
    cwd: REPO, encoding: "utf8", shell: process.platform === "win32",
    stdio: opts.quiet ? "pipe" : "inherit",
  });
  if (r.status !== 0) die(`${label} failed`, opts.hint);
  return r.stdout || "";
}

// ---- 1. refuse to package something broken or stale -------------------------------

step(1, "check the build");

const REQUIRED = ["index.html", "player.js", "bundle.json", "seed.js"];
const missing = REQUIRED.filter((f) => !existsSync(join(OUT, f)));
if (missing.length) {
  die(`build/battle-bots is missing ${missing.join(", ")}`,
      "run tools/rebuild-game.mjs (needs the editor running with Expose enabled)");
}

// The shim is what makes a build runnable at all; an unshimmed export starts, renders
// the export-time scene, and responds to nothing (LIM-009). That is exactly the kind
// of thing you do not discover until someone else reports the game "doesn't work".
const player = readFileSync(join(OUT, "player.js"), "utf8");
if (player.indexOf("__SMPL_SHIMMED__") < 0) {
  die("build/battle-bots/player.js is not shimmed",
      "run: node tools/shim-build.js build/battle-bots");
}

// Sources changed after the build were not in it. This is the stale-build check.
const buildTime = Math.min(...REQUIRED.map((f) => statSync(join(OUT, f)).mtimeMs));
const watched = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|json)$/.test(e.name) && !p.includes("bundle.min")) watched.push(p);
  }
};
walk(join(REPO, "game"));
const newer = watched.filter((p) => statSync(p).mtimeMs > buildTime + 1000);
if (newer.length) {
  console.log(`    ${newer.length} source file(s) changed after this build:`);
  for (const p of newer.slice(0, 8)) console.log(`      ${p.replace(REPO, ".")}`);
  if (newer.length > 8) console.log(`      ...and ${newer.length - 8} more`);
  if (!args.has("--stale-ok")) {
    die("the build is older than the sources",
        "run tools/rebuild-game.mjs first, or pass --stale-ok if this is deliberate");
  }
  console.log("    --stale-ok given; packaging anyway");
}

const audioDir = join(OUT, "audio");
const audioCount = existsSync(audioDir) ? readdirSync(audioDir).length : 0;
const totalMb = REQUIRED.reduce((a, f) => a + statSync(join(OUT, f)).size, 0) / 1024 / 1024;
console.log(`    shimmed, ${totalMb.toFixed(1)} MB of build + ${audioCount} audio files`);
if (!audioCount) console.log("    NOTE: no audio/ directory — every clip will fall back to synthesis");

// ---- 2. build the image -----------------------------------------------------------

step(2, `build ${IMAGE}`);
run("docker", ["build", "-f", "deploy/Dockerfile", "-t", IMAGE, "."], "docker build");

const size = run("docker", ["image", "inspect", IMAGE, "--format", "{{.Size}}"], "docker inspect", { quiet: true });
console.log(`    image size ${(Number(size.trim()) / 1024 / 1024).toFixed(0)} MB`);

// ---- 3. run it --------------------------------------------------------------------

if (!args.has("--no-run")) {
  step(3, `run on :${PORT}`);
  spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore", shell: process.platform === "win32" });
  run("docker", ["run", "-d", "--name", CONTAINER, "--restart", "unless-stopped",
                 "-p", `${PORT}:8080`, "--read-only",
                 "--tmpfs", "/tmp", "--tmpfs", "/var/cache/nginx",
                 "--security-opt", "no-new-privileges:true", IMAGE], "docker run");
  console.log(`    http://localhost:${PORT}`);
}

// ---- 4. optional: a file you can send -----------------------------------------------

if (args.has("--save")) {
  step(4, "save a shareable tarball");
  const tar = join(REPO, "build", "battle-bots-image.tar");
  run("docker", ["save", "-o", tar, IMAGE], "docker save");
  const mb = (statSync(tar).size / 1024 / 1024).toFixed(0);
  console.log(`    ${tar.replace(REPO, ".")} (${mb} MB)`);
  console.log(`\n    Send that file plus deploy/README.md. The recipient runs:`);
  console.log(`      docker load -i battle-bots-image.tar`);
  console.log(`      docker run --rm -p 4300:8080 ${IMAGE}`);
}

console.log(`\nDone.\n`);
