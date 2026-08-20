/**
 * DamageSystem — component health, degradation and part loss. (T-3.1 – T-3.8)
 *
 * Attach to one marker entity per scene (Name `DamageSystem`). It discovers bots
 * by entity name, so it needs no per-bot wiring.
 *
 * SIGNAL (T-1.14, T-3.4)
 *   `physics.getContacts()` — live contacts, refreshed every step, each carrying
 *   `maxForce` in newtons. Preferred over the `physics.contact` EVENT because that
 *   only fires on contact begin/end, so a spinner grinding along a plate would
 *   damage once and then never again. Polling the live set makes sustained contact
 *   accumulate naturally.
 *
 *   `Collider.contactForceEventThreshold` (400 N, from damage.json) is what keeps
 *   this cheap: below it the solver reports no force at all, so resting and
 *   rolling contacts cost nothing to ignore.
 *
 * MODEL (T-3.1, T-3.3)
 *   Per part: hp, maxHp, state ∈ {intact, damaged, destroyed}, armour tier.
 *   Force-based rate, not an energy derived from velocities — the solver already
 *   computed the force, so deriving energy would duplicate it:
 *
 *     excess  = max(0, maxForce - damageFloorN)
 *     dps     = excess * damageScaleHpPerNs * weaponFactor * (1 - armorReduction)
 *     damage  = dps * dt
 *
 *   `weaponFactor` comes from the STRIKING part (a spinner bites harder than a
 *   shove — `ram` is the factor for anything that is not a weapon).
 *   `armorReduction` comes from the STRUCK part's own tier.
 *
 * WHAT COUNTS AS A HIT (T-3.8)
 *   Only inter-bot pairs. Two parts of the same bot never damage each other, and
 *   arena geometry never damages anything — filtering by role is enough, so no
 *   collision-group masks are needed. Doing it in the damage system rather than
 *   with `Collider.collisionGroups` keeps the bots physically solid against the
 *   floor and each other, which masks would otherwise put at risk.
 *
 * STATE STORAGE
 *   Health lives in this script's own Map, keyed by entity. There is no component
 *   to hold it, and `Script.params` is per-instance config rather than a place for
 *   another entity's runtime state. The consequence is deliberate: health resets
 *   when the scene reloads, which is exactly what a match restart wants (T-5.8).
 */

const BUNDLE_PATH = "/data/bundle.json";

// Greybox damage tint. Real wear overlays are T-4.13.
const COL_DAMAGED = 0x8a6a1f;
const COL_DESTROYED = 0x3a2a2a;

export default function create() {
  let bundle = null;
  let dmg = null;
  /** entity -> { role, socketId, partId, category, hp, maxHp, state, armorTier, isChassis } */
  const parts = new Map();
  /** role -> { chassis, knockedOut, damageDealt } */
  const bots = new Map();
  let scanCooldown = 0;
  let offReport = null;
  let offWeapon = null;
  /** weapon entity -> 0..1 of its target rpm, from battlebots.weaponState */
  const spin = new Map();

  function nameOf(call, e) {
    const r = call("scene.getComponent", { entity: e, component: "Name" });
    return r && !r.isError && r.content ? r.content.value : null;
  }

  /**
   * Rebuild the registry from the live scene. Cheap enough to re-run
   * periodically, which is how bots that spawn after us get picked up.
   */
  function scan(call, engine) {
    const ents = call("scene.query", { components: ["Name"] }).content.entities;
    const seen = new Set();
    for (const e of ents) {
      const n = nameOf(call, e);
      if (!n || !/^Bot_/.test(n) || /Visual/.test(n)) continue;
      seen.add(e);
      if (parts.has(e)) continue;

      // Bot_<role>_Chassis  |  Bot_<role>_<socketId>_<partId>
      const body = n.slice(4);
      const us = body.indexOf("_");
      if (us < 0) continue;
      const role = body.slice(0, us);
      const rest = body.slice(us + 1);

      if (rest === "Chassis") {
        // Chassis hp comes from its own PartDef; recover it via collider size.
        const col = call("scene.getComponent", { entity: e, component: "Collider" }).content;
        let def = null;
        for (const id of Object.keys(bundle.parts)) {
          const d = bundle.parts[id];
          if (d.category !== "chassis") continue;
          const he = d.colliderSpec.halfExtents;
          if (he && col.halfExtents &&
              Math.abs(he[0] - col.halfExtents[0]) < 1e-6 &&
              Math.abs(he[1] - col.halfExtents[1]) < 1e-6 &&
              Math.abs(he[2] - col.halfExtents[2]) < 1e-6) { def = d; break; }
        }
        const hp = def ? def.hp : 300;
        parts.set(e, { role, socketId: "chassis", partId: def ? def.id : "unknown",
          category: "chassis", hp, maxHp: hp, state: "intact", armorTier: "none", isChassis: true });
        if (!bots.has(role)) bots.set(role, { chassis: e, knockedOut: false, damageDealt: 0, wheelsSeen: 0 });
        else bots.get(role).chassis = e;
        continue;
      }

      // trailing partId, leading socketId — socket ids contain underscores
      let socketId = null, partId = null;
      for (const id of Object.keys(bundle.parts)) {
        if (rest.length > id.length && rest.slice(rest.length - id.length) === id &&
            rest.charAt(rest.length - id.length - 1) === "_") {
          partId = id;
          socketId = rest.slice(0, rest.length - id.length - 1);
          break;
        }
      }
      if (!partId) continue;
      const def = bundle.parts[partId];
      parts.set(e, { role, socketId, partId, category: def.category, hp: def.hp, maxHp: def.hp,
        state: "intact", armorTier: def.armorTier || "none", isChassis: false });
      if (!bots.has(role)) bots.set(role, { chassis: 0, knockedOut: false, damageDealt: 0, wheelsSeen: 0 });
      if (def.category === "wheel") {
        const bk = bots.get(role);
        // High-water mark, not a live count: a wheel that has been culled as debris
        // is still a wheel this bot LOST, so the denominator must not shrink.
        let live = 0;
        for (const r2 of parts.values()) if (r2.role === role && r2.category === "wheel") live++;
        if (live > bk.wheelsSeen) bk.wheelsSeen = live;
      }
    }
    // forget entities that no longer exist (culled debris, scene reload)
    for (const e of [...parts.keys()]) if (!seen.has(e)) parts.delete(e);
  }

  /** Per-side drive authority from surviving wheels, written into BotDrive params. */
  function refreshDrive(call, role) {
    const bot = bots.get(role);
    if (!bot || !bot.chassis) return;
    const side = { left: [], right: [] };
    for (const rec of parts.values()) {
      if (rec.role !== role || rec.category !== "wheel") continue;
      const s = /_(fl|rl)$/.test(rec.socketId) ? "left" : "right";
      side[s].push(rec);
    }
    const authority = (list) => {
      if (!list.length) return 0;
      let sum = 0;
      for (const r of list) {
        sum += r.state === "destroyed" ? 0 : r.state === "damaged" ? dmg.damagedDriveTorqueMultiplier : 1;
      }
      return sum / list.length;
    };
    // Read-modify-write: `params` is one field, so patching it REPLACES the whole
    // object. AiDriver writes `intent` into the same params, and a blind write here
    // would delete the AI's commands every time a wheel changed state.
    const cur = call("scene.getComponent", { entity: bot.chassis, component: "Script" });
    const existing = cur && !cur.isError && cur.content && cur.content.params ? cur.content.params : {};
    call("scene.setComponent", {
      entity: bot.chassis,
      component: "Script",
      patch: {
        params: Object.assign({}, existing, {
          driveLeft: authority(side.left),
          driveRight: authority(side.right),
        }),
      },
    });
  }

  function setColor(call, entity, color) {
    const r = call("scene.getComponent", { entity, component: "MeshRenderer" });
    if (r && !r.isError && r.content) call("scene.setComponent", { entity, component: "MeshRenderer", patch: { color } });
  }

  /** intact -> damaged -> destroyed, with the mechanical consequences (T-3.5, T-3.6, T-5.5). */
  function applyState(call, engine, entity, rec, next) {
    if (rec.state === next) return;
    rec.state = next;

    if (next === "damaged") {
      setColor(call, entity, COL_DAMAGED);
      // Progressive weakening: a damaged mount shears sooner (T-5.5).
      const j = call("scene.getComponent", { entity, component: "Joint" });
      if (j && !j.isError && j.content && j.content.joints.length) {
        const joints = j.content.joints.map((link) => ({
          ...link, breakForce: link.breakForce * dmg.damagedBreakForceMultiplier,
        }));
        call("scene.setComponent", { entity, component: "Joint", patch: { joints } });
      }
    } else if (next === "destroyed") {
      setColor(call, entity, COL_DESTROYED);
      if (!rec.isChassis) {
        // Detach: drop the Joint so the part becomes free arena debris (T-5.2).
        // Detaching rather than hiding is deliberate — a part that mechanically
        // left the bot should be visible on the floor, which reads better than
        // something vanishing.
        const j = call("scene.getComponent", { entity, component: "Joint" });
        if (j && !j.isError && j.content) call("scene.removeComponent", { entity, component: "Joint" });
      }
    }

    engine.mcp.emit("battlebots.partState", {
      entity, role: rec.role, socketId: rec.socketId, partId: rec.partId, state: next,
    });
    engine.console.log("[Damage] " + rec.role + "/" + rec.socketId + " (" + rec.partId + ") -> " + next);

    if (rec.category === "wheel" || rec.category === "motor") refreshDrive(call, rec.role);
    checkKnockout(call, engine, rec.role);
  }

  /** Immobilised, or chassis destroyed, ends the match for that bot (T-3.7). */
  function checkKnockout(call, engine, role) {
    const bot = bots.get(role);
    if (!bot || bot.knockedOut) return;

    let chassisDead = false;
    let wheelsAlive = 0;
    for (const rec of parts.values()) {
      if (rec.role !== role) continue;
      if (rec.isChassis && rec.state === "destroyed") chassisDead = true;
      if (rec.category === "wheel" && rec.state !== "destroyed") wheelsAlive++;
    }
    // Compared against the high-water mark, so a wheel whose entity is gone counts
    // as lost rather than simply forgotten.
    const immobilised = (bot.wheelsSeen || 0) > 0 && wheelsAlive < 2;
    if (!chassisDead && !immobilised) return;

    bot.knockedOut = true;
    const reason = chassisDead ? "chassis-destroyed" : "immobilised";
    engine.mcp.emit("battlebots.knockout", { role, reason });
    engine.console.log("[Damage] KNOCKOUT " + role + " — " + reason);
  }

  return {
    onStart({ engine, call }) {
      bundle = JSON.parse(call("project.readFile", { path: BUNDLE_PATH }).content.text);
      dmg = bundle.damage;
      parts.clear();
      bots.clear();
      scan(call, engine);
      for (const role of bots.keys()) refreshDrive(call, role);
      engine.console.log("[Damage] ready — " + parts.size + " parts across " + bots.size + " bots");

      // Debug/HUD channel: anyone emitting `battlebots.requestReport` gets a
      // `battlebots.damageReport` back with the full health table. The in-match
      // HUD (T-6.11) reads the same channel, so this is not test-only scaffolding.
      offWeapon = engine.mcp.on("battlebots.weaponState", (p) => {
        if (p && typeof p.spinFraction === "number") spin.set(p.entity, p.spinFraction);
      });

      offReport = engine.mcp.on("battlebots.requestReport", () => {
        const rows = [];
        for (const [ent, r] of parts) {
          rows.push({ entity: ent, role: r.role, socket: r.socketId, part: r.partId,
            hp: Math.round(r.hp * 10) / 10, maxHp: r.maxHp, state: r.state });
        }
        const summary = [];
        for (const [role, b] of bots) {
          summary.push({ role, knockedOut: b.knockedOut, damageDealt: Math.round(b.damageDealt * 10) / 10 });
        }
        engine.mcp.emit("battlebots.damageReport", { parts: rows, bots: summary });
      });
    },

    onDestroy() {
      if (offReport) { offReport(); offReport = null; }
      if (offWeapon) { offWeapon(); offWeapon = null; }
    },

    onFixedUpdate({ engine, call, dt }) {
      // Re-scan occasionally so late-spawning bots are picked up without
      // paying a full query every step.
      scanCooldown -= dt;
      if (scanCooldown <= 0) {
        scanCooldown = 1.0;
        const had = parts.size;
        scan(call, engine);
        if (parts.size !== had) for (const role of bots.keys()) refreshDrive(call, role);
        // Re-evaluate defeat here too, not just on a damage transition: a wheel can
        // leave the bot without any transition of its own — culled as debris, or
        // removed by a reset — and immobilisation must still be noticed (T-3.7).
        for (const role of bots.keys()) checkKnockout(call, engine, role);
      }

      const res = call("physics.getContacts", {});
      if (!res || res.isError || !res.content) return;

      for (const c of res.content.contacts) {
        const A = parts.get(c.a);
        const B = parts.get(c.b);
        if (!A || !B) continue;          // arena geometry or debris we no longer track
        if (A.role === B.role) continue; // same bot — never self-damage (T-3.8)

        const force = c.maxForce || 0;
        const excess = force - dmg.damageFloorN;
        if (excess <= 0) continue;

        const strike = (striker, victim, victimEntity, strikerEntity) => {
          if (victim.state === "destroyed") return;
          let factor = dmg.weaponFactor.ram;
          if (striker.category === "weapon") {
            const st = bundle.parts[striker.partId].stats || {};
            const f = st.type ? dmg.weaponFactor[st.type] : undefined;
            factor = typeof f === "number" ? f : dmg.weaponFactor.ram;
            // A damaged weapon bites less hard (T-3.6).
            if (striker.state === "damaged") factor *= dmg.damagedWeaponRpmMultiplier;
            // Scale by how fast the blade is actually turning. Its collider is the
            // swept envelope, so it touches even at rest; a stopped blade is just a
            // bar being shoved, and should do ram damage rather than weapon damage.
            const frac = spin.has(strikerEntity) ? spin.get(strikerEntity) : 0;
            factor = dmg.weaponFactor.ram + (factor - dmg.weaponFactor.ram) * frac;
          }
          const reduction = dmg.armorReduction[victim.armorTier] || 0;
          const amount = excess * dmg.damageScaleHpPerNs * factor * (1 - reduction) * dt;
          if (amount <= 0) return;

          victim.hp = Math.max(0, victim.hp - amount);
          const attacker = bots.get(striker.role);
          if (attacker) attacker.damageDealt += amount;

          // A weapon that connects loses energy. Reported from here because this
          // loop already knows the roles and the force — a weapon controller
          // polling contacts itself would duplicate the whole filter.
          if (striker.category === "weapon") {
            engine.mcp.emit("battlebots.weaponHit", {
              weapon: strikerEntity,
              victim: victimEntity,
              role: striker.role,
              force,
            });
          }

          if (victim.hp <= 0) applyState(call, engine, victimEntity, victim, "destroyed");
          else if (victim.hp / victim.maxHp <= dmg.damagedAtHpFraction) {
            applyState(call, engine, victimEntity, victim, "damaged");
          }
        };

        // Each side strikes the other.
        strike(A, B, c.b, c.a);
        strike(B, A, c.a, c.b);
      }
    },
  };
}
