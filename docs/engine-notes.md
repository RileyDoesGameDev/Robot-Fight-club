# SMPL-Engine notes for Battle Bots

Engine behaviour discovered while building week 1, verified against the engine source at
`C:\Users\KOBI 2\Documents\Kobi\3d-game-engine-mcp-native` and by measurement in the live editor.
These are the things that cost time to find. Read this before writing a new gameplay script.

---

## 1. `physics.applyForce` latches — use impulses instead

**Symptom.** A drive script calling `physics.applyForce` once per fixed step ramped the bot from rest to
**322 m/s in four steps**, with no input held, reproducibly, and it kept accelerating after the script
was disabled.

**Cause.** `PhysicsSystem.applyForce` calls Rapier's `body.addForce(force, true)`, and the engine
**never calls `resetForces()`** anywhere. Rapier's `addForce` adds to a *persistent* force accumulator
that survives every subsequent step, so each call permanently increases the standing force on the body.
The tool description ("Add a force to a body for the next step") is wrong.

**Fix.** Use `physics.applyImpulse` / `physics.applyTorque` (`applyTorqueImpulse`). Rapier clears
impulses each step, which is the per-step semantics a drivetrain wants. Convert with
`impulse = force × dt`.

**Consequence.** A latched force is only cleared by destroying and recreating the body — in practice,
by reloading the scene (`project.loadScene`). If a body behaves as if pushed by an invisible hand,
suspect this first.

Also note `physics.applyTorque` is a torque **impulse**, not a continuous torque. Sizing it as though it
were continuous overshoots by roughly the inverse of `dt` — a 55 N·m intuition became 1500 N·m in
practice once the wheels' friction was accounted for.

---

## 2. `physics.*` is not on the editor bridge (T-1.16 — answered)

The bridge exposes ~380 tools but **no `physics_*` namespace**. The provider
(`packages/engine-core/src/providers/physics-provider.ts`) is registered inside engine-core, so the
tools exist in-process and are reachable from scripts — just not from an external agent.

**Therefore: all game physics reads and writes happen from scripts.** There is no bridge fallback.

**But they are registered lazily.** The physics provider only exists once physics has been initialised
(§6), so before the first play-mode enable `engine.mcp.hasTool("physics.bodyState")` is `false` and
`callTool` rejects with `unknown MCP tool: physics.bodyState`. A gameplay script that starts before
physics is up will throw once per frame. This is what produced 124 buffered `unhandled rejection` errors
during week 1 — historical, and zero recur with the current script, but worth recognising: that error
message means "physics is not up yet", not "you typed the name wrong".

## 3. Reaching physics synchronously from a script

`engine.mcp.callTool` is **async**. Awaiting it inside `onFixedUpdate` is not an option (the hook is
sync and returns `void`), and *not* awaiting it silently yields a `Promise` — which is how the first
version of `BotDrive.ts` became a no-op that read `undefined.content` every frame and returned early.

`engine.mcp.toolMap` is a `Map` of ~403 entries whose `handler` functions are **synchronous** and return
`{ content }` directly. Resolve them once in `onStart`:

```js
onStart({ engine }) {
  const tm = engine.mcp.toolMap;
  applyImpulse = tm.get("physics.applyImpulse").handler;
  bodyState    = tm.get("physics.bodyState").handler;
}
```

Calling a handler directly **skips zod parsing**, so schema defaults do not apply — pass every argument
explicitly (e.g. `resetVelocity` on `physics.setTransform`).

---

## 4. Moving a dynamic body

Writing `Transform` on a dynamic body is **silently discarded** — the ECS→Rapier push covers kinematic
bodies only, and the solver overwrites a dynamic body's `Transform` every fixed step.

Use `physics.setTransform` (`resetVelocity: true` unless you specifically want it to arrive moving).
This is the match-reset primitive: respawning a multi-body bot means calling it on the chassis **and
every wheel**, at their correct relative offsets. Resetting only the chassis leaves the wheels behind and
the joints violently drag it back — which invalidated the first self-right test.

One exception: `scene.setComponent` on `Transform` **does** land in the serialized scene if you save
without stepping first. That is how the committed `Arena01` has exact spawn coordinates instead of
settled float drift.

---

## 5. `Collider.halfExtents` ignores `Transform.scale`

`ColliderDesc.cuboid(halfExtents...)` receives the values raw. The **visual** mesh *is* scaled by
`Transform.scale`. So for a greybox box: `Transform.scale` = full size in metres, `halfExtents` = half
of it, maintained by hand.

Combined with the fact that children inherit `Transform.scale`, this forces the pattern in
`docs/DESIGN.md` §3: the body entity stays unit-scaled and carries the collider; a child carries the
visual and its non-uniform scale.

---

## 6. Physics only initialises after play mode has been on once

Until play mode has been enabled once, no Rapier bodies exist **and the `physics.*` tools are not even
registered** (§2). The editor wires `ensurePhysics: () => setRunning(true)`
(`packages/editor/src/engine/runtime.ts`), so enabling play mode is what brings both into being.

For reproducible measurement: `editor.setRunning(true)` once to initialise, then
`editor.setRunning(false)`, then drive time with `engine.stepFrames`. In edit mode `stepFrames` is the
only thing that advances the clock, so results depend on inputs alone. Leaving play mode on means the
host RAF is also ticking and nothing is reproducible.

---

## 7. `script.eval` result projection

Returned strings are capped at **1000 characters** regardless of `maxChars`. To move a whole file out of
the project filesystem, slice it into an array of sub-1000-char chunks and reassemble. The scene JSON is
written with `JSON.stringify(value, null, 2)`, so transporting minified text and re-expanding with the
same call on disk reproduces the engine's bytes exactly (verified: minified length 15376 both sides).

Also: `call(tool, args)` inside `script.eval` returns a **Promise**, and `script.eval` only awaits the
top-level result — so `await` each call.

---

## 8. Editor viewport lighting is not scene lighting

The editor viewport shades with its own preview lighting, so scene `Light` components have little visible
effect in `renderer.captureScreenshot`. Judge geometry from the viewport; judge lighting in the deployed
runtime (`:4173`), not in the editor.

---

## 9. Bridge fragility

`project.open` reloads the editor page, which drops the MCP bridge; and the bridge process
(`ws://localhost:8765`) can die outright, taking all engine tools with it. It does not always come back
on its own. Symptom: every engine tool reports `no engine connected`, and port 8765 is closed while
`:4174` is still serving.

Recovery: reconnect the MCP server, then re-enable **Expose** in the editor's MCP tab. Confirm with
`engine_status` → `engineConnected: true` before assuming an authoring failure is your own.
