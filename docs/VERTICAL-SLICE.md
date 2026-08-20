# Vertical Slice Definition (T-0.14)

> **Rescoped 2026-08-19:** the Create stage is now **choosing a prebuilt bot**, not building one. See
> `DESIGN.md` §0. The gate below has been rewritten accordingly — step 1 is a selection screen, and the
> Workshop is no longer part of the slice.

**One page. This is the week 2–3 gate.** If the loop below runs end to end, the project is on track; if it does not, nothing else in weeks 4–6 matters yet. Pinned per the proposal's own recommendation ("build a vertical slice by week 2–3 to validate the full Create → Test → Destroy loop before investing in content breadth").

## The slice is exactly this

| Axis | Slice content | Deliberately excluded |
|---|---|---|
| Create | pick from **2 prebuilt bots** on a select screen | building, part fitting, paint, naming |
| Arena | `Arena01` only — 12 × 12 m, four walls, four corner pits | hazards, second arena, set dressing |
| Player bot | `player-slice` ("Blue Ruin", 98 kg, spinner) | the rest of the roster |
| Weapon | `wp-spinner-h` only (horizontal spinner) | drum, hammer, flipper |
| Opponent | `opp-wedge` ("Doorstop") driven by one scripted AI (`AiDriver.ts`) | utility AI, personalities, telemetry tuning |
| Players | single player vs. AI | local multiplayer |
| Art | greybox primitives | modelled/textured meshes |
| Audio | none | the whole audio pass |

Both bots already exist as authored blueprints: `game/data/bots/player-slice.json` and
`game/data/bots/opp-wedge.json`.

## Pass criteria

The gate is met when a player can, without touching the editor:

1. **Create** — open `BotSelect`, page through the roster, see each bot's stats (mass, class, armour, weapon), and confirm a choice.
2. **Test** — launch into `DemoCenter`, drive with `WSAD`, spin the weapon with `Space`, self-right with `R`.
3. **Destroy** — launch into `Arena01` against the scripted opponent and land hits that:
   - deal damage through the contact-force path (`physics.contact` → `DamageSystem.ts`),
   - drive at least one part from `intact` → `damaged` → `destroyed`,
   - shear at least one wheel or armour plate off via `Joint.breakForce`,
   - visibly degrade function (a lost wheel costs drive on that side).
4. **Resolve** — reach a knockout or time expiry, see a post-match summary, and return to `BotSelect` able to pick again.
5. **Repeat** — a second match runs correctly: all authored joints and part health restored (T-1.15 / T-5.8).

## Recorded evidence required

Per the standing convention that every **(V)** task gets a number, a screenshot, or a log line:

- `scene_validate` clean on `Arena01` and on a live mid-disassembly bot
- `profiler_getFrameStats` during a full match with both bots and debris present
- the chosen blueprint assembled twice into an identical entity tree (T-2.11 — already recorded)
- `profiler_getErrors` empty across a complete match

## Status

**Week 1 (done):** arena blockout with colliders and lighting, greybox bot, tank drive with measured feel, self-right (implemented, needs real geometry to validate), input map, part/blueprint data model with a consistency validator, physics-budget baseline.

**Week 2 so far (done):** the **assembler** (T-2.9) — a `BotBlueprint` becomes a live bot, one breakable rigid body per part, driven by spawner markers. Determinism verified (T-2.11). `Arena01` is spawner-driven: both bots build themselves on load and the player bot drives, with tuning carrying over unchanged from the greybox. Two-bot physics cost measured at 0.135 ms/step, which answers T-6.10 early.

**Week 2, also done (now a stretch feature — `DESIGN.md` §0):** the **Workshop** (T-2.12 – T-2.18) — fit/swap/remove parts across ten sockets, live mass and weight-class readout, undo/redo, save/load with a roster, and an over-cap save guard. The preview bot rebuilds on every edit through the same assembler the arena uses. The reverse path (T-2.10) is real: Save serialises what the *scene* contains and confirms it matches the draft.

**Remaining for the gate:** the `BotSelect` screen (T-2.20 – T-2.23), the damage system (T-3.1 – T-3.8), the spinner weapon controller (T-3.9), the scripted AI opponent (T-3.13), the `DemoCenter` scene (T-3.15), and scene-to-scene hand-off so a chosen bot actually launches (T-6.2).

**Pass criteria progress**

| Step | State |
|---|---|
| 1. Create — pick a prebuilt bot | ✅ `BotSelect` works: 6-bot roster, spec card, turntable preview, CONFIRM persists the choice |
| 2. Test — drive it | ⚠️ the chosen bot drives and fights in `Arena01`; `DemoCenter` (T-3.15) and automatic scene switching (T-6.2) do not exist — you load the arena yourself |
| 3. Destroy — damage, part loss, degradation | ✅ damage, degradation, detachment, knockout and a working spinner all verified |
| 4. Resolve — knockout, post-match summary | ❌ not started |
| 5. Repeat — clean second match | ❌ blocked on T-1.15 (joint restore on reset) |

**Steps 1 and 3 are done and steps 2's substance works** — a chosen bot drives, fights an AI, takes and deals damage, sheds parts and can be knocked out. What is left is the *frame* around a match rather than the match itself: a Test scene (T-3.15), automatic scene flow (T-6.2), and a match lifecycle that ends when the knockout event fires (T-6.3). That is the remaining work for the T-3.16 gate.
