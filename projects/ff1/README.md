# FF1 format-preserving encryption: Java, Elixir, Rust, Go, C/OpenSSL

NIST SP 800-38G **FF1** (AES-based format-preserving encryption) in five
languages, modeled on BouncyCastle's `SP80038G` / `FPEFF1Engine` and then
optimized. All five pass NIST's nine FF1 sample vectors, and all are
benchmarked under one protocol against established libraries (BouncyCastle,
Rust `fpe`, Go `capitalone/fpe`). The benchmark aborts if any two of the nine
implementations disagree on a ciphertext.

| Dir | Language | AES | Arithmetic | Tests |
|---|---|---|---|---|
| `java/` | Java 25 | JDK AES-NI intrinsic (`--add-opens`) or JCE | 2×`long` / `long[]` limbs / `BigInteger` | JUnit 5 |
| `elixir/` | Elixir 1.14 / OTP 25 | `:crypto` ECB state | BEAM integers | ExUnit |
| `rust/` | Rust 1.99 | `aes` 0.9 (AES-NI, `target-cpu=native`) | `u128` / `u64` limbs / `num-bigint` | `cargo test` |
| `go/` | Go 1.27 | `crypto/aes` | 2×`uint64` / limbs / `math/big` | `go test` |
| `openssl/` | C11 on OpenSSL 3.0 libcrypto | EVP AES-ECB (`EVP_Cipher`) | `__int128` / limbs / `BIGNUM` | `make test` (ASan/UBSan clean) |

Tests in every port: NIST samples 1–9 (AES-128/192/256, radix 10 and 36, empty
and non-empty tweaks) on every arithmetic path, ≥2,000 pseudorandom inputs over
radices 2…65536 and lengths up to 600, with each one cross-checked across the
fast, limb and bignum paths, the reciprocal-division code against bignum
division, exact `b`, and input validation.

## Results (v2, median µs per encrypt, single thread, lower is better)

| Workload | Java | Java (JCE) | Elixir | Rust | Go | C/OpenSSL | BouncyCastle | Rust `fpe` | Go capitalone |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| SSN: radix 10, 9 digits, AES-128 | 0.41 | 0.54 | 5.12 | **0.27** | 0.36 | 0.33 | 3.40 | 3.33 | 2.36 |
| PAN: radix 10, 16 digits, AES-128 | 0.41 | 0.56 | 5.16 | **0.28** | 0.40 | 0.34 | 3.57 | 4.10 | 2.42 |
| PAN: radix 10, 16 digits, AES-256 | 0.46 | 0.59 | 5.25 | **0.31** | 0.43 | 0.39 | 4.38 | 4.11 | 2.43 |
| Token: radix 36, 32 chars, AES-128 | 0.49 | 0.66 | 7.11 | **0.40** | 0.51 | 0.44 | 8.26 | 8.78 | 5.05 |
| Long: radix 10, 128 digits, AES-128 | 1.66 | 2.10 | 21.11 | **1.38** | 1.73 | 1.51 | 20.04 | 32.98 | 6.89 |

Decrypt runs within a few percent of encrypt. Rust handles ~3.6M PAN
encryptions per second on one core. Full tables (decrypt, ops/s, ratios,
spread, toolchain versions) are in [`results/results.md`](results/results.md);
raw samples are in `results/raw.csv`. The first version's results are in
[`results/v1/`](results/v1/results.md).

**Speed-up over v1 (encrypt):** Java 3.4–6.6×, Rust 2.7–6.0×, Go 2.9–7.2×,
C 2.5–5.0×, Elixir 1.5–1.9×.

**Takeaways**

- **Rust is fastest everywhere** (0.27 µs for an SSN); C/OpenSSL is 1.1–1.25×
  behind and Go 1.3–1.4×. In all three the time is now mostly the latency of
  11 sequential AES calls plus 10 divides. In C, about half of each AES call is
  EVP dispatch overhead.
- **Java is 1.2–1.5× Rust** with the AES-NI intrinsic, and 1.5–2× with plain
  JCE. The JCE layers cost ~14 ns per AES block.
- **Elixir is NIF-bound.** `:crypto.crypto_update/2` costs ~450 ns per call on
  OTP 25 regardless of data size, and FF1 needs 10 sequential calls. Elixir is
  at ~5 µs, near that floor of about 4.5 µs.
- **Against the established libraries:** 8–17× faster than BouncyCastle,
  13–24× faster than Rust `fpe`, and 4–10× faster than capitalone. Most of it
  comes from avoiding bignum work and per-round digit↔integer conversion.

## What the code does

Taken from BouncyCastle: the `encFF1/decFF1` structure, exact `b`,
`d = (b+7) & ~3`, S-block expansion by XORing the counter into the last 4
bytes of R, and word-grouped radix conversion.

Optimizations (the same in every compiled port; Elixir gets the parts that
apply to it):

1. **Three arithmetic tiers**, chosen per (n, radix):
   - radix^v < 2^96 (SSN, PAN, 32-char base-36 tokens): halves are 128-bit
     integers. The single varying Q block is `X ⊕ (i << 8b) ⊕ B` as one
     integer, S = R, and `y mod radix^m` is a hardware `divq` (64-bit moduli)
     or a Möller–Granlund 3-by-2 reciprocal division (moduli ≥ 2^64). Java has
     no 128/64 divide, so it uses MG for both via `Math.unsignedMultiplyHigh`.
   - radix^v < 2^4096: fixed-width `u64` limb arrays with Knuth algorithm D.
     The quotient is only 1–2 limbs, and nothing is allocated per round.
   - Beyond that: the language's bignum (also the test oracle).
2. **Per-length cache**: b, d, CIPH(P), radix^u, radix^v and the reciprocals
   are computed once per (n, tweak length) and reused.
3. **Tweak-prefix caching**: Q blocks that contain only tweak/padding are
   CBC-MACed once per call, not once per round.
4. **Halves stay numeric** across all 10 rounds; NUM/STR run once each way,
   and STR divides by the radix with a precomputed reciprocal.
5. **No allocation** in the hot path for C/Rust/Go/Java (`*_into` / `EncryptTo`
   APIs), plus native-CPU builds for C and Rust.

Each choice was measured. See `../../DECISIONS.md`, which also lists what
didn't help (MG for 64-bit moduli, `GOAMD64=v3`).

## Run it

```bash
python3 bench/run.py                      # build + test all, 3 rounds (~21 min), writes results/
```

```bash
python3 bench/run.py --quick --rounds 1   # ~4 min smoke run
```

Per language:

```bash
(cd java && JAVA_HOME=/usr/lib/jvm/java-25-openjdk-amd64 mvn -q package)   # runs JUnit too
```

```bash
(cd elixir && mix test)
```

```bash
(cd rust && cargo test --release)
```

```bash
(cd go && go test ./...)
```

```bash
(cd openssl && make test)
```

APIs (digits are integer arrays, most significant first; instances are
**one per thread** because they cache per-length state):

- Java: `new FF1(key, radix).encrypt(tweak, int[])`, or `encrypt(tweak, in, out)`
- Elixir: `FF1.new(key, radix) |> FF1.encrypt(tweak, [digits])`
- Rust: `let mut c = Ff1::new(&key, radix)?; c.encrypt(&tweak, &[u16])` or `encrypt_into`
- Go: `c, _ := ff1.New(key, radix)` then `c.Encrypt(tweak, []uint16)` or `c.EncryptTo(...)`
- C: `ff1_init(&ctx, key, len, radix); ff1_encrypt(&ctx, tweak, tlen, in, out, n)`

Requirements: JDK 25 + Maven, Elixir ≥ 1.12, Rust ≥ 1.80, Go ≥ 1.24 (go.mod
pins the 1.27.3 toolchain), gcc/clang + libssl-dev (OpenSSL 3), and Python 3
for the driver.

## Limitations

- These ports are not audited or constant-time; the arithmetic is
  data-dependent. Don't use them in production without review.
- They enforce the original `radix^n ≥ 10^6` domain rule, not the stricter
  limits in NIST's 2025 revision of SP 800-38G.
- The Java intrinsic backend reaches into a JDK-internal class and needs
  `--add-opens java.base/com.sun.crypto.provider=ALL-UNNAMED`. Without the flag
  it falls back to JCE automatically (the `java-jce` column).
- C and Rust are built with `-march=native` / `target-cpu=native`; drop those
  flags for portable binaries (~10–17% slower).
- **Not the latest Erlang/OTP, Elixir or OpenSSL:** upgrading those three was
  blocked in this environment (see `../../BLOCKED.md`). Newer OTP and OpenSSL
  would likely help Elixir (NIF cost) and C (EVP overhead).
- Numbers are from one 4-vCPU cloud VM (Xeon @ 2.1 GHz), single thread.
- The capitalone baseline only has a string API, so its numbers include string
  conversion. BouncyCastle uses its default pure-Java AES engine.
