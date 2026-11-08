// Package ff1 implements NIST SP 800-38G FF1 format-preserving encryption
// with AES as the underlying block cipher.
//
// The structure follows BouncyCastle's SP80038G.encFF1/decFF1. Optimizations
// (shared with the other ports in this repository):
//
//  1. Per-(n, tweak length) values (b, d, CIPH_K(P), radix^u, radix^v) are
//     cached on the Cipher, so repeated calls with the same length skip setup.
//  2. Q blocks made only of tweak/zero bytes are identical every round; their
//     CBC-MAC is computed once per call and each round continues from it.
//  3. Feistel halves stay numbers across rounds (NUM/STR only at entry/exit).
//  4. Fast path when radix^v < 2^96: halves are (hi, lo) uint64 pairs, the
//     single varying Q block is one 128-bit XOR, S = R (d <= 16), and the
//     modular reduction is a hardware 128/64 divide (bits.Rem64) or a
//     Möller–Granlund 3-by-2 reciprocal division for moduli >= 2^64.
//     Larger domains use math/big.
//  5. Digit extraction divides by the radix with a precomputed reciprocal.
package ff1

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/binary"
	"errors"
	"math/big"
	"math/bits"
)

const (
	MinRadix  = 2
	MaxRadix  = 1 << 16
	minDomain = 1000000 // NIST requirement radix^minlen >= 1,000,000
	blockSize = 16
)

var (
	ErrRadix  = errors.New("ff1: radix must be in [2, 65536]")
	ErrLength = errors.New("ff1: input length out of range (radix^n must be >= 1000000)")
	ErrDigit  = errors.New("ff1: digit out of range for radix")
	ErrKey    = errors.New("ff1: key must be 16, 24 or 32 bytes")
)

// u128 is an unsigned 128-bit integer as two words.
type u128 struct{ hi, lo uint64 }

func (a u128) less(b u128) bool { return a.hi < b.hi || (a.hi == b.hi && a.lo < b.lo) }

func (a u128) add(b u128) u128 {
	lo, c := bits.Add64(a.lo, b.lo, 0)
	hi, _ := bits.Add64(a.hi, b.hi, c)
	return u128{hi, lo}
}

func (a u128) sub(b u128) u128 {
	lo, c := bits.Sub64(a.lo, b.lo, 0)
	hi, _ := bits.Sub64(a.hi, b.hi, c)
	return u128{hi, lo}
}

// recip reduces modulo an invariant modulus m < 2^96.
type recip struct {
	m    u128
	wide bool   // m >= 2^64
	s    uint   // normalization shift (wide only)
	d    u128   // m << s
	v    uint64 // floor((2^192-1)/d) - 2^64
}

func newRecip(m u128) recip {
	r := recip{m: m}
	if m.hi == 0 {
		return r
	}
	r.wide = true
	r.s = uint(bits.LeadingZeros64(m.hi))
	r.d = u128{m.hi<<r.s | m.lo>>(64-r.s), m.lo << r.s}
	if r.s == 0 {
		r.d = m
	}
	// Restoring long division of 2^192-1 by d (once per length).
	var rem u128
	var q uint64
	for bit := 191; bit >= 0; bit-- {
		top := rem.hi >> 63
		rem = u128{rem.hi<<1 | rem.lo>>63, rem.lo<<1 | 1}
		ge := top != 0 || !rem.less(r.d)
		if ge {
			rem = rem.sub(r.d)
		}
		if bit < 64 {
			q <<= 1
			if ge {
				q |= 1
			}
		}
	}
	r.v = q
	return r
}

func (r *recip) rem(y u128) u128 {
	if !r.wide {
		return u128{0, bits.Rem64(y.hi, y.lo, r.m.lo)} // hardware DIVQ
	}
	s := r.s
	var u2, u1, u0 uint64
	if s == 0 {
		u1, u0 = y.hi, y.lo
	} else {
		u2, u1, u0 = y.hi>>(64-s), y.hi<<s|y.lo>>(64-s), y.lo<<s
	}
	d1, d0 := r.d.hi, r.d.lo
	qh, ql := bits.Mul64(r.v, u2)
	ql, c := bits.Add64(ql, u1, 0)
	qh, _ = bits.Add64(qh, u2, c)
	q1, q0 := qh, ql
	r1 := u1 - q1*d1
	th, tl := bits.Mul64(d0, q1)
	rr := u128{r1, u0}.sub(u128{th, tl}).sub(r.d)
	if rr.hi >= q0 {
		rr = rr.add(r.d)
	}
	if !rr.less(r.d) {
		rr = rr.sub(r.d)
	}
	if s == 0 {
		return rr
	}
	return u128{rr.hi >> s, rr.lo>>s | rr.hi<<(64-s)}
}

type params struct {
	n, t, u, v, b, d int
	encP             [blockSize]byte
	fast             bool
	ru, rv           recip
	bigU, bigV       *big.Int
}

// Cipher is an FF1 instance bound to one AES key and radix. It is not safe
// for concurrent use (it caches per-length parameters and scratch buffers).
type Cipher struct {
	block      cipher.Block
	radix      int
	groupLen   int
	groupPow   uint64
	magic      uint64
	forceBig   bool
	p          *params
	a, b, y, t *big.Int
	vbuf, sbuf []byte
	x, blk     [blockSize]byte // scratch: kept on the struct so they don't escape per call
}

// New creates an FF1 cipher for the given AES key and radix.
func New(key []byte, radix int) (*Cipher, error) {
	if radix < MinRadix || radix > MaxRadix {
		return nil, ErrRadix
	}
	switch len(key) {
	case 16, 24, 32:
	default:
		return nil, ErrKey
	}
	blk, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	c := &Cipher{block: blk, radix: radix, a: new(big.Int), b: new(big.Int), y: new(big.Int), t: new(big.Int)}
	c.groupPow = 1
	for c.groupPow <= (1<<63-1)/uint64(radix) { // keep groups < 2^63
		c.groupPow *= uint64(radix)
		c.groupLen++
	}
	c.magic = ^uint64(0)/uint64(radix) + 1 // ceil(2^64 / radix)
	return c, nil
}

// Encrypt encrypts the numeral string x (each element a digit < radix) under
// tweak and returns a new numeral string of the same length.
func (c *Cipher) Encrypt(tweak []byte, x []uint16) ([]uint16, error) {
	out := make([]uint16, len(x))
	return out, c.crypt(tweak, x, out, true)
}

// Decrypt reverses Encrypt.
func (c *Cipher) Decrypt(tweak []byte, x []uint16) ([]uint16, error) {
	out := make([]uint16, len(x))
	return out, c.crypt(tweak, x, out, false)
}

// EncryptTo is Encrypt writing into out (len(out) == len(x); may alias x).
func (c *Cipher) EncryptTo(tweak []byte, x, out []uint16) error { return c.crypt(tweak, x, out, true) }

// DecryptTo is Decrypt writing into out (len(out) == len(x); may alias x).
func (c *Cipher) DecryptTo(tweak []byte, x, out []uint16) error { return c.crypt(tweak, x, out, false) }

func (c *Cipher) checkLength(n int) error {
	if n < 2 || n > 1<<31-1 {
		return ErrLength
	}
	p := uint64(1)
	for i := 0; i < n; i++ {
		p *= uint64(c.radix)
		if p >= minDomain {
			return nil
		}
	}
	return ErrLength
}

func (c *Cipher) makeParams(n, t int) *params {
	p := &params{n: n, t: t, u: n / 2}
	p.v = n - p.u
	r := uint64(c.radix)
	// radix^v < 2^96 ?
	pv, ok := u128{0, 1}, !c.forceBig
	for k := 0; k < p.v && ok; k++ {
		hi1, lo := bits.Mul64(pv.lo, r)
		hi := pv.hi*r + hi1
		ok = pv.hi*r/r == pv.hi && hi>>32 == 0
		pv = u128{hi, lo}
	}
	if ok {
		pu := u128{0, 1}
		for k := 0; k < p.u; k++ {
			hi1, lo := bits.Mul64(pu.lo, r)
			pu = u128{pu.hi*r + hi1, lo}
		}
		p.fast = true
		p.ru, p.rv = newRecip(pu), newRecip(pv)
		m1 := pv.sub(u128{0, 1})
		nb := 64 - bits.LeadingZeros64(m1.lo)
		if m1.hi != 0 {
			nb = 128 - bits.LeadingZeros64(m1.hi)
		}
		p.b = (nb + 7) / 8
	} else {
		br := big.NewInt(int64(c.radix))
		p.bigU = new(big.Int).Exp(br, big.NewInt(int64(p.u)), nil)
		p.bigV = p.bigU
		if p.v != p.u {
			p.bigV = new(big.Int).Mul(p.bigU, br)
		}
		m1 := new(big.Int).Sub(p.bigV, big.NewInt(1))
		p.b = (m1.BitLen() + 7) / 8
	}
	p.d = (p.b + 7) &^ 3
	var P [blockSize]byte
	P[0], P[1], P[2] = 1, 2, 1
	P[3], P[4], P[5] = byte(c.radix>>16), byte(c.radix>>8), byte(c.radix)
	P[6], P[7] = 10, byte(p.u)
	binary.BigEndian.PutUint32(P[8:], uint32(n))
	binary.BigEndian.PutUint32(P[12:], uint32(t))
	c.block.Encrypt(p.encP[:], P[:])
	return p
}

func (c *Cipher) crypt(T []byte, x, out []uint16, enc bool) error {
	n, t := len(x), len(T)
	if len(out) != n {
		return ErrLength
	}
	p := c.p
	cached := p != nil && p.n == n && p.t == t
	if !cached {
		if err := c.checkLength(n); err != nil {
			return err
		}
	}
	for _, d := range x {
		if int(d) >= c.radix {
			return ErrDigit
		}
	}
	if !cached {
		p = c.makeParams(n, t)
		c.p = p
	}
	zeros := (-(t + p.b + 1)) & 15
	roundIdx := t + zeros
	// CBC-MAC state after P and all Q blocks that hold only tweak/zero bytes.
	X := &c.x
	*X = p.encP
	off := 0
	for ; off+blockSize <= roundIdx; off += blockSize {
		for j := 0; j < blockSize; j++ {
			if k := off + j; k < t {
				X[j] ^= T[k]
			}
		}
		c.block.Encrypt(X[:], X[:])
	}
	if p.fast {
		var cb [blockSize]byte
		for j := 0; j < blockSize; j++ {
			if k := off + j; k < roundIdx && k < t {
				cb[j] = T[k]
			}
		}
		xc := u128{binary.BigEndian.Uint64(X[:8]) ^ binary.BigEndian.Uint64(cb[:8]),
			binary.BigEndian.Uint64(X[8:]) ^ binary.BigEndian.Uint64(cb[8:])}
		c.cryptFast(p, xc, x, out, enc)
		return nil
	}
	c.cryptBig(p, T, X, off, roundIdx, x, out, enc)
	return nil
}

func shl128(x uint64, s uint) u128 { // x << s, s < 128
	if s >= 64 {
		return u128{x << (s - 64), 0}
	}
	if s == 0 {
		return u128{0, x}
	}
	return u128{x >> (64 - s), x << s}
}

func (c *Cipher) cryptFast(p *params, xc u128, x, out []uint16, enc bool) {
	ishift := uint(8 * p.b)
	yshift := uint(128 - 8*p.d) // in [0, 64]
	A := c.num128(x[:p.u])
	B := c.num128(x[p.u:])
	blk := &c.blk
	prf := func(i int, src u128) u128 {
		iv := shl128(uint64(i), ishift)
		binary.BigEndian.PutUint64(blk[:8], xc.hi^iv.hi^src.hi)
		binary.BigEndian.PutUint64(blk[8:], xc.lo^iv.lo^src.lo)
		c.block.Encrypt(blk[:], blk[:])
		hi, lo := binary.BigEndian.Uint64(blk[:8]), binary.BigEndian.Uint64(blk[8:])
		switch {
		case yshift == 0:
			return u128{hi, lo}
		case yshift == 64:
			return u128{0, hi}
		default:
			return u128{hi >> yshift, lo>>yshift | hi<<(64-yshift)}
		}
	}
	if enc {
		for i := 0; i < 10; i++ {
			rc := &p.ru
			if i&1 == 1 {
				rc = &p.rv
			}
			y := rc.rem(prf(i, B))
			cc := A.add(y)
			if !cc.less(rc.m) {
				cc = cc.sub(rc.m)
			}
			A, B = B, cc
		}
	} else {
		for i := 9; i >= 0; i-- {
			rc := &p.ru
			if i&1 == 1 {
				rc = &p.rv
			}
			y := rc.rem(prf(i, A))
			var cc u128
			if B.less(y) {
				cc = B.add(rc.m.sub(y))
			} else {
				cc = B.sub(y)
			}
			A, B = cc, A
		}
	}
	c.str128(A, out[:p.u])
	c.str128(B, out[p.u:])
}

func (c *Cipher) cryptBig(p *params, T []byte, X *[blockSize]byte, off, roundIdx int, x, out []uint16, enc bool) {
	b, d := p.b, p.d
	qlen := roundIdx + 1 + b
	vlen := qlen - off
	if cap(c.vbuf) < vlen {
		c.vbuf = make([]byte, vlen)
	}
	V := c.vbuf[:vlen]
	for k := range V {
		V[k] = 0
		if j := off + k; j < roundIdx && j < len(T) {
			V[k] = T[j]
		}
	}
	ridx := roundIdx - off
	nBlocks := (d + blockSize - 1) / blockSize
	if cap(c.sbuf) < nBlocks*blockSize {
		c.sbuf = make([]byte, nBlocks*blockSize)
	}
	S := c.sbuf[:nBlocks*blockSize]
	A, B, y := c.num(c.a, x[:p.u]), c.num(c.b, x[p.u:]), c.y
	prf := func(i int, num *big.Int) *big.Int {
		V[ridx] = byte(i)
		num.FillBytes(V[ridx+1:])
		R := *X
		for o := 0; o < vlen; o += blockSize {
			for k := 0; k < blockSize; k++ {
				R[k] ^= V[o+k]
			}
			c.block.Encrypt(R[:], R[:])
		}
		copy(S, R[:])
		j0 := binary.BigEndian.Uint32(R[12:])
		for j := 1; j < nBlocks; j++ {
			blk := S[j*blockSize : (j+1)*blockSize]
			copy(blk, R[:12])
			binary.BigEndian.PutUint32(blk[12:], j0^uint32(j))
			c.block.Encrypt(blk, blk)
		}
		return y.SetBytes(S[:d])
	}
	if enc {
		for i := 0; i < 10; i++ {
			mod := p.bigU
			if i&1 == 1 {
				mod = p.bigV
			}
			A.Add(A, prf(i, B))
			A.Mod(A, mod)
			A, B = B, A
		}
	} else {
		for i := 9; i >= 0; i-- {
			mod := p.bigU
			if i&1 == 1 {
				mod = p.bigV
			}
			B.Sub(B, prf(i, A))
			B.Mod(B, mod) // Euclidean: non-negative
			A, B = B, A
		}
	}
	c.strBig(A, out[:p.u])
	c.strBig(B, out[p.u:])
}

// divRadix returns w / radix and w % radix for w < 2^63 using
// ceil(2^64/radix) and one correction step.
func (c *Cipher) divRadix(w uint64) (uint64, uint64) {
	q, _ := bits.Mul64(w, c.magic)
	r := w - q*uint64(c.radix)
	if r > w {
		q--
		r += uint64(c.radix)
	}
	return q, r
}

func (c *Cipher) strGroup(w uint64, out []uint16, i int) int {
	for k := 0; k < c.groupLen && i > 0; k++ {
		var r uint64
		w, r = c.divRadix(w)
		i--
		out[i] = uint16(r)
	}
	return i
}

func (c *Cipher) num128(x []uint16) u128 {
	r := uint64(c.radix)
	var res u128
	for i := 0; i < len(x); {
		end := min(i+c.groupLen, len(x))
		acc, pw := uint64(0), uint64(1)
		for ; i < end; i++ {
			acc = acc*r + uint64(x[i])
			pw *= r
		}
		hi1, lo := bits.Mul64(res.lo, pw)
		res = u128{res.hi*pw + hi1, lo}.add(u128{0, acc})
	}
	return res
}

func (c *Cipher) str128(v u128, out []uint16) {
	gp := c.groupPow
	i := len(out)
	for i > 0 {
		var w uint64
		if v.hi == 0 && v.lo < gp {
			w, v = v.lo, u128{}
		} else {
			qhi := v.hi / gp
			qlo, r := bits.Div64(v.hi%gp, v.lo, gp)
			v, w = u128{qhi, qlo}, r
		}
		i = c.strGroup(w, out, i)
	}
}

// num computes NUM_radix(x) into res using machine-word digit groups
// (the idea behind BouncyCastle's RadixConverter).
func (c *Cipher) num(res *big.Int, x []uint16) *big.Int {
	res.SetUint64(0)
	r := uint64(c.radix)
	for i := 0; i < len(x); {
		end := min(i+c.groupLen, len(x))
		acc, pw := uint64(0), uint64(1)
		for ; i < end; i++ {
			acc = acc*r + uint64(x[i])
			pw *= r
		}
		res.Mul(res, c.t.SetUint64(pw))
		res.Add(res, c.t.SetUint64(acc))
	}
	return res
}

// strBig writes STR^m_radix(v) into out (m = len(out)); destroys v.
func (c *Cipher) strBig(v *big.Int, out []uint16) {
	div := new(big.Int).SetUint64(c.groupPow)
	rem := new(big.Int)
	i := len(out)
	for i > 0 {
		v.QuoRem(v, div, rem)
		i = c.strGroup(rem.Uint64(), out, i)
	}
}

// calcB returns b = ceil(ceil(v*log2(radix))/8) exactly, as BouncyCastle does
// (kept for the exactness test; the cipher derives b from radix^v - 1).
func calcB(radix, v int) int {
	tz := bits.TrailingZeros(uint(radix))
	nbits := tz * v
	odd := radix >> tz
	if odd != 1 {
		p := new(big.Int).Exp(big.NewInt(int64(odd)), big.NewInt(int64(v)), nil)
		nbits += p.BitLen()
	}
	return (nbits + 7) / 8
}
