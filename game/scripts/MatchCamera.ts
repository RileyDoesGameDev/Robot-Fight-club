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
 * params:
 *   minDistance / maxDistance   how far back it may sit, in metres along `dir`
 *   metresPerSeparation         extra distance per metre between the bots
 *   smoothing                   0..1 per-frame lerp; 1 is instant
 *   ignoreBelowY                bots below this are not framed
 */

const DEFAULTS = {
  minDistance: 13,
  maxDistance: 26,
  metresPerSeparation: 1.15,
  smoothing: 0.08,
  ignoreBelowY: -0.5,
};

export default function create() {
  let dir = null;        // normalised authored offset from the origin
  let baseDistance = 16;
  let current = null;    // smoothed camera position
  let rescan = 0;
  let bots = [];

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
      engine.console.log("[Camera] shared view — base " + Math.round(len * 10) / 10
        + " m along [" + dir.map((x) => Math.round(x * 100) / 100).join(", ") + "]");
    },

    onUpdate({ entity, call, dt, params }) {
      if (!dir) return;
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
      const want = Math.max(num(params, "minDistance"),
        Math.min(num(params, "maxDistance"),
          baseDistance * 0.82 + spread * num(params, "metresPerSeparation")));

      const goal = [target[0] + dir[0] * want, target[1] + dir[1] * want, target[2] + dir[2] * want];
      if (!current) current = goal.slice();
      // Frame-rate-independent smoothing: a raw lerp by a constant would chase
      // faster on a faster machine, which is exactly the kind of thing that makes a
      // camera feel different on someone else's laptop.
      const k = 1 - Math.pow(1 - Math.min(0.999, num(params, "smoothing")), dt * 60);
      for (let i = 0; i < 3; i++) current[i] += (goal[i] - current[i]) * k;

      // Position only. The authored rotation is deliberately never written.
      call("scene.setComponent", { entity, component: "Transform",
        patch: { position: [current[0], current[1], current[2]] } });
    },
  };
}
