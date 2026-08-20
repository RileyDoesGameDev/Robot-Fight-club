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
 *   Bot_<role>_Chassis            unit-scaled body: Collider + RigidBody + Script
 *     Bot_<role>_ChassisVisual    child carrying the non-uniform visual scale
 *   Bot_<role>_<socket>_<partId>  one dynamic body per attached part, joined to
 *                                 the chassis by a BREAKABLE joint (T-5.1)
 *
 *   Every part is its own rigid body so it can be damaged and sheared off. Part
 *   bodies carry their visual directly (they have no children, so a non-uniform
 *   Transform.scale is safe there — unlike the chassis, whose socket children
 *   would inherit and be distorted by it).
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

  const chassis = createEntity({
    components: {
      Name: { value: "Bot_" + role + "_Chassis" },
      Transform: { position: p, rotation: q, scale: [1, 1, 1] },
      Collider: colliderFor(chassisDef.colliderSpec, contactThreshold),
      RigidBody: rigid,
    },
  }).content.entity;

  const visual = createEntity({
    components: {
      Name: { value: "Bot_" + role + "_ChassisVisual" },
      Transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: chassisDef.visualScale },
      MeshRenderer: { primitive: chassisDef.primitive || "box", color: primary },
    },
  }).content.entity;
  reparent({ child: visual, parent: chassis });

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

    // A powered spinner rides a revolute joint with a velocity motor; the
    // WeaponController (T-3.9) ramps targetVelocity. Everything else is welded.
    // Either way the joint is breakable, which is what detaches the part (T-5.2).
    const wstats = def.stats || {};
    const powered = def.category === "weapon" && wstats.axis && wstats.targetRpm;
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
      motor: powered
        ? {
            targetVelocity: 0, // the weapon controller spins it up
            maxForce: wstats.motorMaxForce != null ? wstats.motorMaxForce : 500,
            stiffness: 0,
            damping: 0,
            targetPosition: null,
          }
        : null,
    };
    addComponent({ entity, component: "Joint", data: { joints: [link] } });

    // A powered weapon gets its own controller (T-3.9). autoSpin for anyone who is
    // not the player, so the opponent's weapon runs until AiDriver lands (T-3.13).
    if (powered) {
      attach({
        entity,
        behavior: "WeaponController",
        enabled: true,
        params: { role, partId: a.partId, autoSpin: role !== "player" },
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
  const inert = role === "workshop" || role === "select";
  if (!inert) {
    attach({
      entity: chassis,
      behavior: "BotDrive",
      enabled: true,
      params: { inputDriven: role === "player" },
    });
  }

  // Anyone who is not the player gets a brain. It is a CHILD entity because an
  // entity can hold only one Script and the chassis already carries BotDrive.
  if (!inert && role !== "player") {
    const brain = createEntity({
      components: {
        Name: { value: "Bot_" + role + "_Brain" },
        Transform: { position: [0, 0.4, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      },
    }).content.entity;
    reparent({ child: brain, parent: chassis });
    attach({ entity: brain, behavior: "AiDriver", enabled: true, params: { role, target: "player" } });
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
