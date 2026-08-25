# Audio coverage — what exists, and what is missing

Companion to T-6.16. Written 2026-08-25, after WebAudio output landed.

## First: there are no audio *files*, by design

Nothing in this game loads an audio file, and nothing is missing because it was never
sourced. All nine sounds are **synthesised at load** from the numbers in
`game/data/audio.json` — waveform kind, frequency, decay, noise mix, gain, bus — and turned
into PCM by the synth block in `AudioDirector.ts`. The build ships **zero audio assets** and
231 KB of samples generated at runtime.

That was a deliberate match for the greybox art (§4.4): untextured visuals, untextured
waveforms, one intentional style rather than two kinds of placeholder. It also means every
sound is tunable by editing a JSON number, with no re-record and no re-import.

> **One loose end.** The repo root carries `Audio/` — seven sourced `.mp3` files from
> freesound (`electro-02`, `poof`, `magiaz-smoke`, `olenchic-electric`,
> `spinopel-impact-on-metal`, `universfield-hammer-steel-impact`, `u_ml52e3xzf7-metal-impact`).
> **Nothing references them.** They are LFS-tracked and shipped in the repo but not in the
> build, and they predate the synthesis decision. Keep them as reference or delete them —
> they are not part of the game.

So "which audio files are missing" is really two other questions, below.

---

## 1. Sounds the game already fires an event for, and has no clip

These are the real gaps: the game **already emits the event**, `AudioDirector` already
subscribes or trivially could, and there is nothing to play. Each is a few lines in
`audio.json` plus a case in the director.

| # | Missing sound | Event that already exists | Why it matters |
|---|---|---|---|
| 1 | **Weapon swing / whoosh** | `battlebots.weaponSwing` — **emitted and consumed by nobody** | An axe and a flipper are burst weapons whose whole read is the wind-up and the strike. Right now a swing that *misses* is completely silent, so you cannot hear the opponent commit. The one event in the game with no listener at all. |
| 2 | **Part damaged / destroyed** | `battlebots.partState` (`damaged`, `destroyed`) | `VfxDirector` puts smoke on a damaged part and fire on a dead motor; audio does nothing. Losing a motor is a mechanical turning point with no sound of its own. |
| 3 | **Self-right** | `UtilityAi` publishes a `selfRight` intent; `BotDrive` acts on it | A flipped bot heaving itself over is one of the most physical moments in a match and is silent. |
| 4 | **Countdown + match start** | `battlebots.matchState` (`countdown` → `fighting`) | The crowd bed starts on `fighting`, but the 3-2-1 has no beat and the start has no signal. |
| 5 | **Match end / verdict** | `battlebots.matchResult` | Consumed only to push the crowd to full. A knockout gets the `ko` sting; a win on damage-at-time-expiry gets nothing. |
| 6 | **Debris settling / culled** | `battlebots.debrisCulled` | Consumed only to forget cached state. Parts vanish silently, which is the one place the greybox look needs the most help. |
| 7 | **Pit fall** | `battlebots.knockout` with `reason: "pitted"` | Currently identical to any other knockout. A fall is a different event and reads as one. |
| 8 | **UI navigation** | `battlebots.botSelected` fires only on *confirm* | `click` covers confirm. Moving through the roster, opening Options and going Back are all silent. |

## 2. Sounds T-6.16 named that the current set only half-covers

T-6.16 asked for "motor loops, weapon spin, metal impacts, sparks, part detachment, crowd,
announcer stings, UI clicks". Eight names, nine clips — but two are thinner than the wording:

- **"Announcer stings" (plural)** — there are two: `sting` (a rising sweep, used for UI) and
  `ko` (a falling one). Neither is an announcer, and there is no voice anywhere. A real
  announcer set is out of reach without sourced audio, so this is a wording gap rather than a
  bug — but it should be called what it is.
- **"Metal impacts" (plural)** — there is exactly one `impact` clank, pitched by force. Every
  collision in the game is that one sound at a different pitch. Distinct clips for
  blade-on-armour, blade-on-wheel and bot-on-wall would carry real information: right now you
  cannot hear *what* you hit.

## 3. What is fully covered

Worth stating so the gaps above are not mistaken for the whole picture.

| Clip | Driven by | Behaviour |
|---|---|---|
| `motor` | chassis road speed | loops per bot, pitch 0.72→1.45, spatialised, follows the bot |
| `spin` | `weaponState.spinFraction` | loops per weapon, pitch 0.55→1.6 so spin-up is audible before it is dangerous |
| `impact` | `weaponHit.force` | rate-limited one-shot, harder hits louder **and** lower |
| `spark` | `weaponHit.force` | pitched up with force, pairs with the impact |
| `detach` | `partDetached` | the loudest one-shot in the game, deliberately |
| `crowd` | hits + `damageReport` health | rises with contact, decays, floor lifts near a knockout |
| `ko` | `knockout` | descending sweep |
| `sting` | UI | rising sweep |
| `click` | `botSelected` | UI confirm |

---

## Priority, if this gets picked up

1. **Weapon swing (#1)** — the only emitted event in the entire game with no listener, and it
   silences half of what two of the four weapon archetypes do.
2. **Distinct impact clips (§2)** — the highest ratio of information gained to work.
3. **Part damaged/destroyed (#2)** — pairs with VFX that already exists.
4. **Countdown, match end, pit fall (#4, #5, #7)** — match structure you can hear.
5. Everything else is polish.

None of it needs a file. Each is a clip spec in `audio.json` and a `case` in `AudioDirector`,
and `audio-check.js` will validate the new clip's waveform the moment it is added.
