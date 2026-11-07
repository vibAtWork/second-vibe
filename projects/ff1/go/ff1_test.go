package ff1

import (
	"encoding/hex"
	"math/rand"
	"strings"
	"testing"
)

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"

func parse(s string) []uint16 {
	out := make([]uint16, len(s))
	for i, ch := range s {
		out[i] = uint16(strings.IndexRune(alphabet, ch))
	}
	return out
}

func format(x []uint16) string {
	var sb strings.Builder
	for _, d := range x {
		sb.WriteByte(alphabet[d])
	}
	return sb.String()
}

// NIST SP 800-38G FF1 samples 1-9.
var vectors = []struct {
	key, tweak string
	radix      int
	pt, ct     string
}{
	{"2B7E151628AED2A6ABF7158809CF4F3C", "", 10, "0123456789", "2433477484"},
	{"2B7E151628AED2A6ABF7158809CF4F3C", "39383736353433323130", 10, "0123456789", "6124200773"},
	{"2B7E151628AED2A6ABF7158809CF4F3C", "3737373770717273373737", 36, "0123456789abcdefghi", "a9tv40mll9kdu509eum"},
	{"2B7E151628AED2A6ABF7158809CF4F3CEF4359D8D580AA4F", "", 10, "0123456789", "2830668132"},
	{"2B7E151628AED2A6ABF7158809CF4F3CEF4359D8D580AA4F", "39383736353433323130", 10, "0123456789", "2496655549"},
	{"2B7E151628AED2A6ABF7158809CF4F3CEF4359D8D580AA4F", "3737373770717273373737", 36, "0123456789abcdefghi", "xbj3kv35jrawxv32ysr"},
	{"2B7E151628AED2A6ABF7158809CF4F3CEF4359D8D580AA4F7F036D6F04FC6A94", "", 10, "0123456789", "6657667009"},
	{"2B7E151628AED2A6ABF7158809CF4F3CEF4359D8D580AA4F7F036D6F04FC6A94", "39383736353433323130", 10, "0123456789", "1001623463"},
	{"2B7E151628AED2A6ABF7158809CF4F3CEF4359D8D580AA4F7F036D6F04FC6A94", "3737373770717273373737", 36, "0123456789abcdefghi", "xs8a0azh2avyalyzuwd"},
}

func TestNISTVectors(t *testing.T) {
	for i, v := range vectors {
		key, _ := hex.DecodeString(v.key)
		tw, _ := hex.DecodeString(v.tweak)
		c, err := New(key, v.radix)
		if err != nil {
			t.Fatal(err)
		}
		ct, err := c.Encrypt(tw, parse(v.pt))
		if err != nil {
			t.Fatal(err)
		}
		if got := format(ct); got != v.ct {
			t.Errorf("sample %d encrypt: got %s want %s", i+1, got, v.ct)
		}
		pt, err := c.Decrypt(tw, parse(v.ct))
		if err != nil {
			t.Fatal(err)
		}
		if got := format(pt); got != v.pt {
			t.Errorf("sample %d decrypt: got %s want %s", i+1, got, v.pt)
		}
	}
}

func TestRoundTripRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	radices := []int{2, 3, 10, 16, 26, 36, 62, 255, 256, 1000, 65535, 65536}
	for iter := 0; iter < 400; iter++ {
		radix := radices[iter%len(radices)]
		key := make([]byte, []int{16, 24, 32}[iter%3])
		rng.Read(key)
		tw := make([]byte, rng.Intn(40))
		rng.Read(tw)
		c, _ := New(key, radix)
		n := 2 + rng.Intn(150)
		x := make([]uint16, n)
		for i := range x {
			x[i] = uint16(rng.Intn(radix))
		}
		if c.checkLength(n) != nil {
			continue
		}
		ct, err := c.Encrypt(tw, x)
		if err != nil {
			t.Fatal(err)
		}
		pt, err := c.Decrypt(tw, ct)
		if err != nil {
			t.Fatal(err)
		}
		for i := range x {
			if pt[i] != x[i] {
				t.Fatalf("round trip mismatch radix=%d n=%d", radix, n)
			}
		}
	}
}

func TestCalcB(t *testing.T) {
	// Compare against the definition ceil(bitlen(radix^v - 1) / 8).
	for _, r := range []int{2, 3, 7, 8, 10, 16, 36, 64, 255, 256, 1000, 65536} {
		for v := 1; v < 80; v++ {
			want := (bitlenPowMinus1(r, v) + 7) / 8
			if got := calcB(r, v); got != want {
				t.Fatalf("calcB(%d,%d)=%d want %d", r, v, got, want)
			}
		}
	}
}

func bitlenPowMinus1(r, v int) int {
	c, _ := New(make([]byte, 16), r)
	pp := c.num(append([]uint16{1}, make([]uint16, v)...)) // radix^v
	pp.Sub(pp, c.num([]uint16{1}))
	return pp.BitLen()
}

func TestValidation(t *testing.T) {
	if _, err := New(make([]byte, 16), 1); err == nil {
		t.Error("radix 1 accepted")
	}
	if _, err := New(make([]byte, 15), 10); err == nil {
		t.Error("bad key accepted")
	}
	c, _ := New(make([]byte, 16), 10)
	if _, err := c.Encrypt(nil, parse("12345")); err == nil {
		t.Error("too-short input accepted (10^5 < 10^6)")
	}
	if _, err := c.Encrypt(nil, []uint16{1, 2, 3, 4, 5, 6, 10}); err == nil {
		t.Error("out-of-range digit accepted")
	}
}
