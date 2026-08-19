# Battle Bots

A physics-based robot combat game built on the **DSD SMPL-Engine**. Design and build a combat robot from
modular parts, spar against AI opponents, then fight in a destructible arena where wheels get sheared off
and weapons jam.

Solo project · 8-week window · feature-complete target: end of week 6.

**Status: week 1 complete, week 2 underway.** The arena is blocked out and the **assembler works** — a
`BotBlueprint` becomes a live bot with one breakable rigid body per part, verified deterministic. Two bots
now build themselves on scene load and drive. Next: the Workshop scene and UI, then the damage system —
see [docs/VERTICAL-SLICE.md](docs/VERTICAL-SLICE.md) for the week 2–3 gate.

![Two assembled bots facing off in Arena01](docs/images/assembled-bots.png)

| Document | What it is |
|---|---|
| [TASKS.md](TASKS.md) | Master task list, stable IDs (`T-1.8`), referenced by commits |
| [docs/DESIGN.md](docs/DESIGN.md) | The design contract — units, weight classes, damage model, controls, measured numbers |
| [docs/VERTICAL-SLICE.md](docs/VERTICAL-SLICE.md) | The one-page week 2–3 gate |
| [docs/engine-notes.md](docs/engine-notes.md) | Engine gotchas that cost real time — **read before writing a gameplay script** |
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
  scenes/     Arena01 (spawner-driven) + MainMenu, Workshop, DemoCenter, PostMatch (placeholders)
  scripts/    gameplay behaviours — BotDrive.ts, BotAssembler.ts
  data/
    parts/            14 PartDefs (chassis, wheels, weapons, armor, motors)
    bots/             seed BotBlueprints — player-slice, opp-wedge, opp-brick
    schemas/          JSON Schema for PartDef and BotBlueprint
    damage.json       damage-model constants (T-3.3)
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

`W`/`S` drive · `A`/`D` turn · `Space` weapon · `R` self-right · `Esc` pause

## Git LFS

Binary assets (`.glb`, `.png`, `.wav`, `.blend`, …) are tracked via LFS. `.gitattributes` was committed
before the first binary landed. After cloning:

```sh
git lfs install
git lfs pull
```
