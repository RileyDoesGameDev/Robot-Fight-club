# Postmortem — Battle Bots (T-8.8)

Written 2026-08-24, at the end of week 8. The task asks three questions: what the AI feedback in the
proposal's §4 changed, what the scope cuts bought, and what the engine choice cost and saved. Taking
them in that order, then the things that do not fit under any of them.

---

## 1. What the AI feedback changed

The proposal came back with three substantive notes. Two were taken and one was refused, and the
refusal turned out to be the more interesting decision.

**"Cut the player-facing build system."** Taken, in week 2, and it was the single most valuable cut
of the project (§0 of DESIGN.md). The Create stage became *choosing* a prebuilt bot rather than
assembling one. What it bought is the entire rest of the game: the four weapons, destruction, the
utility AI, local multiplayer and the HUD all landed inside the window, and none of them would have
if the freeform builder had stayed. The Workshop still exists — it is how the roster gets authored —
but as a tool rather than a feature, which is a much cheaper thing to own.

**"Use statistics, not ML, for the AI tuning."** Taken, and it made the claim honest. The utility AI
scores actions against weights in a JSON file; `aggregate.js` turns recorded matches into suggested
weights by plain arithmetic. There is no model, nothing is learned, and the pitch never had to
overstate what it does.

**"Consider dropping destruction to a visual effect."** Refused, and this was right. Destruction *is*
the game — every part being its own rigid body on a breakable joint is what makes a match a sequence
of decisions rather than two health bars draining. Losing a wheel changes how you drive for the rest
of the match. That is worth the physics budget, and the budget turned out not to be the problem
anyway: a full two-bot match with destruction, VFX, HUD and hazards costs **0.3–0.4 ms per frame**
against a 16.67 ms budget. Risk R1 — "physics can't carry two bots plus debris" — was the headline
risk of the whole proposal and it was never close.

---

## 2. What the scope cuts bought

Three cuts, in order of how much they returned.

**The build system (week 2)** — covered above. Bought the back half of the project.

**The art (week 8)** — the greybox became the art direction rather than a placeholder stage.
Untextured primitives are what ships. This retired risk R6, made two more tasks moot (no imported
meshes means no collision proxies to author and no LODs to generate), and closed the one open thread
in the performance task, which had deferred draw-call work on the grounds that the geometry was
temporary. It also cost something real and worth naming: the wear overlay and the paint-maskable
channel were the two places art was going to carry information, so damage now has to read entirely
through colour and VFX.

**The playtests (not a cut — a refusal)** — five tasks are blocked on five humans and were left
blocked. The most tempting shortcut in the project was sitting right there: 33 telemetry files and a
working aggregation script, everything needed to "re-tune the AI on recorded data". Classifying the
samples showed 2 matches with a human driving, 18 of AI self-play, and 13 of versus mode with nobody
at the keyboard — 6.6 % of player samples contain any input at all. Tuning on that and reporting it
as *shaped by real player data* would have been the project's central claim, made false by a step
nobody would ever have checked.

---

## 3. What the engine cost and saved

### What it saved

A great deal, and it should be said first. Rapier via the engine gave working breakable joints,
contact-force events and CCD for free, and those three things are the entire damage model. `breakForce`
on a joint is *exactly* the destruction mechanic — a part shears when the force on its mount exceeds
what the mount can take — and it was already there. `contactForceEventThreshold` is exactly the damage
signal, with a built-in filter so the event stream stays cheap. Building those from scratch would have
eaten the window.

The MCP surface is the other half. Being able to drive the live editor from an agent — build a scene,
attach a script, step frames, read the console, measure a match — made the whole project's method
possible. Most of the evidence in TASKS.md was gathered that way.

### What it cost

The recurring, expensive pattern was **the engine being confidently wrong rather than absent**. A
missing feature costs an afternoon; a feature that reports success and does nothing costs a day and
some trust. Four examples, all of which took real time:

- **`audio.loadClip` returns `loaded: true` for five bytes of junk.** There is no audio backend at
  all — not in the editor, and not in the deployed runtime either, which I checked and got wrong the
  first time. The entire audio pass is correct and inert. Every audio task would have "passed" against
  garbage.
- **`build.export` produces a build that cannot run the game.** The export succeeds, the budget check
  passes, the page loads, the splash fades, and every button is dead. The deployed player turned out
  to be an *older engine* than the editor, missing two fixes this repo already had filed as done.
- **The renderer does not fold parent transforms.** A visual parented to a moving body draws at the
  world origin. Both bots' chassis and both arena hazards stacked up in the middle of the arena and
  each bot appeared as wheels with no body — while `scene.worldTransform` cheerfully reported every
  one of them in the right place.
- **`clock.stepSeconds` looks like a time scale and is a fidelity knob.** Halving it doubles the step
  rate and leaves simulation speed identical. Easy to ship a broken slow-motion on.

Ten limitations and a dozen bugs are written up in `engine-fixes.md`. The ones above are the ones that
would have shipped silently.

### The method that came out of it

Every one of those was caught the same way: by refusing to accept the engine's own report as evidence.
That hardened into a habit worth keeping — **verify outside the thing you are testing**.

`audio-check.js` extracts the synthesiser from the shipped script and validates the bytes in Node.
`audio-wiring-check.mjs` imports the real director and drives it against a stub that models the
awkward parts. `camera-feel-check.mjs` asserts the shake is frame-rate independent, which is a bug
that only appears on someone else's monitor. `difficulty-check.mjs` asserts no tier grants a stat
advantage.

All four were **mutation-tested** — deliberately broken to confirm the check fails — and that is what
made them worth having. Three checks passed against code with the behaviour removed. One asserted a
property guarded by two redundant clamps, so neither could fail it alone. Another would have demanded
a broken sawtooth. A green check that cannot go red is worse than no check, because you stop looking.

---

## 4. The things that do not fit the three questions

**The most dangerous bug was in the task list.** A commit rewrote TASKS.md from a stale copy: it
unticked 24 completed tasks and deleted 90 lines of evidence. The code was untouched; only the record
of it was lost. It was caught by noticing that a commit said a task was done while the file said it
was open. Nothing else would have caught it, and a week later nobody would have known which was true.
The tracker is a deliverable and needs the same care as the code.

**The stale-data failure is the same shape.** The engine project was running a balance value that a
task had replaced weeks earlier. A stale-but-valid JSON loads perfectly and just plays slightly wrong,
so every balance observation taken against it was measured on tuning nobody had approved. The
structural fix — a check that compares the project's data against the repo's — is still open, and is
the highest-value small thing left.

**Writing down why is what made the deep bugs findable.** The dense comments in these scripts are not
decoration. "The renderer does not fold parent transforms, so a child visual lands at the origin"
takes thirty seconds to write and saves the next person the day it cost. The task list's `Result:`
lines did the same job at project scale, which is exactly why losing them mattered.

## What I would do differently

- **Deploy in week 2, not week 8.** Three of the four expensive engine findings — no filesystem, no
  `ctx.call`, no `Script.params` in the runtime — are *deployment* bugs, and they were sitting there
  the whole time. Building for eight weeks against an editor that behaves differently from the target
  meant discovering the target's contract at the worst possible moment.
- **Distrust `true`.** Every "it worked" that came back from a single boolean turned out to deserve a
  second look. The habit arrived late and should have been the starting posture.
- **Book the playtesters in week 1.** They are the one dependency that cannot be compressed, parallelised
  or substituted, and five tasks are still sitting behind them.
