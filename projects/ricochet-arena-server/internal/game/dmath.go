package game

// Deterministic trigonometry, a line-by-line port of public/shared/dmath.js.
// Built only from + - * / and sqrt so results are bit-identical to the browser
// (which predicts its own tank with the JavaScript version).
//
// Every product that is added to something is wrapped in float64(...): the Go
// spec lets compilers fuse x*y+z into one FMA instruction on some CPUs (arm64),
// which would change the last bit. An explicit conversion forbids that.

import "math"

const (
	pio2Hi    = 1.57079632673412561417e+00
	pio2Lo    = 6.07710050650619224932e-11
	twoOverPi = 6.36619772367581382433e-01
)

// PI as JavaScript's Math.PI (a rounded double, never an exact constant).
var PI = float64(3.141592653589793)

// jsRound is JavaScript's Math.round: halves round toward +Infinity.
func jsRound(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	return r
}

func ksin(x float64) float64 {
	z := float64(x * x)
	p := float64(z * 1.58969099521155010221e-10)
	p = float64(z * (-2.50507602534068634195e-08 + p))
	p = float64(z * (2.75573137070700676789e-06 + p))
	p = float64(z * (-1.98412698298579493134e-04 + p))
	p = float64(z * (8.33333333332248946124e-03 + p))
	p = -1.66666666666666324348e-01 + p
	return x + float64(float64(x*z)*p)
}

func kcos(x float64) float64 {
	z := float64(x * x)
	p := float64(z * -1.13596475577881948265e-11)
	p = float64(z * (2.08757232129817482790e-09 + p))
	p = float64(z * (-2.75573143513906633035e-07 + p))
	p = float64(z * (2.48015872894767294178e-05 + p))
	p = float64(z * (-1.38888888888741095749e-03 + p))
	p = 4.16666666666666019037e-02 + p
	return 1 - float64(0.5*z) + float64(float64(z*z)*p)
}

func reduce(x float64) (float64, int) {
	k := jsRound(float64(x * twoOverPi))
	r := (x - float64(k*pio2Hi)) - float64(k*pio2Lo)
	n := int(math.Mod(math.Mod(k, 4)+4, 4))
	return r, n
}

func Sin(x float64) float64 {
	r, n := reduce(x)
	switch n {
	case 0:
		return ksin(r)
	case 1:
		return kcos(r)
	case 2:
		return -ksin(r)
	}
	return -kcos(r)
}

func Cos(x float64) float64 {
	r, n := reduce(x)
	switch n {
	case 0:
		return kcos(r)
	case 1:
		return -ksin(r)
	case 2:
		return -kcos(r)
	}
	return ksin(r)
}

var atanHi = [4]float64{4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00}
var atanLo = [4]float64{2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17}
var aT = [11]float64{3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01,
	9.09088713343650656196e-02, -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02,
	4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02}

func Atan(v float64) float64 {
	neg := v < 0
	x := v
	if neg {
		x = -v
	}
	id := -1
	switch {
	case x < 0.4375:
	case x < 0.6875:
		id, x = 0, (float64(2*x)-1)/(2+x)
	case x < 1.1875:
		id, x = 1, (x-1)/(x+1)
	case x < 2.4375:
		id, x = 2, (x-1.5)/(1+float64(1.5*x))
	default:
		id, x = 3, -1/x
	}
	z := float64(x * x)
	w := float64(z * z)
	s1 := float64(z * (aT[0] + float64(w*(aT[2]+float64(w*(aT[4]+float64(w*(aT[6]+float64(w*(aT[8]+float64(w*aT[10]))))))))))
	s2 := float64(w * (aT[1] + float64(w*(aT[3]+float64(w*(aT[5]+float64(w*(aT[7]+float64(w*aT[9])))))))))
	var r float64
	if id < 0 {
		r = x - float64(x*(s1+s2))
	} else {
		r = atanHi[id] - ((float64(x*(s1+s2)) - atanLo[id]) - x)
	}
	if neg {
		return -r
	}
	return r
}

func Atan2(y, x float64) float64 {
	if x > 0 {
		return Atan(y / x)
	}
	if x < 0 {
		if y >= 0 {
			return Atan(y/x) + PI
		}
		return Atan(y/x) - PI
	}
	if y > 0 {
		return PI / 2
	}
	if y < 0 {
		return -PI / 2
	}
	return 0
}

func Hypot(x, y float64) float64 { return math.Sqrt(float64(x*x) + float64(y*y)) }
