# Short Fuse

A browser-based, online grid bomber for up to 4 players, with bots to fill empty seats.
Drop bombs, blast crates for power-ups, kick and throw bombs, and be the last one
standing. You get 3 lives per heat, and a match is best of 3 heats.

It's an original game in the classic grid-bomber genre. Its **rules and numbers were
reverse-engineered from the Flash game the owner supplied**. That covers the 24 fps
timing, the speed table, the exact grid movement with corner assist, the bomb fuse and
flames, chain reactions, kicking and throwing (including wrap-around), hit boxes, lives
and invincibility, the power-up pool and drop odds, teleporters, fire lines, the
sudden-death spiral and the scoring. The method, tools and every recovered number are in
[RE-NOTES.md](RE-NOTES.md). The name, art, sounds and arena layouts are original.

## Run it

Needs Node 26 (current LTS) and nothing else; there are **no npm dependencies**.

```bash
cd projects/short-fuse
npm start            # http://localhost:8080  (PORT=xxxx to change)
```

Or with Docker (published by `.github/workflows/docker-short-fuse.yml`, amd64 and arm64):

```bash
docker run -d --name short-fuse -p 8080:8080 --restart unless-stopped ghcr.io/vibatwork/short-fuse:latest
```

Open the page, press **Join**, and send the invite link (**Copy invite link**). Everyone
with the same link plays in the same room. Pick the arena and the number of bots in the
header; that makes a new room with them in its invite link.

## Controls

| | Move | Bomb |
|---|---|---|
| Player 1 | arrow keys | Space (or Enter / ;) |
| Player 2 (same keyboard, "+ Local player") | W A S D | F (or \\) |

* Movement snaps to the grid. Push against a corner and you slide round it.
* **Boots** (green pickup): walk into a bomb to kick it.
* **Glove** (purple pickup): press the bomb key on a bomb to pick it up, and release to
  throw it 3 cells. Throws wrap round the edges.
* Other pickups: flame (+1 range), lightning (+1 speed), bomb (+1 bomb).

## Arenas

* **Classic:** crates everywhere except the start corners.
* **Fire lines:** a flame touching the track sets the whole track alight for a second.
* **Teleporters:** two pairs of pads. Stand on a pad too long and it sends you back.
* **Madness:** no crates. Everyone starts fast, with 3 bombs, long flames, kick and throw.

In the last 40 seconds of a heat, walls spiral in from the edges. A wall landing on you
costs a life. The heat winner gets seconds left × opponents × 250 points; heat wins
decide the match, and points break ties.

## How it works

* `server.js` plus `ws.js` (a minimal built-in WebSocket server) run one authoritative
  `Room` per invite link at 24 ticks/s, the original's frame rate. An update goes out
  every tick, about 1–2 KB (25–45 KB/s per player).
* `public/shared/sim.js` holds the whole game, in the original's units (30 per cell).
  The browser runs the same `movePlayer()` to predict your own movement. Controls react
  instantly and match the server exactly, smoothed between ticks.
* Others are drawn one update plus the measured jitter in the past. The server's input
  queue trims itself back to jitter size, and TCP_NODELAY is on.
* **Cheating:** the server runs the game and clients only send buttons.
  * Every message is validated.
  * One input is applied per tick, so sending faster gains nothing.
  * Connections are rate-limited.
  * A player whose inputs stop arriving goes idle after 1.5 s.
* **Bots** are Short Fuse's own AI. Each tick they map when every cell will be on fire
  (chain reactions included). They flee when threatened, bomb crates and rivals when
  they can still escape, and hunt. Against an idle player they take 15–45 s depending on
  the arena.

## Tests

```bash
npm test          # 24 tests: recovered tables, arena generator, movement + corner assist, bombs, chains, kick, throw, hits, pickups, teleporters, fire lines, sudden death, heats, bots, room, network prediction
npm run e2e       # headless Chromium: two players, prediction, bombs seen by both, local second player, bots
npm run playtest  # bots and button-mashers in 16 scenarios with invariants checked every tick
```

## Limitations

* One board size (15 × 13, as in the original). The arena layouts are new, not the
  original's hand-made levels.
* Some hit boxes are simplified to the union of each clip's frames (see RE-NOTES.md).
  The flame end pieces use the arm size.
* No touch controls yet; it needs a keyboard.
* A few original bugs were fixed rather than reproduced. They're listed in RE-NOTES.md.
