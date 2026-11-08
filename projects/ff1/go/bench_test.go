package ff1

import "testing"

func benchCrypt(b *testing.B, radix, n int) {
	key := make([]byte, 16)
	tw := []byte{0, 1, 2, 3, 4, 5, 6, 7}
	c, _ := New(key, radix)
	x := make([]uint16, n)
	for i := range x {
		x[i] = uint16((7*i + 3) % radix)
	}
	y := make([]uint16, n)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = c.EncryptTo(tw, x, y)
		x, y = y, x
	}
}

func BenchmarkPAN(b *testing.B)   { benchCrypt(b, 10, 16) }
func BenchmarkToken(b *testing.B) { benchCrypt(b, 36, 32) }
func BenchmarkLong(b *testing.B)  { benchCrypt(b, 10, 128) }
