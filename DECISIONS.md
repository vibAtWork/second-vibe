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
