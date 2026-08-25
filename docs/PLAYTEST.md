# Playtest kit — Battle Bots (T-7.1)

Everything needed to run a session except the people. One facilitator, one tester at a time,
about 25 minutes each. Five testers minimum, because four is where you still cannot tell a
pattern from a personality.

**Why this exists in this shape:** three week-7 tasks are blocked until real sessions happen,
and they are blocked on *data*, not on opinions. T-7.4 needs matchup outcomes from people who
were trying to win. T-7.5 needs recorded telemetry of human play — the 33 files currently on
disk are AI-vs-AI or a parked bot, so tuning the AI on them would mean tuning it against a
stationary dummy while claiming it was shaped by players. T-7.10 needs the five things people
actually disliked, ranked, rather than the five things the developer already suspects. The
session below is built to produce those three things specifically.

---

## Before the tester arrives

- [ ] `node game/data/validate.js` — data consistent
- [ ] `node game/data/audio-check.js` and `audio-wiring-check.mjs` — audio sane
- [ ] `node game/data/camera-feel-check.mjs` and `difficulty-check.mjs` — feel and tiers sane
- [ ] Push the current scripts and `data/bundle.json` into the engine project (see README)
- [ ] **Set difficulty to `normal`** in `/data/session.json` unless the run is specifically about tiers
- [ ] Clear `/telemetry/` or note the current file count, so this session's recordings are identifiable
- [ ] Confirm `[Telemetry] armed` appears in the console on scene load — if it does not, the session produces no data and there is no point running it
- [ ] Gamepad charged, if testing versus

Record for each tester: **an id (not a name), whether they play games regularly, and whether
they have seen this build before.** Nothing else — you do not need personal data to fix a game.

---

## Script

Read the bracketed parts aloud. Do not explain anything that is not in the script; the point
is to find out what the game fails to communicate on its own.

### 1. Cold open (3 min) — *no instructions at all*

> "This is a robot fighting game. I am going to ask you to play it. I will not explain
> anything yet — I want to see what the game tells you on its own. Please think out loud."

Put them on the main menu. Say nothing else. Write down, verbatim:

- What they click first, and what they expected it to do
- The first moment they look confused
- **How long before they work out the controls** — stopwatch this, it is the number that matters
- Anything they say out loud that starts with "how do I" or "why did"

Do not help. If they are stuck for more than 90 seconds, note *what* they were stuck on,
then move to step 2 — that stuck point is a finding, not a failure of the session.

### 2. Guided practice (4 min)

Now tell them: `W`/`S` drive, `A`/`D` turn, `E` toggles the weapon, `R` self-rights,
`Esc` pauses. Send them to the Demo Center against one opponent.

- Do they use `E` unprompted after being told once? Do they realise it is a toggle, or do they hold it?
- Do they ever discover self-righting on their own, or do they sit flipped?
- Ask: **"what do you think your weapon does?"** — a wrong answer here is a readability bug

### 3. Three real matches (10 min) — *this is the data*

Three matches in the arena. **Change the bot between each** so matchups vary. For each match
record, on the sheet below: the two bots, who won, how, and roughly how long it took.

> "Play these to win. Tell me if anything feels wrong, even if you cannot say why."

Watch for and note the timestamp of:

- A match decided by a pit rather than by fighting
- A moment where they clearly did not know why they took damage
- A moment where they lost a part and did not notice
- Any point where the camera lost them
- Anything they do repeatedly that the game never acknowledges

### 4. Difficulty (3 min)

One match on `easy`, one on `hard`, without telling them which is which.

> "Two more matches. Tell me afterwards which one was harder, and how you could tell."

The answer to *how they could tell* is the real result. "It reacted quicker" or "it kept
missing" means the tiers are working. **"It felt like it was cheating" is a failure** — the
tiers deliberately grant no stat advantage (see `difficulty-check.mjs`), so if it reads as
cheating, that is a perception bug worth fixing.

### 5. Debrief (5 min) — *hand over the form below*

Let them fill it in themselves. Leave the room if you can; people soften criticism when the
person who made the thing is watching them write it.

---

## Match record sheet

One row per match. This is what T-7.4 is waiting for.

| # | Player bot | Opponent bot | Difficulty | Winner | How it ended | Length | Felt fair? |
|---|---|---|---|---|---|---|---|
| 1 | | | normal | | | | |
| 2 | | | normal | | | | |
| 3 | | | normal | | | | |
| 4 | | | easy | | | | |
| 5 | | | hard | | | | |

*How it ended:* knockout / immobilised / pitted / time expired / other.

---

## Feedback form

> Please be blunt. "It was fine" is the least useful thing you can write, and nothing here
> is going to hurt anyone's feelings.

**1. In one sentence, what is this game about?**

**2. What was the single most annoying thing?**

**3. Was there a moment you felt genuinely good? What happened?**

**4. Did you ever take damage and not know why?**   Yes / No — if yes, what happened?

**5. Did you ever lose a part without noticing?**   Yes / No

**6. Could you tell what your weapon was doing?**   Always / Mostly / Rarely / Never

**7. Could you tell how badly damaged you were?**   Always / Mostly / Rarely / Never

**8. Rate these 1–5** (1 = bad, 5 = good)

| | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| Driving feels good | | | | | |
| Hits feel powerful | | | | | |
| I could see what was happening | | | | | |
| Sound adds to it | | | | | |
| The opponent was fun to fight | | | | | |
| I understood why I won or lost | | | | | |

**9. Which match was hardest, and how could you tell?**

**10. Did the opponent ever feel like it was cheating?**   Yes / No — when?

**11. If you could change one thing, what?**

**12. Would you play it again?**   Yes / No / Maybe

---

## After every session

- [ ] Copy the new files out of `/telemetry/` and label them with the tester id — **this is
      the only human play data that will ever exist**, and it is what T-7.5 needs
- [ ] Add the match rows to the running matchup table (T-7.4)
- [ ] Put every problem into `docs/BUGS.md` with a severity, even the vague ones — "the camera
      felt weird once" is a real report and belongs there as `needs-repro`, not nowhere
- [ ] Note anything a tester said that contradicts a design assumption; those are worth more
      than the bugs

## After all five

- [ ] Rank the complaints by **how many testers hit them**, not by how bad they sounded. One
      person's strong opinion is one person's strong opinion; three people hitting the same
      wall is a design problem. That ranking is T-7.10's top-5.
- [ ] Re-run the AI weight aggregation over the new telemetry (`game/data/ai/aggregate.js`) —
      T-7.5
