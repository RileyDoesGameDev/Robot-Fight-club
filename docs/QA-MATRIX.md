# QA matrix — Battle Bots (T-8.1)

Last run: **2026-08-24**, against the live engine with the repo's scripts and scenes pushed in.
**41 cases, 0 failures, 0 engine errors.**

## What this is, and what it is not

This is a **crash-and-wiring** pass. It drives the real game through every scene, every weapon
archetype, both multiplayer paths, persistence and reset, and asserts that each one comes up with
the systems it is supposed to have and no errors in the console.

It is **not a playtest**, and it cannot become one. Everything below is driven by the engine or by
the AI; nobody is trying to win, nobody is confused, and nothing here can tell you that a weapon
feels weak or that a player could not work out how to self-right. That is T-7.1's job and it needs
five humans (`docs/PLAYTEST.md`).

The distinction matters because simulated play produces data that *looks* like playtest data. The
same trap already caught this project once: 33 telemetry files that turned out to be AI-vs-AI and
parked bots, which would have made "AI shaped by real player data" a false claim if they had been
used for tuning (T-7.5).

## How to re-run it

The cases are executed against the live editor over the MCP bridge — the engine has to be running
with the project open and **Expose** enabled. Push the repo in first (`tools/serve-repo.mjs`), or
the run measures whatever stale copy the working project happens to hold (BB-001).

---

## 1. Scene load — every scene, cold

Load each scene, run 90 frames, assert it comes up with no errors.

| Scene | Loads | Entities | Errors |
|---|---|---|---|
| MainMenu | yes | 15 | 0 |
| BotSelect | yes | 28 | 0 |
| DemoCenter | yes | 54 | 0 |
| Arena01 | yes | 53 | 0 |
| PostMatch | yes | 15 | 0 |
| Workshop | yes | 19 | 0 |

Every scene also brought up its own systems in the console: `[Menu] ready`, `[Select] ready — 9
bots`, `[Match] … 2 bots`, `[Damage] ready — 18 parts`, `[Hud] ready`, `[Vfx] ready — 5 presets`,
`[Telemetry] armed`, `[Audio] 9/9 clips registered`, `[PostMatch] ready`, `[Workshop] ready`.

## 2. Weapon archetypes — all six

Set each bot as the player, load `Arena01`, assert its `WeaponController` comes up in the right
mode with the right numbers.

| Archetype | Bot | Result | Errors |
|---|---|---|---|
| `wp-spinner-h` horizontal bar | Ravager | `mode spin, target 1400 rpm` | 0 |
| `wp-drum-v` vertical drum | Havoc | `mode spin, target 1100 rpm` | 0 |
| `wp-hammer-a` axe | Gavel | `mode swing, arc -1.20 -> 0.90 rad` | 0 |
| `wp-flipper-p` flipper | Tipster | `mode swing, arc -0.05 -> 1.35 rad` | 0 |
| `wp-wedge-p` passive wedge | Hornet | no controller — **correct**, a wedge wins on geometry | 0 |
| none fitted | Anvil | no controller — **correct** | 0 |

The two "no controller" rows are the ones worth having. A passive weapon that quietly acquired a
controller would spin a wedge; one that failed to *report* itself would look identical to a bug.

## 3. Multiplayer paths — both

Assert the seat wiring, which is the thing that silently breaks (a stale `session.json` once left
single-player with two human seats and no AI at all).

| Path | Player 1 | Player 2 / opponent | AI brains |
|---|---|---|---|
| Single player | `inputDriven: true`, index 1 | `inputDriven: false`, index 2 | **1** |
| Versus | `inputDriven: true`, index 1 | `inputDriven: true`, index 2 | **0** |

## 4. Persistence

| Case | Result |
|---|---|
| Match history survives a scene cycle | 30 → 30 entries |
| Roster survives a scene cycle | preserved |
| Blueprint hand-off (`__selected` → arena spawn) | the chosen bot is the one assembled, all 6 archetype runs |

## 5. Reset

| Case | Result |
|---|---|
| Reload a live match mid-play | 2 chassis rebuilt, 0 errors |
| Assembly is idempotent | spawner renames to `BotSpawned:` — no duplicate bots on reload |

## 6. Build

Run separately, against the deployed container (`http://localhost:4300`).

| Case | Result |
|---|---|
| Menu → BotSelect → FIGHT → Arena01 | reaches a live match, 105 entities |
| Bot specs read from seeded data | mass, weapon, armour, top speed all populated |
| Chassis renders on the bot | fixed — see BB-010 |
| UI legible at deployment resolution | fixed — see BB-009 |
| Audio | **no output** — engine limitation, BB-011 / LIM-006 |

---

## Known gaps in this matrix

- **No audio case can pass.** The engine has no audio backend in any profile, so the audio row
  above records a limitation rather than a result.
- **Nothing here measures feel.** Frame rate, balance, readability and difficulty are all outside
  what this can assert. T-7.6 covers performance; the rest waits on playtests.
- **The Workshop is exercised only as far as it loads and assembles a draft.** It is descoped to a
  stretch goal (T-9.0), so its authoring flow is not walked case by case.
- **The build cases are run by hand** in a browser, not automated. They need a real page and a
  visible tab, because a hidden tab suspends `requestAnimationFrame` and the game stops.
