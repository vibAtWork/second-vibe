# Graveyard Shift

A browser-based, online co-op survival shooter for up to 4 players. Hold the graveyard
through ever harder levels of **shamblers** (melee) and **hexers** (they keep their distance
and throw fireballs). Every kill feeds a shared multiplier that unlocks weapons and upgrades.
There's also a deathmatch mode.

It's an original game in the top-down co-op survival-shooter genre. Its **rules and numbers
were reverse-engineered from the Flash game the owner supplied** (an obfuscated AS2 SWF;
method, tools and every recovered table are in [RE-NOTES.md](RE-NOTES.md)). That covers the
50 fps timing, weapon stats, the upgrade effects, the 58-step multiplier unlock table, the
multiplier drain formula, the per-level spawn formulas, difficulty start points, creature
stats, health regeneration and the deathmatch rules. The name, art, sounds and generated
maps are original.

## Run it

Needs Node 26 (current LTS) and nothing else; there are **no npm dependencies**.

```bash
cd projects/graveyard-shift
npm start            # http://localhost:8080  (PORT=xxxx to change)
```

Or with Docker (published by `.github/workflows/docker-graveyard-shift.yml`, amd64 and arm64):

```bash
docker run -d --name graveyard-shift -p 8080:8080 --restart unless-stopped ghcr.io/vibatwork/graveyard-shift:latest
```

Open the page, press **Join**, and send the invite link (**Copy invite link**). Everyone with
the same link plays in the same room.

## Controls

| | Move | Shoot / place | Switch weapon |
|---|---|---|---|
| Player 1 | arrow keys | Space | 1–0, or Z / X |
| Player 2 (same keyboard, "+ Local player") | W A S D | F | R / T |

You shoot the way you're walking. Stand next to a downed teammate for 2 seconds to revive them.

## Modes

* **Co-op survival** (default): levels of shamblers, with hexers from level 5. Every kill adds
  +1 to the **team multiplier**, which drains one step at a time if you stop killing (3 s at
  ×1, a fraction of a second at ×50+). Reaching a multiplier unlocks the next step of a
  58-step table for the whole team: new weapons at ×5, 10, 15, 20, 30, 40, 50, 55 and 70, and
  "+" upgrades in between (Fast/Rapid Fire, Double/Quad Damage and Ammo, Long Shot, Wide
  Shot, Big Bang, Cluster Explode, Infinite Range). Points = creature score × multiplier.
  Revive downed friends; if everyone's down, the game restarts.
* **Difficulty** (co-op): Beginner (level 1, ×1), Intermediate (level 10, ×10), Expert
  (level 20, ×30), Nightmare (level 35, ×50).
* **Deathmatch**: multiplier 200, so everything is unlocked. Players hurt each other (mines
  too), frags count, you respawn after 3 s with a short shield, first to 10 frags wins.
  Zombies still roam.

Pick the mode and difficulty in the header. That creates a room with them in its invite
link, so friends who open the link join that mode.

## Weapons

| Key | Weapon | Unlocked at | Notes |
|---|---|---|---|
| 1 | Pistol | start | semi-automatic until Fast Fire |
| 2 | SMG | ×5 | automatic |
| 3 | Shotgun | ×10 | spread grows with Wide/Wider Shot |
| 4 | Barrel | ×15 | placed in front of you; explodes when shot, chains |
| 5 | Grenade | ×20 | hold to wind up, **release to throw** |
| 6 | Barricade | ×30 | 1000 hp wall; enemies smash through |
| 7 | Mine | ×40 | triggered by enemies (and rivals in deathmatch) |
| 8 | Rocket | ×50 | explodes on impact |
| 9 | Charge | ×55 | place up to 3, press again to detonate |
| 0 | Railgun | ×70 | pierces everything in a line |

Health regenerates slowly (a full refill in 30 s), and health and ammo crates drop from kills.

## How it works

* `server.js` plus `ws.js` (a minimal built-in WebSocket server) run one authoritative
  `Room` per invite link at 50 ticks/s, the original's frame rate, and send 25 updates/s.
* `public/shared/sim.js` holds the whole game. The browser uses its `movePlayer()` (plain
  arithmetic) to predict your own movement, so controls react instantly and match the
  server exactly. Everything else is blended between server updates, drawn one update
  interval plus the recently measured jitter in the past (about 50-60 ms on a steady
  connection, more on a jittery one).
* **Latency:** TCP_NODELAY is on, so small messages aren't held back. The server's
  per-player input queue is only a jitter buffer: if it never runs low for a second, one
  frame is dropped (keeping any weapon switch or shot in it), so clock drift or a lag spike
  can't leave you with extra input delay. Each snapshot is serialized once per tick, not
  once per player.
* **Cheating:** the server runs the game and clients only send buttons. Every message is
  validated, one input is applied per tick (sending faster gains nothing), connections are
  rate-limited, and a player whose inputs stop arriving goes idle after 1.5 s. There is no
  behavioural bot detection (unlike Ricochet Arena): it's a co-op game, so a bot would only
  be helping.

## Tests

```bash
npm test          # 25 tests: recovered tables and formulas, every weapon, upgrades, difficulties, deathmatch, room, server
npm run e2e       # headless Chromium players: co-op (prediction, building, switching) and a deathmatch frag
npm run playtest  # bots play 6 scenarios (solo to 4p nightmare, deathmatch) for 30,000 ticks each, checking invariants every tick
```

The playtest prints per-scenario stats: levels reached, kills, downs, frags, snapshot size and
time per tick (about 0.015 ms on average, under 5 ms at worst, against a 20 ms budget).

## Limitations

* One arena size (30 × 20 tiles), generated per game, no camera scrolling. The original's
  hand-made rooms are not reproduced.
* A few timings weren't isolated in the original's code and are my choices: zombie and
  hexer attack cadence, explosion radius, cluster bomblets and shotgun pellet counts.
  See RE-NOTES.md.
* Bonus weapons present in the original's code but not in its unlock table (Devastator,
  Smart Bomb, homing missiles) aren't included.
