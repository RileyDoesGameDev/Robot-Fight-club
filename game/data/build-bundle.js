#!/usr/bin/env node
/**
 * Packs game/data/** into a single bundle the engine can read in one call.
 *
 *   node game/data/build-bundle.js
 *
 * Why a bundle: the per-file layout under parts/ and bots/ is the SOURCE OF
 * TRUTH and stays human-diffable, but a gameplay script inside the engine would
 * otherwise need one project.readFile per part plus a directory listing. The
 * bundle is a generated build artifact — never hand-edit it, and never read a
 * value from it that isn't in the sources.
 *
 * Writes:
 *   game/data/bundle.json          pretty, committed, diffable
 *   game/data/bundle.min.json      minified, what gets pushed into the engine
 */
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const loadDir = (dir) =>
  Object.fromEntries(
    fs
      .readdirSync(path.join(ROOT, dir))
      // "__"-prefixed files are runtime state (__selected, __draft, __player),
      // not roster content. BotAssembler resolves those from /data/bots/<id>.json.
      .filter((f) => f.endsWith(".json") && !f.startsWith("__"))
      .sort()
      .map((f) => [path.basename(f, ".json"), readJson(path.join(ROOT, dir, f))]),
  );

const bundle = {
  $generated: "by game/data/build-bundle.js — do not hand-edit",
  parts: loadDir("parts"),
  bots: loadDir("bots"),
  damage: readJson(path.join(ROOT, "damage.json")),
  weightClasses: readJson(path.join(ROOT, "weight-classes.json")),
  inputMap: readJson(path.join(ROOT, "input-map.json")),
  aiWeights: readJson(path.join(ROOT, "ai", "weights.json")),
  vfx: readJson(path.join(ROOT, "vfx.json")),
};

fs.writeFileSync(path.join(ROOT, "bundle.json"), JSON.stringify(bundle, null, 2) + "\n");
const min = JSON.stringify(bundle);
fs.writeFileSync(path.join(ROOT, "bundle.min.json"), min + "\n");

console.log(
  `bundle: ${Object.keys(bundle.parts).length} parts, ${Object.keys(bundle.bots).length} bots, ` +
    `${min.length} chars minified`,
);
