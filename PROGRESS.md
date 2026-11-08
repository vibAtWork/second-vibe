# Progress

| When (UTC) | What | Status | Where |
|---|---|---|---|
| 2026-11-07 | Installed Elixir 1.14 / OTP 25 (apt); fetched BouncyCastle 1.86 sources for reference | done | — |
| 2026-11-07 | Go FF1 + NIST vectors + bench (capitalone baseline) | done, tests pass | projects/ff1/go |
| 2026-11-07 | Rust FF1 + tests + bench (fpe crate baseline) | done, tests pass | projects/ff1/rust |
| 2026-11-07 | C/OpenSSL FF1 (EVP + BIGNUM) + tests (also ASan/UBSan clean) + bench | done, tests pass | projects/ff1/openssl |
| 2026-11-07 | Java FF1 (JCE + BigInteger) + JUnit + bench (BouncyCastle baseline) | done, tests pass | projects/ff1/java |
| 2026-11-07 | Elixir FF1 (:crypto + integers) + ExUnit + bench | done, tests pass | projects/ff1/elixir |
| 2026-11-07 | Benchmark driver with cross-implementation ciphertext check | done | projects/ff1/bench |
| 2026-11-07 | Full benchmark run (3 rounds, 18.7 min), README with final tables, SUMMARY.md | done | projects/ff1/results, projects/ff1/README.md |
| 2026-11-08 | Toolchains: Go 1.27.3, Rust 1.99.1, JDK 25.0.4 (OTP/Elixir/OpenSSL upgrade blocked, see BLOCKED.md) | partial | — |
| 2026-11-08 | v2 optimizations: u128 fast path, limb path (Knuth D), param + prefix caching, reciprocal division, native builds, Java AES intrinsic backend, Elixir NIF-count/alloc reductions | done, all tests pass (3-way path cross-checks) | projects/ff1/* |
| 2026-11-08 | v2 full benchmark (3 rounds, 20.7 min), README/SUMMARY updated | done | projects/ff1/results |
