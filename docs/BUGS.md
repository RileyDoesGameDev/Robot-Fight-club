# Bug list — Battle Bots (T-7.2)

Triaged: **blocker** (cannot ship / cannot play) · **major** (spoils a match) ·
**minor** (wrong but survivable) · **polish** (feel and finish) ·
**needs-repro** (seen once, not yet pinned down).

Engine defects live in `engine-fixes.md`, not here. This file is the game's own.

> **Status: seeded, not populated.** Everything below was found by engineering — profiling,
> reading telemetry, and pushing the build around. The bulk of a real bug list comes out of
> T-7.1, and no playtest has been run yet, so the *interesting* entries do not exist yet. The
> point of writing it now is that the sessions have somewhere to put their findings.

---

## Blocker

*None open.*

## Major

*None open.*

---

## Minor

### BB-001 — the engine project can silently run stale data files · **fixed**

Found 2026-08-24 while adding difficulty tiers. The engine project's `/data/ai/weights.json`
still had `hazardRadiusM: 2.4` — the value T-4.9 replaced with `4.0` after finding that 8 of
15 matchups ended in a pit. The repo was correct; the working copy was months of decisions
behind, and nothing anywhere said so.

That is worse than a stale file: **every balance observation made against that project was
measured on tuning nobody had approved**, and it is invisible because a stale-but-valid JSON
file loads perfectly and just plays slightly wrong.

*Fixed* by pushing the repo's copy. **Not** fixed structurally — the README documents a manual
sync step, and a manual sync step is a thing that will be skipped again. The real fix is a
check that compares the project's data files against the repo's and refuses to start, or at
least shouts. Worth doing before the playtests, since a stale-data session produces data that
looks fine and is worthless.

### BB-008 — a stock build is silently dead, and looks fine

Not our bug, but it is the one most likely to waste someone's afternoon, so it is recorded here
as well as in `engine-fixes.md` (LIM-009). `build.export` reports success, the budget check
passes, the page loads, the splash fades — and every button does nothing, because the deployed
player has no project filesystem, no `ctx.call`, and drops `Script.params`.

The old `my-game` deployment on `:4200` is the trap in its purest form: it *looks* like a
working main menu, complete with a win/loss record. Those numbers are frozen text baked into
the scene at export time. Nothing behind them is alive.

Shimmed by `tools/shim-build.js`; the container on `:4300` is a real, playable build. Reopen if
the engine is rebuilt and the shim stops matching.

### BB-002 — `scene.query` reorders components on export

Re-exporting an untouched scene produces a diff: `Name` moves relative to `MeshRenderer` on
about a dozen entities. The README claims exports are byte-identical, and for most entities
they are, but component insertion order is not preserved for all of them.

Harmless to the game — same JSON, same entities — but it buries a one-line change in forty
lines of churn, which is how a real change gets waved through in review. Worked around by
editing scene files surgically rather than round-tripping them.

---

## Polish

### BB-003 — no slow motion on a knockout

T-7.9 asked for it; the engine has no time scale at all (`engine-fixes.md` LIM-008). Shipped a
cinematic camera push-in instead, which gives the ending a beat but is not the same thing.
Reopen if a `timeScale` ever lands.

### BB-004 — FXAA emits a shader-compiler warning on D3D

`THREE.WebGLProgram` reports X3595/X4000 once, when the FXAA post-FX shader is built. Cosmetic,
fires once, comes from three.js rather than from this project — the direct cost of enabling
FXAA in T-5.13. Recorded so it is not rediscovered in week 8 and mistaken for something new.

### BB-005 — two containers report `unhealthy` · **no longer reproduces**

`engine-runtime` and `engine-editor` reported unhealthy in `docker ps` while working perfectly
(T-0.2). Re-checked 2026-08-24 during the build work: all three services now report `healthy`.
Nothing here changed them, so either the healthchecks were fixed upstream or they were failing
on a transient the containers have since settled out of. Left recorded rather than deleted,
because "it went away on its own" is worth knowing if it comes back.

---

## Needs repro

### BB-006 — a bot was launched clean out of the arena

Telemetry `DemoCenter-3750-16.json` has the player's `z` going `3.3 → 3.9 → 7.4 → 12.3 → 16.8
→ 20.7` over about two seconds. The arena is 12 × 12 m with walls at `z = ±6.15`, so that bot
finished **14 m outside the world** and the match was scored `pitted` — which is what the
out-of-bounds check calls anything below the floor, whether it fell in a pit or was punted
over a wall.

Not reproduced on the current build. Two reasons to suspect it is already gone: the file
cannot be dated (IndexedDB rewrote every mtime on load), and the same batch shows
`hazardRadiusM: 2.4`, i.e. it predates the T-4.9 balance pass. But the walls **are** only
1.2 m tall, and the same telemetry records a hit at **57,947 N**, so the launch is physically
plausible and may simply be rare.

Worth an explicit check during playtests, and worth separating the two cases in the scoring:
"fell in a pit" and "left the arena" are different events and only one of them is a designed
mechanic.

### BB-007 — an AI bot deadlocked against a wall for nine seconds

Same batch, `DemoCenter-14833-58.json`: from `t=3.63` to `t=12.42` the player bot sits at
`(0.2, 5.6)` — hard against the south wall at `z = 6.15` — emitting `retreat` every single
tick while the opponent sits 0.9 m away emitting `ram`. Neither moves. Health drips from 85%
to 80% over the standoff.

The shape of it is a cornered bot choosing `retreat`, retreating into a wall, remaining
cornered, and choosing `retreat` again. `wallNear` exists as a consideration and `stuck`
feeds the same action, so the AI has the information and still deadlocks — which suggests
retreat needs a direction that is not simply "away from the opponent" when there is a wall
behind it.

Same dating caveat as BB-006. Not reproduced on the current build, but this one is a
*decision* bug rather than a physics accident, and decision bugs do not usually fix
themselves — a targeted look at `retreat` is warranted regardless of what the playtests show.
