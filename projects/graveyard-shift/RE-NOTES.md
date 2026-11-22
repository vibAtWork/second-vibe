# Reverse-engineering notes (supplied SWF → Graveyard Shift rules)

These notes record how the game logic was recovered from the supplied Flash file and which
rules and numbers Graveyard Shift takes from it. Only mechanics (numbers, formulas, tables)
were carried over. The original's code, art, sounds, characters and levels are not
included, and the SWF itself is not in this repository.

## The obfuscation

The file is an AS2 SWF (`CWS`, 50 fps, 6.4 MB decompressed). A normal tag-by-tag
disassembly shows:

* 166 `DoAction`/`DoInitAction` blocks, but almost no real work in them. There are only
  3 `GetMember` and 1 `SetMember` in the whole file.
* Every class block starts with a stub function and a **state-machine dispatcher**: a
  variable is compared against magic numbers and adjusted, with junk `If`/`Jump` chains,
  undefined opcodes (`0x03`) and decoy `ConstantPool`s with unprintable names.
* Each block has a real-looking constant pool (e.g. `mFireRate mDamage mRange …`), but no
  instruction references it.

**The trick.** Emulating a dispatcher (`re/emu.py`) shows it finally jumping to a
*negative* offset, before the start of its own tag. Flash Player executes actions straight
out of the loaded file buffer and doesn't bounds-check jumps against the tag. So the real
code lives **inside the bytes of other tags**, and jumps hop between them. Any
tag-by-tag decompiler only sees the decoys.

## Tools (`re/`)

| Script | What it does |
|---|---|
| `swf_decompress.py in.swf out.swf` | zlib-decompress a `CWS` file |
| `flowdis.py` | control-flow-following disassembler within each tag (shows the decoys) |
| `emu.py` | tiny AVM1 emulator for the dispatchers (shows the out-of-tag jump) |
| `fulldis.py raw.swf out.txt` | **whole-file** flow-following disassembler with absolute addresses. It follows `Jump`/`If`/function bodies anywhere in the buffer, ignores decoy pools, and marks instructions outside any code tag with `*` (about 63,000 of them) |
| `perblock.py raw.swf out.txt` | walks each code block over the whole buffer and resolves names against that block's real pool |
| `bodies.py raw.swf` | for every function body, picks the pool that decodes it cleanly and prints its constant `this.mX = …` writes |

Result: about 352,000 reachable instructions, including 11,796 `GetMember`, 3,941
`SetMember` and 1,157 `DefineFunction2`.

## Recovered rules used by Graveyard Shift

**Timing:** 50 frames per second; ranges are in map cells.

**Weapons** (`fireRate` frames / damage / range cells / auto / starting ammo):

| Key | Original class | Graveyard Shift | fireRate | damage | range | auto | notes |
|---|---|---|---|---|---|---|---|
| 1 | Pistol | Pistol | 8 | 26 | 8 | no | infinite ammo |
| 2 | UZI | SMG | 4 | 35 | 8 | yes | ammo 100 |
| 3 | Shotgun | Shotgun | 12 | 51 | 7 | no | ammo 20, wide-shot levels |
| 4 | Barrel | Barrel | 1 | 150 | – | – | placed; explodes |
| 5 | Grenade | Grenade | 12 | 150 | 6 | no | **fires on release**; 60-frame fuse |
| 6 | FakeWall | Barricade | 1 | – | – | – | wall life 1000 |
| 7 | Mine (Claymore) | Mine | 1 | 150* | – | – | |
| 8 | Rocket | Rocket | 12 | 250 | – | no | |
| 9 | ChargePack | Charge | 1 | 150 | – | – | detonate mode |
| 0 | Railgun | Railgun | 5 | 100 | 10 | no | pierces |

\* Mine damage wasn't isolated; it uses the barrel's 150. Starting-ammo values found in the
code are 100, 20 (×6), 10 (×2), 15 and 5. Their assignment to the placeable weapons is
partly inferred.

**Upgrade effects** (`ApplyUpgrade_Weapon`, applied to the original stats):

* Damage: DoubleDamage ×2, QuadDamage ×4, FatalDamage ×10.
* Fire rate: FastFire `round(max(2, rate/2))`, RapidFire `round(max(2, rate/4))`; both make the weapon automatic.
* Ammo: DoubleAmmo ×2, QuadAmmo ×4.
* Range: LongShot ×1.5, InfiniteRange = 100 cells.
* Shotgun spread: WideShot level 1, WiderShot level 2.
* Explosions: BigBang level 1, BiggerBang level 2, plus a ClusterExplode flag.

**Progression** (`CUpgrades`). Every kill adds **+1 to a team-wide multiplier** (clamped
1–999). Points are the creature's score × multiplier. The multiplier drops by 1 whenever
its timer runs out, and the timer restarts at

    ticks(m) = 3 + (3·fps − 3) · (101 − min(m, 100))^2.5 / 100000

which is 150 frames at ×1, about 30 at ×50 and 3 at ×100. Reaching a multiplier applies
its unlock step for good. All **58 steps** were recovered:
3 Pistol Fast Fire · **5 UZI** · 8 Pistol Double Damage · **10 Shotgun** · 13 UZI Rapid Fire ·
**15 Barrel** · 17 UZI Double Ammo · 18 Shotgun Fast Fire · **20 Grenade** · 21 Shotgun Double Ammo ·
23 UZI Long Shot · 26 Barrel Double Ammo · **30 Fake Wall** · 31 Shotgun Wide Shot · 32 Barrel Big Bang ·
33 Grenade Cluster · 35 Shotgun Long Shot · 36 Barrel Quad Ammo · 37 Fake Wall Double Ammo · 39 UZI Quad Ammo ·
**40 Claymore** · 41 Shotgun Quad Ammo · 42 Grenade Double Ammo · 43 Shotgun Rapid Fire · 44 Barrel Bigger Bang ·
45 Grenade Big Bang · 47 Claymore Cluster · 48 UZI Double Damage · **50 Rocket** · 51 Shotgun Wider Shot ·
52 Grenade Quad Ammo · 53 Fake Wall Quad Ammo · 54 Claymore Double Ammo · **55 Chargepack** · 56 Shotgun Double Damage ·
57 Grenade Bigger Bang · 58 Claymore Big Bang · 59 Rocket Fast Fire · 61 UZI Infinite Range · 62 Claymore Bigger Bang ·
63 Chargepack Cluster · 64 Claymore Quad Ammo · 66 Rocket Double Ammo · 68 Chargepack Double Ammo · **70 Railgun** ·
72 Rocket Big Bang · 74 Chargepack Big Bang · 76 Chargepack Quad Ammo · 78 Railgun Fast Fire · 80 Railgun Double Ammo ·
85 Rocket Quad Ammo · 90 UZI Quad Damage · 95 Chargepack Bigger Bang · 100 Railgun Rapid Fire · 105 Rocket Bigger Bang ·
110 Railgun Quad Ammo · 120 Rocket Rapid Fire · 125 Railgun Long Shot.

**Levels** (loop over levels 1–100 in `CUpgrades`):

* Zombie spawn interval `max(1, fps − (n−1))` frames.
* Zombies alive at once `min(60, 10 + 5(n−1))`; zombies to clear the level `10 + 5(n−1)`.
* Speed-up `min(5, 1 + n/10)`.
* Devils: spawn interval starts at 10·fps and drops by 1 per level. Their counts grow by
  0.3 (alive) and 0.25 (total) per level once devils are active (from level 5 in Graveyard
  Shift; the original unlocks them through save data).

**Difficulty** (`SetDifficulty`, starting level / starting multiplier):

| Difficulty | Level | Multiplier |
|---|---|---|
| Beginner | 1 | ×1 |
| Intermediate | 10 | ×10 |
| Expert | 20 | ×30 |
| Nightmare | 35 | ×50 |
| **DeathMatch** | 1 | **×200** (everything unlocked) |

**Creatures:**

* **Zombie:** speed 0.02 cells/frame (× level speed-up), life 100, attack 50, score 100.
* **Devil:** speed 0.04, life 1000, attack 50, attack range 5 cells, score 1000.
* **Player:** speed 2, life 100. Life **regenerates** `min(max, life + max/(fps·30))` per frame,
  a full refill in 30 s.
* Wall (fake wall) life 1000, barrel life 1.

## What Graveyard Shift chose itself

* **Arena and art:** the arena generator, all art and sounds, and the names (Graveyard
  Shift, shamblers, hexers, SMG, Barricade, Mine, Charge).
* **Timings not isolated in the code:** zombie attack cadence (1 per second), devil cast
  cadence (2 s), explosion radius (2.2 cells, ×1.5 per Big Bang level), cluster bomblets,
  and shotgun pellet counts per wide-shot level.
* **Deathmatch win condition:** first to 10 frags, plus a short spawn shield.
* **Explosion self-damage in co-op:** 30%.
