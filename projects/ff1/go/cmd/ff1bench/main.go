// Command ff1bench runs the cross-language FF1 benchmark protocol
// (see ../../../bench/PROTOCOL.md) for this Go implementation or for the
// github.com/capitalone/fpe baseline.
//
//	ff1bench <ours|capitalone> <radix> <n> <keybits> <tweaklen>
package main

import (
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	capff1 "github.com/capitalone/fpe/ff1"
	ff1 "github.com/vibatwork/second-vibe/projects/ff1/go"
)

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"

func envF(name string, def float64) float64 {
	if s := os.Getenv(name); s != "" {
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return f
		}
	}
	return def
}

// measure runs f chained (x = f(x)) and returns the median ns/op.
func measure(f func()) float64 {
	warm := time.Duration(envF("FF1_WARMUP", 1.0) * float64(time.Second))
	sample := envF("FF1_SAMPLE", 0.25)
	nSamples := int(envF("FF1_SAMPLES", 7))
	start := time.Now()
	count := 0
	for time.Since(start) < warm {
		f()
		count++
	}
	perSample := int(float64(count) * sample / warm.Seconds())
	if perSample < 1 {
		perSample = 1
	}
	res := make([]float64, nSamples)
	for s := range res {
		t0 := time.Now()
		for i := 0; i < perSample; i++ {
			f()
		}
		res[s] = float64(time.Since(t0).Nanoseconds()) / float64(perSample)
	}
	sort.Float64s(res)
	return res[nSamples/2]
}

func main() {
	if len(os.Args) != 6 {
		fmt.Fprintln(os.Stderr, "usage: ff1bench <ours|capitalone> radix n keybits tweaklen")
		os.Exit(2)
	}
	impl := os.Args[1]
	radix, _ := strconv.Atoi(os.Args[2])
	n, _ := strconv.Atoi(os.Args[3])
	keybits, _ := strconv.Atoi(os.Args[4])
	tlen, _ := strconv.Atoi(os.Args[5])

	key := make([]byte, keybits/8)
	for i := range key {
		key[i] = byte(i)
	}
	tweak := make([]byte, tlen)
	for i := range tweak {
		tweak[i] = byte(i)
	}
	pt := make([]uint16, n)
	for i := range pt {
		pt[i] = uint16((i*7 + 3) % radix)
	}

	var enc, dec func()
	var ctStr string
	var ok bool

	switch impl {
	case "ours":
		c, err := ff1.New(key, radix)
		if err != nil {
			panic(err)
		}
		ct, err := c.Encrypt(tweak, pt)
		if err != nil {
			panic(err)
		}
		back, _ := c.Decrypt(tweak, ct)
		ok = fmt.Sprint(back) == fmt.Sprint(pt)
		ctStr = digits(ct)
		// Allocation-free API, chained through two buffers.
		x, x2 := append([]uint16(nil), pt...), make([]uint16, n)
		enc = func() { _ = c.EncryptTo(tweak, x, x2); x, x2 = x2, x }
		y, y2 := append([]uint16(nil), ct...), make([]uint16, n)
		dec = func() { _ = c.DecryptTo(tweak, y, y2); y, y2 = y2, y }
	case "capitalone":
		c, err := capff1.NewCipher(radix, tlen, key, tweak)
		if err != nil {
			panic(err)
		}
		ptS := digits(pt)
		ct, err := c.Encrypt(ptS)
		if err != nil {
			panic(err)
		}
		back, _ := c.Decrypt(ct)
		ok = back == ptS
		ctStr = ct
		x := ptS
		enc = func() { x, _ = c.Encrypt(x) }
		y := ct
		dec = func() { y, _ = c.Decrypt(y) }
	default:
		fmt.Fprintln(os.Stderr, "unknown impl", impl)
		os.Exit(2)
	}
	if !ok {
		fmt.Fprintln(os.Stderr, "round trip failed")
		os.Exit(1)
	}
	name := "go"
	if impl == "capitalone" {
		name = "go-capitalone"
	}
	for _, op := range []struct {
		name string
		f    func()
	}{{"encrypt", enc}, {"decrypt", dec}} {
		ns := measure(op.f)
		fmt.Printf("%s,%d,%d,%d,%d,%s,%.1f,%s\n", name, radix, n, keybits, tlen, op.name, ns, ctStr)
	}
}

func digits(x []uint16) string {
	var sb strings.Builder
	for _, d := range x {
		sb.WriteByte(alphabet[d])
	}
	return sb.String()
}
