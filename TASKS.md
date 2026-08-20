# Battle Bots — Master Task List

Working title: **Battle Bots** · Engine: **DSD SMPL-Engine** (MCP-first, TypeScript + Three.js, WebGL2, Rapier 3D) · Solo developer · 8-week window, feature-complete by end of week 6.

Derived from `Battle_Bots_Project_Proposal (1).docx`. Every task is written to be individually checkable. IDs are stable — reference them in commits (`T-2.4: snap sockets`) and in Trello/Notion cards.

**Legend:** `[ ]` todo · `[~]` in progress / partially validated · `[x]` done · `[-]` superseded (no work required — the sub-bullet says what replaced it) · `[>]` deferred (descoped, may return as a stretch) · **(R)** = risk task, needs a spike before committing · **(V)** = validation/verification gate

> Sub-bullets starting **Result:** / **Decision:** / **Measured:** record the evidence a `(V)` task requires.

---

## 0. Engine & Repo Foundations (before Week 1 content work)

### 0.1 Stack up and reachable
- [x] **T-0.1** Bring up the Docker stack: `docker compose up -d --build` (editor `:4174`, runtime `:4173`, deployer `:4180/health`).
  - **Result:** stack up — `engine-runtime` :4173, `engine-editor` :4174, `engine-deployer` :4180.
- [~] **T-0.2** Verify all three services healthy (`docker compose ps`) and the editor loads in the browser.
  - **Result:** editor loads and is fully usable on :4174, but `docker ps` reports `engine-runtime` and `engine-editor` as **unhealthy** (deployer is healthy). Their healthchecks need a look — not blocking authoring.
- [x] **T-0.3** Build and register `smpl-mcp-bridge` so an AI agent can drive the live editor; confirm the full ~178-tool catalog appears after **Expose** (`ws://localhost:8765`).
  - **Result:** bridge works; catalog is **~380 tools**, not ~178 — and it contains **no `physics_*` namespace** (see T-1.16).
- [x] **T-0.4** Confirm `engine_status` reports `engineConnected: true` from the agent side. **(V)**
  - **Result:** `engine_status` → `engineConnected: true`, engine `smpl-engine-editor`.
- [x] **T-0.5** Note the Windows path caveat — this repo lives under `C:\Users\KOBI 2\...` (space in path). Either use the 8.3 short name in MCP config or relocate the repo to a space-free path.
  - Documented in `README.md`; use the 8.3 short name `C:\Users\KOBI2~1\...` in MCP config.

### 0.2 Game repo scaffolding
- [x] **T-0.6** `git init` is already done — add `.gitignore` (node_modules, dist, build output, Blender `.blend1`).
- [x] **T-0.7** Set up **Git LFS** and track `*.glb *.gltf *.png *.jpg *.tga *.wav *.ogg *.blend`. Commit `.gitattributes` **before** the first binary asset lands.
  - `git lfs install --local` done; `.gitattributes` committed in the first commit, before any binary.
- [x] **T-0.8** Create the SMPL-Engine project for the game (`project_createOnDisk` / `project_create`) named `battle-bots`; confirm with `project_active`. Today only `Default Project` exists.
  - **Result:** project `battle-bots` id `battle-bots-upgyz6`. Used `project_create` — `project_createOnDisk` needs an interactive folder picker an agent cannot drive, which is why the repo is the source of truth (T-0.11).
- [x] **T-0.9** Create the folder layout inside the project (`project_mkdir`): `scenes/`, `prefabs/`, `scripts/`, `materials/`, `assets/parts/`, `assets/arena/`, `assets/audio/`, `data/`.
- [x] **T-0.10** Create the scene set (`project_createScene`): `MainMenu`, `Workshop`, `DemoCenter`, `Arena01`, `PostMatch`.
  - All five created; `Arena01` built out, the other four are default placeholders.
- [x] **T-0.11** Decide and document the repo↔project relationship: is the engine project folder committed into this repo, or referenced? Write the answer in `README.md` so it isn't re-litigated later.
  - **Decision:** the git repo is the source of truth; the engine project (browser IndexedDB) is a working copy. Recorded in `README.md`.
- [x] **T-0.12** Set editor conventions once and record them: `editor_setUpAxis`, `editor_setGridUnit`, gizmo snap (`editor_setGizmoSnap`). Snap values must match the part-socket grid from T-2.3.
  - **Recorded:** up-axis Y, grid unit metre, gizmo snap on (1 m). Socket precision comes from JSON, not gizmo drags, so the 1 m snap and the 0.02 m socket lattice do not conflict.

### 0.3 Design doc + tracking
- [x] **T-0.13** Finalize the design doc: core loop, weight classes, damage model, win conditions, control scheme, part list v1.
  - `docs/DESIGN.md`.
- [x] **T-0.14** Write the **one-page vertical slice definition** (one arena, one chassis, one weapon, one AI opponent) and pin it — this is the week 2–3 gate.
  - `docs/VERTICAL-SLICE.md`.
- [ ] **T-0.15** Set up the Trello/Notion board with columns mapped to the 8 weeks; import these task IDs.
- [x] **T-0.16** Define the units/scale convention (1 unit = 1 m; robot ≈ 0.6–1.2 m; arena ≈ 12 × 12 m) and the mass budget per weight class in kg — physics tuning is unrecoverable without this fixed early.
  - 1 unit = 1 m, 1 mass unit = 1 kg; arena 12 x 12 m; classes 60 / 110 / 180 kg in `game/data/weight-classes.json`.

---

## 1. Week 1 — Pre-production & Prototyping

### 1.1 Test arena blockout
- [x] **T-1.1** Block out `Arena01` from primitives (`scene_createEntity` + `MeshRenderer.primitive`, `model_createPrimitive` for anything custom): floor, four walls, corner pits.
  - Floor as three panels leaving four 2 x 2 m corner pits, four walls, pit floors at y = -1.65.
- [x] **T-1.2** Add static colliders to the arena shell (`Collider` + `RigidBody.type: "fixed"`).
- [~] **T-1.3** Add lighting + a fixed match camera; save a camera bookmark (`viewport_setCamera` values recorded in the design doc).
  - Match camera at `[0, 11, 12]` looking at origin, fov 60 (recorded in `game/scenes/Arena01.scene.json`). Key + ambient light authored, but **the editor viewport shades with its own preview lighting**, so the lighting look is unverified until seen in the runtime at :4173.
- [x] **T-1.4** Run `scene_validate` on `Arena01` and clear all errors. **(V)**
  - **Result:** `scene_validate` → `ok: true`, 0 errors / 0 warnings across 23 entities (also clean with `floorY: -2.5`).
- [x] **T-1.5** Save the scene (`project_saveScene`) and commit.

### 1.2 Bot movement prototype
- [x] **T-1.6** Build a placeholder bot: chassis box with `RigidBody` (dynamic, explicit `mass`) + `Collider`, four wheel entities.
  - Chassis 70 kg (explicit `massProperties`, CoM -0.08 m in Y) + 4 x 5 kg wheel bodies on breakable fixed joints = 90 kg.
- [x] **T-1.7** Decide the drivetrain model — **revolute wheel joints with velocity motors** vs. **direct impulse/velocity drive on the chassis**. Prototype both, pick one, document why. **(R)**
  - **Decision: direct chassis drive.** Impulse on the chassis; wheels are real bodies on breakable joints but do not propel. Rejected revolute wheel motors (four extra motorised constraints per bot, drive feel coupled to joint stiffness). Rationale in `docs/DESIGN.md` §4.
- [x] **T-1.8** Author `scripts/BotDrive.ts` (`script_create` → `script_attach`) implementing tank-style drive: left/right track throttle, turn-in-place.
  - `game/scripts/BotDrive.ts`, compiled and attached. Note it must use **impulses, not forces** — see T-1.16 and `docs/engine-notes.md` §1.
- [x] **T-1.9** Map input actions (`input_mapAction`): `drive.forward`, `drive.back`, `turn.left`, `turn.right`, `weapon.primary`, `weapon.secondary`, `bot.selfRight`, `ui.pause`.
  - All eight actions mapped; mirrored in `game/data/input-map.json`.
- [x] **T-1.10** Tune drive feel: acceleration, top speed, `linearDamping`/`angularDamping`, friction, center of mass. Record the final numbers in the design doc.
  - **Measured:** top speed 4.53 m/s; peak yaw 2.33 rad/s (133 deg/s); idle drift 0.0001 m; coast to <0.03 m/s in 1 s. Wheel friction 0.6, `linearDamping` 0.35, `angularDamping` 2.5. Constants at the top of `BotDrive.ts`.
- [x] **T-1.11** Verify the bot cannot tunnel through arena walls at top speed; enable `RigidBody.ccdEnabled` if it does. **(V)**
  - **Result:** at top speed the bot rests at z = -5.600 — exactly wall face (-6.0) + chassis half-length (0.4). **No tunneling**, CCD enabled. Also survived an uncapped ~18 m/s impact without passing through.
- [~] **T-1.12** Add a self-righting impulse so a flipped bot isn't a dead match.
  - Implemented (700 N·s kick + 1600 N·m·s roll, 2 s cooldown) and traction gating verified — a flipped bot cannot drive. **But the greybox cannot rest fully inverted** (settles to up.y ~0.47 unaided), so there is no stable flipped state to test against. Re-validate on real chassis geometry in week 2.

### 1.3 Engine capability audit (de-risking)
- [x] **T-1.13** **Confirmed:** the `Joint` component already ships `breakForce` (newtons; the joint disconnects and fires `physics.jointBroken` when its solver impulse exceeds `breakForce * timestep`). The "custom breakable-joint system" in the proposal is therefore mostly *configuration + event handling*, not a fracture solver. Update the proposal's risk framing accordingly.
- [x] **T-1.14** **Confirmed:** `Collider.contactForceEventThreshold` (N) filters contact events — this is the damage signal source. Verify the `physics.contact` event payload shape (force magnitude, both entities, contact point/normal) via `events_listChannels` + `events_poll`. **(V)**
  - **Answered.** Event payload `{ a, b, started, point, normal, maxForce, force }`, verified live. It fires only on contact **begin/end**, so the damage system polls `physics.getContacts()` instead — live contacts refreshed every step, each with `maxForce` in newtons. Peak inter-bot force in a full-speed ram: **4311 N**. (Before the engine fixes, `maxForce` read 0 with any non-zero threshold; it reports correctly now.)
  - Field confirmed present (`Collider.contactForceEventThreshold`, newtons) and set to 400 on bot colliders. **Still to do:** verify the actual `physics.contact` payload shape via `events_listChannels` + `events_poll` during a real impact.
- [ ] **T-1.15** Verify what a force-broken joint leaves behind: does the detached part stay a live dynamic body, and does the authored joint return on scene reload (docs say yes — a force-break is runtime state, not an edit)? This determines how match reset works. **(V) (R)**
- [x] **T-1.16** Confirm whether `physics_*` MCP tools are exposed through the bridge in this build; if not, all physics reads/writes happen from scripts. Record which path the game uses.
  - **Answered: the bridge exposes no `physics_*` tools.** The provider is registered inside engine-core, so **scripts are the only path to physics**. Scripts must resolve the synchronous handlers from `engine.mcp.toolMap` — `engine.mcp.callTool` is async and unusable in a fixed step.
- [x] **T-1.17** Measure the fixed-step budget: how many dynamic bodies + joints run at target frame rate before frame time degrades? Use `profiler_getFrameStats` with 2 bots × N breakable parts. This sets the part-count ceiling for the whole project. **(V) (R)**
  - **Measured:** 1 bot (5 dynamic bodies, 4 joints) + full arena = **0.055 ms per fixed step**, ~300x headroom in a 16.67 ms frame. Physics-side only (excludes rendering), but risk R1 is much smaller than assumed.

---

## 2. Week 2 — Build System Prototype

> **RESCOPED 2026-08-19.** The player-facing build system is cut; Create becomes **choosing a prebuilt
> bot** (`docs/DESIGN.md` §0). What that means for this section:
> - **§2.1 / §2.2 (data model + assembler) stay fully in scope** — prebuilt bots are authored over exactly
>   this socket model, and the assembler is what turns one into a live bot.
> - **§2.3 (the Workshop) is built and working, but is now a stretch feature.** Its `[x]` marks are
>   accurate — that code exists and is verified. It is simply no longer on the critical path, and it is
>   how the prebuilt roster gets authored.
> - **§2.4 (Bot Select) is the new critical path** for this stage.

### 2.1 Part data model
- [x] **T-2.1** Define the `PartDef` schema (JSON in `data/parts/`): `id`, `category` (chassis/wheel/weapon/armor/motor), `displayName`, `mass`, `hp`, `cost`, `mesh`, `colliderSpec`, `sockets[]`, `requiresSocketType`, `stats{}`.
  - `game/data/schemas/part-def.schema.json` + 14 parts in `game/data/parts/`.
- [x] **T-2.2** Define the `BotBlueprint` schema: `name`, `chassisId`, `attachments[{ socketId, partId, paint }]`, `weightClass`, derived totals. This is the save format shared by Workshop, Demo Center, and Arena.
  - `game/data/schemas/bot-blueprint.schema.json` + 3 seed blueprints in `game/data/bots/`.
- [x] **T-2.3** Define the **socket/attachment-point system**: named sockets on each chassis with a local position, orientation, and accepted part categories. Fixed attachment points — explicitly *not* freeform placement (per the proposal's adopted scope cut).
  - Ten sockets per chassis (4 wheel, 1 weapon, 4 armor, 1 motor), each with local position, accepted categories and `breakForce`. All offsets on the 0.02 m lattice, enforced by `game/data/validate.js`.
- [x] **T-2.4** Implement socket authoring: sockets as child entities of the chassis prefab, tagged by a `Socket` component or a naming convention. Pick one and be consistent.
  - **Decision:** the PartDef JSON is the single source of truth; the assembler creates a child entity per socket at runtime. No `Socket` component, no naming-convention parsing — one mechanism, so the two cannot disagree.

### 2.2 Prefabs
- [-] **T-2.5** Author the chassis prefab (`prefab_create`) with sockets, `RigidBody`, `Collider`, and `MeshRenderer`.
  - **Superseded by T-2.9.** The assembler builds the chassis directly from its PartDef; a prefab would duplicate its mass, collider and sockets in a second place needing regeneration on every JSON change. Rationale in `docs/DESIGN.md` §3.
- [-] **T-2.6** Author wheel prefabs (small/medium/large) with their own mass and friction values.
  - **Superseded by T-2.9** — wheel mass and friction come from `game/data/parts/wh-*.json`.
- [-] **T-2.7** Author **one** weapon prefab for the slice — the horizontal spinner: weapon body + revolute joint + velocity motor + damage collider.
  - **Superseded by T-2.9** — the assembler gives a powered weapon a revolute joint with a velocity motor from `PartDef.stats` (axis, targetRpm, motorMaxForce). The spinner's damage collider and spin-up logic are T-3.9.
- [-] **T-2.8** Author one armor-plate prefab.
  - **Superseded by T-2.9** — armour plates come from `ar-*.json`.
- [x] **T-2.9** Write the **assembler**: `scripts/BotAssembler.ts` takes a `BotBlueprint` and produces a live bot in the scene via `prefab_instantiate` + `scene_reparent` + `Joint` writes at each socket.
  - **Result:** `game/scripts/BotAssembler.ts`. Spawner-marker driven (`BotSpawn:<blueprintId>:<role>` in the entity `Name`, since `script.attach` takes no per-instance args), idempotent via a rename to `BotSpawned:`. Builds one dynamic body per part on a breakable joint; powered weapons get a revolute joint + motor, everything else `fixed`. Reads `/data/bundle.json`.
- [x] **T-2.10** Write the reverse path: serialize a live in-workshop bot back to a `BotBlueprint`.
  - **Result:** `readBackFromScene()` in `WorkshopController.ts` rebuilds a blueprint from the live entity tree — chassis recovered by matching collider half-extents, attachments parsed out of `Bot_workshop_<socketId>_<partId>` names. Save writes what the SCENE contains, not the in-memory draft, and reports whether the two agree. Verified: `roundTripMatches=true`.
- [x] **T-2.11** Verify assembler determinism: same blueprint → identical entity tree, masses, and joint anchors twice in a row. **(V)**
  - **Result:** two independent assemblies of `player-slice` produced byte-identical structural signatures (masses, collider shapes, joint kinds, anchors, break forces, motor config). Every joint anchor exactly equals its authored socket position — 0 mismatches. Assembled mass equals declared mass exactly (98 kg `player-slice`, 89 kg `opp-wedge`).

### 2.3 Workshop scene
- [x] **T-2.12** Block out the `Workshop` scene: turntable platform, lighting, part racks, camera rig.
  - **Result:** floor, raised turntable, backdrop, two part racks, key + ambient light, and a player-facing camera at `[0, 1.4, 4.2]`. Turntable is a box, not a cylinder — see `docs/engine-bugs.md` LIM-005.
- [x] **T-2.13** Build the workshop UI (`ui_createCanvas` / `ui_createTree`): part category tabs, part list, socket selector, stat readout, Save / Load / Test buttons.
  - **Result:** 43 UI elements / 24 buttons across five panels — category tabs, part list, socket list, live stat readout, and Save / Load / Test / Remove / Undo / Redo. Built with `ui.createCanvas` + one `ui.createTree` per panel (a wrapper root would collapse its children's fractional anchors).
- [>] **T-2.14** Implement click-to-select a socket, then click-to-fit a part; show a ghost/preview before commit.
  - **Deferred with the build system (2026-08-19).** The part that shipped — click-to-select-socket then click-to-fit, with every fit rebuilding the preview immediately — works. **The ghost/preview-before-commit is deliberately not built:** immediate apply plus undo/redo is simpler and gives better feedback than a ghost you must confirm. Revisit only if playtesters ask for it. Also still missing: clicking a socket *in the 3D view* (needs picking); selection is list-driven for now.
- [x] **T-2.15** Implement part removal and swap.
  - **Result:** fitting into an occupied socket swaps in place (verified 110 kg Medium Plate -> 118 kg Heavy Plate with the part count unchanged at 8); Remove clears the selected socket (verified wheels 4 -> 3 -> 4).
- [x] **T-2.16** Wire undo/redo in the workshop through `undo_beginTransaction` / `undo_commit` / `undo_undo` so each fit is one atomic step.
  - **Result:** undo/redo over draft snapshots, each edit wrapped in `undo.beginTransaction` / `undo.commit` so the scene rebuild collapses to one editor undo step. Verified 98 -> 110 -> 118 -> undo 110 -> undo 98 -> redo 110, with the preview rebuilt each time.
- [x] **T-2.17** Live stat panel: total mass, weight class, top-speed estimate, armor total, weapon damage rating.
  - **Result:** live panel showing name, chassis, mass + weight class, armour total, weapon rating, estimated top speed, and wheel count. Over-cap mass and a bot with <2 wheels both turn red.
- [x] **T-2.18** Blueprint persistence: save/load named bots (`game_saveSlot` / `game_loadSlot` or a JSON file via `project_writeFile`). Pick one and document it.
  - **Decision: plain JSON via `project.writeFile`**, not `game.saveSlot` — a blueprint is authored content that must stay diffable and exportable to the repo. Bots go to `/data/bots/<slug>.json` with the roster in `/data/roster.json`. Load cycles roster + bundled blueprints (verified opp-brick -> opp-wedge -> player-slice -> new-bot -> wrap). Saving an over-cap bot is refused (verified at 204 kg), which also covers T-4.8.
- [>] **T-2.19** **Vertical-slice gate:** build a bot in the Workshop → launch it into `Arena01` → drive it. Loop closes end to end. **(V)**
  - **Superseded by T-2.23** — the gate is now *select* a bot, not build one. The Workshop half of this already works; only the scene hand-off was ever missing.

### 2.5 Engine-fix follow-ups (added 2026-08-20)

- [ ] **T-2.24** Migrate `BotAssembler.ts` and `WorkshopController.ts` off the old workarounds: use `ctx.call` instead of `engine.mcp.toolMap` (which was private and skipped zod defaults — the cause of the hidden-canvas bug), and `Script.params` instead of encoding arguments into `Name`. `BotDrive.ts` and `DamageSystem.ts` already use both.
- [ ] **T-2.25** Delete `WorkshopController`'s 3-frame disable/re-enable rebuild machine — BUG-011 is fixed, so a Script-bearing entity can be deleted from inside a hook directly.
- [ ] **T-2.26** Move input-map application out of `BotDrive.onStart` into a scene bootstrap. `input.mapAction` bindings are runtime-only and are not serialized, so *something* must re-apply them after every scene load; a bot is the wrong owner. Fold into T-6.2.
- [ ] **T-2.27** Re-check point-light intensity now that blank captures are impossible: three.js 0.171 makes `point` intensity candela with inverse-square falloff, so the component default of 1 is effectively invisible at metre scale (`engine-fixes.md` LIM-003). Our scenes use directional + ambient only, so this is a look-pass item, not a bug.

---

### 2.4 Bot Select — the new Create stage (added 2026-08-19)

- [x] **T-2.20** Author the prebuilt roster: 4–6 bots spanning the weight classes, each a `BotBlueprint` in `game/data/bots/`, each distinct enough to change how a match plays. Three exist (`player-slice`, `opp-wedge`, `opp-brick`) — they need companions with different weapons, not just different masses.
  - Six bots spanning all three classes: Hornet 69 (light), Doorstop 89, Blue Ruin 98, Grinder 107 (middle), Ravager 162, Anvil 168 (heavy). Chosen to change how a match plays — an unarmoured sprinter, two wedges, two spinners at different weights, and one bot with no weapon at all. **Also raised the lightweight cap 60 -> 80 kg**: the lightest rolling bot is 59 kg and the cheapest weapon is 10 kg, so at 60 no lightweight build could carry a weapon.
- [x] **T-2.21** Build the `BotSelect` scene: turntable preview of the highlighted bot, roster list, per-bot stat card (mass, class, armour total, weapon, top-speed estimate), Prev / Next / Confirm. Reuse `WorkshopController`'s stat + preview machinery — the preview path (write blueprint → spawner marker → `BotAssembler`) already works.
  - `game/scripts/BotSelectController.ts` + the `BotSelect` scene (8 authored entities). Roster list, spec card (class, mass, weapon, armour, estimated speed, chassis, blurb), Prev/Next/CONFIRM, and a turntable preview built through the same spawner path the Workshop uses. Role `select` is inert — no drivetrain, no AI brain. Speed estimate is clamped to BotDrive's MAX_SPEED; unclamped it overstated Hornet at 8.23 m/s.
- [x] **T-2.22** Bot-select → arena hand-off: the confirmed blueprint id becomes the player spawn in `Arena01` / `DemoCenter`. Depends on the same scene-flow plumbing as T-6.2.
  - CONFIRM writes `/data/bots/__selected.json`; `Arena01`'s player spawner is `BotSpawn:__selected:player` and BotAssembler already resolved ids from `/data/bots/<id>.json`, so no new plumbing was needed. `__`-prefixed files are excluded from the bundle so the selection is not mistaken for a roster entry. Automatic scene switching remains T-6.2.
- [x] **T-2.23** **Vertical-slice gate (replaces T-2.19):** choose a bot in `BotSelect` → launch into `Arena01` → drive it. Loop closes end to end. **(V)**
  - **Gate passed.** Confirmed Ravager in BotSelect -> loaded Arena01 -> the player bot was assembled as Ravager (4x wh-l, spinner, heavy plate, torque motor, 162 kg) -> drove it with the spinner running and fought the AI: 30.2 / 31.0 damage exchanged, 4 parts damaged, `scene.validate` clean, 0 new errors.

---

## 3. Week 3 — Combat Prototype

### 3.1 Damage model
- [x] **T-3.1** Implement the `PartHealth` state: `hp`, `maxHp`, `state ∈ {intact, damaged, destroyed}`, `armorRating`.
  - In `DamageSystem.ts`: per part `hp`, `maxHp`, `state ∈ {intact, damaged, destroyed}`, `armorTier`. Held in the script's own Map keyed by entity — no component exists for it, and resetting on scene reload is exactly what a match restart wants (T-5.8).
- [x] **T-3.2** Write `scripts/DamageSystem.ts`: subscribe to contact/force events, convert impulse magnitude → damage, apply it to the struck part.
  - `game/scripts/DamageSystem.ts`. Polls contacts, filters to inter-bot pairs, converts force to damage, applies it to the struck part. Discovers bots by entity name, so it needs no per-bot wiring.
- [x] **T-3.3** Define the damage formula: `damage = f(relativeVelocity, weaponMass, weaponType, armorRating)` with a minimum threshold so shoves don't chip armor. Tune per weapon later.
  - **Defined** in `docs/DESIGN.md` §5, constants in `game/data/damage.json`: energy-based, `damageFloorJ` 150 so shoves cannot chip armour, per-weapon `weaponFactor`, per-tier `armorReduction`. Unverified against real impacts until T-3.2 / T-3.11.
- [x] **T-3.4** Set `Collider.contactForceEventThreshold` per part so the event stream stays cheap — do **not** report every contact.
  - Set to 400 N on every bot collider by the assembler, from `damage.json`. **One value for all parts** — per-category tuning is deferred until profiling says it matters; below the threshold the solver reports no force at all, which is what makes per-step polling cheap.
- [x] **T-3.5** Implement damage-state visuals: swap material/color or mesh at `damaged`, hide + detach at `destroyed`.
  - `damaged` tints the part; `destroyed` tints it dark **and drops its Joint** so it becomes free arena debris. Verified `joint=DETACHED`. Detaching rather than hiding is deliberate — a part that mechanically left the bot should be visible on the floor.
- [x] **T-3.6** Implement functional degradation: a `damaged` wheel loses torque, a `damaged` weapon spins slower, a `destroyed` wheel stops driving entirely. This is what makes damage matter more than a health bar.
  - **Measured:** one damaged wheel took `driveRight` 1 → **0.775** = (1 + 0.55)/2; one destroyed wheel took `driveLeft` 1 → **0.5**; two gone → **0**. Delivered through `Script.params` on the chassis, which `BotDrive` reads fresh each hook — the sanctioned cross-script channel now that per-instance params exist.
- [x] **T-3.7** Implement the bot-level defeat condition: immobilized (all drive parts destroyed) or chassis HP zero → knockout.
  - **Verified:** losing 3 of 4 wheels emitted `{ role: "player", reason: "immobilised" }`. Two implementation traps found and fixed while testing: defeat is re-checked on the periodic scan (not only on a damage transition, or a wheel culled as debris would never trigger it), and wheel count is a **high-water mark** (or a removed wheel would shrink the denominator instead of counting as a loss).
- [x] **T-3.8** Add per-part collision groups (`Collider.collisionGroups`) so weapon damage colliders, chassis, and arena walls filter correctly and self-hits don't register.
  - Role-based filtering in the damage system: same-bot pairs and arena geometry never damage anything. Deliberately **not** `Collider.collisionGroups` — masks would risk the bots' physical solidity against the floor and each other, and the filter is a single comparison.

### 3.2 Weapon vs. armor
- [x] **T-3.9** Implement the spinner weapon controller: spin-up ramp, RPM state, energy loss on impact, jam/stall state.
  - **Result:** `game/scripts/WeaponController.ts`. Spin-up linear to 1396/1400 rpm in exactly 2.4 s; spin-down linear over 4.0 s; states `idle → spinup → ready → spindown`, plus relative-stall `jammed` detection. 86 weapon hits in one engagement against a facing target, blade forces 3.7–9.3 kN (under the 12 kN mount). Energy loss bleeds the *commanded* ramp on each hit so a weapon that keeps connecting never reaches full speed.
- [x] **T-3.10** Implement weapon-vs-armor interaction: armor reduces incoming damage, the weapon takes reaction damage on hits.
  - Armour reduction is measurable (light 0.15 vs medium 0.30 changes who loses the exchange), and reaction damage falls out of the model — both sides of a contact take damage, so the attacker's own front plate wears. Weapon damage now also scales by `spinFraction`, so a stopped blade does `ram` damage rather than weapon damage.
  - Armour reduction works and is measurable (the light-plate rammer takes more damage than the medium-plate defender). **Reaction damage falls out for free** — both sides of a contact take damage, so ramming face-first hurts your own plate. Still missing: weapon-specific interaction, which needs the spinner controller (T-3.9).
- [~] **T-3.11** Verify big hits produce plausible physics reaction (knockback, spin-out) rather than jitter or explosive launches. **(V) (R)**
  - **Substantial evidence gathered.** A bar-shaped blade at 1400 rpm either tunnels (0 contacts) or resolves at **132 kN** — an explosive launch, exactly the failure this task warns about. Colliding the swept envelope instead keeps forces at 3.7–9.3 kN with the blade attached and no jitter. **Still to verify:** knockback and spin-out during a full match with the AI opponent driving, and behaviour mid-disassembly (overlaps T-5.7).

### 3.3 First AI opponent (scripted)
- [x] **T-3.12** Build 2–3 pre-built opponent blueprints in `data/bots/` (a wedge, a spinner, a brick).
  - `player-slice` (98 kg), `opp-wedge` (89 kg), `opp-brick` (168 kg) — all validated in-band. `AiDriver.ts` itself is still to write.
- [x] **T-3.13** Write `scripts/AiDriver.ts`: a scripted opponent that seeks the player, aligns its weapon, and attacks. Baseline — the Utility AI in week 5 replaces the decision layer, not the actuation layer.
  - **Result:** `game/scripts/AiDriver.ts`, on a brain child entity. Decision layer only — writes `intent` into the chassis `Script.params`, `BotDrive` actuates, so drive tuning is not duplicated and week 5 replaces `decide()` alone. Priority: knocked-out → self-right → avoid-pit → back-off → break-off → disengage → align → close → attack. **Measured:** closed 5.44 m → 0.88 m in ~1 s, then cycled `attack → break-off → back-off → align → close → attack`; damage exchanged both ways (102.4 vs 94.1).
- [x] **T-3.14** Set up the nav layer if pathing is needed (`nav_setGrid` / `nav_findPath`) or confirm direct steering is sufficient in a bare arena. Decide; don't leave both half-built.
  - **Decided: no nav grid.** Direct steering only — a bare 12 x 12 m box with one moving obstacle gives A* nothing a heading error cannot express, and half-building both paths is what this task warns against. Corner pits are handled by a repulsion term. Revisit if T-5.12 hazards add real geometry to route around.
- [x] **T-3.15** Build the `DemoCenter` scene: opponent select, restart, control tips.
  - `game/scripts/DemoCenterController.ts` + the `DemoCenter` scene (21 authored entities, 41 live). Same room as `Arena01` but with MatchDirector in `practice` mode — no clock, no verdict. Adds a **Spar against** list (click a bot -> write `/data/bots/__opponent.json` -> reload) and six lines of control hints. The opponent spawner is `BotSpawn:__opponent:opponent`, so this reuses the same `__`-prefixed runtime-state pattern Bot Select uses and needed no assembler change.
- [x] **T-3.16** **Slice gate:** full Create → Test → Destroy loop playable with one weapon, one arena, one AI opponent. This is the proposal's week 2–3 validation milestone. **(V)**
  - **GATE PASSED 2026-08-20.** One unbroken run, no editor after the first load: `BotSelect` -> Blue Ruin -> **PRACTICE** -> `DemoCenter`, sparred Anvil -> **Change Bot** -> `BotSelect` -> Ravager -> **FIGHT** -> `Arena01` -> 3 s countdown -> full 120 s match -> *"time expired on damage 149 vs 145"*, HUD **MATCH OVER / YOU LOSE**. Evidence: `scene.validate` clean on cold boots of both fighting scenes (`Arena01` 39 live entities, `DemoCenter` 41), `profiler_getErrors` empty across the run, assembler determinism from T-2.11. The proposal's week 2–3 validation milestone is met — weeks 4–6 breadth now builds on a loop that demonstrably runs. Gaps the gate does not rest on: `MainMenu`/`PostMatch` stubs, the richer breakdown screen (T-6.4), and T-1.15's explicit joint-restore assertion.

---

## 4. Week 4 — Build System Expansion

> **RESCOPED 2026-08-19.** With no player-facing builder, this section narrows to *content and balance for
> prebuilt bots*. Weapon variety (§4.1) matters **more**, not less — it is now the main axis of difference
> between bots. Player customisation (§4.3) is deferred.

### 4.1 Weapon variety
- [x] **T-4.1** Vertical spinner / drum: prefab, joint config, damage profile, spin-up curve.
  - `wp-drum-v` — the same actuator as the bar spinner with its axis turned on its side, so it lifts rather than throws. Shorter, fatter, lower inertia: **1 100 rpm in 1.8 s** against the bar's 1 400 in 2.4. Spins up faster, hits more often, hits less hard (`drumVertical` factor 0.9 against the bar's 1.0).
- [x] **T-4.2** Hammer / axe: revolute joint + position motor, swing arc, cooldown, damage profile.
  - `wp-hammer-a` — a **position** motor, not a velocity one: a swing weapon is defined by where it starts and where it stops, so asking for an angle lets the solver do the acceleration. Arc −1.20 → 0.90 rad, 0.16 s strike, 1.1 s cooldown. Highest factor in the damage table (1.3) but live for only 0.16 s of each cycle — burst damage set against a spinner's sustained damage.
- [x] **T-4.3** Flipper: prismatic or revolute actuator, impulse launch, cooldown, self-flip risk.
  - `wp-flipper-p` — the same swing actuator, differing **entirely in data**: a wider, faster, far stronger arc (−0.05 → 1.35 rad, 0.09 s, 5 200 N) at the lowest damage factor in the table (0.3). It wins by putting the other bot on its back or in a pit rather than by grinding it down, which is exactly what T-5.12's pit rule now pays out. Self-flip risk is real and deliberate — the same impulse goes both ways — and the recovery stroke runs at 35 % force so a flipper cannot launch itself off its own return.
- [x] **T-4.4** Wedge / passive weapon: no actuator, wins on geometry — proves armor shape matters.
  - `wp-wedge-p`, shipped since week 2. It declares no `axis`, so the assembler welds it with a fixed joint and attaches **no controller at all** — there is nothing to actuate. It is also why Doorstop rams: a passive wedge reads as `weaponLost` to the utility AI (DESIGN §5).
- [x] **T-4.5** Unify all four behind a shared `WeaponController` interface so the AI and input layers treat them uniformly.
  - `stats.mode` picks the actuator — `spin` (velocity motor) or `swing` (position motor) — and **nothing else differs**. Same command path (`weapon.primary` for the human, `spinCommand` for the AI), same `battlebots.weaponState` report, same damage path.
  - The shared contract is `spinFraction`: 0..1 of "how live is this weapon right now". DamageSystem scales weapon damage by it and knows nothing about modes — for a spinner it is rpm over target, for a swing weapon it is 1 during the stroke and 0 otherwise. That is what makes an axe a burst weapon **without the damage model knowing what an axe is**, and it needed no change to the damage model at all.
  - **Bug found in testing:** swings originally fired on the press EDGE, which is wrong for the AI — UtilityAi holds `spinCommand` for as long as it wants the weapon live, so an axe swung once per engagement instead of once per cooldown. The cooldown was already the rate limit, making the edge check redundant for the human too. Measured after the fix: **axe 10 swings in its 10 s commanded window (1.1 s cooldown), flipper 9 across 14 s (1.6 s cooldown)** — both within a swing of nominal. **(V)**
  - Three new bots carry them so every type is reachable from Bot Select: **Havoc** (drum), **Gavel** (axe), **Tipster** (flipper). Roster 6 → 9, parts 14 → 17. Verified live: `mode spin, target 1100 rpm` and `mode swing, arc −1.20 → 0.90 rad`, `scene.validate` clean, 0 engine errors.
- [ ] **T-4.6** Per-weapon audio + VFX hooks (stubbed now, filled in weeks 5–6).

### 4.2 Armor & weight classes
- [x] **T-4.7** Add armor tiers (light / medium / heavy) with mass↔protection tradeoffs.
  - Shipped in the data model: `ar-light` 6 kg / 90 hp / 0.15 reduction, `ar-med` 12 kg / 140 hp / 0.30, `ar-heavy` 20 kg / 200 hp / 0.45 (`game/data/parts/`, reductions in `damage.json`).
- [x] **T-4.8** Define weight classes with mass caps; the Workshop blocks saving an over-cap bot.
  - Caps 60 / 110 / 180 kg in `game/data/weight-classes.json`; `validate.js` fails an over-cap blueprint at authoring time, and the Workshop refuses the save (verified at 204 kg).
- [x] **T-4.9** First balance pass: verify no single weapon dominates every matchup. Log matchup results in a table. **(V)**
  - Round-robin over the six weapon archetypes (bar spinner, drum, axe, flipper, passive wedge, no weapon) — 15 matchups, 60 s each, **AI on both sides**. The player bot has no brain of its own, so the harness attaches one exactly the way BotAssembler does for the opponent; a matchup where one side cannot move is not a balance reading.
  - **The headline holds: no weapon dominates every matchup.** The only lopsided result is the bar spinner against a passive wedge (282 vs 87), which is the intended rock-paper-scissors.

    | Matchup | damage dealt | ended |
    |---|---|---|
    | Ravager (bar) v Havoc (drum) | 97 – 96 | — |
    | Ravager (bar) v Tipster (flipper) | 206 – 199 | immobilised |
    | Ravager (bar) v Doorstop (wedge) | **282 – 87** | chassis destroyed |
    | Gavel (axe) v Tipster (flipper) | 120 – 116 | — |
    | Tipster (flipper) v Doorstop (wedge) | 280 – 277 | chassis destroyed |
    | Tipster (flipper) v Anvil (none) | 156 – 162 | — |
    | Doorstop (wedge) v Anvil (none) | 94 – 103 | — |

  - **A real bug fell out of it, and it was mine.** The first run ended **8 of 15 matchups in a pit**, one after 4.6 s, which made every damage reading meaningless. Cause: T-5.12 made the pit lethal, but the AI's pit veto was geometrically incapable of firing in time. `hazardRadiusM` was 2.4 and the veto tripped at `hazardNear > 0.55`, i.e. **1.08 m from a pit centre** — while the nearest corner of the pit *mouth* is already **1.41 m** out from that centre. The bot was over the hole before it could react. Raising the radius to 4.0 and moving the threshold into data as `pitVetoAt: 0.35` makes it fire at 2.6 m, about 1.2 m of margin, which is roughly the braking distance at cruising speed. **Pit endings fell to 6 of 15** and the damage numbers became usable. **(V)**
  - **Two findings carried into T-7.4**, not silently fixed here:
    1. Most pairings come out nearly symmetric (97–96, 206–199, 280–277). That says mutual ram and contact damage is swamping weapon differentiation — the weapons are distinct in *feel* and in how they win, but not yet in how much damage they account for.
    2. Anything involving **Anvil** (no weapon, heavy, defensive) produces very little damage on either side (5–6, 9–2). A bot with nothing to attack with also gives the AI very little reason to close, so those matches stall. Anvil may need a reason to engage, or the defensive weights may need a floor.
  - The remaining 6 pit endings are **not all failures**: `push-to-hazard` is a designed, scored AI action, so shoving someone into a corner is a win condition working as intended. Separating deliberate shoves from self-inflicted falls needs the telemetry from real playtests (T-7.1, T-7.5).
- [x] **T-4.10** Add motor/drivetrain parts as a real tradeoff (speed vs. torque vs. mass).
  - The three motor PartDefs have existed since week 2 and their stats were **completely inert**: `driveForceMultiplier`, `turnTorqueMultiplier` and `maxSpeedMultiplier` were authored, validated by `validate.js`, and read by nothing. Fitting a Sprint drive or a Grinder drive changed only the bot's mass.
  - BotAssembler now resolves the fitted motor at assembly time and writes those three numbers into BotDrive's params; BotDrive scales its drive impulse, its yaw torque and its speed cap by them. Resolved at assembly rather than looked up inside BotDrive because the assembler is the only thing that knows the blueprint, and it keeps BotDrive a pure actuator with a single tuning source. A bot with no motor fitted falls back to 1.0 rather than being undrivable.
  - The tradeoff is now real: Sprint **1.25 force / 0.85 turn / 1.3 top speed** against Grinder **0.85 / 1.35 / 0.8**. It also gives the motor something to lose — T-5.4 made a damaged motor scale both tracks by 0.6 and a dead one stop the bot outright.

### 4.3 Customization visuals
- [>] **T-4.11** Build the paint system: base + secondary color per part via `material_setParams` or `MeshRenderer.color`.
  - **Deferred (2026-08-19)** — player customisation is out of scope. Authored per-bot `paint.primary` / `paint.secondary` already drives greybox colour in `BotAssembler`, which is enough to tell two bots apart on screen.
- [>] **T-4.12** Add decals/patterns using the texture tools (`texture_create`, `texture_paintStroke`, `texture_applyToEntity`) or a UV-atlas swap. Pick the cheaper path.
  - **Deferred (2026-08-19)** with player customisation.
- [ ] **T-4.13** Add a wear/scratch overlay that intensifies with damage state.
- [ ] **T-4.14** Add bot naming + a saved bot roster with thumbnails (`assets_thumbnail` or `renderer_captureScreenshot`).
  - **Re-aimed (2026-08-19):** player naming is deferred, but thumbnails are now wanted for the **T-2.21 Bot Select** roster instead of for player-saved bots.
- [>] **T-4.15** Extend `BotBlueprint` to persist paint/decal choices; verify round-trip. **(V)**
  - **Deferred (2026-08-19).** Authored `paint` is already in the `BotBlueprint` schema and survives save/load; only player-chosen paint is out.

### 4.4 Art pipeline (runs in parallel from week 2)
- [ ] **T-4.16** Model the chassis variants in Blender; export glTF; import via `assets_import`.
- [ ] **T-4.17** Model wheels, all four weapon types, and armor plates.
- [ ] **T-4.18** Model workshop props and arena set dressing.
- [ ] **T-4.19** Texture the parts (Substance Painter or Blender texture paint) with a paint-maskable channel so recoloring works.
- [ ] **T-4.20** Author collision proxies: convex hulls or `Collider.extraShapes` decomposition (`mesh_decomposeCollision`) — never trimesh colliders on dynamic bodies.
- [ ] **T-4.21** Generate LODs for the heaviest meshes (`mesh_generateLOD`) if T-1.17 showed a budget problem.
- [ ] **T-4.22** Establish the naming convention for meshes/materials/prefabs and document it.

---

## 5. Week 5 — Destruction & AI Pass

### 5.1 Breakable-joint detachment
- [x] **T-5.1** Set `breakForce` per attachment joint, scaled by part category and armor tier. Weak mounts break early; chassis-critical mounts hold.
  - Authored per socket by category in `game/data/parts/*.json` — armour 2 500 N, wheel 4 000, motor 9 000, weapon head 12 000 — and cached per part by DamageSystem at registration. The armour-tier dimension is carried by `armorReduction` on incoming damage rather than by the mount, so a heavy plate resists damage but is not harder to shear off; that reads better than making the toughest part also the hardest to remove. **Only became functional today** — see T-5.2 and BUG-013.
- [~] **T-5.2** Subscribe to `physics.jointBroken` and drive the detachment sequence: mark the part detached, sever its logical link to the bot, spawn VFX, play audio.
  - **Not implementable as written — BUG-013.** `physics.jointBroken` never fires and `Joint.breakForce` is never evaluated, verified in isolation (two 5 kg boxes, `breakForce: 100`, 50 000 N·s impulse, separation unchanged). The *detachment sequence* is done and working: DamageSystem shears a part whose contact force exceeds its cached mount strength, drops the `Joint`, marks it debris and emits `battlebots.partDetached` with a `reason` of `sheared` or `damage`. Verified live — `[Damage] player/armor_front (ar-heavy) -> destroyed [sheared]`, the AI's wedge exceeding a 2 500 N mount with no attrition first. **Still open:** the real subscription once the engine breaks joints (this workaround catches impact shears but not slow levering), and the VFX/sound legs, which are T-5.11 and the week-6 audio pass.
- [x] **T-5.3** Handle the detached body's lifetime: it stays dynamic and interactive, becomes arena debris, and is culled after N seconds or M debris pieces to protect the frame budget.
  - A detached part stays dynamic and interactive, then is culled after `debrisLifetimeSeconds` (12 s) or early if more than `DEBRIS_CAP` (8) pieces are down, oldest first. Verified by entity count: a cold-boot Arena01 is 39 live entities, and after a shear plus its cull it settles at 38. Culling a detached weapon deletes an entity still carrying its `WeaponController`, which is only safe because BUG-011 was fixed.
- [x] **T-5.4** Make detachment mechanically meaningful: lost wheel → lost drive on that side; lost weapon → no attack; lost armor → exposed hitbox.
  - All four legs of the degradation table now bite. **Wheel** and **weapon** were already wired (per-side authority; `ceilingRpm` plus the AI's `weaponLost`); **armour** and **motor** were not, and the wheel leg had a hole.
  - **Armour is directional.** The chassis has no tier of its own, so plates protected it not at all — losing one changed nothing. `armorReductionFor` now takes the contact point into chassis-local space and matches it against the chassis' own armour socket offsets, so what protects the chassis is the plate on the face that was actually struck. Derived from the socket table rather than a hardcoded front/rear/left/right map, so a new chassis needs no code. A `damaged` plate gives half its tier (`damagedArmorReductionMultiplier`); a destroyed one gives nothing.
  - **Motor.** `refreshDrive` ignored motors entirely, so "drive dead" was decorative. A motor now multiplies BOTH tracks — `damagedMotorOutputMultiplier` (0.6) when damaged, 0 when destroyed — and a bot with no live motor is `immobilised`, which is the other half of the knockout rule.
  - **Bug found and fixed:** drive authority was computed from *live wheel entities*, so when a sheared wheel's debris was culled (T-5.3) the denominator shrank and that track climbed back to full power a few seconds after being torn off. Wheels and motors are now a per-bot socket registry that is written once and never removed; `checkKnockout` counts off it too, which retires the `wheelsSeen` high-water hack.
  - **Measured** against the live script driven by a synthetic bot (ch-box-m, ar-med on `armor_front`, mt-balanced), 3 000 N contact, ram factor, 1/60 s steps: **(V)**

    | Case | Result |
    |---|---|
    | Front face, medium plate on | **0.28 hp/step** (reduction 0.30) |
    | Left flank, no plate fitted there | **0.40 hp/step** — directionality, with the front plate still on |
    | Front plate at 3 000 N vs its 2 500 N mount | `destroyed`, `partDetached reason=sheared` |
    | Front face, plate gone | **0.40 hp/step** — exposure ratio **1.4286** = 1/0.7 exactly |
    | Front-left wheel sheared | `driveLeft` 1 → **0.5**, `driveRight` 1 |
    | …after that wheel's debris is culled | `driveLeft` **still 0.5** (was climbing back to 1) |
    | Motor `damaged` (step 21) | `driveLeft` **0.3** = 0.5 × 0.6, `driveRight` **0.6** |
    | Motor `destroyed` (step 42) | drive **0 / 0** + `knockout { reason: "immobilised" }` |
- [x] **T-5.5** Add progressive weakening — a `damaged` part's joint `breakForce` is reduced so accumulated hits eventually shear it off.
  - A part reaching `damaged` has its joint `breakForce` multiplied by `damagedBreakForceMultiplier` (0.5), so accumulated hits shear it off sooner.
- [x] **T-5.6** Curate the breakable set explicitly (proposal scope cut): wheels, weapon head, armor plates. **Not** every part, and **no** free-fracture.
  - Enforced by a `BREAKABLE` set in `DamageSystem.ts` (`wheel`, `weapon`, `armor`) rather than by "anything that is not the chassis", which had been letting motors detach. A destroyed motor now stays bolted in and simply stops working. No free-fracture: a part detaches whole or stays put.
- [x] **T-5.7** Verify a bot mid-disassembly stays physically stable — no NaN transforms, no exploding joints. Run `scene_validate` during play. **(V) (R)**
  - **Verified.** DemoCenter, Ravager vs Doorstop, player bot reduced to chassis + motor + 2 wheels (front plate sheared by the opponent on its own; the other front-left wheel, rear-right wheel and the spinner head dropped mid-simulation), then 20 s stepped at the fixed 60 Hz with `scene.validate` every 5 s over all 16 bot bodies.

    | Sample | validate | non-finite transforms | max speed | max spin |
    |---|---|---|---|---|
    | 5 s | ok, 0/0 | 0 | 0.38 m/s | 2.6 rad/s |
    | 10 s | ok, 0/0 | 0 | 0.22 m/s | 1.4 rad/s |
    | 15 s | ok, 0/0 | 0 | 0.56 m/s | 3.7 rad/s |
    | 20 s | ok, **1 warning** | 0 | 23.05 m/s | 2.3 rad/s |

  - No NaN, no Infinity, no exploding joint, no engine errors. The single warning is **not** an instability: it is the sheared front-left wheel, which rolled out past the arena wall (x −7.5, arena half-extent 5.6) and was in free fall at y −28.5 — hence the 23 m/s, which is gravity, not the solver. It is culled by the 12 s debris lifetime. Worth knowing that debris can leave the arena at all; a lip or a kill-plane belongs with the hazard work in T-5.12.
- [x] **T-5.8** Verify match reset restores all authored joints and part health cleanly (depends on T-1.15). **(V)**
  - **Reloading the scene *is* the reset.** Part health lives in DamageSystem's own Map and force-broken joints are runtime state, so a fresh `project.loadScene` restores both with no bespoke teardown — Rematch is one call. Exercised back to back: a practice round, an opponent swap (which also reloads), and a full timed match, with `scene.validate` clean on cold boots of both scenes and no errors. An explicit assertion that every authored joint is back stays with T-1.15.

### 5.2 VFX & hazards
- [x] **T-5.9** Sparks on metal-on-metal impact (`vfx_createEmitter`, `vfx_burst`), scaled by impact force.
- [x] **T-5.10** Smoke from `damaged` parts; fire/heavy smoke from destroyed motors.
- [x] **T-5.11** Detachment burst VFX + debris dust.
  - All three live in `game/scripts/VfxDirector.ts`, one marker entity per fighting scene. It is a **pure consumer** of the `battlebots.*` channels DamageSystem already emitted — it queries nothing and writes to no bot, so detaching it changes no gameplay. Five presets in `game/data/vfx.json` (`sparks`, `smoke`, `fire`, `detach`, `dust`), tuning included, so the look needs no recompile.
  - **`ParticleEmitter` is a component, so an entity carries at most one.** The presets are therefore swapped on a single entity rather than layered, ranked burst > sparks > smoke. The obvious alternative — spawning a short-lived entity at each `weaponHit.point` — was rejected as entity churn on the hot path at ~60 spawns per second of contact, the same cost T-5.3 caps debris to avoid. `worldSpace: true` throws particles off a spinning blade instead of letting them orbit with it.
  - `weaponHit` gained a `point` field for this (it already had the contact point after T-5.4).
  - **Measured** by driving the channels directly, since the director is a pure consumer: **(V)**

    | Event | Result |
    |---|---|
    | `weaponHit` 900 N | +3 particles (`sparkMinCount`) |
    | `weaponHit` 6 000 N | +22 particles (`sparkMaxCount`) — force-scaled |
    | `weaponHit` repeated immediately | no burst — `sparkCooldownSeconds` held it |
    | `partState` damaged | `smoke` preset on that part |
    | `partState` destroyed + motor | `fire` preset, 29 live particles |
    | `partDetached` | `detach` burst, then hands over to `dust` |
- [x] **T-5.12** Arena hazards: pit/kill zone, saw blades or floor spinners, pushout zone. Fold their damage rules into the damage model.
  - **The pit was decoration.** Arena01's four corners are real holes — there is no floor at |x| > 4 and |z| > 4 — but nothing watched them, so a bot that drove into one fell forever and the match never ended. DamageSystem now knocks out any bot whose chassis drops below `pitKillY` (−0.9) with reason `pitted`, and deletes debris that falls past it instead of letting it free-fall (the T-5.7 run caught a wheel at −28 m). Verified: `KNOCKOUT player — pitted at y −1.07`, and MatchDirector declared `winner=opponent (pitted)` off the existing channel with no changes. **(V)**
  - **The pit IS the pushout zone.** The arena is walled on all four sides, so there is no ring-out edge; the corners are where you shove someone to remove them. `push-to-hazard` was already an AI action scored against `foeHazard`, so the AI has been trying to use this since T-5.16 against a rule that did not exist.
  - **Floor spinners** (`Hazard_SpinnerW` / `E`, ±2.6 m, flanking the centre lane rather than sitting in it). Damage is **folded into the damage model, not parallel to it**: any entity named `Hazard_*` registers under a reserved `$hazard` role, so the existing same-role contact filter lets it through to every bot and to no other hazard. It strikes with `weaponFactor.hazard` (1.2) and `strike` returns early if the victim is a hazard, so it can never be worn down. A hazard is a striker with a factor — about fifteen lines, no new subsystem.
  - Their rotation is **cosmetic on purpose**: the body is static and the collider is a disc, the bar's swept envelope. That is the T-3.11 lesson (a thin bar sweeping >0.2 m per fixed step tunnels, and the contacts that resolve are explosive) applied up front, and it means the hazard's contact behaviour does not depend on where the art is pointing.
  - **Measured**, bot set down on a spinner at rest height so no drop impact confounds it: **514 contacts over 2 s, median 526 N, peak 7 626 N** — the peak clears the 4 000 N wheel mount, so it **sheared a wheel off**, while the other three took 0.3–3.1 hp of attrition. Sitting on it costs you a wheel; crossing it costs you paint. **(V)**
- [x] **T-5.13** Post-processing pass (`renderer_setPostFx`) for impact punch — restrained, and off if it costs frames.
  - ACES + bloom (strength 0.35, threshold 0.85, so it catches sparks and not much else) + a soft vignette + FXAA. SSAO and grain are **off** — both cost more than they add in a top-down greybox arena.
  - **Measured free:** 16.685 ms frame time with it on and 16.685 ms with it off, at 69 entities. It stays on. **(V)**
  - Post-FX is **renderer state, not scene state** — nothing in the repo would carry it into a build if it were only set from the editor. It therefore lives in `data/vfx.json` under `postFx` and is applied by VfxDirector at scene start, which makes it both reproducible from the repo and tunable without a recompile.

### 5.3 Utility AI opponent
- [x] **T-5.14** Add match telemetry recording: log player decisions and outcomes during play (`events_setRecording`, `simulation_setRecording`, or a custom log via `project_writeFile`). Must ship *before* the playtests that generate the tuning data — start this in week 3 if possible. **(R)**
  - **Risk R5 is closed.** `game/scripts/MatchTelemetry.ts`, one marker per fighting scene, writes one JSON record per finished match to `/telemetry/<scene>-<stamp>.json`.
  - Custom log via `project.writeFile`, not `events_setRecording`: the engine's own recorders capture engine events, whereas the tuning questions are about *game* concepts — which action a personality chose, at what range, with what health, and whether it won. Those already existed as `battlebots.*` channels, so the recorder is another **pure consumer** and gameplay cannot tell whether it is attached.
  - **Decisions are recorded identically for both sides**, which is the property T-7.5 needs: the AI's decision is its `aiAction`, and the human's is the input it was holding (`throttle`/`turn`/`spin`). One schema, so a player trace and an AI trace are directly comparable.
  - Sampled at 2 Hz rather than logged per frame — every tuning question is distributional, and a 60 Hz log of a 120 s match is 7 200 rows per bot for no extra answer. One write at match end, never mid-match, so file IO never lands on the fixed step.
  - **Verified** on a full timed Arena01 match: `wrote /telemetry/Arena01-91533-356.json — 356 samples, 16 events, 91.53 s`, result `winner=player, chassis-destroyed`, damage 280.9 vs 260.0, parts lost 2/1. Six further AI-vs-AI matches recorded across the roster; the corpus is 5 finished records, 286 KB. **(V)**
  - `game/telemetry/` is **gitignored** — recorded matches are data, not source, and 286 KB of them accumulates fast. Export them out of the engine project before running the aggregator.
- [x] **T-5.15** Define the utility-AI **considerations**: distance to opponent, weapon alignment, own health, opponent health, weapon spin-up state, hazard proximity, arena position.
  - Twelve, all normalised 0..1: `proximity`, `alignment`, `ownHealth`, `foeHealth`, `weaponSpin`, `bladeDown`, `weaponLost`, `hazardNear`, `wallNear`, `foeHazard`, `stuck`, `engaged`. The last three were **not** in the original list and were forced by testing — see the three modelling bugs in DESIGN.md section 5.
- [x] **T-5.16** Define the **action set**: charge, circle-strafe, retreat, spin up, ram, fire weapon, self-right, push toward hazard.
  - Seven: attack, charge, circle-strafe, retreat, spin-up, ram, push-to-hazard. "Fire weapon" and "spin up" collapse into one for a spinner (the blade either turns or it does not), so each action declares a `spin` wish rather than there being a separate fire action; `self-right` is a **gate**, not a scored action.
- [x] **T-5.17** Implement the scoring core in `scripts/UtilityAi.ts`: each action's score = weighted sum of normalized considerations; pick the highest with hysteresis to prevent flip-flopping.
  - `game/scripts/UtilityAi.ts`. Score = bias + sum(weight * consideration), highest wins. Hysteresis is two mechanisms: `minDwellSeconds` (0.45) against sub-frame dithering, and `hysteresisBonus` (0.15) so an incumbent must be beaten clearly rather than narrowly. Knocked-out and flipped are gated rather than scored, and the pit is a veto (-2 to everything but retreat) — a weight file should not be able to price instant death as merely expensive.
- [x] **T-5.18** Externalize the weights into `data/ai/weights.json` so tuning needs no recompile.
  - `game/data/ai/weights.json` — considerations documented inline, a `tuning` block (ranges, thresholds, hysteresis, dwell) and three personality weight sets. Bundled by `build-bundle.js`; UtilityAi reads the file directly, so a weight change needs no recompile. Every constant that mattered during tuning ended up here, including `engagedProximity` and `attackDwellSeconds`.
- [x] **T-5.19** Build the aggregation script: recorded match stats → suggested weights. Plain statistics, **not** ML (per the adopted proposal decision).
  - `game/data/ai/aggregate.js` — `node game/data/ai/aggregate.js [--dir game/telemetry] [--write]`. Counting and averaging only: no model, no gradient, no training. Per personality, per action, it compares the share of samples spent in that action in matches that bot **won** against matches it **lost**:

    ```
    lift(action) = mean(share | won) − mean(share | lost)
    ```

    and suggests that lift, scaled and clamped, as a delta on the action's `bias` — `bias` specifically, because it is the one unconditional term, so a nudge there means exactly "do this more often" without silently re-shaping *when* the action fires.
  - **It never writes `weights.json`.** Output is a suggestion a human reads; `--write` puts it in `weights.suggested.json`, which the game does not load. A number from counting six matches has no business overwriting a number arrived at by watching the bot play.
  - **It refuses to speak too soon.** Below `MIN_MATCHES` (6) per personality, with at least one win and one loss, it prints "insufficient data" rather than a confident-looking table. That is the whole defence against this task's failure mode — laundering noise into authority by formatting it.
  - **Verified** on a synthetic corpus built to exercise the branches (real recorded matches live engine-side): aggressive over 6 matches (3W/3L) returned `ram` lift **+0.398**, `attack` **+0.136**, `circle-strafe` **−0.534`, each clamped to the ±0.25 per-pass limit; defensive with 1 match correctly declined. It also reports median range at commit against `tuning.engageRangeM`. **(V)**
- [x] **T-5.20** Author 2–3 AI personalities (aggressive / defensive / opportunist) as distinct weight sets.
  - **aggressive** (trades hard, ignores its own health), **defensive** (will not commit without a blade at speed, disengages when hurt), **opportunist** (circles and punishes a weakened target — its attack weights on `foeHealth` are negative). Assigned per blueprint via `aiPersonality` so a bot's temperament is data: Hornet opportunist, Grinder and Anvil defensive, the rest aggressive.
- [x] **T-5.21** Add an AI debug overlay showing live consideration values and the winning action — indispensable for tuning.
  - Live overlay of every consideration value and every action score with the winner marked, F3 to toggle. `params.debug` forces it on without a keypress, which is also how it is tested — canvases went 2 -> 3 -> 2 on toggle with `refreshOverlay` writing every frame for 60 frames and zero errors. Building it also found a real bug in `BotDrive.ensureBindings`: it gated the whole input map on `drive.forward` already existing, so **any action added later never bound at all**. It now binds per action.
- [x] **T-5.22** Verify the AI is beatable but not trivial, and that it never gets stuck against a wall or in a corner. **(V)**
  - **Verified.** 30 s per personality, Ravager vs Ravager, sampled every 0.75 s: aggressive 17 switches (attack 9 / ram 9 / retreat 6), defensive 16 (attack 8 / charge 6 / circle 7 / spin-up 3), opportunist 13 (circle 11 / attack 7 / ram 6). Three distinct temperaments, none monotone, none stuck, 0 errors. Three separate stuck states were found and fixed getting here — grinding forever, orbiting forever, ramming forever — each a modelling error rather than a tuning miss (DESIGN.md section 5). Beatability against a *human* is still unmeasured; that needs T-5.14 telemetry plus a playtest.
  - **Partially addressed early by the scripted baseline:** `break-off` after 2.5 s of attacking, plus a stuck detector gated on commanded throttle, keep it from grinding forever or sitting wedged. Still to do: the beatable-but-not-trivial judgement, which needs the utility AI and real playtests.
- [x] **T-5.23** Run the AI in a Worker via the scripting layer's isolation if its main-thread cost shows up in `profiler_getFrameStats`. **Measured; not needed.**
  - The task is conditional and the condition is not met. Timing 600 fixed frames of a live two-bot match (`stepFrames` is synchronous, so wall time around a fixed frame count is a direct read on main-thread cost):

    | Configuration | ms / frame |
    |---|---|
    | Everything on | 0.394, 0.245 on repeat |
    | Utility AI disabled | 0.248 |
    | VFX + telemetry disabled | 0.279 |

  - The whole simulation costs **0.25–0.39 ms against a 16.67 ms budget** (~2 %), and the AI's share is **~0.15 ms — inside run-to-run noise**. Moving it to a Worker would add serialization and a frame of latency to buy back a fraction of a percent. Revisit only if local multiplayer with two AI bots plus debris changes the picture (T-6.10).

---

## 6. Week 6 — Feature Complete

### 6.1 Loop integration
- [x] **T-6.1** Main menu: Create / Test / Destroy / Options / Quit.
  - `game/scripts/MainMenuController.ts` in the `MainMenu` scene, which was a stub until now.
  - The proposal's five entries were written when Create meant a part-fitting Workshop. That was cut (DESIGN §0), so **Create now means *choose***, and all three play entries funnel through Bot Select rather than three separate paths: CREATE → browse, TEST → carries intent `practice`, DESTROY → carries intent `fight`. Intent rides `/data/session.json`, the same file hand-off the blueprint uses, so Bot Select needs no knowledge of the menu.
  - OPTIONS is an in-place panel rather than a scene — it is a controls reference until there is an audio bus to hang a slider on (T-6.13, T-6.20).
  - **QUIT tells the truth.** `window.close()` is refused for pages a script did not open, and this build is a web page, so the button says "close the tab to quit" rather than silently doing nothing. One line to change if it ever ships in a desktop wrapper.
  - The footer reads the W/L record out of `/data/history.json` (T-6.5) and names the currently selected bot.
- [x] **T-6.2** Scene flow and state handoff: menu → workshop → demo center / arena → post-match → workshop, carrying the blueprint through.
  - **The loop is closed.** `MainMenu` --CREATE/TEST/DESTROY--> `BotSelect` --PRACTICE--> `DemoCenter` / --FIGHT--> `Arena01` --> result panel --Results--> `PostMatch` --Rematch/Revise Bot/Main Menu--> back in. Bot Select also has a **Menu** button, so no screen is a dead end.
  - Key finding: **`project.loadScene` from inside a script hook is safe** — the ScriptSystem drops its instances on `world.reloaded` and the engine keeps stepping — so the deferred-request queue this was going to need was never built; buttons switch scenes directly.
  - **Every hand-off is a file**, never a scene reference: the blueprint rides `__selected.json`, the menu's intent rides `session.json`, the result rides `last-match.json`, and where Rematch should return to rides `return-to.json`. No scene knows any other scene exists, which is what made adding two screens additive rather than a rewire.
  - **Walked end to end** by driving the real buttons through `ui.click`: MainMenu → BotSelect → Arena01 → full 120 s match → persisted → PostMatch → MainMenu, with 0 engine errors. **(V)** Still open: moving input-map application into a real bootstrap (T-2.26).
- [x] **T-6.3** Match lifecycle: countdown, timer, knockout detection, time-expiry judgment on damage dealt (`game_start` / `game_pause` / `game_end` / `game_restart`).
  - `game/scripts/MatchDirector.ts` — `countdown -> fighting -> over`, one marker per fighting scene, `mode` param picks timed match (120 s + 3 s countdown) or untimed practice. Bots are held still through BotDrive's new `frozen` param, checked *before* the keyboard/intent branch so one flag stops human and AI identically; **weapons stay live during the countdown** on purpose. Ends on `battlebots.knockout`, or at time expiry on damage dealt — judged by emitting `battlebots.requestReport` and ranking DamageSystem's reply rather than keeping a second tally. Drives `game.start` / `game.end` behind a `game.status` probe, since those transitions are legality-checked.
- [x] **T-6.4** Post-match screen: winner, damage dealt/taken, parts lost, and a "revise your bot" button back into the Workshop.
  - `game/scripts/PostMatchController.ts` in the `PostMatch` scene, also a stub until now. Verdict, both bots' names, the reason it ended, duration; a scorecard of damage dealt / damage taken / parts lost / parts torn off the opponent; and a per-socket health table of the player's bot, colour-coded by state.
  - **It reads a file rather than asking.** Everything on this screen lives in DamageSystem's own Map, which is per-instance by design (T-5.8) — health resetting on scene load is exactly what makes Rematch one `loadScene` call. So a screen in a *different* scene has nothing left to ask, and MatchDirector writes `/data/last-match.json` at `finish()` while it still holds the report.
  - "Back into the Workshop" is **REVISE BOT → Bot Select**, since the Workshop was cut. Plus REMATCH (back to whichever scene was played, via `/data/return-to.json`) and MAIN MENU.
  - The in-scene result panel keeps Rematch and Change Bot for a fast turnaround, and gains a third **Results** button that opens this screen — the quick path and the detailed path both stay available.
- [x] **T-6.5** Persistence: bot roster and match history survive a reload.
  - MatchDirector's `persist()` writes two files at `finish()`: `/data/last-match.json` (the full breakdown PostMatch reads) and `/data/history.json` (an append-only log the menu reads). Both are project files, so they survive a reload the same way the blueprints do.
  - History is **capped at 50 entries**. It is read by a menu, not analysed — an unbounded log in browser storage is a slow leak, and T-5.14's telemetry is where the full record already lives for anyone who wants depth.
  - The **roster** survives because it is data: the nine blueprints are files under `data/bots/`, and the player's current choice persists in `__selected.json` (written by Bot Select since T-2.20).
  - **Bug found and fixed during verification:** `persist()` originally read the bot names from `/data/bots/__selected.json` and `__opponent.json`. That is wrong in Arena01, whose spawner names a blueprint directly (`BotSpawn:opp-wedge:opponent`) and never writes that file — the record showed whichever opponent the Demo Center had last written. It now reads the `BotSpawned:<id>:<role>` markers, which are the only thing that knows what was actually built, and resolves the display name from the bundle first (a roster blueprint like `opp-wedge` exists only inside the bundle, not as a file in the engine project). Verified: **"Gavel vs Doorstop"**, was **"Gavel vs Tipster"**. **(V)**

### 6.2 Local multiplayer
- [ ] **T-6.6** Two-player input: gamepad + gamepad, or gamepad + keyboard. Verify the input layer handles two simultaneous devices — **spike this early**; it's the one week-6 item that can surprise you. **(R)**
- [ ] **T-6.7** Split-screen vs. shared-camera decision. A shared camera framing both bots is cheaper and usually reads better in a small arena — prefer it unless testing says otherwise.
- [ ] **T-6.8** Two-player bot select from the saved roster.
- [ ] **T-6.9** Local-multiplayer match flow, scoring, and rematch.
- [ ] **T-6.10** Verify performance with two full player bots + destruction at target frame rate. **(V)**

### 6.3 UI/UX pass
- [x] **T-6.11** In-match HUD: per-bot part-health readout, match timer, weapon state (spin-up / cooldown / jammed).
  - `game/scripts/MatchHud.ts`, one marker per fighting scene. Two columns, player left and opponent right: overall condition as a percentage plus a bar, then **a row per socket** with its own bar, coloured by state, and the live weapon line underneath (`idle` / `spinup` / `ready` / `jammed` / `striking`, with rpm where a weapon has any).
  - Another **pure consumer** of the `battlebots.*` channels — the whole HUD is driven by the `damageReport` and `weaponState` traffic that already existed for the debug path. It touches physics only to place the directional indicator.
  - **The match timer is deliberately NOT here.** MatchDirector already owns the top strip and its countdown; two clocks that can disagree is worse than one, so the HUD reuses it rather than drawing a second.
  - Pulled at **5 Hz, not per frame** — it is a full part table and nothing on it changes faster than a person reads. **(V)** Verified live: 16 socket rows across both bots, condition percentages tracking real damage, 60 fps at 94 entities.
- [x] **T-6.12** Damage feedback: hit flashes, directional damage indicator, part-lost callout.
  - Three signals, each tied to something the player has to react to. **Hit flash:** the struck part's row flashes white, so damage has a *location* rather than just a number. **Direction:** four edge marks, and the one facing the blow lights up — computed by taking the contact point into the chassis' own frame, the same trick directional armour uses (T-5.4). **Part-lost callout:** a large centred line, `LOST ARMOR FRONT` when it is yours and `TORE OFF …` when it is theirs.
  - Deliberately sparse: a screen-wide flash was the first build and it made the arena *harder* to read, not easier. Anything more competes with the fight for attention.
  - **(V)** Driven down the channels: callout read `LOST ARMOR FRONT`, and a hit placed on the nose lit the front edge.
- [x] **T-6.13** Pause menu, options (volume, sensitivity), and rebindable controls.
  - Esc toggles a pause overlay listing the controls, with Resume and Main Menu. It freezes both bots through BotDrive's **existing `frozen` param** — the same flag MatchDirector's countdown uses, so pause and countdown cannot fight each other, and weapons spin down naturally exactly as they already do during a countdown. **(V)** Verified: `frozen` false → true on Esc, overlay visible, true → false on the second press.
  - **Partial, and honestly so:** volume has nothing to attach to until the audio bus exists (T-6.16 – T-6.20), and **rebindable controls are not done** — bindings live in `data/input-map.json` and are applied at runtime, so rebinding needs a persistence path and a capture UI. Both are listed against T-6.20 and T-8.1 respectively rather than being quietly claimed here.
- [x] **T-6.14** Controls/tutorial panel in the Demo Center.
  - The controls half already existed. It is now a real primer: controls, then the four things that decide a match and are **not** discoverable by pressing buttons — the pits are lethal, the red floor discs can tear a wheel off, losing three wheels or the motor stops you, and a blade at rest only shoves. Kept to one screen; a panel nobody finishes reading teaches nothing.
- [ ] **T-6.15** UI consistency pass — one type scale, one color language, readable at the deployed resolution.

### 6.4 Audio
- [ ] **T-6.16** Source/create the audio set: motor loops, weapon spin, metal impacts, sparks, part detachment, crowd, announcer stings, UI clicks.
- [ ] **T-6.17** Load and attach clips (`audio_loadClip`, `audio_attachSource`, `audio_setListener`); set up 3D positioning.
- [ ] **T-6.18** Dynamic motor/weapon pitch driven by throttle and RPM.
- [ ] **T-6.19** Adaptive combat audio: crowd intensity rises with damage; ambience shifts near a knockout.
- [ ] **T-6.20** Mix pass with per-bus volume control.
- [ ] **T-6.21** **Feature-complete gate:** full loop, four weapons, destruction, AI opponent, local multiplayer, UI, and audio all in one build. **(V)**

---

## 7. Week 7 — Polish & Playtesting

- [ ] **T-7.1** Run structured playtests (≥5 testers) with a written script and a feedback form.
- [ ] **T-7.2** Log every bug into a triaged list (blocker / major / minor / polish).
- [ ] **T-7.3** Fix all blockers and majors.
- [ ] **T-7.4** Balance pass on weapons, armor, and weight classes using playtest matchup data.
- [ ] **T-7.5** Re-tune AI weights with the freshly recorded telemetry — the "shaped by real players" claim rests on this, so do it with real data, not by hand.
- [x] **T-7.6** Performance optimization: profile with `profiler_getFrameStats`, cut draw calls, cap debris, tune shadows (`renderer_setShadowConfig`).
  - **Profiled, and there is nothing to optimize yet.** A complete 130 s Arena01 match with everything on — two bots, four-weapon actuation, destruction, VFX, HUD, telemetry, hazards, post-FX, 94 entities — costs **0.298–0.400 ms per frame (median 0.362)** against a 16.67 ms budget. That is ~2 % of frame, and 60 fps was held throughout.
  - Measured by timing `stepFrames` over ten 780-frame runs, which is a direct read on main-thread cost; the reported `frameTimeMs` of 16.68 is just the vsync cap and says nothing about headroom.
  - Debris is already capped (T-5.3: 8 pieces or 12 s, plus instant deletion below the pit since T-5.12). Shadows are `pcfsoft` at 1024 — left alone, because cutting them would buy frames that are not needed and cost the only depth cue a greybox arena has.
  - **Cutting draw calls is deferred on purpose**, not skipped: the scene is greybox primitives, so the draw-call count is a property of art that does not exist yet (T-4.16 – T-4.18). Optimizing it now would be optimizing a placeholder. Re-profile when meshes land.
- [x] **T-7.7** Check `profiler_getErrors` / `profiler_getLogs` for a clean console across a full match.
  - **0 errors** across a full 130 s match, and `scene.validate` clean (0 errors, 0 warnings) at the end. **(V)**
  - **1 warning**, and it is not ours: `THREE.WebGLProgram` reporting X3595/X4000 from compiling the **FXAA** post-FX shader on the D3D backend. It is a shader-compiler diagnostic from three.js, fires once at program build, and is the direct cost of enabling FXAA in T-5.13. Recorded rather than suppressed so it is not rediscovered in week 8.
- [ ] **T-7.8** Difficulty tuning: an easy/normal/hard mapping over the AI weight sets.
- [ ] **T-7.9** Game-feel polish: camera shake on big hits, hit pause, slow-mo on knockout.
- [ ] **T-7.10** Fix the top-5 "feels bad" items testers named, whether or not they're bugs.

---

## 8. Week 8 — Final Polish & Presentation

- [ ] **T-8.1** Final QA pass against a written test matrix (every scene, every weapon, both multiplayer paths, save/load, reset).
- [ ] **T-8.2** Produce the deployable build: `build_export` / `build_bundle` via the engine-deployer "Deploy as WebGL" path; verify it runs from `:4173` in a clean browser profile. **(V)**
- [ ] **T-8.3** Check the build report (`build_getReport`) for size and asset warnings; trim if load time is bad.
- [ ] **T-8.4** Capture marketing screenshots (`renderer_captureScreenshot`, `viewport_captureViews`).
- [ ] **T-8.5** Cut the trailer (build → best match footage → 45–60s).
- [ ] **T-8.6** Build the store/presentation page: description, screenshots, trailer, playable link.
- [ ] **T-8.7** Write the final README: what it is, how to play, controls, what's implemented, known issues.
- [ ] **T-8.8** Write the postmortem: what the AI feedback in §4 changed, what the scope cuts bought, what the engine choice cost and saved.
- [ ] **T-8.9** Build the presentation deck and rehearse; record a fallback video in case the live demo fails.
- [ ] **T-8.10** Final commit + tag `v1.0`; confirm LFS objects pushed.

---

## 9. Stretch Goals (only if on/ahead of schedule by week 5)

- [ ] **T-9.0** **Re-promote the Workshop** to a shipped feature: the player-facing build system (T-2.12 – T-2.18) is already implemented and verified, so this is a polish-and-wire-up job (ghost preview T-2.14, 3D socket picking, paint T-4.11) rather than new construction. Take this only once the damage system, AI and match flow are done.
- [ ] **T-9.1** Extra utility considerations: react to the opponent's specific weapon type.
- [ ] **T-9.2** Aggression that adapts to remaining health.
- [ ] **T-9.3** Opponent-behavior modeling — the AI picks up on a specific player's habits across matches.
- [ ] **T-9.4** A second arena with different hazards.
- [ ] **T-9.5** A short single-player tournament ladder.
- [ ] **T-9.6** Deeper customization (decal editor, more paint options).

**Explicitly out of scope:** online multiplayer, ML-trained opponent AI, general free-fracture destruction, freeform (non-socket) building. All four were cut deliberately in §4 of the proposal — don't let them creep back in.

---

## 10. Risk Register

| # | Risk | Impact | Mitigation | Tasks |
|---|------|--------|-----------|-------|
| R1 | Physics budget can't carry 2 bots + debris | Guts the destruction pitch | Measure in week 1, before content; cap debris; curated breakable set | T-1.17, T-5.3, T-5.6, T-6.10 |
| R2 | Destruction physics unstable (jitter, explosions, NaN) | Match-breaking | `breakForce` is already native; validate during play; CCD; conservative masses | T-1.13, T-1.15, T-5.7 |
| R3 | Match reset doesn't cleanly restore broken joints | Can't play twice | Verify reload semantics in week 1, not week 5 | T-1.15, T-5.8 |
| R4 | Two-device local input unproven | Cuts a core pitch feature | Spike the input layer in week 2, not week 6 | T-6.6 |
| R5 | No telemetry recorded before week 5 | AI tuning has no data; the "real player data" claim fails | Land recording by week 3 | T-5.14 |
| R6 | Art volume for 4 weapons + parts + 2 scenes, solo | Week 4 slips | Ship greybox-playable; art is a parallel track, never a blocker | T-4.16–T-4.22 |
| ~~R7~~ | ~~Build system scope creeps toward freeform~~ | — | **Retired 2026-08-19:** the player-facing build system is cut entirely (`DESIGN.md` §0), so there is no longer a builder whose scope can creep. The socket model it would have crept from is now internal-only. | T-2.3, T-2.4 |
| R8 | Docker rebuild loop slows iteration (no in-container HMR) | Death by a thousand rebuilds | Do gameplay work through scripting + `script_hotReload`; rebuild images only for engine-package changes | T-0.1, T-0.2 |

---

## 11. Standing Conventions

- **Engine edits vs. game code.** Game logic lives in project scripts (`script_create` / `script_edit` / `script_hotReload`) — hot-reloadable, no Docker rebuild. Touch `packages/engine-core` **only** if a genuine engine gap blocks the game, and log it as engine work, not game work.
- **Every scene change is a transaction.** Wrap multi-step authoring in `undo_beginTransaction` / `undo_commit`.
- **Validate before committing a scene.** `scene_validate` must come back clean.
- **Fast rotation needs a swept collider.** At the 60 Hz fixed step, a rotating part whose tip travels more than ~0.2 m per step will tunnel, and the contacts that do resolve are explosive. Collide the swept envelope and scale damage by actual rpm — see `docs/DESIGN.md` §5. This applies to every weapon added in week 4, not just the spinner.
- **Data over code.** Parts, bots, AI weights, and damage constants live in JSON under `data/` so tuning never needs a recompile.
- **Commit messages carry task IDs.** `T-5.2: drive detachment from physics.jointBroken`.
- **Every (V) task gets a recorded result** — a number, a screenshot, or a log line. "It seemed fine" is not a validation.
