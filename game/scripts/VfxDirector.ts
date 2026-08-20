/**
 * VfxDirector — sparks, smoke and detachment bursts. (T-5.9, T-5.10, T-5.11)
 *
 * Attach to one marker entity per fighting scene (Name `VfxDirector`). It owns no
 * bots and queries nothing: it listens on the `battlebots.*` channels DamageSystem
 * already emits, so it is a pure consumer and can be removed without touching the
 * damage model.
 *
 *   battlebots.weaponHit    -> spark burst, count scaled by contact force   (T-5.9)
 *   battlebots.partState    -> smoke on a `damaged` part, fire on a dead motor (T-5.10)
 *   battlebots.partDetached -> one-shot burst, then dust for its debris life (T-5.11)
 *   battlebots.debrisCulled -> forget the entity
 *
 * ONE EMITTER PER ENTITY
 *   `ParticleEmitter` is a component, so an entity carries at most one. These are
 *   therefore PRESETS the director swaps on a single entity, not layers it stacks,
 *   and they are ranked: burst > sparks > smoke. A damaged, still-swinging weapon
 *   shows sparks rather than smoke — the hit is the more informative signal, and it
 *   is the one the player is looking at.
 *
 * WHY THE EMITTER LIVES ON THE PART, NOT AT THE CONTACT POINT
 *   The obvious build spawns a short-lived entity at `weaponHit.point` per impact.
 *   That is entity churn on the hot path — the same cost T-5.3 caps debris to avoid,
 *   at ~60 spawns per second of contact. Emitters instead ride the parts that are
 *   already there, and `worldSpace: true` throws the particles off rather than
 *   letting them orbit with a spinning blade.
 *
 * COST
 *   Bounded by construction: at most one emitter per bot part (16 in a two-bot
 *   match), each with its preset's own `maxParticles`. Nothing here allocates per
 *   frame; the spark path is rate-limited by `sparkCooldownSeconds` per weapon, so
 *   a blade grinding along a plate sparks at a readable cadence instead of every
 *   fixed step.
 */

const BUNDLE_PATH = "/data/bundle.json";

export default function create() {
  let vfx = null;
  let tune = null;
  /** entity -> the preset name currently written to its emitter */
  const preset = new Map();
  /** weapon entity -> seconds of spark cooldown left */
  const sparkCool = new Map();
  const offs = [];

  /**
   * Write a preset to an entity's emitter, creating it on first use. Re-writing the
   * same preset is skipped: `vfx.setEmitterProps` is a component patch, and a
   * damaged part would otherwise re-issue it on every state echo.
   */
  function apply(call, entity, name, force) {
    const props = vfx[name];
    if (!props) return false;
    if (!force && preset.get(entity) === name) return true;
    const existing = preset.has(entity);
    const res = call(existing ? "vfx.setEmitterProps" : "vfx.createEmitter", { entity, props });
    // A part culled between the event and here no longer exists; drop it quietly.
    if (!res || res.isError) { preset.delete(entity); return false; }
    preset.set(entity, name);
    return true;
  }

  function burst(call, entity, count) {
    const res = call("vfx.burst", { entity, count });
    return !!(res && !res.isError);
  }

  return {
    onStart({ engine, call }) {
      const bundle = JSON.parse(call("project.readFile", { path: BUNDLE_PATH }).content.text);
      vfx = bundle.vfx;
      tune = vfx.tuning;
      preset.clear();
      sparkCool.clear();

      // T-5.9 — sparks on metal-on-metal, scaled by impact force.
      offs.push(engine.mcp.on("battlebots.weaponHit", (p) => {
        if (!p || !p.weapon) return;
        if ((sparkCool.get(p.weapon) || 0) > 0) return;
        const force = p.force || 0;
        if (force < tune.sparkMinForceN) return;
        const span = Math.max(1, tune.sparkMaxForceN - tune.sparkMinForceN);
        const t = Math.min(1, (force - tune.sparkMinForceN) / span);
        const count = Math.round(tune.sparkMinCount + (tune.sparkMaxCount - tune.sparkMinCount) * t);
        // Sparks fly off the STRUCK part, which is where the metal is being ground
        // away. Falling back to the weapon keeps the effect alive if the victim was
        // culled in the same step.
        const at = p.victim || p.weapon;
        if (!apply(call, at, "sparks")) return;
        burst(call, at, count);
        sparkCool.set(p.weapon, tune.sparkCooldownSeconds);
      }));

      // T-5.10 — smoke from damaged parts, fire from a destroyed motor.
      offs.push(engine.mcp.on("battlebots.partState", (p) => {
        if (!p || !p.entity) return;
        if (p.state === "damaged") apply(call, p.entity, "smoke");
        // Only the motor is handled here. Every other destroyed part is breakable,
        // so it detaches in the same breath and partDetached owns its look.
        else if (p.state === "destroyed" && p.category === "motor") apply(call, p.entity, "fire");
      }));

      // T-5.11 — the mount lets go: one burst, then dust while it is debris.
      offs.push(engine.mcp.on("battlebots.partDetached", (p) => {
        if (!p || !p.entity) return;
        if (!apply(call, p.entity, "detach", true)) return;
        burst(call, p.entity, tune.detachBurstCount);
        // Queue the switch to dust rather than doing it now — the burst is spawned on
        // the NEXT tick, so retuning the emitter immediately would spawn it as dust.
        preset.set(p.entity, "detach:pending");
      }));

      offs.push(engine.mcp.on("battlebots.debrisCulled", (p) => {
        if (!p || !p.entity) return;
        preset.delete(p.entity);
        sparkCool.delete(p.entity);
      }));

      // T-5.13. Post-FX is RENDERER state, not scene state, so nothing in the repo
      // would carry it into a build if it were only set from the editor. Applying it
      // from data here makes the look reproducible and tunable without a recompile.
      if (vfx.postFx && vfx.postFx.enabled) {
        const fx = {};
        for (const k of Object.keys(vfx.postFx)) if (k[0] !== "$") fx[k] = vfx.postFx[k];
        const r = call("renderer.setPostFx", fx);
        if (r && r.isError) engine.console.log("[Vfx] post-FX rejected");
      }

      engine.console.log("[Vfx] ready — " + Object.keys(vfx).filter((k) => k !== "tuning" && k !== "postFx" && k[0] !== "$").length
        + " presets");
    },

    onDestroy() {
      for (const off of offs) off();
      offs.length = 0;
      preset.clear();
      sparkCool.clear();
    },

    onFixedUpdate({ call, dt }) {
      for (const [e, left] of sparkCool) {
        const next = left - dt;
        if (next <= 0) sparkCool.delete(e); else sparkCool.set(e, next);
      }
      // Second half of the detach effect: the burst has been spawned by now, so the
      // emitter can be handed over to the slow dust it trails as debris.
      for (const [e, name] of Array.from(preset)) {
        if (name !== "detach:pending") continue;
        preset.set(e, "detach");
        apply(call, e, "dust");
      }
    },
  };
}
