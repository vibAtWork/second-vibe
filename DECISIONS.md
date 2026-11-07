# Decisions

- **Original game, same mechanics.** The game is called "Ricochet Arena" and has its own art, sounds and procedural mazes. Only the mechanics (speeds, turn rate, sub-steps, bounce rule, timings, key bindings) match the supplied SWF.
- **Maze generator:** a randomized DFS spanning tree, then 30% of the remaining interior walls are removed. Every cell is reachable and there are loops. The original's generator could leave unreachable pockets; that wasn't worth copying.
- **Tank size 0.32 × 0.40 cells** (approximated). The muzzle is a collision point at 4.5/16 cells (the original's bullet spawn distance), so bullets never spawn inside walls.
- **Fire taps are latched** until the next 25 Hz tick, so a key tap shorter than 40 ms still fires. The original polled the key once per frame and could miss very short taps.
- **Approach 1 netcode:** authoritative server, one queued input per tick, client prediction for your own tank only, 90 ms interpolation for everything else. Input frames are re-sent 4× for loss tolerance.
- **Approach 2 (P2P):** the first browser to claim the peer id `ricochet-arena-v1-<room>` hosts. A random back-off picks the new host when one leaves. Close events from WebRTC aren't reliable, so a 2.5 s snapshot timeout (guest side) and a 6 s silence timeout (host side) detect drops. PeerJS is vendored so the page doesn't depend on a CDN.
- **Bullet limit = 1**, from the original's default settings block (`settingsMaxBullets = 1`). My earlier value of 5 was a wrong assumption.
- **Crate pickup** uses the original rule (a crate corner inside the tank), plus "tank centre over the crate". The tank size is approximated, and without the extra rule a tank parked squarely on a crate turned 45° would miss it.
- **Frag shards** follow the original's code path literally: on touching a wall a shard stops for the rest of that frame instead of bouncing, so it creeps slowly through walls while fading.
- **Gatling rounds** start moving on the frame they're fired, like other projectiles.
- **Frag shards pass through walls** (changed on the owner's feedback about the original). Earlier I read the code as making them stall at walls.
- **Missile smoke**: grey before lock-on, then ~50% of puffs use the target's colour. The snapshot carries the target id for this.
- **Anti-cheat (server):** the server already runs the game. Hardening: strict validation, per-seat control scheme lock, one frame per tick, rate limit and kick, name sanitising.
- **Anti-cheat (P2P):** I chose replay auditing over lockstep or rollback. The host stays authoritative (smooth play) and guests verify it after the fact with per-tick hashes. This needed bit-exact trig (`dmath.js`) because `Math.sin` etc. may differ across engines. Join nonces go into the round seed so the host can't choose mazes alone.
- **Shared code instead of copies:** the P2P folder no longer copies shared code. It reuses the server project's files through its dev server and a `build.mjs` that produces `dist/` for static hosting. The Docker build stays self-contained because it only needs the server folder.
- **Refactor:** a protocol field list replaces positional indexing; one `busy` flag replaces four weapon flags; a `PROJECTILES` table plus `spawn()`; the client is split into game-client/render/audio/transport. JS went from 3,042 to 1,926 lines across both projects, with anti-cheat added.
