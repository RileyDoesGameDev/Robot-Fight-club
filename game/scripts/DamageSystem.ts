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
 *   `armorReduction` comes from the STRUCK part: its own tier for an ordinary part,
 *   and for the CHASSIS the plate covering the face that was hit — see
 *   `armorReductionFor`.
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

/**
 * Most debris pieces allowed on the floor at once. Past this the oldest is culled
 * early rather than waiting out its lifetime, so a scrappy match cannot outpace the
 * timer. Eight covers a full bot's worth of shed parts.
 */
const DEBRIS_CAP = 8;

/**
 * What can come off (T-5.6). Explicitly curated rather than "anything not the
 * chassis": a motor is internal, so a dead motor stays bolted in and simply stops
 * working. No free-fracture — a part either detaches whole or stays put.
 */
const BREAKABLE = new Set(["wheel", "weapon", "armor"]);

/** Rotate vector v by quaternion q (x,y,z,w). */
function rotate(q, v) {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}

/** World -> body-local, for asking WHICH FACE of a chassis a contact landed on. */
function invRotate(q, v) {
  return rotate([-q[0], -q[1], -q[2], q[3]], v);
}

export default function create() {
  let bundle = null;
  let dmg = null;
  /** entity -> { role, socketId, partId, category, hp, maxHp, state, armorTier, isChassis } */
  const parts = new Map();
  /** role -> { chassis, knockedOut, damageDealt, wheels, motors } */
  const bots = new Map();
  let scanCooldown = 0;
  let offReport = null;
  let offWeapon = null;
  /** weapon entity -> 0..1 of its target rpm, from battlebots.weaponState */
  const spin = new Map();
  /** detached part entity -> seconds since it left its bot (T-5.3) */
  const debris = new Map();
  /** entity -> bodyState, cleared each fixed step so a contact loop asks once */
  const bodyCache = new Map();

  /**
   * A bot's drivetrain sockets are registered once and NEVER removed, even after the
   * part's entity is gone. A wheel culled as debris is still a wheel this bot LOST,
   * and counting live entities instead let drive authority climb back the moment the
   * debris was swept up — half a track returning to full power seconds after being
   * torn off.
   */
  function newBot(chassis) {
    return { chassis, knockedOut: false, damageDealt: 0, wheels: new Map(), motors: new Map() };
  }

  /**
   * Unit direction, in chassis-local space, of every socket that takes a plate —
   * the faces armour can cover. Read from the chassis' own socket table rather than
   * hardcoding front/rear/left/right, so a chassis added later needs no code change.
   */
  function armorFaces(def) {
    const out = [];
    for (const s of (def && def.sockets) || []) {
      if (!Array.isArray(s.accepts) || s.accepts.indexOf("armor") < 0) continue;
      const p = s.position || [0, 0, 0];
      const len = Math.hypot(p[0], p[1], p[2]);
      if (len < 1e-6) continue;
      out.push({ id: s.id, dir: [p[0] / len, p[1] / len, p[2] / len] });
    }
    return out;
  }

  /**
   * The mount strength this part hangs on, cached so the contact loop does not
   * re-read a component per contact. Authored per socket by the assembler and
   * weakened when the part becomes `damaged`.
   */
  function jointBreakForce(call, e) {
    const j = call("scene.getComponent", { entity: e, component: "Joint" });
    if (!j || j.isError || !j.content || !j.content.joints.length) return 0;
    return j.content.joints[0].breakForce || 0;
  }

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
          category: "chassis", hp, maxHp: hp, state: "intact", armorTier: "none", isChassis: true,
          sockets: (def && def.sockets) || [], armorSockets: armorFaces(def) });
        if (!bots.has(role)) bots.set(role, newBot(e));
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
        state: "intact", armorTier: def.armorTier || "none", isChassis: false,
        breakForce: jointBreakForce(call, e) });
      if (!bots.has(role)) bots.set(role, newBot(0));
      const bk = bots.get(role);
      if (def.category === "wheel" && !bk.wheels.has(socketId)) bk.wheels.set(socketId, { state: "intact" });
      if (def.category === "motor" && !bk.motors.has(socketId)) bk.motors.set(socketId, { state: "intact" });
    }
    // forget entities that no longer exist (culled debris, scene reload)
    for (const e of [...parts.keys()]) if (!seen.has(e)) parts.delete(e);
  }

  /** Which track a wheel socket sits on — by its x offset, falling back to its id. */
  function sideOfSocket(role, socketId) {
    const bot = bots.get(role);
    const chassisRec = bot && bot.chassis ? parts.get(bot.chassis) : null;
    for (const s of (chassisRec && chassisRec.sockets) || []) {
      if (s.id !== socketId) continue;
      if (s.position && s.position[0] !== 0) return s.position[0] < 0 ? "left" : "right";
      break;
    }
    return /_(fl|rl)$/.test(socketId) ? "left" : "right";
  }

  /**
   * Per-side drive authority, written into BotDrive params (T-3.6, T-5.4).
   *
   *   wheel  damaged   -> contributes damagedDriveTorqueMultiplier to its side
   *          destroyed -> contributes nothing to its side
   *   motor  damaged   -> BOTH sides scaled by damagedMotorOutputMultiplier
   *          destroyed -> drive dead
   *
   * The motor is the whole drivetrain, so it multiplies both tracks rather than
   * averaging into one. Its state is the worst of any fitted motor — a bot carrying
   * two of them is not rescued by the healthy one.
   */
  function refreshDrive(call, role) {
    const bot = bots.get(role);
    if (!bot || !bot.chassis) return;
    const side = { left: [], right: [] };
    for (const [socketId, w] of bot.wheels) side[sideOfSocket(role, socketId)].push(w);
    const authority = (list) => {
      if (!list.length) return 0;
      let sum = 0;
      for (const r of list) {
        sum += r.state === "destroyed" ? 0 : r.state === "damaged" ? dmg.damagedDriveTorqueMultiplier : 1;
      }
      return sum / list.length;
    };
    let motorFactor = 1;
    for (const m of bot.motors.values()) {
      const f = m.state === "destroyed" ? 0 : m.state === "damaged" ? dmg.damagedMotorOutputMultiplier : 1;
      if (f < motorFactor) motorFactor = f;
    }
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
          driveLeft: authority(side.left) * motorFactor,
          driveRight: authority(side.right) * motorFactor,
        }),
      },
    });
  }

  function bodyStateOf(call, entity) {
    if (bodyCache.has(entity)) return bodyCache.get(entity);
    const r = call("physics.bodyState", { entity });
    const b = r && !r.isError ? r.content : null;
    bodyCache.set(entity, b);
    return b;
  }

  /**
   * How much of an incoming hit the STRUCK part shrugs off (T-3.3, T-5.4).
   *
   * An ordinary part uses its own tier, halved once it is `damaged` — the "reduced
   * protection" leg of the degradation table.
   *
   * The CHASSIS is directional. It has no tier of its own; what protects it is the
   * plate on the face that was actually struck, found by taking the contact point
   * into chassis-local space and matching it against the chassis' own armour socket
   * offsets. Shear the front plate off a wedge and its nose is bare while its flanks
   * stay covered — that is what "hitbox exposed" has to mean mechanically, and it is
   * what makes a plate worth defending rather than just worth its own hp. A hit that
   * matches no face (the roof, or underneath) is unprotected, which is correct: no
   * socket on any chassis points that way.
   */
  function armorReductionFor(call, victim, victimEntity, point) {
    const tiered = (rec) => {
      const base = dmg.armorReduction[rec.armorTier] || 0;
      return rec.state === "damaged" ? base * dmg.damagedArmorReductionMultiplier : base;
    };
    if (!victim.isChassis) return tiered(victim);

    const faces = victim.armorSockets;
    if (!faces || !faces.length || !point) return 0;
    const body = bodyStateOf(call, victimEntity);
    if (!body || !body.rotation || !body.position) return 0;
    const q = [body.rotation.x, body.rotation.y, body.rotation.z, body.rotation.w];
    const local = invRotate(q, [
      point.x - body.position.x, point.y - body.position.y, point.z - body.position.z,
    ]);
    const len = Math.hypot(local[0], local[1], local[2]);
    if (len < 1e-6) return 0;

    let bestId = null;
    let bestDot = dmg.armorCoverageDotMin;
    for (const f of faces) {
      const d = (local[0] * f.dir[0] + local[1] * f.dir[1] + local[2] * f.dir[2]) / len;
      if (d > bestDot) { bestDot = d; bestId = f.id; }
    }
    if (!bestId) return 0;

    for (const rec of parts.values()) {
      if (rec.role !== victim.role || rec.category !== "armor" || rec.socketId !== bestId) continue;
      // A destroyed plate has already left the bot (it is debris until it is culled),
      // so the face it was covering is open.
      return rec.state === "destroyed" ? 0 : tiered(rec);
    }
    return 0; // nothing fitted on that face — bare from the start
  }

  function setColor(call, entity, color) {
    const r = call("scene.getComponent", { entity, component: "MeshRenderer" });
    if (r && !r.isError && r.content) call("scene.setComponent", { entity, component: "MeshRenderer", patch: { color } });
  }

  /** intact -> damaged -> destroyed, with the mechanical consequences (T-3.5, T-3.6, T-5.5). */
  function applyState(call, engine, entity, rec, next, reason) {
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
        rec.breakForce = joints[0].breakForce || 0;
      }
    } else if (next === "destroyed") {
      setColor(call, entity, COL_DESTROYED);
      if (BREAKABLE.has(rec.category)) {
        // Detach: drop the Joint so the part becomes free arena debris (T-5.2).
        // Detaching rather than hiding is deliberate — a part that mechanically
        // left the bot should be visible on the floor, which reads better than
        // something vanishing.
        const j = call("scene.getComponent", { entity, component: "Joint" });
        if (j && !j.isError && j.content) call("scene.removeComponent", { entity, component: "Joint" });
        rec.breakForce = 0;
        debris.set(entity, 0);
        engine.mcp.emit("battlebots.partDetached", {
          entity, role: rec.role, socketId: rec.socketId, partId: rec.partId,
          category: rec.category, reason: reason || "damage",
        });
      }
    }

    engine.mcp.emit("battlebots.partState", {
      entity, role: rec.role, socketId: rec.socketId, partId: rec.partId, state: next,
    });
    engine.console.log("[Damage] " + rec.role + "/" + rec.socketId + " (" + rec.partId + ") -> " + next
      + (reason ? " [" + reason + "]" : ""));

    const bot = bots.get(rec.role);
    if (bot && rec.category === "wheel" && bot.wheels.has(rec.socketId)) bot.wheels.get(rec.socketId).state = next;
    if (bot && rec.category === "motor" && bot.motors.has(rec.socketId)) bot.motors.get(rec.socketId).state = next;
    if (rec.category === "wheel" || rec.category === "motor") refreshDrive(call, rec.role);
    checkKnockout(call, engine, rec.role);
  }

  /** Immobilised, or chassis destroyed, ends the match for that bot (T-3.7). */
  function checkKnockout(call, engine, role) {
    const bot = bots.get(role);
    if (!bot || bot.knockedOut) return;

    let chassisDead = false;
    for (const rec of parts.values()) {
      if (rec.role === role && rec.isChassis && rec.state === "destroyed") chassisDead = true;
    }
    // Counted off the socket registry rather than live entities, so a wheel whose
    // entity has been culled still counts as lost rather than simply forgotten.
    let wheelsAlive = 0;
    for (const w of bot.wheels.values()) if (w.state !== "destroyed") wheelsAlive++;
    let motorsAlive = 0;
    for (const m of bot.motors.values()) if (m.state !== "destroyed") motorsAlive++;
    // Both ways a bot stops moving: too few wheels left to drive on, or the drive
    // motor itself killed. The motor leg is what makes the degradation table's
    // "drive dead" an end state instead of a bot that sits still spinning its weapon
    // until the clock runs out.
    const immobilised = (bot.wheels.size > 0 && wheelsAlive < 2)
      || (bot.motors.size > 0 && motorsAlive === 0);
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
      // Poses are read for directional armour and are only valid for this step.
      bodyCache.clear();

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

      // Debris lifetime (T-5.3). A detached part stays dynamic and interactive for
      // a while — it is arena clutter you can shove and be tripped by — then it is
      // culled so a long match cannot grow the body count without bound. Deleting a
      // Script-bearing entity from a hook is safe now that BUG-011 is fixed, which
      // matters because a detached weapon still carries its WeaponController.
      if (debris.size) {
        let oldest = 0;
        let oldestAge = -1;
        for (const [ent, age] of debris) {
          const next = age + dt;
          debris.set(ent, next);
          if (next > oldestAge) { oldestAge = next; oldest = ent; }
        }
        const overCap = debris.size > DEBRIS_CAP;
        for (const [ent, age] of Array.from(debris)) {
          if (age <= dmg.debrisLifetimeSeconds && !(overCap && ent === oldest)) continue;
          debris.delete(ent);
          parts.delete(ent);
          call("scene.deleteEntity", { entity: ent });
          engine.mcp.emit("battlebots.debrisCulled", { entity: ent, ageSeconds: Math.round(age * 10) / 10 });
        }
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

        const strike = (striker, victim, victimEntity, strikerEntity, point) => {
          if (victim.state === "destroyed") return;

          // Force shear (T-5.1, T-5.5). `Joint.breakForce` is accepted and echoed
          // back by the engine but never evaluated, and `physics.jointBroken` never
          // fires (BUG-013) — so a big enough hit is resolved here instead, from the
          // same contact force the damage math already has. Without this the whole
          // breakForce table is decorative and a weakened mount never actually
          // shears, which is the mechanic T-5.5 exists to provide.
          if (BREAKABLE.has(victim.category) && victim.breakForce > 0 && force >= victim.breakForce) {
            victim.hp = 0;
            applyState(call, engine, victimEntity, victim, "destroyed", "sheared");
            return;
          }
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
          const reduction = armorReductionFor(call, victim, victimEntity, point);
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

        // Each side strikes the other. Both are handed the same contact point — which
        // face it landed on is answered per victim, in that victim's own frame.
        strike(A, B, c.b, c.a, c.point);
        strike(B, A, c.a, c.b, c.point);
      }
    },
  };
}
