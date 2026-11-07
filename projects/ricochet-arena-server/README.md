# Ricochet Arena (approach 1: authoritative server)

A browser-based, online multiplayer maze tank game with ricocheting bullets.
Movement, controls and timing follow the Flash maze-tank game the owner
supplied; the code, art, sounds and maze generator are new.

**Netcode:** a small Node server runs the one authoritative simulation for each
room at 25 ticks/s. Each browser predicts its own tank with the *same*
simulation code (`public/shared/sim.js`), so your controls react instantly.
Other tanks and bullets are drawn 90 ms in the past and blended smoothly between
server snapshots.

## Run it

```bash
cd projects/ricochet-arena-server
npm install
npm start            # http://localhost:8080  (PORT=xxxx to change)
```

Or with Docker (image published by `.github/workflows/docker-ricochet-arena.yml`, for amd64 and arm64):

```bash
docker run -d --name ricochet-arena -p 8080:8080 --restart unless-stopped ghcr.io/vibatwork/ricochet-arena:latest
```

To build it yourself: `docker build -t ricochet-arena projects/ricochet-arena-server`.

Open the page and press **Join**. The URL gets a `?room=` code: send it to
friends (**Copy invite link**) and everyone in that room plays together. To play
over the internet, run it on any host that can run Node (a VPS, Fly.io, Render,
Railway…), or expose your machine with a tunnel such as `cloudflared tunnel --url http://localhost:8080`.
Up to 8 players per room. One browser can add up to 3 local players.

## Controls (same as the original)

| Player | Forward | Reverse | Turn left / right | Fire |
|---|---|---|---|---|
| Player 1 (Join) | ↑ | ↓ | ← / → | M |
| Player 2 (+ Local player) | E | D | S / F | Q |
| Mouse player | tank turns to face the pointer and drives toward it (stops when within 60 px) | | | click |

## Mechanics carried over from the original

Numbers were read from the supplied SWF's game logic:

* 25 frames/s. Maze is 4–12 × 4–10 cells. The cell size `S` is chosen so the maze fills
  692 × 400 px, and walls are `S/8` thick.
* Forward speed `4·S/50` px/frame, reverse `2.5·S/50`, turning 10°/frame, applied in
  5 sub-steps so driving while turning traces an arc.
* Collision: try the full move and turn. If any point on the tank's edge would be inside a wall,
  undo it and retry the turn and the move separately in each sub-step (this is
  what makes tanks slide along walls). After an unobstructed turn, the heading snaps to a
  multiple of 10°.
* Bullets: speed `4.5·S/50` px/frame in 7 sub-steps, bouncing by probing whether
  flipping x or flipping y gets them out of the wall. They last 250 frames (10 s),
  appear `4.5/16·S` in front of the tank, and can destroy their own tank.
  **One cannon ball per tank at a time** (the original's default setting), and fire needs a release between shots.
* Tanks drive through each other (only walls block them, as in the original).
* Rounds: 50-frame freeze at the start. Once only one tank (or none) is left,
  play continues for 125 frames (bullets can still kill the survivor), then the
  survivor scores and a new maze is generated.

## Power-up crates

Crates drop on the original's timer: the first after `(350 + rand·200)·0.1` frames, then
every `(350 + rand·200 + 2000/cells)·0.1` frames, on a free random cell. Drive over one
while holding the normal cannon to pick it up. You can't pick up a second weapon while
holding one. The four weapons are the original's default crate set:

| Weapon | How it works |
|---|---|
| **Laser** | While held, a flickering sight line shows the bouncing path (200 px at scale 50, stops at a tank). Fire to shoot a beam that travels 70 px per frame for 8 frames, ricocheting off walls. Its first 7 px are harmless. Your tank can't move while the beam is live. |
| **Frag bomb** | Fire launches a bouncing bomb (same speed as a cannon ball). Press fire again to burst it into 40 shards flying in random directions at 4–8.5 px/frame. Shards fly straight through walls (they never bounce) and fade after 20 frames, with a smoke cloud and screen shake on the burst. The bomb also bursts when its 10 s run out, when it hits a tank (killing it), or if its owner dies. |
| **Gatling gun** | Hold fire: the barrels spin up for 10 frames, then fire every 3rd frame (20 rounds, ±5.5° spread, 5.5 px/frame, 5 s life, harmless for their first 2 frames). Release to stop; it spins down and you get your cannon back. |
| **Homing missile** | Flies straight and bounces for 50 frames, then locks onto the nearest tank **by path through the maze** (which can be you). Its smoke trail is grey until it locks on, then about half the puffs take the hunted tank's colour, so everyone can see who it's after. It steers toward the next cell on the shortest path. Lasts 10 s. |

After a weapon is used up, the tank goes back to the cannon.

## Cheating

The server runs the game and every client only sends button presses, so a modified client
can't move faster, teleport, fire extra shots, survive hits or change scores. On top of that,
`public/shared/room.js` (the same room code the P2P host runs):

* validates and normalises every message and drops anything malformed
* locks each seat to the control scheme it joined with: a keyboard seat can't send mouse aim
  to snap-turn, and a mouse seat can't send keys
* consumes exactly one input frame per tick per seat, with a bounded queue, so sending inputs
  faster or in bursts gains nothing
* rate-limits each connection and kicks floods; strips control and bidi characters from names
  so they can't be used to spoof other players
* there's no hidden information to leak: everything in a snapshot is visible on screen anyway

What no game can stop: bots or aim assistance running on a player's own computer.

## Code layout

| File | Role |
|---|---|
| `public/shared/sim.js` | the whole game: maze, movement, weapons, crates, rounds; deterministic and serialisable |
| `public/shared/dmath.js` | bit-exact trig (identical results on every browser engine) |
| `public/shared/protocol.js` | snapshot wire format, defined once by named field lists |
| `public/shared/room.js` | authoritative room + input validation (server **and** P2P host) |
| `public/shared/verify.js` | auditor a P2P guest uses to catch a cheating host |
| `public/game-client.js` | input, prediction, interpolation, events; transport-agnostic |
| `public/render.js`, `public/audio.js` | drawing/effects and synthesized sounds |
| `public/net-ws.js` | WebSocket transport (the P2P project adds `net-p2p.js`) |
| `server.js` | HTTP + WebSocket plumbing around `room.js` |

## Tests

```bash
npm test        # simulation, weapons, server, anti-cheat (36 tests)
npm run e2e     # two headless Chromium players against a real server
```

The tests cover movement speeds, turning, wall collision, bounce rules,
self-hits, the one-ball limit, crate timing and pickup, each weapon's behaviour, round scoring, and maze connectivity. They also
check that two real WebSocket clients see each other, that rooms are isolated,
and that **the server's tank position matches the client's prediction exactly**
after 10 frames of input.

## Limitations

* Only the original's four default crate weapons are implemented. The original's code also had
  rarely-enabled extras (death ray, remote-controlled missile, electric bullet) that are not included.
* Tank size is an approximation (0.32 × 0.40 cells), and bullet hits use the
  tank body rectangle. The original tested hits against the drawn sprite shape.
* Your own tank is shown at "now" while others are ~90 ms + ping behind
  (normal for client prediction). On very high-latency links, an enemy bullet can appear to
  pass close and still hit, or the reverse.
* The server is authoritative but does no rate limiting beyond bounded input queues.
  It's meant for friends, not a public matchmaking service.
* No AI opponents.
