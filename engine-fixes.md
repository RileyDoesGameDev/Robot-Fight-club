# SMPL-Engine — what got fixed

Response to [engine-bugs.md](engine-bugs.md), the filable list from building Battle Bots. That file
is the report and now carries a **Fixed** note per entry; this one is the summary — what changed,
what to re-test, and what is still yours to decide.

**All 12 BUG entries are closed.** Of the 5 LIM entries, 3 are closed and 2 are left open on purpose
because they are features with a design decision attached, not fixes.

Verified green: `npm run typecheck` passes, **2370 tests across 177 files** (+68 new), lint clean on
every file touched. The three Docker containers report `healthy`.

---

## At a glance

| # | Sev | Issue | Outcome |
|---|---|---|---|
| BUG-001 | 🔴 | `physics.applyForce` latches forever | Fixed — force is now genuinely per-step |
| BUG-011 | 🔴 | Deleting a Script entity from a hook kills the frame loop | Fixed — guarded read, as proposed |
| BUG-002 | 🟠 | `applyTorque` is an impulse, undocumented | Fixed — units documented ⚠️ *one open decision* |
| BUG-003 | 🟠 | `physics.*` registers lazily, misleading error | Fixed — registered at boot, bound lazily |
| BUG-004 | 🟠 | No sync path to physics; `toolMap` skips zod | Fixed — `ctx.call` / `callToolSync` |
| BUG-006 | 🟠 | `script.eval` caps strings at 1000 chars | Fixed — `maxStringChars` |
| BUG-007 | 🟠 | Containers report `unhealthy` | Fixed — verified live |
| BUG-008 | 🟠 | MCP bridge dies and does not recover | Fixed — expose survives the reload |
| BUG-009 | 🟠 | `frameEntities` fails on a group | Fixed — *was worse than filed* |
| BUG-012 | 🟠 | `captureScreenshot` returns a blank PNG | Fixed — refuses instead |
| BUG-005 | 🟡 | `physics.*` absent from bridge catalog | Fixed — same root cause as BUG-003 |
| BUG-010 | 🟡 | Colliders ignore `Transform.scale` | Fixed — documented + `scene.validate` check |
| LIM-001 | 🟡 | No per-instance script parameters | Fixed — `Script.params` |
| LIM-005 | 🟡 | Cylinder axis disagreement | Fixed — documented + `scene.validate` check |
| LIM-003 | 🟡 | Editor viewport ignores scene lighting | 🔬 Premise corrected — see below |
| LIM-006 | 🟠 | Editor `audio.*` never decodes; `loaded: true` is meaningless | ⬜ Open — found building T-6.16 |
| LIM-007 | 🟡 | `audio.loadClip` is async-only, unlike the rest of `audio.*` | ⬜ Open — worked around |
| LIM-002 | 🟡 | Scripts cannot import each other | ⬜ Open — needs your call |
| LIM-004 | 🟡 | `project.createOnDisk` unusable by an agent | ⬜ Open — platform-blocked |

BUG-009 was raised from 🟡 to 🟠 once its cause turned out to be a silent rendering bug.

---

## Five things the investigation changed

Worth reading even if you skip the rest — in each case the code disagreed with the report.

**BUG-003 and BUG-005 were one bug.** Not capability gating. The provider only registered from
`PhysicsSystem.attachTo`, which the editor reaches on the first play-mode enable — while MCP clients
snapshot `tools/list` once at connect and Expose is normally toggled before anyone presses Play. The
namespace existed; it was never in the catalog the client held. One fix closed both.

**BUG-009 was worse than filed.** The framing error was the visible half. Because transform-only
groups were mirrored by nothing, `attach` resolved a child's parent to
`objects.get(parentEntity) ?? this.scene` — so children of a group were parented to the scene root
and **the group's `Transform` was silently dropped**. A probe against the unfixed engine:

```
groupObj: null
child world position: [0,0,0]     // group is at x=10
child parent is scene: true
```

An Arena moved to `x=10` drew its children at the origin, and nothing reported it.

**BUG-008's auto-reconnect already existed.** `createExposeController` reconnects with exponential
backoff (500 ms → 8 s), which is why the unprompted drop recovered on its own and the `project.open`
one did not. The real gap was `project-manager.ts:64` calling `window.location.reload()`, which takes
the controller with it.

**LIM-005 was already solved for robots.** The URDF importer carries `RAPIER_CYLINDER_TO_URDF` and
pre-composes it into every imported cylinder collider. Only *hand-authored* cylinders were affected,
because nothing told an author compensation was needed.

**LIM-003's premise does not hold.** There is no viewport preview lighting to toggle off — see below.

---

## The two blockers

### BUG-001 — `applyForce` latches forever

Rapier's `addForce` writes a persistent accumulator and nothing ever reset it, so calling it once per
fixed step — what any drivetrain does — permanently *raised* the standing force.

`PhysicsSystem.step` now calls `clearAppliedForces()` immediately after `world.step()`, resetting the
accumulator for bodies forced since the previous step. Tracked in a `forcedBodies` set, so a step
where nobody pushed anything costs one `size === 0` check. Clearing happens **after** the step that
consumed the force, which is what makes the documented per-step semantics true: calls made before the
same step still sum, and sustained thrust means calling every fixed step. Torques are untouched —
`applyTorqueImpulse` never writes that accumulator.

The regression test reproduces your table against the unfixed engine — per-step gain doubling, and
acceleration continuing after the caller stops.

→ `packages/engine-core/src/physics/apply-force.test.ts`

### BUG-011 — deleting a Script entity from a hook

Exactly the one-liner you proposed, plus an `isAlive` check for the entity itself. The 3-frame
`enabled` toggle in `WorkshopController.ts` is no longer needed — delete from a hook directly.

One detail decides whether a test for this is real: **`world.query` returns a snapshot sorted by
ascending entity id**, so the crash only fires when the deleted entity sorts *after* its deleter. My
first attempt spawned the victim first and passed against the unfixed engine. The committed test
creates the deleter first and says why; all four cases throw
`Cannot read properties of undefined (reading 'enabled')` without the fix.

→ `packages/engine-core/src/scripting/script-delete-in-hook.test.ts`

---

## The rest

### BUG-004 — no synchronous path to physics

`McpRegistry.callToolSync(name, args)` is public, synchronous, parses input through the tool's zod
schema, and wraps mutating tools in the same undo transaction as `callTool`. Every `ScriptContext`
carries it as `ctx.call`:

```ts
onFixedUpdate: ({ entity, call, dt }) => {
  const state = call("physics.bodyState", { entity }).content;
  call("physics.applyImpulse", { entity, impulse: { x: 0, y: 0, z: 260 * dt } });
}
```

Two notes. `toolMap` was **private** the whole time — the workaround reached into a private field at
runtime, which is why nothing warned when it skipped zod. And the defaults trap reproduces exactly:

```
direct handler call → UICanvas {}                 // no `visible` → falsy → hidden canvas
callToolSync        → UICanvas {"visible": true}  // schema default applied
```

A tool whose handler is async now **throws** naming the async alternative, rather than handing a
Promise to a synchronous caller — the silent failure this entry is about.

→ `packages/engine-core/src/scripting/script-sync-call.test.ts`

### BUG-003 + BUG-005 — physics registration

`createPhysicsProvider` accepts a thunk, and the editor registers it at boot alongside `renderer.*`
and `viewport.*` — the same "presence static, binding dynamic" rule §0.1 established. Calls before
physics exists get a clean `isError`:

> physics is not initialised on this host yet — it is constructed on the first play-mode enable. Call
> `editor.setRunning({ running: true })` once (or press Play), then retry.

`attachTo` only self-registers when nothing has claimed the namespace, so the deployed player — which
builds physics eagerly — is unchanged.

→ `packages/engine-core/src/providers/physics-provider-binding.test.ts`

### BUG-009 — transform-only groups

`sync` now walks the ancestor chain of every renderable entity and mirrors transform-only ancestors as
`THREE.Group`. Ancestors only, never a blanket scan, so the Plan-010 R2 cost rule holds. Parenting
moved to a second pass so a child visited before its group cannot fall through to the scene root for a
frame. The eviction loop also drops entities that left the set — a `MeshRenderer` removed from a live
entity used to leak its mesh into the scene forever.

→ `packages/engine-core/src/render/render-sync-groups.test.ts` (9 cases)

### BUG-012 — blank captures

The source was `GameViewport.render()`: with the Scene tab unmounted, the Game bridge serves
`renderer.*`, and that renderer draws through the ECS `Camera` marked `active`. With none it does a
clear-only pass — a valid PNG of flat `0x0a0a14`, your 2901 bytes.

`RendererBridge` gained an optional `captureBlockedReason(): string | null`. The provider calls it
before capturing and returns an `isError` naming the cure. Bridges that always have something to draw
(the player falls back to its own camera) omit the hook and are unaffected. The tests also assert
nothing is rendered or written when blocked — the point is that no blank PNG lands on disk.

### BUG-006 — `script.eval` string cap

`maxChars` keeps its meaning (the whole serialized projection); `maxStringChars` caps each individual
string, defaulting to the old 1000. Raise both and a 15,376-char string returns whole. They are
independent on purpose, so the elision note now names the knob:

```
string at $: kept 1000 of 15376 chars (raise maxStringChars to return it whole)
```

That is the sharper half — the old note reported the loss without saying what to turn.

### BUG-007 — container healthchecks

Confirmed against the live containers rather than guessed:

```
wget http://localhost:8080/  → Connecting to localhost:8080 ([::1]:8080) → refused
wget http://127.0.0.1:8080/  → exit 0
netstat                      → tcp 0.0.0.0:8080 LISTEN        (IPv4 only)
```

`nginx.conf` says `listen 8080;`, which binds IPv4 only, while Alpine maps `localhost` to both
`127.0.0.1` and `::1` and BusyBox wget tries IPv6 first. The deployer passed all along because Node
binds dual-stack — that contrast is what identified it. Both checks now use `127.0.0.1`.

**Applied and verified:** `engine-editor`, `engine-runtime` and `engine-deployer` all report `healthy`.

### BUG-008 — bridge recovery

The expose URL is remembered for the tab session in `sessionStorage` — so a reload restores it, and a
brand-new tab does not silently open a bridge. It outranks `?expose=` and the env var (including
`?expose=0`), because clicking Expose is a later and more specific act than page config;
`stopExposing()` clears it so an explicit stop is not undone. Access is wrapped, since
`sessionStorage` throws outright in some privacy modes.

`project.open` now states the reload in both its description and its result body (`reloadsEditor: true`
plus a warning). By the time the result is read the socket is already going, and an unexplained
disconnect reads as the engine having crashed.

→ `packages/editor/src/engine/expose-memory.test.ts`

### BUG-010 + LIM-005 — two silent geometry traps

Both are deliberate designs that were documented nowhere, so both got the contract written down plus a
`scene.validate` check.

`Collider.halfExtents` / `radius` / `halfHeight` now state that they are absolute metres, that
`Transform.scale` does not touch them while it *does* scale the drawn primitive, and **why**: a
collider is a physical dimension, and `Transform.scale` is inherited by children, so folding it in
would silently resize every descendant's physics whenever someone nudged a visual.

| Check | Fires when | Tuning |
|---|---|---|
| `collider-visual-size-mismatch` | drawn primitive and collider diverge beyond a ratio | `colliderSizeTolerance`, default 2 |
| `cylinder-axis-mismatch` | cylinder primitive + cylinder collider, `offsetRotation` still identity | — |

Both are warnings, so `ok` stays true. The size check covers box↔box and sphere↔sphere only — the
pairings whose sizes map unambiguously; a check that is sometimes wrong is worse than no check. The
tolerance is a whole factor rather than 1.0 because colliders are legitimately given margin, and a
check that fires on every 5% difference is one people turn off. Imported robots stay silent by
construction, confirmed by the 29 UR-demo tests.

→ `packages/engine-core/src/scene/collider-visual-size.test.ts` (14 cases, both checks)

### LIM-001 — per-instance script params

`Script.params` is free-form JSON defaulting to `{}`, surfaced as `ctx.params`, accepted by
`script.attach`:

```ts
call("script.attach", { entity, behavior: "BotSpawn", params: { slice: "player", team: "player" } });
// …and in the behavior:
onStart: ({ params }) => spawnFor(params.team)
```

Read fresh each hook, so editing it with `scene.setComponent` lands on the next tick with no
detach/reattach. It serializes with the scene, so it is authoring data rather than runtime state — no
more encoding arguments into `Name` and colliding with name lookup.

The engine's own contract caught a mistake here, correctly: `describeComponentType` refuses to ship a
container field whose shape nothing describes, so a bare `{}` failed the shipped-components test with
`gaps: [{ field: "params", reason: "no-shape" }]`. It is declared as an **open map**
(`values: { anyOf: [...] }`) rather than a fixed shape — the honest description, since the keys are
whatever the behavior documents.

→ `packages/engine-core/src/scripting/script-params.test.ts`

---

## LIM-003 — the premise does not hold

There is no viewport preview lighting to toggle off. `EditorViewport` is built around the shared
`sync.scene`, sets only `scene.background`, and adds **no lights of its own** — the only preview rig in
the editor belongs to `thumbnail-renderer.ts`, which serves asset thumbnails.
`RenderSyncSystem.syncLight` mirrors every authored `Light` into that same scene. The editor already
shades with scene lights.

The likely real cause is a unit trap. This engine is on **three.js 0.171** — past r155, where
physically-correct lighting became the default, and past r165, where the legacy escape hatch was
removed entirely. So:

| `Light.type` | Unit of `intensity` | Is `1` sensible? |
|---|---|---|
| `directional` | scale-free irradiance | yes |
| `ambient` | scale-free irradiance | yes |
| `point` | **candela, inverse-square falloff** | no — `1/25` brightness at 5 m |

A point light at the component default of `1` is not dim, it is effectively invisible at metre scale —
while directional and ambient at 1 look fine. That asymmetry is exactly what reads as "authored lights
have almost no effect" rather than "my number is 100× too small".

`LightComponent.intensity` now documents the per-type units, and the field metadata says the same over
MCP, so `engine.describeComponents` answers it. I deliberately did **not** change the default: that
would silently re-light every existing scene, and confirming the visual outcome needs eyes on a running
editor rather than a test.

**Worth a look now that BUG-012 no longer hides an empty capture.** If a point light at, say,
`intensity: 200` reads correctly, this closes. If it still does not, the next suspect is tone
mapping/exposure in `postFx`, not the light path.

---

## Open — your call

### BUG-002 — should `applyTorque` change meaning?

I fixed the description rather than renaming, because the *behaviour* was already correct and only the
docs lied. `physics.applyTorque` now states it is a torque impulse in N·m·s, that sizing it as
continuous torque overshoots by `1/dt`, and gives the conversion.

That leaves the namespace asymmetric: `applyForce` is continuous (N, per-step) and there is no
continuous-torque verb. Making `applyTorque` continuous and adding `applyTorqueImpulse` is the coherent
API — but it is a silent 60× change in magnitude for anything already calling it. That is a deliberate
breaking change, not a bug fix, so it is yours.

### LIM-002 — scripts importing each other

A feature with a semantic decision in it. `EsbuildScriptCompiler` calls `esbuild.transform`, a
single-file transform with no module resolution. Supporting imports means `esbuild.build` with a
virtual-FS plugin resolving against the source registry — mechanically fine — but first, what does an
import *mean*?

- **Bundle per script.** Self-contained, no ordering concerns. But shared code is duplicated, and
  **module-level state is not shared** — two behaviors importing the same counter get two counters.
  Hot-reloading a shared module needs a dependency graph to know which dependents to recompile.
- **Real ESM over blob URLs.** One module instance, so shared state behaves the way `import` implies,
  and hot reload can invalidate a single module. Costs specifier rewriting, a blob-URL lifecycle, and
  a circular-import story.

The second is what "scripts can import each other" normally promises and is the one I would build; it
is also several times the work. Say which and I'll do it.

The pressure is lower than when this was filed: `ctx.call` and `Script.params` remove both reasons
Battle Bots routed everything through a spawner marker, so what remains is the genuine need for shared
*library* code rather than indirection.

### LIM-006 — the editor never decodes audio, and says nothing about it

Found while building the audio pass (T-6.16 – T-6.20). `audio.loadClip` stores the bytes, marks the
clip `loaded: true`, and never looks at them again. There is no decode, no `AudioBuffer`, no duration,
no sample rate, and nothing ever makes a sound in the editor profile:

```js
await call("audio.loadClip", { name: "junk",   source: { bytes: [1,2,3,4,5] } })  // -> loaded: true
await call("audio.loadClip", { name: "gone",   source: { url: "/nope.wav" } })    // -> loaded: true
engine.audioClips.clips.get("junk")   // { name, url, bytes, loaded: true }  — no buffer
engine.audio                          // { playCount: 0, stopCount: 0, sources: Map(0) } after playing
```

Only an empty `bytes: []` is refused, and that is zod's `minItems`, not a decoder.

This is defensible as a design — the editor is an authoring surface and a runtime build is what makes
noise — but `loaded: true` actively asserts the opposite, and it is the only signal an agent gets.
Every audio task in this project would have "passed" against five bytes of garbage. Two cheap fixes,
either of which would be enough:

- **Decode on load.** `AudioContext.decodeAudioData` on the bytes, report `loaded: false` plus a
  reason when it fails, and expose `duration` / `sampleRate` on the clip record. That turns
  `loaded` into the fact it claims to be.
- **Or say so.** If decoding is deliberately out of scope for the editor profile, have `loadClip`
  return `{ registered: true, decoded: false, note: "editor profile does not decode or play audio" }`
  and have `audio.play` say the same. Honest and nearly free.

Until then `loaded` cannot be trusted, so this repo verifies audio outside the engine:
`game/data/audio-check.js` validates the WAV bytes numerically (header, level, loop seams, spectrum)
and `game/data/audio-wiring-check.mjs` drives `AudioDirector` against a stubbed engine. Both extract
or import the shipped code rather than reimplementing it.

### LIM-007 — `audio.loadClip` is the only async tool in its namespace

`audio.loadClip` is an `AsyncFunction`; `attachSource`, `play`, `stop`, `setVolume`, `setLoop`,
`setListener` and `getSource` are all plain synchronous functions. So the `ctx.call` path that
BUG-004 added — the one every script in this repo uses — works for eight of the nine and throws on
the ninth:

```
MCP tool audio.loadClip is async and cannot be called synchronously
```

The error message is good and names the cure. The cost is that clip registration cannot happen in
the same synchronous sweep as the rest of a script's `onStart`, so `AudioDirector` kicks the loads
off through `engine.mcp.callTool` and gates playback on a `ready` flag until they land — a frame or
two, inaudible, but a whole state machine that exists only because one tool in the namespace is
shaped differently from its neighbours.

Worth asking whether it needs to be async at all. It does no I/O in the `bytes` form — it stores an
array — so the asynchrony appears to exist for the `url` form alone. Splitting the two, or resolving
the bytes form synchronously, would remove the special case.

### LIM-004 — `createOnDisk` for agents

Blocked in the browser. The File System Access API grants a directory handle only from a user gesture;
there is no path-argument form to add, because no browser accepts a path from script under any flag.

The plausible unblock is the sidecar you already run: `engine-deployer` holds the Docker socket and the
editor reaches it same-origin through the nginx `/deployer/` proxy. A `POST /project` endpoint writing
to a host-mounted volume would give agents real on-disk projects with no picker. That is a new trust
surface — an MCP verb writing arbitrary host paths — so it wants a rooted base directory and path
containment. Architectural call, yours to make.

Until then this repo remaining the source of truth is the right answer.

---

## Change set

21 files modified, 9 new test files, +68 tests.

**Engine core** — `physics/physics-system.ts`, `providers/physics-provider.ts`,
`providers/renderer-provider.ts`, `providers/script-provider.ts`,
`providers/scene-inspect-provider.ts`, `providers/project-lifecycle-provider.ts`, `mcp/registry.ts`,
`render/render-sync.ts`, `scene/inspect.ts`, `scripting/behavior.ts`, `scripting/script-system.ts`,
`scripting/eval-result.ts`, `ecs/components.ts`

**Editor** — `engine/runtime.ts`, `engine/expose.ts`, `engine/expose-connection.ts`,
`engine/game-viewport.ts`, `panels/GameView.tsx`, `panels/ScriptEditorWindow.tsx`

**Stack** — `docker-compose.yml`

Every fix carries a regression test that fails against the unfixed engine. Where a proposed fix was
declined, or a reported cause turned out to be wrong, the reasoning is recorded in
[engine-bugs.md](engine-bugs.md) next to the original entry rather than only here.
