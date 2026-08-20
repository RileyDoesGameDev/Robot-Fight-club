# Battle Bots

A physics-based robot combat game built on the **DSD SMPL-Engine**. Pick a combat robot, spar against AI
opponents, then fight in a destructible arena where wheels get sheared off and weapons jam.

Solo project · 8-week window · feature-complete target: end of week 6.

> **Scope change, 2026-08-19:** the player-facing build system is cut. The Create stage is now **choosing
> a prebuilt bot**, not building one. Rationale, and what it costs the pitch, in
> [docs/DESIGN.md](docs/DESIGN.md) §0.

**Status: the vertical-slice gate is passed (T-3.16, 2026-08-20).** Pick one of six prebuilt bots in
**Bot Select**, then **PRACTICE** to spar in `DemoCenter` or **FIGHT** a timed match in `Arena01`: a
3-second countdown, a scripted AI opponent, working damage with part degradation, detachment and
knockout, and a verdict on knockout or on damage dealt at time expiry — then Rematch or Change Bot.
No editor needed once you are in. A full part-fitting **Workshop** also exists and is kept as a stretch
feature (it is how the roster gets authored). See [docs/VERTICAL-SLICE.md](docs/VERTICAL-SLICE.md) for
the gate and its evidence.

![Two assembled bots facing off in Arena01](docs/images/assembled-bots.png)

| Document | What it is |
|---|---|
| [TASKS.md](TASKS.md) | Master task list, stable IDs (`T-1.8`), referenced by commits |
| [docs/DESIGN.md](docs/DESIGN.md) | The design contract — units, weight classes, damage model, controls, measured numbers |
| [docs/VERTICAL-SLICE.md](docs/VERTICAL-SLICE.md) | The one-page week 2–3 gate |
| [docs/engine-notes.md](docs/engine-notes.md) | Engine gotchas that cost real time — **read before writing a gameplay script** |
| [docs/engine-bugs.md](docs/engine-bugs.md) | Filable engine bugs & limitations hit while building this game |
| [docs/smpl-engine-README.md](docs/smpl-engine-README.md) | Reference copy of the engine's own README |
| `Battle_Bots_Project_Proposal (1).docx` | The original proposal |

---

## Repo ↔ engine project relationship (T-0.11)

This is the decision that shouldn't be re-litigated later.

The SMPL-Engine project `battle-bots` (id `battle-bots-upgyz6`) lives in **browser storage** (IndexedDB),
because `project_createOnDisk` needs an interactive OS folder picker and cannot be driven by an agent.
Browser storage is not a place work can safely live.

**Therefore: this git repo is the source of truth. The engine project is a working copy.**

- Everything authored as text — scenes, scripts, part data, docs — is committed here under `game/`.
- The engine project is treated as reproducible from this repo, not the reverse.
- `game/scenes/*.scene.json` are exported verbatim from the engine (byte-identical: the engine writes
  `JSON.stringify(scene, null, 2)`, and the export round-trip is length-verified).
- The editor's rolling `autosave.scene.json` is **not** an authored artifact and is gitignored.

Practical consequence: after authoring in the editor, export back into `game/` before committing.
Nothing in the browser is backed up.

```
game/
  scenes/     Arena01, BotSelect, Workshop (all spawner-driven)
              MainMenu, DemoCenter, PostMatch still placeholders
  scripts/    BotAssembler, BotDrive, DamageSystem, WeaponController, AiDriver, UtilityAi,
              MatchDirector, BotSelectController, DemoCenterController, WorkshopController,
              VfxDirector, HazardSpinner, MatchTelemetry
  data/
    parts/            14 PartDefs (chassis, wheels, weapons, armor, motors)
    bots/             6 prebuilt BotBlueprints + __selected.json (the persisted choice,
                      overwritten by Bot Select)
    schemas/          JSON Schema for PartDef and BotBlueprint
    damage.json       damage-model constants (T-3.3)
    vfx.json          particle presets + post-FX (T-5.9 - T-5.13)
    ai/weights.json   utility-AI weights and personalities (T-5.18)
    ai/aggregate.js   recorded matches -> suggested weights (T-5.19)
    weight-classes.json, input-map.json
    validate.js       data consistency check
    build-bundle.js   packs the above into bundle.json for the engine
    bundle.json       GENERATED — do not hand-edit
docs/         design doc, vertical slice, engine notes, screenshots
```

`Arena01` holds no baked bots. It contains two **spawner markers** whose `Name` encodes the blueprint
(`BotSpawn:player-slice:player`); `BotAssembler` builds the bots on load, taking an 18-entity scene to 36
live entities. See [docs/DESIGN.md](docs/DESIGN.md) §3.

After changing anything under `game/data/`, rebuild the bundle and push it to the engine project:

```sh
node game/data/validate.js        # check consistency first
node game/data/build-bundle.js    # regenerate bundle.json
# then write bundle.json to the engine project at /data/bundle.json
```

---

## Running it

The engine runs as a Docker stack (editor `:4174`, runtime `:4173`, deployer `:4180`):

```sh
docker compose up -d --build     # from the engine repo, not this one
```

Then open the editor at <http://localhost:4174>, open the `battle-bots` project, and load `Arena01`.

To drive an agent against the live editor, build and register `smpl-mcp-bridge`, then enable **Expose** in
the editor's MCP tab and confirm `engine_status` reports `engineConnected: true`. The bridge listens on
`ws://localhost:8765`; if that port is closed, every engine tool will fail — see
[docs/engine-notes.md](docs/engine-notes.md) §9.

> **Path caveat (T-0.5):** this repo lives under `C:\Users\KOBI 2\...`, which contains a space. Use the
> 8.3 short name (`C:\Users\KOBI2~1\...`) in MCP config, or relocate the repo to a space-free path.

## Data validation

```sh
node game/data/validate.js
```

Checks that every part has required fields, socket offsets sit on the 0.02 m lattice, part/socket category
constraints agree, blueprint attachments reference real sockets, no socket is double-filled, and each
blueprint's cached mass and weight class match the sum of its parts.

## Controls

`W`/`S` drive · `A`/`D` turn · `Space` spin up the weapon · `R` self-right · `Esc` pause

Load `BotSelect` and the rest is in-game: **PRACTICE** spars in `DemoCenter` (pick who you fight,
no clock), **FIGHT** runs a timed match in `Arena01`. When it ends, **Rematch** replays it and
**Change Bot** goes back to the roster.

## Git LFS

Binary assets (`.glb`, `.png`, `.wav`, `.blend`, …) are tracked via LFS. `.gitattributes` was committed
before the first binary landed. After cloning:

```sh
git lfs install
git lfs pull
```
