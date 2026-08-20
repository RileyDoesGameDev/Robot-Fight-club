#!/usr/bin/env node
/**
 * aggregate.js — recorded matches in, suggested AI weights out. (T-5.19)
 *
 *   node game/data/ai/aggregate.js [--dir game/telemetry] [--write]
 *
 * PLAIN STATISTICS, NOT LEARNING
 *   The proposal cut ML-trained AI explicitly (§4, "explicitly out of scope"), and
 *   this honours that literally: everything below is counting and averaging. There
 *   is no model, no gradient, no held-out set. The output is a SUGGESTION a human
 *   reads and decides about — it never rewrites weights.json on its own, because a
 *   number arrived at by counting 6 matches has no business overwriting a number
 *   arrived at by watching the bot play.
 *
 * THE STATISTIC
 *   For each personality, for each action, we take the share of a bot's samples
 *   spent in that action, then compare the mean share in matches that bot WON
 *   against the mean share in matches it LOST:
 *
 *       lift(action) = mean(share | won) - mean(share | lost)
 *
 *   A positive lift means "this personality spends more time in this action when it
 *   wins". The suggested nudge is that lift scaled by BIAS_GAIN and clamped, applied
 *   to the action's `bias` — bias rather than a consideration weight because bias is
 *   the one term that is unconditional, so a nudge there means exactly "do this more
 *   often" without silently re-shaping when the action fires.
 *
 * WHY IT REFUSES TO SPEAK TOO SOON
 *   With one match per personality, lift is either +share or -share and means
 *   nothing. MIN_MATCHES is the floor below which it reports "insufficient data" per
 *   personality rather than emitting a confident-looking number. That is the whole
 *   defence against the failure mode this task invites — laundering noise into
 *   authority by printing it as a table.
 *
 * INPUT
 *   The JSON files MatchTelemetry writes (T-5.14). They live in the engine project's
 *   /telemetry, so pull them into the repo before running:
 *     see docs/DESIGN.md "Telemetry" for the one-liner.
 */

const fs = require("fs");
const path = require("path");

const MIN_MATCHES = 6;      // per personality, below which we decline to suggest
const BIAS_GAIN = 0.8;      // lift -> bias delta
const MAX_DELTA = 0.25;     // no single pass may move a bias further than this

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const DIR = path.resolve(arg("--dir", path.join(__dirname, "..", "..", "telemetry")));
const WRITE = argv.includes("--write");

if (!fs.existsSync(DIR)) {
  console.error("no telemetry directory at " + DIR);
  console.error("record some matches first (T-5.14), then pull /telemetry out of the engine project.");
  process.exit(1);
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));
if (!files.length) { console.error("no telemetry files in " + DIR); process.exit(1); }

/** personality -> { matches: [{won, shares:{action:share}, hits:[range]}] } */
const byPersonality = new Map();
let totalSamples = 0;
let skipped = 0;

for (const f of files) {
  let rec;
  try { rec = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); }
  catch (err) { skipped++; continue; }
  if (!rec || rec.formatVersion !== 1 || !Array.isArray(rec.samples)) { skipped++; continue; }
  // An unfinished match has no winner, so it cannot contribute to a win/loss split.
  if (!rec.result || !rec.result.winner) { skipped++; continue; }

  // A role's personality is only visible through the aiAction events it emitted; a
  // human-driven role emits none and is correctly left out of AI tuning.
  const personalityOf = new Map();
  for (const e of rec.events) {
    if (e.kind === "aiAction" && e.personality) personalityOf.set(e.role, e.personality);
  }

  const counts = new Map();   // role -> Map(action -> n)
  const totals = new Map();   // role -> n
  for (const s of rec.samples) {
    totalSamples++;
    if (!s.action || !personalityOf.has(s.role)) continue;
    if (!counts.has(s.role)) counts.set(s.role, new Map());
    const c = counts.get(s.role);
    c.set(s.action, (c.get(s.action) || 0) + 1);
    totals.set(s.role, (totals.get(s.role) || 0) + 1);
  }

  // Range is recorded on aiAction, not on hit — and it is the better read anyway:
  // engageRangeM is about the distance a personality CHOOSES to commit at, whereas
  // the range at contact is ~0 by definition.
  const decisionRanges = new Map();
  for (const e of rec.events) {
    if (e.kind !== "aiAction" || typeof e.range !== "number") continue;
    if (!decisionRanges.has(e.role)) decisionRanges.set(e.role, []);
    decisionRanges.get(e.role).push(e.range);
  }

  for (const [role, c] of counts) {
    const p = personalityOf.get(role);
    const n = totals.get(role) || 0;
    if (!n) continue;
    const shares = {};
    for (const [action, k] of c) shares[action] = k / n;
    if (!byPersonality.has(p)) byPersonality.set(p, []);
    byPersonality.get(p).push({ won: rec.result.winner === role, shares, ranges: decisionRanges.get(role) || [] });
  }
}

// ── report ─────────────────────────────────────────────────────────────────
const weightsPath = path.join(__dirname, "weights.json");
const weights = JSON.parse(fs.readFileSync(weightsPath, "utf8"));
const suggestions = {};

console.log("telemetry:  " + files.length + " files, " + totalSamples + " samples, "
  + skipped + " skipped (unfinished or unreadable)");
console.log("threshold:  " + MIN_MATCHES + " matches per personality before suggesting\n");

for (const [personality, matches] of byPersonality) {
  const wins = matches.filter((m) => m.won);
  const losses = matches.filter((m) => !m.won);
  console.log("── " + personality + " — " + matches.length + " matches ("
    + wins.length + "W / " + losses.length + "L)");

  if (matches.length < MIN_MATCHES || !wins.length || !losses.length) {
    console.log("   insufficient data — need " + MIN_MATCHES
      + " matches with at least one win and one loss. No suggestion made.\n");
    continue;
  }

  const actions = new Set();
  for (const m of matches) for (const a of Object.keys(m.shares)) actions.add(a);
  const mean = (rows, action) => rows.reduce((s, m) => s + (m.shares[action] || 0), 0) / rows.length;

  const out = {};
  for (const action of [...actions].sort()) {
    const w = mean(wins, action), l = mean(losses, action);
    const lift = w - l;
    let delta = lift * BIAS_GAIN;
    if (delta > MAX_DELTA) delta = MAX_DELTA;
    if (delta < -MAX_DELTA) delta = -MAX_DELTA;
    delta = Math.round(delta * 100) / 100;
    const current = (weights.personalities[personality] || {})[action];
    const bias = current && typeof current.bias === "number" ? current.bias : 0;
    console.log("   " + action.padEnd(16)
      + " share W " + w.toFixed(3) + "  L " + l.toFixed(3)
      + "  lift " + (lift >= 0 ? "+" : "") + lift.toFixed(3)
      + "   bias " + bias.toFixed(2) + " -> " + (bias + delta).toFixed(2));
    if (delta !== 0) out[action] = { bias: Math.round((bias + delta) * 100) / 100 };
  }

  // Where hits actually land is a direct read on engageRangeM — no inference needed.
  const ranges = matches.flatMap((m) => m.ranges).sort((a, b) => a - b);
  if (ranges.length >= 10) {
    const median = ranges[Math.floor(ranges.length / 2)];
    console.log("   median range at commit:  " + median.toFixed(2) + " m (tuning.engageRangeM is "
      + weights.tuning.engageRangeM + ")");
    out.$tuning = { engageRangeM: Math.round(median * 100) / 100 };
  }
  console.log("");
  suggestions[personality] = out;
}

if (!Object.keys(suggestions).length) {
  console.log("nothing suggested. Record more finished matches and run again.");
  process.exit(0);
}

const outPath = path.join(__dirname, "weights.suggested.json");
if (WRITE) {
  fs.writeFileSync(outPath, JSON.stringify({
    $comment: "SUGGESTIONS from data/ai/aggregate.js (T-5.19). Not loaded by the game. "
      + "Read them, decide, and hand-edit weights.json — see the header of aggregate.js for the statistic.",
    generatedFrom: { files: files.length, samples: totalSamples },
    personalities: suggestions,
  }, null, 2) + "\n");
  console.log("wrote " + outPath);
} else {
  console.log("(--write to save these to weights.suggested.json)");
}
