//! Cross-language FF1 benchmark protocol (see ../../bench/PROTOCOL.md).
//!
//! ff1bench <ours|fpe> <radix> <n> <keybits> <tweaklen>

use std::hint::black_box;
use std::time::{Duration, Instant};

use fpe::ff1::{FlexibleNumeralString, FF1};

const ALPHA: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

fn env_f(name: &str, def: f64) -> f64 {
    std::env::var(name).ok().and_then(|s| s.parse().ok()).unwrap_or(def)
}

fn measure(mut f: impl FnMut()) -> f64 {
    let warm = Duration::from_secs_f64(env_f("FF1_WARMUP", 1.0));
    let sample = env_f("FF1_SAMPLE", 0.25);
    let n_samples = env_f("FF1_SAMPLES", 7.0) as usize;
    let start = Instant::now();
    let mut count = 0u64;
    while start.elapsed() < warm {
        f();
        count += 1;
    }
    let per = ((count as f64 * sample / warm.as_secs_f64()) as u64).max(1);
    let mut res: Vec<f64> = (0..n_samples)
        .map(|_| {
            let t0 = Instant::now();
            for _ in 0..per {
                f();
            }
            t0.elapsed().as_nanos() as f64 / per as f64
        })
        .collect();
    res.sort_by(|a, b| a.partial_cmp(b).unwrap());
    res[n_samples / 2]
}

fn digits(x: &[u16]) -> String {
    x.iter().map(|&d| ALPHA[d as usize] as char).collect()
}

fn run_fpe<C>(key: &[u8], radix: u32, tweak: &[u8], pt: &[u16]) -> (String, f64, f64)
where
    C: aes::cipher::BlockCipherEncrypt + aes::cipher::KeyInit + Clone,
{
    let c = FF1::<C>::new(key, radix).unwrap();
    let ct: Vec<u16> = c.encrypt(tweak, &FlexibleNumeralString::from(pt.to_vec())).unwrap().into();
    let back: Vec<u16> = c.decrypt(tweak, &FlexibleNumeralString::from(ct.clone())).unwrap().into();
    assert_eq!(back, pt, "round trip failed");
    let mut x = FlexibleNumeralString::from(pt.to_vec());
    let e = measure(|| x = black_box(c.encrypt(tweak, &x).unwrap()));
    let mut y = FlexibleNumeralString::from(ct.clone());
    let d = measure(|| y = black_box(c.decrypt(tweak, &y).unwrap()));
    (digits(&ct), e, d)
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() != 6 {
        eprintln!("usage: ff1bench <ours|fpe> radix n keybits tweaklen");
        std::process::exit(2);
    }
    let radix: u32 = a[2].parse().unwrap();
    let n: usize = a[3].parse().unwrap();
    let keybits: usize = a[4].parse().unwrap();
    let tlen: usize = a[5].parse().unwrap();
    let key: Vec<u8> = (0..keybits / 8).map(|i| i as u8).collect();
    let tweak: Vec<u8> = (0..tlen).map(|i| i as u8).collect();
    let pt: Vec<u16> = (0..n).map(|i| ((i * 7 + 3) % radix as usize) as u16).collect();

    let (name, ct, e, d) = match a[1].as_str() {
        "ours" => {
            let mut c = ff1::Ff1::new(&key, radix).unwrap();
            let ct = c.encrypt(&tweak, &pt).unwrap();
            assert_eq!(c.decrypt(&tweak, &ct).unwrap(), pt, "round trip failed");
            // Allocation-free API, chained through two buffers (x -> y -> x ...).
            let (mut x, mut y) = (pt.clone(), vec![0u16; n]);
            let e = measure(|| {
                c.encrypt_into(&tweak, &x, &mut y).unwrap();
                std::mem::swap(&mut x, &mut y);
                black_box(&x);
            });
            let (mut x, mut y) = (ct.clone(), vec![0u16; n]);
            let d = measure(|| {
                c.decrypt_into(&tweak, &x, &mut y).unwrap();
                std::mem::swap(&mut x, &mut y);
                black_box(&x);
            });
            ("rust", digits(&ct), e, d)
        }
        "fpe" => {
            let (ct, e, d) = match keybits {
                128 => run_fpe::<aes::Aes128>(&key, radix, &tweak, &pt),
                192 => run_fpe::<aes::Aes192>(&key, radix, &tweak, &pt),
                256 => run_fpe::<aes::Aes256>(&key, radix, &tweak, &pt),
                _ => panic!("bad keybits"),
            };
            ("rust-fpe-crate", ct, e, d)
        }
        other => {
            eprintln!("unknown impl {other}");
            std::process::exit(2);
        }
    };
    println!("{name},{radix},{n},{keybits},{tlen},encrypt,{e:.1},{ct}");
    println!("{name},{radix},{n},{keybits},{tlen},decrypt,{d:.1},{ct}");
}
