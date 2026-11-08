//! NIST SP 800-38G FF1 format-preserving encryption with AES.
//!
//! The structure follows BouncyCastle's `SP80038G.encFF1/decFF1`. Optimizations
//! (shared with the other ports in this repository):
//!
//! 1. Per-(n, tweak length) values (b, d, `CIPH_K(P)`, radix^u, radix^v) are
//!    cached on the instance, so repeated calls with the same length skip setup.
//! 2. Q blocks made only of tweak/zero bytes are identical every round; their
//!    CBC-MAC is computed once per call and each round continues from it.
//! 3. Feistel halves stay numbers across rounds (NUM/STR only at entry/exit).
//! 4. Fast path when radix^v < 2^96: halves are `u128`, the single varying Q
//!    block is one 128-bit XOR, S = R (d <= 16), and the modular reduction is a
//!    hardware 128/64 divide (or a Möller–Granlund 3-by-2 reciprocal division
//!    for moduli >= 2^64).
//! 4b. Limb path up to 2^4096: fixed-width little-endian `u64` limb arrays on the
//!    stack, Knuth algorithm D for y mod radix^m, no allocation per round.
//!    `num-bigint` is only the fallback beyond that (and the test oracle).
//! 5. Digit extraction divides by the radix with a precomputed reciprocal.

use aes::cipher::{BlockCipherEncrypt, KeyInit};
use aes::{Aes128, Aes192, Aes256};
use num_bigint::BigUint;
use num_integer::Integer;
use num_traits::{ToPrimitive, Zero};
use std::fmt;

const BLOCK: usize = 16;
const MIN_DOMAIN: u64 = 1_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    Radix,
    Key,
    Length,
    Digit,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Error::Radix => "radix must be in [2, 65536]",
            Error::Key => "key must be 16, 24 or 32 bytes",
            Error::Length => "input length out of range (radix^n must be >= 1000000)",
            Error::Digit => "digit out of range for radix",
        };
        f.write_str(s)
    }
}

impl std::error::Error for Error {}

enum AnyAes {
    A128(Aes128),
    A192(Aes192),
    A256(Aes256),
}

impl AnyAes {
    #[inline(always)]
    fn encrypt(&self, buf: &mut [u8; BLOCK]) {
        let blk: &mut aes::Block = buf.into();
        match self {
            AnyAes::A128(c) => c.encrypt_block(blk),
            AnyAes::A192(c) => c.encrypt_block(blk),
            AnyAes::A256(c) => c.encrypt_block(blk),
        }
    }

    #[inline(always)]
    fn encrypt_u128(&self, x: u128) -> u128 {
        let mut b = x.to_be_bytes();
        self.encrypt(&mut b);
        u128::from_be_bytes(b)
    }
}

/// (hi:lo) / m with hi < m. Returns (quotient, remainder).
#[inline(always)]
fn divrem_128_64(hi: u64, lo: u64, m: u64) -> (u64, u64) {
    #[cfg(target_arch = "x86_64")]
    {
        let (q, r): (u64, u64);
        // SAFETY: hi < m guarantees the quotient fits in 64 bits (no #DE).
        unsafe {
            std::arch::asm!("div {m}", m = in(reg) m, inout("rax") lo => q, inout("rdx") hi => r,
                            options(pure, nomem, nostack));
        }
        (q, r)
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        let n = ((hi as u128) << 64) | lo as u128;
        ((n / m as u128) as u64, (n % m as u128) as u64)
    }
}

/// Precomputed reduction modulo an invariant modulus < 2^96.
#[derive(Clone, Copy)]
struct Recip {
    m: u128,
    s: u32,
    wide: bool,
    d: u128,
    v: u64,
}

impl Recip {
    fn new(m: u128) -> Self {
        if m >> 64 == 0 {
            let s = (m as u64).leading_zeros();
            Recip { m, s, wide: false, d: m << s, v: 0 }
        } else {
            let s = ((m >> 64) as u64).leading_zeros();
            let d = m << s;
            // v = floor((2^192 - 1) / d) - 2^64, by restoring long division (once per length).
            let (mut rem, mut q) = (0u128, 0u64);
            for bit in (0..192).rev() {
                let top = rem >> 127 != 0;
                rem = (rem << 1) | 1;
                let ge = top || rem >= d;
                if ge {
                    rem = rem.wrapping_sub(d);
                }
                if bit < 64 {
                    q = (q << 1) | ge as u64;
                }
            }
            Recip { m, s, wide: true, d, v: q }
        }
    }

    #[inline(always)]
    fn rem(&self, y: u128) -> u128 {
        let (hi, lo) = ((y >> 64) as u64, y as u64);
        if !self.wide {
            let m = self.m as u64;
            let hi = if hi >= m { hi % m } else { hi };
            return divrem_128_64(hi, lo, m).1 as u128;
        }
        // Möller–Granlund 3-by-2 division (remainder only).
        let s = self.s;
        let u2 = if s == 0 { 0 } else { hi >> (64 - s) };
        let u1 = (hi << s) | if s == 0 { 0 } else { lo >> (64 - s) };
        let u0 = lo << s;
        let d = self.d;
        let (d1, d0) = ((d >> 64) as u64, d as u64);
        let q = (self.v as u128) * (u2 as u128) + (((u2 as u128) << 64) | u1 as u128);
        let (q1, q0) = ((q >> 64) as u64, q as u64);
        let r1 = u1.wrapping_sub(q1.wrapping_mul(d1));
        let mut r = ((((r1 as u128) << 64) | u0 as u128).wrapping_sub((d0 as u128) * (q1 as u128)))
            .wrapping_sub(d);
        if (r >> 64) as u64 >= q0 {
            r = r.wrapping_add(d);
        }
        if r >= d {
            r -= d;
        }
        r >> s
    }
}

const MAXL: usize = 64;

/// A modulus for the limb path: little-endian limbs plus its normalized form.
struct LMod {
    n: usize,
    s: u32,
    m: [u64; MAXL],  // zero-padded to L limbs
    dn: [u64; MAXL], // m << s (n limbs)
}

impl LMod {
    fn new(m: &BigUint) -> Box<Self> {
        let digits = m.to_u64_digits();
        let mut lm = Box::new(LMod { n: digits.len(), s: 0, m: [0; MAXL], dn: [0; MAXL] });
        lm.m[..digits.len()].copy_from_slice(&digits);
        lm.s = lm.m[lm.n - 1].leading_zeros();
        for i in (0..lm.n).rev() {
            let lo = if lm.s != 0 && i > 0 { lm.m[i - 1] >> (64 - lm.s) } else { 0 };
            lm.dn[i] = (lm.m[i] << lm.s) | lo;
        }
        lm
    }

    /// r (L limbs) = y mod m, Knuth algorithm D (remainder only).
    fn rem(&self, y: &[u64], r: &mut [u64]) {
        let (n, s, ly) = (self.n, self.s, y.len());
        r.fill(0);
        if ly < n {
            r[..ly].copy_from_slice(y);
            return;
        }
        let mut un = [0u64; MAXL + 3];
        un[ly] = if s != 0 { y[ly - 1] >> (64 - s) } else { 0 };
        for i in (1..ly).rev() {
            un[i] = (y[i] << s) | if s != 0 { y[i - 1] >> (64 - s) } else { 0 };
        }
        un[0] = y[0] << s;
        let dn = &self.dn;
        let dtop = dn[n - 1];
        let dsec = if n >= 2 { dn[n - 2] } else { 0 };
        for j in (0..=ly - n).rev() {
            let (mut qhat, mut rhat): (u128, u128) = if un[j + n] < dtop {
                let (q, r) = divrem_128_64(un[j + n], un[j + n - 1], dtop);
                (q as u128, r as u128)
            } else {
                (u64::MAX as u128, un[j + n - 1] as u128 + dtop as u128)
            };
            let u2 = if j + n >= 2 { un[j + n - 2] } else { 0 };
            while rhat >> 64 == 0 && qhat * dsec as u128 > ((rhat << 64) | u2 as u128) {
                qhat -= 1;
                rhat += dtop as u128;
            }
            let (mut borrow, mut carry) = (0u64, 0u64);
            for i in 0..n {
                let pr = qhat * dn[i] as u128 + carry as u128;
                carry = (pr >> 64) as u64;
                let (t, b1) = un[i + j].overflowing_sub(pr as u64);
                let (t2, b2) = t.overflowing_sub(borrow);
                un[i + j] = t2;
                borrow = (b1 | b2) as u64;
            }
            let (t, b1) = un[j + n].overflowing_sub(carry);
            let (t2, b2) = t.overflowing_sub(borrow);
            un[j + n] = t2;
            if b1 | b2 {
                let mut cy = 0u64;
                for i in 0..n {
                    let sm = un[i + j] as u128 + dn[i] as u128 + cy as u128;
                    un[i + j] = sm as u64;
                    cy = (sm >> 64) as u64;
                }
                un[j + n] = un[j + n].wrapping_add(cy);
            }
        }
        for i in 0..n {
            r[i] = if s != 0 { (un[i] >> s) | (un[i + 1] << (64 - s)) } else { un[i] };
        }
    }
}

fn limb_geq(a: &[u64], b: &[u64]) -> bool {
    for i in (0..a.len()).rev() {
        if a[i] != b[i] {
            return a[i] > b[i];
        }
    }
    true
}

/// a = (a + r) mod m (all < m, same length).
fn limb_addmod(a: &mut [u64], r: &[u64], m: &[u64]) {
    let mut cy = false;
    for i in 0..a.len() {
        let (t, c1) = a[i].overflowing_add(r[i]);
        let (t2, c2) = t.overflowing_add(cy as u64);
        a[i] = t2;
        cy = c1 | c2;
    }
    if cy || limb_geq(a, m) {
        let mut bw = false;
        for i in 0..a.len() {
            let (t, b1) = a[i].overflowing_sub(m[i]);
            let (t2, b2) = t.overflowing_sub(bw as u64);
            a[i] = t2;
            bw = b1 | b2;
        }
    }
}

/// a = (a - r) mod m (all < m, same length).
fn limb_submod(a: &mut [u64], r: &[u64], m: &[u64]) {
    let mut bw = false;
    for i in 0..a.len() {
        let (t, b1) = a[i].overflowing_sub(r[i]);
        let (t2, b2) = t.overflowing_sub(bw as u64);
        a[i] = t2;
        bw = b1 | b2;
    }
    if bw {
        let mut cy = false;
        for i in 0..a.len() {
            let (t, c1) = a[i].overflowing_add(m[i]);
            let (t2, c2) = t.overflowing_add(cy as u64);
            a[i] = t2;
            cy = c1 | c2;
        }
    }
}

enum Moduli {
    Fast { mod_u: Recip, mod_v: Recip },
    Limb { l: usize, mod_u: Box<LMod>, mod_v: Box<LMod> },
    Big { mod_u: BigUint, mod_v: BigUint },
}

struct Params {
    n: usize,
    t: usize,
    u: usize,

    b: usize,
    d: usize,
    enc_p: [u8; BLOCK],
    moduli: Moduli,
}

/// An FF1 instance bound to one AES key and radix. Methods take `&mut self`
/// because the instance caches per-length parameters; use one per thread.
pub struct Ff1 {
    aes: AnyAes,
    radix: u32,
    group_len: usize,
    group_pow: u64,
    magic: u64,
    force_path: u8, // testing: 0 auto, 1 force limb path, 2 force num-bigint path
    params: Option<Params>,
}

impl Ff1 {
    pub fn new(key: &[u8], radix: u32) -> Result<Self, Error> {
        if !(2..=65536).contains(&radix) {
            return Err(Error::Radix);
        }
        let aes = match key.len() {
            16 => AnyAes::A128(Aes128::new_from_slice(key).map_err(|_| Error::Key)?),
            24 => AnyAes::A192(Aes192::new_from_slice(key).map_err(|_| Error::Key)?),
            32 => AnyAes::A256(Aes256::new_from_slice(key).map_err(|_| Error::Key)?),
            _ => return Err(Error::Key),
        };
        // Largest g with radix^g < 2^63 (BouncyCastle RadixConverter idea).
        let (mut g, mut p) = (0usize, 1u64);
        while p <= i64::MAX as u64 / radix as u64 {
            p *= radix as u64;
            g += 1;
        }
        let magic = u64::MAX / radix as u64 + 1; // ceil(2^64 / radix)
        Ok(Ff1 { aes, radix, group_len: g, group_pow: p, magic, force_path: 0, params: None })
    }

    pub fn encrypt(&mut self, tweak: &[u8], x: &[u16]) -> Result<Vec<u16>, Error> {
        let mut out = vec![0u16; x.len()];
        self.crypt(tweak, x, &mut out, true)?;
        Ok(out)
    }

    pub fn decrypt(&mut self, tweak: &[u8], x: &[u16]) -> Result<Vec<u16>, Error> {
        let mut out = vec![0u16; x.len()];
        self.crypt(tweak, x, &mut out, false)?;
        Ok(out)
    }

    /// Like [`encrypt`](Self::encrypt) but writes into `out` (same length as `x`).
    pub fn encrypt_into(&mut self, tweak: &[u8], x: &[u16], out: &mut [u16]) -> Result<(), Error> {
        self.crypt(tweak, x, out, true)
    }

    /// Like [`decrypt`](Self::decrypt) but writes into `out` (same length as `x`).
    pub fn decrypt_into(&mut self, tweak: &[u8], x: &[u16], out: &mut [u16]) -> Result<(), Error> {
        self.crypt(tweak, x, out, false)
    }

    fn check_length(&self, n: usize) -> Result<(), Error> {
        if n < 2 || n > u32::MAX as usize {
            return Err(Error::Length);
        }
        let mut p = 1u64;
        for _ in 0..n {
            p *= self.radix as u64;
            if p >= MIN_DOMAIN {
                return Ok(());
            }
        }
        Err(Error::Length)
    }

    fn make_params(&self, n: usize, t: usize) -> Params {
        let u = n / 2;
        let v = n - u;
        let r = self.radix as u128;
        let mut pv: Option<u128> = if self.force_path != 0 { None } else { Some(1) };
        for _ in 0..v {
            pv = pv.and_then(|p| p.checked_mul(r)).filter(|p| p >> 96 == 0);
        }
        let (b, moduli) = match pv {
            Some(pv) => {
                let pu = r.pow(u as u32);
                let b = (128 - (pv - 1).leading_zeros() as usize).div_ceil(8);
                (b, Moduli::Fast { mod_u: Recip::new(pu), mod_v: Recip::new(pv) })
            }
            None => {
                let big_r = BigUint::from(self.radix);
                let mod_u = big_r.pow(u as u32);
                let mod_v = if v != u { &mod_u * &big_r } else { mod_u.clone() };
                let b = ((&mod_v - 1u32).bits() as usize).div_ceil(8);
                let l = (mod_v.bits() as usize).div_ceil(64);
                if self.force_path != 2 && l <= MAXL {
                    (b, Moduli::Limb { l, mod_u: LMod::new(&mod_u), mod_v: LMod::new(&mod_v) })
                } else {
                    (b, Moduli::Big { mod_u, mod_v })
                }
            }
        };
        let d = (b + 7) & !3;
        let mut p = [0u8; BLOCK];
        p[0] = 1;
        p[1] = 2;
        p[2] = 1;
        p[3..6].copy_from_slice(&self.radix.to_be_bytes()[1..]);
        p[6] = 10;
        p[7] = u as u8;
        p[8..12].copy_from_slice(&(n as u32).to_be_bytes());
        p[12..16].copy_from_slice(&(t as u32).to_be_bytes());
        self.aes.encrypt(&mut p);
        Params { n, t, u, b, d, enc_p: p, moduli }
    }

    fn crypt(&mut self, tw: &[u8], x: &[u16], out: &mut [u16], enc: bool) -> Result<(), Error> {
        let n = x.len();
        let t = tw.len();
        assert_eq!(out.len(), n, "output length must equal input length");
        let cached = matches!(&self.params, Some(p) if p.n == n && p.t == t);
        if !cached {
            self.check_length(n)?;
            if t > u32::MAX as usize {
                return Err(Error::Length);
            }
        }
        if x.iter().any(|&d| d as u32 >= self.radix) {
            return Err(Error::Digit);
        }
        if !cached {
            self.params = Some(self.make_params(n, t));
        }
        let p = self.params.as_ref().unwrap();
        let zeros = (16 - (t + p.b + 1) % 16) % 16;
        let round_idx = t + zeros;
        // CBC-MAC state after P and all Q blocks that hold only tweak/zero bytes.
        let qconst = |k: usize| if k < t { tw[k] } else { 0 };
        let mut xs = p.enc_p;
        let mut var_off = 0;
        while var_off + BLOCK <= round_idx {
            for j in 0..BLOCK {
                xs[j] ^= qconst(var_off + j);
            }
            self.aes.encrypt(&mut xs);
            var_off += BLOCK;
        }
        match &p.moduli {
            Moduli::Fast { mod_u, mod_v } => {
                let mut cblk = [0u8; BLOCK];
                for (j, c) in cblk.iter_mut().enumerate() {
                    if var_off + j < round_idx {
                        *c = qconst(var_off + j);
                    }
                }
                let xc = u128::from_be_bytes(xs) ^ u128::from_be_bytes(cblk);
                self.crypt_fast(p, xc, x, out, enc, mod_u, mod_v);
            }
            Moduli::Limb { l, mod_u, mod_v } => {
                self.crypt_limb(p, &xs, var_off, round_idx, &qconst, x, out, enc, *l, mod_u, mod_v);
            }
            Moduli::Big { mod_u, mod_v } => {
                self.crypt_big(p, &xs, var_off, round_idx, &qconst, x, out, enc, mod_u, mod_v);
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    #[inline(always)]
    fn crypt_fast(&self, p: &Params, xc: u128, x: &[u16], out: &mut [u16], enc: bool, ru: &Recip, rv: &Recip) {
        let ishift = 8 * p.b as u32;
        let yshift = 128 - 8 * p.d as u32;
        let mut a = self.num128(&x[..p.u]);
        let mut b = self.num128(&x[p.u..]);
        if enc {
            for i in 0..10u32 {
                let r = self.aes.encrypt_u128(xc ^ ((i as u128) << ishift) ^ b);
                let rc = if i & 1 == 0 { ru } else { rv };
                let y = rc.rem(r >> yshift);
                let mut c = a + y;
                if c >= rc.m {
                    c -= rc.m;
                }
                a = b;
                b = c;
            }
        } else {
            for i in (0..10u32).rev() {
                let r = self.aes.encrypt_u128(xc ^ ((i as u128) << ishift) ^ a);
                let rc = if i & 1 == 0 { ru } else { rv };
                let y = rc.rem(r >> yshift);
                let c = if b >= y { b - y } else { b + (rc.m - y) };
                b = a;
                a = c;
            }
        }
        let (lo, hi) = out.split_at_mut(p.u);
        self.str128(a, lo);
        self.str128(b, hi);
    }

    #[allow(clippy::too_many_arguments)]
    fn crypt_limb(
        &self,
        p: &Params,
        xs: &[u8; BLOCK],
        var_off: usize,
        round_idx: usize,
        qconst: &dyn Fn(usize) -> u8,
        x: &[u16],
        out: &mut [u16],
        enc: bool,
        l: usize,
        mu: &LMod,
        mv: &LMod,
    ) {
        let (b, d) = (p.b, p.d);
        let ly = d.div_ceil(8);
        let vlen = round_idx + 1 + b - var_off;
        let mut vbuf = [0u8; 16 + 8 * MAXL + 16];
        for k in 0..vlen {
            if var_off + k < round_idx {
                vbuf[k] = qconst(var_off + k);
            }
        }
        let v = &mut vbuf[..vlen];
        let ridx = round_idx - var_off;
        let n_blocks = d.div_ceil(BLOCK);
        let mut s = [0u8; 8 * MAXL + 32];
        let (mut abuf, mut bbuf) = ([0u64; MAXL], [0u64; MAXL]);
        let (mut y, mut r) = ([0u64; MAXL + 1], [0u64; MAXL]);
        self.num_limbs(&x[..p.u], &mut abuf[..l]);
        self.num_limbs(&x[p.u..], &mut bbuf[..l]);
        let (mut a, mut bb) = (&mut abuf[..l], &mut bbuf[..l]);
        let (full_b, part_b) = (b / 8, b % 8);
        let full_d = d / 8;
        for k in 0..10 {
            let i = if enc { k } else { 9 - k };
            {
                let src: &[u64] = if enc { bb } else { a };
                v[ridx] = i as u8;
                let num = &mut v[ridx + 1..];
                for q in 0..full_b {
                    num[b - 8 * (q + 1)..b - 8 * q].copy_from_slice(&src[q].to_be_bytes());
                }
                for q in 0..part_b {
                    num[part_b - 1 - q] = (src[full_b] >> (8 * q)) as u8;
                }
            }
            let mut rr = *xs;
            for chunk in v.chunks_exact(BLOCK) {
                for j in 0..BLOCK {
                    rr[j] ^= chunk[j];
                }
                self.aes.encrypt(&mut rr);
            }
            s[..BLOCK].copy_from_slice(&rr);
            let j0 = u32::from_be_bytes(rr[12..16].try_into().unwrap());
            for j in 1..n_blocks {
                let mut blk = rr;
                blk[12..16].copy_from_slice(&(j0 ^ j as u32).to_be_bytes());
                self.aes.encrypt(&mut blk);
                s[j * BLOCK..(j + 1) * BLOCK].copy_from_slice(&blk);
            }
            for q in 0..full_d {
                y[q] = u64::from_be_bytes(s[d - 8 * (q + 1)..d - 8 * q].try_into().unwrap());
            }
            if d & 4 != 0 {
                y[full_d] = u32::from_be_bytes(s[..4].try_into().unwrap()) as u64;
            }
            let m = if i & 1 == 0 { mu } else { mv };
            m.rem(&y[..ly], &mut r[..l]);
            if enc {
                limb_addmod(a, &r[..l], &m.m[..l]);
            } else {
                limb_submod(bb, &r[..l], &m.m[..l]);
            }
            std::mem::swap(&mut a, &mut bb);
        }
        let (lo, hi) = out.split_at_mut(p.u);
        self.str_limbs(a, lo);
        self.str_limbs(bb, hi);
    }

    fn num_limbs(&self, x: &[u16], res: &mut [u64]) {
        let r = self.radix as u64;
        res.fill(0);
        for chunk in x.chunks(self.group_len) {
            let (mut acc, mut pw) = (0u64, 1u64);
            for &dgt in chunk {
                acc = acc * r + dgt as u64;
                pw *= r;
            }
            let mut cy = acc;
            for limb in res.iter_mut() {
                let pr = *limb as u128 * pw as u128 + cy as u128;
                *limb = pr as u64;
                cy = (pr >> 64) as u64;
            }
        }
    }

    /// STR into out; destroys v.
    fn str_limbs(&self, v: &mut [u64], out: &mut [u16]) {
        let mut i = out.len();
        let mut top = v.len();
        while i > 0 {
            while top > 0 && v[top - 1] == 0 {
                top -= 1;
            }
            let mut r = 0u64;
            for k in (0..top).rev() {
                let (q, rr) = divrem_128_64(r, v[k], self.group_pow);
                v[k] = q;
                r = rr;
            }
            self.str_group(r, out, &mut i);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn crypt_big(
        &self,
        p: &Params,
        xs: &[u8; BLOCK],
        var_off: usize,
        round_idx: usize,
        qconst: &dyn Fn(usize) -> u8,
        x: &[u16],
        out: &mut [u16],
        enc: bool,
        mod_u: &BigUint,
        mod_v: &BigUint,
    ) {
        let (b, d) = (p.b, p.d);
        let qlen = round_idx + 1 + b;
        let mut vbuf: Vec<u8> = (var_off..qlen).map(|k| if k < round_idx { qconst(k) } else { 0 }).collect();
        let ridx = round_idx - var_off;
        let n_blocks = d.div_ceil(BLOCK);
        let mut s = vec![0u8; n_blocks * BLOCK];
        let mut a = self.num_big(&x[..p.u]);
        let mut bb = self.num_big(&x[p.u..]);
        let mut prf = |i: usize, num: &BigUint| -> BigUint {
            vbuf[ridx] = i as u8;
            let bytes = num.to_bytes_be();
            let tail = &mut vbuf[ridx + 1..];
            let len = if num.is_zero() { 0 } else { bytes.len() };
            let pad = tail.len() - len;
            tail[..pad].fill(0);
            tail[pad..].copy_from_slice(&bytes[bytes.len() - len..]);
            let mut r = *xs;
            for chunk in vbuf.chunks_exact(BLOCK) {
                for k in 0..BLOCK {
                    r[k] ^= chunk[k];
                }
                self.aes.encrypt(&mut r);
            }
            s[..BLOCK].copy_from_slice(&r);
            let j0 = u32::from_be_bytes(r[12..16].try_into().unwrap());
            for j in 1..n_blocks {
                let mut blk = r;
                blk[12..16].copy_from_slice(&(j0 ^ j as u32).to_be_bytes());
                self.aes.encrypt(&mut blk);
                s[j * BLOCK..(j + 1) * BLOCK].copy_from_slice(&blk);
            }
            BigUint::from_bytes_be(&s[..d])
        };
        if enc {
            for i in 0..10 {
                let y = prf(i, &bb);
                let m = if i & 1 == 0 { mod_u } else { mod_v };
                a += y;
                a %= m;
                std::mem::swap(&mut a, &mut bb);
            }
        } else {
            for i in (0..10).rev() {
                let y = prf(i, &a);
                let m = if i & 1 == 0 { mod_u } else { mod_v };
                let y = y % m;
                if bb < y {
                    bb += m;
                }
                bb -= y;
                std::mem::swap(&mut a, &mut bb);
            }
        }
        let (lo, hi) = out.split_at_mut(p.u);
        self.str_big(&a, lo);
        self.str_big(&bb, hi);
    }

    /// w / radix for w < 2^63 via ceil(2^64/radix) and one correction.
    #[inline(always)]
    fn div_radix(&self, w: u64) -> (u64, u64) {
        let mut q = ((w as u128 * self.magic as u128) >> 64) as u64;
        let mut r = w.wrapping_sub(q.wrapping_mul(self.radix as u64));
        if r > w {
            q -= 1;
            r = r.wrapping_add(self.radix as u64);
        }
        (q, r)
    }

    #[inline(always)]
    fn str_group(&self, mut w: u64, out: &mut [u16], i: &mut usize) {
        for _ in 0..self.group_len {
            if *i == 0 {
                break;
            }
            let (q, r) = self.div_radix(w);
            *i -= 1;
            out[*i] = r as u16;
            w = q;
        }
    }

    #[inline(always)]
    fn num128(&self, x: &[u16]) -> u128 {
        let r = self.radix as u64;
        let mut res = 0u128;
        for chunk in x.chunks(self.group_len) {
            let (mut acc, mut p) = (0u64, 1u64);
            for &dgt in chunk {
                acc = acc * r + dgt as u64;
                p *= r;
            }
            res = res * p as u128 + acc as u128;
        }
        res
    }

    #[inline(always)]
    fn str128(&self, mut v: u128, out: &mut [u16]) {
        let gp = self.group_pow;
        let mut i = out.len();
        while i > 0 {
            let w = if v < gp as u128 {
                let w = v as u64;
                v = 0;
                w
            } else {
                let hi = (v >> 64) as u64;
                let (qlo, r) = divrem_128_64(hi % gp, v as u64, gp);
                v = (((hi / gp) as u128) << 64) | qlo as u128;
                r
            };
            self.str_group(w, out, &mut i);
        }
    }

    fn num_big(&self, x: &[u16]) -> BigUint {
        let r = self.radix as u64;
        let mut res = BigUint::zero();
        for chunk in x.chunks(self.group_len) {
            let (mut acc, mut p) = (0u64, 1u64);
            for &dgt in chunk {
                acc = acc * r + dgt as u64;
                p *= r;
            }
            res *= p;
            res += acc;
        }
        res
    }

    fn str_big(&self, v: &BigUint, out: &mut [u16]) {
        let gp = BigUint::from(self.group_pow);
        let mut q = v.clone();
        let mut i = out.len();
        while i > 0 {
            let (nq, rem) = q.div_rem(&gp);
            q = nq;
            self.str_group(rem.to_u64().unwrap(), out, &mut i);
        }
    }
}

/// b = ceil(ceil(v * log2(radix)) / 8), computed exactly as BouncyCastle does
/// (kept for the exactness test; the cipher derives b from radix^v - 1).
#[cfg(test)]
fn calc_b(radix: u32, v: usize) -> usize {
    let tz = radix.trailing_zeros() as usize;
    let mut bits = tz * v;
    let odd = radix >> tz;
    if odd != 1 {
        bits += BigUint::from(odd).pow(v as u32).bits() as usize;
    }
    bits.div_ceil(8)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALPHA: &str = "0123456789abcdefghijklmnopqrstuvwxyz";

    fn parse(s: &str) -> Vec<u16> {
        s.chars().map(|c| ALPHA.find(c).unwrap() as u16).collect()
    }
    fn fmt(x: &[u16]) -> String {
        x.iter().map(|&d| ALPHA.as_bytes()[d as usize] as char).collect()
    }
    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    const K128: &str = "2B7E151628AED2A6ABF7158809CF4F3C";
    const K192: &str = "2B7E151628AED2A6ABF7158809CF4F3CEF4359D8D580AA4F";
    const K256: &str = "2B7E151628AED2A6ABF7158809CF4F3CEF4359D8D580AA4F7F036D6F04FC6A94";
    const T1: &str = "39383736353433323130";
    const T2: &str = "3737373770717273373737";

    #[test]
    fn nist_vectors() {
        let vs = [
            (K128, "", 10, "0123456789", "2433477484"),
            (K128, T1, 10, "0123456789", "6124200773"),
            (K128, T2, 36, "0123456789abcdefghi", "a9tv40mll9kdu509eum"),
            (K192, "", 10, "0123456789", "2830668132"),
            (K192, T1, 10, "0123456789", "2496655549"),
            (K192, T2, 36, "0123456789abcdefghi", "xbj3kv35jrawxv32ysr"),
            (K256, "", 10, "0123456789", "6657667009"),
            (K256, T1, 10, "0123456789", "1001623463"),
            (K256, T2, 36, "0123456789abcdefghi", "xs8a0azh2avyalyzuwd"),
        ];
        for force in [0u8, 1, 2] {
            for (i, (k, tw, radix, pt, ct)) in vs.iter().enumerate() {
                let mut c = Ff1::new(&hex(k), *radix).unwrap();
                c.force_path = force;
                let got = c.encrypt(&hex(tw), &parse(pt)).unwrap();
                assert_eq!(fmt(&got), *ct, "sample {} encrypt (path={force})", i + 1);
                let back = c.decrypt(&hex(tw), &parse(ct)).unwrap();
                assert_eq!(fmt(&back), *pt, "sample {} decrypt (path={force})", i + 1);
            }
        }
    }

    #[test]
    fn round_trip_and_fast_vs_bignum() {
        let mut state = 0x1234_5678_9abc_def0u64;
        let mut rnd = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let radices = [2u32, 3, 10, 16, 26, 36, 62, 255, 256, 1000, 65535, 65536];
        for iter in 0..2000 {
            let radix = radices[iter % radices.len()];
            let key: Vec<u8> = (0..[16, 24, 32][iter % 3]).map(|_| rnd() as u8).collect();
            let tw: Vec<u8> = (0..rnd() % 40).map(|_| rnd() as u8).collect();
            let n = 2 + (rnd() % if iter % 7 == 0 { 600 } else if iter % 2 == 1 { 40 } else { 150 }) as usize;
            let mut c = Ff1::new(&key, radix).unwrap();
            if c.check_length(n).is_err() {
                continue;
            }
            let x: Vec<u16> = (0..n).map(|_| (rnd() % radix as u64) as u16).collect();
            let ct = c.encrypt(&tw, &x).unwrap();
            assert_eq!(c.decrypt(&tw, &ct).unwrap(), x);
            for fp in [1u8, 2] {
                let mut s = Ff1::new(&key, radix).unwrap();
                s.force_path = fp;
                assert_eq!(s.encrypt(&tw, &x).unwrap(), ct, "path {fp} mismatch radix={radix} n={n}");
                assert_eq!(s.decrypt(&tw, &ct).unwrap(), x, "path {fp} decrypt radix={radix} n={n}");
            }
        }
    }

    #[test]
    fn recip_matches_division() {
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        let mut rnd = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        for _ in 0..20000 {
            let bits = 2 + rnd() % 95;
            let m = ((((rnd() as u128) << 64) | rnd() as u128) >> (128 - bits)) | 2;
            let y = ((rnd() as u128) << 64) | rnd() as u128;
            assert_eq!(Recip::new(m).rem(y), y % m, "m={m} y={y}");
        }
    }

    #[test]
    fn validation() {
        assert_eq!(Ff1::new(&[0; 16], 1).err(), Some(Error::Radix));
        assert_eq!(Ff1::new(&[0; 15], 10).err(), Some(Error::Key));
        let mut c = Ff1::new(&[0; 16], 10).unwrap();
        assert_eq!(c.encrypt(&[], &parse("12345")).err(), Some(Error::Length));
        assert_eq!(c.encrypt(&[], &[1, 2, 3, 4, 5, 6, 10]).err(), Some(Error::Digit));
    }

    #[test]
    fn calc_b_exact() {
        for r in [2u32, 3, 7, 8, 10, 16, 36, 64, 255, 256, 1000, 65536] {
            for v in 1..80 {
                let want = ((BigUint::from(r).pow(v as u32) - 1u32).bits() as usize).div_ceil(8);
                assert_eq!(calc_b(r, v), want, "r={r} v={v}");
            }
        }
    }
}
