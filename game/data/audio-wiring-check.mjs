/**
 * Drives AudioDirector against a stubbed engine and asserts what it does.
 *
 *   node game/data/audio-wiring-check.mjs
 *
 * WHY THIS EXISTS
 *   `audio-check.js` proves the CLIPS are valid; this proves the WIRING is. Neither
 *   can be checked in the editor: its `audio.*` surface never decodes a byte and
 *   never makes a sound (engine-fixes.md LIM-006), so "it ran without erroring" is
 *   the only signal the engine can give, and that is not a test.
 *
 *   Here the director is imported for real and handed a fake `call` that records
 *   every engine tool it reaches for, plus a fake event bus. Then the match is
 *   played out in miniature — a hit lands, a blade spins up, a bot drives, a bus
 *   moves, the match pauses — and the calls it made are asserted.
 *
 *   The stub deliberately answers the way the real engine does, INCLUDING the
 *   awkward part: `audio.attachSource` resets `playing` to false. If that behaviour
 *   is ever modelled wrongly here the motor-restart assertions stop meaning
 *   anything, so it is asserted directly as well.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const bundle = JSON.parse(readFileSync(join(HERE, "bundle.json"), "utf8"));
const audio = bundle.audio;

// pathToFileURL, not the bare path: this repo lives under a Windows drive letter
// and the ESM loader reads `C:\...` as a URL scheme (T-0.5's cousin).
const create = (await import(pathToFileURL(join(HERE, "..", "scripts", "AudioDirector.ts")).href)).default;

// ---- the stub engine ----------------------------------------------------------

function makeHarness({ withCamera = true, chassis = [] } = {}) {
  const calls = [];
  /** entity -> the AudioSource the engine would be holding */
  const sources = new Map();
  /** clip ids the engine has actually been told about */
  const registered = new Set();
  const names = new Map();
  const bodies = new Map();
  let nextEntity = 9000;

  if (withCamera) names.set(100, "MatchCamera");
  for (const c of chassis) {
    names.set(c.entity, `Bot_${c.role}_Chassis`);
    bodies.set(c.entity, { position: { x: 0, y: 0.3, z: 0 }, linearVelocity: { x: 0, y: 0, z: 0 } });
  }

  const call = (tool, a) => {
    calls.push({ tool, args: a });
    switch (tool) {
      case "project.readFile":
        return { content: { text: JSON.stringify(bundle) } };
      case "audio.loadClip":
        registered.add(a.name);
        return { content: { clip: a.name, loaded: true } };
      case "scene.createEntity": {
        const e = nextEntity++;
        if (a.components && a.components.Name) names.set(e, a.components.Name.value);
        return { content: { entity: e } };
      }
      case "scene.query":
        return { content: { entities: Array.from(names.keys()) } };
      case "scene.getComponent":
        if (a.component === "Name") {
          return names.has(a.entity) ? { content: { value: names.get(a.entity) } } : { isError: true };
        }
        if (a.component === "Transform") {
          return { content: { position: [0, 11, 12], rotation: [-0.3625, 0, 0, 0.932] } };
        }
        return { isError: true };
      case "physics.bodyState":
        return bodies.has(a.entity) ? { content: bodies.get(a.entity) } : { isError: true };
      case "audio.attachSource":
        // The engine will happily attach a source naming a clip that was never
        // registered — no error, it just never plays. That silent failure shipped
        // once; the stub refuses it so it cannot ship again.
        if (!registered.has(a.clip)) {
          throw new Error(`attachSource named unregistered clip "${a.clip}" (registered: ${[...registered].join(", ")})`);
        }
        // The real engine RESETS playing here. Modelling that is the whole point.
        sources.set(a.entity, {
          clip: a.clip, loop: !!a.loop, pitch: a.pitch, volume: a.volume,
          spatial: !!a.spatial, playing: false,
        });
        return { content: {} };
      case "audio.play": {
        const s = sources.get(a.entity);
        if (!s) return { isError: true };
        s.playing = true;
        return { content: {} };
      }
      case "audio.stop": {
        const s = sources.get(a.entity);
        if (!s) return { isError: true };
        s.playing = false;
        return { content: {} };
      }
      case "audio.setVolume": {
        const s = sources.get(a.entity);
        if (!s) return { isError: true };
        s.volume = a.volume;
        return { content: {} };
      }
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
        return () => {
          const list = handlers.get(ch);
          list.splice(list.indexOf(fn), 1);
        };
      },
      emit(ch, p) { for (const fn of handlers.get(ch) || []) fn(p); },
      // audio.loadClip is async-only in the real engine, so the director reaches it
      // through callTool rather than `call`. Model that, including the fact that the
      // result lands a microtask later than onStart returns.
      async callTool(tool, a) { return call(tool, a); },
    },
  };

  return {
    calls, sources, names, bodies, engine, call, handlers,
    emit: (ch, p) => engine.mcp.emit(ch, p),
    of: (tool) => calls.filter((c) => c.tool === tool),
    setVelocity(entity, vx, vz) {
      bodies.get(entity).linearVelocity = { x: vx, y: 0, z: vz };
    },
  };
}

// ---- assertions ---------------------------------------------------------------

let failed = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, why: e.message });
    failed++;
  }
}
function eq(a, b, what) {
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}
function ok(cond, what) {
  if (!cond) throw new Error(what);
}
function near(a, b, tol, what) {
  if (Math.abs(a - b) > tol) throw new Error(`${what}: expected ~${b}, got ${a}`);
}

const CHASSIS = [{ entity: 200, role: "player" }, { entity: 201, role: "opponent" }];
/** master * bus * dynamic, the mix the director is supposed to be applying. */
const CLIP = (name) => "bb_" + name;
const mix = (clip, dyn = 1) =>
  audio.buses.master * audio.buses[audio.clips[clip].bus] * dyn;

async function boot(opts) {
  const h = makeHarness(opts);
  const inst = create();
  inst.onStart({ entity: 1, engine: h.engine, call: h.call });
  // The director gates playback until every clip is registered, and registration is
  // async. Flush the microtask queue so tests observe a director that is actually
  // ready — the same one or two frames the real engine takes.
  await new Promise((r) => setImmediate(r));
  return { h, inst };
}

// T-6.16 — every clip is synthesised and registered.
await check("T-6.16 registers every clip as bb_* with real WAV bytes", async () => {
  const { h } = await boot({ chassis: CHASSIS });
  const loads = h.of("audio.loadClip");
  // Count from the data rather than a literal, so adding a clip does not fail this
  // check for the wrong reason — the point is that every DECLARED clip registers.
  const declared = Object.keys(audio.clips).filter((k) => k[0] !== "$").length;
  eq(loads.length, declared, "clip count");
  for (const l of loads) {
    ok(l.args.name.startsWith("bb_"), `clip ${l.args.name} is namespaced`);
    const b = l.args.source.bytes;
    ok(Array.isArray(b) && b.length > 44, `${l.args.name} has bytes`);
    eq(String.fromCharCode(...b.slice(0, 4)), "RIFF", `${l.args.name} RIFF magic`);
    ok(b.every((x) => Number.isInteger(x) && x >= 0 && x <= 255), `${l.args.name} bytes in range`);
  }
});

// T-6.17 — the voice pool and beds exist, so one-shots never steal a loop.
await check("T-6.17 builds 8 pooled voices + crowd and sting beds", async () => {
  const { h } = await boot({ chassis: CHASSIS });
  const made = h.of("scene.createEntity").map((c) => c.args.components.Name.value);
  eq(made.filter((n) => n.startsWith("AudioVoice_")).length, 8, "voice count");
  ok(made.includes("AudioBed_Crowd"), "crowd bed");
  ok(made.includes("AudioBed_Sting"), "sting bed");
});

// T-6.17 — the listener tracks the camera.
await check("T-6.17 drives the listener from the match camera", async () => {
  const { h, inst } = await boot({ chassis: CHASSIS });
  inst.onUpdate({ call: h.call, dt: 0.016 });
  const l = h.of("audio.setListener");
  ok(l.length > 0, "setListener called");
  const a = l[l.length - 1].args;
  eq(a.position.length, 3, "position is a vec3");
  const f = a.forward;
  near(Math.hypot(f[0], f[1], f[2]), 1, 0.01, "forward is normalised");
  ok(f[2] < 0, "camera at +z looks back toward the origin");
});

// A menu scene has no camera and must not crash or fake a listener.
await check("T-6.17 scene with no camera skips the listener cleanly", async () => {
  const { h, inst } = await boot({ withCamera: false });
  inst.onUpdate({ call: h.call, dt: 0.016 });
  eq(h.of("audio.setListener").length, 0, "no listener calls");
});

// T-6.17 — impacts fire one-shots from the pool, positioned at the contact.
await check("T-6.17 a hit fires impact + spark at the contact point", async () => {
  const { h, inst } = await boot({ chassis: CHASSIS });
  h.emit("battlebots.matchState", { state: "fighting" });
  const before = h.of("audio.attachSource").length;
  h.emit("battlebots.weaponHit", { weapon: 300, victim: 301, force: 4000, point: { x: 1, y: 2, z: 3 } });
  const attached = h.of("audio.attachSource").slice(before);
  const clips = attached.map((c) => c.args.clip);
  // One of the three impact clips, chosen by force and by whether the weapon swings.
  const IMPACTS = [CLIP("impact"), CLIP("impactHeavy"), CLIP("hammerHit")];
  ok(clips.some((c) => IMPACTS.includes(c)), `an impact clip fired, got ${clips.join(",")}`);
  ok(clips.includes(CLIP("spark")), "spark fired");
  const moved = h.of("scene.setComponent").filter((c) => c.args.component === "Transform");
  ok(moved.length >= 2, "voices teleported to the contact point");
  const p = moved[moved.length - 1].args.patch.position;
  ok(p[0] === 1 && p[1] === 2 && p[2] === 3, `voice at contact, got ${p}`);
  ok(attached.every((c) => c.args.spatial === true), "positioned one-shots are spatial");
  ok(attached.every((c) => c.args.loop === false), "one-shots do not loop");
});

// Three impact clips instead of one pitched clank: which metal hit which is
// information a player can act on, and it is easy to regress into "always impact".
await check("T-6.17 the impact clip varies with force and weapon type", async () => {
  const fired = async (force, swingFirst) => {
    const { h } = await boot({ chassis: CHASSIS });
    h.emit("battlebots.matchState", { state: "fighting" });
    if (swingFirst) h.emit("battlebots.weaponSwing", { entity: 300, role: "player", arc: 1 });
    const before = h.of("audio.attachSource").length;
    h.emit("battlebots.weaponHit", { weapon: 300, victim: 301, force, point: { x: 0, y: 0, z: 0 } });
    return h.of("audio.attachSource").slice(before).map((c) => c.args.clip);
  };
  const soft = await fired(1500, false);
  const hard = await fired(9000, false);
  const swung = await fired(1500, true);
  ok(soft.includes(CLIP("impact")), `an ordinary hit uses impact, got ${soft.join(",")}`);
  ok(hard.includes(CLIP("impactHeavy")), `a hard hit uses impactHeavy, got ${hard.join(",")}`);
  ok(swung.includes(CLIP("hammerHit")), `a swing weapon uses hammerHit, got ${swung.join(",")}`);
});

// The event that had no listener at all until AUDIO-GAPS #1.
await check("T-6.17 a weapon swing that misses still makes a sound", async () => {
  const { h } = await boot({ chassis: CHASSIS });
  h.emit("battlebots.matchState", { state: "fighting" });
  const before = h.of("audio.attachSource").length;
  h.emit("battlebots.weaponSwing", { entity: 400, role: "player", arc: 2.1 });
  const clips = h.of("audio.attachSource").slice(before).map((c) => c.args.clip);
  ok(clips.includes(CLIP("swing")), `swing fired, got ${clips.join(",")}`);
});

// A part reaching `destroyed` — the audio half of what VfxDirector already shows.
await check("T-6.17 a destroyed part makes a sound", async () => {
  const { h } = await boot({ chassis: CHASSIS });
  h.emit("battlebots.matchState", { state: "fighting" });
  const before = h.of("audio.attachSource").length;
  h.emit("battlebots.partState", { entity: 500, role: "player", state: "destroyed", category: "wheel" });
  const clips = h.of("audio.attachSource").slice(before).map((c) => c.args.clip);
  ok(clips.includes(CLIP("partBreak")), `partBreak fired, got ${clips.join(",")}`);
});

// A hit under the force floor is not a sound.
await check("T-6.17 a hit below impactMinForceN is silent", async () => {
  const { h } = await boot({ chassis: CHASSIS });
  const before = h.of("audio.attachSource").length;
  h.emit("battlebots.weaponHit", { weapon: 300, victim: 301, force: 10, point: { x: 0, y: 0, z: 0 } });
  eq(h.of("audio.attachSource").length, before, "nothing fired");
});

// T-6.17 — the impact cooldown stops a grinding blade becoming a buzz.
await check("T-6.17 impacts are rate-limited by impactCooldownSeconds", async () => {
  const { h, inst } = await boot({ chassis: CHASSIS });
  const hit = () => h.emit("battlebots.weaponHit", { weapon: 300, victim: 301, force: 5000, point: { x: 0, y: 0, z: 0 } });
  const before = h.of("audio.attachSource").length;
  for (let i = 0; i < 10; i++) hit();                    // ten contacts, same instant
  const after = h.of("audio.attachSource").length;
  eq(after - before, 2, "exactly one impact+spark pair got through");
  // ...and after the cooldown elapses, the next one does.
  for (let i = 0; i < 12; i++) inst.onUpdate({ call: h.call, dt: 0.016 });
  hit();
  ok(h.of("audio.attachSource").length > after, "fires again once cooled");
});

// T-6.18 — the blade is pitched by how fast it is actually turning.
await check("T-6.18 blade pitch tracks spinFraction across its range", async () => {
  const { h } = await boot({ chassis: CHASSIS });
  const t = audio.tuning;
  h.emit("battlebots.weaponState", { entity: 400, role: "player", state: "spinning", spinFraction: 0 });
  h.emit("battlebots.weaponState", { entity: 400, role: "player", state: "spinning", spinFraction: 1 });
  const full = h.of("audio.attachSource").filter((c) => c.args.entity === 400).pop();
  near(full.args.pitch, t.spinPitchMax, 0.001, "full-speed pitch");
  eq(full.args.clip, CLIP("spin"), "spin clip");
  eq(full.args.loop, true, "blade loops");
  eq(full.args.spatial, true, "blade is spatial");
  ok(h.sources.get(400).playing, "blade is actually playing");
});

// A passive wedge reports rpm 0 forever and must never open a voice.
await check("T-6.18 a passive weapon never opens a voice", async () => {
  const { h } = await boot({ chassis: CHASSIS });
  h.emit("battlebots.weaponState", { entity: 401, role: "player", state: "idle", spinFraction: 0 });
  eq(h.of("audio.attachSource").filter((c) => c.args.entity === 401).length, 0, "no source");
});

// T-6.18 — a jammed blade shuts up.
await check("T-6.18 a jammed blade stops", async () => {
  const { h } = await boot({ chassis: CHASSIS });
  h.emit("battlebots.weaponState", { entity: 400, role: "player", state: "spinning", spinFraction: 1 });
  ok(h.sources.get(400).playing, "spinning first");
  h.emit("battlebots.weaponState", { entity: 400, role: "player", state: "jammed", spinFraction: 0.9 });
  eq(h.sources.get(400).playing, false, "stopped when jammed");
});

// T-6.18 — the motor bed is pitched by road speed, and keeps playing while it is.
await check("T-6.18 motor pitch tracks road speed and the loop survives it", async () => {
  const { h, inst } = await boot({ chassis: CHASSIS });
  const t = audio.tuning;
  inst.onUpdate({ call: h.call, dt: 0.016 });
  const idle = h.of("audio.attachSource").filter((c) => c.args.entity === 200).pop();
  near(idle.args.pitch, t.motorPitchMin, 0.001, "idle pitch");
  ok(h.sources.get(200).playing, "motor playing at idle");

  h.setVelocity(200, t.motorSpeedForMaxPitch, 0);
  for (let i = 0; i < 3; i++) inst.onUpdate({ call: h.call, dt: 0.016 });
  const fast = h.of("audio.attachSource").filter((c) => c.args.entity === 200).pop();
  near(fast.args.pitch, t.motorPitchMax, 0.001, "full-speed pitch");
  // The re-attach reset `playing`; the director has to have noticed and replayed it.
  ok(h.sources.get(200).playing, "motor still playing after a pitch change");
});

// The reason pitch is quantised at all: attachSource is expensive and resets playback.
await check("T-6.18 tiny speed changes do not churn attachSource", async () => {
  const { h, inst } = await boot({ chassis: CHASSIS });
  inst.onUpdate({ call: h.call, dt: 0.016 });
  const before = h.of("audio.attachSource").filter((c) => c.args.entity === 200).length;
  // Nudge the speed by far less than PITCH_EPSILON is worth, many times.
  for (let i = 0; i < 30; i++) {
    h.setVelocity(200, 0.001 * i, 0);
    inst.onUpdate({ call: h.call, dt: 0.016 });
  }
  const after = h.of("audio.attachSource").filter((c) => c.args.entity === 200).length;
  eq(after, before, "no redundant re-attaches");
});

// T-6.19 — the room reacts: hits raise the crowd, quiet lets it fall back.
await check("T-6.19 crowd rises with hits and decays back toward the floor", async () => {
  const { h, inst } = await boot({ chassis: CHASSIS });
  h.emit("battlebots.matchState", { state: "fighting" });
  const bed = [...h.names.entries()].find(([, n]) => n === "AudioBed_Crowd")[0];
  ok(h.sources.get(bed).playing, "crowd bed running once fighting");

  for (let i = 0; i < 40; i++) {
    h.emit("battlebots.weaponHit", { weapon: 300, victim: 301, force: 6000, point: null });
    inst.onUpdate({ call: h.call, dt: 0.05 });
  }
  const loud = h.sources.get(bed).volume;

  for (let i = 0; i < 200; i++) inst.onUpdate({ call: h.call, dt: 0.05 });
  const quiet = h.sources.get(bed).volume;
  ok(loud > quiet, `crowd fell back after the fighting stopped (${loud.toFixed(3)} -> ${quiet.toFixed(3)})`);
  near(quiet, mix("crowd", audio.tuning.crowdBaseVolume), 0.02, "settles at the base level");
});

// T-6.19 — a bot near death lifts the floor.
await check("T-6.19 near-knockout health raises the crowd floor", async () => {
  const { h, inst } = await boot({ chassis: CHASSIS });
  h.emit("battlebots.matchState", { state: "fighting" });
  const bed = [...h.names.entries()].find(([, n]) => n === "AudioBed_Crowd")[0];
  for (let i = 0; i < 200; i++) inst.onUpdate({ call: h.call, dt: 0.05 });
  const calm = h.sources.get(bed).volume;

  h.emit("battlebots.damageReport", {
    parts: [
      { role: "player", hp: 5, maxHp: 100 },      // all but dead
      { role: "opponent", hp: 90, maxHp: 100 },
    ],
  });
  for (let i = 0; i < 200; i++) inst.onUpdate({ call: h.call, dt: 0.05 });
  const tense = h.sources.get(bed).volume;
  ok(tense > calm, `room tightens near a knockout (${calm.toFixed(3)} -> ${tense.toFixed(3)})`);
  near(tense, mix("crowd", audio.tuning.crowdBaseVolume + audio.tuning.crowdNearKnockoutBoost), 0.02,
    "settles at base + boost");
});

// T-6.19 — the knockout sting.
await check("T-6.19 a knockout plays the descending sting", async () => {
  const { h } = await boot({ chassis: CHASSIS });
  h.emit("battlebots.knockout", { role: "opponent", reason: "immobilised" });
  const sting = h.of("audio.attachSource").filter((c) => c.args.clip === CLIP("ko")).pop();
  ok(sting, "ko clip fired");
  eq(sting.args.spatial, false, "sting is not spatialised");
});

// T-6.20 — the mix is master * bus * clip, and per-bus control is live.
await check("T-6.20 volumes follow master * bus, and setBus moves them live", async () => {
  const { h, inst } = await boot({ chassis: CHASSIS });
  h.emit("battlebots.matchState", { state: "fighting" });
  const bed = [...h.names.entries()].find(([, n]) => n === "AudioBed_Crowd")[0];
  for (let i = 0; i < 200; i++) inst.onUpdate({ call: h.call, dt: 0.05 });
  near(h.sources.get(bed).volume, mix("crowd", audio.tuning.crowdBaseVolume), 0.02, "default crowd level");

  h.emit("battlebots.setBus", { bus: "crowd", volume: 1 });
  for (let i = 0; i < 200; i++) inst.onUpdate({ call: h.call, dt: 0.05 });
  const raised = h.sources.get(bed).volume;
  near(raised, audio.buses.master * 1 * audio.tuning.crowdBaseVolume, 0.02, "crowd bus raised to unity");

  h.emit("battlebots.setBus", { bus: "crowd", volume: 0 });
  for (let i = 0; i < 200; i++) inst.onUpdate({ call: h.call, dt: 0.05 });
  near(h.sources.get(bed).volume, 0, 0.001, "crowd bus muted");
});

// The invariant, not the implementation: whatever a slider sends, no voice may be
// asked for a volume outside 0..1. Two independent clamps guarantee this — one in
// `setBus`, one in `mix` — so removing either alone is still safe and this check
// only fails when the last line of defence goes. That redundancy is deliberate;
// the assertion is written against the property rather than against either clamp.
await check("T-6.20 no bus value can push a voice outside 0..1", async () => {
  const bed = (h) => [...h.names.entries()].find(([, n]) => n === "AudioBed_Crowd")[0];
  for (const v of [99, -5, 1e9]) {
    const { h, inst } = await boot({ chassis: CHASSIS });
    h.emit("battlebots.matchState", { state: "fighting" });
    h.emit("battlebots.setBus", { bus: "crowd", volume: v });
    for (let i = 0; i < 200; i++) inst.onUpdate({ call: h.call, dt: 0.05 });
    const got = h.sources.get(bed(h)).volume;
    ok(got >= 0 && got <= 1, `bus=${v} produced volume ${got}`);
    for (const c of h.of("audio.setVolume")) {
      ok(c.args.volume >= 0 && c.args.volume <= 1, `bus=${v} sent setVolume ${c.args.volume}`);
    }
    for (const c of h.of("audio.attachSource")) {
      ok(c.args.volume >= 0 && c.args.volume <= 1, `bus=${v} attached at volume ${c.args.volume}`);
    }
  }
});

// Pause ducks everything and resume brings the room back.
await check("pause stops every voice; resume restores the crowd", async () => {
  const { h, inst } = await boot({ chassis: CHASSIS });
  h.emit("battlebots.matchState", { state: "fighting" });
  inst.onUpdate({ call: h.call, dt: 0.016 });
  h.emit("battlebots.weaponState", { entity: 400, role: "player", state: "spinning", spinFraction: 1 });
  ok([...h.sources.values()].some((s) => s.playing), "something was playing");

  h.emit("battlebots.paused", { paused: true });
  ok([...h.sources.values()].every((s) => !s.playing), "everything stopped");

  // A paused match must not start new sounds either.
  const before = h.of("audio.attachSource").length;
  h.emit("battlebots.weaponHit", { weapon: 300, victim: 301, force: 9000, point: { x: 0, y: 0, z: 0 } });
  eq(h.of("audio.attachSource").length, before, "no one-shots while paused");

  h.emit("battlebots.paused", { paused: false });
  const bed = [...h.names.entries()].find(([, n]) => n === "AudioBed_Crowd")[0];
  ok(h.sources.get(bed).playing, "crowd came back");
});

// Debris is culled constantly; a stale voice would leak.
await check("culled debris drops its cached source state", async () => {
  const { h } = await boot({ chassis: CHASSIS });
  h.emit("battlebots.weaponState", { entity: 400, role: "player", state: "spinning", spinFraction: 1 });
  h.emit("battlebots.debrisCulled", { entity: 400 });
  const before = h.of("audio.attachSource").length;
  h.emit("battlebots.weaponState", { entity: 400, role: "player", state: "spinning", spinFraction: 1 });
  ok(h.of("audio.attachSource").length > before, "re-attaches rather than trusting stale state");
});

await check("onDestroy unsubscribes and deletes every entity it made", async () => {
  const { h, inst } = await boot({ chassis: CHASSIS });
  const made = h.of("scene.createEntity").length;
  inst.onDestroy({ call: h.call });
  eq(h.of("scene.deleteEntity").length, made, "deleted as many as it created");
  const before = h.of("audio.attachSource").length;
  h.emit("battlebots.weaponHit", { weapon: 300, victim: 301, force: 9000, point: { x: 0, y: 0, z: 0 } });
  eq(h.of("audio.attachSource").length, before, "handlers are detached");
});

// A director dropped into a scene with no bundle must degrade, not throw.
await check("a missing bundle disables the director instead of throwing", async () => {
  const h = makeHarness({});
  const call = (tool, a) => (tool === "project.readFile" ? { isError: true } : h.call(tool, a));
  const inst = create();
  inst.onStart({ entity: 1, engine: h.engine, call });
  inst.onUpdate({ call, dt: 0.016 });
  eq(h.of("audio.loadClip").length, 0, "nothing registered");
});

// The gate the engine forced: audio.loadClip is async, so there is a window after
// onStart where the clips are not registered yet. Attaching in that window would
// name a source after a clip that does not exist.
await check("nothing is attached before clip registration completes", async () => {
  const h = makeHarness({ chassis: CHASSIS });
  const inst = create();
  inst.onStart({ entity: 1, engine: h.engine, call: h.call });
  // deliberately NOT flushing — this is the pre-registration window
  h.emit("battlebots.matchState", { state: "fighting" });
  h.emit("battlebots.weaponHit", { weapon: 300, victim: 301, force: 9000, point: { x: 0, y: 0, z: 0 } });
  h.emit("battlebots.weaponState", { entity: 400, role: "player", state: "spinning", spinFraction: 1 });
  inst.onUpdate({ call: h.call, dt: 0.016 });
  eq(h.of("audio.attachSource").length, 0, "no sources attached before ready");

  // ...and once registration lands, the same events do work.
  await new Promise((r) => setImmediate(r));
  h.emit("battlebots.weaponState", { entity: 400, role: "player", state: "spinning", spinFraction: 1 });
  ok(h.of("audio.attachSource").length > 0, "attaches once ready");
});

// ---- report -------------------------------------------------------------------

console.log(`audio-wiring-check — AudioDirector driven against a stubbed engine\n`);
for (const r of results) {
  console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name}`);
  if (!r.ok) console.log(`          ${r.why}`);
}
console.log(failed ? `\nFAIL — ${failed} of ${results.length}` : `\nPASS — ${results.length} checks`);
process.exit(failed ? 1 : 0);
