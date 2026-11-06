# Decisions

- **Original game, same mechanics.** The game is called "Ricochet Arena" and has its own art, sounds and procedural mazes. Only the mechanics (speeds, turn rate, sub-steps, bounce rule, timings, key bindings) match the supplied SWF.
- **Maze generator:** a randomized DFS spanning tree, then 30% of the remaining interior walls are removed. Every cell is reachable and there are loops. The original's generator could leave unreachable pockets; that wasn't worth copying.
- **Tank size 0.32 × 0.40 cells** (approximated). The muzzle is a collision point at 4.5/16 cells (the original's bullet spawn distance), so bullets never spawn inside walls.
- **Fire taps are latched** until the next 25 Hz tick, so a key tap shorter than 40 ms still fires. The original polled the key once per frame and could miss very short taps.
- **Approach 1 netcode:** authoritative server, one queued input per tick, client prediction for your own tank only, 90 ms interpolation for everything else. Input frames are re-sent 4× for loss tolerance.
