/**
 * AudioDirector — the whole audio pass. (T-6.16 – T-6.20)
 *
 * Attach to one marker entity per scene (Name `AudioDirector`). Like VfxDirector it
 * owns nothing and queries almost nothing: it listens on the `battlebots.*` channels
 * that already exist and can be deleted from a scene without touching gameplay.
 *
 *   battlebots.matchState    -> crowd bed in/out                        (T-6.19)
 *   battlebots.weaponHit     -> impact + spark one-shots, crowd energy  (T-6.17)
 *   battlebots.partDetached  -> the loudest one-shot in the game        (T-6.17)
 *   battlebots.weaponState   -> blade loop, pitched by real rpm         (T-6.18)
 *   battlebots.damageReport  -> health, for the near-knockout shift     (T-6.19)
 *   battlebots.knockout      -> the descending sting
 *   battlebots.paused        -> duck the whole mix
 *   battlebots.botSelected   -> UI click (menu scenes)
 *   battlebots.setBus        -> live per-bus volume, for the options panel (T-6.20)
 *
 * EVERY SOUND IS SYNTHESISED AT LOAD (T-6.16)
 *   There is no sourced audio and no audio file in the build. `buildWav` below turns
 *   the numbers in `data/audio.json` into 16-bit PCM WAV bytes and hands them to
 *   `audio.loadClip`. The reasoning is in audio.json: the visuals are untextured
 *   primitives, so untextured waveforms read as one deliberate style rather than as
 *   placeholder, the build stays tiny, and the entire mix is tunable without a
 *   recompile. It also makes the audio pass reproducible — the synth is seeded, so
 *   the same JSON always produces byte-identical clips.
 *
 * ONE AUDIOSOURCE PER ENTITY
 *   `AudioSource` is a component, so an entity carries at most one — the same
 *   constraint `ParticleEmitter` puts on VfxDirector, and it shapes this file:
 *
 *     - Loops that belong to a thing ride that thing. The motor bed sits on the bot
 *       chassis, the blade loop on the weapon entity. They are spatial, so they pan
 *       and attenuate for free.
 *     - One-shots CANNOT ride the part they belong to — a spinner hitting a plate
 *       would cut its own blade loop. They come from a small round-robin pool of
 *       voice entities that are teleported to the contact point before playing.
 *       Eight is enough that a voice is never stolen mid-impact at the cooldown
 *       T-6.18 imposes, and it is a fixed cost paid once at scene start.
 *     - Non-spatial beds (crowd, stings, UI) get their own dedicated entities.
 *
 * WHY PITCH UPDATES ARE QUANTISED
 *   The engine exposes no `setPitch`. Pitch can only be written by re-issuing
 *   `audio.attachSource`, and doing that RESETS `playing` to false — so every pitch
 *   change costs a re-attach plus a re-play, and a naive per-frame update would
 *   restart the motor loop sixty times a second. Pitch is therefore only rewritten
 *   when it moves more than `PITCH_EPSILON`, which turns a continuous ramp into a
 *   few steps per second. This is the same change-detection discipline
 *   WeaponController uses to keep its own event stream cheap.
 *
 * WHAT IS NOT VERIFIABLE FROM THE EDITOR
 *   The editor profile's `audio.*` surface is bookkeeping, not playback: it records
 *   AudioSource components and clip registrations for a runtime build to honour, but
 *   it never decodes bytes and never makes a sound. `loaded: true` means
 *   "registered", not "valid" — five bytes of junk and a dead URL both report it.
 *   So the wiring here is verified in the editor and the WAV bytes are verified
 *   numerically by `game/data/audio-check.js`, which extracts the SYNTH block below
 *   verbatim rather than copying it. Audible confirmation needs the runtime build.
 *   See engine-fixes.md LIM-006.
 */

const BUNDLE_PATH = "/data/bundle.json";

/**
 * Clips are registered under a namespaced id so this director cannot collide with
 * anything else that registers audio. `audio.json` keys stay bare — the bundle is
 * the mix, `clipId` is the engine's name for the same thing — and EVERY engine call
 * goes through this, because passing a bare name to `attachSource` silently produces
 * a source pointing at a clip that was never registered: it attaches, reports no
 * error, and simply never plays.
 */
function clipId(name) { return "bb_" + name; }

/** Pitch must move by more than this before it is worth a re-attach + re-play. */
const PITCH_EPSILON = 0.035;
/** Round-robin one-shot voices. See "ONE AUDIOSOURCE PER ENTITY" above. */
const VOICE_COUNT = 8;

/* ------------------------------------------------------------------ SYNTH:BEGIN
 * Pure and dependency-free on purpose: `game/data/audio-check.js` extracts
 * everything between these markers and runs it in Node to validate the bytes this
 * script will ship. Do not close over anything outside this block.
 */

/**
 * Deterministic noise. `Math.random` would make every load a different build and
 * defeat the byte-identical property the check harness relies on, so this is a
 * plain 32-bit LCG seeded per clip from its name.
 */
function makeRng(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296 * 2 - 1;               // -1..1
  };
}

function seedFromName(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Render one clip spec to mono float samples in -1..1.
 *
 * kinds:
 *   saw    buzzy periodic — motors and blades. `harmonic` adds a partial, `noise`
 *          blends in grit so a motor sounds loaded rather than synthetic.
 *   noise  broadband. `bright` differentiates (high-pass, for sparks), `smooth`
 *          runs a moving average (low-pass, for the crowd bed).
 *   clank  noise burst plus a ringing partial — metal. `noise` sets the ratio.
 *   sweep  a glide from `freq` to `freqTo`, for stings.
 *
 * Loop clips are built to be seamless, by whichever of two routes fits. Anything
 * with a frequency is truncated to a whole number of cycles, so the wrap lands
 * exactly where a cycle boundary would have — for a sawtooth that is a full-range
 * jump, and correctly so. The crowd bed has no frequency to align to, so it is
 * rendered past its end and the overhang is folded back over the head.
 */
function renderClip(name, spec, sampleRate) {
  const kind = spec.kind;
  const loop = !!spec.loop;
  const freq = typeof spec.freq === "number" ? spec.freq : 0;
  let n = Math.max(1, Math.round(sampleRate * spec.seconds));

  // Seamless loops: land the wrap on a whole cycle.
  if (loop && freq > 0) {
    const perCycle = sampleRate / freq;
    const cycles = Math.max(1, Math.round(n / perCycle));
    n = Math.max(1, Math.round(cycles * perCycle));
  }

  // A loop with no frequency to align to (the crowd bed) is made seamless by
  // rendering PAST the end and folding that overhang back over the head, so the
  // samples either side of the wrap are genuinely continuous. Rendering exactly `n`
  // and crossfading in place does not work: it leaves out[n-1] -> out[0] untouched,
  // which is the one join that matters.
  const xfade = loop && !(freq > 0)
    ? Math.min(Math.floor(n / 8), Math.floor(sampleRate * 0.08))
    : 0;
  const total = n + xfade;

  const rng = makeRng(seedFromName(name));
  const out = new Float64Array(total);
  const decay = typeof spec.decay === "number" ? spec.decay : 0;
  const noiseAmt = typeof spec.noise === "number" ? spec.noise : 0;

  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    let v = 0;

    if (kind === "saw") {
      // Naive ramp. Aliasing is audible only well above these frequencies, and a
      // little of it is what makes a motor read as a motor.
      const phase = (t * freq) % 1;
      v = phase * 2 - 1;
      if (spec.harmonic) {
        const hp = (t * freq * spec.harmonic) % 1;
        v = v * 0.7 + (hp * 2 - 1) * 0.3;
      }
      if (noiseAmt) v = v * (1 - noiseAmt) + rng() * noiseAmt;
    } else if (kind === "noise") {
      v = rng();
    } else if (kind === "clank") {
      // The strike is broadband; the ring is what tells you it was metal.
      const ring = Math.sin(2 * Math.PI * freq * t) * 0.6
                 + Math.sin(2 * Math.PI * freq * 2.71 * t) * 0.4;   // inharmonic partial
      v = ring * (1 - noiseAmt) + rng() * noiseAmt;
    } else if (kind === "sweep") {
      const to = typeof spec.freqTo === "number" ? spec.freqTo : freq;
      const frac = total > 1 ? i / (total - 1) : 0;
      // Integrate the linear frequency ramp rather than stepping the frequency per
      // sample: phase = 2pi*(f0*t + (f1-f0)*t^2/2T). Writing sin(2pi*f(t)*t) instead
      // is the classic chirp bug — the phase jumps every sample and it buzzes.
      const phase = 2 * Math.PI * (freq * t + (to - freq) * (t * frac) / 2);
      v = Math.sin(phase);
    }

    if (decay > 0) v *= Math.exp(-decay * t);
    out[i] = v;
  }

  // Post filters, run across the overhang too so the filter state either side of
  // the fold matches.
  if (kind === "noise" && spec.smooth) {
    // Moving average -> low-pass. A raw white bed is hiss; the crowd needs body.
    const w = 24;
    const smoothed = new Float64Array(total);
    let acc = 0;
    for (let i = 0; i < total; i++) {
      acc += out[i];
      if (i >= w) acc -= out[i - w];
      smoothed[i] = acc / Math.min(w, i + 1);
    }
    for (let i = 0; i < total; i++) out[i] = smoothed[i] * 3.2;   // recover the level the average ate
  }
  if (kind === "noise" && spec.bright) {
    // First difference -> high-pass. Sparks are all top end.
    for (let i = total - 1; i > 0; i--) out[i] = out[i] - out[i - 1];
    out[0] = 0;
  }

  if (loop) {
    // Fold the overhang back over the head. out[n + i] is the natural continuation
    // of out[n - 1], so after this the wrap is continuous by construction.
    // Pitched loops need none of this — they were truncated to whole cycles above,
    // and a sawtooth's wrap is the same jump it already makes once per cycle.
    for (let i = 0; i < xfade; i++) {
      const k = i / xfade;
      out[i] = out[i] * k + out[n + i] * (1 - k);
    }
  } else {
    // One-shots get short ramps at both ends. A waveform that starts or stops on a
    // non-zero sample clicks, and a click on top of an impact just sounds broken.
    const a = Math.min(Math.floor(sampleRate * 0.002), Math.floor(n / 2));
    for (let i = 0; i < a; i++) { out[i] *= i / a; out[n - 1 - i] *= i / a; }
  }

  // Apply the clip's own gain, then hard-limit. Clipping here would be a bug in the
  // numbers, so the limiter is a guard rail rather than part of the sound.
  const gain = typeof spec.gain === "number" ? spec.gain : 1;
  const res = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let v = out[i] * gain;
    if (v > 1) v = 1; else if (v < -1) v = -1;
    res[i] = v;
  }
  return res;   // the overhang is scaffolding; it never ships
}

/** Wrap mono float samples as a 16-bit PCM WAV byte array. */
function toWavBytes(samples, sampleRate) {
  const n = samples.length;
  const bytes = new Array(44 + n * 2);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i) & 255; };
  const u32 = (o, v) => { bytes[o] = v & 255; bytes[o + 1] = (v >> 8) & 255; bytes[o + 2] = (v >> 16) & 255; bytes[o + 3] = (v >> 24) & 255; };
  const u16 = (o, v) => { bytes[o] = v & 255; bytes[o + 1] = (v >> 8) & 255; };

  str(0, "RIFF"); u32(4, 36 + n * 2); str(8, "WAVE");
  str(12, "fmt "); u32(16, 16); u16(20, 1); u16(22, 1);
  u32(24, sampleRate); u32(28, sampleRate * 2); u16(32, 2); u16(34, 16);
  str(36, "data"); u32(40, n * 2);

  for (let i = 0; i < n; i++) {
    let v = Math.round(samples[i] * 32767);
    if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
    if (v < 0) v += 65536;
    bytes[44 + i * 2] = v & 255;
    bytes[44 + i * 2 + 1] = (v >> 8) & 255;
  }
  return bytes;
}

function buildWav(name, spec, sampleRate) {
  return toWavBytes(renderClip(name, spec, sampleRate), sampleRate);
}

/* -------------------------------------------------------------------- SYNTH:END */

/* ── WebAudio output ─────────────────────────────────────────────────────────
 *
 * The engine's `audio.*` surface records AudioSource state and never makes a sound —
 * in the editor and in a deployed build alike (engine-fixes.md LIM-006). So this
 * director drives WebAudio itself, and the engine calls are kept for what they are
 * genuinely good for: they are the declarative state of record, they are what a real
 * backend would honour if one ever ships, and they are what `audio-wiring-check.mjs`
 * asserts against. Every gain and pitch below is the same number handed to the
 * engine, computed once, so the two paths cannot disagree.
 *
 * If the engine ever grows a working backend, delete one of the two. Two live outputs
 * would double every sound.
 *
 * WHY THIS IS MODULE SCOPE AND NOT PER-INSTANCE
 *   There is one AudioDirector per scene, and scenes change constantly — menu, select,
 *   arena, post-match. An AudioContext owned by the director would be closed and
 *   rebuilt on every one of those transitions, and a fresh context starts SUSPENDED:
 *   the browser only resumes one on a user gesture, so audio would work on the first
 *   screen and be silent for the rest of the session. The context, the bus graph and
 *   the decoded buffers therefore live here, shared by every instance and built once.
 *   Only the live voices are per-instance, because those really do belong to a scene.
 */
let actx = null;
let masterGain = null;
const busGain = new Map();          // bus name -> GainNode
const buffers = new Map();          // clip name -> AudioBuffer
let gestureHooked = false;

/**
 * Build the graph: source -> [panner] -> voice gain -> bus gain -> master -> out.
 *
 * Buses are real nodes rather than arithmetic so a bus mute is genuinely instant
 * instead of waiting for every live voice to notice on its next update.
 */
function waInit(engine, busNames) {
  if (actx) return true;
  const Ctx = (typeof globalThis !== "undefined")
    && (globalThis.AudioContext || globalThis.webkitAudioContext);
  if (!Ctx) return false;
  try {
    actx = new Ctx();
    masterGain = actx.createGain();
    masterGain.gain.value = 1;
    masterGain.connect(actx.destination);
    for (const name of busNames) {
      if (name === "master") continue;
      const g = actx.createGain();
      g.gain.value = 1;            // bus level is folded into voice gain by mix()
      g.connect(masterGain);
      busGain.set(name, g);
    }
  } catch (err) {
    actx = null;
    engine.console.log("[Audio] WebAudio unavailable: " + err);
    return false;
  }

  // A browser will not start an AudioContext without a user gesture, and the game
  // opens on a menu that has to be clicked anyway. Resume on the first input of any
  // kind rather than guessing which, and unhook once it takes.
  if (!gestureHooked && typeof document !== "undefined" && document.addEventListener) {
    gestureHooked = true;
    const unhook = () => {
      document.removeEventListener("pointerdown", wake, true);
      document.removeEventListener("keydown", wake, true);
    };
    // Unhook only once the context is genuinely RUNNING, never merely because a
    // gesture happened. `resume()` is a promise and can be refused — a click during
    // page load, before the context exists, is the ordinary case — and a handler that
    // removes itself on the first attempt would leave the game permanently silent
    // with no way back. Cheap to leave armed: it costs one no-op call per input until
    // it takes, and then it is gone.
    const wake = () => {
      if (!actx) return;
      if (actx.state === "running") { unhook(); return; }
      const done = actx.resume();
      if (done && done.then) done.then(() => { if (actx && actx.state === "running") unhook(); }, () => {});
      else if (actx.state === "running") unhook();
    };
    document.addEventListener("pointerdown", wake, true);
    document.addEventListener("keydown", wake, true);
  }
  return true;
}

/**
 * Turn a clip's samples straight into an AudioBuffer.
 *
 * No WAV round trip: `renderClip` already produces the float samples `buildWav` would
 * wrap in a header for the engine to ignore, so encoding them only to hand them to
 * `decodeAudioData` would be two conversions back to where we started. The WAV path
 * still exists for `audio.loadClip` and for `audio-check.js`, which validates the
 * bytes a real backend would be given.
 */
function waBuffer(name, spec, sr) {
  if (!actx) return null;
  if (buffers.has(name)) return buffers.get(name);
  try {
    const samples = renderClip(name, spec, sr);
    const buf = actx.createBuffer(1, samples.length, sr);
    const ch = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) ch[i] = samples[i];
    buf.copyToChannel(ch, 0);
    buffers.set(name, buf);
    return buf;
  } catch (err) {
    return null;
  }
}

/**
 * Upgrade a clip from its synthesised fallback to the sourced recording.
 *
 * Deliberately fire-and-forget and deliberately late. Synthesis has already put a
 * usable buffer in place, so the game is audible on the first frame and nothing here
 * can make it silent: a 404, a decode failure, a format the browser will not take, or
 * no network at all simply leaves the synthesised version in the map. That is why the
 * synth specs are maintained for every clip that has a file — the fallback has to be
 * a real sound, not an empty slot.
 *
 * `decodeAudioData` is the right call here, unlike in `waBuffer`: an mp3 is compressed
 * bytes we did not generate, so there is genuinely something to decode.
 */
function waLoadFile(name, url, engine) {
  if (!actx) return Promise.resolve(false);
  return fetch(url)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error("HTTP " + r.status))))
    .then((bytes) => actx.decodeAudioData(bytes))
    .then((buf) => {
      // Voices already playing keep the buffer they started with; the swap takes
      // effect the next time a voice is created. A motor bed started in the first
      // second will therefore stay synthesised until the scene changes, which is a
      // better trade than cutting a running loop to substitute it.
      buffers.set(name, buf);
      return true;
    })
    .catch((err) => {
      engine.console.log("[Audio] " + name + " kept the synthesised version (" + err.message + ")");
      return false;
    });
}

function waNode(clipName, spatial, pitch, volume, bus) {
  const buf = buffers.get(clipName);
  if (!actx || !buf) return null;
  const source = actx.createBufferSource();
  source.buffer = buf;
  source.playbackRate.value = pitch;
  const gain = actx.createGain();
  gain.gain.value = volume;
  let panner = null;
  if (spatial && actx.createPanner) {
    panner = actx.createPanner();
    panner.panningModel = "equalpower";   // cheap, and the arena is only 12 m across
    panner.distanceModel = "inverse";
    panner.refDistance = 4;
    panner.maxDistance = 40;
    source.connect(panner);
    panner.connect(gain);
  } else {
    source.connect(gain);
  }
  gain.connect(busGain.get(bus) || masterGain);
  return { src: source, gain, panner };
}

function waMoveTo(node, point) {
  if (!node || !node.panner || !point) return;
  const x = point.x !== undefined ? point.x : point[0] || 0;
  const y = point.y !== undefined ? point.y : point[1] || 0;
  const z = point.z !== undefined ? point.z : point[2] || 0;
  if (node.panner.positionX) {
    node.panner.positionX.value = x;
    node.panner.positionY.value = y;
    node.panner.positionZ.value = z;
  } else if (node.panner.setPosition) {
    node.panner.setPosition(x, y, z);
  }
}

function waListener(pos, fwd) {
  if (!actx || !actx.listener) return;
  const l = actx.listener;
  if (l.positionX) {
    l.positionX.value = pos[0]; l.positionY.value = pos[1]; l.positionZ.value = pos[2];
    if (l.forwardX) {
      l.forwardX.value = fwd[0]; l.forwardY.value = fwd[1]; l.forwardZ.value = fwd[2];
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    }
  } else if (l.setPosition) {
    l.setPosition(pos[0], pos[1], pos[2]);
    if (l.setOrientation) l.setOrientation(fwd[0], fwd[1], fwd[2], 0, 1, 0);
  }
}

function waSetBusLevel(bus, level, master) {
  if (bus === "master") { if (masterGain) masterGain.gain.value = master; return; }
  // Bus level is already folded into every voice gain by mix(), so the node sits at 1
  // and only drops for an outright mute — which should be immediate.
  if (busGain.has(bus)) busGain.get(bus).gain.value = level > 0 ? 1 : 0;
}

export default function create() {
  let audio = null;              // the audio block out of the bundle
  let tune = null;
  let buses = null;              // live bus levels, mutable via battlebots.setBus
  /** False until every clip is registered. Nothing may be attached before then. */
  let ready = false;
  const offs = [];

  // Live voices belong to the scene, so they are the one part of the WebAudio path
  // that is per-instance. The context, buses and buffers are shared — see the module
  // scope block above for why.
  /** entity -> { src, gain, panner, clip, pitch } for a LOOPING voice. */
  const waVoices = new Map();

  /** Start or retune a LOOPING voice on an entity. */
  function waLoop(entity, clipName, pitch, volume, spatial) {
    if (!actx) return;
    const live = waVoices.get(entity);
    if (live && live.clip === clipName) {
      // Retuning beats restarting: a motor changing pitch should bend, not stutter.
      live.gain.gain.value = volume;
      live.src.playbackRate.value = pitch;
      live.pitch = pitch;
      return;
    }
    if (live) waStop(entity);
    const spec = audio.clips[clipName];
    if (!spec) return;
    const node = waNode(clipName, spatial, pitch, volume, spec.bus);
    if (!node) return;
    node.src.loop = true;
    try { node.src.start(); } catch (err) { return; }
    node.clip = clipName;
    node.pitch = pitch;
    waVoices.set(entity, node);
  }

  function waStop(entity) {
    const live = waVoices.get(entity);
    if (!live) return;
    try { live.src.stop(); } catch (err) { /* already ended */ }
    try {
      live.src.disconnect(); live.gain.disconnect();
      if (live.panner) live.panner.disconnect();
    } catch (err) {}
    waVoices.delete(entity);
  }

  function waVolume(entity, volume) {
    const live = waVoices.get(entity);
    if (live) live.gain.gain.value = volume;
  }

  /** Fire and forget. The node graph is disposable and tears itself down on end. */
  function waOneShot(clipName, point, volume, pitch) {
    if (!actx) return;
    const spec = audio.clips[clipName];
    if (!spec) return;
    const node = waNode(clipName, !!point, pitch, volume, spec.bus);
    if (!node) return;
    waMoveTo(node, point);
    node.src.onended = () => {
      try {
        node.src.disconnect(); node.gain.disconnect();
        if (node.panner) node.panner.disconnect();
      } catch (err) {}
    };
    try { node.src.start(); } catch (err) {}
  }

  /**
   * Scene teardown stops this scene's voices and NOTHING else. The context and the
   * decoded buffers deliberately survive: closing them here is what made audio work
   * on the first screen and go silent for the rest of the session.
   */
  function waTeardown() {
    for (const e of Array.from(waVoices.keys())) waStop(e);
  }

  /** Pooled one-shot voice entities, and the next one to steal. */
  let voices = [];
  let nextVoice = 0;
  /** Dedicated non-spatial beds: crowd + stings/UI. */
  let crowdEnt = 0;
  let stingEnt = 0;

  /** entity -> { clip, pitch, volume, playing } we last wrote, to avoid redundant calls. */
  const srcState = new Map();
  /** chassis entity -> role, learned lazily. */
  let chassis = [];
  let rescan = 0;

  /** role -> last known health fraction, from damageReport. (T-6.19) */
  const health = new Map();
  let crowdLevel = 0;
  let crowdTarget = 0;
  let impactCool = 0;
  let paused = false;
  /** Weapons seen to swing, so a connecting hit can pick the right impact clip. */
  const swingWeapons = new Set();
  let listenerEnt = 0;
  let started = false;

  // ---------------------------------------------------------------- mix (T-6.20)

  /**
   * The mix in one place: master * bus * the clip's own gain * any per-voice
   * dynamic. Buses are the mix; clip gain is the balance inside a bus. Nothing else
   * in this file is allowed to invent a volume.
   */
  function mix(clipName, dynamic) {
    const clip = audio.clips[clipName];
    if (!clip) return 0;
    const bus = buses[clip.bus] !== undefined ? buses[clip.bus] : 1;
    const v = (buses.master !== undefined ? buses.master : 1) * bus * (dynamic === undefined ? 1 : dynamic);
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  // ------------------------------------------------------------- source plumbing

  /**
   * Write a source onto an entity, skipping anything already true of it.
   *
   * `audio.attachSource` is the only way to set pitch and it resets `playing`, so it
   * is issued only when the clip or the pitch actually changes — and always followed
   * by a re-play if the voice was meant to be running. Volume has its own tool and
   * does not disturb playback, so it is written independently and cheaply.
   */
  function setSource(call, entity, clipName, opts) {
    // Attaching a clip the engine has not registered yet would name a source after
    // nothing. The registration lands within a frame or two of scene start, so this
    // only ever swallows sounds nobody could have heard.
    if (!ready) return false;
    const want = {
      clip: clipName,
      pitch: opts.pitch === undefined ? 1 : opts.pitch,
      volume: opts.volume === undefined ? 1 : opts.volume,
      loop: !!opts.loop,
      spatial: !!opts.spatial,
    };
    const have = srcState.get(entity);
    const needAttach = !have
      || have.clip !== want.clip
      || have.loop !== want.loop
      || have.spatial !== want.spatial
      || Math.abs(have.pitch - want.pitch) > PITCH_EPSILON;

    if (needAttach) {
      const r = call("audio.attachSource", {
        entity, clip: clipId(want.clip), loop: want.loop,
        pitch: want.pitch, volume: want.volume, spatial: want.spatial,
      });
      // The entity can have been culled between the event and here — debris does
      // exactly that. Drop it quietly rather than retrying every frame.
      if (!r || r.isError) { srcState.delete(entity); return false; }
      // A pitch change on a LIVE loop bends the voice rather than restarting it, so a
      // motor slides instead of stuttering. play() re-arms the engine's own flag.
      if (want.loop && waVoices.has(entity)) {
        waLoop(entity, want.clip, want.pitch, want.volume, want.spatial);
      }
      want.playing = false;
      srcState.set(entity, want);
    } else {
      if (Math.abs(have.volume - want.volume) > 0.01) {
        const r = call("audio.setVolume", { entity, volume: want.volume });
        if (!r || r.isError) { srcState.delete(entity); return false; }
        have.volume = want.volume;
        waVolume(entity, want.volume);
      }
      // Carry the pitch we did NOT rewrite, so drift is measured from what the
      // engine actually holds rather than from what we last wanted.
      want.pitch = have.pitch;
      want.playing = have.playing;
      srcState.set(entity, want);
    }
    return true;
  }

  function play(call, entity) {
    const st = srcState.get(entity);
    const r = call("audio.play", { entity });
    if (!r || r.isError) { srcState.delete(entity); return false; }
    if (st) {
      st.playing = true;
      // Start the audible voice from the state just committed, so the two paths can
      // only ever carry the same clip, pitch and gain.
      if (st.loop) waLoop(entity, st.clip, st.pitch, st.volume, st.spatial);
    }
    return true;
  }

  function stop(call, entity) {
    const st = srcState.get(entity);
    if (!st || !st.playing) return;
    const r = call("audio.stop", { entity });
    if (!r || r.isError) { srcState.delete(entity); return; }
    st.playing = false;
    waStop(entity);
  }

  /** Fire a one-shot from the pool, at a world point if one is given. */
  function oneShot(call, clipName, point, dynamic, pitch) {
    if (!voices.length || paused) return;
    const ent = voices[nextVoice];
    nextVoice = (nextVoice + 1) % voices.length;
    if (point) {
      call("scene.setComponent", {
        entity: ent, component: "Transform",
        patch: { position: [point.x || point[0] || 0, point.y || point[1] || 0, point.z || point[2] || 0] },
      });
    }
    const vol = mix(clipName, dynamic);
    const pit = pitch === undefined ? 1 : pitch;
    if (!setSource(call, ent, clipName, { pitch: pit, volume: vol, loop: false, spatial: !!point })) return;
    play(call, ent);
    // The audible one. Independent of the pooled voice entity — WebAudio disposes its
    // own nodes on end, so a one-shot cannot be cut off by the pool wrapping around.
    waOneShot(clipName, point, vol, pit);
  }

  // ------------------------------------------------------------------- lifecycle

  return {
    onStart({ entity, engine, call }) {
      const res = call("project.readFile", { path: BUNDLE_PATH });
      if (!res || res.isError) { engine.console.log("[Audio] no bundle — disabled"); return; }
      const bundle = JSON.parse(res.content.text);
      audio = bundle.audio;
      if (!audio) { engine.console.log("[Audio] bundle has no audio block — disabled"); return; }
      tune = audio.tuning;
      // Copy, so a live bus change never writes back into the bundle.
      buses = {};
      for (const k of Object.keys(audio.buses)) buses[k] = audio.buses[k];

      srcState.clear();
      health.clear();
      swingWeapons.clear();
      ready = false;
      crowdLevel = 0; crowdTarget = 0; impactCool = 0; paused = false;
      chassis = []; rescan = 0; nextVoice = 0;

      // T-6.16 — synthesise and register every clip.
      //
      // `audio.loadClip` is the ONE async tool in the audio namespace — attachSource,
      // play, stop, setVolume and setListener all dispatch synchronously and go
      // through `call` like everything else in this repo. So registration alone
      // cannot use `call`; doing so throws "is async and cannot be called
      // synchronously" and takes the whole of onStart down with it.
      //
      // The loads are therefore kicked off and left to settle. onStart stays
      // synchronous — subscriptions and entities are all in place before this
      // returns — and `ready` gates playback until the clips are actually
      // registered, which takes a frame or two and is inaudible. See
      // engine-fixes.md LIM-007.
      const sr = audio.sampleRate;
      const clipNames = Object.keys(audio.clips).filter((k) => k[0] !== "$");
      let bytesTotal = 0;
      const jobs = [];

      // The real output, built first and synchronously. The engine's registration
      // below produces nothing audible, so there is no reason to wait on it.
      const haveWa = waInit(engine, Object.keys(audio.buses));
      let waCount = 0;
      if (haveWa) for (const name of clipNames) if (waBuffer(name, audio.clips[name], sr)) waCount++;

      // Then upgrade whichever of them have a sourced recording. Asynchronous and
      // unawaited on purpose — see waLoadFile.
      const base = audio.fileBase || "./audio/";
      const sourced = clipNames.filter((n) => audio.clips[n].file);
      if (haveWa && sourced.length) {
        Promise.all(sourced.map((n) => waLoadFile(n, base + audio.clips[n].file, engine)))
          .then((rs) => {
            const got = rs.filter(Boolean).length;
            engine.console.log("[Audio] " + got + "/" + sourced.length + " sourced clips loaded"
              + (got < sourced.length ? " — the rest stay synthesised" : ""));
          });
      }

      for (const name of clipNames) {
        const bytes = buildWav(name, audio.clips[name], sr);
        bytesTotal += bytes.length;
        jobs.push(engine.mcp.callTool("audio.loadClip", { name: clipId(name), source: { bytes } }));
      }
      Promise.all(jobs).then((rs) => {
        const failed = rs.filter((r) => !r || r.isError).length;
        ready = failed === 0;
        engine.console.log("[Audio] " + (clipNames.length - failed) + "/" + clipNames.length
          + " clips registered, " + Math.round(bytesTotal / 1024) + " KB"
          + (failed ? " — " + failed + " FAILED, audio disabled" : ""));
      }).catch((e) => {
        engine.console.log("[Audio] clip registration failed: " + e);
      });

      // T-6.17 — the voice pool and the two non-spatial beds.
      voices = [];
      for (let i = 0; i < VOICE_COUNT; i++) {
        const r = call("scene.createEntity", {
          components: {
            Name: { value: "AudioVoice_" + i },
            Transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
        });
        if (r && !r.isError) voices.push(r.content.entity);
      }
      const bed = (label) => {
        const r = call("scene.createEntity", {
          components: {
            Name: { value: label },
            Transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
        });
        return r && !r.isError ? r.content.entity : 0;
      };
      crowdEnt = bed("AudioBed_Crowd");
      stingEnt = bed("AudioBed_Sting");

      // The listener rides the match camera when there is one, so panning matches
      // what the player is looking at. Menu scenes have none and stay unspatialised.
      const q = call("scene.query", { components: ["Name"] });
      if (q && !q.isError) {
        for (const e of q.content.entities) {
          const n = call("scene.getComponent", { entity: e, component: "Name" });
          const v = n && !n.isError && n.content ? n.content.value : null;
          if (v === "MatchCamera") { listenerEnt = e; break; }
        }
      }

      // ---- events -------------------------------------------------------------

      // T-6.17 — impacts. Rate-limited: a blade grinding along a plate generates
      // contacts every fixed step, and one clank per step is a buzz, not a hit.
      offs.push(engine.mcp.on("battlebots.weaponHit", (p) => {
        if (!p || paused) return;
        const force = p.force || 0;
        if (force < tune.impactMinForceN) return;
        if (impactCool > 0) return;
        impactCool = tune.impactCooldownSeconds;
        // Harder hits are louder AND lower — a big strike should sound heavy, not
        // just loud, so force drives pitch downward as well as volume up.
        const t = Math.min(1, force / (tune.impactMinForceN * 6));
        // Which metal hit which. One clank pitched by force told you that something
        // connected; three tell you WHAT did, which is information a player can act
        // on. A swing weapon is identified by having emitted `weaponSwing` — the
        // damage model does not carry the archetype, and this costs nothing.
        const clip = swingWeapons.has(p.weapon) ? "hammerHit" : (t > 0.66 ? "impactHeavy" : "impact");
        oneShot(call, clip, p.point, 0.45 + t * 0.55, 1.15 - t * 0.35);
        oneShot(call, "spark", p.point, 0.5 + t * 0.5, 0.9 + t * 0.4);
        // T-6.19 — the room reacts to contact.
        crowdTarget = Math.min(1, crowdTarget + tune.crowdPerHit * (0.4 + t));
      }));

      // T-6.17 — losing a part: the biggest one-shot there is.
      offs.push(engine.mcp.on("battlebots.partDetached", (p) => {
        if (!p || paused) return;
        oneShot(call, "detach", p.point || null, 1, 1);
        crowdTarget = Math.min(1, crowdTarget + tune.crowdPerHit * 2.5);
      }));

      // T-6.18 — the blade, pitched by what it is actually doing.
      offs.push(engine.mcp.on("battlebots.weaponState", (p) => {
        if (!p || !p.entity) return;
        const frac = typeof p.spinFraction === "number" ? p.spinFraction : 0;
        // A passive wedge reports rpm 0 forever and should never open a voice.
        if (p.state === "jammed" || frac <= 0.02) { stop(call, p.entity); return; }
        const pitch = tune.spinPitchMin + (tune.spinPitchMax - tune.spinPitchMin) * frac;
        // Volume tracks spin too, so spin-up is audible before it is dangerous.
        if (!setSource(call, p.entity, "spin", {
          pitch, volume: mix("spin", 0.25 + 0.75 * frac), loop: true, spatial: true,
        })) return;
        const st = srcState.get(p.entity);
        if (st && !st.playing && !paused) play(call, p.entity);
      }));

      // AUDIO-GAPS #1 — `battlebots.weaponSwing` was the only event in the game with
      // no listener at all, so an axe or flipper that MISSED was completely silent and
      // you could not hear the opponent commit. It also tells us which weapons are
      // swing weapons, which is what lets a connecting hit pick the right impact.
      offs.push(engine.mcp.on("battlebots.weaponSwing", (p) => {
        if (!p || !p.entity || paused) return;
        swingWeapons.add(p.entity);
        oneShot(call, "swing", null, 1, 1);
      }));

      // AUDIO-GAPS #2 — a part reaching `destroyed`. VfxDirector already smokes a
      // damaged part and sets a dead motor on fire; this is the audio half.
      offs.push(engine.mcp.on("battlebots.partState", (p) => {
        if (!p || paused) return;
        if (p.state === "destroyed") oneShot(call, "partBreak", null, 1, 1);
      }));

      offs.push(engine.mcp.on("battlebots.weaponJammed", (p) => {
        if (!p || paused) return;
        oneShot(call, "impact", null, 0.7, 0.6);
      }));

      offs.push(engine.mcp.on("battlebots.debrisCulled", (p) => {
        if (!p || !p.entity) return;
        srcState.delete(p.entity);
      }));

      // T-6.19 — health drives the near-knockout shift. This channel is already
      // emitted ~2 Hz for the HUD and telemetry, so listening costs nothing.
      offs.push(engine.mcp.on("battlebots.damageReport", (p) => {
        if (!p || !p.parts) return;
        const hp = new Map(), max = new Map();
        for (const r of p.parts) {
          if (!r.role) continue;
          hp.set(r.role, (hp.get(r.role) || 0) + r.hp);
          max.set(r.role, (max.get(r.role) || 0) + r.maxHp);
        }
        health.clear();
        for (const [role, m] of max) if (m > 0) health.set(role, hp.get(role) / m);
      }));

      offs.push(engine.mcp.on("battlebots.matchState", (p) => {
        if (!p) return;
        if (p.state === "fighting") {
          crowdTarget = tune.crowdBaseVolume;
          if (crowdEnt && setSource(call, crowdEnt, "crowd", {
            pitch: 1, volume: mix("crowd", tune.crowdBaseVolume), loop: true, spatial: false,
          })) play(call, crowdEnt);
        }
      }));

      offs.push(engine.mcp.on("battlebots.knockout", (p) => {
        if (!p) return;
        if (stingEnt && setSource(call, stingEnt, "ko", { pitch: 1, volume: mix("ko"), loop: false, spatial: false })) {
          play(call, stingEnt);
        }
        crowdTarget = 1;
      }));

      offs.push(engine.mcp.on("battlebots.matchResult", () => {
        crowdTarget = 1;
      }));

      // A paused match should not keep roaring. Ducking rather than stopping means
      // resume does not have to rebuild every voice.
      offs.push(engine.mcp.on("battlebots.paused", (p) => {
        paused = !!(p && p.paused);
        if (paused) {
          for (const e of Array.from(srcState.keys())) stop(call, e);
        } else if (crowdEnt && srcState.has(crowdEnt)) {
          play(call, crowdEnt);
        }
      }));

      // UI click — menu scenes carry this director for exactly this.
      offs.push(engine.mcp.on("battlebots.botSelected", () => {
        if (!stingEnt) return;
        if (setSource(call, stingEnt, "click", { pitch: 1, volume: mix("click"), loop: false, spatial: false })) {
          play(call, stingEnt);
        }
      }));

      // T-6.20 — live per-bus control, so the options panel has something real to
      // move. Volumes are recomputed from the mix on the next update.
      offs.push(engine.mcp.on("battlebots.setBus", (p) => {
        if (!p || !p.bus || typeof p.volume !== "number") return;
        buses[p.bus] = Math.max(0, Math.min(1, p.volume));
        // Force the looping voices to pick the new level up.
        for (const st of srcState.values()) st.volume = -1;
        // ...and move the bus node itself so a mute is immediate rather than waiting
        // for each voice to notice on its next update. Bus level is already folded
        // into every voice gain by mix(), so the node stays at 1 except for silence.
        waSetBusLevel(p.bus, buses[p.bus], buses.master);
      }));

      started = true;
      engine.console.log("[Audio] wired — " + voices.length + " voices"
        + (listenerEnt ? ", listener on camera" : ", no listener")
        + ", " + clipNames.length + " clips registering"
        + (haveWa
            ? ", WebAudio " + waCount + "/" + clipNames.length + " buffers (" + (actx && actx.state) + ")"
            : ", NO WebAudio — silent"));
    },

    onDestroy({ call }) {
      for (const off of offs) off();
      offs.length = 0;
      for (const e of voices) call("scene.deleteEntity", { entity: e });
      if (crowdEnt) call("scene.deleteEntity", { entity: crowdEnt });
      if (stingEnt) call("scene.deleteEntity", { entity: stingEnt });
      voices = []; crowdEnt = 0; stingEnt = 0;
      ready = false;
      waTeardown();
      srcState.clear();
      health.clear();
      started = false;
    },

    onUpdate({ call, dt }) {
      if (!started) return;

      if (impactCool > 0) impactCool -= dt;

      // T-6.17 — keep the listener on the camera so the stereo image matches the
      // view. Position only; the authored camera rotation is the forward vector.
      if (listenerEnt) {
        const t = call("scene.getComponent", { entity: listenerEnt, component: "Transform" });
        if (t && !t.isError && t.content && t.content.position) {
          const p = t.content.position;
          const q = t.content.rotation || [0, 0, 0, 1];
          // Rotate (0,0,-1) by the quaternion — the camera's forward.
          const x = q[0], y = q[1], z = q[2], w = q[3];
          const fx = -(2 * (x * z + w * y));
          const fy = -(2 * (y * z - w * x));
          const fz = -(1 - 2 * (x * x + y * y));
          call("audio.setListener", { position: [p[0], p[1], p[2]], forward: [fx, fy, fz], up: [0, 1, 0] });
          waListener([p[0], p[1], p[2]], [fx, fy, fz]);
        }
      }

      if (paused) return;

      // T-6.18 — the motor bed, pitched by road speed.
      rescan -= dt;
      if (rescan <= 0) {
        rescan = 1;
        chassis = [];
        const q = call("scene.query", { components: ["Name"] });
        if (q && !q.isError) {
          for (const e of q.content.entities) {
            const n = call("scene.getComponent", { entity: e, component: "Name" });
            const v = n && !n.isError && n.content ? n.content.value : null;
            const m = v && /^Bot_(player|opponent)_Chassis$/.exec(v);
            if (m) chassis.push({ entity: e, role: m[1] });
          }
        }
      }
      for (const c of chassis) {
        const r = call("physics.bodyState", { entity: c.entity });
        const s = r && !r.isError ? r.content : null;
        if (!s || !s.linearVelocity) { srcState.delete(c.entity); continue; }
        const v = s.linearVelocity;
        const speed = Math.hypot(v.x || 0, v.z || 0);
        const frac = Math.min(1, speed / tune.motorSpeedForMaxPitch);
        const pitch = tune.motorPitchMin + (tune.motorPitchMax - tune.motorPitchMin) * frac;
        // The bed never fully closes — a live bot idles audibly, which is what makes
        // the arena feel occupied when nobody is moving.
        if (!setSource(call, c.entity, "motor", {
          pitch, volume: mix("motor", 0.45 + 0.55 * frac), loop: true, spatial: true,
        })) continue;
        const st = srcState.get(c.entity);
        if (st && !st.playing) play(call, c.entity);
        // The motor rides a moving bot; its panner has to move too or the whole
        // arena sounds like it is happening in one spot.
        const live = waVoices.get(c.entity);
        if (live) waMoveTo(live, s.position);
      }

      // T-6.19 — the crowd. Energy decays on its own; a bot near death lifts the
      // floor, so the room gets tenser as the match gets closer to over.
      let nearKo = false;
      for (const h of health.values()) if (h <= tune.nearKnockoutHealth) nearKo = true;
      const floor = tune.crowdBaseVolume + (nearKo ? tune.crowdNearKnockoutBoost : 0);
      crowdTarget = Math.max(crowdTarget - tune.crowdDecayPerSecond * dt, floor);
      if (crowdTarget > 1) crowdTarget = 1;
      // Smooth the level itself too, so a burst of hits swells the room instead of
      // stepping it. Frame-rate independent, same as the camera.
      crowdLevel += (crowdTarget - crowdLevel) * (1 - Math.pow(0.5, dt * 4));
      if (crowdEnt && srcState.has(crowdEnt)) {
        const want = mix("crowd", crowdLevel);
        const st = srcState.get(crowdEnt);
        if (Math.abs(st.volume - want) > 0.01) {
          const r = call("audio.setVolume", { entity: crowdEnt, volume: want });
          if (r && !r.isError) { st.volume = want; waVolume(crowdEnt, want); }
        }
      }
    },
  };
}
