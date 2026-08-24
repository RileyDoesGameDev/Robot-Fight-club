/**
 * MatchCamera — one shared camera that keeps both bots framed. (T-6.7)
 *
 * Attach to the scene's `MatchCamera` entity, which already carries the Camera
 * component and its authored pose.
 *
 * SHARED CAMERA, NOT SPLIT SCREEN
 *   The proposal called this decision out and predicted the answer; the arena is
 *   12 x 12 m and the bots fight at contact range, so a shared view almost always
 *   holds both. Split screen would halve the resolution of each view, double the
 *   draw work, and — in an arena this size — mostly show the two players the same
 *   thing twice. It also has nothing to fall back on in single player.
 *   The one real cost is that a shared camera cannot frame two bots in opposite
 *   corners without pulling back far enough to make both small, which is what
 *   `maxDistance` bounds and why the pit corners stay legible.
 *
 * WHY IT ONLY EVER MOVES, NEVER RE-AIMS
 *   The camera sits at `target + dir * distance`, where `dir` is the normalised
 *   authored offset. Both tracking and zoom change only the target and the
 *   distance — never `dir` — so the view direction is *identically* the pose that
 *   was framed by hand in the editor, and the authored rotation is never touched.
 *   Recomputing a look-at quaternion each frame would have produced subtly
 *   different framing and put a rotation solve on every frame for no gain.
 *
 * FAILURE MODES IT HAS TO SURVIVE
 *   A bot can be knocked into a pit (y well below the floor) or culled entirely.
 *   Tracking the raw midpoint would drag the camera underground after the first
 *   pit knockout, so bots below `ignoreBelowY` are dropped from the framing and the
 *   camera settles on whoever is left.
 *
 * GAME FEEL (T-7.9)
 *   Impact feedback lives here because the camera is the only thing in the game that
 *   can react to a hit without changing its outcome. Three effects, all of them
 *   POSITION-only, so the rule above still holds - the authored rotation is never
 *   touched, and none of this can alter a match.
 *
 *   Shake        Trauma-based, not "jitter for N frames". A hit adds trauma scaled by
 *                its force; trauma decays linearly and the offset is trauma SQUARED,
 *                so a big hit falls off hard and a small one barely registers. Losing
 *                a part adds the most - it is the biggest thing that happens.
 *                The displacement is three sine waves at unrelated frequencies rather
 *                than per-frame randomness, which reads as a camera being shoved
 *                instead of a bad video signal, and is frame-rate independent for free.
 *   Hit stop     A real hitstop freezes the simulation. This engine has no timescale
 *                (see below), so what freezes is the CAMERA: for ~80 ms after a big
 *                hit it stops tracking entirely and only shakes. Perceptually most of
 *                hitstop is the view going rigid at the moment of contact, so this
 *                buys most of the effect for none of the risk - a simulation freeze
 *                would change physics outcomes, which is a gameplay change wearing
 *                polish's clothes.
 *   Knockout     Asked for as slow-motion. NOT POSSIBLE - see the note below. What
 *                happens instead is a slow cinematic push-in over `koPushSeconds`,
 *                which gives the ending a beat of its own. Called what it is rather
 *                than filed as slow-mo.
 *
 * WHY THERE IS NO SLOW MOTION (engine-fixes.md LIM-008)
 *   The engine exposes no time scale. `engine.clock.stepSeconds` looks like one and is
 *   not: the accumulator drains real time regardless, so halving it doubles the step
 *   rate and leaves simulation speed identical - measured 61 steps/s at 1/60 and 120
 *   steps/s at 1/120, both advancing 1.0 s of sim per wall second. It is a fidelity
 *   knob. `game.pause` is a full stop with its own event, not a dilation, and
 *   `editor.setRunning` + `stepFrames` would work only in the editor and not in a
 *   deployed build. Slow motion needs a real `timeScale` on the clock.
 *
 * params:
 *   minDistance / maxDistance   how far back it may sit, in metres along `dir`
 *   metresPerSeparation         extra distance per metre between the bots
 *   smoothing                   0..1 per-frame lerp; 1 is instant
 *   ignoreBelowY                bots below this are not framed
 *   shakeMinForceN              hits below this do not shake the camera at all
 *   shakeMaxForceN              the force that earns a full-trauma shake
 *   shakeMetres                 peak displacement at full trauma
 *   traumaDecayPerSecond        how fast a shake settles
 *   detachTrauma                trauma added when a part is torn off
 *   hitStopSeconds              how long tracking freezes after a big hit
 *   hitStopMinForceN            the force worth freezing for
 *   koPushMetres                how far the camera eases in on a knockout
 *   koPushSeconds               how long that push takes
 */

const DEFAULTS = {
  minDistance: 13,
  maxDistance: 26,
  metresPerSeparation: 1.15,
  smoothing: 0.08,
  ignoreBelowY: -0.5,
  // T-7.9. Forces line up with the damage model: DamageSystem reports contact force
  // in newtons, and a solid weapon hit lands in the low thousands.
  shakeMinForceN: 1200,
  shakeMaxForceN: 9000,
  shakeMetres: 0.42,
  traumaDecayPerSecond: 1.6,
  detachTrauma: 0.75,
  hitStopSeconds: 0.08,
  hitStopMinForceN: 5000,
  koPushMetres: 3.2,
  koPushSeconds: 1.4,
};

/**
 * Three unrelated frequencies, so the sum never repeats on a short cycle and the
 * shake does not read as a loop. Prime-ish ratios on purpose.
 */
const SHAKE_FREQ = [37.1, 23.7, 29.3];
const SHAKE_PHASE = [0, 2.1, 4.3];

export default function create() {
  let dir = null;        // normalised authored offset from the origin
  let baseDistance = 16;
  let current = null;    // smoothed camera position
  let rescan = 0;
  let bots = [];

  // T-7.9 game feel.
  let trauma = 0;        // 0..1; shake is trauma squared
  let shakeClock = 0;    // seconds, drives the sine displacement
  let hitStop = 0;       // seconds of tracking freeze left
  let koPush = 0;        // 0..1 eased progress of the knockout push-in
  let koActive = false;
  // Script params arrive on the update hook, so they are cached for the event
  // handlers, which fire outside it. Until the first update they read DEFAULTS.
  let paramsRef = null;
  const offs = [];

  function num(params, k) {
    const v = params ? params[k] : undefined;
    return typeof v === "number" && isFinite(v) ? v : DEFAULTS[k];
  }

  function findBots(call) {
    const out = [];
    const res = call("scene.query", { components: ["Name"] });
    if (!res || res.isError) return out;
    for (const e of res.content.entities) {
      const n = call("scene.getComponent", { entity: e, component: "Name" });
      const v = n && !n.isError && n.content ? n.content.value : null;
      if (v && /^Bot_(player|opponent)_Chassis$/.test(v)) out.push(e);
    }
    return out;
  }

  return {
    onStart({ entity, engine, call }) {
      const t = call("scene.getComponent", { entity, component: "Transform" });
      const p = t && !t.isError && t.content ? t.content.position : [0, 11, 12];
      const len = Math.hypot(p[0], p[1], p[2]) || 1;
      // The authored pose IS the framing decision; everything here is expressed
      // relative to it rather than replacing it.
      dir = [p[0] / len, p[1] / len, p[2] / len];
      baseDistance = len;
      current = null;
      bots = findBots(call);
      rescan = 0;
      trauma = 0; shakeClock = 0; hitStop = 0; koPush = 0; koActive = false;

      // T-7.9 - impact feedback. Pure consumers of channels that already exist, so
      // nothing here is on the damage path and removing it changes no outcome.
      offs.push(engine.mcp.on("battlebots.weaponHit", (p) => {
        if (!p) return;
        const force = p.force || 0;
        const lo = num(paramsRef, "shakeMinForceN");
        const hi = num(paramsRef, "shakeMaxForceN");
        if (force < lo) return;
        const t = Math.min(1, (force - lo) / Math.max(1, hi - lo));
        // Take the strongest claim on the camera rather than summing: two hits in a
        // frame should not shake twice as hard as physics can justify.
        trauma = Math.min(1, Math.max(trauma, t));
        if (force >= num(paramsRef, "hitStopMinForceN")) {
          hitStop = Math.max(hitStop, num(paramsRef, "hitStopSeconds"));
        }
      }));

      offs.push(engine.mcp.on("battlebots.partDetached", () => {
        trauma = Math.min(1, Math.max(trauma, num(paramsRef, "detachTrauma")));
        hitStop = Math.max(hitStop, num(paramsRef, "hitStopSeconds"));
      }));

      // The ending gets a beat. Not slow motion - the engine has none (LIM-008).
      offs.push(engine.mcp.on("battlebots.knockout", () => { koActive = true; }));
      offs.push(engine.mcp.on("battlebots.matchResult", () => { koActive = true; }));

      engine.console.log("[Camera] shared view — base " + Math.round(len * 10) / 10
        + " m along [" + dir.map((x) => Math.round(x * 100) / 100).join(", ") + "]"
        + " — shake/hit-stop armed");
    },

    onDestroy() {
      for (const off of offs) off();
      offs.length = 0;
      trauma = 0; hitStop = 0; koPush = 0; koActive = false;
    },

    onUpdate({ entity, call, dt, params }) {
      if (!dir) return;
      paramsRef = params;

      // T-7.9 timers. Trauma decays linearly; the SQUARE of it drives displacement,
      // which is what makes a shake land hard and leave quickly instead of sagging.
      shakeClock += dt;
      if (trauma > 0) trauma = Math.max(0, trauma - num(params, "traumaDecayPerSecond") * dt);
      if (hitStop > 0) hitStop -= dt;
      if (koActive && koPush < 1) {
        koPush = Math.min(1, koPush + dt / Math.max(0.01, num(params, "koPushSeconds")));
      }

      // Bots are assembled after this script starts, so keep looking until found.
      rescan -= dt;
      if (rescan <= 0 || !bots.length) { rescan = 1; bots = findBots(call); }
      if (!bots.length) return;

      const floor = num(params, "ignoreBelowY");
      let sx = 0, sz = 0, n = 0;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const e of bots) {
        const r = call("physics.bodyState", { entity: e });
        const s = r && !r.isError ? r.content : null;
        if (!s || !s.position || s.position.y < floor) continue;   // pitted or gone
        sx += s.position.x; sz += s.position.z; n++;
        minX = Math.min(minX, s.position.x); maxX = Math.max(maxX, s.position.x);
        minZ = Math.min(minZ, s.position.z); maxZ = Math.max(maxZ, s.position.z);
      }
      if (!n) return;

      const target = [sx / n, 0, sz / n];
      const spread = n > 1 ? Math.max(maxX - minX, maxZ - minZ) : 0;
      let want = Math.max(num(params, "minDistance"),
        Math.min(num(params, "maxDistance"),
          baseDistance * 0.82 + spread * num(params, "metresPerSeparation")));

      // T-7.9 knockout beat. Pulling `want` in rather than moving the camera by hand
      // keeps the push on the same authored axis as everything else, so the framing
      // tightens without the view ever changing direction. Smoothstep, so it eases
      // at both ends instead of arriving with a jolt.
      if (koPush > 0) {
        const e = koPush * koPush * (3 - 2 * koPush);
        want = Math.max(num(params, "minDistance") * 0.55, want - num(params, "koPushMetres") * e);
      }

      const goal = [target[0] + dir[0] * want, target[1] + dir[1] * want, target[2] + dir[2] * want];
      if (!current) current = goal.slice();
      // Frame-rate-independent smoothing: a raw lerp by a constant would chase
      // faster on a faster machine, which is exactly the kind of thing that makes a
      // camera feel different on someone else's laptop.
      //
      // T-7.9 hit stop: while it is running, `k` is zero and the camera stops
      // tracking altogether. It does not freeze in place - the shake below still
      // moves it - so the view goes rigid against the world rather than dead.
      const k = hitStop > 0
        ? 0
        : 1 - Math.pow(1 - Math.min(0.999, num(params, "smoothing")), dt * 60);
      for (let i = 0; i < 3; i++) current[i] += (goal[i] - current[i]) * k;

      // T-7.9 shake. Three sine waves at unrelated frequencies: smooth, deterministic,
      // and frame-rate independent, where per-frame randomness would alias into
      // different-looking noise on a 144 Hz monitor. Applied as an offset at write
      // time so `current` itself never accumulates shake - otherwise the smoothing
      // above would chase the shaken position and the camera would drift.
      let ox = 0, oy = 0, oz = 0;
      if (trauma > 0) {
        const amp = num(params, "shakeMetres") * trauma * trauma;
        ox = amp * Math.sin(shakeClock * SHAKE_FREQ[0] + SHAKE_PHASE[0]);
        oy = amp * Math.sin(shakeClock * SHAKE_FREQ[1] + SHAKE_PHASE[1]) * 0.6;
        oz = amp * Math.sin(shakeClock * SHAKE_FREQ[2] + SHAKE_PHASE[2]);
      }

      // Position only. The authored rotation is deliberately never written.
      call("scene.setComponent", { entity, component: "Transform",
        patch: { position: [current[0] + ox, current[1] + oy, current[2] + oz] } });
    },
  };
}
