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
- [x] **T-0.2** Verify all three services healthy (`docker compose ps`) and the editor loads in the browser. **(V)**
  - ~~Editor loads and is fully usable on :4174, but `docker ps` reports `engine-runtime` and `engine-editor` as **unhealthy**.~~
  - **Re-checked 2026-08-24 during the build work: all three report `healthy`.** `engine-runtime`, `engine-editor` and `engine-deployer` are all up and passing. Nothing in this project changed them, so either the healthchecks were fixed upstream or they were failing on a transient that has since settled. Recorded rather than silently closed, because "it fixed itself" is worth knowing if it comes back (BB-005).
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

- [x] **T-2.24** Migrate `BotAssembler.ts` and `WorkshopController.ts` off the old workarounds: use `ctx.call` instead of `engine.mcp.toolMap` (which was private and skipped zod defaults — the cause of the hidden-canvas bug), and `Script.params` instead of encoding arguments into `Name`. `BotDrive.ts` and `DamageSystem.ts` already use both.
  - **Both halves done.** No script reaches into `engine.mcp.toolMap` any more — the only remaining mentions are the comments explaining why not. `assemble()` takes `call` as its first argument; `WorkshopController`'s `H("tool")({args})` shape survives unchanged as a thin adapter over `ctx.call`, so 27 call sites migrated by changing one line.
  - **Why it mattered beyond tidiness:** raw handlers skip zod, and skipping zod skips the schema DEFAULTS. That is what produced the hidden-canvas bug — an omitted field stayed `undefined` instead of taking the default the schema promised. Every call now goes through the schema.
  - Arguments moved from the entity Name into `Script.params`: the two arena spawners in `Arena01` and `DemoCenter` carry `{ blueprintId, role }`, and both dynamic creators (`BotSelectController`, `WorkshopController`) pass params to `script.attach`. The Name keeps exactly one job — the **spent flag** (`BotSpawn:` → `BotSpawned:`) that makes assembly idempotent. State in the name is fine; arguments in the name were the problem.
  - Name-encoded markers are still accepted, so a scene authored before this change still loads. That fallback is the only thing keeping `BotSpawn:<id>:<role>` meaningful and can go once no scene uses it.
  - **(V)** Verified live across all three marker creators: `Arena01` and `DemoCenter` spawners assemble from params (`BotSpawned:__selected:player` with `params { blueprintId: "__selected", role: "player" }`), `BotSelect` builds its turntable preview, and the Workshop assembles its draft — 0 errors.
  - Found and fixed on the way: the report object still returned a `visual` field that the chassis-rendering fix (BB-010) had deleted, which threw `visual is not defined` and failed every assembly.
- [~] **T-2.25** Delete `WorkshopController`'s 3-frame disable/re-enable rebuild machine — BUG-011 is fixed, so a Script-bearing entity can be deleted from inside a hook directly.
  - **Reduced to 2 frames, not deleted — and the reason is the point.** BUG-011 is fixed *in the editor*. The deployed runtime still has the unguarded read: its script loop does `A.getComponent(g, Script)` and dereferences `.enabled` with no null check, so deleting a Script-bearing entity from inside a hook still takes the whole frame loop down there (LIM-009 again — the player is an older engine).
  - **This is not just a Workshop concern.** `DamageSystem` culls debris from `onFixedUpdate`, and a sheared-off weapon *is* debris carrying `WeaponController`. Any deployed match that ran long enough for a weapon to come off and then expire would have frozen. `tools/shim-build.js` now backports the guard, which is the most consequential patch in that file.
  - So the marker still lives, and only the re-enable waits a frame — the teardown and disable happen immediately, since they are ordinary calls with no ordering hazard. One state instead of three, one frame of latency instead of two.
  - Left open rather than closed: a rebuild that depends on a shim patch to not freeze the game is a worse design than one that never deletes the entity. Delete-and-recreate becomes correct the day the runtime carries BUG-011's fix natively.
- [x] **T-2.26** Move input-map application out of `BotDrive.onStart` into a scene bootstrap. `input.mapAction` bindings are runtime-only and are not serialized, so *something* must re-apply them after every scene load; a bot is the wrong owner. Fold into T-6.2.
  - Moved into `MatchDirector`, which is the scene bootstrap T-6.2 already built: one per gameplay scene, starts before anything is driveable, and already owns the rest of scene setup.
  - **A bot was the wrong owner in a way that had already bitten.** Bindings are one global registry, and the first bot to start would set the guard flag — so in a versus match whichever bot started second found the work "done" and never got its keys. Binding is still per-action rather than all-or-nothing, which is the other half of the same bug: gating the whole map on one action already existing meant any action added later never bound at all in a session that had applied the old set, and that is how the F3 AI overlay silently went missing.
  - `BotDrive` is now purely an actuator: it reads actions, it does not create them.
- [x] **T-2.27** Re-check point-light intensity now that blank captures are impossible: three.js 0.171 makes `point` intensity candela with inverse-square falloff, so the component default of 1 is effectively invisible at metre scale (`engine-fixes.md` LIM-003). Our scenes use directional + ambient only, so this is a look-pass item, not a bug.
  - **Re-checked, and the premise holds: there are no point lights in this game.** All six scenes audited — every light is `directional` or `ambient`:

    | Scene | Lights |
    |---|---|
    | Arena01 / DemoCenter | directional 2.6 + ambient 0.95 |
    | BotSelect / Workshop | directional 2.2 + ambient 0.85 |
    | MainMenu / PostMatch | directional 1.2 |

  - Nothing to fix. The candela trap is real and stays documented in LIM-003 for whoever adds the first point light — at metre scale the component default of 1 is effectively black, which reads as a broken light rather than a dim one.
  - Noted while auditing: `MainMenu` and `PostMatch` have no ambient fill. They are UI screens with almost no 3D so it does not show, but it is an inconsistency for the type/colour pass (T-6.15).

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
- [x] **T-4.6** Per-weapon audio + VFX hooks (stubbed now, filled in weeks 5–6).
  - **Filled in as the task anticipated**, and closed here because the hooks demonstrably exist — this was still ticking over as open long after the work landed.
  - `WeaponController` emits `weaponState` (rpm, spin fraction, jammed), `weaponSwing` and, via `DamageSystem`, `weaponHit` with contact force. `VfxDirector` consumes them for force-scaled sparks; `AudioDirector` consumes them for the blade loop pitched by real rpm, impact and spark one-shots, and a jam clank.
  - The hooks are per-weapon without either director knowing what a weapon *is*: everything is keyed off the archetype-agnostic `weaponState` contract, so a passive wedge (rpm 0 forever) correctly produces no blade voice and no spin VFX.
  - **Caveat:** the audio half is wired and inert until the engine can play a sound at all (BB-011 / LIM-006). The hooks are done; the output is not.

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
- [x] **T-4.13** Add a wear/scratch overlay that intensifies with damage state.
  - **Carried by colour, because the art descope (§4.4) removed the things this task assumed.** There is no texture to overlay and no paint-maskable channel to drive, so every part now darkens and desaturates *continuously* as its hp falls — from its own paint toward scorched metal (`#4a4038`), up to 72 % of the way at zero.
  - That is a better fit than a texture would have been, and not only because it is what is available. The two discrete steps from T-3.5 tell you a part crossed a threshold; they cannot tell you a part is at 60 %. A continuous tint reads as "this one is getting chewed up" *while it happens*, which is what a player is actually trying to read off a bot mid-fight.
  - The stepped colours still win at their thresholds — `damaged` and `destroyed` have mechanical meaning (a weaker mount, a dropped joint) and should look like states, not like slightly more wear. So wear only applies while a part is `intact`.
  - Quantised to 6 steps so a blade grinding along a plate does not issue a `setComponent` per contact; the visible result is identical and the call count is bounded.
  - **Measured** on the Ravager's chassis paint: `#6f2f8f` → `#6b3185` (80 % hp) → `#623570` (50 %) → `#59395b` (20 %) → `#543b50` (0 %).
- [~] **T-4.14** Add bot naming + a saved bot roster with thumbnails (`assets_thumbnail` or `renderer_captureScreenshot`).
  - **Naming and the roster are done; thumbnails are not.** 9 named blueprints in `game/data/bots/` with a live `BotSelect` roster that shows each bot's name, weight class, mass, weapon, armour total and estimated top speed, and previews the highlighted bot on a turntable.
  - The turntable preview is arguably the better answer than a thumbnail — it is the real bot, assembled from the same blueprint the match will use, rather than a picture that can go stale. But it is not what the task asks for, and a static thumbnail is what a roster *grid* would need, so this stays open rather than being quietly redefined.
  - Blocked in practice by the same thing as T-8.4: `renderer.captureScreenshot` refuses when the Game view has no active ECS camera, and returns an error rather than a blank PNG (BUG-012). Capturing a bot portrait needs a camera staged for it.
  - **Re-aimed (2026-08-19):** player naming is deferred, but thumbnails are now wanted for the **T-2.21 Bot Select** roster instead of for player-saved bots.
- [>] **T-4.15** Extend `BotBlueprint` to persist paint/decal choices; verify round-trip. **(V)**
  - **Deferred (2026-08-19).** Authored `paint` is already in the `BotBlueprint` schema and survives save/load; only player-chosen paint is out.

### 4.4 Art pipeline (runs in parallel from week 2)

> **Descoped 2026-08-24, by decision: the greybox IS the art direction.** Not a deferral and not a
> placeholder anyone intends to replace — untextured primitives are what ships. Recorded here so it
> is never re-litigated as "art still to do", and so the several tasks written *against* an art
> pipeline can be closed honestly rather than left hanging.
>
> This also **retires risk R6** (art volume sinks a solo week 4) by removing the thing that caused
> it, and it lets T-7.6 close: draw-call cutting was deferred there on the grounds that the geometry
> was a placeholder, and that premise no longer holds.
>
> What the decision costs: the wear/scratch overlay (T-4.13) and the paint-maskable channel (T-4.19)
> were the two places art was going to carry information, so damage state has to read entirely
> through colour swaps and VFX. It already does — T-3.5 swaps material colour at `damaged`, and
> `VfxDirector` puts smoke on a damaged part and fire on a dead motor.

- [>] **T-4.16** Model the chassis variants in Blender; export glTF; import via `assets_import`.
- [>] **T-4.17** Model wheels, all four weapon types, and armor plates.
- [>] **T-4.18** Model workshop props and arena set dressing.
- [>] **T-4.19** Texture the parts (Substance Painter or Blender texture paint) with a paint-maskable channel so recoloring works.
  - All four descoped together — they are one body of work and there is no half of it worth doing. The four weapon archetypes already read as distinct at a glance from silhouette alone (a horizontal bar, a vertical drum, a raised axe, a wedge), which was the only thing the modelling had to buy that gameplay depends on.

- [-] **T-4.20** Author collision proxies: convex hulls or `Collider.extraShapes` decomposition (`mesh_decomposeCollision`) — never trimesh colliders on dynamic bodies.
  - **Superseded by the descope, and satisfied by construction.** This task existed to stop imported art becoming trimesh colliders on dynamic bodies. With no imported meshes, every collider in the game is already an authored primitive — box, cylinder or sphere — which is the outcome it was protecting. Nothing to author.

- [-] **T-4.21** Generate LODs for the heaviest meshes (`mesh_generateLOD`) if T-1.17 showed a budget problem.
  - **Superseded — the condition it was gated on never fired.** It reads "if T-1.17 showed a budget problem"; T-1.17 did not, and T-7.6 since measured a full two-bot match with destruction, VFX, HUD and hazards at **0.298–0.400 ms/frame against 16.67 ms**. There are also no heavy meshes to generate LODs from.

- [x] **T-4.22** Establish the naming convention for meshes/materials/prefabs and document it.
  - Done by writing down what is already in force, rather than inventing a scheme for assets that will not exist. There are no meshes or named materials — greybox renders through `MeshRenderer.primitive` and a colour — so the convention that matters is over **part ids, scene entities and runtime entities**. Recorded in `README.md`:
  - **Part ids** `<category>-<variant>-<size|kind>`: `ch-` chassis, `wh-` wheel, `wp-` weapon, `ar-` armor, `mt-` motor. Size suffix `-l/-m/-h` (light/medium/heavy) for chassis, wheels and armor; kind suffix for weapons — `-h` horizontal bar, `-v` vertical drum, `-a` axe, `-p` passive.
  - **Scene entities** PascalCase for singletons (`MatchCamera`, `DamageSystem`, `AudioDirector`), `Group_Part` for arena geometry (`Floor_Center`, `Wall_North`, `Pit_NW`), and a `Visual` suffix for a render-only child of a physics body (`Hazard_SpinnerWVisual`).
  - **Runtime entities** built by `BotAssembler`: `Bot_<role>_Chassis` and `Bot_<role>_<socket>_<partId>`. Spawn markers carry their arguments in the name — `BotSpawn:<blueprint>:<role>`.
  - **Audio** clips register as `bb_<name>`; voices are `AudioVoice_<n>`, beds `AudioBed_<Name>`.

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
- [x] **T-6.6** Two-player input: gamepad + gamepad, or gamepad + keyboard.
  - **2026-08-25 — rebound and two bugs fixed.** Player 1 is WASD with **E** for the weapon; player 2 is the **numpad**: `8`/`5` drive, `4`/`6` turn, `9` weapon, `7` self-right. Bindings are by physical `code`, so the numpad works with NumLock off. The weapon is now a **toggle** rather than a hold — a spinner takes real seconds to reach speed, so holding a key all match achieved nothing and letting go to reposition meant paying the spin-up again. Verified: one press `spinup → ready@1163` and it stays; a second press `spindown`.
  - **BB-013** — both players' weapons fired off one key. `BotDrive` split the seats correctly via `playerIndex`, but `WeaponController` fell back to the unprefixed `weapon.primary` and `BotAssembler` never passed an action. Only visible in versus, because in single player the opponent's weapon is driven by the AI and never reads input. Fixed by resolving the action in the assembler, the only place that knows which seat a bot is.
  - **BB-014** — the input map could add a binding but never *change* one. `applyInputMap` skipped actions that already existed, and a deployed build bakes the editor's action table into its bundle, so the stale baked binding always won and `input-map.json` was decorative for anything already bound. The map is now applied in full on every scene load. Verify the input layer handles two simultaneous devices — **spike this early**; it's the one week-6 item that can surprise you. **(R)**
  - **Risk R4 resolved, and the surprise was real: the engine has no gamepad support at all.** `input.getState` exposes exactly `keysHeld`, `keysPressed`, `keysReleased`, `mouse` and `actions` — there is no gamepad channel — and `input.mapAction` binds `KeyboardEvent.code` strings only. The *browser* has the Gamepad API (`navigator.getGamepads()` returns its four slots), so nothing is missing at the platform level; the engine's input layer simply never reads it. Adding it is `packages/engine-core` work, which §11 says to avoid unless a genuine gap blocks the game.
  - **It does not block the game.** Both of the proposal's options needed a pad, so the shipped mode is **two players on one keyboard**: player 1 on WASD + Space, player 2 on the arrow cluster + Numpad0/RightShift. The two sets are disjoint by construction.
  - Player 2's actions are the same names behind a `p2.` prefix, and BotDrive picks its prefix from `params.playerIndex` — **one code path serves both humans**, so there is no second input path to keep in sync.
  - **Spiked before building on it, as the task asks. (V)** Seven keys held at once, both players' `drive.forward`, `turn.left` and `weapon.primary` all reading `true` simultaneously and independently, and the held set draining cleanly on release.
  - **Two bugs found wiring it up.** (1) `ensureBindings` bound only `inputMap.player1`, so whichever bot assembled second never got its keys — it now binds every map in the file, because bindings are a global registry. (2) Arrow keys were duplicate bindings on player 1 for the WASD-or-arrows convenience; left in place, every P2 input would also have driven P1. They now belong to player 2 alone.
- [x] **T-6.7** Split-screen vs. shared-camera decision. A shared camera framing both bots is cheaper and usually reads better in a small arena — prefer it unless testing says otherwise.
  - **Shared camera**, as predicted. `game/scripts/MatchCamera.ts` on the existing `MatchCamera` entity. Split screen would halve each view's resolution, double the draw work, and in a 12 x 12 m arena mostly show both players the same thing twice — and it has nothing to fall back on in single player.
  - **It only ever moves; it never re-aims.** The camera sits at `target + dir * distance` where `dir` is the *normalised authored offset*, so tracking and zoom change only the target and the distance. The view direction is therefore identically the pose framed by hand in the editor, and the authored rotation is never written. **(V)** Measured across six samples: separation 0.92 m → 17.08 m back, 6.99 m → 21.39 m, 15.79 m → 24.44 m, with the rotation reading `-0.3625, 0, 0, 0.9320` at every single sample.
  - Smoothing is frame-rate independent (`1 - (1-k)^(dt*60)`); a raw lerp would chase faster on a faster machine and feel different on someone else's laptop.
  - It ignores bots below `ignoreBelowY`. Without that, the first pit knockout drags the camera underground following a body that is still falling.
- [x] **T-6.8** Two-player bot select from the saved roster.
  - VERSUS is a **two-stage use of the existing select screen**, not a second screen: stage 1 writes player 1's bot to `__selected.json`, stage 2 writes player 2's to `__opponent.json` and launches. A dedicated 2P screen would have been a near-copy — the roster list, the 3D preview and the spec card are the whole value here, and they are already built.
  - Any single-player launch resets a half-finished versus pick, so a stranded stage-1 selection cannot leak into the next match.
- [x] **T-6.9** Local-multiplayer match flow, scoring, and rematch.
  - **The session decides, not the scene.** `/data/session.json` carries `players: 1 | 2`; BotAssembler reads it and puts a human in the opponent seat instead of a brain. Arena01 serves both modes **unchanged**, which is the same "no scene knows about any other" property the rest of the flow has. Scoring, the timer, damage judgement, persistence and Rematch are all the existing single-player machinery — versus needed no new match code, only new labels (PLAYER 1 / PLAYER 2 instead of YOU / OPPONENT, in both the result panel and the HUD).
  - The directional damage indicator is **suppressed** in versus: it can only point for one of the two players, so showing it would be actively misleading.
  - **Two bugs found in verification, both mine. (V)**
    1. `assemble()` predates `ctx.call` and reaches tools through `engine.mcp.toolMap` (the workaround T-2.24 exists to remove). Reading the session with `call` threw a `ReferenceError` that my own `catch` swallowed, so versus silently never engaged and the opponent stayed an AI.
    2. Arena01's opponent spawner named `opp-wedge` **directly**, so player 2's pick was ignored there — the marker is now `__opponent`, and Bot Select fills that file on the single-player path too, which keeps the arena's stock challenger exactly what it always was.
  - Verified after the fixes: both seats `inputDriven` with indices 1 and 2, **zero AI brains in the scene**, P2's chosen bot spawned, and pressing only P1's key moved P2 by exactly **0.00 m** — no crosstalk.
- [x] **T-6.10** Verify performance with two full player bots + destruction at target frame rate. **(V)**
  - Worst case on purpose: two **heavyweights** (Ravager 162 kg bar spinner vs Gavel 152 kg axe), both human-driven straight into each other with weapons held live for the full match, parts shearing off throughout.
  - **0.436 – 0.722 ms per frame (median 0.639)** against a 16.67 ms budget — about 4 % — at 60 fps and 88 entities, `scene.validate` clean and 0 engine errors. Roughly double the single-player figure (0.36 ms median), which is what a second live weapon and a second driven chassis should cost.
  - Risk **R1** ("physics budget can't carry 2 bots + debris") can be closed: this *is* that case, measured, with two orders of magnitude of headroom.

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
- [~] **T-6.15** UI consistency pass — one type scale, one color language, readable at the deployed resolution.
  - **"Readable at the deployed resolution" is done; the wider consistency pass is not.**
  - The bug this task existed to catch, found the moment the build was played on a real screen: the UI lays out in **anchor space** (every panel a fraction of the screen) but font sizes were written as **absolute pixels**. On a 2560-wide deployment the panels grow with the display and the text stays 14px, so the menu renders as tiny writing marooned in oversized boxes — buttons 602 x 104 px with 14px labels, a text-to-button ratio of 0.135.
  - **Invisible while authoring**, which is why it survived to week 8: the editor's game view happens to be about the size the numbers were originally picked against, so it looks right there and only breaks in the thing you ship.
  - Fixed by making the sizes DESIGN pixels against a 720p reference and converting through a `uiPx` helper, which measures the largest canvas in the document — the full-screen viewport in a build, the game-view panel in the editor, which is the correct reference in each case. Clamped to 0.75–2.5 so an extreme window cannot turn the interface into either billboards or ants.
  - **Measured:** at a 1215px viewport the scale is 1.69 and 14px becomes 24px; ratio 0.135 -> **0.23**. Applied at all 13 font sites across the six UI scripts, each of which funnels every size through its own `text()`/`button()` helper. The helper is duplicated per script because scripts cannot import each other (LIM-002).
  - **Still open:** one type scale and one colour language across the six screens. Sizes are currently 11/12/13/14/15 chosen per-script rather than from a shared ramp, and a couple of HUD labels now clip (`armor_fron`). Worth doing with the playtest feedback (T-7.1) rather than guessing.

### 6.4 Audio

> All five audio tasks are implemented by one script, `game/scripts/AudioDirector.ts`, from the
> numbers in `game/data/audio.json`. It is a pure consumer of the `battlebots.*` channels that
> already existed - like `VfxDirector`, it can be deleted from a scene without touching gameplay.
>
> **Two engine findings shaped the whole pass** (both filed in `engine-fixes.md`):
> **LIM-006** - the editor's `audio.*` surface never decodes a byte and never makes a sound;
> `loaded: true` comes back for five bytes of junk and for a dead URL alike. So the engine cannot
> verify audio, and every check below is deliberately run *outside* it.
> **LIM-007** - `audio.loadClip` is the only async tool in the namespace, so it cannot go through
> the synchronous `ctx.call` path every other script uses.
>
> **2026-08-25 - the game now makes sound.** Everything below was built correct and inert for a
> backend that does not exist. `AudioDirector` drives **WebAudio directly**: the synth's float
> samples go straight into an `AudioBuffer` (no WAV round trip), buses are real `GainNode`s,
> spatial voices get a `PannerNode` that follows the bot, and the listener tracks the match
> camera. The engine's `audio.*` calls are kept alongside as the declarative state of record -
> if a real backend ever ships, **one of the two paths must be deleted or every sound doubles.**
> Measured in the deployed build with an analyser spliced in front of the destination: steady
> peak 0.083 / RMS 0.026 from the motor and crowd beds, rising to 0.123 on an impact. Signal,
> not state.
>
> Two bugs found while proving it, both invisible to inspection: the AudioContext was created
> per director, so it was closed and rebuilt on every scene change - and a fresh context starts
> *suspended*, so audio would have worked on the menu and been silent for the rest of the
> session. And the gesture handler unhooked itself on the first input whether or not `resume()`
> took, so a click during page load would have silenced the game permanently with no way back.
>
> **Coverage gaps: `docs/AUDIO-GAPS.md`** - eight sounds the game already fires an event for and
> has no clip for, led by `battlebots.weaponSwing`, the only event in the entire game with no
> listener at all.

- [x] **T-6.16** Source/create the audio set: motor loops, weapon spin, metal impacts, sparks, part detachment, crowd, announcer stings, UI clicks.
  - **2026-08-25: sourced recordings supplied and wired — 11 of 13 clips now play a real file**, with synthesis kept as the fallback under every one of them. Four clips were added that the recordings made possible: `swing`, `hammerHit`, `impactHeavy`, `partBreak`. Mapping and the remaining gaps: `docs/AUDIO-GAPS.md`.
  - The fallback is not redundancy for its own sake — it is what makes both environments work. The deployed build serves `./audio/` and reports `11/11 sourced clips loaded`; the editor has no such path and reports `0/11 — the rest stay synthesised`, and the game is fully audible in both. A 404, a decode failure or a refused format degrades to a real sound rather than to silence.
  - Three gaps closed with it: **weapon swing** (`battlebots.weaponSwing` was the only event in the game with no listener at all, so a weapon that *missed* was silent), **impact variety** (three clips instead of one clank pitched by force, so you can hear *what* hit you), and **part destroyed**.
  - **Decision:** nothing is sourced - all nine clips are **synthesised at load** as 16-bit PCM WAV from `data/audio.json`. Untextured waveforms match untextured greybox primitives, the build carries no audio file at all, and the whole mix retunes without a recompile. Four kinds cover it: `saw` (motor, blade), `noise` (spark, crowd, click), `clank` (impact, detach), `sweep` (sting, ko).
  - The synth is **seeded**, not `Math.random`, so the same JSON always produces byte-identical clips.
  - **Measured:** `node game/data/audio-check.js` -> 9/9 pass, **230.6 KB** of PCM total. It extracts the synth block from `AudioDirector.ts` *verbatim* between `SYNTH:BEGIN`/`SYNTH:END` and runs it in Node, so it tests the shipped code rather than a copy that could drift.
  - It checks content, not just format: Goertzel confirms each saw's strongest partial is its specified fundamental (motor 72 Hz: 0.084, 144 Hz: 0.042, 216 Hz: 0.028 - a textbook sawtooth rolloff), and each sweep glides the direction it claims.
  - **The check earned its keep immediately** - it caught the crowd bed's loop seam. Crossfading the tail into the head in place leaves `out[n-1] -> out[0]` untouched, which is the one join that matters; rendering past the end and folding the overhang back fixed it (wrap step 0.511 -> **0.007**). It also caught a *wrong test*: a sawtooth jumps the full range once per cycle by definition, so demanding a small wrap step would have meant demanding a broken saw. For pitched loops the real criterion is whole-cycle alignment, which is what is asserted now.

- [x] **T-6.17** Load and attach clips (`audio_loadClip`, `audio_attachSource`, `audio_setListener`); set up 3D positioning.
  - `AudioSource` is a component, so an entity carries **at most one** - the same constraint `ParticleEmitter` puts on `VfxDirector`, and it dictates the design. Loops ride the thing they belong to (motor on the chassis, blade on the weapon, both spatial). One-shots **cannot**: a spinner hitting a plate would cut its own blade loop. They come from a round-robin pool of **8 voice entities** teleported to the contact point, so impact and spark land on separate voices at the true world position.
  - Listener follows the `MatchCamera` transform each frame, forward derived from its quaternion. A menu scene has no camera and correctly sets no listener.
  - **Result:** verified live in `Arena01` - `[Audio] 9/9 clips registered, 231 KB`, motor beds playing on both chassis, crowd bed at 0.095, a hit putting `bb_impact` on `AudioVoice_0` and `bb_spark` on `AudioVoice_1`, both at the exact contact point `[2, 0.5, -1]`. Zero errors across a full scene load.
  - **The live engine caught a bug the stub had not:** clips register as `bb_motor` but `attachSource` was being handed the bare name `motor`. The engine attaches such a source **without error** and simply never plays it. Now one `clipId()` owns the engine-side name, and the wiring harness refuses an unregistered clip so it cannot recur.

- [x] **T-6.18** Dynamic motor/weapon pitch driven by throttle and RPM.
  - Motor pitch tracks road speed from `physics.bodyState`; blade pitch tracks `spinFraction` off the existing `battlebots.weaponState`, so spin-up is audible before it is dangerous. A passive wedge reports `spinFraction` 0 forever and never opens a voice at all.
  - **The engine exposes no `setPitch`.** Pitch can only be written by re-issuing `attachSource`, and that **resets `playing` to false** - so every pitch change costs a re-attach *and* a re-play, and a naive per-frame update would restart the motor loop 60x/second. Pitch is therefore quantised to `PITCH_EPSILON` (0.035), which turns a continuous ramp into a few steps per second.
  - **Measured** live: blade at quarter speed -> pitch 0.813 (`0.55 + 1.05 x 0.25`, correct), at full -> **1.6** = `spinPitchMax`, volume 0.335 -> 0.765. Motor idles at 0.721 = `motorPitchMin`.

- [x] **T-6.19** Adaptive combat audio: crowd intensity rises with damage; ambience shifts near a knockout.
  - Crowd energy rises per hit (scaled by force), decays at `crowdDecayPerSecond`, and is smoothed frame-rate-independently so a flurry *swells* the room instead of stepping it. Health comes free off `battlebots.damageReport`, which the HUD and telemetry already emit ~2 Hz; below `nearKnockoutHealth` the floor lifts by `crowdNearKnockoutBoost`, so the room tightens as the match gets closer to over.
  - **Measured:** crowd rises under sustained hits and settles back to base once quiet; with a bot at 5/100 hp it settles at base + boost instead. Knockout fires the descending `ko` sweep.

- [x] **T-6.20** Mix pass with per-bus volume control.
  - Five buses (`master`, `sfx`, `weapons`, `crowd`, `ui`) in `audio.json`. Played volume is `master x bus x clip gain x dynamic`, computed in exactly one function - buses are the mix, clip gain is the balance within a bus, and nothing else in the file is allowed to invent a volume. `battlebots.setBus` moves any bus live, which is the real slider the options panel (T-6.13) was waiting for.
  - **Measured:** crowd bed at 0.095 = `0.9 x 0.3 x 0.35`; ko sting at 0.63 = `0.9 x 0.7`; blade at full spin 0.765 = `0.9 x 0.85`. `setBus` to 1 and to 0 moves and mutes it live.

- **Verification, since the engine cannot do it (LIM-006):**
  - `node game/data/audio-check.js` - 9/9 clips: header, level, clipping, loop seams, spectrum, determinism. `--write-wav <dir>` dumps real .wav files to audition.
  - `node game/data/audio-wiring-check.mjs` - **22 checks** driving the real `AudioDirector` against a stubbed engine that models the awkward parts (attach resets `playing`; async `loadClip`; unregistered clips rejected).
  - Both harnesses were **mutation-tested**: removing pitch quantisation, the impact cooldown, the motor re-play, or the clip prefix each fails the specific check that covers it. One assertion was found passing *vacuously* (two redundant clamps guard the 0..1 mix invariant, so neither alone could fail it) and was rewritten against the property rather than either clamp.

- [x] **T-6.21** **Feature-complete gate:** full loop, four weapons, destruction, AI opponent, local multiplayer, UI, and audio all in one build. **(V)**
  - **Passed 2026-08-25.** Everything on the list runs together in one deployed build at `http://localhost:4300`: menu -> bot select -> arena, four weapon archetypes (six counting the passive wedge and the no-weapon case), destruction with shearing and debris, the utility AI with three personalities and three difficulty tiers, both local-multiplayer seat paths, the full HUD - **and audio that is actually audible.**
  - The last blocker was the audio, and it was not a gate technicality: the engine has no audio backend in any profile (LIM-006), so every clip was correct and inert. `AudioDirector` now drives WebAudio directly. Verified by **measurement rather than inspection** - an analyser spliced in front of the destination in the deployed build read a steady peak of 0.083 from the motor and crowd beds, rising to 0.123 on an impact.
  - Two caveats recorded rather than buried: this passes on a **shimmed** build (T-8.2 / LIM-009), and the audio path is the game routing *around* the engine rather than through it.
  - Every *feature* on this list now exists and runs together in `Arena01` with a clean console. What is **not** yet done is the "in one build" half: T-8.2 (`build_export`, then run it from `:4173`) has not been attempted, and the audio has never been **heard** - LIM-006 means the editor cannot play it, so the runtime build is the first chance to confirm it is audible rather than merely correct. Leaving this open until then; it is a gate, and calling it passed on a build nobody has run would be exactly the kind of claim it exists to prevent.

---

## 7. Week 7 — Polish & Playtesting

- [~] **T-7.1** Run structured playtests (≥5 testers) with a written script and a feedback form.
  - **The kit is written; the sessions are not run.** `docs/PLAYTEST.md` has the facilitator script (cold open with no instructions, guided practice, three recorded matches, a blind easy/hard comparison, debrief), a match record sheet, and a 12-question feedback form. It is built backwards from the three tasks that are blocked on it, so a session produces matchup rows for T-7.4, labelled telemetry for T-7.5, and a ranked complaint list for T-7.10 — rather than a pile of opinions.
  - **This is the gate for the rest of week 7 and it needs five humans.** Nothing an agent can do substitutes for it.

- [~] **T-7.2** Log every bug into a triaged list (blocker / major / minor / polish).
  - `docs/BUGS.md`, triaged blocker / major / minor / polish / needs-repro, with engine defects kept out of it (they live in `engine-fixes.md`). **Seeded, not populated** — 7 entries, all found by engineering rather than by play, because the sessions that produce the real list have not happened. No blockers or majors open.
  - **The one that mattered: BB-001.** The engine project was running `hazardRadiusM: 2.4` — the value T-4.9 *replaced* with 4.0 after finding 8 of 15 matchups ending in a pit. The repo was right; the working copy was stale, and a stale-but-valid JSON loads perfectly and just plays wrong. Every balance observation made against that project was measured on tuning nobody approved. Pushed the correct file; the structural fix (a check that compares project data against the repo) is still open and is worth doing **before** the playtests, since a stale-data session produces data that looks fine and is worthless.

- [ ] **T-7.3** Fix all blockers and majors.
  - Nothing to do yet, honestly rather than vacuously: `docs/BUGS.md` has no blockers or majors open, and the list that would contain them comes out of T-7.1.

- [ ] **T-7.4** Balance pass on weapons, armor, and weight classes using playtest matchup data.
  - Blocked on T-7.1 by definition — it asks for *playtest* matchup data. The AI-vs-AI round robin already ran in T-4.9 and is not a substitute; the whole point of a second pass is to see what happens when a human is making the decisions.

- [>] **T-7.5** Re-tune AI weights with the freshly recorded telemetry — the "shaped by real players" claim rests on this, so do it with real data, not by hand.
  - **Blocked, and deliberately not faked.** There are 33 telemetry files and the tooling to aggregate them (`game/data/ai/aggregate.js`, T-5.19), so this *looks* ready. It is not. Classifying all 6,590 samples by what the player bot was actually doing:

    | What the recording actually is | Matches |
    |---|---|
    | Player bot driven by a human | **2** |
    | AI vs AI self-play | 18 |
    | Versus mode with nobody at the keyboard — a parked, idle bot | 13 |

  - Only **217 of 3,295 player samples (6.6 %)** contain any input at all, and they are concentrated in those two files. Retuning the weights on this would tune the AI against a stationary dummy and its own reflection, and then report it as *shaped by real players* — which is precisely the claim this task exists to protect. The task itself says "with real data, not by hand"; the honest reading is that it also means "not with data that merely exists".
  - Deferred until T-7.1 produces human telemetry. `docs/PLAYTEST.md` labels each session's recordings so they can be told apart from this batch.
- [x] **T-7.6** Performance optimization: profile with `profiler_getFrameStats`, cut draw calls, cap debris, tune shadows (`renderer_setShadowConfig`).
  - **Profiled, and there is nothing to optimize yet.** A complete 130 s Arena01 match with everything on — two bots, four-weapon actuation, destruction, VFX, HUD, telemetry, hazards, post-FX, 94 entities — costs **0.298–0.400 ms per frame (median 0.362)** against a 16.67 ms budget. That is ~2 % of frame, and 60 fps was held throughout.
  - Measured by timing `stepFrames` over ten 780-frame runs, which is a direct read on main-thread cost; the reported `frameTimeMs` of 16.68 is just the vsync cap and says nothing about headroom.
  - Debris is already capped (T-5.3: 8 pieces or 12 s, plus instant deletion below the pit since T-5.12). Shadows are `pcfsoft` at 1024 — left alone, because cutting them would buy frames that are not needed and cost the only depth cue a greybox arena has.
  - ~~**Cutting draw calls is deferred on purpose**, not skipped: the scene is greybox primitives, so the draw-call count is a property of art that does not exist yet (T-4.16 – T-4.18). Optimizing it now would be optimizing a placeholder. Re-profile when meshes land.~~
  - **Closed 2026-08-24.** The art was descoped (§4.4), so the greybox primitives *are* the final geometry and this draw-call count is the shipping one — at ~2 % of frame budget there is nothing to cut. The deferral is resolved by the premise disappearing, not by the work being done.
- [x] **T-7.7** Check `profiler_getErrors` / `profiler_getLogs` for a clean console across a full match.
  - **0 errors** across a full 130 s match, and `scene.validate` clean (0 errors, 0 warnings) at the end. **(V)**
  - **1 warning**, and it is not ours: `THREE.WebGLProgram` reporting X3595/X4000 from compiling the **FXAA** post-FX shader on the D3D backend. It is a shader-compiler diagnostic from three.js, fires once at program build, and is the direct cost of enabling FXAA in T-5.13. Recorded rather than suppressed so it is not rediscovered in week 8.
- [x] **T-7.8** Difficulty tuning: an easy/normal/hard mapping over the AI weight sets.
  - **Difficulty is a modifier over `tuning`, not a fourth personality.** Personality is who the bot is; difficulty is how well it plays. Keeping them orthogonal means "aggressive on easy" still reads as aggressive rather than as a different character, and it stops three weight tables becoming nine and drifting apart. Every pairing of 3 personalities × 3 tiers is asserted to boot.
  - **Nothing cheats.** No tier touches health, damage, mass or the drivetrain — a bot that wins by having more hp teaches the player nothing and feels unfair the moment they notice. The levers are all decision quality: reaction time (`minDwellSeconds`, `stuckSeconds`, `healthPollSeconds`), commitment precision (`alignToleranceRad`), self-preservation (`hazardRadiusM`, so an easy bot respects pits later and occasionally drives into one), throttle, and an outright mistake rate. `difficulty-check.mjs` enforces this with a deliberately broad pattern that would catch a future well-meaning `healthScale`.
  - **Mistakes take the runner-up, never a random action.** The second-best choice is still a defensible thing to do, so an easy bot reads as beatable rather than broken.
  - **Deterministic.** Nothing else in this codebase uses `Math.random` — the assembler is verified reproducible (T-2.11) and T-4.9's balance runs depend on a match replaying identically — so the mistake roll is a seeded LCG, seeded per bot from role + personality + tier so the two sides never err in lockstep.
  - `normal` is a pure pass-through of the tuning T-4.9 balanced, asserted rather than assumed. Difficulty rides `session.json` the same way the player count does, so the options panel sets it once and every brain assembled afterwards picks it up.
  - **Measured live**, both tiers on the same bot: `normal` → `dwell 0.45s, align 0.3rad, hazard 4m, throttle x1, mistakes 0%`; `easy` → `dwell 0.99s, align 0.6rad, hazard 2.4m, throttle x0.72, mistakes 35%`. Published throttle came out at exactly `0.1 × 0.72 = 0.072` and `0.6 × 0.72 = 0.432`.
  - **(V)** `node game/data/difficulty-check.mjs` — 9 checks, mutation-tested. One of them exists *because* of a mutation: giving `hard` a `healthScale` was caught, but deleting the code that applies the scaling was **not**, since every assertion until then only read the JSON. The brain now logs its effective tuning — useful in a playtest console in its own right — and the check asserts those numbers. The one lever applied on the update hook (`throttleScale`) is still outside that harness's reach and is verified in the live engine instead; the gap is written into the file rather than papered over.

- [x] **T-7.9** Game-feel polish: camera shake on big hits, hit pause, slow-mo on knockout.
  - All of it lives in `MatchCamera.ts`, because the camera is the only thing that can react to a hit **without changing its outcome**. Every effect is position-only, so the file's existing rule holds: the authored rotation is never written, and none of this can alter a match.
  - **Shake** is trauma-based. A hit adds trauma scaled by force; trauma decays linearly and displacement is trauma *squared*, so a big hit lands hard and leaves quickly while a tap does nothing. Losing a part outranks any single hit. Displacement is three sine waves at unrelated frequencies rather than per-frame randomness — it reads as the camera being shoved instead of as a bad video signal, and it is frame-rate independent for free.
  - **Hit stop** freezes *tracking*, not the simulation: for ~80 ms the camera stops chasing and only shakes, so the view goes rigid against a world that keeps moving. Freezing the simulation would change physics outcomes, which is a gameplay change wearing polish's clothes.
  - **Slow-mo on knockout is not possible and is not claimed.** The engine has no time scale (`engine-fixes.md` LIM-008): `engine.clock.stepSeconds` looks like one and is a fidelity knob — measured 61 steps/s at 1/60 and 120 steps/s at 1/120, both advancing 1.0 s of sim per wall second. `game.pause` is a full stop with its own event; `editor.setRunning` + `stepFrames` would work in the editor and not in a build. Shipped a slow cinematic push-in instead, which gives the ending a beat, and called it what it is. Logged as BB-003 to reopen if a `timeScale` ever lands.
  - **(V)** `node game/data/camera-feel-check.mjs` — 11 checks, mutation-tested. The one worth having is **frame-rate independence**: the same elapsed time at 30, 60 and 144 Hz must produce the same displacement, and swapping the sine noise for `Math.random` fails it immediately. That is the bug nobody catches by looking, because it only shows up on someone else's monitor.

- [ ] **T-7.10** Fix the top-5 "feels bad" items testers named, whether or not they're bugs.
  - Blocked on T-7.1, and the wording is the point: *testers named*. `docs/PLAYTEST.md` ranks complaints by how many testers hit them rather than by how bad they sounded, because one strong opinion is one person and three people hitting the same wall is a design problem.

---

## 8. Week 8 — Final Polish & Presentation

- [x] **T-8.1** Final QA pass against a written test matrix (every scene, every weapon, both multiplayer paths, save/load, reset). **(V)**
  - `docs/QA-MATRIX.md`. **41 cases, 0 failures, 0 engine errors**, run against the live engine with the repo's scripts and scenes pushed in.
  - All six scenes load clean and bring up their own systems. All **six weapon archetypes** come up correctly — including the two that correctly come up with *no* controller, which are the rows worth having: a passive wedge that quietly acquired a controller would spin, and one that failed to report itself would look identical to a bug. Both multiplayer paths wire their seats correctly (single: 1 AI brain; versus: 0 brains, both seats human). History survives a scene cycle; a live match reloads to 2 rebuilt chassis with 0 errors and no duplicate bots.
  - **This is a crash-and-wiring pass and the document says so.** It is driven by the engine and the AI; nobody is trying to win and nobody is confused, so it cannot tell you a weapon feels weak or that a player could not work out how to self-right. That is T-7.1's job and it needs five humans.
  - The distinction is written in because this project has already been caught by it once: 33 telemetry files that looked like play data and were AI self-play and parked bots (T-7.5).
  - Known gaps recorded rather than hidden: no audio case can pass, nothing here measures feel, the Workshop is only exercised as far as it assembles, and the build cases are run by hand in a browser because a hidden tab suspends `requestAnimationFrame`.
- [~] **T-8.2** Produce the deployable build: `build_export` / `build_bundle` via the engine-deployer "Deploy as WebGL" path; verify it runs from `:4173` in a clean browser profile. **(V)**
  - **The build itself is clean and the game is playable in a container — but only because the exported artifact is patched afterwards, so this is not `[x]`.**
  - `build.export --format site --name battle-bots` from a stopped `MainMenu`: **495 KB**, 18 scripts, 9 audio clips, 24 input actions, 0 missing behaviors, 0 warnings, inside the 5 MB budget. Deployed at **`http://localhost:4300`** (`battle-bots`, nginx, `--restart unless-stopped`).
  - **A stock export cannot run this game at all** (`engine-fixes.md` LIM-009). The deployed player is an older engine than the editor and is missing three things this repo depends on completely: the project filesystem is off for every non-editor profile (so `loadScene` / `readFile` / `writeFile` are never registered), the script host passes `{entity, world, dt, engine}` with **no `ctx.call`**, and `script.attach` still drops `params`. Two of those three are fixes recorded in `engine-fixes.md` as *done* — they exist in the editor and have simply never shipped to the deployed artifact.
  - None of it is visible from the outside: the export reports success, the budget passes, the page loads, the splash fades, and you get the scene that was live at export time with every button dead. The old `my-game` deploy on `:4200` looks like a working main menu and is a photograph of one — its numbers are frozen text baked into the scene.
  - `tools/shim-build.js` patches the export: narrows the capability gate to the filesystem **only** (granting the full editor set instead wedges the main thread on boot — engine-ready, splash gone, then a frozen renderer with no error), seeds the FS from a generated `seed.js`, rebuilds `call` and `params` onto the script context, and carries `params` through `script.attach`. Every replacement asserts an exact match count and fails loudly, because the failure being designed against is a build that looks fine and is quietly dead.
  - **Verified end to end in the container:** main menu → bot select (9 bots, live specs off the seeded bundle) → `FIGHT` → `Arena01` with both bots assembled, 18 parts tracked, the HUD, the hazard spinners, post-FX, `[Camera] shake/hit-stop armed`, and `[AI] opponent utility brain up (aggressive, normal)` reporting its effective tuning. 105 entities.
  - **The audio is registered and attached in a real runtime for the first time** — `9/9 clips registered, 231 KB`, motor beds playing on both chassis at the mix levels the numbers predict. The runtime has `AudioContext` and `decodeAudioData`, which the editor never used (LIM-006), so this is the first build on which the game can actually make a sound. Whether it *sounds right* still needs a human with speakers.
  - Not verified from `:4173` as the task words it — that path serves the editor-built runtime app, which has the same capability gate and the same problem. The shimmed container is the equivalent.
  - **Left open deliberately.** The deliverable is a build that stands on its own; this one stands on a patch to a vendored artifact that will break the moment the engine is rebuilt. It closes when LIM-009 does — most likely by rebuilding the deployed player from current engine source, which is a build-pipeline change rather than an engineering one.

- [x] **T-8.3** Check the build report (`build_getReport`) for size and asset warnings; trim if load time is bad.
  - **495 KB bundle against a 5 MB budget — 10 %, nothing to trim.** 18 scripts, 9 audio clips, 0 mesh assets, 0 materials, 0 paint textures, 0 warnings, `withinBudget: true`.
  - The greybox descope (§4.4) is why: with no meshes and no textures, the entire game is scripts, scene JSON and 231 KB of synthesised PCM. The two large files in a deployment are the engine's own `player.js` (4.9 MB) and the splash GIF inlined into `index.html` (2 MB) — both engine artifacts, neither ours, and neither something this project can trim.
- [ ] **T-8.4** Capture marketing screenshots (`renderer_captureScreenshot`, `viewport_captureViews`).
- [ ] **T-8.5** Cut the trailer (build → best match footage → 45–60s).
- [ ] **T-8.6** Build the store/presentation page: description, screenshots, trailer, playable link.
- [x] **T-8.7** Write the final README: what it is, how to play, controls, what's implemented, known issues.
  - `README.md` opens with what the game actually *is* — damage that is physical rather than a health bar with extra steps, four weapon archetypes that play differently on purpose, a utility AI whose difficulty tiers change how well it plays rather than what it is made of — then how to play it, the controls, and a **Known issues** table that leads with the two red ones rather than burying them.
  - Known issues names the sound and the build shim first, because those are the two things someone will otherwise discover for themselves and mistrust the rest of the document for.
  - Document index refreshed to include the playtest kit, the QA matrix, the bug list, `engine-fixes.md` and the postmortem.
- [x] **T-8.8** Write the postmortem: what the AI feedback in §4 changed, what the scope cuts bought, what the engine choice cost and saved.
  - `docs/POSTMORTEM.md`, answering the three questions asked and then the things that do not fit them.
  - **The feedback:** two notes taken (cut the build system; statistics not ML) and one refused (drop destruction to a visual effect). The refusal was right — destruction *is* the game, and risk R1, the headline physics risk of the whole proposal, was never close: 0.3–0.4 ms per frame against 16.67.
  - **The cuts:** the build system bought the entire back half of the project. The art descope retired R6 and made three more tasks moot. The playtests were *refused* rather than cut — and the most tempting shortcut in the project was right there, 33 telemetry files and a working aggregation script, which would have made the central claim false via a step nobody would ever have checked.
  - **The engine:** Rapier's `breakForce` and `contactForceEventThreshold` *are* the damage model and saved the window. What it cost was a recurring pattern — the engine being confidently wrong rather than absent. A missing feature costs an afternoon; a feature that reports success and does nothing costs a day and some trust.
  - The method that came out of it: verify outside the thing you are testing, and mutation-test the verifier. Three of the four check harnesses passed against code with the behaviour deleted until they were broken on purpose.
  - Ends with what I would do differently, of which the first is the real lesson: **deploy in week 2, not week 8** — three of the four expensive engine findings are deployment bugs that sat there the whole time.
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
| ~~R6~~ | ~~Art volume for 4 weapons + parts + 2 scenes, solo~~ | — | **Retired 2026-08-24:** the mitigation became the decision — greybox ships as the art direction, so there is no art track left to slip. | T-4.16–T-4.22 |
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
