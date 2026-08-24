#!/usr/bin/env node
/**
 * Validates the audio the game will actually ship.
 *
 *   node game/data/audio-check.js [--write-wav <dir>]
 *
 * WHY THIS EXISTS
 *   The engine editor profile does not decode audio. `audio.loadClip` stores the
 *   bytes, marks the clip `loaded: true` and never looks at them again — five bytes
 *   of junk and a dead URL both report success (engine-fixes.md LIM-006). So
 *   "the clip loaded" proves nothing about whether it is a valid, audible WAV, and
 *   nothing inside the engine will ever tell us otherwise.
 *
 *   This harness is the missing check. It EXTRACTS the synth block from
 *   `game/scripts/AudioDirector.ts` verbatim — between the SYNTH:BEGIN and
 *   SYNTH:END markers — and runs it here against the real `audio.json`. It is
 *   therefore testing the shipped code, not a reimplementation of it that could
 *   drift. If the two ever diverge, the extraction fails loudly rather than
 *   silently validating the wrong thing.
 *
 * WHAT IT CHECKS
 *   - the RIFF/WAVE header parses, and its declared sizes match the byte array
 *   - every sample is a finite, in-range 16-bit value
 *   - the clip is not silent, and is not clipped into a square wave
 *   - loop clips wrap seamlessly (the step from last sample to first is small)
 *   - one-shots start and end near zero, so they do not click
 *   - synthesis is deterministic: two runs are byte-identical
 *
 * `--write-wav <dir>` drops real .wav files you can listen to, which is the only
 * way to audition this audio short of the runtime build.
 */
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const SCRIPT = path.join(ROOT, "..", "scripts", "AudioDirector.ts");
const BEGIN = "SYNTH:BEGIN";
const END = "SYNTH:END";

// ---- extract the shipped synth ------------------------------------------------

const src = fs.readFileSync(SCRIPT, "utf8");
const b = src.indexOf(BEGIN);
const e = src.indexOf(END);
if (b < 0 || e < 0 || e < b) {
  console.error(`FAIL: could not find ${BEGIN}/${END} markers in ${SCRIPT}`);
  console.error("The synth block moved or was renamed — this harness is now testing nothing.");
  process.exit(1);
}
// From the end of the BEGIN banner to the start of the END banner. The markers sit
// inside block comments, so trim back to the comment boundaries.
const block = src.slice(src.indexOf("*/", b) + 2, src.lastIndexOf("/*", e));

let buildWav;
try {
  buildWav = new Function(`${block}\nreturn buildWav;`)();
} catch (err) {
  console.error("FAIL: extracted synth block did not evaluate:", err.message);
  process.exit(1);
}
if (typeof buildWav !== "function") {
  console.error("FAIL: extracted block did not define buildWav");
  process.exit(1);
}

// ---- the data it will be given ------------------------------------------------

const audio = JSON.parse(fs.readFileSync(path.join(ROOT, "audio.json"), "utf8"));
const sr = audio.sampleRate;
const names = Object.keys(audio.clips).filter((k) => k[0] !== "$");

const outDir = process.argv.indexOf("--write-wav") >= 0
  ? process.argv[process.argv.indexOf("--write-wav") + 1]
  : null;
if (outDir) fs.mkdirSync(outDir, { recursive: true });

// ---- checks -------------------------------------------------------------------

const rd = (bytes, o, n) => { let v = 0; for (let i = n - 1; i >= 0; i--) v = v * 256 + bytes[o + i]; return v; };
const ascii = (bytes, o, n) => String.fromCharCode(...bytes.slice(o, o + n));

let failures = 0;
const rows = [];

for (const name of names) {
  const spec = audio.clips[name];
  const bytes = buildWav(name, spec, sr);
  const problems = [];

  // header
  if (ascii(bytes, 0, 4) !== "RIFF") problems.push("no RIFF magic");
  if (ascii(bytes, 8, 4) !== "WAVE") problems.push("no WAVE magic");
  if (ascii(bytes, 12, 4) !== "fmt ") problems.push("no fmt chunk");
  if (ascii(bytes, 36, 4) !== "data") problems.push("no data chunk");
  if (rd(bytes, 22, 2) !== 1) problems.push("not mono");
  if (rd(bytes, 34, 2) !== 16) problems.push("not 16-bit");
  if (rd(bytes, 24, 4) !== sr) problems.push(`sample rate ${rd(bytes, 24, 4)} != ${sr}`);

  const dataLen = rd(bytes, 40, 4);
  if (dataLen !== bytes.length - 44) problems.push(`data size ${dataLen} != ${bytes.length - 44} actual`);
  if (rd(bytes, 4, 4) !== bytes.length - 8) problems.push("RIFF size wrong");

  // samples
  const n = dataLen / 2;
  const s = new Float64Array(n);
  let peak = 0, sumSq = 0, clipped = 0, bad = 0;
  for (let i = 0; i < n; i++) {
    let v = bytes[44 + i * 2] | (bytes[44 + i * 2 + 1] << 8);
    if (v > 32767) v -= 65536;
    const b0 = bytes[44 + i * 2], b1 = bytes[44 + i * 2 + 1];
    if (!Number.isInteger(b0) || b0 < 0 || b0 > 255 || !Number.isInteger(b1) || b1 < 0 || b1 > 255) bad++;
    const f = v / 32768;
    s[i] = f;
    const a = Math.abs(f);
    if (a > peak) peak = a;
    if (a >= 0.999) clipped++;
    sumSq += f * f;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, n));

  if (bad) problems.push(`${bad} bytes outside 0..255`);
  if (n === 0) problems.push("no samples");
  if (peak < 0.02) problems.push(`effectively silent (peak ${peak.toFixed(4)})`);
  if (rms < 0.002) problems.push(`RMS ${rms.toFixed(5)} — inaudible`);
  if (clipped / Math.max(1, n) > 0.02) problems.push(`${((clipped / n) * 100).toFixed(1)}% of samples at full scale — squared off`);

  // boundaries
  const wrap = Math.abs(s[n - 1] - s[0]);
  if (spec.loop && spec.freq > 0) {
    // A PERIODIC loop is seamless exactly when it holds a whole number of cycles —
    // that is the real criterion, and it is checked below. Measuring the raw step
    // across the wrap says nothing here: a sawtooth jumps the full range once per
    // cycle by definition, so the correct wrap is a big step, and demanding a small
    // one would mean demanding a broken saw.
  } else if (spec.loop) {
    // No cycle to align to (the crowd bed), so the join has to be made by hand and
    // is worth measuring. This one is low-passed, so it moves in small increments
    // and any real step would read as a tick once per loop, forever.
    if (wrap > 0.05) problems.push(`loop wrap discontinuity ${wrap.toFixed(3)} — will tick`);
  } else {
    if (Math.abs(s[0]) > 0.05) problems.push(`starts at ${s[0].toFixed(3)} — will click`);
    if (Math.abs(s[n - 1]) > 0.05) problems.push(`ends at ${s[n - 1].toFixed(3)} — will click`);
  }

  // Content, not just format. A clip can be a perfectly valid WAV of the wrong
  // sound, and every check above would pass on a pure tone at the wrong pitch.
  if (spec.kind === "saw" && spec.freq > 0) {
    // Goertzel at the fundamental and its neighbours: the fundamental must win.
    const mag = (f) => {
      const k = 2 * Math.cos((2 * Math.PI * f) / sr);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < n; i++) { const s0 = s[i] + k * s1 - s2; s2 = s1; s1 = s0; }
      return Math.sqrt(Math.abs(s1 * s1 + s2 * s2 - k * s1 * s2)) / n;
    };
    const cands = [spec.freq / 2, spec.freq, spec.freq * 2, spec.freq * 3];
    let best = cands[0], bestM = -1;
    for (const f of cands) { const m = mag(f); if (m > bestM) { bestM = m; best = f; } }
    if (Math.abs(best - spec.freq) > 0.5) {
      problems.push(`strongest partial is ${best.toFixed(0)} Hz, not the specified ${spec.freq} Hz`);
    }
  }
  if (spec.kind === "sweep" && typeof spec.freqTo === "number") {
    // Zero-crossing rate at each end must move in the direction the spec asks for.
    const zc = (a, bb) => { let c = 0; for (let i = a + 1; i < bb; i++) if ((s[i - 1] < 0) !== (s[i] < 0)) c++; return (c * sr) / (2 * (bb - a)); };
    const w = Math.max(1, Math.floor(n * 0.15));
    const lo = zc(0, w), hi = zc(n - w, n);
    const wantUp = spec.freqTo > spec.freq;
    if (wantUp ? hi <= lo : hi >= lo) {
      problems.push(`sweep does not glide ${spec.freq}->${spec.freqTo} Hz (measured ${lo.toFixed(0)} -> ${hi.toFixed(0)})`);
    }
  }

  // whole cycles, for pitched loops
  if (spec.loop && spec.freq > 0) {
    const cycles = (n * spec.freq) / sr;
    if (Math.abs(cycles - Math.round(cycles)) > 0.02) {
      problems.push(`${cycles.toFixed(3)} cycles — not a whole number`);
    }
  }

  // determinism
  const again = buildWav(name, spec, sr);
  if (again.length !== bytes.length) problems.push("non-deterministic length");
  else for (let i = 0; i < bytes.length; i++) {
    if (again[i] !== bytes[i]) { problems.push(`non-deterministic at byte ${i}`); break; }
  }

  if (outDir) fs.writeFileSync(path.join(outDir, `${name}.wav`), Buffer.from(bytes));

  rows.push({
    name, kind: spec.kind, bus: spec.bus, loop: !!spec.loop,
    ms: Math.round((n / sr) * 1000), kb: +(bytes.length / 1024).toFixed(1),
    peak: +peak.toFixed(3), rms: +rms.toFixed(4), wrap: +wrap.toFixed(3),
    ok: problems.length === 0, problems,
  });
  if (problems.length) failures++;
}

// ---- mix sanity ---------------------------------------------------------------

const buses = audio.buses;
const mixProblems = [];
for (const [k, v] of Object.entries(buses)) {
  if (typeof v !== "number" || v < 0 || v > 1) mixProblems.push(`bus ${k} = ${v} out of 0..1`);
}
for (const name of names) {
  const c = audio.clips[name];
  if (!c.bus) mixProblems.push(`clip ${name} names no bus`);
  else if (buses[c.bus] === undefined) mixProblems.push(`clip ${name} -> unknown bus "${c.bus}"`);
  const loudest = (buses.master || 1) * (buses[c.bus] || 1) * (c.gain === undefined ? 1 : c.gain);
  if (loudest > 1) mixProblems.push(`clip ${name} can reach ${loudest.toFixed(2)} — above unity`);
}

// ---- report -------------------------------------------------------------------

const pad = (s, w) => String(s).padEnd(w);
console.log(`audio-check — ${names.length} clips from audio.json, synth extracted from AudioDirector.ts\n`);
console.log(`  ${pad("clip", 9)}${pad("kind", 7)}${pad("bus", 9)}${pad("ms", 6)}${pad("KB", 7)}${pad("peak", 7)}${pad("rms", 8)}${pad("wrap", 7)}status`);
for (const r of rows) {
  console.log(`  ${pad(r.name, 9)}${pad(r.kind, 7)}${pad(r.bus, 9)}${pad(r.ms, 6)}${pad(r.kb, 7)}${pad(r.peak, 7)}${pad(r.rms, 8)}${pad(r.wrap, 7)}${r.ok ? "ok" : "FAIL"}`);
  for (const p of r.problems) console.log(`  ${" ".repeat(9)}  - ${p}`);
}

const totalKb = rows.reduce((a, r) => a + r.kb, 0);
console.log(`\n  total ${totalKb.toFixed(1)} KB of PCM, synthesised at load — no audio files in the build.`);

if (mixProblems.length) {
  console.log("\n  mix problems:");
  for (const p of mixProblems) console.log(`    - ${p}`);
}
if (outDir) console.log(`\n  wrote ${rows.length} .wav files to ${outDir}`);

const bad = failures + mixProblems.length;
console.log(bad ? `\nFAIL — ${failures} clip(s), ${mixProblems.length} mix problem(s)` : "\nPASS");
process.exit(bad ? 1 : 0);
