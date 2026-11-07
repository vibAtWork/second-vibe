//! NIST SP 800-38G FF1 format-preserving encryption with AES.
//!
//! The structure follows BouncyCastle's `SP80038G.encFF1/decFF1` (P block, Q
//! block, CBC-MAC PRF, S-block expansion, modular add/sub) with the same three
//! optimizations used by every port in this repository:
//!
//! 1. `CIPH_K(P)` is computed once per call; each round's PRF then only
//!    CBC-MACs `Q`, chained from that block (same result as `PRF(P || Q)`).
//! 2. The two Feistel halves stay integers across all ten rounds, so
//!    `NUM_radix` / `STR_radix` run once on entry and once on exit.
//! 3. `radix^u` and `radix^v` are computed once per call.

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
}

/// An FF1 instance bound to one AES key and radix.
pub struct Ff1 {
    aes: AnyAes,
    radix: u32,
    group_len: usize,
    group_pow: u64,
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
        // Largest g with radix^g fitting in a u64 (BouncyCastle RadixConverter idea).
        let (mut g, mut p) = (0usize, 1u64);
        while let Some(np) = p.checked_mul(radix as u64) {
            p = np;
            g += 1;
        }
        Ok(Ff1 { aes, radix, group_len: g, group_pow: p })
    }

    pub fn encrypt(&self, tweak: &[u8], x: &[u16]) -> Result<Vec<u16>, Error> {
        self.crypt(tweak, x, true)
    }

    pub fn decrypt(&self, tweak: &[u8], x: &[u16]) -> Result<Vec<u16>, Error> {
        self.crypt(tweak, x, false)
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

    fn crypt(&self, t_bytes: &[u8], x: &[u16], enc: bool) -> Result<Vec<u16>, Error> {
        let n = x.len();
        self.check_length(n)?;
        if x.iter().any(|&d| d as u32 >= self.radix) {
            return Err(Error::Digit);
        }
        let t = t_bytes.len();
        let u = n / 2;
        let v = n - u;
        let b = calc_b(self.radix, v);
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
        self.aes.encrypt(&mut p); // p now holds CIPH(P)
        let enc_p = p;

        let zeros = (-((t + b + 1) as isize)).rem_euclid(16) as usize;
        let mut q = vec![0u8; t + zeros + 1 + b];
        q[..t].copy_from_slice(t_bytes);
        let round_idx = t + zeros;
        let num_off = round_idx + 1;

        let n_blocks = d.div_ceil(BLOCK);
        let mut s = vec![0u8; n_blocks * BLOCK];

        let big_radix = BigUint::from(self.radix);
        let mod_u = big_radix.pow(u as u32);
        let mod_v = if v != u { &mod_u * &big_radix } else { mod_u.clone() };

        let mut a = self.num(&x[..u]);
        let mut bb = self.num(&x[u..]);

        let mut prf = |i: usize, num: &BigUint| -> BigUint {
            q[round_idx] = i as u8;
            let bytes = num.to_bytes_be();
            let tail = &mut q[num_off..];
            let pad = tail.len() - if num.is_zero() { 0 } else { bytes.len() };
            tail[..pad].fill(0);
            if !num.is_zero() {
                tail[pad..].copy_from_slice(&bytes);
            }
            let mut r = enc_p;
            for chunk in q.chunks_exact(BLOCK) {
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
                let m = if i & 1 == 0 { &mod_u } else { &mod_v };
                let c = (a + y) % m;
                a = std::mem::replace(&mut bb, c);
            }
        } else {
            for i in (0..10).rev() {
                let y = prf(i, &a);
                let m = if i & 1 == 0 { &mod_u } else { &mod_v };
                let y = y % m;
                let c = if bb >= y { bb - y } else { bb + m - y };
                bb = std::mem::replace(&mut a, c);
            }
        }

        let mut out = vec![0u16; n];
        self.str(&a, &mut out[..u]);
        self.str(&bb, &mut out[u..]);
        Ok(out)
    }

    /// NUM_radix(x) using u64 digit groups.
    fn num(&self, x: &[u16]) -> BigUint {
        let r = self.radix as u64;
        let mut res = BigUint::zero();
        for chunk in x.chunks(self.group_len) {
            let mut acc = 0u64;
            let mut p = 1u64;
            for &dgt in chunk {
                acc = acc * r + dgt as u64;
                p *= r;
            }
            res = res * p + acc;
        }
        res
    }

    /// STR^m_radix(v) into out (m = out.len()), most significant digit first.
    fn str(&self, v: &BigUint, out: &mut [u16]) {
        let r = self.radix as u64;
        let gp = BigUint::from(self.group_pow);
        let mut q = v.clone();
        let mut i = out.len();
        while i > 0 {
            let (nq, rem) = q.div_rem(&gp);
            q = nq;
            let mut w = rem.to_u64().unwrap();
            for _ in 0..self.group_len {
                if i == 0 {
                    break;
                }
                i -= 1;
                out[i] = (w % r) as u16;
                w /= r;
            }
        }
    }
}

/// b = ceil(ceil(v * log2(radix)) / 8), computed exactly as BouncyCastle does.
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
        for (i, (k, tw, radix, pt, ct)) in vs.iter().enumerate() {
            let c = Ff1::new(&hex(k), *radix).unwrap();
            let got = c.encrypt(&hex(tw), &parse(pt)).unwrap();
            assert_eq!(fmt(&got), *ct, "sample {} encrypt", i + 1);
            let back = c.decrypt(&hex(tw), &parse(ct)).unwrap();
            assert_eq!(fmt(&back), *pt, "sample {} decrypt", i + 1);
        }
    }

    #[test]
    fn round_trip_pseudorandom() {
        let mut state = 0x1234_5678_9abc_def0u64;
        let mut rnd = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let radices = [2u32, 3, 10, 16, 26, 36, 62, 255, 256, 1000, 65535, 65536];
        for iter in 0..400 {
            let radix = radices[iter % radices.len()];
            let key: Vec<u8> = (0..[16, 24, 32][iter % 3]).map(|_| rnd() as u8).collect();
            let tw: Vec<u8> = (0..rnd() % 40).map(|_| rnd() as u8).collect();
            let n = 2 + (rnd() % 150) as usize;
            let c = Ff1::new(&key, radix).unwrap();
            if c.check_length(n).is_err() {
                continue;
            }
            let x: Vec<u16> = (0..n).map(|_| (rnd() % radix as u64) as u16).collect();
            let ct = c.encrypt(&tw, &x).unwrap();
            assert_eq!(c.decrypt(&tw, &ct).unwrap(), x);
        }
    }

    #[test]
    fn validation() {
        assert_eq!(Ff1::new(&[0; 16], 1).err(), Some(Error::Radix));
        assert_eq!(Ff1::new(&[0; 15], 10).err(), Some(Error::Key));
        let c = Ff1::new(&[0; 16], 10).unwrap();
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
