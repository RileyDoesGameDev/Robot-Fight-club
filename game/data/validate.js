#!/usr/bin/env node
/**
 * Consistency check for the Battle Bots data model.
 * Run from the repo root:  node game/data/validate.js
 *
 * Deliberately dependency-free — it checks the invariants that actually break
 * the assembler (T-2.9) rather than doing full JSON Schema validation:
 *   - every PartDef has the required fields and a legal category
 *   - socket offsets sit on the socketGridM lattice (T-0.12 / T-2.3)
 *   - a part's requiresSocketType is a category some socket accepts
 *   - every blueprint attachment names a real socket that accepts that part
 *   - no socket is filled twice, and derived mass / weight class are correct
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname);
const CATEGORIES = ["chassis", "wheel", "weapon", "armor", "motor"];
const errors = [];
const warnings = [];
const fail = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const { socketGridM, classes } = readJson(path.join(ROOT, "weight-classes.json"));

// ── load parts ──────────────────────────────────────────────────────────────
const parts = {};
for (const f of fs.readdirSync(path.join(ROOT, "parts")).filter((f) => f.endsWith(".json"))) {
  const p = readJson(path.join(ROOT, "parts", f));
  if (path.basename(f, ".json") !== p.id) fail(`${f}: filename does not match id "${p.id}"`);
  parts[p.id] = p;
}

const onGrid = (v) => Math.abs(v / socketGridM - Math.round(v / socketGridM)) < 1e-9;

for (const p of Object.values(parts)) {
  for (const field of ["id", "category", "displayName", "mass", "hp", "cost", "colliderSpec"]) {
    if (p[field] === undefined) fail(`${p.id}: missing required field "${field}"`);
  }
  if (!CATEGORIES.includes(p.category)) fail(`${p.id}: illegal category "${p.category}"`);
  if (p.mass <= 0) fail(`${p.id}: mass must be > 0`);
  if (p.hp <= 0) fail(`${p.id}: hp must be > 0`);

  if (p.category === "chassis") {
    if (!p.sockets || !p.sockets.length) fail(`${p.id}: chassis with no sockets`);
    const seen = new Set();
    for (const s of p.sockets || []) {
      if (seen.has(s.id)) fail(`${p.id}: duplicate socket id "${s.id}"`);
      seen.add(s.id);
      if (!s.accepts || !s.accepts.length) fail(`${p.id}.${s.id}: accepts is empty`);
      if (!(s.breakForce > 0)) fail(`${p.id}.${s.id}: breakForce must be > 0 (0 means unbreakable)`);
      for (const [axis, v] of s.position.map((v, i) => [["x", "y", "z"][i], v])) {
        if (!onGrid(v)) fail(`${p.id}.${s.id}: ${axis}=${v} is not a multiple of socketGridM (${socketGridM})`);
      }
    }
  } else if (!p.requiresSocketType) {
    fail(`${p.id}: non-chassis part has no requiresSocketType`);
  }
}

// every requiresSocketType must be accepted by at least one socket somewhere
const accepted = new Set();
for (const p of Object.values(parts)) for (const s of p.sockets || []) for (const a of s.accepts) accepted.add(a);
for (const p of Object.values(parts)) {
  if (p.requiresSocketType && !accepted.has(p.requiresSocketType)) {
    fail(`${p.id}: requiresSocketType "${p.requiresSocketType}" is not accepted by any socket`);
  }
}

// ── load blueprints ─────────────────────────────────────────────────────────
for (const f of fs.readdirSync(path.join(ROOT, "bots")).filter((f) => f.endsWith(".json"))) {
  const bp = readJson(path.join(ROOT, "bots", f));
  const chassis = parts[bp.chassisId];
  if (!chassis) { fail(`${f}: unknown chassisId "${bp.chassisId}"`); continue; }
  if (chassis.category !== "chassis") fail(`${f}: chassisId "${bp.chassisId}" is not a chassis`);

  const sockets = Object.fromEntries((chassis.sockets || []).map((s) => [s.id, s]));
  const filled = new Set();
  let mass = chassis.mass;

  for (const a of bp.attachments) {
    const part = parts[a.partId];
    const socket = sockets[a.socketId];
    if (!part) { fail(`${f}: unknown partId "${a.partId}"`); continue; }
    if (!socket) { fail(`${f}: chassis "${bp.chassisId}" has no socket "${a.socketId}"`); continue; }
    if (filled.has(a.socketId)) fail(`${f}: socket "${a.socketId}" filled more than once`);
    filled.add(a.socketId);
    if (!socket.accepts.includes(part.category)) {
      fail(`${f}: socket "${a.socketId}" accepts [${socket.accepts}] but "${a.partId}" is a ${part.category}`);
    }
    if (part.requiresSocketType && !socket.accepts.includes(part.requiresSocketType)) {
      fail(`${f}: "${a.partId}" requires a "${part.requiresSocketType}" socket, got "${a.socketId}"`);
    }
    mass += part.mass;
  }

  const cls = classes.find((c) => mass <= c.maxMassKg);
  const clsId = cls ? cls.id : "over-cap";
  if (!cls) fail(`${f}: total mass ${mass} kg exceeds every weight class cap`);
  if (bp.derived) {
    if (bp.derived.totalMassKg !== mass) {
      fail(`${f}: derived.totalMassKg is ${bp.derived.totalMassKg} but parts sum to ${mass}`);
    }
    if (bp.derived.weightClass !== clsId) {
      fail(`${f}: derived.weightClass is "${bp.derived.weightClass}" but ${mass} kg is "${clsId}"`);
    }
  } else {
    warn(`${f}: no derived block (allowed — it is a cache, not authoritative)`);
  }

  // A bot with no drive parts can never move; flag it before it reaches the arena.
  const driveParts = bp.attachments.filter((a) => parts[a.partId] && parts[a.partId].category === "wheel");
  if (driveParts.length < 2) fail(`${f}: only ${driveParts.length} wheel(s) — bot cannot drive`);

  console.log(`ok  ${f.padEnd(20)} ${String(mass).padStart(4)} kg  ${clsId.padEnd(7)} ${bp.attachments.length} attachments`);
}

console.log(`\n${Object.keys(parts).length} parts checked`);
for (const w of warnings) console.log("WARN " + w);
if (errors.length) {
  console.error(`\n${errors.length} error(s):`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log("all data consistent");
