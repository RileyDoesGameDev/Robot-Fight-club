# Vertical Slice Definition (T-0.14)

**One page. This is the week 2–3 gate.** If the loop below runs end to end, the project is on track; if it does not, nothing else in weeks 4–6 matters yet. Pinned per the proposal's own recommendation ("build a vertical slice by week 2–3 to validate the full Create → Test → Destroy loop before investing in content breadth").

## The slice is exactly this

| Axis | Slice content | Deliberately excluded |
|---|---|---|
| Arena | `Arena01` only — 12 × 12 m, four walls, four corner pits | hazards, second arena, set dressing |
| Chassis | `ch-box-m` only | wedge and brick chassis |
| Weapon | `wp-spinner-h` only (horizontal spinner) | drum, hammer, flipper, passive wedge |
| Wheels | `wh-m` only | light and heavy wheels |
| Armor | `ar-light` only, front socket | medium/heavy tiers, other sockets |
| Opponent | one scripted AI (`AiDriver.ts`) | utility AI, personalities, telemetry tuning |
| Players | single player vs. AI | local multiplayer |
| Art | greybox primitives | modelled/textured meshes |
| Audio | none | the whole audio pass |

The blueprint that defines it is `game/data/bots/player-slice.json` — "Blue Ruin", 98 kg middleweight.

## Pass criteria

The gate is met when a player can, without touching the editor:

1. **Create** — open `Workshop`, fit four wheels, one spinner and one armour plate to `ch-box-m`, see live mass/weight-class readout, name and save the blueprint.
2. **Test** — launch into `DemoCenter`, drive with `WSAD`, spin the weapon with `Space`, self-right with `R`.
3. **Destroy** — launch into `Arena01` against the scripted opponent and land hits that:
   - deal damage through the contact-force path (`physics.contact` → `DamageSystem.ts`),
   - drive at least one part from `intact` → `damaged` → `destroyed`,
   - shear at least one wheel or armour plate off via `Joint.breakForce`,
   - visibly degrade function (a lost wheel costs drive on that side).
4. **Resolve** — reach a knockout or time expiry, see a post-match summary, and return to the Workshop with the blueprint intact.
5. **Repeat** — a second match runs correctly: all authored joints and part health restored (T-1.15 / T-5.8).

## Recorded evidence required

Per the standing convention that every **(V)** task gets a number, a screenshot, or a log line:

- `scene_validate` clean on `Arena01` and on a live mid-disassembly bot
- `profiler_getFrameStats` during a full match with both bots and debris present
- a saved blueprint round-tripped through save → load → assemble, producing an identical entity tree (T-2.11)
- `profiler_getErrors` empty across a complete match

## Status at end of week 1

Done: arena blockout with colliders and lighting, greybox bot, tank drive with measured feel, self-right (implemented, needs real geometry to validate), input map, part/blueprint data model with a consistency validator, physics-budget baseline.

Not started: Workshop scene and UI, the assembler, the damage system, the weapon controller, the AI opponent. Those are the slice.
