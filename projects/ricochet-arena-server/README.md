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

### Behavioural detection (bots, aim assistance, scripted clients)

The rules can't be broken, but they can be played inhumanly well. `public/shared/anticheat.js`
watches every seat on the server (and on a P2P host) without affecting the game:

| Signal | How it's measured | Action |
|---|---|---|
| Impossible ricochet aim | every cannon shot is replayed on the server: would it kill an enemy after bouncing? | 8+ shots, ≥60% ricochet kills **and** ≥75% fired instantly → **kick**; ≥80% ricochet kills over 16+ shots → **kick**; ≥50% → flag |
| Inhuman reactions | ticks from "a shot would kill now" to the trigger; ≤1 tick (40 ms) is instant | ≥80% instant over 8+ lethal shots → flag |
| Mouse aimbot | the pointer jumps >120 px in one tick and lands on an enemy's centre | 15 in 60 s → **kick**; 6 → flag |
| Scripted input | buttons change on more than half the ticks for 15 s straight | flag |
| Speed hack attempt | input frames keep arriving faster than real time (they're dropped anyway) | flag |
| Lag switch | inputs stop arriving | tank keeps its last input through hiccups; idles only after 1.5 s of silence |

**Everything is reported to the players, so the server can run unattended:**

* **Flags** (suspicions that aren't strong enough for an automatic kick) are shown to everyone
  in the room: the suspect gets a ⚠ on the scoreboard, and a panel **below the game** lists
  every flag with its reason. The flagged player sees it too. Anti-cheat never draws over the
  playfield.
* **Players decide:** anyone else playing can press **Vote to remove**, and a strict majority of
  the other players removes the flagged player. Votes are only possible against players the
  detector flagged, so a group can't vote out someone innocent.
* **Kicks:** the kicked player sees why, and everyone else sees "<name> was removed (reason)"
  in the same panel.
* The admin page (`/admin/reports`) is optional; it shows the same information plus evidence numbers.
 Address bans
are **off** by default, because friends and family often share one IP and a bot is simply
detected again. Set `BAN_MINUTES` to enable them. Flags never affect play. They go to the server log and to
`GET /admin/reports?token=…`, which only exists when `ADMIN_TOKEN` is set.

Configure with environment variables:

```bash
docker run -d -p 8080:8080 -e ANTICHEAT=kick -e ADMIN_TOKEN=change-me ghcr.io/vibatwork/ricochet-arena:latest
```

`ANTICHEAT` is `kick` (default), `flag` (report only) or `off`. `BAN_MINUTES` (default 0) bans a kicked player's address.

### Never at the expense of honest play

* **Isolated:** the detector only reads the game. If it ever throws an error it switches itself
  off and logs why, and the game carries on.
* **Cheap:** about 0.05 ms per tick for 8 players on the server (a tick is 40 ms). If it ever
  takes more than 3 ms, it runs on fewer ticks instead of delaying the game.
* **No false kicks by design:** kicks need overwhelming evidence over many shots; anything
  borderline is only a report. 12 simulated games of human-style players produce zero reports.
* **Network-friendly:** inputs that stop briefly are bridged with the last input, exactly as
  before. Only 1.5 s of silence idles a tank.
* **P2P:** a host whose tab freezes or lags is never treated as a cheater. That needs a host that
  keeps sending game updates while withholding the audit log.

**How the thresholds were checked:** `test/behaviour.test.js` runs 12 full games of simulated
human-style players (wanderers, aimers with 5–10 tick reactions, smooth mouse users) and
requires zero flags. It also requires that a ricochet bot, a mouse aimbot, a jittering script
and a fast-clock client are each caught.

**Limits:** detection is statistical. A bot deliberately made sloppy (human-like delays,
no ricochets) can stay under the thresholds, and a triggerbot that only takes direct shots is
flagged rather than kicked. That's the price of not kicking skilled humans.


## Code layout

| File | Role |
|---|---|
| `public/shared/sim.js` | the whole game: maze, movement, weapons, crates, rounds; deterministic and serialisable |
| `public/shared/dmath.js` | bit-exact trig (identical results on every browser engine) |
| `public/shared/protocol.js` | snapshot wire format, defined once by named field lists |
| `public/shared/room.js` | authoritative room + input validation (server **and** P2P host) |
| `public/shared/verify.js` | auditor a P2P guest uses to catch a cheating host |
| `public/shared/anticheat.js` | behavioural detection of bots/aim assistance (server and P2P host) |
| `public/game-client.js` | input, prediction, interpolation, events; transport-agnostic |
| `public/render.js`, `public/audio.js` | drawing/effects and synthesized sounds |
| `public/net-ws.js` | WebSocket transport (the P2P project adds `net-p2p.js`) |
| `server.js` | HTTP + WebSocket plumbing around `room.js` |

## Tests

```bash
npm test        # simulation, weapons, server, anti-cheat, bot detection (45 tests)
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
