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
  Each tank can have at most 5 bullets in play, and fire needs a release between shots.
* Tanks drive through each other (only walls block them, as in the original).
* Rounds: 50-frame freeze at the start. Once only one tank (or none) is left,
  play continues for 125 frames (bullets can still kill the survivor), then the
  survivor scores and a new maze is generated.

## Tests

```bash
npm test
```

The tests cover movement speeds, turning, wall collision, bounce rules,
self-hits, the fire limit, round scoring, and maze connectivity. They also
check that two real WebSocket clients see each other, that rooms are isolated,
and that **the server's tank position matches the client's prediction exactly**
after 10 frames of input.

## Limitations

* No power-ups yet (the original had laser, frag bomb, gatling gun, homing missile and others, from crates).
  The core bullet game is complete.
* Tank size is an approximation (0.32 × 0.40 cells), and bullet hits use the
  tank body rectangle. The original tested hits against the drawn sprite shape.
* Your own tank is shown at "now" while others are ~90 ms + ping behind
  (normal for client prediction). On very high-latency links, an enemy bullet can appear to
  pass close and still hit, or the reverse.
* The server is authoritative but does no rate limiting beyond bounded input queues.
  It's meant for friends, not a public matchmaking service.
* No AI opponents.
