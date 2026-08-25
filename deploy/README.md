# Battle Bots — how to run it

A physics-based robot combat game. Pick a bot, fight it in an arena with corner pits and floor
spinners, and try to tear the other one apart.

You need **Docker** and nothing else. No Node, no game engine, no source checkout.

---

## If you were sent a `.tar` file

```sh
docker load -i battle-bots-image.tar
docker run --rm -p 4300:8080 battle-bots:latest
```

Then open **<http://localhost:4300>**.

That's it. `--rm` means the container deletes itself when you stop it (Ctrl-C).

## If you have the repo

```sh
docker compose -f deploy/docker-compose.yml up -d
```

Open <http://localhost:4300>. Stop it with `docker compose -f deploy/docker-compose.yml down`.

### A different port

The game does not care what port it is on:

```sh
docker run --rm -p 8080:8080 battle-bots:latest      # then localhost:8080
PORT=8080 docker compose -f deploy/docker-compose.yml up -d
```

---

## Two things that will look like bugs and are not

**Keep the tab in the foreground.** Chrome and Firefox suspend animation in background tabs, so
a backgrounded game does not slow down — it *stops*. Click back into it and it resumes.

**Click once before expecting sound.** Browsers refuse to start audio until you have interacted
with the page. The main menu has buttons you have to click anyway, so this sorts itself out, but
if you are staring at a silent arena wondering why, that is why.

---

## Controls

**Player 1**

| | |
|---|---|
| `W` / `S` | drive forward / back |
| `A` / `D` | turn |
| `E` | weapon on/off |
| `R` | self-right (if you get flipped) |
| `Esc` | pause |
| `F3` | AI debug overlay |

**Player 2** — versus mode, same keyboard, numpad

| | |
|---|---|
| numpad `8` / `5` | drive forward / back |
| numpad `4` / `6` | turn |
| numpad `9` | weapon on/off |
| numpad `7` | self-right |

The weapon is a **toggle**, not a hold. Press once to bring it up, press again to drop it. A
spinner takes a few seconds to reach full speed, and it does more damage the faster it is going.

The numpad bindings use physical key positions, so they work whether or not NumLock is on.

---

## How to play

1. **DESTROY** from the main menu → pick a bot → **FIGHT** for a timed match.
   **TEST** puts you in the practice arena instead, with no clock.
2. Bots are made of parts, and every part is real: four wheels, a weapon, an armour plate, a
   motor. Each has its own health and its own mount.
3. Hit something hard enough and the part comes off and becomes debris. Lose enough wheels and
   you are immobilised, and immobilised means you lose.
4. Damage is directional — the front plate only protects the front.
5. The corner pits are instant death. So is the other bot's spinner, given time.

A match ends on knockout, on immobilisation, on a pit, or on damage dealt when the clock runs
out.

### The bots

Nine of them across three weight classes. The weapon is the interesting part:

- **Horizontal bar spinner** — everything on one enormous hit. Long spin-up.
- **Vertical drum** — steadier, less spectacular, harder to argue with.
- **Axe** — a burst weapon on a cooldown. Hits hard when it connects.
- **Flipper** — tries to put you on your back, or in a pit.
- **Passive wedge** — no moving parts at all. Wins on geometry, by getting underneath you.

Heavier bots hit harder and turn slower. That trade is the whole game.

---

## Known limitations

Worth stating up front so they are not mistaken for something broken:

- **The art is deliberate.** Untextured blocks are the finished look, not placeholder geometry.
- **No playtesting has happened yet.** Balance is tuned by measurement rather than by play, so
  if something feels wrong, it probably is — that feedback is genuinely wanted.
- **Two-player is same-keyboard only.** There is no gamepad support: the engine's input layer
  has no gamepad channel at all.
- **Audio is a mix of recordings and synthesised sound**, and some loops may tick on repeat.

## If something goes wrong

```sh
docker logs battle-bots          # nginx access/error log
docker ps --filter name=battle-bots
```

The game itself logs to the **browser console** (F12), which is the more useful one. Every
subsystem announces itself on load — `[Match]`, `[Damage]`, `[Audio]`, `[AI]`, `[Hud]` — so if
something did not start, its line is missing.
