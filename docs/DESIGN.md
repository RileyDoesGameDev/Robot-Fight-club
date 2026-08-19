# Battle Bots — Design Doc

Working title: **Battle Bots** · Engine: **DSD SMPL-Engine** · Solo developer · 8 weeks, feature-complete by end of week 6.

This is the contract referenced by `TASKS.md`. Where this document and the proposal disagree, this document wins — it records decisions actually taken and measured. Numbers marked **(measured)** came from a real run in the engine, not an estimate.

---

## 1. Core loop

**Create → Test → Destroy**, mirroring the show.

| Stage | Scene | What the player does |
|---|---|---|
| Create | `Workshop` | Fit parts to chassis sockets, paint, name, save a blueprint |
| Test | `DemoCenter` | Spar against a pre-built AI opponent, learn controls, tune |
| Destroy | `Arena01` | Fight an AI opponent or a local human; parts break off |
| — | `PostMatch` | Damage summary → "revise your bot" back into the Workshop |

Win condition: **knockout** (all drive parts destroyed = immobilised, or chassis HP reaches zero) or, on time expiry, **most damage dealt**.

---

## 2. Units, scale, and mass budget (T-0.16)

- **1 world unit = 1 metre. 1 mass unit = 1 kilogram.** Gravity is −Y.
- Arena playfield: **12 × 12 m**, walls 1.2 m high and 0.3 m thick, inner wall faces at ±6.0 m.
- Bot footprint: 0.6–0.9 m long, 0.6–0.72 m wide, ≈0.25–0.30 m tall.
- **Socket lattice: 0.02 m.** Every socket offset in `game/data/parts/*.json` is an integer multiple of it, enforced by `game/data/validate.js`.
- Editor conventions (T-0.12): up-axis **Y**, grid unit **metre**, gizmo snap **on** (1 m — right for arena blockout). Socket precision does *not* come from gizmo dragging; sockets are authored numerically in JSON, which is why a 1 m snap and a 0.02 m lattice coexist without conflict.

### Weight classes

| Class | Mass cap | Seed blueprint |
|---|---|---|
| Lightweight | ≤ 60 kg | — |
| Middleweight | ≤ 110 kg | `player-slice` (98 kg), `opp-wedge` (89 kg) |
| Heavyweight | ≤ 180 kg | `opp-brick` (168 kg) |

The Workshop refuses to save an over-cap bot (T-4.8). Mass is always the **sum of every attached `PartDef.mass`** — never hand-authored.

---

## 3. Build system: sockets, not freeform (T-2.3, T-2.4)

Adopted scope cut from the proposal: **fixed attachment points**, explicitly not freeform placement.

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
which is what lets the Workshop hand any saved blueprint to any scene.

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

### The Workshop (T-2.12 – T-2.18)

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

State per part: `intact → damaged → destroyed`, with `damaged` at **≤ 50 % HP**.

```
impactEnergyJ  = ½ · effectiveMass · relativeVelocity²
raw            = impactEnergyJ · weaponFactor · (1 − armorReduction)
damage         = raw < damageFloorJ ? 0 : raw · damageScaleHpPerJ
```

Constants live in `game/data/damage.json` so tuning never needs a recompile:

| Knob | Value |
|---|---|
| `damageFloorJ` | 150 — shoves must not chip armour |
| `damageScaleHpPerJ` | 0.02 → a 3000 J hit ≈ 60 HP pre-armour |
| `weaponFactor` | spinner 1.0, drum 0.9, hammer 1.3, flipper 0.3, wedge 0.15 |
| `armorReduction` | light 0.15, medium 0.30, heavy 0.45 |
| `contactForceEventThresholdN` | 400 — below this, no contact event is even emitted |

The damage signal source is **`Collider.contactForceEventThreshold`** (confirmed present, T-1.14) feeding `physics.contact`. Setting it per part is what keeps the event stream affordable (T-3.4).

### Functional degradation (T-3.6) — what makes damage matter

| Part | `damaged` | `destroyed` |
|---|---|---|
| Wheel | drive torque × 0.55 on that side | that side stops driving |
| Weapon | RPM × 0.6 | no attack |
| Armor | reduced protection | hitbox exposed |
| Motor | reduced output | drive dead |

Progressive weakening (T-5.5): a `damaged` part's joint `breakForce` is multiplied by **0.5**, so accumulated hits eventually shear it off.

---

## 6. Destruction (T-5.1 – T-5.6)

**No fracture solver is needed.** `Joint.breakForce` ships natively (confirmed, T-1.13): the joint disconnects and emits `physics.jointBroken` when its solver impulse exceeds `breakForce × timestep`. The "custom breakable-joint system" in the proposal is therefore *configuration plus event handling*.

Seed `breakForce` by socket category:

| Socket | breakForce (N) |
|---|---|
| Armor plate | 2 500 |
| Wheel mount | 4 000 |
| Motor | 9 000 |
| Weapon head | 12 000 |

Curated breakable set (adopted scope cut): **wheels, weapon head, armor plates.** Not every part, and no free-fracture.

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

Online multiplayer · ML-trained opponent AI · general free-fracture destruction · freeform (non-socket) building. All four were cut deliberately in §4 of the proposal. Local multiplayer and workshop customisation are **kept**.
