# Decisions

## 2026-11-07 — FF1 in five languages (`projects/ff1/`)

- **One algorithm for all five ports.** Each port follows BouncyCastle's
  `SP80038G.encFF1/decFF1` structure: exact `b` via trailing zeros plus
  `oddPart^v` bit length, `d = (b+7) & ~3`, the BC trick of XORing the S-block
  counter into only the last 4 bytes of R, and word-grouped radix conversion
  from BC's `RadixConverter`. On top of that, every port applies the same three
  optimizations, so the comparison is between languages and not between
  algorithms:
  1. `CIPH_K(P)` once per call; each round CBC-MACs only `Q` from it.
  2. Feistel halves kept as integers across rounds (NUM/STR only at entry/exit).
     BC instead converts digits ↔ BigInteger every round.
  3. `radix^u` and `radix^v` precomputed per call (BC does this as well).
- **Bignum everywhere, no u64/u128 fast path.** Each port uses its standard or
  idiomatic big-integer type (Java `BigInteger`, BEAM integers, `num-bigint`,
  `math/big`, OpenSSL `BIGNUM`). A machine-word fast path for small domains
  (e.g. 16-digit PANs fit in a u64) would be much faster, but Java has no native
  u128 and the ports would diverge. Listed in the backlog instead.
- **"OpenSSL" means C on libcrypto.** OpenSSL has no FF1, so the port is C
  using EVP AES-ECB (AES-NI) for the block cipher and `BIGNUM` for arithmetic.
- **AES backends:** Java uses JCE `AES/ECB/NoPadding` (HotSpot AES-NI
  intrinsics) rather than BC's pure-Java `AESEngine`. The BC baseline keeps its
  default engine, as a BC user would get it.
- **Radix 65536 encodes P[3..5] as a true 3-byte radix** (per the spec). BC
  writes `P[3] = 0` and so cannot represent 65536 there. That only matters at
  radix 65536, which none of the benchmark workloads use.
- **Baselines:** BouncyCastle 1.86 (Java), `fpe` 0.7.0 (Rust),
  `capitalone/fpe` v1.2.1 (Go). No established Elixir FF1 library and no C
  library on OpenSSL was found that was worth pulling in, so those two columns
  have no baseline.
- **Elixir toolchain:** installed `elixir` 1.14 / OTP 25 from Ubuntu apt (dev
  dependency, allowed by AGENTS.md). Newer versions would require third-party
  repos.
- **Benchmark design:** same CLI and CSV output in every language
  (`bench/PROTOCOL.md`), fresh process per (workload, impl), median of 9 samples
  per run and median of 3 runs. Ciphertexts are cross-checked across all 8
  implementations, so a speed number can't come from a wrong answer.
- **Scope:** the user's request (implement and benchmark FF1) took priority over
  the AGENTS.md "keep picking backlog items" loop. The session stops once the
  final results table exists. Follow-ups are in BACKLOG.md.

## 2026-11-08 — v2: "optimize each, latest versions"

- **Toolchains:** Go 1.27.3 (via the `toolchain` line in go.mod), Rust 1.99.1,
  OpenJDK 25.0.4 (latest LTS; JDK 26/27 were unreachable). Erlang/OTP, Elixir
  and OpenSSL could not be upgraded (see BLOCKED.md), so they stay at
  OTP 25 / Elixir 1.14 / OpenSSL 3.0.13.
- **Three arithmetic tiers in C, Rust, Go and Java**, chosen per (n, radix):
  1. radix^v < 2^96: two-word integers. Each round is one 128-bit XOR to form
     the single varying Q block, one AES call, a shift, and one reduction.
  2. radix^v < 2^4096: fixed-width u64 limb arrays with Knuth algorithm D.
     The quotient y / radix^m is only 1–2 limbs because d − b ≤ 7 bytes.
  3. Beyond that: the language's bignum, which also serves as the test oracle
     (`force_path` flags; the tests compare all three tiers on random inputs).
- **Reduction strategy was measured, not assumed:** on this Xeon, hardware
  `divq` beat the Möller–Granlund 2-by-1 reciprocal (C: 380 vs 436 ns/op), so
  C/Rust/Go use `divq` (`bits.Rem64` in Go) for 64-bit moduli and MG 3-by-2 for
  moduli ≥ 2^64 (C: 486 vs 502 ns/op over `__umodti3`). Java has no 128/64
  divide, so it uses MG 2-by-1 / 3-by-2 with `Math.unsignedMultiplyHigh`.
- **Per-instance parameter cache** keyed by (n, tweak length) in C/Go/Java/Rust,
  and in the process dictionary in Elixir. Rust's API became `&mut self` for
  this; all instances were already documented as one-per-thread.
- **Tweak-prefix CBC caching:** Q blocks before the round-number byte never
  change, so they are MACed once per call instead of every round.
- **Allocation-free entry points** (`encrypt_into` / `EncryptTo` /
  `encrypt(tweak, in, out)`) are what the benchmark measures for our ports.
  The allocating variants remain.
- **Native builds:** C `-O3 -march=native` (measured ~10%), Rust
  `-C target-cpu=native` (~17%, AES-NI inlined instead of runtime dispatch).
  `GOAMD64=v3` made no difference to Go, so it was left at the default.
- **Java AES backend:** JCE `Cipher.update` costs 25 ns/block versus 11.6 ns for
  the JDK's internal `com.sun.crypto.provider.AESCrypt` intrinsic. FF1.java
  uses the intrinsic when the JVM grants `--add-opens
  java.base/com.sun.crypto.provider=ALL-UNNAMED` and falls back to JCE
  otherwise. Both are benchmarked (`java` and `java-jce`), because the flag is
  a deployment decision.
- **Rejected:** hand-written AES assembly for Go and pure-Elixir AES. The
  first means maintaining hand-rolled crypto. The second was estimated at
  ~1 µs/block, slower than the 450 ns NIF.
