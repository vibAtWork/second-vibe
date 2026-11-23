# Short Fuse

A browser-based, online grid bomber for up to 4 players, with bots for empty seats. Drop
bombs, blast crates for power-ups, kick and throw bombs, and be the last one standing.
You get 3 lives per heat, and a match is best of 3 heats.

It's an original game in the classic grid-bomber genre. Its **rules and numbers were
reverse-engineered from the Flash game the owner supplied**:

* the 24 fps timing and the speed table
* the exact grid movement with corner sliding
* bomb fuse, flames and chain reactions
* kicking and throwing, wrap-around included
* hit boxes, lives and invincibility
* the power-up pool and drop odds
* teleporters, fire lines, the sudden-death spiral and the scoring

The method, tools and every recovered number are in [RE-NOTES.md](RE-NOTES.md). The name,
art, sound, music and arena layouts are original.

*This is the second implementation: rewritten from scratch for robustness (see "Testing").*

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

Open the page, press **Join**, and send the invite link. Everyone with the same link plays
in the same room. Choosing an arena or a number of bots in the header makes a new room
with those settings in its link.

## Playing

| | Move | Bomb |
|---|---|---|
| Player 1 | arrow keys | Space (or Enter / ;) |
| Player 2 (same keyboard, "+ Local player") | W A S D | F (or \\) |

**Moving:** movement snaps to the grid. Push against a corner and you slide round it.

**Power-ups** are bright glowing tiles left by burnt crates:

| Tile | Effect |
|---|---|
| orange flame | longer flames |
| yellow bolt | faster |
| grey **+1** | one more bomb |
| green boot | walk into a bomb to kick it |
| purple glove | press the bomb key on a bomb to pick it up, let go to throw it |

**Arenas:**

* **Classic:** crates everywhere except the start corners.
* **Fire lines:** a flame touching the track sets all of it alight for a second.
* **Teleporters:** two pairs of pads.
* **Madness:** no crates. Everyone starts fast, with 3 bombs, long flames, kick and glove.

**Rounds and scoring:**

* In the last 40 seconds walls spiral in, and a wall landing on you costs a life.
* A heat ends when one player is left, when every human is out, or at 0:00.
* The heat winner gets seconds left × opponents × 250 points. Heat wins decide the match,
  and points break ties.

**Music and sound:** Short Fuse has its own chiptune soundtrack. The header has Music and
Sound switches, and your choice is remembered.

**Your own art or music:** put image and sound files with a `skin.json` in a folder and
point `SKIN_DIR` at it, for example
`docker run ... -v /path/to/skin:/app/skin:ro ghcr.io/vibatwork/short-fuse:latest`. The
format is at the top of `public/skin.js`. Anything the skin leaves out uses the built-in
art and sound. Skin files are not part of this repository.

## How it works

* `server.js` and `room.js` run one authoritative game per invite link at 24 ticks/s, the
  original's frame rate. An update goes out every tick, about 1–2 KB. `ws.js` is a minimal
  built-in WebSocket server.
* `public/shared/game.js` holds every rule, plus the browser's prediction and the bots.
* **Netcode:**
  * **Your movement:** your browser runs the server's own code for it, so your robot
    reacts instantly.
  * **Your bomb:** laying, picking up and kicking show at once.
  * **Vanishing bombs and crates:** your browser knows when each bomb and burning crate
    will go, so you can run through at exactly the right moment.
  * **Inputs:** every input frame is applied exactly once, in order. A late frame is
    waited for, never guessed. A backlog (a clock running a bit fast, a lag spike) is
    caught up two frames a tick, never dropped. So your screen and the server agree on
    where you are.
  * **Speed hacking:** you can't send frames faster than real time (+3% for clock drift).
  * **Other players** are drawn one update plus the measured jitter in the past.
* **Fairness:**
  * A flame hits everyone standing in it.
  * Start corners rotate each heat.
  * Players who join mid-heat wait for the next one.
  * Leaves are announced, and same-named players get a number.
* **Bots:** Short Fuse's own AI. Each tick they map when every cell will burn, chain
  reactions included. They flee when threatened, bomb crates and rivals when they can
  still escape, and hunt.

## Testing

```bash
npm test               # 26 tests: rules, netcode, real WebSocket, network simulations
npm run e2e            # two browsers: keyboard, bombs seen by both, focus safety, local player, bots
npm run pvp -- 120     # two browsers through a 120 ms lag proxy: zero corrections, instant bombs, fair dodging, hits
npm run soak -- 150    # four self-playing browsers on 25-200 ms links for 150 s: errors, corrections, server state
npm run playtest       # bots and button-mashers in 16 scenarios, invariants checked every tick
```

**What the tests showed:**

* **Ghost bombs (fixed):** the playtest's invariants found the bug behind bombs that
  "appeared" and broke the game. A landing or stopping bomb claimed its cell a tick late,
  so a second bomb could share it. Bombs now claim their cell at once.
* **Power-up look (changed):** the old extra-bomb power-up looked just like a bomb, so
  power-ups are now unmistakable.
* **Measured results:**
  * Your position needs no corrections at 50–400 ms round trip, even when always moving
    with a clock 1% fast.
  * Four self-playing browsers on 25–200 ms links saw 0–2 corrections each in 2.5 minutes
    of classic.
  * In madness, the remaining corrections come from other players' kicked and thrown
    bombs landing in your path.

## Limitations

* One board size (15 × 13, as in the original). The arena layouts are new, not the
  original's hand-made levels.
* Some hit boxes are simplified from the original's clip bounds (see RE-NOTES.md).
* Keyboard only.
* Other players' kicked or thrown bombs aren't predicted. When one lands in your path,
  your position is corrected (smoothly, unless it's a big jump).
