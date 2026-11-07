# FF1 format-preserving encryption: Java, Elixir, Rust, Go, C/OpenSSL

NIST SP 800-38G **FF1** (AES-based format-preserving encryption) in five
languages, modeled on BouncyCastle's `SP80038G` / `FPEFF1Engine`. All five
pass NIST's nine FF1 sample vectors, and all of them are benchmarked under one
shared protocol against established libraries (BouncyCastle, Rust `fpe`,
Go `capitalone/fpe`).

| Dir | Language | AES | Big integers | Tests |
|---|---|---|---|---|
| `java/` | Java 21 | JCE `AES/ECB/NoPadding` (AES-NI intrinsics) | `BigInteger` | JUnit 5 |
| `elixir/` | Elixir 1.14 / OTP 25 | `:crypto` ECB state | BEAM integers | ExUnit |
| `rust/` | Rust 1.97 | `aes` 0.9 (AES-NI autodetect) | `num-bigint` 0.5 | `cargo test` |
| `go/` | Go 1.24 | `crypto/aes` | `math/big` | `go test` |
| `openssl/` | C11 on OpenSSL 3.0 libcrypto | EVP AES-ECB | `BIGNUM` | `make test` (also ASan/UBSan clean) |

Every port has the same test set: NIST samples 1–9 (AES-128/192/256, radix 10
and 36, empty and non-empty tweaks), 400 pseudorandom round trips over radices
2…65536 and lengths up to 151, an exactness check of `b` against
`ceil(bitlen(radix^v − 1)/8)`, and input validation.

## Results (median µs per encrypt, single thread, lower is better)

| Workload | Java | Elixir | Rust | Go | C/OpenSSL | BouncyCastle | Rust `fpe` | Go capitalone |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| SSN: radix 10, 9 digits, AES-128 | 1.48 | 7.86 | **1.03** | 1.95 | 1.60 | 3.59 | 3.20 | 2.35 |
| PAN: radix 10, 16 digits, AES-128 | 1.47 | 7.94 | **1.07** | 1.88 | 1.68 | 3.95 | 4.02 | 2.45 |
| PAN: radix 10, 16 digits, AES-256 | 1.56 | 8.24 | **1.10** | 1.90 | 1.68 | 4.54 | 4.26 | 2.54 |
| Token: radix 36, 32 chars, AES-128 | 3.26 | 13.47 | 2.36 | 3.66 | **2.20** | 8.18 | 8.77 | 4.75 |
| Long: radix 10, 128 digits, AES-128 | 6.12 | 34.03 | 3.76 | 5.05 | **3.75** | 21.44 | 31.96 | 6.93 |

Decrypt runs within about 10% of encrypt everywhere. The full tables (decrypt,
ops/s, relative speed, spread across rounds, toolchain versions) are in
[`results/results.md`](results/results.md), and raw samples are in `results/raw.csv`.
All 8 implementations produced **identical ciphertext** for every workload; the
driver aborts if they don't.

**Takeaways**

- **Rust is fastest for short inputs** (≈1.0–1.1 µs, ~950k ops/s). **C/OpenSSL
  ties or wins at 32+ digits**, where BIGNUM's arithmetic matters more than the
  per-call EVP overhead.
- **Java is a close third** (1.4× Rust). Go is 1.35–1.9× Rust; `math/big` costs
  more on tiny numbers but is good at 128 digits.
- **Elixir is 6–9× slower.** The cause is not the algorithm: every
  `:crypto.crypto_update` NIF call costs ~490 ns (measured), against ~20–50 ns
  for a native AES block, and FF1 needs ≥21 AES calls per operation.
- **The same algorithm beats the established library in each language**:
  2.4–3.5× faster than BouncyCastle, 3.1–8.5× faster than Rust `fpe`, and
  1.2–1.4× faster than capitalone. The gain comes mostly from keeping the
  Feistel halves as integers rather than re-converting digits every round, and
  from caching `CIPH(P)`.

## Algorithm notes

Taken from BouncyCastle: the overall `encFF1/decFF1` structure, exact `b`
(power-of-two part counted directly plus bit length of `oddPart^v`),
`d = (b+7) & ~3`, S-block expansion by XORing the counter into only the last 4
bytes of R, and word-grouped radix conversion (`RadixConverter`).

Added on top, identically in every port:
1. `CIPH_K(P)` is computed once per call, and each round CBC-MACs only `Q` from
   it (same result as `PRF(P‖Q)`).
2. The halves stay integers across all 10 rounds; NUM/STR run once each way.
3. `radix^u`, `radix^v` are precomputed per call.

There is no machine-word fast path; all ports use big integers. See
`../../DECISIONS.md` for why, and `../../BACKLOG.md` for the follow-up.

## Run it

```bash
python3 bench/run.py              # build + test all, 3 rounds (~19 min), writes results/
python3 bench/run.py --quick --rounds 1   # ~3 min smoke run
```

Per language:

```bash
(cd java && mvn -q package)                         # runs JUnit too
(cd elixir && mix test)
(cd rust && cargo test --release)
(cd go && go test ./...)
(cd openssl && make test)
```

APIs (digits are integer arrays, most significant first):

- Java: `new FF1(key, radix).encrypt(tweak, int[])`
- Elixir: `FF1.new(key, radix) |> FF1.encrypt(tweak, [digits])`
- Rust: `Ff1::new(&key, radix)?.encrypt(&tweak, &[u16])`
- Go: `ff1.New(key, radix)` then `c.Encrypt(tweak, []uint16)`
- C: `ff1_init(&ctx, key, len, radix); ff1_encrypt(&ctx, tweak, tlen, in, out, n)`

Requirements: JDK 21 + Maven, Elixir ≥1.12, Rust ≥1.80, Go ≥1.22,
gcc/clang + libssl-dev (OpenSSL 3), and Python 3 for the driver. The benchmark
protocol is in [`bench/PROTOCOL.md`](bench/PROTOCOL.md).

## Limitations

- These ports are not audited or constant-time. Big-integer arithmetic in every
  language leaks timing. Don't use them in production without review.
- NIST's 2025 revision of SP 800-38G raises the minimum domain size and adds
  other constraints. These ports enforce the original `radix^n ≥ 10^6`.
- Instances are single-threaded (they hold mutable cipher state); create one
  per thread.
- Numbers come from one 4-vCPU cloud VM (Xeon @ 2.1 GHz) and are single-thread
  only. Absolute values will differ elsewhere; the ratios were stable across
  rounds (see the spread table).
- The Go capitalone baseline only has a string API, so its numbers include
  string conversion. BouncyCastle uses its own pure-Java AES engine (its
  default), while our Java port uses JCE with AES-NI.
