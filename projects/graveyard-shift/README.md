# Graveyard Shift

A browser-based, online co-op survival shooter for up to 4 players. Hold the graveyard
against endless waves of **shamblers** (melee) and **hexers** (they keep their distance and
throw fireballs). Score kills to unlock new weapons, chain kills for a multiplier, and revive
downed friends.

It's an original game in the top-down co-op survival-shooter genre, inspired by the
mechanics of the Flash game the owner supplied: its weapon line-up on keys 1–0 unlocked by
scoring, placeable barrels/walls/mines, kill multipliers and two players on one keyboard.
The supplied file's game code is obfuscated, so all numbers, art, sounds and maps here are
my own.

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

## Weapons (unlocked by score)

| Key | Weapon | Unlock | Notes |
|---|---|---|---|
| 1 | Pistol | start | unlimited ammo |
| 2 | SMG | 500 | fast, slight spread |
| 3 | Shotgun | 1,500 | 7 pellets, short range |
| 4 | Barrel | 3,000 | placed in front of you; blocks enemies; explodes when shot, chains with other barrels |
| 5 | Grenade | 5,000 | thrown, explodes after 1.2 s |
| 6 | Barricade | 7,500 | blocks the path; enemies have to smash through |
| 7 | Mine | 10,000 | explodes when an enemy steps on it |
| 8 | Rocket | 14,000 | explodes on impact |
| 9 | Charge | 19,000 | place up to 3, press again to detonate them all |
| 0 | Railgun | 25,000 | pierces every enemy in a line |

Kills give 10 (shambler) or 30 (hexer) points × your multiplier. Every kill within 2 s of the
previous one raises the multiplier, up to ×10. Enemies drop health packs and ammo crates.
Explosions hurt players too, at 30%. Each wave is bigger and a little faster. If everyone is
down, the graveyard is overrun and the game restarts from wave 1.

## How it works

* `server.js` plus `ws.js` (a minimal built-in WebSocket server) run one authoritative
  `Room` per invite link at 30 ticks/s.
* `public/shared/sim.js` holds the whole game. The browser uses its `movePlayer()` (plain
  arithmetic) to predict your own movement, so controls react instantly and match the
  server exactly. Everything else is drawn 80 ms in the past and blended between server
  updates.
* **Cheating:** the server runs the game and clients only send buttons. Every message is
  validated, one input is applied per tick (sending faster gains nothing), connections are
  rate-limited, and a player whose inputs stop arriving goes idle after 1.5 s. There is no
  behavioural bot detection (unlike Ricochet Arena): it's a co-op game, so a bot would only
  be helping.

## Tests

```bash
npm test          # 17 tests: maps, movement, every weapon, enemies, waves, revive, scoring, room, server
npm run e2e       # two headless Chromium players against a real server (needs Playwright)
```

## Limitations

* One arena size (30 × 20 tiles), procedurally generated per game; no camera scrolling.
* No deathmatch mode and no weapon upgrades ("double ammo" and the like) yet.
* Enemies path toward the nearest player with a grid flow field; they don't plan around
  barricades, they smash through them.
