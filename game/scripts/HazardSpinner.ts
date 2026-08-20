/**
 * HazardSpinner — the moving half of an arena floor hazard. (T-5.12)
 *
 * The hazard's DAMAGE is not here. Any entity named `Hazard_*` is picked up by
 * DamageSystem's scan and registered under the reserved `$hazard` role, so it
 * strikes every bot part it touches with `weaponFactor.hazard` and can never be
 * struck back. This script only makes it turn.
 *
 * WHY THE ROTATION IS COSMETIC
 *   The body is STATIC and its collider is a cylinder — the swept envelope of the
 *   bar, not the bar. That is the same lesson the weapon collider cost us
 *   (DESIGN §5): a 60 Hz fixed step cannot resolve a thin bar sweeping faster than
 *   ~0.2 m per step, and the contacts that do resolve are explosive. Colliding the
 *   envelope means the hazard's contact behaviour is identical whether it is
 *   turning or not, so the rotation can be pure art and the solver never sees it.
 *   A player reads "this is spinning, stay off it" from the art alone.
 *
 * params:
 *   rpm   how fast the bar turns, default 150
 */

const RPM_TO_RAD = Math.PI / 30;

export default function create() {
  let angle = 0;
  let position = null;

  return {
    onStart({ entity, engine, call, params }) {
      const res = call("physics.bodyState", { entity });
      const b = res && !res.isError ? res.content : null;
      // Cache the spawn position: the body is fixed, so it never moves, and this
      // saves a bodyState read every step just to hold it in place.
      position = b && b.position ? { x: b.position.x, y: b.position.y, z: b.position.z } : null;
      angle = 0;
      engine.console.log("[Hazard] spinner up — " + (params.rpm || 150) + " rpm");
    },

    onFixedUpdate({ entity, call, dt, params }) {
      if (!position) return;
      angle += (params.rpm || 150) * RPM_TO_RAD * dt;
      if (angle > Math.PI * 2) angle -= Math.PI * 2;
      // Quaternion for a yaw of `angle`. Written through physics rather than the
      // Transform because the physics body owns the pose of anything with a
      // RigidBody — a bare Transform write would be overwritten on the next step.
      const half = angle * 0.5;
      call("physics.setTransform", {
        entity,
        position,
        rotation: { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) },
      });
    },
  };
}
