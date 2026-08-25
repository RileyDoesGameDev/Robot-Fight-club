# Battle Bots

A physics-based robot combat game built on the **DSD SMPL-Engine**. Pick a combat robot, spar against AI
opponents, then fight in a destructible arena where wheels get sheared off and weapons jam.

Solo project · 8-week window · feature-complete target: end of week 6.

**Play it: <http://localhost:4300>** — see [Playing it](#playing-it).

## What it is

You pick a combat robot from a roster of nine, and fight it in a 12 × 12 m arena with corner pits and
two floor spinners. Matches end by knockout, by immobilisation, by a bot going into a pit, or on
damage dealt when the clock runs out.

Damage is physical, not a health bar with extra steps. Every part — each wheel, the weapon, the
armour plate, the motor — is its own rigid body on a breakable joint, with its own hit points. Hit a
wheel hard enough and it shears off and becomes debris; lose enough wheels and you are immobilised
and you lose. A damaged motor drives slower. A damaged mount shears sooner. Armour is directional,
so where you get hit matters as much as how hard.

The four weapon archetypes play differently on purpose: a horizontal bar spinner trades everything
for one enormous hit, a vertical drum is steadier, an axe is a burst weapon on a cooldown, a flipper
tries to put you in a pit, and a passive wedge has no moving parts at all and wins on geometry.

The opponent is a utility AI — it scores every action it could take against weighted considerations
(range, alignment, its own health, yours, how long the grind has gone on, how close it is to a pit)
and takes the best one. Three personalities, three difficulty tiers, and the tiers change how well
it plays rather than what it is made of.

**Status.** Feature-complete except for sound, which the engine cannot play (see
[Known issues](#known-issues)). The vertical-slice gate passed in week 3; weeks 4–7 added the four
weapons, destruction, the utility AI, local multiplayer, HUD, game feel and difficulty. A playable
build runs in a Docker container. The art is deliberately greybox — see
[Art direction](#art-direction-and-naming-t-422).

![Two assembled bots facing off in Arena01](docs/images/assembled-bots.png)

| Document | What it is |
|---|---|
| [TASKS.md](TASKS.md) | Master task list, stable IDs (`T-1.8`), referenced by commits |
| [docs/DESIGN.md](docs/DESIGN.md) | The design contract — units, weight classes, damage model, controls, measured numbers |
| [docs/VERTICAL-SLICE.md](docs/VERTICAL-SLICE.md) | The one-page week 2–3 gate |
| [docs/engine-notes.md](docs/engine-notes.md) | Engine gotchas that cost real time — **read before writing a gameplay script** |
| [docs/engine-bugs.md](docs/engine-bugs.md) | Filable engine bugs & limitations hit while building this game |
| [docs/smpl-engine-README.md](docs/smpl-engine-README.md) | Reference copy of the engine's own README |
| [docs/PLAYTEST.md](docs/PLAYTEST.md) | Playtest session kit — script, match sheet, feedback form (T-7.1) |
| [docs/QA-MATRIX.md](docs/QA-MATRIX.md) | The QA pass: 41 cases across scenes, weapons, multiplayer, persistence (T-8.1) |
| [docs/BUGS.md](docs/BUGS.md) | Triaged bug list for the game itself |
| [engine-fixes.md](engine-fixes.md) | Engine bugs and limitations found building this — **read this one** |
| [docs/POSTMORTEM.md](docs/POSTMORTEM.md) | What worked, what did not, what the engine cost (T-8.8) |
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

## Playing it

The game runs in a Docker container at **<http://localhost:4300>**. Open it and play — `W`/`S`
drive, `A`/`D` turn, `Space` spins the weapon, `R` self-rights, `Esc` pauses.

```sh
docker ps --filter name=battle-bots      # it restarts with Docker
docker start battle-bots                 # if it is stopped
```

> **Keep the tab in the foreground.** Chrome suspends `requestAnimationFrame` in hidden tabs, so
> a backgrounded game does not merely slow down, it stops. That is browser behaviour, not a bug.

### Rebuilding it

A stock `build.export` **cannot run this game** — see `engine-fixes.md` LIM-009. The deployed
player is an older engine than the editor: no project filesystem outside the editor profile, no
`ctx.call` on the script context, and `script.attach` still drops `params`. The export succeeds,
the page loads, and every button is dead.

`tools/shim-build.js` patches the exported artifact back into a working state. To rebuild:

1. Push the repo's `game/scenes/` and `game/data/` into the engine project (see below).
2. Load `MainMenu`, stop simulation, and `build.export --format site --name battle-bots`.
3. Copy `index.html`, `bundle.json`, `player.js` into `build/battle-bots/`, and write a
   `seed.js` containing every `/data/**` and `/scenes/**` file as
   `globalThis.__SMPL_SEED_FILES__ = { "<path>": "<contents>", ... }`.
4. `node tools/shim-build.js build/battle-bots`
5. `docker restart battle-bots`

The shim asserts an exact match count for every replacement and fails loudly rather than
producing a build that looks fine and is quietly dead. If the engine is ever rebuilt, expect it
to fail — and prefer deleting it to loosening it.

## Art direction and naming (T-4.22)

**The greybox is the art direction.** Untextured primitives are what ships - this is a decision, not
a placeholder stage (TASKS.md §4.4). Nothing imports a mesh, so there are no glTF assets and no named
materials; `MeshRenderer.primitive` plus a colour is the whole renderer contract, and every collider
is an authored primitive rather than a hull decomposition.

Naming, as it is actually in force:

| Thing | Convention | Example |
|---|---|---|
| Part id | `<category>-<variant>-<size or kind>` | `ch-wedge-m`, `wp-spinner-h` |
| Categories | `ch-` chassis, `wh-` wheel, `wp-` weapon, `ar-` armor, `mt-` motor | `ar-heavy`, `mt-torque` |
| Size suffix | `-l` / `-m` / `-h` for chassis, wheels, armor | `wh-l`, `ch-brick-h` |
| Weapon kind suffix | `-h` horizontal bar, `-v` vertical drum, `-a` axe, `-p` passive | `wp-drum-v`, `wp-wedge-p` |
| Scene singleton | PascalCase | `MatchCamera`, `AudioDirector` |
| Arena geometry | `Group_Part` | `Floor_Center`, `Pit_NW` |
| Render-only child of a body | parent name + `Visual` | `Hazard_SpinnerWVisual` |
| Runtime bot entity | `Bot_<role>_<socket>_<partId>` | `Bot_player_weapon_top_wp-spinner-h` |
| Spawn marker | `BotSpawn:<blueprint>:<role>` | `BotSpawn:__selected:player` |
| Audio clip / voice / bed | `bb_<name>` / `AudioVoice_<n>` / `AudioBed_<Name>` | `bb_impact`, `AudioBed_Crowd` |

## Audio

Every sound is **synthesised at load** from `game/data/audio.json` by `game/scripts/AudioDirector.ts`.
There is no audio file in the build: nine clips (motor, blade, impact, spark, detach, crowd, sting,
knockout, click) are rendered to 16-bit PCM WAV in-script and registered with `audio.loadClip`. The
synth is seeded, so the same JSON always produces byte-identical clips.

The engine **cannot verify any of this**. Its editor-profile `audio.*` surface never decodes a byte
and never makes a sound - `loaded: true` comes back for five bytes of junk and for a dead URL alike
(`engine-fixes.md` LIM-006). So audio is checked outside the engine, by two harnesses that test the
shipped code rather than a copy of it:

```sh
node game/data/audio-check.js                  # the clips: header, level, loop seams, spectrum
node game/data/audio-check.js --write-wav /tmp/bb-audio   # ...and dump .wav files to listen to
node game/data/audio-wiring-check.mjs          # the wiring: 22 checks against a stubbed engine
```

`audio-check.js` extracts the synth block from `AudioDirector.ts` verbatim; `audio-wiring-check.mjs`
imports the director itself. Neither can drift from what ships.

Mix is `master x bus x clip gain`, over five buses in `audio.json`. Emit `battlebots.setBus`
(`{ bus, volume }`) to move one live.

> The repo root also carries an `Audio/` folder of sourced `.mp3` files from an earlier direction.
> Nothing references them and they are not part of the build - keep them as reference or delete them.

## Checks

Everything verifiable outside the engine, in one place. The engine can compile a script and
report a clean console; it cannot tell you a shake is frame-rate dependent, a loop clicks, or
a difficulty tier quietly grants a health bonus. These can.

```sh
node game/data/validate.js              # part/blueprint/socket consistency
node game/data/build-bundle.js          # regenerate bundle.json after any data change
node game/data/audio-check.js           # 9 synthesised clips: format, level, loop seams, spectrum
node game/data/audio-wiring-check.mjs   # AudioDirector against a stubbed engine (22 checks)
node game/data/camera-feel-check.mjs    # shake / hit-stop / knockout push (11 checks)
node game/data/difficulty-check.mjs     # easy-normal-hard mapping, and that it never cheats (9 checks)
```

The `*-check.mjs` harnesses import the shipped script itself and `audio-check.js` extracts the
synth block verbatim, so none of them can drift from what runs. All four have been
mutation-tested — the checks are known to fail when the behaviour they describe is removed.

## Playtesting

`docs/PLAYTEST.md` is the session kit (facilitator script, match sheet, feedback form).
`docs/BUGS.md` is the triaged bug list. Three week-7 tasks — the balance pass, the AI weight
re-tune, and the top-5 feel fixes — are blocked on real sessions and deliberately not faked;
see T-7.1/T-7.4/T-7.5/T-7.10 in `TASKS.md`.

**Before any session, push the repo's `game/data/` into the engine project.** A stale but
valid data file loads perfectly and plays slightly wrong, which produces a session that looks
fine and is worthless (BB-001).

## Data validation

```sh
node game/data/validate.js
```

Checks that every part has required fields, socket offsets sit on the 0.02 m lattice, part/socket category
constraints agree, blueprint attachments reference real sockets, no socket is double-filled, and each
blueprint's cached mass and weight class match the sum of its parts.

## Known issues

Honest list. Detail and repro in [docs/BUGS.md](docs/BUGS.md); engine-side causes in
[engine-fixes.md](engine-fixes.md).

| | Issue |
|---|---|
| 🔴 | **There is no sound.** Nine clips are synthesised, mixed across five buses, pitched by rpm and road speed, and spatialised on the camera — and the engine has no audio backend in *any* profile, so none of it is audible. Everything is built and inert (BB-011 / LIM-006). |
| 🔴 | **A stock `build.export` cannot run this game.** The deployed player is an older engine than the editor: no project filesystem, no `ctx.call`, and `script.attach` drops `params`. `tools/shim-build.js` patches the artifact back into a working state (BB-008 / LIM-009). |
| 🟠 | **No slow motion on a knockout.** The engine has no time scale at all; the knockout gets a cinematic camera push-in instead (BB-003 / LIM-008). |
| 🟠 | **No playtests have been run.** Five week-7 and week-8 tasks are blocked on real testers, and are deliberately not faked — including the AI weight re-tune, which would otherwise be tuned against a parked dummy (T-7.1, T-7.4, T-7.5, T-7.10). |
| 🟡 | **Type scale is not unified.** Font sizes are legible at any resolution now, but they are still chosen per screen rather than from one ramp, and two HUD labels clip (T-6.15). |
| 🟡 | **No bot thumbnails.** The roster shows a live turntable preview instead; a static thumbnail needs a staged camera (T-4.14, BUG-012). |
| ⬜ | **Two traces never reproduced:** a bot launched out of the arena, and an AI deadlocking against a wall. Both predate a balance fix and neither reproduces on the current build, but the second is a decision bug and decision bugs do not fix themselves (BB-006, BB-007). |

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
