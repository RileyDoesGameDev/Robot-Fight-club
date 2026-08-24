/**
 * Drives MatchCamera against a stubbed engine and asserts the game feel. (T-7.9)
 *
 *   node game/data/camera-feel-check.mjs
 *
 * WHY THIS EXISTS
 *   Shake, hit stop and the knockout push are all things you judge by eye, and there
 *   is no eye here - the editor renders to a canvas this process cannot see. What CAN
 *   be pinned down is the arithmetic underneath: that a small hit is ignored and a big
 *   one is not, that a shake decays to exactly zero rather than leaving the camera
 *   permanently offset, that tracking actually stops during hit stop, and - the one
 *   that matters most and is easiest to get wrong - that all of it is frame-rate
 *   independent. A shake built on per-frame randomness looks different on a 144 Hz
 *   monitor, and nobody notices until someone else plays it.
 *
 *   Taste still needs a human. This only guarantees the effect is not broken.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const create = (await import(pathToFileURL(join(HERE, "..", "scripts", "MatchCamera.ts")).href)).default;

// ---- stub -----------------------------------------------------------------------

function makeHarness(botPositions) {
  const calls = [];
  const names = new Map([[200, "Bot_player_Chassis"], [201, "Bot_opponent_Chassis"]]);
  const bodies = new Map(Object.entries(botPositions).map(([k, v]) => [Number(k), v]));
  let written = null;

  const call = (tool, a) => {
    calls.push({ tool, args: a });
    switch (tool) {
      case "scene.query":
        return { content: { entities: [...names.keys()] } };
      case "scene.getComponent":
        if (a.component === "Name") {
          return names.has(a.entity) ? { content: { value: names.get(a.entity) } } : { isError: true };
        }
        if (a.component === "Transform") {
          // The authored camera pose from Arena01.
          return { content: { position: [0, 11, 12], rotation: [-0.3625, 0, 0, 0.932] } };
        }
        return { isError: true };
      case "physics.bodyState":
        return bodies.has(a.entity) ? { content: { position: bodies.get(a.entity) } } : { isError: true };
      case "scene.setComponent":
        written = a.patch.position.slice();
        return { content: {} };
      default:
        return { content: {} };
    }
  };

  const handlers = new Map();
  const engine = {
    console: { log: () => {} },
    mcp: {
      on(ch, fn) {
        if (!handlers.has(ch)) handlers.set(ch, []);
        handlers.get(ch).push(fn);
        return () => { const l = handlers.get(ch); l.splice(l.indexOf(fn), 1); };
      },
      emit(ch, p) { for (const fn of handlers.get(ch) || []) fn(p); },
    },
  };

  return {
    call, engine, bodies,
    emit: (ch, p) => engine.mcp.emit(ch, p),
    pos: () => written,
    move(entity, x, z) { bodies.get(entity).x = x; bodies.get(entity).z = z; },
  };
}

const PARAMS = {};   // exercise the shipped DEFAULTS

function boot(positions = { 200: { x: -2, y: 0.3, z: 0 }, 201: { x: 2, y: 0.3, z: 0 } }) {
  const h = makeHarness(positions);
  const inst = create();
  inst.onStart({ entity: 1, engine: h.engine, call: h.call });
  const step = (dt = 1 / 60, n = 1) => {
    for (let i = 0; i < n; i++) inst.onUpdate({ entity: 1, call: h.call, dt, params: PARAMS });
    return h.pos();
  };
  return { h, inst, step };
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---- assertions -------------------------------------------------------------------

let failed = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, why: e.message }); failed++; }
}
const ok = (c, w) => { if (!c) throw new Error(w); };
const near = (a, b, tol, w) => { if (Math.abs(a - b) > tol) throw new Error(`${w}: expected ~${b}, got ${a}`); };

check("settles to a steady position with no hits", () => {
  const { step } = boot();
  step(1 / 60, 400);
  const a = step();
  const b = step();
  near(dist(a, b), 0, 1e-6, "camera is still");
});

check("a big hit displaces the camera", () => {
  const { h, step } = boot();
  step(1 / 60, 400);
  const before = step().slice();
  h.emit("battlebots.weaponHit", { force: 9000 });
  const after = step();
  ok(dist(before, after) > 0.05, `camera moved on impact (moved ${dist(before, after).toFixed(4)} m)`);
});

check("a weak hit is ignored entirely", () => {
  const { h, step } = boot();
  step(1 / 60, 400);
  const before = step().slice();
  h.emit("battlebots.weaponHit", { force: 200 });   // below shakeMinForceN
  const after = step();
  near(dist(before, after), 0, 1e-6, "no shake from a tap");
});

check("shake scales with force", () => {
  const peak = (force) => {
    const { h, step } = boot();
    step(1 / 60, 400);
    const base = step().slice();
    h.emit("battlebots.weaponHit", { force });
    let worst = 0;
    for (let i = 0; i < 30; i++) worst = Math.max(worst, dist(base, step()));
    return worst;
  };
  const soft = peak(2500), hard = peak(9000);
  ok(hard > soft * 1.5, `a hard hit shakes harder (${soft.toFixed(3)} vs ${hard.toFixed(3)})`);
});

check("losing a part shakes hardest of all", () => {
  const peak = (emit) => {
    const { h, step } = boot();
    step(1 / 60, 400);
    const base = step().slice();
    emit(h);
    let worst = 0;
    for (let i = 0; i < 30; i++) worst = Math.max(worst, dist(base, step()));
    return worst;
  };
  const hit = peak((h) => h.emit("battlebots.weaponHit", { force: 4000 }));
  const detach = peak((h) => h.emit("battlebots.partDetached", { entity: 9 }));
  ok(detach > hit, `detachment outweighs an ordinary hit (${hit.toFixed(3)} vs ${detach.toFixed(3)})`);
});

check("shake decays to exactly zero, leaving no permanent offset", () => {
  const { h, step } = boot();
  step(1 / 60, 400);
  const settled = step().slice();
  h.emit("battlebots.weaponHit", { force: 9000 });
  step(1 / 60, 240);                       // four seconds
  const a = step(), b = step();
  near(dist(a, b), 0, 1e-9, "camera is perfectly still again");
  near(dist(settled, a), 0, 1e-6, "and back where it started, not offset");
});

check("hit stop freezes tracking, then releases it", () => {
  const { h, step } = boot();
  step(1 / 60, 400);
  const start = step().slice();
  // Move the bots far away; normally the camera chases immediately.
  h.move(200, -2, 40);
  h.move(201, 2, 40);
  h.emit("battlebots.weaponHit", { force: 9000 });   // >= hitStopMinForceN
  // Advance less than hitStopSeconds (0.08) and the camera must not have chased.
  const during = step(1 / 240, 12).slice();          // 0.05 s
  const chasedDuring = Math.abs(during[2] - start[2]);
  // Now let the stop expire and it should chase hard.
  step(1 / 60, 60);
  const after = step();
  const chasedAfter = Math.abs(after[2] - start[2]);
  ok(chasedDuring < 1.0, `tracking frozen during hit stop (moved ${chasedDuring.toFixed(3)} m in z)`);
  ok(chasedAfter > 5, `tracking resumes after it (moved ${chasedAfter.toFixed(3)} m in z)`);
});

check("a knockout pulls the camera in and holds", () => {
  const { h, step } = boot();
  step(1 / 60, 400);
  const before = step().slice();
  const rBefore = Math.hypot(before[0], before[1], before[2]);
  h.emit("battlebots.knockout", { role: "opponent", reason: "immobilised" });
  step(1 / 60, 200);
  const after = step();
  const rAfter = Math.hypot(after[0], after[1], after[2]);
  ok(rAfter < rBefore - 1, `camera pushed in (${rBefore.toFixed(2)} m -> ${rAfter.toFixed(2)} m)`);
  // and it must stop, not keep creeping forever
  step(1 / 60, 200);
  const later = step();
  near(Math.hypot(later[0], later[1], later[2]), rAfter, 0.02, "push settles");
});

check("shake is frame-rate independent", () => {
  // Same elapsed time, wildly different step sizes: the displacement at a given
  // moment must agree. Per-frame randomness would fail this outright.
  const sample = (dt) => {
    const { h, step } = boot();
    step(1 / 60, 400);
    const base = step().slice();
    h.emit("battlebots.weaponHit", { force: 9000 });
    const steps = Math.round(0.1 / dt);
    const p = step(dt, steps);
    return dist(base, p);
  };
  const at60 = sample(1 / 60), at144 = sample(1 / 144), at30 = sample(1 / 30);
  ok(Math.abs(at60 - at144) < 0.04, `60 Hz vs 144 Hz agree (${at60.toFixed(4)} vs ${at144.toFixed(4)})`);
  ok(Math.abs(at60 - at30) < 0.06, `60 Hz vs 30 Hz agree (${at60.toFixed(4)} vs ${at30.toFixed(4)})`);
});

check("trauma cannot stack past full scale", () => {
  const { h, step } = boot();
  step(1 / 60, 400);
  const base = step().slice();
  for (let i = 0; i < 50; i++) h.emit("battlebots.weaponHit", { force: 100000 });
  let worst = 0;
  for (let i = 0; i < 40; i++) worst = Math.max(worst, dist(base, step()));
  // shakeMetres 0.42, and the offset is bounded by sqrt(x^2+y^2+z^2) of the
  // per-axis amplitudes: 0.42 * sqrt(1 + 0.36 + 1) ~= 0.63 at absolute worst.
  ok(worst < 0.7, `bounded even under a barrage (peak ${worst.toFixed(3)} m)`);
});

check("onDestroy unsubscribes", () => {
  const { h, inst, step } = boot();
  step(1 / 60, 400);
  inst.onDestroy();
  const before = step().slice();
  h.emit("battlebots.weaponHit", { force: 100000 });
  const after = step();
  near(dist(before, after), 0, 1e-9, "no shake after teardown");
});

// ---- report ------------------------------------------------------------------------

console.log("camera-feel-check — MatchCamera driven against a stubbed engine\n");
for (const r of results) {
  console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name}`);
  if (!r.ok) console.log(`          ${r.why}`);
}
console.log(failed ? `\nFAIL — ${failed} of ${results.length}` : `\nPASS — ${results.length} checks`);
process.exit(failed ? 1 : 0);
