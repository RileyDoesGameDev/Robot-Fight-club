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

export default function create() {
  let audio = null;              // the audio block out of the bundle
  let tune = null;
  let buses = null;              // live bus levels, mutable via battlebots.setBus
  /** False until every clip is registered. Nothing may be attached before then. */
  let ready = false;
  const offs = [];

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
      want.playing = false;
      srcState.set(entity, want);
    } else {
      if (Math.abs(have.volume - want.volume) > 0.01) {
        const r = call("audio.setVolume", { entity, volume: want.volume });
        if (!r || r.isError) { srcState.delete(entity); return false; }
        have.volume = want.volume;
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
    if (st) st.playing = true;
    return true;
  }

  function stop(call, entity) {
    const st = srcState.get(entity);
    if (!st || !st.playing) return;
    const r = call("audio.stop", { entity });
    if (!r || r.isError) { srcState.delete(entity); return; }
    st.playing = false;
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
    if (!setSource(call, ent, clipName, {
      pitch: pitch === undefined ? 1 : pitch,
      volume: mix(clipName, dynamic),
      loop: false, spatial: !!point,
    })) return;
    play(call, ent);
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
        oneShot(call, "impact", p.point, 0.45 + t * 0.55, 1.15 - t * 0.35);
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
      }));

      started = true;
      engine.console.log("[Audio] wired — " + voices.length + " voices"
        + (listenerEnt ? ", listener on camera" : ", no listener")
        + ", " + clipNames.length + " clips registering");
    },

    onDestroy({ call }) {
      for (const off of offs) off();
      offs.length = 0;
      for (const e of voices) call("scene.deleteEntity", { entity: e });
      if (crowdEnt) call("scene.deleteEntity", { entity: crowdEnt });
      if (stingEnt) call("scene.deleteEntity", { entity: stingEnt });
      voices = []; crowdEnt = 0; stingEnt = 0;
      ready = false;
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
          if (r && !r.isError) st.volume = want;
        }
      }
    },
  };
}
