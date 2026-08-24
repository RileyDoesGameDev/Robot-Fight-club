/**
 * BotAssembler — turns a BotBlueprint into a live, breakable bot. (T-2.9)
 *
 * HOW IT IS DRIVEN
 *   Attach this behavior to an empty "spawner" marker entity whose Transform is
 *   the spawn pose and whose Name encodes the parameters:
 *
 *       BotSpawn:<blueprintId>:<role>          e.g. BotSpawn:player-slice:player
 *
 *   `Name` is the parameter channel because `script.attach` takes no per-instance
 *   arguments and the ECS has no generic key/value component. On success the
 *   marker renames itself to `BotSpawned:...`, which makes assembly idempotent:
 *   re-loading a scene that already contains a baked bot will not duplicate it.
 *
 * WHY NOT PREFABS (deviation from T-2.5 - T-2.8 as written)
 *   T-2.4 made the PartDef JSON the single source of truth for sockets. Authoring
 *   prefabs too would duplicate every mass, collider and socket in a second place
 *   that has to be regenerated whenever the JSON changes. So the assembler builds
 *   entities directly from `data/bundle.json`. T-2.5 - T-2.8 are superseded.
 *
 * STRUCTURE PRODUCED
 *   Bot_<role>_Chassis            body: Collider + RigidBody + MeshRenderer + Script
 *   Bot_<role>_<socket>_<partId>  one dynamic body per attached part, joined to
 *                                 the chassis by a BREAKABLE joint (T-5.1)
 *
 *   Every part is its own rigid body so it can be damaged and sheared off, and every
 *   body carries its own visual directly. Nothing here relies on parent transforms:
 *   the renderer does not fold them, so anything drawn from a child entity lands at
 *   the world origin instead of on its parent (BB-010).
 *
 *   The partId is encoded in the entity Name so the damage system can recover a
 *   part's hp/armorTier from the bundle without a component to store it in.
 */

const BUNDLE_PATH = "/data/bundle.json";

// Greybox palette. Real paint arrives with the material pass (T-4.11).
const COLOR_NEUTRAL = 0x22222a; // wheels, motors
const COLOR_FALLBACK = 0xcccccc;

function hexToInt(hex, fallback) {
  if (typeof hex !== "string") return fallback;
  const v = parseInt(hex.replace("#", ""), 16);
  return Number.isFinite(v) ? v : fallback;
}

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

/** Collider payload for a PartDef, filling only the fields its shape uses. */
function colliderFor(spec, contactThreshold) {
  const c = {
    shape: spec.shape,
    friction: spec.friction != null ? spec.friction : 0.5,
    restitution: spec.restitution != null ? spec.restitution : 0,
    contactForceEventThreshold: contactThreshold,
  };
  if (spec.shape === "box") c.halfExtents = spec.halfExtents;
  if (spec.radius != null) c.radius = spec.radius;
  if (spec.halfHeight != null) c.halfHeight = spec.halfHeight;
  return c;
}

/**
 * Build the bot. Returns a report describing what was created — the Workshop
 * stat panel (T-2.17) and the determinism gate (T-2.11) both read it.
 */
function assemble(engine, blueprintId, role, pose) {
  const tm = engine.mcp.toolMap;
  const H = (n) => tm.get(n).handler;
  const readFile = H("project.readFile");
  const createEntity = H("scene.createEntity");
  const addComponent = H("scene.addComponent");
  const reparent = H("scene.reparent");
  const attach = H("script.attach");

  const bundle = JSON.parse(readFile({ path: BUNDLE_PATH }).content.text);
  const parts = bundle.parts;
  // Resolve from the bundle first, then fall back to a standalone blueprint file
  // under /data/bots/. That fallback is what lets the Workshop preview an unsaved
  // draft through this same assembler instead of duplicating assembly logic — the
  // scripting layer has no imports, so duplication is the only alternative.
  let blueprint = bundle.bots[blueprintId];
  if (!blueprint) {
    try {
      blueprint = JSON.parse(readFile({ path: "/data/bots/" + blueprintId + ".json" }).content.text);
    } catch (err) {
      blueprint = null;
    }
  }
  if (!blueprint) throw new Error("unknown blueprint: " + blueprintId);

  const chassisDef = parts[blueprint.chassisId];
  if (!chassisDef) throw new Error("unknown chassis: " + blueprint.chassisId);

  const contactThreshold = bundle.damage.contactForceEventThresholdN;
  const primary = hexToInt(blueprint.paint && blueprint.paint.primary, COLOR_FALLBACK);
  const secondary = hexToInt(blueprint.paint && blueprint.paint.secondary, COLOR_FALLBACK);

  const p = pose.position;
  const q = pose.rotation;

  // ── chassis body ──────────────────────────────────────────────────────────
  // Explicit massProperties when the def supplies inertia, so the solver does
  // not derive a tall inertia tensor from the collider and make the bot tippy.
  const st = chassisDef.stats || {};
  const rigid = {
    type: "dynamic",
    linearDamping: 0.35,
    angularDamping: 2.5,
    ccdEnabled: true,
    canSleep: false,
  };
  if (st.principalAngularInertia) {
    rigid.massProperties = {
      mass: chassisDef.mass,
      centerOfMass: st.centerOfMassOffset || [0, 0, 0],
      principalAngularInertia: st.principalAngularInertia,
    };
  } else {
    rigid.mass = chassisDef.mass;
  }

  // The chassis carries its own visual, at its own non-uniform scale.
  //
  // This used to be a child entity (`Bot_<role>_ChassisVisual`) holding the scale, so
  // that socket children would not inherit and be distorted by it. That reasoning no
  // longer applies — attached parts are separate rigid bodies joined by physics, not
  // children — and the child was actively broken: **the renderer does not fold parent
  // transforms**, so a child at local [0,0,0] draws at the world ORIGIN rather than on
  // its parent. Both bots' chassis rendered on top of each other in the middle of the
  // arena, and each bot appeared as wheels and a weapon with no body.
  //
  // `Transform.scale` is safe to use here because colliders ignore it (engine-fixes.md
  // BUG-010) — the Collider keeps the size its spec asks for, exactly as it did when
  // the scale lived on the child. So this is the same geometry with one fewer entity
  // per bot and no dependency on hierarchy rendering.
  const chassis = createEntity({
    components: {
      Name: { value: "Bot_" + role + "_Chassis" },
      Transform: { position: p, rotation: q, scale: chassisDef.visualScale || [1, 1, 1] },
      Collider: colliderFor(chassisDef.colliderSpec, contactThreshold),
      RigidBody: rigid,
      MeshRenderer: { primitive: chassisDef.primitive || "box", color: primary },
    },
  }).content.entity;

  // ── attached parts ────────────────────────────────────────────────────────
  const sockets = {};
  for (const s of chassisDef.sockets || []) sockets[s.id] = s;

  const created = [];
  let totalMass = chassisDef.mass;

  for (const a of blueprint.attachments) {
    const def = parts[a.partId];
    const socket = sockets[a.socketId];
    if (!def) throw new Error("unknown part: " + a.partId);
    if (!socket) throw new Error(blueprint.chassisId + " has no socket " + a.socketId);
    if (!socket.accepts.includes(def.category)) {
      throw new Error("socket " + a.socketId + " rejects a " + def.category);
    }

    const local = socket.position;
    const world = rotate(q, local);
    const color =
      def.category === "wheel" || def.category === "motor"
        ? COLOR_NEUTRAL
        : def.category === "weapon"
          ? secondary
          : primary;

    const entity = createEntity({
      components: {
        Name: { value: "Bot_" + role + "_" + a.socketId + "_" + a.partId },
        Transform: {
          position: [p[0] + world[0], p[1] + world[1], p[2] + world[2]],
          rotation: q,
          scale: def.visualScale,
        },
        MeshRenderer: { primitive: def.primitive || "box", color },
        Collider: colliderFor(def.colliderSpec, contactThreshold),
        RigidBody: {
          type: "dynamic",
          mass: def.mass,
          angularDamping: def.category === "wheel" ? 0.4 : 0.2,
          ccdEnabled: true,
          canSleep: false,
        },
      },
    }).content.entity;

    // An ACTUATED weapon rides a revolute joint; everything else is welded. Either
    // way the joint is breakable, which is what detaches the part (T-5.2).
    //   spin  (T-3.9, T-4.1) a velocity motor WeaponController ramps to targetRpm
    //   swing (T-4.2, T-4.3) a position motor it drives between two angles
    // A passive wedge has no axis and gets a fixed joint - it wins on geometry
    // alone (T-4.4), so there is nothing to actuate and no controller to attach.
    const wstats = def.stats || {};
    const swing = wstats.mode === "swing";
    const powered = def.category === "weapon" && !!wstats.axis && (!!wstats.targetRpm || swing);
    const link = {
      kind: powered ? "revolute" : "fixed",
      mode: "impulse",
      b: chassis,
      anchorA: [0, 0, 0],
      anchorB: local,
      axis: powered ? wstats.axis : null,
      limits: null,
      distance: null,
      breakForce: socket.breakForce,
      contactsEnabled: false,
      // A swing weapon is authored parked at its rest angle with the position
      // motor already holding it there, so an axe does not flop on spawn.
      motor: powered
        ? (swing
            ? {
                targetVelocity: 0,
                maxForce: wstats.motorMaxForce != null ? wstats.motorMaxForce : 2000,
                stiffness: wstats.motorStiffness != null ? wstats.motorStiffness : 900,
                damping: wstats.motorDamping != null ? wstats.motorDamping : 60,
                targetPosition: wstats.restAngleRad != null ? wstats.restAngleRad : 0,
              }
            : {
                targetVelocity: 0, // the weapon controller spins it up
                maxForce: wstats.motorMaxForce != null ? wstats.motorMaxForce : 500,
                stiffness: 0,
                damping: 0,
                targetPosition: null,
              })
        : null,
    };
    addComponent({ entity, component: "Joint", data: { joints: [link] } });

    // A powered weapon gets its own controller (T-3.9). `autoSpin` is now only for
    // display roles — the select turntable and the Workshop preview, where a turning
    // blade is decoration. A fighting bot decides for itself: the player holds a key,
    // and an AI bot gets `spinCommand` written by UtilityAi (T-5.16).
    if (powered) {
      attach({
        entity,
        behavior: "WeaponController",
        enabled: true,
        params: { role, partId: a.partId, autoSpin: role === "workshop" || role === "select" },
      });
    }

    created.push({
      entity,
      socketId: a.socketId,
      partId: a.partId,
      category: def.category,
      mass: def.mass,
      hp: def.hp,
      breakForce: socket.breakForce,
      joint: link.kind,
    });
    totalMass += def.mass;
  }

  // ── controller ────────────────────────────────────────────────────────────
  // The opponent gets AiDriver once it exists (T-3.13); until then it is inert.
  // BotDrive is the actuation layer for EVERY driven bot. The player's reads the
  // keyboard; an AI bot's reads `intent` written by an AiDriver brain (T-3.13), so
  // the measured drive tuning lives in one file rather than being duplicated.
  // Display-only roles get no drivetrain and no brain. Keeping the list in one
  // place stops a new preview scene from silently acquiring an AI opponent.
  // Local multiplayer (T-6.6, T-6.9). The session decides whether the opponent seat
  // is a second human or the AI; the SCENE does not know, which is what lets Arena01
  // serve both modes unchanged.
  // Read through this function's own `readFile` handle, NOT `ctx.call` — there is no
  // `call` in this scope. assemble() predates it and reaches tools through
  // engine.mcp.toolMap, which is exactly the workaround T-2.24 is about; using
  // `call` here threw a ReferenceError that the catch below swallowed, so versus
  // silently never engaged and the opponent stayed an AI.
  let twoPlayer = false;
  let difficulty = "normal";
  try {
    const sess = JSON.parse(readFile({ path: "/data/session.json" }).content.text);
    twoPlayer = sess.players === 2;
    // T-7.8 — difficulty rides the session the same way the player count does, so
    // the options panel sets it once and every brain assembled afterwards picks it
    // up. Absent means normal, which is what an untouched install should play like.
    if (typeof sess.difficulty === "string") difficulty = sess.difficulty;
  } catch (err) {
    twoPlayer = false;   // no session file yet — single player
  }
  const humanSeat = role === "player" || (twoPlayer && role === "opponent");

  const inert = role === "workshop" || role === "select";
  if (!inert) {
    // T-4.10 — the fitted motor IS the drivetrain tuning. Resolved here, at assembly,
    // because this is the only place that knows the blueprint; BotDrive stays a pure
    // actuator that reads numbers rather than looking parts up. A bot with no motor
    // fitted falls back to 1.0 across the board rather than being undrivable.
    let mstats = {};
    for (const a2 of blueprint.attachments || []) {
      const d = parts[a2.partId];
      if (d && d.category === "motor") { mstats = d.stats || {}; break; }
    }
    attach({
      entity: chassis,
      behavior: "BotDrive",
      enabled: true,
      params: {
        inputDriven: humanSeat,
        playerIndex: role === "player" ? 1 : 2,
        driveForceMultiplier: mstats.driveForceMultiplier != null ? mstats.driveForceMultiplier : 1,
        turnTorqueMultiplier: mstats.turnTorqueMultiplier != null ? mstats.turnTorqueMultiplier : 1,
        maxSpeedMultiplier: mstats.maxSpeedMultiplier != null ? mstats.maxSpeedMultiplier : 1,
      },
    });
  }

  // Anyone who is not the player gets a brain. It is a CHILD entity because an
  // entity can hold only one Script and the chassis already carries BotDrive.
  // A seat with a human in it gets no brain — in versus BOTH seats are human.
  if (!inert && !humanSeat) {
    const brain = createEntity({
      components: {
        Name: { value: "Bot_" + role + "_Brain" },
        Transform: { position: [0, 0.4, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      },
    }).content.entity;
    reparent({ child: brain, parent: chassis });
    // UtilityAi scores its options against weights in data/ai/weights.json (T-5.17).
    // A blueprint can name its own temperament, so a bot's character is data rather
    // than a branch here; AiDriver remains in the repo as the scripted baseline.
    attach({ entity: brain, behavior: "UtilityAi", enabled: true,
      params: { role, target: "player", personality: blueprint.aiPersonality || "aggressive",
        difficulty } });
  }

  const cls = (bundle.weightClasses.classes || []).find((c) => totalMass <= c.maxMassKg);

  return {
    blueprintId,
    role,
    name: blueprint.name,
    chassis,
    visual,
    parts: created,
    totalMassKg: totalMass,
    weightClass: cls ? cls.id : "over-cap",
    declaredMassKg: blueprint.derived ? blueprint.derived.totalMassKg : null,
  };
}

export default function create() {
  return {
    onStart({ entity, engine, world }) {
      const tm = engine.mcp.toolMap;
      const getComp = tm.get("scene.getComponent").handler;
      const setComp = tm.get("scene.setComponent").handler;

      const nameComp = getComp({ entity, component: "Name" }).content;
      const raw = nameComp && nameComp.value ? nameComp.value : "";
      if (!raw.startsWith("BotSpawn:")) return; // already spawned, or not a marker

      const [, blueprintId, roleRaw] = raw.split(":");
      const role = roleRaw || "player";

      const t = getComp({ entity, component: "Transform" }).content;
      const pose = {
        position: t ? t.position : [0, 0, 0],
        rotation: t ? t.rotation : [0, 0, 0, 1],
      };

      try {
        const report = assemble(engine, blueprintId, role, pose);
        // Mark spent BEFORE anything else can re-enter, so a double onStart
        // (hot reload restarts instances) cannot build the bot twice.
        setComp({ entity, component: "Name", patch: { value: "BotSpawned:" + blueprintId + ":" + role } });
        engine.console.log(
          "[BotAssembler] " + report.name + " (" + report.blueprintId + ") " +
            report.totalMassKg + " kg " + report.weightClass + ", " +
            report.parts.length + " parts, chassis=" + report.chassis,
        );
      } catch (err) {
        engine.console.error("[BotAssembler] " + raw + " failed: " + err.message);
      }
    },
  };
}
