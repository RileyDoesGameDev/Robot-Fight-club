/**
 * Asserts what the three difficulty tiers actually do. (T-7.8)
 *
 *   node game/data/difficulty-check.mjs
 *
 * The claim being defended is narrow and worth defending: difficulty changes how
 * well the AI PLAYS and nothing else. It is very easy for a difficulty system to
 * quietly become a stat bonus — a little more health on hard, a little less damage
 * taken — and once that happens the opponent stops teaching the player anything and
 * starts feeling unfair the moment they work out what is going on.
 *
 * So this checks two things. First that the tiers are actually ordered: easy really
 * is slower, sloppier and more careless than hard, in the direction claimed. Second,
 * and more importantly, that no tier touches anything the bot is MADE of — no
 * health, damage, mass, or drivetrain multiplier appears in any difficulty block,
 * and `normal` is a byte-for-byte pass-through of the tuning that T-4.9 balanced.
 *
 * WHAT THIS DOES NOT COVER
 *   Everything here runs `onStart`. The one difficulty lever applied on the update
 *   hook — `intent.throttle *= throttleScale` — is therefore proven to be READ (the
 *   effective-tuning line reports it) but not proven to be APPLIED; deleting that
 *   multiply still passes this file. Driving `onFixedUpdate` needs a chassis, a
 *   target, live bodies and a weapon joint, which is a stub big enough to be its own
 *   source of bugs. It is verified in the live engine instead, by booting an easy and
 *   a normal brain and comparing the `intent.throttle` each publishes into its
 *   chassis params — recorded against T-7.8 in TASKS.md.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const weights = JSON.parse(readFileSync(join(HERE, "ai", "weights.json"), "utf8"));
const create = (await import(pathToFileURL(join(HERE, "..", "scripts", "UtilityAi.ts")).href)).default;

let failed = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, why: e.message }); failed++; }
}
const ok = (c, w) => { if (!c) throw new Error(w); };
const eq = (a, b, w) => { if (a !== b) throw new Error(`${w}: expected ${b}, got ${a}`); };

const TIERS = ["easy", "normal", "hard"];
const D = weights.difficulty;

// ---- the data ---------------------------------------------------------------------

check("all three tiers exist", () => {
  ok(D, "difficulty block present");
  for (const t of TIERS) ok(D[t], `${t} tier present`);
});

check("normal is a pure pass-through of the balanced tuning", () => {
  const n = D.normal;
  for (const k of ["reactionScale", "alignToleranceScale", "hazardRadiusScale", "throttleScale"]) {
    eq(n[k], 1, `normal.${k}`);
  }
  eq(n.mistakeChance, 0, "normal.mistakeChance");
});

check("NO tier grants a stat advantage — difficulty is skill, never cheating", () => {
  // Anything matching these would be a bonus to what the bot IS rather than to how
  // it plays. The list is deliberately broad: it should catch a future well-meaning
  // "healthScale" long before anyone ships it.
  const forbidden = /health|damage|armou?r|mass|hp|weapon|force|torque|drive|speedScale|maxSpeed/i;
  for (const t of TIERS) {
    for (const k of Object.keys(D[t])) {
      if (k.startsWith("$")) continue;
      ok(!forbidden.test(k), `${t}.${k} looks like a stat advantage, not a skill difference`);
    }
  }
});

check("tiers are ordered in the direction they claim", () => {
  ok(D.easy.reactionScale > D.normal.reactionScale, "easy reacts slower than normal");
  ok(D.hard.reactionScale < D.normal.reactionScale, "hard reacts faster than normal");
  ok(D.easy.alignToleranceScale > D.hard.alignToleranceScale, "easy aims sloppier than hard");
  ok(D.easy.hazardRadiusScale < D.hard.hazardRadiusScale, "easy respects pits later than hard");
  ok(D.easy.mistakeChance > 0, "easy actually makes mistakes");
  eq(D.hard.mistakeChance, 0, "hard makes none");
  ok(D.easy.throttleScale < 1, "easy drives less hard");
  eq(D.hard.throttleScale, 1, "hard drives no harder than the machine allows");
});

// ---- the code that consumes it -----------------------------------------------------

/** Minimal stub: enough for onStart to load weights and report itself. */
function bootBrain(difficulty) {
  const logs = [];
  const call = (tool, a) => {
    if (tool === "project.readFile") return { content: { text: JSON.stringify(weights) } };
    if (tool === "scene.query") return { content: { entities: [] } };
    return { content: {} };
  };
  const engine = {
    console: { log: (m) => logs.push(m) },
    mcp: { on: () => () => {}, emit: () => {} },
  };
  const inst = create();
  inst.onStart({ entity: 1, engine, call, params: { role: "opponent", target: "player", personality: "aggressive", difficulty } });
  return { logs };
}

check("the brain reports the difficulty it booted with", () => {
  for (const t of TIERS) {
    const { logs } = bootBrain(t);
    const line = logs.find((l) => l.indexOf("[AI]") === 0 && l.indexOf("brain up") >= 0);
    ok(line, `${t}: startup line present`);
    ok(line.indexOf(t) >= 0, `${t}: named in "${line}"`);
  }
});

check("an unknown difficulty falls back to normal and says so", () => {
  const { logs } = bootBrain("nightmare");
  ok(logs.some((l) => l.indexOf("unknown difficulty") >= 0), "warns about the bad value");
  const line = logs.find((l) => l.indexOf("brain up") >= 0);
  ok(line && line.indexOf("normal") >= 0, `falls back to normal, got "${line}"`);
});

check("a missing difficulty param is normal, silently", () => {
  const { logs } = bootBrain(undefined);
  ok(!logs.some((l) => l.indexOf("unknown difficulty") >= 0), "no warning for an absent value");
  const line = logs.find((l) => l.indexOf("brain up") >= 0);
  ok(line && line.indexOf("normal") >= 0, "defaults to normal");
});

check("difficulty is orthogonal to personality — every pairing boots", () => {
  const personalities = Object.keys(weights.personalities).filter((k) => k[0] !== "$");
  ok(personalities.length >= 3, "the three personalities are still there");
  for (const t of TIERS) {
    for (const pers of personalities) {
      const logs = [];
      const call = (tool) => tool === "project.readFile"
        ? { content: { text: JSON.stringify(weights) } }
        : { content: { entities: [] } };
      const engine = { console: { log: (m) => logs.push(m) }, mcp: { on: () => () => {}, emit: () => {} } };
      create().onStart({ entity: 1, engine, call, params: { role: "opponent", personality: pers, difficulty: t } });
      const line = logs.find((l) => l.indexOf("brain up") >= 0);
      ok(line && line.indexOf(pers) >= 0 && line.indexOf(t) >= 0,
        `${pers} x ${t} both survive into "${line}"`);
    }
  }
});

check("the scaling is actually APPLIED, not just declared in the data", () => {
  // The gap this closes: every check above passes even if the code that multiplies
  // the tuning is deleted, because they only read weights.json. These assert the
  // numbers the brain reports it is really running.
  const eff = (t) => {
    const { logs } = bootBrain(t);
    const line = logs.find((l) => l.indexOf("effective tuning") >= 0);
    ok(line, `${t}: effective-tuning line present`);
    const g = (re) => { const m = line.match(re); ok(m, `${t}: ${re} in "${line}"`); return parseFloat(m[1]); };
    return {
      dwell: g(/dwell ([\d.]+)s/),
      align: g(/align ([\d.]+)rad/),
      hazard: g(/hazard ([\d.]+)m/),
      throttle: g(/throttle x([\d.]+)/),
      mistakes: g(/mistakes (\d+)%/),
    };
  };
  const base = weights.tuning;
  const e = eff("easy"), n = eff("normal"), h = eff("hard");

  // normal must be the authored tuning untouched
  ok(Math.abs(n.dwell - base.minDwellSeconds) < 1e-6, `normal dwell is the authored ${base.minDwellSeconds}, got ${n.dwell}`);
  ok(Math.abs(n.align - base.alignToleranceRad) < 1e-6, `normal align untouched, got ${n.align}`);
  ok(Math.abs(n.hazard - base.hazardRadiusM) < 1e-6, `normal hazard untouched, got ${n.hazard}`);

  // and the other tiers must be the authored value times their declared scale
  const D2 = weights.difficulty;
  ok(Math.abs(e.dwell - base.minDwellSeconds * D2.easy.reactionScale) < 1e-6,
    `easy dwell = ${base.minDwellSeconds} x ${D2.easy.reactionScale}, got ${e.dwell}`);
  ok(Math.abs(h.dwell - base.minDwellSeconds * D2.hard.reactionScale) < 1e-6,
    `hard dwell = ${base.minDwellSeconds} x ${D2.hard.reactionScale}, got ${h.dwell}`);
  ok(Math.abs(e.align - base.alignToleranceRad * D2.easy.alignToleranceScale) < 1e-6,
    `easy align scaled, got ${e.align}`);
  ok(Math.abs(e.hazard - base.hazardRadiusM * D2.easy.hazardRadiusScale) < 1e-6,
    `easy hazard scaled, got ${e.hazard}`);
  ok(e.mistakes === Math.round(D2.easy.mistakeChance * 100), `easy mistake rate reported, got ${e.mistakes}%`);
  ok(h.mistakes === 0, `hard makes no mistakes, got ${h.mistakes}%`);
  ok(Math.abs(e.throttle - D2.easy.throttleScale) < 1e-6, `easy throttle scaled, got ${e.throttle}`);
});

// ---- report -------------------------------------------------------------------------

console.log("difficulty-check — the easy/normal/hard mapping over the AI weight sets\n");
for (const r of results) {
  console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name}`);
  if (!r.ok) console.log(`          ${r.why}`);
}
console.log(failed ? `\nFAIL — ${failed} of ${results.length}` : `\nPASS — ${results.length} checks`);
process.exit(failed ? 1 : 0);
