# Audio coverage — what plays, and what is still missing

Companion to T-6.16. Updated 2026-08-25, after the sourced recordings were wired in.

**11 of 13 clips play a real recording.** `crowd` and `sting` are synthesis-only — there is no
crowd recording in the set, and `sting` is a UI sweep with no sourced equivalent.

## Synthesis is still underneath every clip

Every clip has a full synthesis spec and is synthesised at load. A clip with a `file` then
fetches that recording and swaps it in once it decodes.

That is not belt-and-braces for its own sake — it is what makes the two environments both work:

| | Sourced clips | Result |
|---|---|---|
| Deployed build (`:4300`) | `11/11 loaded` | plays the recordings |
| Editor (`:4174`) | `0/11 — the rest stay synthesised` | plays the synthesised versions |

The editor has no `./audio/` path to serve from, so every fetch fails there — and the game is
fully audible anyway. A 404, a decode failure, a format the browser refuses or no network at
all degrades to a real sound rather than to silence, and the game makes noise on the first
frame instead of after a network round trip.

It also means the mapping can be changed by editing one JSON field, with a guaranteed floor.

## The mapping

`fileBase` is `./audio/`; files live in `Audio/` in the repo and are copied into the build by
`tools/rebuild-game.mjs`, which warns if a clip names a file that is not there.

| Clip | Recording | Role |
|---|---|---|
| `motor` | `freesound_community-large-fan-38268` | drivetrain hum, pitched by road speed |
| `spin` | `freesound_community-power-drill-90294` | blade, pitched by real rpm |
| `impact` | `spinopel-impact-on-metal` | ordinary contact |
| `impactHeavy` | `universfield-punch-impact-hit` | the top of the force curve |
| `hammerHit` | `universfield-hammer-steel-impact` | a **swing** weapon connecting |
| `swing` | `floraphonic-swing-whoosh-12` | a swing weapon that **misses** |
| `spark` | `olenchic-electric-155027` | metal-on-metal grind |
| `detach` | `u_mgq59j5ayf-sound-effect-car-crash` | a part torn off |
| `partBreak` | `freesound_community-poof-80161` | a part reaching `destroyed` |
| `click` | `litupsubway-ui-close-sfx` | UI confirm |
| `ko` | `freesound_community-electro-02` | knockout |
| `crowd` | *(synthesised)* | low-passed noise bed |
| `sting` | *(synthesised)* | rising UI sweep |

**Not yet assigned:** `alex-morgan-car-car-music-545487.mp3` (599 KB, music — there is no music
system; it would want its own bus and a menu/match distinction) and
`magiaz-smoke-454927.mp3` (smoke — closest fit would be a `damaged` part, which is gap #1
below). `daviddumaisaudio-steampunk-weapon-single-shot` is unused because `hammerHit` covers
the same moment with a better match.

---

## Closed since this document was first written

- **Weapon swing.** `battlebots.weaponSwing` was the only event in the entire game with **no
  listener at all**, so a weapon that missed was silent and you could not hear the opponent
  commit. Now fires `swing`.
- **Impact variety.** One clank pitched by force told you *that* something connected; three
  clips tell you *what* did. A swing weapon is identified by having emitted `weaponSwing`,
  which costs nothing since the damage model does not carry the archetype.
- **Part destroyed.** `battlebots.partState` now fires `partBreak`, the audio half of what
  `VfxDirector` already shows.

## Still missing

The game emits these and nothing plays. Each is a clip spec plus a `case` in `AudioDirector`.

| # | Missing sound | Event that already exists | Why it matters |
|---|---|---|---|
| 1 | **Part damaged** (not destroyed) | `battlebots.partState` `damaged` | The destroyed case is covered; crossing into `damaged` is a mechanical change (weaker mount, slower motor) with no sound. `magiaz-smoke` would fit. |
| 2 | **Self-right** | `BotDrive` acts on a `selfRight` intent | A flipped bot heaving itself over is one of the most physical moments in a match, and it is silent. |
| 3 | **Countdown + match start** | `matchState` `countdown` → `fighting` | The crowd bed starts on `fighting`; the 3-2-1 has no beat and the start has no signal. |
| 4 | **Match end / verdict** | `matchResult` | A knockout gets `ko`; a win on damage-at-time-expiry gets nothing. |
| 5 | **Pit fall** | `knockout` with `reason: "pitted"` | Identical to any other knockout today. A fall is a different event and reads as one. |
| 6 | **Debris settling / culled** | `debrisCulled` | Consumed only to forget cached state. Parts vanish silently. |
| 7 | **UI navigation** | `botSelected` fires only on *confirm* | Moving through the roster, opening Options and going Back are all silent. |
| 8 | **Music** | — | No music system exists. The one music file in the set is unassigned. |

## Still true of the wording in T-6.16

- **"Announcer stings" (plural)** — there are two sweeps and no voice anywhere. A real announcer
  needs recorded speech, which is not in the set. A wording gap rather than a bug, but it should
  be called what it is.

## Priority

1. **Part damaged (#1)** — pairs with VFX that already exists, and a file is already sitting
   unassigned for it.
2. **Countdown, match end, pit fall (#3, #4, #5)** — match structure you can hear.
3. **Self-right (#2)** and **UI navigation (#7)** — feel.
4. **Music (#8)** — the largest single asset, and the only one needing new plumbing.
