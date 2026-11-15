package game

// Authoritative game simulation: a faithful port of public/shared/sim.js.
// It must stay bit-identical to the JavaScript version, because browsers
// predict their own tank with sim.js; cmd/simtrace + test/go-conformance.test.js
// check that over long random games (weapons, crates, rounds included).
//
// Porting rules used throughout:
//   - JS Map insertion order is kept with ordered slices.
//   - Math.round -> jsRound; `%` -> math.Mod; >>> / Math.imul -> uint32.
//   - Non-exact constants are runtime float64 vars (no exact constant folding).
//   - Products added to something are wrapped in float64(...) (no FMA fusion).

import (
	"math"
	"strconv"
)

var (
	ViewW     = float64(692)
	ViewH     = float64(480)
	bottomBar = float64(80)
	mazeAreaH = ViewH - bottomBar
	wall      = float64(0.125)
	d2r       = PI / 180

	tankW       = float64(0.32)
	tankL       = float64(0.40)
	bulletSpawn = float64(4.5) / 16
	crateHalf   = float64(0.15)
)

const (
	FPS                 = 25
	steps               = 5
	turnSpeed           = 10.0
	forwardSpeed        = 4.0
	backupSpeed         = 2.5
	bulletSpeed         = 4.5
	BulletSubsteps      = 7
	bulletLifetime      = 250
	MaxBullets          = 1
	crateTimeBase       = 350
	crateTimeRandom     = 200
	crateMazeScale      = 2000.0
	maxCrates           = 100
	laserSpeed          = 70.0
	laserSubsteps       = 70
	laserLifetime       = 8
	laserSafeSteps      = 7
	fragSpeed           = 4.5
	fragSubsteps        = 7
	fragLifetime        = 250
	fragShards          = 40
	shardLifetime       = 20
	gatlingSpeed        = 5.5
	gatlingSubsteps     = 7
	gatlingLifetime     = 125
	gatlingBullets      = 20
	gatlingSpin         = 10
	gatlingSafe         = 2
	gatlingSpread       = 11.0
	homingSpeed         = 4.5
	homingSubsteps      = 5
	homingLifetime      = 250
	homingStartup       = 50
	mouseDeadzone       = 60.0
	FramesFrozen        = 50
	framesBeforeEnd     = 125
)

var crateModifier = float64(0.1)
var homingTurn = float64(0.12)

var Weapons = []string{"laser", "frag", "gatling", "homing"}
var weaponCode = map[string]int{"bullet": 0, "laser": 1, "frag": 2, "gatling": 3, "homing": 4}
var projCode = map[string]int{"bullet": 0, "gatling": 1, "frag": 2, "shard": 3, "homing": 4}

type projSpec struct {
	speed           float64
	substeps, life  int
	deadly          int
}

var projectiles = map[string]projSpec{
	"bullet":  {bulletSpeed, BulletSubsteps, bulletLifetime, 0},
	"gatling": {gatlingSpeed, gatlingSubsteps, gatlingLifetime, gatlingSafe},
	"frag":    {fragSpeed, fragSubsteps, fragLifetime, 0},
	"shard":   {fragSpeed, fragSubsteps, shardLifetime, 0},
	"homing":  {homingSpeed, homingSubsteps, homingLifetime, 0},
}

// ---------------------------------------------------------------- RNG
// mulberry32, identical to sim.js rng().
type Rng struct{ a uint32 }

func NewRng(seed uint32) *Rng { return &Rng{seed} }
func (r *Rng) State() uint32  { return r.a }
func (r *Rng) SetState(v uint32) { r.a = v }
func (r *Rng) Next() float64 {
	r.a += 0x6D2B79F5
	t := r.a
	t = (t ^ (t >> 15)) * (t | 1)
	t ^= t + (t^(t>>7))*(t|61)
	return float64(t^(t>>14)) / 4294967296
}

// HashString is 32-bit FNV-1a over UTF-16 code units (like charCodeAt).
func HashString(s string) uint32 {
	h := uint32(0x811c9dc5)
	for _, u := range utf16Units(s) {
		h ^= uint32(u)
		h *= 0x01000193
	}
	return h
}

func utf16Units(s string) []uint16 {
	out := make([]uint16, 0, len(s))
	for _, r := range s {
		if r >= 0x10000 {
			r -= 0x10000
			out = append(out, uint16(0xD800+(r>>10)), uint16(0xDC00+(r&0x3FF)))
		} else {
			out = append(out, uint16(r))
		}
	}
	return out
}

// ---------------------------------------------------------------- Maze
// V[i][j]: vertical wall on grid line x=i, row j. H[i][j]: horizontal wall on line y=j, column i.
type Maze struct {
	Seed   uint32
	W, H   int
	S      float64
	V, Hz  [][]bool
	Ox, Oy float64
}

func GenerateMaze(seed uint32, w, h int, openness float64) *Maze {
	r := NewRng(seed)
	W, H := w, h
	if W == 0 {
		W = 4 + int(math.Floor(r.Next()*9))
	}
	if H == 0 {
		H = 4 + int(math.Floor(r.Next()*7))
	}
	v := make([][]bool, W+1)
	for i := range v {
		v[i] = make([]bool, H)
		for j := range v[i] {
			v[i][j] = true
		}
	}
	hz := make([][]bool, W)
	for i := range hz {
		hz[i] = make([]bool, H+1)
		for j := range hz[i] {
			hz[i][j] = true
		}
	}
	seen := make([]bool, W*H)
	sx := int(math.Floor(r.Next() * float64(W)))
	sy := int(math.Floor(r.Next() * float64(H)))
	stack := [][2]int{{sx, sy}}
	seen[sy*W+sx] = true
	for len(stack) > 0 {
		c := stack[len(stack)-1]
		cx, cy := c[0], c[1]
		var nbrs [][2]int
		if cx > 0 && !seen[cy*W+cx-1] {
			nbrs = append(nbrs, [2]int{-1, 0})
		}
		if cx < W-1 && !seen[cy*W+cx+1] {
			nbrs = append(nbrs, [2]int{1, 0})
		}
		if cy > 0 && !seen[(cy-1)*W+cx] {
			nbrs = append(nbrs, [2]int{0, -1})
		}
		if cy < H-1 && !seen[(cy+1)*W+cx] {
			nbrs = append(nbrs, [2]int{0, 1})
		}
		if len(nbrs) == 0 {
			stack = stack[:len(stack)-1]
			continue
		}
		d := nbrs[int(math.Floor(r.Next()*float64(len(nbrs))))]
		switch {
		case d[0] == -1:
			v[cx][cy] = false
		case d[0] == 1:
			v[cx+1][cy] = false
		case d[1] == -1:
			hz[cx][cy] = false
		case d[1] == 1:
			hz[cx][cy+1] = false
		}
		nx, ny := cx+d[0], cy+d[1]
		seen[ny*W+nx] = true
		stack = append(stack, [2]int{nx, ny})
	}
	for i := 1; i < W; i++ {
		for j := 0; j < H; j++ {
			if v[i][j] && r.Next() < openness {
				v[i][j] = false
			}
		}
	}
	for i := 0; i < W; i++ {
		for j := 1; j < H; j++ {
			if hz[i][j] && r.Next() < openness {
				hz[i][j] = false
			}
		}
	}
	S := math.Min(ViewW/(float64(W)+wall), mazeAreaH/(float64(H)+wall))
	return &Maze{Seed: seed, W: W, H: H, S: S, V: v, Hz: hz,
		Ox: (ViewW - float64(S*(float64(W)+wall))) / 2, Oy: (mazeAreaH - float64(S*(float64(H)+wall))) / 2}
}

var defaultOpenness = float64(0.3)

func (m *Maze) WallAt(x, y float64) bool {
	S := m.S
	t := float64(wall * S)
	if x < 0 || y < 0 || x >= float64(float64(m.W)*S)+t || y >= float64(float64(m.H)*S)+t {
		return true
	}
	fi, fj := math.Floor(x/S), math.Floor(y/S)
	i, j := int(fi), int(fj)
	fx, fy := x-float64(fi*S), y-float64(fj*S)
	if fx < t {
		if j < m.H && m.V[i][j] {
			return true
		}
		if fy < t && j > 0 && m.V[i][j-1] {
			return true
		}
	}
	if fy < t {
		if i < m.W && m.Hz[i][j] {
			return true
		}
		if fx < t && i > 0 && m.Hz[i-1][j] {
			return true
		}
	}
	return false
}

func (m *Maze) CellCenter(cx, cy int) (float64, float64) {
	half := float64(wall*m.S) / 2
	return float64((float64(cx)+0.5)*m.S) + half, float64((float64(cy)+0.5)*m.S) + half
}

// ---------------------------------------------------------------- Tanks
func normRot(r float64) float64 {
	r = math.Mod(r, 360)
	if r > 180 {
		r -= 360
	}
	if r <= -180 {
		r += 360
	}
	return r
}

type tankPts struct{ front, rear, sides [][2]float64 }

var ptCache = map[float64]*tankPts{}

func pts(S float64) *tankPts {
	if p, ok := ptCache[S]; ok {
		return p
	}
	w, l := float64(tankW*S), float64(tankL*S)
	p := &tankPts{
		front: [][2]float64{{-w / 2, -l / 2}, {-w / 4, -l / 2}, {w / 4, -l / 2}, {w / 2, -l / 2}, {0, -float64(bulletSpawn * S)}},
		rear:  [][2]float64{{-w / 2, l / 2}, {-w / 4, l / 2}, {w / 4, l / 2}, {w / 2, l / 2}},
		sides: [][2]float64{{-w / 2, -l / 4}, {-w / 2, 0}, {-w / 2, l / 4}, {w / 2, -l / 4}, {w / 2, 0}, {w / 2, l / 4}},
	}
	ptCache[S] = p
	return p
}

func hitAny(m *Maze, list [][2]float64, x, y, rot float64) bool {
	a := float64(rot * d2r)
	c, s := Cos(a), Sin(a)
	for _, p := range list {
		px, py := p[0], p[1]
		if m.WallAt(x+float64(px*c)-float64(py*s), y+float64(px*s)+float64(py*c)) {
			return true
		}
	}
	return false
}

func tankHitsWall(m *Maze, x, y, rot float64) bool {
	p := pts(m.S)
	return hitAny(m, p.front, x, y, rot) || hitAny(m, p.rear, x, y, rot) || hitAny(m, p.sides, x, y, rot)
}

// Input for one tank for one frame.
type Input struct {
	F, B, L, R, Fire bool
	Mouse            bool
	MX, MY           float64
}

type Tank struct {
	ID              int
	X, Y, Rot       float64
	Alive           bool
	BulletsFired    int
	TriggerReleased bool
	Weapon          string
	Busy            bool
	LastFrag        int // projectile id of the frag bomb in flight (0 = none)
}

// MoveTank mirrors sim.js moveTank exactly.
func MoveTank(m *Maze, t *Tank, in Input) {
	S := m.S
	fwd, back := float64(forwardSpeed*S)/50, float64(backupSpeed*S)/50
	p := pts(S)
	oldX, oldY, oldRot := t.X, t.Y, t.Rot
	forward, backup, left, right := in.F, in.B, in.L, in.R
	if in.Mouse {
		dx, dy := in.MX-t.X, in.MY-t.Y
		t.Rot = normRot(Atan2(dy, dx)/d2r + 90)
		forward = Hypot(dx, dy) > mouseDeadzone
		backup, left, right = false, false, false
	}
	moveSize, turnSize := 0.0, 0.0
	if forward {
		moveSize = fwd / steps
	}
	if backup {
		moveSize -= back / steps
	}
	if left {
		turnSize = -turnSpeed / steps
	}
	if right {
		turnSize += turnSpeed / steps
	}
	hitSomething := false
	x, y, rot := t.X, t.Y, t.Rot
	for k := 0; k < steps; k++ {
		rot += turnSize
		x += float64(Cos(float64((rot-90)*d2r)) * moveSize)
		y += float64(Sin(float64((rot-90)*d2r)) * moveSize)
	}
	rot = normRot(rot)
	if tankHitsWall(m, x, y, rot) {
		x, y, rot = oldX, oldY, oldRot
		for k := 0; k < steps; k++ {
			if !in.Mouse {
				pr := rot
				rot = normRot(rot + turnSize)
				if tankHitsWall(m, x, y, rot) {
					rot = pr
					hitSomething = true
				}
			}
			px, py := x, y
			x += float64(Cos(float64((rot-90)*d2r)) * moveSize)
			y += float64(Sin(float64((rot-90)*d2r)) * moveSize)
			if moveSize > 0 && hitAny(m, p.front, x, y, rot) {
				x, y, hitSomething = px, py, true
			} else if moveSize < 0 && hitAny(m, p.rear, x, y, rot) {
				x, y, hitSomething = px, py, true
			}
		}
	}
	offset := math.Mod(math.Mod(360+rot, turnSpeed)+turnSpeed, turnSpeed)
	if !hitSomething && turnSize != 0 && offset != 0 {
		if offset < turnSpeed/2 {
			rot = rot - offset
		} else {
			rot = rot + (turnSpeed - offset)
		}
	}
	t.X, t.Y, t.Rot = x, y, normRot(jsRound(float64(rot*1e6))/1e6)
}

func pointInTank(S float64, t *Tank, x, y float64) bool {
	a := float64(-t.Rot * d2r)
	c, s := Cos(a), Sin(a)
	dx, dy := x-t.X, y-t.Y
	lx, ly := float64(dx*c)-float64(dy*s), float64(dx*s)+float64(dy*c)
	return math.Abs(lx) <= float64(tankW*S)/2 && math.Abs(ly) <= float64(tankL*S)/2
}

// ---------------------------------------------------------------- Projectiles
type Proj struct {
	ID       int
	Kind     string
	Owner    int
	X, Y     float64
	VX, VY   float64
	Substeps int
	Life     int
	Deadly   int
	Startup  int  // homing
	Homing   bool // homing
	Target   int  // homing (0 = none)
	dead     bool
}

type mover interface{ pos() (*float64, *float64, *float64, *float64) }

func (b *Proj) pos() (*float64, *float64, *float64, *float64) { return &b.X, &b.Y, &b.VX, &b.VY }

// bounceStep: one sub-step with the original's bounce rule (see sim.js).
func bounceStep(m *Maze, x, y, vx, vy *float64) bool {
	px, py := *x, *y
	*x += *vx
	*y += *vy
	if !m.WallAt(*x, *y) {
		return false
	}
	hitXInv := m.WallAt(px-*vx, py+*vy)
	hitYInv := m.WallAt(px+*vx, py-*vy)
	switch {
	case hitXInv && !hitYInv:
		*vy = -*vy
	case hitYInv && !hitXInv:
		*vx = -*vx
	default:
		*vx, *vy = -*vx, -*vy
	}
	*x, *y = px+*vx, py+*vy
	return true
}

func stepBullet(m *Maze, b *Proj, substeps int) int {
	n := 0
	for i := 0; i < substeps; i++ {
		if bounceStep(m, &b.X, &b.Y, &b.VX, &b.VY) {
			n++
		}
	}
	return n
}

type muzzleT struct{ x, y, c, s float64 }

func muzzle(m *Maze, t *Tank) muzzleT {
	a := float64((t.Rot - 90) * d2r)
	c, s := Cos(a), Sin(a)
	return muzzleT{t.X + float64(float64(c*m.S)*bulletSpawn), t.Y + float64(float64(s*m.S)*bulletSpawn), c, s}
}

// makeBullet mirrors sim.js makeBullet (used by the anti-cheat to replay shots).
func makeBullet(m *Maze, t *Tank) *Proj {
	S := m.S
	a := float64((t.Rot - 90) * d2r)
	sp := float64(bulletSpeed/BulletSubsteps*S) / 50
	c, s := Cos(a), Sin(a)
	return &Proj{Owner: t.ID, X: t.X + float64(float64(c*S)*bulletSpawn), Y: t.Y + float64(float64(s*S)*bulletSpawn),
		VX: float64(c * sp), VY: float64(s * sp), Life: bulletLifetime}
}

func cellOf(m *Maze, x, y float64) (int, int) {
	cx := int(math.Max(0, math.Min(float64(m.W-1), math.Floor(x/m.S))))
	cy := int(math.Max(0, math.Min(float64(m.H-1), math.Floor(y/m.S))))
	return cx, cy
}

func mazeDistances(m *Maze, sx, sy int) []int {
	d := make([]int, m.W*m.H)
	for i := range d {
		d[i] = -1
	}
	q := []int{sx + sy*m.W}
	d[q[0]] = 0
	for k := 0; k < len(q); k++ {
		c := q[k]
		x, y := c%m.W, c/m.W
		goTo := func(nx, ny int, w bool) {
			n := nx + ny*m.W
			if !w && d[n] < 0 {
				d[n] = d[c] + 1
				q = append(q, n)
			}
		}
		if x > 0 {
			goTo(x-1, y, m.V[x][y])
		}
		if x < m.W-1 {
			goTo(x+1, y, m.V[x+1][y])
		}
		if y > 0 {
			goTo(x, y-1, m.Hz[x][y])
		}
		if y < m.H-1 {
			goTo(x, y+1, m.Hz[x][y+1])
		}
	}
	return d
}

// ---------------------------------------------------------------- Game
type Player struct {
	ID    int
	Name  string
	Color string
	Score int
}

type Laser struct {
	ID, Owner int
	X, Y      float64
	VX, VY    float64
	Life      int
	Safe      int
	Trail     [][2]float64
}

type Gun struct {
	Owner   int
	Active  bool
	Spin    int
	Counter int
	Left    int
}

type Crate struct {
	ID       int
	CX, CY   int
	X, Y     float64
	Rot      float64
	Weapon   string
}

// Event is a free-form game event (sent to clients as JSON).
type Event map[string]any

type Game struct {
	MaxBullets int
	Crates     bool
	seedRng    *Rng
	rand       *Rng
	Tick       int
	players    []*Player // insertion order (like a JS Map)
	tanks      []*Tank   // insertion order
	Bullets    []*Proj
	Lasers     []*Laser
	Guns       []*Gun
	CrateList  []*Crate
	nextID     int
	events     []Event
	Round      int
	Maze       *Maze
	Frozen     int
	EndCount   int
	CrateTimer float64
}

func NewGame(seed uint32) *Game {
	return &Game{MaxBullets: MaxBullets, Crates: true, seedRng: NewRng(seed), rand: NewRng(seed ^ 0x51ed270b), nextID: 1, EndCount: -1}
}

func (g *Game) Player(id int) *Player {
	for _, p := range g.players {
		if p.ID == id {
			return p
		}
	}
	return nil
}
func (g *Game) Players() []*Player { return g.players }
func (g *Game) Tank(id int) *Tank {
	for _, t := range g.tanks {
		if t.ID == id {
			return t
		}
	}
	return nil
}
func (g *Game) Tanks() []*Tank { return g.tanks }
func (g *Game) RNGStates() (uint32, uint32) { return g.seedRng.State(), g.rand.State() }

// AddPlayer: nonce is mixed into the round seed (see sim.js).
func (g *Game) AddPlayer(id int, name, color string, nonce uint32) {
	g.players = append(g.players, &Player{ID: id, Name: name, Color: color})
	if nonce != 0 {
		g.seedRng.SetState(HashString(strconv.FormatUint(uint64(g.seedRng.State()), 10) + ":" + strconv.FormatUint(uint64(nonce), 10)))
	}
	if len(g.players) <= 2 {
		g.NewRound()
	}
}

func (g *Game) RemovePlayer(id int) {
	g.players = filter(g.players, func(p *Player) bool { return p.ID != id })
	g.tanks = filter(g.tanks, func(t *Tank) bool { return t.ID != id })
	g.Guns = filter(g.Guns, func(x *Gun) bool { return x.Owner != id })
	if len(g.players) == 0 {
		g.Maze, g.tanks, g.Bullets, g.Lasers, g.CrateList, g.Guns = nil, nil, nil, nil, nil, nil
	}
}

func filter[T any](s []T, keep func(T) bool) []T {
	out := s[:0:0]
	for _, x := range s {
		if keep(x) {
			out = append(out, x)
		}
	}
	return out
}

func (g *Game) NewRound() {
	g.Round++
	seed := uint32(math.Floor(g.seedRng.Next() * 4294967296))
	m := GenerateMaze(seed, 0, 0, defaultOpenness)
	g.Maze = m
	g.Bullets, g.Lasers, g.Guns, g.CrateList = nil, nil, nil, nil
	g.tanks = nil
	r := NewRng(seed ^ 0x9e3779b9)
	var cells [][2]int
	for x := 0; x < m.W; x++ {
		for y := 0; y < m.H; y++ {
			cells = append(cells, [2]int{x, y})
		}
	}
	for i := len(cells) - 1; i > 0; i-- {
		k := int(math.Floor(r.Next() * float64(i+1)))
		cells[i], cells[k] = cells[k], cells[i]
	}
	for n, p := range g.players {
		c := cells[n%len(cells)]
		x, y := m.CellCenter(c[0], c[1])
		g.tanks = append(g.tanks, &Tank{ID: p.ID, X: x, Y: y, Rot: normRot(math.Floor(r.Next()*36) * 10),
			Alive: true, TriggerReleased: true, Weapon: "bullet"})
	}
	g.Frozen = FramesFrozen
	g.EndCount = -1
	g.CrateTimer = float64(float64(crateTimeBase+math.Floor(g.rand.Next()*crateTimeRandom)) * crateModifier)
	g.events = append(g.events, Event{"type": "round", "round": g.Round})
}

func (g *Game) locked(t *Tank) bool { return t.Weapon == "laser" && t.Busy }

func (g *Game) weaponReady(t *Tank) bool {
	if t.Weapon == "bullet" {
		return t.BulletsFired < g.MaxBullets
	}
	return t.Weapon == "frag" || !t.Busy
}

func (g *Game) finishWeapon(t *Tank) {
	if t == nil {
		return
	}
	t.Weapon, t.Busy, t.LastFrag = "bullet", false, 0
}

func (g *Game) spawn(kind string, owner int, x, y, c, s, speed float64) *Proj {
	k := projectiles[kind]
	sp := float64(speed/float64(k.substeps)*g.Maze.S) / 50
	b := &Proj{ID: g.nextID, Kind: kind, Owner: owner, X: x, Y: y, VX: float64(c * sp), VY: float64(s * sp), Substeps: k.substeps, Life: k.life, Deadly: k.deadly}
	g.nextID++
	g.Bullets = append(g.Bullets, b)
	return b
}

func (g *Game) fire(t *Tank) {
	m := g.Maze
	mz := muzzle(m, t)
	shoot := func(kind string) *Proj { return g.spawn(kind, t.ID, mz.x, mz.y, mz.c, mz.s, projectiles[kind].speed) }
	switch t.Weapon {
	case "bullet":
		shoot("bullet")
		t.BulletsFired++
		g.events = append(g.events, Event{"type": "fire", "x": t.X, "y": t.Y, "id": t.ID, "weapon": "bullet"})
		return
	case "frag":
		if t.Busy {
			for _, b := range g.Bullets {
				if b.ID == t.LastFrag {
					g.detonate(b)
					break
				}
			}
			return
		}
		t.LastFrag = shoot("frag").ID
		g.events = append(g.events, Event{"type": "fire", "x": t.X, "y": t.Y, "id": t.ID, "weapon": "frag"})
	case "laser":
		sp := float64(laserSpeed/laserSubsteps*m.S) / 50
		g.Lasers = append(g.Lasers, &Laser{ID: g.nextID, Owner: t.ID, X: mz.x, Y: mz.y, VX: float64(mz.c * sp), VY: float64(mz.s * sp), Life: laserLifetime, Safe: laserSafeSteps})
		g.nextID++
		g.events = append(g.events, Event{"type": "laser", "x": t.X, "y": t.Y})
	case "gatling":
		g.Guns = append(g.Guns, &Gun{Owner: t.ID, Active: true, Left: gatlingBullets})
		g.events = append(g.events, Event{"type": "spin", "id": t.ID})
	case "homing":
		b := shoot("homing")
		b.Startup = homingStartup
		g.events = append(g.events, Event{"type": "missile", "x": t.X, "y": t.Y})
	}
	t.Busy = true
}

func (g *Game) detonate(b *Proj) {
	if b.dead {
		return
	}
	b.dead = true
	g.finishWeapon(g.Tank(b.Owner))
	for i := 0; i < fragShards; i++ {
		a := float64((math.Floor(g.rand.Next()*360) - 90) * d2r)
		speed := fragSpeed - float64(g.rand.Next()*fragSpeed) + 4
		g.spawn("shard", b.Owner, b.X, b.Y, Cos(a), Sin(a), speed)
	}
	g.events = append(g.events, Event{"type": "frag", "x": b.X, "y": b.Y})
}

func (g *Game) kill(t *Tank, killer int) {
	if !t.Alive {
		return
	}
	t.Alive = false
	g.events = append(g.events, Event{"type": "boom", "x": t.X, "y": t.Y, "victim": t.ID, "killer": killer})
}

func (g *Game) tankAt(x, y float64) *Tank {
	for _, t := range g.tanks {
		if t.Alive && pointInTank(g.Maze.S, t, x, y) {
			return t
		}
	}
	return nil
}

func (g *Game) stepGun(gun *Gun) bool {
	t := g.Tank(gun.Owner)
	if t == nil || !t.Alive {
		return false
	}
	if gun.Active && t.TriggerReleased {
		gun.Active = false
	}
	if gun.Active {
		if gun.Spin < gatlingSpin {
			gun.Spin++
		}
		if gun.Spin == gatlingSpin {
			gun.Counter++
			if gun.Counter%3 == 0 && gun.Left > 0 {
				gun.Left--
				mz := muzzle(g.Maze, t)
				a := float64((t.Rot - 90 + float64(g.rand.Next()*gatlingSpread) - gatlingSpread/2) * d2r)
				g.spawn("gatling", t.ID, mz.x, mz.y, Cos(a), Sin(a), gatlingSpeed)
				g.events = append(g.events, Event{"type": "gshot"})
			}
		}
	} else {
		if gun.Spin > 0 {
			gun.Spin--
		}
		if gun.Spin == 0 {
			g.finishWeapon(t)
			return false
		}
	}
	return true
}

func (g *Game) stepLaser(L *Laser) bool {
	m := g.Maze
	L.Trail = [][2]float64{{L.X, L.Y}}
	for j := 0; j < laserSubsteps; j++ {
		if bounceStep(m, &L.X, &L.Y, &L.VX, &L.VY) {
			L.Trail = append(L.Trail, [2]float64{L.X - L.VX, L.Y - L.VY})
		}
		if L.Safe > 0 {
			L.Safe--
		}
		if L.Safe == 0 {
			if hit := g.tankAt(L.X, L.Y); hit != nil {
				g.kill(hit, L.Owner)
				L.Life = 1
				break
			}
		}
	}
	L.Trail = append(L.Trail, [2]float64{L.X, L.Y})
	L.Life--
	if L.Life == 0 {
		g.finishWeapon(g.Tank(L.Owner))
		return false
	}
	return true
}

func (g *Game) stepHoming(b *Proj) int {
	m := g.Maze
	S := m.S
	var aim *[2]float64
	if b.Homing {
		cx, cy := cellOf(m, b.X, b.Y)
		dist := mazeDistances(m, cx, cy)
		best := 1000000000
		var target *Tank
		for _, t := range g.tanks {
			if !t.Alive {
				continue
			}
			tx, ty := cellOf(m, t.X, t.Y)
			d := dist[tx+ty*m.W]
			if d < 0 {
				continue
			}
			if d < best || (d == best && t.ID != b.Owner) {
				best, target = d, t
			}
		}
		if target == nil {
			b.Homing = false
		} else {
			if b.Target != target.ID {
				b.Target = target.ID
				g.events = append(g.events, Event{"type": "lock", "id": target.ID})
			}
			if best == 0 {
				aim = &[2]float64{target.X, target.Y}
			} else {
				tx, ty := cellOf(m, target.X, target.Y)
				back := mazeDistances(m, tx, ty)
				here := back[cx+cy*m.W]
				var opts [][2]int
				if cx > 0 && !m.V[cx][cy] {
					opts = append(opts, [2]int{cx - 1, cy})
				}
				if cx < m.W-1 && !m.V[cx+1][cy] {
					opts = append(opts, [2]int{cx + 1, cy})
				}
				if cy > 0 && !m.Hz[cx][cy] {
					opts = append(opts, [2]int{cx, cy - 1})
				}
				if cy < m.H-1 && !m.Hz[cx][cy+1] {
					opts = append(opts, [2]int{cx, cy + 1})
				}
				next := [2]int{tx, ty}
				for _, o := range opts {
					if back[o[0]+o[1]*m.W] == here-1 {
						next = o
						break
					}
				}
				x, y := m.CellCenter(next[0], next[1])
				aim = &[2]float64{x, y}
			}
		}
	}
	maxSp := float64(homingSpeed/homingSubsteps*S) / 50
	acc := homingTurn / homingSubsteps
	bounces := 0
	for i := 0; i < homingSubsteps; i++ {
		if bounceStep(m, &b.X, &b.Y, &b.VX, &b.VY) {
			bounces++
		}
		if aim != nil {
			if aim[0]-b.X < 0 {
				b.VX += -acc
			} else {
				b.VX += acc
			}
			if aim[1]-b.Y < 0 {
				b.VY += -acc
			} else {
				b.VY += acc
			}
			sp := Hypot(b.VX, b.VY)
			if sp > maxSp {
				b.VX = float64(b.VX/sp) * maxSp
				b.VY = float64(b.VY/sp) * maxSp
			}
		}
	}
	return bounces
}

func (g *Game) stepShard(b *Proj) bool {
	m := g.Maze
	wasIn := m.WallAt(b.X, b.Y)
	entered := false
	for i := 0; i < b.Substeps; i++ {
		b.X += b.VX
		b.Y += b.VY
		if !wasIn && !entered && m.WallAt(b.X, b.Y) {
			entered = true
		}
	}
	return entered
}

func (g *Game) spawnCrate() {
	m := g.Maze
	g.CrateTimer = float64(float64(crateTimeBase+math.Floor(g.rand.Next()*crateTimeRandom)+crateMazeScale/float64(m.W*m.H)) * crateModifier)
	if !g.Crates || len(g.CrateList) >= maxCrates {
		return
	}
	for tries := 0; tries < 5; tries++ {
		cx := int(math.Floor(g.rand.Next() * float64(m.W)))
		cy := int(math.Floor(g.rand.Next() * float64(m.H)))
		taken := false
		for _, c := range g.CrateList {
			if c.CX == cx && c.CY == cy {
				taken = true
				break
			}
		}
		if taken {
			continue
		}
		x, y := m.CellCenter(cx, cy)
		rot := float64(g.rand.Next()*90) - 45
		w := Weapons[int(math.Floor(g.rand.Next()*float64(len(Weapons))))]
		g.CrateList = append(g.CrateList, &Crate{ID: g.nextID, CX: cx, CY: cy, X: x, Y: y, Rot: rot, Weapon: w})
		g.nextID++
		g.events = append(g.events, Event{"type": "crate", "x": x, "y": y})
		return
	}
}

func (g *Game) checkCrates() {
	S := g.Maze.S
	g.CrateList = filter(g.CrateList, func(c *Crate) bool {
		a := float64(c.Rot * d2r)
		co, si, h := Cos(a), Sin(a), float64(crateHalf*S)
		corners := [4][2]float64{}
		for i, xy := range [4][2]float64{{-h, -h}, {-h, h}, {h, h}, {h, -h}} {
			corners[i] = [2]float64{c.X + float64(xy[0]*co) - float64(xy[1]*si), c.Y + float64(xy[0]*si) + float64(xy[1]*co)}
		}
		for _, t := range g.tanks {
			if !t.Alive || t.Weapon != "bullet" {
				continue
			}
			dx, dy := t.X-c.X, t.Y-c.Y
			lx, ly := float64(dx*co)+float64(dy*si), float64(-dx*si)+float64(dy*co)
			hit := math.Abs(lx) <= h && math.Abs(ly) <= h
			for _, p := range corners {
				if hit {
					break
				}
				hit = pointInTank(S, t, p[0], p[1])
			}
			if hit {
				t.Weapon = c.Weapon
				g.events = append(g.events, Event{"type": "pickup", "id": t.ID, "weapon": c.Weapon})
				return false
			}
		}
		return true
	})
}

// Step advances one frame. inputs: tank id -> input.
func (g *Game) Step(inputs map[int]Input) {
	g.Tick++
	if g.Maze == nil {
		return
	}
	if g.Frozen > 0 {
		g.Frozen--
		return
	}
	m := g.Maze
	for _, t := range g.tanks {
		if !t.Alive || g.locked(t) {
			continue
		}
		in := inputs[t.ID]
		MoveTank(m, t, in)
		if in.Fire {
			if t.TriggerReleased && g.weaponReady(t) {
				t.TriggerReleased = false
				g.fire(t)
			}
		} else {
			t.TriggerReleased = true
		}
	}
	g.checkCrates()
	g.Guns = filter(g.Guns, g.stepGun)
	g.Lasers = filter(g.Lasers, g.stepLaser)

	var survivors []*Proj
	shardHits := 0
	for i := 0; i < len(g.Bullets); i++ { // live length: shards spawned mid-loop move this frame too
		b := g.Bullets[i]
		if b.dead {
			continue
		}
		switch b.Kind {
		case "shard":
			if g.stepShard(b) {
				shardHits++
			}
		case "homing":
			if g.stepHoming(b) > 0 {
				g.events = append(g.events, Event{"type": "bounce"})
			}
		default:
			if stepBullet(m, b, b.Substeps) > 0 {
				g.events = append(g.events, Event{"type": "bounce"})
			}
		}
		dead := false
		if b.Deadly == 0 {
			if hit := g.tankAt(b.X, b.Y); hit != nil {
				g.kill(hit, b.Owner)
				dead = true
				if b.Kind == "frag" {
					g.detonate(b)
				}
			}
		} else {
			b.Deadly--
		}
		if !dead && b.Kind == "frag" {
			if o := g.Tank(b.Owner); o == nil || !o.Alive {
				g.detonate(b)
				dead = true
			}
		}
		if !dead && b.Kind == "homing" && b.Startup > 0 {
			b.Startup--
			if b.Startup == 0 {
				b.Homing = true
			}
		}
		if !dead {
			b.Life--
			if b.Life <= 0 {
				dead = true
				if b.Kind == "frag" {
					g.detonate(b)
				} else if b.Kind != "shard" {
					g.events = append(g.events, Event{"type": "poof", "x": b.X, "y": b.Y})
				}
			}
		}
		if dead || b.dead {
			b.dead = true
			o := g.Tank(b.Owner)
			if o != nil && b.Kind == "bullet" {
				o.BulletsFired--
			}
			if b.Kind == "homing" {
				g.finishWeapon(o)
			}
		} else {
			survivors = append(survivors, b)
		}
	}
	g.Bullets = survivors
	if shardHits > 0 {
		g.events = append(g.events, Event{"type": "shardwall", "n": shardHits})
	}

	g.CrateTimer--
	if g.CrateTimer <= 0 {
		g.spawnCrate()
	}

	switch {
	case len(g.tanks) >= 2:
		alive := 0
		var winner *Tank
		for _, t := range g.tanks {
			if t.Alive {
				alive++
				winner = t
			}
		}
		if g.EndCount < 0 && alive <= 1 {
			g.EndCount = framesBeforeEnd
		}
		if g.EndCount > 0 {
			g.EndCount--
			if g.EndCount == 0 {
				if alive == 1 {
					if p := g.Player(winner.ID); p != nil {
						p.Score++
					}
					g.events = append(g.events, Event{"type": "win", "id": winner.ID})
				} else {
					g.events = append(g.events, Event{"type": "draw"})
				}
				g.NewRound()
			}
		}
	case len(g.tanks) == 1 && len(g.players) == 1:
		if !g.tanks[0].Alive {
			if g.EndCount < 0 {
				g.EndCount = framesBeforeEnd
			} else {
				g.EndCount--
				if g.EndCount == 0 {
					g.NewRound()
				}
			}
		}
	case len(g.players) >= 2 && len(g.tanks) < 2:
		g.NewRound()
	}
}

func (g *Game) DrainEvents() []Event {
	e := g.events
	g.events = nil
	return e
}
