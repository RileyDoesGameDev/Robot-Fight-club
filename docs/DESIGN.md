# Battle Bots — Design Doc

Working title: **Battle Bots** · Engine: **DSD SMPL-Engine** · Solo developer · 8 weeks, feature-complete by end of week 6.

This is the contract referenced by `TASKS.md`. Where this document and the proposal disagree, this document wins — it records decisions actually taken and measured. Numbers marked **(measured)** came from a real run in the engine, not an estimate.

---

## 0. Scope decisions

Recorded so they are not re-litigated, and so the presentation can explain them.

### 2026-08-19 — the player-facing build system is cut; Create becomes **bot selection**

**What changes.** The player no longer assembles a bot from parts. The Create stage becomes a **Bot
Select** screen: choose one of several prebuilt bots, see its stats, take it into a match.

**Why.** The build system was one of the three systems the proposal's own §4 risk review flagged as
capstone-scale on its own. With destruction, the weapon controllers, the AI opponent, local multiplayer,
audio and a UI pass all still ahead of feature-complete in week 6, the build system is the one that can be
removed without breaking the core loop — a match still needs two bots, and prebuilt bots supply them.

**What is NOT lost.** The socket data model stays exactly as it is, because the assembler needs it to turn
a blueprint into a bot (§3). Prebuilt bots are still authored as `BotBlueprint` JSON over `PartDef`
sockets. The difference is only who edits them: the designer, not the player.

**The Workshop already works and is kept as a stretch feature.** Part fitting, swapping, live stats,
undo/redo and save/load are implemented and verified (§3). It is no longer on the critical path and no
longer owes the polish the tasks below it once implied — but it is a working demo, not deleted code, and
it can be re-promoted if the schedule allows.

**Honest consequence for the pitch.** The proposal named "a genuinely dynamic build system" as its first
differentiator. Selecting a prebuilt bot is not that, and the presentation should not claim it is. The
differentiators that remain are the two the proposal also named: **real-time physics-based destruction**
(parts dent, jam and shear off) and an **opponent AI tuned from recorded player matches**. Both are
untouched by this cut, and both are still ahead of us. If the Workshop stretch lands, the honest framing
is "a build system exists, and here it is" rather than "building is the core loop".

---

## 1. Core loop

**Create → Test → Destroy**, mirroring the show.

| Stage | Scene | What the player does |
|---|---|---|
| Create | `BotSelect` | Choose a prebuilt bot from the roster; see its stats |
| Test | `DemoCenter` | Spar against a pre-built AI opponent, learn controls, tune |
| Destroy | `Arena01` | Fight an AI opponent or a local human; parts break off |
| — | `PostMatch` | Damage summary → "pick another bot" back to Bot Select |

Win condition: **knockout** (all drive parts destroyed = immobilised, or chassis HP reaches zero) or, on time expiry, **most damage dealt**.

---

## 2. Units, scale, and mass budget (T-0.16)

- **1 world unit = 1 metre. 1 mass unit = 1 kilogram.** Gravity is −Y.
- Arena playfield: **12 × 12 m**, walls 1.2 m high and 0.3 m thick, inner wall faces at ±6.0 m.
- Bot footprint: 0.6–0.9 m long, 0.6–0.72 m wide, ≈0.25–0.30 m tall.
- **Socket lattice: 0.02 m.** Every socket offset in `game/data/parts/*.json` is an integer multiple of it, enforced by `game/data/validate.js`.
- Editor conventions (T-0.12): up-axis **Y**, grid unit **metre**, gizmo snap **on** (1 m — right for arena blockout). Socket precision does *not* come from gizmo dragging; sockets are authored numerically in JSON, which is why a 1 m snap and a 0.02 m lattice coexist without conflict.

### Weight classes

| Class | Mass cap | Roster |
|---|---|---|
| Lightweight | ≤ **80 kg** | Hornet (69) |
| Middleweight | ≤ 110 kg | Doorstop (89), Blue Ruin (98), Grinder (107) |
| Heavyweight | ≤ 180 kg | Ravager (162), Anvil (168) |

**Lightweight was raised from 60 kg on 2026-08-20.** The lightest bot that can roll
at all is 59 kg (`ch-wedge-m` + 4 × `wh-s` + `mt-speed`), and the cheapest weapon is
10 kg — so at a 60 kg cap **no lightweight build could carry a weapon**. The class
existed as a number but not as a thing you could field. 80 kg leaves room for a
weapon and a plate.

Every prebuilt bot must sit inside a class cap; `game/data/validate.js` fails the build if one does not, so the cap is enforced at authoring time rather than in a player-facing UI. Mass is always the **sum of every attached `PartDef.mass`** — never hand-authored. (The Workshop also refuses to save an over-cap bot, which is where T-4.8 landed.)

---

## 3. Bots: prebuilt, over a socket data model (T-2.3, T-2.4)

Bots are **authored, not player-built** (§0). The socket model below is therefore an *internal* format —
it is how the assembler knows where a wheel goes and how hard its mount is to shear off — rather than a
player-facing feature. Every prebuilt bot is a `BotBlueprint` over these sockets, so nothing here becomes
dead weight.

Fixed attachment points, explicitly not freeform placement.

- A chassis `PartDef` declares its sockets: `id`, local `position`, optional `rotation`, `accepts[]` (categories), and `breakForce` (N).
- **The JSON is the single source of truth.** The assembler creates a child entity per socket at runtime; there is no `Socket` component and no naming-convention parsing. One mechanism, so the two can never disagree.
- A part declares `requiresSocketType`; the socket declares `accepts`. Both must agree or `validate.js` fails.

### Body/visual split — a real constraint, not a style choice

A part's **body entity keeps `Transform.scale = [1,1,1]`**; its visual size lives on a unit-scaled child (`*_ChassisVisual`) or comes from an imported mesh.

Why: `Transform.scale` is inherited by children, so a non-uniform scale on the chassis body (e.g. `[0.6, 0.25, 0.8]`) would distort every socket child's offset. Colliders are unaffected either way — `Collider.halfExtents` is passed to Rapier raw and **ignores `Transform.scale`** — so the visual and the collider must be sized independently and kept in agreement by hand. This bit the week-1 greybox and is why `Bot_Player_Chassis` carries the collider while `Bot_Player_ChassisVisual` carries the box.


### The assembler (T-2.9)

`game/scripts/BotAssembler.ts` turns a `BotBlueprint` into a live bot. It is driven by **spawner
markers**: an empty entity whose Transform is the spawn pose and whose `Name` encodes the parameters.

```
BotSpawn:<blueprintId>:<role>      →  BotSpawn:player-slice:player
```

`Name` is the parameter channel because `script.attach` accepts no per-instance arguments and the ECS has
no generic key/value component. On success the marker renames itself to `BotSpawned:…`, which makes
assembly **idempotent** — loading a scene that already contains a baked bot will not duplicate it.

`Arena01` therefore ships as a **spawner-driven scene**: 18 authored entities, no baked bots. Loading it
produces 36 entities as the two bots build themselves. The arena is not welded to two specific blueprints,
which is what lets Bot Select hand any chosen blueprint to any scene.

Structure produced per bot:

```
Bot_<role>_Chassis              unit-scaled body — Collider + RigidBody + controller Script
  Bot_<role>_ChassisVisual      child holding the non-uniform visual scale
Bot_<role>_<socket>_<partId>    one dynamic body per part, on a BREAKABLE joint
```

Every part is its own rigid body so it can be damaged and sheared off. Part bodies carry their visual
directly — they have no children, so a non-uniform scale is safe there, unlike on the chassis. The
`partId` is encoded in the entity name so the damage system can recover a part's hp and armour tier from
the bundle without a component to store them in.

A powered spinner is attached by a **revolute** joint carrying a velocity motor at `targetVelocity: 0`
(the weapon controller, T-3.9, ramps it); everything else is welded with a `fixed` joint. Either kind is
breakable, so detachment works uniformly.

**Deviation: no prefabs (T-2.5 – T-2.8 superseded).** T-2.4 made the PartDef JSON the single source of
truth for sockets. Authoring prefabs as well would duplicate every mass, collider and socket in a second
place that must be regenerated whenever the JSON changes. The assembler builds entities directly from the
data instead.

**Data delivery.** `game/data/**` is the source of truth, but a script inside the engine would need one
`project.readFile` per part to consume it. `game/data/build-bundle.js` packs everything into
`bundle.json`, which is pushed to the engine project at `/data/bundle.json` and read in one call. The
bundle is a generated artifact — never hand-edit it.

**Verified (T-2.11):** assembling the same blueprint twice produces byte-identical structural signatures
(masses, collider shapes, joint kinds, anchors, break forces), and every joint anchor exactly equals its
authored socket position. Assembled mass matches the blueprint's declared mass exactly — 98 kg for
`player-slice`, 89 kg for `opp-wedge`.

### The Workshop — built, now a stretch feature (T-2.12 – T-2.18)

> **Status:** complete and working, but **off the critical path** since the 2026-08-19 scope cut (§0).
> It is how the prebuilt roster gets authored, and it is a demo-able bonus. It is not what the player is
> promised. The unfinished parts of it — ghost preview, clicking sockets in the 3D view — are deferred, not
> pending.

`Workshop` is a 10-entity authored scene — floor, turntable, backdrop, two part racks, key + ambient
light, player-facing camera, and one marker carrying `WorkshopController`. Loading it produces ~64 live
entities as the UI and the preview bot build themselves.

**Interaction.** Click a socket, then click a part. Fitting into an occupied socket swaps. `Remove` clears
the selected socket. Every fit applies immediately and rebuilds the preview, so **the bot on the turntable
*is* the preview** — there is no translucent ghost-before-commit. That is a deliberate deviation from
T-2.14: an immediate, undoable apply is simpler and gives better feedback than a ghost you must confirm,
with undo/redo as the safety net. Socket selection is list-driven; picking a socket by clicking it in the
3D view needs a raycast picker and is still open.

**UI.** Five panels grafted straight onto the canvas — category tabs + part list, socket list, live stats,
a command bar, and a header hint line. There is no wrapper root element, because a wrapper would have to
be full-bleed for its children's fractional anchors to resolve, and a full-bleed panel paints over the 3D
view.

**Live stats (T-2.17).** Name, chassis, mass + weight class, armour total, weapon rating, estimated top
speed, wheel count. Over-cap mass and a bot with fewer than two wheels both turn red. The speed figure is
an *estimate*: the measured 4.46 m/s reference scaled by the motor multiplier and inverse mass — not a
simulation.

**Undo/redo (T-2.16).** History is a stack of draft snapshots, and each edit is wrapped in
`undo.beginTransaction` / `undo.commit` so the resulting scene rebuild collapses to a single editor undo
step. Undoing the *draft* rather than the scene keeps the two from desynchronising.

**Persistence (T-2.18 decision).** Blueprints are plain JSON at `/data/bots/<slug>.json`, with the roster
at `/data/roster.json` — chosen over `game.saveSlot` because a blueprint is authored content that must
stay diffable and exportable to the repo, not opaque save state. Saving an over-cap bot is refused, which
also satisfies T-4.8.

> **Sync gap worth knowing:** bots authored in the Workshop are written into the engine project, i.e. into
> browser storage. Export them back to `game/data/bots/` before they count as saved.

**Reverse path (T-2.10).** `Save` does not serialise the in-memory draft. It calls `readBackFromScene()`,
which rebuilds the blueprint from the live entity tree — chassis identified by matching collider
half-extents, attachments parsed out of `Bot_workshop_<socketId>_<partId>` names — and then reports
whether that agrees with the draft. Verified `roundTripMatches=true`, so the scene is genuinely
round-trippable rather than assumed to match.

**Rebuild is a 3-frame state machine**, not by choice: deleting a `Script`-bearing entity from inside a
script hook crashes the engine's frame loop (`engine-bugs.md` BUG-011). So the spawner marker is created
once and never deleted; re-running it means disabling its Script on one frame and re-enabling it on the
next, which makes ScriptSystem build a fresh instance and call `onStart` again. Only Script-free bodies are
ever deleted.

---

### Bot Select — the Create stage (T-2.20 – T-2.23)

`game/scripts/BotSelectController.ts` and the `BotSelect` scene: an 8-entity display
set (floor, turntable, backdrop, key + fill light, player-facing camera, controller
marker) that becomes ~30 live entities once the UI and preview build themselves.

Roster list on the left, spec card on the right, Prev / Next / **CONFIRM** below.
The highlighted bot is previewed on the turntable through the *same* path the
Workshop uses — write a marker named `BotSpawn:<id>:select` and let BotAssembler
build it. Role `select` is **inert**: no drivetrain, no AI brain. That inert-role
list lives in one place in the assembler so a future preview scene cannot silently
acquire an opponent AI.

A preview bot's weapon *does* still run, and that turned out to be worth keeping:
measured drift is 0.007 m over 3.3 s, so it stays on the turntable, and the motor's
reaction torque rotates it slowly — a free turntable effect. It only happens for
spinner bots though, so a deliberate slow rotation is still a polish item.

**The roster (T-2.20).** Six bots chosen to change how a match plays, not just to
differ in mass:

| Bot | Class | Mass | Weapon | Armour | Character |
|---|---|---|---|---|---|
| Hornet | light | 69 kg | passive wedge | 0 | fastest thing in the arena, no protection |
| Doorstop | middle | 89 kg | passive wedge | 140 | quick wedge, nothing to jam |
| Blue Ruin | middle | 98 kg | spinner | 90 | the balanced reference build |
| Grinder | middle | 107 kg | spinner | 140 | slow to line up, hard to shove |
| Ravager | heavy | 162 kg | spinner | 200 | heavy spinner behind a heavy plate |
| Anvil | heavy | 168 kg | none | 480 | no weapon at all; wins by outlasting |

**Hand-off (T-2.22).** CONFIRM writes the chosen blueprint to
`/data/bots/__selected.json`. `Arena01`'s player spawner is
`BotSpawn:__selected:player`, and BotAssembler already resolved an id from
`/data/bots/<id>.json` when it was not in the bundle — so the selection rides
machinery that already existed rather than needing new plumbing. `__`-prefixed files
are runtime state and are excluded from the bundle, so the selection never shows up
as a seventh roster entry.

**PRACTICE and FIGHT launch directly** (T-6.2). Both write the selection first, then
load their scene — `DemoCenter` for sparring, `Arena01` for a timed match. Neither
destination knows this screen exists; they read the file through their player spawner.

**Verified (T-2.23 gate).** Confirmed Ravager in `BotSelect` → loaded `Arena01` →
the player bot was built as Ravager (four `wh-l` wheels, spinner, heavy plate, torque
motor, 162 kg) → drove it with the spinner up and fought the AI, 30.2 / 31.0 damage
exchanged across 4 damaged parts. `scene.validate` clean, zero errors.

The spec card's speed figure is an **estimate**: the measured 4.46 m/s reference
scaled by motor multiplier and inverse mass, then clamped to BotDrive's own
`MAX_SPEED`. Unclamped it read 8.23 m/s for Hornet, which the drivetrain cannot
reach — it is a comparison aid between bots, not a simulation.

---

## 4. Drivetrain (T-1.7 decision)

**Chosen: direct chassis drive.** Propulsion is a per-step impulse applied to the chassis body. The four wheels are real dynamic bodies attached by breakable `fixed` joints, but they carry **no motors and provide no propulsion**.

Rejected: revolute wheel joints with velocity motors. More physically honest, but it adds four motorised constraints per bot and couples drive feel to joint stiffness.

Why this combination is the right trade: it keeps drive stable and cheap while still giving the destruction system real, detachable wheel bodies to shear off (T-5.4). A lost or damaged wheel is applied as a per-side `driveScale` multiplier in `BotDrive.ts` rather than as a change in traction.

Revisit only if traction nuance turns out to matter more than the frame budget — and per §7 the frame budget is not currently the constraint.

### Measured drive feel (T-1.10, T-1.11)

Greybox bot: 70 kg chassis + 4 × 5 kg wheels = **90 kg**, CoM offset −0.08 m in Y, `linearDamping 0.35`, `angularDamping 2.5`, CCD on, wheel friction 0.6, floor friction 0.9.

| Property | Value | Note |
|---|---|---|
| Top speed | **4.53 m/s** (measured) | Asymptotic; 3.4 m/s by 0.5 s, 4.0 by 1.5 s |
| Peak yaw rate | **2.33 rad/s ≈ 133 °/s** (measured) | Turn-in-place, no positional drift |
| Idle drift over 0.5 s | **0.0001 m** (measured) | Rests stably; no jitter |
| Coast-down from top speed | < 0.03 m/s after 1 s (measured) | Damping-dominated stop |
| Wall impact at top speed | Rests at **z = −5.600** (measured) | Wall face −6.0 + chassis half-length 0.4 → **no tunneling** |

Tuning constants live at the top of `game/scripts/BotDrive.ts`. `MAX_SPEED = 7.0` is a *safety ceiling*, not the achieved speed — real top speed is set by damping and wheel drag.

### Self-righting (T-1.12) — implemented, not yet fully validated

`SELF_RIGHT_IMPULSE = 700` N·s upward plus `SELF_RIGHT_TORQUE = 1600` N·m·s rolled about the chassis long axis, on a 2 s cooldown, gated on `up.y < 0.35`. Traction gating verified: **a flipped bot cannot drive** (measured).

Honest caveat: the greybox bot **cannot rest fully inverted** — with wheels on rigid joints it settles to `up.y ≈ 0.47` on its own, so there is no stable "stuck upside down" state to test against. 700/1600 did reach fully upright (`up.y 0.998`) from a forced flip; larger values overshoot and land back down. **Re-validate against real chassis geometry in week 2** before trusting these numbers.

---

## 5. Damage model (T-3.1 – T-3.3)

Discrete component health, per the adopted proposal decision — not free-fracture.
Implemented in `game/scripts/DamageSystem.ts`.

State per part: `intact → damaged → destroyed`, with `damaged` at **≤ 50 % HP**.

### Force-based, not energy-based (revised 2026-08-20)

The original formula derived impact energy from relative velocity and mass. That
was replaced once the engine was reporting contact force reliably: the solver has
already computed the force, so re-deriving energy from velocities duplicates its
work and disagrees with it at the margins.

```
excess  = max(0, maxForce − damageFloorN)          // maxForce from physics.getContacts, newtons
dps     = excess · damageScaleHpPerNs · weaponFactor · (1 − armorReduction)
damage  = dps · dt                                 // a RATE, so sustained contact accumulates
```

Because it is a rate rather than a per-impact lump, a spinner grinding along a
plate keeps doing damage — which a per-collision model would miss entirely.

Constants live in `game/data/damage.json` so tuning never needs a recompile:

| Knob | Value |
|---|---|
| `damageFloorN` | 600 — shoving and resting contact must not chip armour |
| `damageScaleHpPerNs` | 0.06 — **tuned**, see the measurements below |
| `weaponFactor` | spinner 1.0, drum 0.9, hammer 1.3, flipper 0.3, wedge 0.15, **ram 0.5** |
| `armorReduction` | light 0.15, medium 0.30, heavy 0.45 |
| `contactForceEventThresholdN` | 400 — below this the solver reports no force at all |

`ram` is the factor for a striker that is not a weapon, so shoving is a real but
weak attack. The **striking** part sets `weaponFactor`; the **struck** part's own
tier sets `armorReduction`.

### Signal: poll contacts, don't listen for them (T-1.14 answered)

`physics.contact` fires only on contact **begin/end** — verified. A grinding
weapon would therefore damage once and then never again. So DamageSystem polls
`physics.getContacts()` each fixed step instead, which returns live contacts
refreshed every step with `maxForce` in newtons.

Payload, confirmed live: `{ a, b, started, point, normal, maxForce, force }` for the
event; `{ a, b, point, normal, maxForce, force }` for a polled record.

`Collider.contactForceEventThreshold` = 400 N is what makes polling cheap: under
it the solver reports no force, so resting and rolling contacts are free to skip.

### What counts as a hit (T-3.8)

Only **inter-bot** pairs. Same-bot pairs and arena geometry never damage anything,
filtered by the role encoded in each entity's name. Deliberately *not* done with
`Collider.collisionGroups`: masks would risk the bots' physical solidity against
the floor and each other, and the filter is one comparison.

### Measured (2026-08-20)

| Property | Result |
|---|---|
| Peak inter-bot contact force, full-speed ram | **4311 N** |
| Damage per ram to a light plate (90 hp) | **≈ 12 hp** → damaged in 4 rams, destroyed in ~8 |
| `damaged` transition | fired at 41.7/90 hp (46 %) |
| Destroyed part | `joint=DETACHED` — becomes free arena debris |
| Drive degradation, one damaged wheel | `driveRight` 1 → **0.775** = (1 + 0.55)/2 |
| Drive degradation, one destroyed wheel | `driveLeft` 1 → **0.5** = (0 + 1)/2 |
| Knockout, 3 of 4 wheels lost | `{ role: "player", reason: "immobilised" }` |
| New console errors across all runs | **0** |

Reaction damage (T-3.10) falls out for free: both sides of a contact take damage,
so a bot that rams face-first hurts its own front plate. The player's plate
consistently took more damage than the opponent's, which is the armour tiers
working — light 0.15 vs medium 0.30 reduction.

### Functional degradation (T-3.6) — what makes damage matter

| Part | `damaged` | `destroyed` |
|---|---|---|
| Wheel | drive torque × 0.55 on that side | that wheel contributes nothing to its side |
| Weapon | RPM × 0.6 | no attack |
| Armor | its tier's reduction × 0.5 on the face it covers | that face of the chassis is bare |
| Motor | both tracks × 0.6 | drive dead, and the bot is `immobilised` |

**Armour is directional (T-5.4).** The chassis has no armour tier of its own; what
protects it is the plate on the face that was actually struck. `armorReductionFor`
takes the contact point into chassis-local space and matches it against the chassis'
own armour socket offsets — from the socket table, not a hardcoded front/rear/left/
right map, so a chassis added later needs no code change. Shear the front plate off a
wedge and its nose is bare while its flanks stay covered, which is what makes a plate
worth defending rather than just worth its hp. A hit matching no face (the roof, or
underneath) is unprotected: no socket on any chassis points that way.

**A drivetrain socket is registered once and never removed.** Authority was computed
from live wheel entities, so culling a sheared wheel's debris (T-5.3) shrank the
denominator and that track climbed back to full power seconds after being torn off.
Wheels and motors now live in a per-bot socket registry that outlives their entities;
`checkKnockout` counts off it too.

Measured (2026-08-20), synthetic bot on ch-box-m with a medium plate on `armor_front`,
3 000 N contact at ram factor:

| Case | Result |
|---|---|
| Front face, plate on | 0.28 hp/step (reduction 0.30) |
| Left flank, no plate there | 0.40 hp/step — directionality with the front plate still on |
| Front face, plate sheared off | 0.40 hp/step — exposure ratio **1.4286** = 1/0.7 |
| One wheel lost | `driveLeft` 1 → 0.5; still 0.5 after its debris is culled |
| Motor damaged / destroyed | 0.5 → 0.3 and 1 → 0.6 / drive 0-0 + `immobilised` knockout |

**Open balance question (for T-7.4).** With directional armour in, the exposure now
fires almost immediately: in DemoCenter both bots shear their front plates on the
first hard ram, because the armour mount is 2 500 N and a full-speed ram peaks at
4 311 N. A plate is currently a one-hit sacrificial layer. That may be the right
feel — it puts destruction on screen in the first seconds — but it should be a
decision, not an accident: either raise the armour mount above ram force so plates
are lost to weapons rather than to shoving, or keep it and accept plates as
consumable.

Progressive weakening (T-5.5): a `damaged` part's joint `breakForce` is multiplied by **0.5**, so accumulated hits eventually shear it off.

---

### Arena hazards (T-5.12)

The corner pits were always real holes — Arena01 has no floor at |x| > 4 and |z| > 4 —
but nothing watched them, so a bot that drove into one fell forever and the match
never ended. Two rules close that:

- **The pit is a kill zone.** A chassis below `pitKillY` (−0.9) knocks its bot out
  with reason `pitted`; debris below it is deleted rather than left to free-fall.
- **The pit is also the pushout zone.** The arena is walled on all four sides, so
  there is no ring-out edge — the corners are where you shove someone to remove them.
  `push-to-hazard` has been a scored AI action since T-5.16, against a rule that did
  not exist until now.

**Hazard damage is folded into the damage model, not parallel to it.** Any entity
named `Hazard_*` registers under a reserved `$hazard` role, so the same-role contact
filter that already separates bots lets a hazard through to every bot and to no other
hazard. It strikes with `weaponFactor.hazard` and `strike` returns early when the
victim is a hazard, so it can never be worn down. A hazard is a striker with a factor.

The floor spinners' rotation is **cosmetic on purpose**: the body is static and the
collider is a disc — the bar's swept envelope. That applies the tunnelling lesson
below up front, and means contact behaviour does not depend on where the art points.

| Property | Measured |
|---|---|
| Contacts, bot resting on a spinner | 514 over 2 s |
| Median / peak contact force | 526 N / **7 626 N** |
| Outcome | peak clears the 4 000 N wheel mount — **shears a wheel off** |
| Other wheels, same 2 s | 0.3–3.1 hp attrition |

### Telemetry (T-5.14) and weight suggestion (T-5.19)

`MatchTelemetry` writes one JSON record per finished match to the engine project's
`/telemetry`. It is a pure consumer of the `battlebots.*` channels, so gameplay
cannot tell whether it is attached. **Both sides record decisions in one schema** —
the AI's is its chosen action, the human's is the input being held — which is what
makes a player trace and an AI trace comparable, and is the point of T-7.5.

Recorded matches are **data, not source**: `game/telemetry/` is gitignored. To run
the aggregator, export the folder out of the engine project first, then:

```sh
node game/data/ai/aggregate.js --dir game/telemetry --write
```

It is plain statistics — per personality, the lift of each action's sample share in
wins over losses, suggested as a clamped delta on that action's `bias`. It never
writes `weights.json`, and it declines to suggest anything below six matches per
personality with at least one win and one loss.

### Weapons: the spinner (T-3.9)

`game/scripts/WeaponController.ts`, attached by the assembler to any weapon whose
PartDef declares an `axis` and a `targetRpm`. It drives the revolute joint's motor
through `physics.setJointMotor` — the runtime path meant for per-step writes.

States: `idle → spinup → ready`, plus `spindown` on release and `jammed` on stall.

| Property | Measured |
|---|---|
| Spin-up | linear to **1396 of 1400 rpm in 2.4 s** — matches `spinUpSeconds` exactly |
| Spin-down | linear 1396 → 1 rpm over **4.0 s** (`spinDownSeconds`) |
| Hits on a facing target | **86** weapon hits in one engagement |
| Blade contact force | 3.7–9.3 kN — under the 12 kN mount `breakForce`, so the blade stays on |

**Collide the swept envelope, not the bar.** A 0.35 m blade at 1400 rpm moves its tip
**0.85 m per fixed step** at 60 Hz. Rapier's CCD is translational, so it does not
protect a *rotating* body: the bar teleports straight through a 0.6 m target. Measured
with a bar-shaped collider:

| target rpm | tip travel / step | weapon hits | peak force |
|---|---|---|---|
| 300 | 0.183 m | 2 | 13.8 kN |
| 600 | 0.365 m | 0 | — |
| 1000 | 0.608 m | 0 | — |
| 1400 | 0.853 m | 0 | **132 kN** ← when it *did* resolve |

Contact collapses past roughly 0.2 m of tip travel per step, and the rare resolved
contact produces an impulse two orders of magnitude too large — which shears the
mount instantly and launches both bots. Neither outcome is a game.

So `wp-spinner-h` collides as a **cylinder of the blade's sweep radius** (r 0.35,
half-height 0.03) while the visual stays a spinning bar. Contact is then continuous at
any rpm and impulses stay in the single-digit kN range. Because the disc touches even
when stopped, **damage scales by `spinFraction`** (actual rpm ÷ target): a dead blade
does `ram` damage, a live one does full `weaponFactor`. The controller publishes that
fraction on `battlebots.weaponState` and DamageSystem reads it.

**Releasing the trigger is a scripted spin-down, not physics coast.** A velocity motor
told to reach 0 rpm is a *brake* — release measured 1396 → 1 rpm in under a second —
and `maxForce: 0` did not free the joint either. Ramping the command down over
`spinDownSeconds` is deterministic, tunable, and reads correctly on screen.

**Emergent: the spinner makes the bot veer.** Motor reaction torque yaws the chassis
about 0.13 rad/s while the blade is spinning. Over a four-second straight-line drive
that integrates into a ~30° heading error — enough to walk the bot into a wall, which
is exactly what happened in early tests before steering was applied. This is real
spinner-bot behaviour and is being kept: it is a skill demand on the player and a
requirement on the AI (T-3.13), not a bug to damp out.

---

### The opponent AI (T-3.13, T-3.14)

`game/scripts/AiDriver.ts`. The assembler gives every non-player bot a **brain**:
a child entity of the chassis carrying this script. It is a child because an entity
holds only one `Script` and the chassis already carries `BotDrive`.

**Decision layer only — this is the important structural choice.** AiDriver writes
`intent = { throttle, turn, selfRight }` into the chassis's `Script.params`, and
`BotDrive` actuates it. The AI never applies an impulse and never sees a drive
constant. Two things follow:

- The drive tuning measured in week 1 lives in **one** file, for the player and every
  AI alike. No second copy to drift.
- The week-5 Utility AI replaces `decide()` and nothing else — which is exactly what
  T-3.13 specifies ("replaces the decision layer, not the actuation layer").

`decide(state, dt)` is a near-pure function of a gathered `state` (range, heading
error, speed, uprightness, nearest-pit range and bearing, wall proximity). Utility
scoring drops straight onto that object.

Behaviour priority, highest first: **knocked-out → self-right → avoid-pit →
back-off → break-off → disengage → align → close → attack.**

| Decision | Why it exists |
|---|---|
| `avoid-pit` outranks attacking | a pit is lethal; nothing is worth driving into one |
| `break-off` after 2.5 s attacking | two bots pressed together jitter, so speed never reads as "stuck" — without a dwell cap the fight is one endless grind (measured: locked at 0.90 m indefinitely) |
| stuck test gated on the *previous* throttle | pivoting in place is legitimately stationary and must not read as wedged |
| proportional turn (x1.6, clamped) | settles instead of oscillating, **and it is what corrects the yaw drift the spinner's reaction torque produces** |

**Measured.** Against a stationary player the opponent closed 5.44 m → 0.88 m in
about 1 s and then cycled properly:

```
attack → break-off → back-off → align → close → attack → break-off → …
range: 5.44 → 0.88 → 3.32 → 1.03 → 3.41 → 1.11
```

Damage was exchanged both ways (opponent 102.4, player 94.1) and the player's
front-right wheel reached `damaged`. Player keyboard control still works
independently (2.23 m on a key press) and the AI bot correctly ignores the player's
keys. Flipping the AI switches it to `self-right`.

**T-3.14 decided: no nav grid.** Direct steering only. The arena is a bare 12 × 12 m
box whose only obstacle is the other bot, so a grid plus A* would buy nothing that a
heading error does not already express — and half-building both is precisely what
T-3.14 warns against. Pits are handled by a repulsion term, not by pathing. Revisit
only if week 5's arena hazards (T-5.12) introduce real geometry to route around.

---

### The utility AI (T-5.15 – T-5.21) — what actually ships

`game/scripts/UtilityAi.ts` replaces AiDriver's priority chain with scored choice, in
the same seat and under the same contract. AiDriver stays in the repo as the scripted
baseline to measure against. **The structural bet above paid off exactly as intended:
the drivetrain was not touched.**

**Why scoring.** The chain could only *order* behaviours, never *compare* them, so
every new one meant picking a slot. Now each action scores itself against the same
world state and the best wins, which is how `push-to-hazard` — a behaviour the
scripted version never had — could be added without renegotiating anything.

**Nine considerations**, all normalised 0..1: `proximity`, `alignment`, `ownHealth`,
`foeHealth`, `weaponSpin`, `bladeDown`, `weaponLost`, `hazardNear`, `wallNear`,
`foeHazard`, `stuck`, `engaged`. **Seven actions**: attack, charge, circle-strafe,
retreat, spin-up, ram, push-to-hazard.

**Weights are data** (`game/data/ai/weights.json`, T-5.18) — three personalities
(T-5.20), tuned without a recompile. Health comes from DamageSystem's existing report
rather than a second tally, polled twice a second.

**Two states are gated, not scored.** Knocked out, and flipped, bypass scoring
entirely. A mis-tuned weight file must not be able to make a bot lie on its back
deliberating; that is a correctness property, not a preference. The pit is a third
near-gate: it is applied as a **veto** (-2 to everything but retreat) rather than a
weight, because instant death should not be something a weight file can price as
merely expensive.

**Hysteresis** is two mechanisms because they solve different problems.
`minDwellSeconds` stops sub-frame dithering between near-equal scores;
`hysteresisBonus` gives the incumbent a standing edge so a behaviour must be beaten
clearly, not narrowly.

#### Three bugs worth recording, because each was a modelling error rather than a typo

**1. A negative weight can only penalise, never reward.** `ram: { weaponSpin: -0.60 }`
was *meant* to say "ram when the blade is down" — but with `weaponSpin` already at 0 the
term contributes exactly 0. The same mistake silently disabled `spin-up` in all three
personalities; it never once won a vote. Saying "do X when Y is absent" requires Y's
complement as its own consideration, hence `bladeDown`. **In a weighted-sum model,
every consideration you want to reward needs to be the thing that is present.**

**2. One consideration covering two states collapses both.** Replacing that weight with
`bladeDown` made *every* bot ram forever, because a blade still spinning up and a blade
sheared clean off both read as `bladeDown: 1` — and they want opposite behaviours
(spin-up vs ram). Splitting `weaponLost` out fixed it. A passive wedge counts as
`weaponLost` too, which is why Doorstop rams: it has a weapon *part* but no controller,
so entity-exists was never a sufficient test.

**3. A behaviour has to actually do what its name says.** `circle-strafe` drove forward
at 0.6 on an offset heading, which does not orbit two 162 kg bots that are touching —
it leans on them. `proximity` stayed pinned, so `engaged` never decayed, so attacking
stayed penalised, and the defensive and opportunist sets orbited *forever*. It now
reverses while turning when inside engagement range. The lesson is that a broken action
implementation reads exactly like bad weights, and tuning numbers cannot fix it.

The first version of the scored AI also just ground into the player for 30 s straight
(`attack`, 40 samples, zero switches) because the scripted version's `ATTACK_DWELL` had
no equivalent. That became `engaged` — a consideration rather than a hard timer, so
breaking off *competes* with attacking instead of pre-empting it. Its threshold is
nose-to-nose rather than merely close, because circling is itself a way of disengaging.

**Measured (T-5.22).** 30 s per personality, Ravager vs Ravager, sampled every 0.75 s:

| Personality | Switches | Mix |
|---|---|---|
| aggressive | 17 | attack 9, ram 9, retreat 6 |
| defensive | 16 | attack 8, charge 6, circle-strafe 7, spin-up 3 |
| opportunist | 13 | circle-strafe 11, attack 7, ram 6 |

Three distinct temperaments, none monotone, none stuck, zero errors. `spin-up`
appearing at all is the evidence that fix 1 landed.

**Debug overlay (T-5.21).** F3 toggles a live panel of every consideration value and
every action score, winner marked. `params.debug` forces it on without a keypress —
which is also how it gets tested, since `input.synthesizeKey` does not drive action
state from a script (`drive.forward` reads `held: false` with `KeyW` synthesised), so
the key path itself is only exercised by hand.

**Weapon management.** Each action declares whether it wants the blade turning, written
as `spinCommand` onto the weapon's params and only on change. `autoSpin` is now reserved
for display roles — the select turntable and the Workshop preview — because "always on"
is precisely the decision this AI exists to make.

---

## 5b. The match: lifecycle and scene flow (T-6.2, T-6.3, T-3.15)

Everything above makes a fight *possible*. This is what makes it a **match** — it
starts, it ends, and it tells you who won.

### MatchDirector (T-6.3)

`game/scripts/MatchDirector.ts`, one marker entity per fighting scene, params choose
the mode:

| param | `Arena01` | `DemoCenter` |
|---|---|---|
| `mode` | `"match"` | `"practice"` |
| `matchSeconds` | 120 | — (untimed) |
| `countdownSeconds` | 3 | 3 |

State is `countdown → fighting → over`.

**The freeze channel.** During the countdown, and again once the match is over, both
bots are held still by writing `frozen: true` into `BotDrive`'s params — the same
read-modify-write channel DamageSystem already uses for `driveLeft` / `driveRight`.
BotDrive checks `frozen` *before* it decides whether to read the keyboard or an AI
intent, so one flag stops the human and the AI identically and no third code path
appears.

**Weapons are deliberately not frozen.** Spinning up during the countdown is a real
tactic in the sport, it costs nothing to allow, and it reads well on screen.

**Two ways a match ends.**

- **Knockout** — `battlebots.knockout` from DamageSystem. The knocked-out role loses.
- **Time expiry** — decided on damage dealt. The director does *not* keep its own
  tally: it emits `battlebots.requestReport` and ranks the reply. DamageSystem already
  tracks damage per role, so making the judge read from it keeps one source of truth
  for "who was winning". A gap under 0.5 HP is a draw.

Verdict is announced on the HUD and emitted as `battlebots.matchResult`.

The engine's own `game.*` session state is driven alongside ours so the host reflects
reality. Those transitions are legality-checked, so the director probes `game.status`
first and lets a rejected transition be a no-op rather than an error in the log.

### Scene flow (T-6.2)

`project.loadScene` **from inside a script hook is safe** — verified: the ScriptSystem
drops its instances on `world.reloaded` and the engine keeps stepping. That killed the
deferred-request queue this was going to need; buttons switch scenes directly.

    BotSelect ──PRACTICE──> DemoCenter ──Change Bot──┐
        │                       │                    │
        └────FIGHT───> Arena01 ──Rematch──> itself    │
                          │                          │
                          └──────Change Bot──────────┴──> BotSelect

**Reloading the scene *is* the match reset** (T-5.8). Part health lives in
DamageSystem's own Map, and force-broken joints are runtime state — so a fresh load
restores both without any bespoke teardown. Rematch is one `loadScene` call. This is
also why swapping a practice opponent reloads rather than hot-swapping: tearing down
eight jointed bodies while DamageSystem holds references to them is the risky path,
and reloading resets health too, which is what you want between rounds anyway.

`MainMenu` and `PostMatch` remain stubs; the richer post-match breakdown is T-6.4.

### DemoCenter — the Test stage (T-3.15)

Same room as `Arena01`, `practice` mode, plus the two things practice needs that a real
match does not:

- **Spar against** — the roster as a list; clicking one writes
  `/data/bots/__opponent.json` and reloads. The scene's opponent spawner is
  `BotSpawn:__opponent:opponent`, so this needs no new machinery in the assembler — it
  is the same `__`-prefixed runtime-state pattern Bot Select uses for the player's bot,
  and `__` files are excluded from the bundle so a practice opponent never shows up as
  a seventh roster entry.
- **Controls** — six lines of hints, because nothing else in the game teaches them.

Practice has no clock and no verdict, so its Restart and Change Bot buttons are
visible from the start rather than appearing on a result.

---

## 6. Destruction (T-5.1 – T-5.6)

**No fracture solver is needed** — but we do have to enforce the break ourselves.

The original plan was that `Joint.breakForce` ships natively, so the proposal's "custom
breakable-joint system" would reduce to *configuration plus event handling*. **That was
wrong, and the correction is 2026-08-20's main finding.** T-1.13 confirmed the *field*
exists; it never tested that a joint actually breaks. It does not: `breakForce` is stored
and echoed back faithfully, but no break check runs and `physics.jointBroken` never fires
(**BUG-013** — two 5 kg boxes on a `breakForce: 100` joint survive a 50 000 N·s impulse
with their separation unchanged to the millimetre).

So detachment is resolved in `DamageSystem` instead, off the contact force it already
reads for the damage math: a part whose contact force exceeds its cached mount strength is
detached on the spot. Two consequences worth being honest about:

- **Impact shears work; levering does not.** Contact force on the *part* is not the
  joint's solver impulse, so a part slowly prised off by sustained load will not come
  away — only a hard enough single hit does. In a sport that is mostly impacts this is a
  small loss, and it is why the constant is called a mount strength rather than a break
  force.
- **The mechanic is real now, where before it was decorative.** Until this landed the
  entire table below did nothing, and T-5.5's progressive weakening was halving a number
  nothing consulted.

Seed `breakForce` by socket category:

| Socket | breakForce (N) |
|---|---|
| Armor plate | 2 500 |
| Wheel mount | 4 000 |
| Motor | 9 000 |
| Weapon head | 12 000 |

Curated breakable set (adopted scope cut, enforced by `BREAKABLE` in `DamageSystem.ts`):
**wheels, weapon head, armor plates.** Not every part, and no free-fracture — a part
either detaches whole or stays put. A motor is internal, so a destroyed motor stays
bolted in and simply stops working; that keeps "what can fall off" a list you can read
rather than a consequence of which parts happen to have a joint.

**Debris (T-5.3).** A detached part stays dynamic and interactive — arena clutter you can
shove and be tripped by — then is culled after `debrisLifetimeSeconds` (12 s), or early if
more than `DEBRIS_CAP` (8) pieces are on the floor, so a scrappy match cannot outgrow the
timer. Culling a detached weapon means deleting an entity that still carries its
`WeaponController`, which is only safe because BUG-011 was fixed.

A force-break is **runtime state, not an edit** — the authored joint returns on scene reload, which is what makes match reset tractable (still to be verified end-to-end, T-1.15 / T-5.8).

---

## 7. Performance budget (T-1.17)

**Measured:**

| Scene | Bodies | Joints | ms / fixed step | Headroom at 60 Hz |
|---|---|---|---|---|
| Greybox bot + arena | 5 | 4 | 0.055 | ~300x |
| Two assembled bots + arena | 16 | 14 | 0.135 | ~124x |

This is stepping cost in isolation and excludes rendering, so it is a ceiling on the physics side only. Scaling is mildly superlinear (bot-vs-bot contacts), but risk **R1** ("physics budget can't carry 2 bots + debris") is far less threatening than the proposal assumed — the two-bot case that T-6.10 exists to verify already runs with two orders of magnitude to spare. Debris caps (T-5.3) remain worth having, but as a rendering and readability measure rather than a solver rescue.

### Assembled-bot drive feel

The week-1 tuning transfers essentially unchanged from the 90 kg greybox to the 98 kg assembled bot, which is the useful result — the constants are not knife-edge:

| | Greybox (90 kg) | Assembled `player-slice` (98 kg) |
|---|---|---|
| Top speed | 4.53 m/s | **4.46 m/s** |
| Peak yaw | 2.33 rad/s (133 deg/s) | **2.28 rad/s (130 deg/s)** |
| Upright after a full-speed run | yes | yes (up.y = 1.000) |

---

## 8. Controls (T-0.13)

| Action | Key | Notes |
|---|---|---|
| `drive.forward` / `drive.back` | `W` / `S` (also `↑` / `↓`) | |
| `turn.left` / `turn.right` | `A` / `D` (also `←` / `→`) | |
| `weapon.primary` | `Space` | spin up / swing |
| `weapon.secondary` | `Left Shift` | reserved |
| `bot.selfRight` | `R` | 2 s cooldown, only while flipped |
| `ui.pause` | `Escape` | |

Input is collapsed to **left/right track throttle** and then recombined into forward + yaw, so the eventual two-stick gamepad mapping and this keyboard mapping run the same code path. Bindings are mirrored in `game/data/input-map.json`.

Player 2 and gamepad support is T-6.6 and is the one week-6 item flagged to spike early.

---

## 9. Part list v1

14 parts ship in `game/data/parts/`. Weapons beyond the spinner and passive wedge are week 4 (T-4.1 – T-4.4).

- **Chassis** — `ch-box-m` (45 kg), `ch-wedge-m` (40 kg), `ch-brick-h` (80 kg)
- **Wheels** — `wh-s` (3 kg), `wh-m` (5 kg), `wh-l` (8 kg)
- **Weapons** — `wp-spinner-h` (18 kg, horizontal spinner), `wp-wedge-p` (10 kg, passive)
- **Armor** — `ar-light` (6 kg), `ar-med` (12 kg), `ar-heavy` (20 kg)
- **Motors** — `mt-speed` (7 kg), `mt-balanced` (9 kg), `mt-torque` (12 kg)

Every chassis exposes the same ten sockets: 4 × wheel, 1 × weapon (top), 4 × armor, 1 × motor.

---

## 10. Out of scope

Cut in §4 of the proposal: online multiplayer · ML-trained opponent AI · general free-fracture
destruction · freeform (non-socket) building.

Cut on 2026-08-19 (§0): **the player-facing build system**, and with it player paint/decals, bot naming,
and the saved-bot roster with thumbnails. The Workshop that implements part fitting still exists and is
retained as a stretch feature.

Still **kept**: local multiplayer, and the socket data model that prebuilt bots are authored over.
