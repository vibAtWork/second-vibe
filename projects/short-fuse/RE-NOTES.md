# Reverse-engineering notes (supplied SWF → Short Fuse rules)

These notes record how the rules were recovered from the supplied Flash game and which
numbers Short Fuse takes from it. Only mechanics (rules, numbers, formulas) were carried
over. The original's code, art, sounds, names and hand-made level layouts are not
included, and the SWF itself is not in this repository.

## The file

`CWS` (zlib-compressed) SWF version 6, 24 fps, 554 × 410 stage, 21 root frames. It holds
13.5 KB of ActionScript 1 in 275 timeline scripts, plus clip-event and button handlers.
Unlike the second game, it is **not obfuscated**. The logic lives in clip events
(`onClipEvent(enterFrame)` etc.) on the instances inside the game sprite:

| Instance | What it does |
|---|---|
| `movGame` (root frame 17) | setup, power-up drops, sudden death, round end |
| `player1` / `player2` | keyboard input, movement, bomb laying / pick-up / throw |
| `computer2..4` | the AI opponents |
| `movBomb1..4` | fuse, kick sliding, throw flight, explosion |
| `movBlock2`, `movPUPS`, `movTransporter`, `movFireLine` | crates, pickups, teleporters, fire lines |
| `movTime` | the round clock |
| root frame 16 | constants and the four level layouts |

## Tools (`re/`)

| Script | What it does |
|---|---|
| `swf_decompress.py in.swf out.swf` | zlib-decompress a `CWS` file |
| `tags.py raw.swf` | header, tag counts, code-tag offsets |
| `dis.py raw.swf out.txt` | disassembles every code block (frames, clip events, buttons) with constant-pool names |
| `decomp.py dis.txt [filter]` | small stack-to-expression decompiler, enough to read the logic. Short-circuit `&&`/`||` come out as gotos; read those from the raw disassembly. |
| `bounds.py raw.swf ID…` | bounding boxes of clips (used for the hit boxes) |
| `sprites.py raw.swf NAME…` | which clip is placed under an instance name, and its frame count |

## Recovered rules used by Short Fuse

**Timing and units.** 24 frames per second; one Short Fuse tick per frame. The grid is
15 × 13 cells of 30 units, with pillars on even/even cells inside a wall border.

**Movement** (`player1` enterFrame, ported line by line into `move` in `public/shared/game.js`):

* Speed levels `arrSpeeds = [2, 3, 5, 6, 10]` units per frame. You start at level 2
  (5 per frame, 4 cells per second). Every speed divides 30, so you land exactly on cell
  centres.
* The nearest cell and the "lag" from its centre are computed once per frame. The
  directions are handled in the order up, down, left, right, each setting the facing.
* You move along an axis only when exactly lined up on the other axis, and only if the
  next cell is open (`!(grid > 0)`) or you're already between cells.
* **Corner assist:** holding up or down with no side key, while off a column, nudges you
  sideways toward the adjacent column whose next cell is open (four rules per
  direction). Left/right is the same with rows. Players don't block each other.
* With **kick**, walking into a bomb (grid value 3) sets it sliding.

**Bombs** (`movBomb` enterFrame):

* Fuse `nBlowTime = 60` frames. An exploding bomb kills for `nFadeTime = 25` frames and
  is removed at 85. Its cell stays solid until then.
* Flames go `length` cells each way. Open cells and pickups let them through (pickups
  are *not* destroyed). A crate stops them and burns for 25 frames, still solid, then
  disappears and may drop a pickup. A wall stops them. Another bomb has its counter set to
  59, so it goes off with the next increment.
* Kicked bombs slide 10 per frame while the next cell is open or they're between cells,
  and destroy pickups they pass. A sliding bomb isn't solid.
* With **throw**, pressing the bomb key on a bomb picks it up, and releasing throws it.
  A carried or flying bomb doesn't count down. The flight is 9 frames at 10 per frame;
  if the landing cell isn't free (`grid === 0`, no pickup or special tile) it keeps going
  2 frames at a time. It wraps round the board edges at the original's bounds.
* Laying needs the cell open and `nBombsLaid < nBombs`. You start with 1 bomb and
  flame length 2.

**Hits** (`fBlastImgLoop`, `fKillPlayer`, clip bounds via `bounds.py`):

* A hit is an overlap with the player's hit marker, a 15.3-unit square.
* Hit boxes: a flame arm is 12.8 × 36, rotated for horizontal arms. The exploding bomb is
  −15.5…16.5 × −26…16. A fire-line tile is 32 × 32. A teleporter is 33 × 33.
* Each flame arm can hit only **one** player, once (`blnKilled`). The bomb itself checks
  every frame.
* A hit costs one of **3 lives** and gives **75 frames** of invincibility (blinking).
  You stay where you are. At 0 lives you're out.

**Pickups** (`fPowerUp`, `movPUPS`):

* Five types: flame +1, speed +1 (to level 4), bomb +1, kick, throw.
* The level's pool is `[8, 8, 8, 4, 4]`.
* A destroyed crate rolls `random(5)`. Throw is rerolled with `random(4)` 1 time in 5,
  so it's rarer (4/25). The drop happens if `random(2) == 1` and the pool has that type
  left.
* A pickup is collected only when a player stands exactly on its cell centre.

**Specials:**

* *Teleporters:* touching a pad moves you to its partner. You can't teleport again for
  24 frames, then standing on the pad sends you back.
* *Fire lines:* a flame touching the track lights the whole track for 25 frames, hurting
  anyone on it.

**Round and match:**

* 3-minute clock (one second per 24 frames), 3 heats per match.
* **Sudden death** in the last 40 seconds: one wall every 8 frames, up to 80, spiralling
  inward from the outer ring (the exact walk is ported). A player under a falling wall
  loses a life.
* The heat ends when at most one player is left, or when every human is out, or at 0:00
  (a draw).
* The winner's bonus is seconds left × opponents × 250.

**Level types** (root frame 16):

* *Classic:* crates everywhere except an L of 5 cells in each start corner, then 20
  random crates removed.
* *Fire lines* and *teleporters:* hand-made layouts using those specials.
* *Madness:* no crates; everyone starts with speed 4, flame 4, 3 bombs, kick and throw.
  The AI's aggression factor is 2.

**AI** (`computer2` enterFrame): it scans for bombs in line with it to flee. It lays a bomb
with a 1-in-12 chance when near targets, and is forced to lay one after 350 frames
without (both divided by the aggression factor).

## Differences from the original (deliberate)

* **Layouts:** the arena layouts are Short Fuse's own. Classic uses the original's
  generator; the fire-line track is an "H" and the teleporter pads sit at the edge
  middles. The start corners and pillar grid are the original's.
* **Two bugs fixed:**
  * In the original, a picked-up bomb kept following the player who *laid* it.
  * After a thrown bomb exploded, the original credited the bomb slot to the *thrower*.
    The layer never got it back, and the thrower could gain bombs.
* **Bombs claim their cell the moment they come to rest.** That covers landing after a
  throw, stopping after a kick, and being dropped. The original claimed it one frame
  later. In that frame a second bomb could be laid or land in the same cell, and one of
  the two then lived on as a "ghost". If the cell is somehow taken, the bomb rests on a
  free neighbour instead.
* **A bomb that can't move can't be kicked:** one already exploding, or one up against
  something. In the original a "kick" against a wall opened the bomb's cell for a frame.
* **Fire lines** can hit each tile once per burn; the original's flag was never reset,
  so each tile could hit only once per round.
* **Flame arms in multiplayer:** an arm is still used up by its first hit, as in the
  original, but it hits *everyone* in it on that tick. The original hit only the
  lowest-numbered player, which would favour some players online.
* **Start corners** rotate each heat. The original's corners were fixed per player, and
  the random crate removal isn't symmetric.
* **Chain timing:** chained bombs always go off on the next tick. In the original that
  depended on the clips' processing order.
* **Sudden-death walls** crush pickups and bombs under them. The original just
  overwrote the grid cell, leaving the bomb clip running.
* **Bomb key:** it acts on press and release, not on keyboard auto-repeat. Holding it
  doesn't drop a trail.
* **Game flow:**
  * Online multiplayer for up to 4, with bots filling empty seats.
  * A short "ready" pause before each heat.
  * Players who join mid-heat wait for the next one.
  * When the humans are out and bots tie on lives, the heat is a draw. The original gave
    a random computer the point.
* **The AI** is Short Fuse's own. It uses danger maps with chain reactions and escape
  routes, and hunts. It keeps the original's forced bomb after 350 frames.
