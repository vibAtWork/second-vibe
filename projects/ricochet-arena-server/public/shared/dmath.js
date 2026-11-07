// Deterministic trigonometry built only from + - * / and sqrt, which IEEE-754
// guarantees bit-identical on every JavaScript engine. Math.sin/cos/atan2 are
// "implementation-approximated" and can differ in the last bit between
// browsers, which would make a replayed game drift. Needed for cheat detection.
// Polynomial coefficients are the classic minimax ones used by fdlibm.

const PIO2_HI = 1.57079632673412561417e+00; // first 33 bits of pi/2
const PIO2_LO = 6.07710050650619224932e-11; // pi/2 - PIO2_HI
const TWO_OVER_PI = 6.36619772367581382433e-01;
export const PI = 3.141592653589793;

function ksin(x) {
  const z = x * x;
  return x + x * z * (-1.66666666666666324348e-01 + z * (8.33333333332248946124e-03 + z * (-1.98412698298579493134e-04 +
    z * (2.75573137070700676789e-06 + z * (-2.50507602534068634195e-08 + z * 1.58969099521155010221e-10)))));
}
function kcos(x) {
  const z = x * x;
  return 1 - 0.5 * z + z * z * (4.16666666666666019037e-02 + z * (-1.38888888888741095749e-03 + z * (2.48015872894767294178e-05 +
    z * (-2.75573143513906633035e-07 + z * (2.08757232129817482790e-09 + z * -1.13596475577881948265e-11)))));
}
function reduce(x) {
  const k = Math.round(x * TWO_OVER_PI);
  return [(x - k * PIO2_HI) - k * PIO2_LO, ((k % 4) + 4) % 4];
}
export function sin(x) {
  const [r, n] = reduce(x);
  return n === 0 ? ksin(r) : n === 1 ? kcos(r) : n === 2 ? -ksin(r) : -kcos(r);
}
export function cos(x) {
  const [r, n] = reduce(x);
  return n === 0 ? kcos(r) : n === 1 ? -ksin(r) : n === 2 ? -kcos(r) : ksin(r);
}

const ATAN_HI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
const ATAN_LO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT = [3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01,
  9.09088713343650656196e-02, -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02,
  4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02];
export function atan(v) {
  const neg = v < 0;
  let x = neg ? -v : v, id;
  if (x < 0.4375) id = -1;
  else if (x < 0.6875) { id = 0; x = (2 * x - 1) / (2 + x); }
  else if (x < 1.1875) { id = 1; x = (x - 1) / (x + 1); }
  else if (x < 2.4375) { id = 2; x = (x - 1.5) / (1 + 1.5 * x); }
  else { id = 3; x = -1 / x; }
  const z = x * x, w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  const r = id < 0 ? x - x * (s1 + s2) : ATAN_HI[id] - ((x * (s1 + s2) - ATAN_LO[id]) - x);
  return neg ? -r : r;
}
export function atan2(y, x) {
  if (x > 0) return atan(y / x);
  if (x < 0) return y >= 0 ? atan(y / x) + PI : atan(y / x) - PI;
  return y > 0 ? PI / 2 : y < 0 ? -PI / 2 : 0;
}
export function hypot(x, y) { return Math.sqrt(x * x + y * y); }
