// Package ff1 implements NIST SP 800-38G FF1 format-preserving encryption
// with AES as the underlying block cipher.
//
// The structure follows BouncyCastle's SP80038G.encFF1/decFF1 (P block,
// Q block, CBC-MAC PRF, S-block expansion, modular add/sub) with three
// optimizations that are applied identically in every language port in this
// repository:
//
//  1. CIPH_K(P) is computed once per call; each round's PRF then only
//     CBC-MACs Q, chained from that block (same result as PRF(P || Q)).
//  2. The two Feistel halves are kept as integers across all ten rounds, so
//     NUM_radix / STR_radix run once on entry and once on exit rather than
//     every round.
//  3. radix^u and radix^v are computed once per call.
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
	MinRadix = 2
	MaxRadix = 1 << 16
	// minDomain is the NIST requirement radix^minlen >= 1,000,000.
	minDomain = 1000000
	blockSize = 16
)

var (
	ErrRadix  = errors.New("ff1: radix must be in [2, 65536]")
	ErrLength = errors.New("ff1: input length out of range (radix^n must be >= 1000000)")
	ErrDigit  = errors.New("ff1: digit out of range for radix")
	ErrKey    = errors.New("ff1: key must be 16, 24 or 32 bytes")
)

// Cipher is an FF1 instance bound to one AES key and radix. It is not safe
// for concurrent use (it reuses scratch buffers).
type Cipher struct {
	block cipher.Block
	radix int
	big   *big.Int
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
	b, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return &Cipher{block: b, radix: radix, big: big.NewInt(int64(radix))}, nil
}

// Encrypt encrypts the numeral string x (each element a digit < radix) under
// tweak and returns a new numeral string of the same length.
func (c *Cipher) Encrypt(tweak []byte, x []uint16) ([]uint16, error) {
	return c.crypt(tweak, x, true)
}

// Decrypt reverses Encrypt.
func (c *Cipher) Decrypt(tweak []byte, x []uint16) ([]uint16, error) {
	return c.crypt(tweak, x, false)
}

func (c *Cipher) checkLength(n int) error {
	if n < 2 || n > 1<<31-1 {
		return ErrLength
	}
	// radix^n >= 1e6
	p := uint64(1)
	for i := 0; i < n; i++ {
		p *= uint64(c.radix)
		if p >= minDomain {
			return nil
		}
	}
	return ErrLength
}

// calcB returns b = ceil(ceil(v*log2(radix))/8) exactly, as BouncyCastle does:
// count the power-of-two part of the radix directly and take the bit length
// of oddPart^v for the rest.
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

func (c *Cipher) crypt(T []byte, x []uint16, enc bool) ([]uint16, error) {
	n := len(x)
	if err := c.checkLength(n); err != nil {
		return nil, err
	}
	for _, d := range x {
		if int(d) >= c.radix {
			return nil, ErrDigit
		}
	}
	t := len(T)
	u := n / 2
	v := n - u
	b := calcB(c.radix, v)
	d := (b + 7) &^ 3 // 4*ceil(b/4) + 4

	// P = [1]^1 [2]^1 [1]^1 [radix]^3 [10]^1 [u mod 256]^1 [n]^4 [t]^4
	var P [blockSize]byte
	P[0], P[1], P[2] = 1, 2, 1
	P[3] = byte(c.radix >> 16)
	P[4] = byte(c.radix >> 8)
	P[5] = byte(c.radix)
	P[6] = 10
	P[7] = byte(u)
	binary.BigEndian.PutUint32(P[8:], uint32(n))
	binary.BigEndian.PutUint32(P[12:], uint32(t))
	var encP [blockSize]byte
	c.block.Encrypt(encP[:], P[:])

	// Q = T || [0]^((-t-b-1) mod 16) || [i]^1 || [NUM(B)]^b
	zeros := (-(t + b + 1)) & 15
	Q := make([]byte, t+zeros+1+b)
	copy(Q, T)
	roundIdx := t + zeros
	numOff := roundIdx + 1

	nBlocks := (d + blockSize - 1) / blockSize
	S := make([]byte, nBlocks*blockSize)

	modU := new(big.Int).Exp(c.big, big.NewInt(int64(u)), nil)
	modV := modU
	if v != u {
		modV = new(big.Int).Mul(modU, c.big)
	}

	A := c.num(x[:u])
	B := c.num(x[u:])
	y := new(big.Int)

	// prf computes S from Q and returns y = NUM_2(S[:d]).
	prf := func(i int, num *big.Int) *big.Int {
		Q[roundIdx] = byte(i)
		num.FillBytes(Q[numOff:])
		var R [blockSize]byte
		copy(R[:], encP[:])
		for off := 0; off < len(Q); off += blockSize {
			for k := 0; k < blockSize; k++ {
				R[k] ^= Q[off+k]
			}
			c.block.Encrypt(R[:], R[:])
		}
		copy(S, R[:])
		// S = R || CIPH(R xor [1]^16) || CIPH(R xor [2]^16) || ...
		// j < 2^32 so only the last four bytes change (BouncyCastle trick).
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
			yy := prf(i, B)
			mod := modU
			if i&1 == 1 {
				mod = modV
			}
			// c = (NUM(A) + y) mod radix^m ; A = B ; B = C
			A.Add(A, yy)
			A.Mod(A, mod)
			A, B = B, A
		}
	} else {
		for i := 9; i >= 0; i-- {
			yy := prf(i, A)
			mod := modU
			if i&1 == 1 {
				mod = modV
			}
			// c = (NUM(B) - y) mod radix^m ; B = A ; A = C
			B.Sub(B, yy)
			B.Mod(B, mod) // Euclidean modulus: result is non-negative
			A, B = B, A
		}
	}

	out := make([]uint16, n)
	c.str(A, out[:u])
	c.str(B, out[u:])
	return out, nil
}

// groupLen returns how many radix digits fit in a uint64 group and radix^g.
func (c *Cipher) groupLen() (int, uint64) {
	g := 0
	p := uint64(1)
	r := uint64(c.radix)
	for {
		hi, lo := bits.Mul64(p, r)
		if hi != 0 {
			break
		}
		p = lo
		g++
	}
	return g, p
}

// num computes NUM_radix(x), processing digits in machine-word groups
// (the idea behind BouncyCastle's RadixConverter).
func (c *Cipher) num(x []uint16) *big.Int {
	g, _ := c.groupLen()
	res := new(big.Int)
	tmp := new(big.Int)
	mul := new(big.Int)
	r := uint64(c.radix)
	for i := 0; i < len(x); {
		end := i + g
		if end > len(x) {
			end = len(x)
		}
		var acc uint64
		p := uint64(1)
		for ; i < end; i++ {
			acc = acc*r + uint64(x[i])
			p *= r
		}
		res.Mul(res, mul.SetUint64(p))
		res.Add(res, tmp.SetUint64(acc))
	}
	return res
}

// str writes STR^m_radix(v) into out (m = len(out)), most significant first.
func (c *Cipher) str(v *big.Int, out []uint16) {
	g, gp := c.groupLen()
	r := uint64(c.radix)
	q := new(big.Int).Set(v)
	rem := new(big.Int)
	div := new(big.Int).SetUint64(gp)
	i := len(out) - 1
	for i >= 0 {
		q.QuoRem(q, div, rem)
		w := rem.Uint64()
		for k := 0; k < g && i >= 0; k++ {
			out[i] = uint16(w % r)
			w /= r
			i--
		}
	}
}
