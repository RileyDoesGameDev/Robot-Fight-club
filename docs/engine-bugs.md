# SMPL-Engine — bugs & limitations hit while building Battle Bots

Issues in the engine itself (or its Docker stack / MCP bridge) that blocked, slowed, or misled game
work. This is the **filable** list — one entry per problem, with a repro and the workaround actually
used. It is deliberately separate from [engine-notes.md](engine-notes.md), which documents how to use
the engine *correctly*; this file is what should be fixed.

Engine source referenced: `C:\Users\KOBI 2\Documents\Kobi\3d-game-engine-mcp-native`.

---

## ✅ All closed — 2026-08-20 · ⚠️ one new bug filed since

Every one of the original 12 BUG entries and 3 of the 5 LIM entries below has been fixed.
**BUG-013 was filed 2026-08-20 after the fixes** and is open: `Joint.breakForce` is stored
but never evaluated, so `physics.jointBroken` never fires. It blocks the whole
force-driven destruction design (week 5).
See [engine-fixes.md](../engine-fixes.md) for what changed and what to re-test.
The entries are kept as filed, because the reasoning and repros are still the
record of how each was found.

Confirmed working on our side after the fixes:

- `ctx.call` replaced the `toolMap` workaround in `BotDrive`; `physics.*` is on
  the bridge; `maxStringChars` returned a 10 KB scene in one call instead of 12
  chunks; `scene.validate`'s new geometry checks **found a real bug in our own
  data** (wheels drawn 0.08 m thick but colliding as a 0.24 m sphere — 3×
  divergence, now fixed).
- Two of the fixes changed our design directly: the damage model became
  force-based because contact force is now reported reliably, and
  `WorkshopController`'s 3-frame state machine became redundant.

Three decisions were handed back to us. Answers below.

### BUG-002 — should `applyTorque` become continuous? **No — add a verb instead**

Keep `physics.applyTorque` exactly as it is. The behaviour was never wrong, only
undocumented, and that is now fixed.

Making it continuous is a silent 60× magnitude change for every existing caller,
and the failure mode is "the bot spins wildly" — the same class of bug that BUG-001
and BUG-002 already cost days on. Our `BotDrive` sizes `TURN_TORQUE` in N·m and
converts at the call site; that line would keep compiling and start lying.

If the asymmetry is worth closing, close it **additively**: add
`physics.applyTorqueContinuous` (N·m, per-step, mirroring `applyForce`) and leave
`applyTorque` meaning what it means today. Nobody breaks, and the namespace ends up
coherent. A rename buys tidiness at the cost of a class of bug that is genuinely
hard to spot.

### LIM-002 — scripts importing each other: **real ESM, but not yet**

Don't build it now. `ctx.call` and `Script.params` removed both reasons we routed
everything through a spawner marker, and we have no duplicated logic left that
imports would delete — the marker indirection is now a *data-driven* choice we would
keep anyway.

When it is built, build the **real-ESM-over-blob-URLs** option. "Scripts can import
each other" implies one module instance and shared state; bundle-per-script would
hand two behaviours two copies of the same counter, which is a bug generator that
looks like working code. Better to not have imports than to have ones that lie
about identity.

The concrete trigger to revisit: **week 4's weapon controllers** (T-4.1 – T-4.5),
where four weapon types will want to share spin-up/jam/cooldown math. That is the
first genuine shared-library need on our roadmap. If it lands before then we will
use it; if not, one controller with a switch is an acceptable stand-in.

### LIM-004 — `createOnDisk` sidecar: **don't build it for us**

The repo-as-source-of-truth workflow works, is committed, and gives us history and
diffs that a disk-backed project would not add to. A `POST /project` endpoint that
writes arbitrary host paths is a new trust surface for a convenience we have already
paid for another way.

If it is built for other users, gate it on a rooted, allowlisted base directory with
path containment — an MCP verb that can write anywhere on the host is worth more
caution than the ergonomics justify. For Battle Bots: keep the export step.

**Severity:** 🔴 blocker/data-corrupting · 🟠 wrong behaviour with a workaround · 🟡 papercut / docs

---

## BUG-001 🔴 `physics.applyForce` latches forever — force accumulates every call

**Where** `packages/engine-core/src/physics/physics-system.ts:930`

`applyForce` calls Rapier's `body.addForce(force, true)`, and **`resetForces()` is never called
anywhere in the engine.** Rapier's `addForce` adds to a *persistent* accumulator that survives every
subsequent step, so each call permanently raises the standing force on the body.

**Repro** Call `physics.applyForce({ entity, force: {x:0,y:0,z:-2600} })` once per fixed step on a
70 kg body, as any drivetrain would:

| step | speed |
|---|---|
| 0 | 81 m/s |
| 1 | 162 m/s |
| 2 | 242 m/s |
| 3 | 322 m/s |

Acceleration is constant at ~4860 m/s² — i.e. ~340 kN of standing force, 130× what was asked for. It
keeps accelerating **after the script that called it is disabled**, and the only cure is destroying the
body (reload the scene).

**Why it's a real bug, not just a doc error** The tool description says *"Add a force to a body for the
next step"*, which is the semantics a caller reasonably assumes. Either the description or the
implementation is wrong. Two candidate fixes: call `resetForces()` at the top of each step so the force
is genuinely per-step, or rename/redocument it as a latching force and add `physics.resetForces`.

**Cost to us** Half a day. The runaway looked exactly like a joint-solver explosion, and because it
persisted after disabling the script it read as an engine physics bug rather than a caller error.

**Workaround** Use `physics.applyImpulse` / `physics.applyTorque` (per-step, correct) and convert
`impulse = force × dt`. Documented in `BotDrive.ts`.

---

## BUG-002 🟠 `physics.applyTorque` is a torque *impulse*, but is not named or documented as one

**Where** `physics-system.ts:934` — the tool `physics.applyTorque` maps to `applyTorqueImpulse`.

Sizing a value as continuous torque overshoots by roughly `1/dt` (60×). Combined with BUG-001 this made
the first drivetrain unusable in two independent ways at once.

**Fix** Rename the tool `physics.applyTorqueImpulse`, or document the units as N·m·s.

---

## BUG-003 🟠 `physics.*` tools register lazily, and the failure message is misleading

The physics provider only exists after physics has been initialised (the editor wires
`ensurePhysics: () => setRunning(true)` in `packages/editor/src/engine/runtime.ts:634`). Before the
first play-mode enable, `engine.mcp.hasTool("physics.bodyState")` is `false` and `callTool` rejects with:

```
unknown MCP tool: physics.bodyState
```

**Why that's bad** "Unknown tool" reads as a typo or a version mismatch, not "physics is not up yet".
A gameplay script that starts before physics does throws once per frame — we accumulated 124 buffered
`unhandled rejection` errors before diagnosing it.

**Fix** Either register the provider at boot with handlers that fail loudly on "physics not
initialised", or make the rejection say so.

---

## BUG-004 🟠 A script cannot reach physics through the documented async API

`engine.mcp.callTool` is `async`, but `ScriptBehavior.onFixedUpdate` is synchronous and returns `void`.
So inside a fixed step:

- `await callTool(...)` — impossible, the hook is not async
- `callTool(...)` unawaited — returns a `Promise`; reading `.content` on it yields `undefined`

The second is a **silent** failure. Our first `BotDrive` read `bodyState(...).content`, got `undefined`,
hit its `if (!body) return;` guard, and did nothing at all, every frame, with no error.

**Workaround** Pull the *synchronous* handlers out of `engine.mcp.toolMap` once in `onStart` and call
them directly. This works well but is undocumented, and it bypasses zod parsing so schema defaults
silently stop applying.

**Fix** Either give `ScriptContext` a documented synchronous accessor for physics
(`ctx.physics.applyImpulse(...)`), or document `toolMap` as the supported in-script path.

**Second occurrence — the lost zod defaults are the sharper edge.** Building the Workshop UI,
`ui.createTree({ spec })` was called through `toolMap` without an explicit `visible`. Its schema says
`visible: z.boolean().default(true)`, but no zod ran, so the canvas was created with
`visible: undefined` — i.e. **hidden**. Every button then failed with `button 113 is on hidden canvas
106`, which points at the UI rather than at the missing default. Any tool with a schema default is a trap
on this path, and there are many.

**Fix** If `toolMap` is the sanctioned in-script route, expose entries whose handlers parse their input,
so direct calls and MCP calls behave identically.

---

## BUG-005 🟡 `physics.*` is absent from the MCP bridge catalog

The bridge exposes ~380 tools with **no `physics_*` namespace**, so an external agent cannot read or
write physics at all — every physics read during week 1 had to be laundered through `script.eval`.

Possibly deliberate (capability gating), but it makes agent-driven physics work substantially harder
than the rest of the engine, and the proposal's ~178-tool figure is also stale.

---

## BUG-006 🟠 `script.eval` truncates returned strings to 1000 chars, ignoring `maxChars`

Passing `maxChars: 400000` still yields:

```
"string at $: kept 1000 of 15376 chars"
```

`maxChars` appears to bound the *total* projection but not any single string, so there is no way to
return one large string — which is the natural way to export a file from the project filesystem.

**Workaround** Slice the string into sub-1000-char chunks and return an array, then reassemble.
Every scene export in this project does this.

**Fix** Let `maxChars` raise the per-string cap, or add `maxStringChars`.

---

## BUG-007 🟠 Editor and runtime containers report `unhealthy`

```
engine-runtime   Up (unhealthy)   0.0.0.0:4173->8080/tcp
engine-editor    Up (unhealthy)   0.0.0.0:4174->8080/tcp
engine-deployer  Up (healthy)     0.0.0.0:4180->9000/tcp
```

Both serve correctly — the editor has been used for this entire project on `:4174`. So the healthcheck
itself is wrong. Harmful because it trains you to ignore health status, and it would break any
`depends_on: condition: service_healthy` orchestration.

---

## BUG-008 🟠 The MCP bridge dies and does not recover

Twice in one session the bridge went away: all 380 tools vanished mid-task and `ws://localhost:8765`
stopped listening, while `:4174` kept serving fine. `engine_status` then reports
`engineConnected: false`.

Once it was self-inflicted — `project.open` reloads the editor page, which drops the socket — but the
second was unprompted. Recovery needs an out-of-band MCP reconnect plus re-enabling **Expose** in the
editor's MCP tab; nothing in-session can restart it.

**Fix** Auto-reconnect on the editor side, and have `project.open` warn that it will drop the bridge.

---

## BUG-009 🟡 `viewport.frameEntities` fails on a group entity instead of framing its children

```
viewport.frameEntities({ entities: [21] })   // 21 = "Arena", a transform group with 11 children
→ error: no renderable geometry for entities [21]
```

Framing a parent is the obvious way to frame a subtree. It should union its descendants' bounds rather
than erroring.

**Workaround** List the leaf entities explicitly.

---

## BUG-010 🟡 Colliders ignore `Transform.scale` while visuals honour it

`ColliderDesc.cuboid(halfExtents...)` receives `Collider.halfExtents` raw
(`physics-system.ts:2150`), but the rendered primitive *is* scaled by `Transform.scale`. So a greybox
box needs its size maintained in two places that can silently disagree, and a scaled entity's collider
does not match what you see.

Defensible as a design choice, but it is documented nowhere, and `scene.validate` does not flag a
visual/collider size mismatch. Combined with children inheriting `Transform.scale`, it forced a
body/visual split on every part (see `DESIGN.md` §3).

**Fix** Document it on `Collider`, and consider a `scene.validate` check for a large visual/collider
size divergence.

---

## BUG-011 🔴 Deleting a `Script`-bearing entity from inside a script hook crashes the frame loop

**Where** `packages/engine-core/src/scripting/script-system.ts:174-176`

```ts
for (const entity of world.query(["Script"])) {
  const script = world.getComponent(entity, Script)!;   // <-- non-null assertion
  if (!script.enabled || script.behavior === "") continue;
```

The `!` assumes every entity yielded by the query still has a gettable `Script`. If a script hook deletes
a Script-bearing entity, the in-progress iteration yields an entity whose component is gone and the
engine throws, killing the whole frame:

```
TypeError: Cannot read properties of undefined (reading 'enabled')
  at ScriptSystem.frameUpdate
  at Scheduler.runFrame
  at Engine.stepFrames
```

**Repro** From any script's `onStart`/`onUpdate`, `scene.deleteEntity` an entity that has a `Script`
component. Every subsequent `engine.stepFrames` throws. Note the teardown loop just above (line 167)
*does* guard with `!script`, so the unsafe assertion is inconsistent with the code right next to it.

**Why it hurts** "Spawn a thing that builds itself, then replace it" is an ordinary pattern, and any
script-driven object pool or respawn hits it. The error names neither the entity nor the script, so it
reads as an engine-internal fault rather than something the caller did.

**Fix** One line: `const script = world.getComponent(entity, Script); if (!script || !script.enabled …)
continue;`

**Workaround** (used by `WorkshopController.ts`) Never delete a Script entity from a hook. Create the
spawner marker once, and to re-run it set `Script.enabled = false` on one frame and `true` on the next —
ScriptSystem then tears the instance down and builds a fresh one, so `onStart` runs again. Only
Script-free bodies are ever deleted. Costs a 3-frame state machine for what should be one call.

**Confirmed safe, for contrast (2026-08-20)** `project.loadScene` *from* a script hook is fine, even
though it destroys every Script entity in the scene including the caller. The reload path drops the
ScriptSystem's instances on `world.reloaded` rather than mutating the world mid-iteration, so the frame
loop survives and keeps stepping. We rely on this: `MatchDirector` and `DemoCenterController` switch
scenes directly from their `ui.clicked` handlers (T-6.2), which is why the deferred-request queue we had
budgeted for scene flow was never needed. Worth a test that pins the behaviour, since the two paths look
identical from a script author's seat and only one of them works.

---

## BUG-012 🟠 `renderer.captureScreenshot` silently returns a blank image when no viewport is attached

With no editor viewport attached, `captureScreenshot` succeeds and writes a valid PNG that is entirely
flat background — 2901 bytes for 460×218 of nothing. Nothing in the result says the capture was empty.

The same host condition is reported correctly on the other path:

```
captureScreenshot({ colliders: true })
→ error: mode / colliders need a viewport that supports capture modes and this host has none
```

So the failure is already detectable; the plain path just doesn't check. A blank PNG is worse than an
error because it looks like a rendering or lighting problem in *your* scene, and it costs a round of
debugging the wrong thing.

**Fix** Refuse the capture (or flag `empty: true` in the result) when no viewport is attached, matching
the `mode`/`colliders` behaviour.

**Side note** `viewport.*` reports "no editor viewport attached — open the Scene tab" for the same
condition, so the diagnosis exists; only `captureScreenshot` hides it.

---

## BUG-013 🔴 `Joint.breakForce` is never evaluated — `physics.jointBroken` never fires

**Status** OPEN, filed 2026-08-20.

`breakForce` is accepted on a `Joint`, persisted, and echoed back correctly by
`physics.listJoints` — including updates written later via `scene.setComponent`, which we
verified propagate to the live joint. But no break check ever runs: the joint holds
under arbitrary load, and the `physics.jointBroken` channel (declared in
`events.listChannels` as *"A joint exceeded its breakForce threshold and was removed"*)
never emits.

**Repro** — two 5 kg boxes, one fixed joint, `breakForce: 100`, then a **50 000 N·s**
impulse:

    a = createEntity(dynamic box, mass 5, at [20, 5.0, 0])
    b = createEntity(dynamic box, mass 5, at [20, 5.5, 0])
    addComponent(b, "Joint", { joints: [{ kind: "fixed", b: a,
        anchorB: [0, 0.5, 0], breakForce: 100 }] })
    stepFrames(5)
    applyImpulse(b, { x: 0, y: 50000, z: 0 })
    stepFrames(10)

Result: joint still present with `breakForce: 100`, separation **exactly 0.500 m**
(unchanged from authored), `physics.jointBroken` events: **0**.

Also reproduced on real content: dropping all 12 mounts of an assembled 162 kg bot to
`breakForce: 1` and yanking a wheel with 6 000 N·s broke nothing.

**Why it hurts** This is the single feature the destruction design rests on. Our
`DESIGN.md` §6 opens with *"no fracture solver is needed — `Joint.breakForce` ships
natively"*, which is how the proposal's "custom breakable-joint system" got scoped down
to configuration plus event handling. With the check missing:

- the whole authored `breakForce` table (2 500 N armour / 4 000 N wheel / 9 000–12 000 N
  weapon mounts) is decorative;
- T-5.5's progressive weakening — halving a damaged part's `breakForce` so accumulated
  hits eventually shear it off — applies the multiplier to nothing;
- T-5.2 as written ("subscribe to `physics.jointBroken` and drive the detachment
  sequence") is not implementable at all.

The failure is silent in the worst way: every value round-trips, so the feature looks
wired up from the caller's seat and only a deliberate over-force test reveals it.

**Workaround** (in `DamageSystem.ts`) Enforce it ourselves. The contact loop already
reads `maxForce` per contact for the damage math, so a part whose contact force exceeds
its cached mount strength is detached on the spot — `hp = 0`, drop the `Joint`, mark it
debris. That restores the mechanic and costs nothing extra, but it is an approximation:
contact force on the *part* is not the same as the *joint's* solver impulse, so a part
levered off slowly by a sustained load will not shear the way a real constraint check
would. Only impact shears work.

**Fix** Compare each joint's solver impulse against `breakForce × timestep` after the
solve, remove the joint when it exceeds, and emit `physics.jointBroken` with
`{ joint, a, b, force }`. A test that authors a joint and over-forces it would have
caught this — worth adding alongside, since the channel and the field both already exist
and only the check is missing.

---

## LIM-005 🟡 `MeshRenderer` cylinders and Rapier cylinders disagree on their axis

`MeshRenderer.primitive` documents `'cylinder'` as **Z-axis aligned (URDF convention)**, while Rapier's
cylinder collider is Y-aligned. A cylinder entity therefore cannot have its visual and its collider agree
without an offset rotation, and nothing warns about it.

Unverified from a screenshot because of BUG-012, so the Workshop turntable ships as a box rather than a
cylinder to avoid committing something that might be visibly wrong.

---

## LIM-001 🟡 `script.attach` accepts no per-instance parameters, and there is no generic data component

Two behaviours of the same script cannot be configured differently. The registered components
(`components.ts`) include no generic key/value or tag component, so there is nowhere to put
per-instance config.

**Workaround** Encode parameters in the `Name` component and parse them:
`BotSpawn:player-slice:player`. It works and survives serialization, but it abuses a display field and
collides with using names for lookup.

**Fix** Either a `params` field on the `Script` component, or a generic `Blackboard`/`Tag` component.

---

## LIM-002 🟡 Scripts cannot import each other

Each script source is an isolated module registered by id, so shared logic must be duplicated across
behaviours. We avoided duplicating the assembler only by routing every caller through a spawner marker
that re-enters `BotAssembler` — indirection that exists purely to work around the lack of imports.

**Fix** Allow `import` between registered script sources, or expose a shared module registry.

---

## LIM-003 🟡 Editor viewport ignores scene lighting

`renderer.captureScreenshot` shades with the viewport's own preview lighting, so authored `Light`
components have almost no visible effect. Lighting cannot be validated from the editor at all — it has
to be checked in the deployed runtime on `:4173`.

**Fix** A viewport toggle to shade with scene lights.

---

## LIM-004 🟡 `project.createOnDisk` cannot be used by an agent

It requires an OS folder picker behind a user gesture, so an agent-driven project can only live in
browser IndexedDB — which is not a safe home for work. This is the whole reason this repo, rather than
the engine project, is the source of truth (see `README.md`).

**Fix** A path-argument variant for headless/agent use.
