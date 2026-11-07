# Summary (2026-11-07 session)

## Built

**`projects/ff1/`**: NIST SP 800-38G FF1 in Java, Elixir, Rust, Go and
C/OpenSSL (modeled on BouncyCastle), each with NIST vectors and round-trip
tests. It includes a cross-language benchmark (5 workloads × 8 implementations
including BouncyCastle, Rust `fpe`, Go capitalone) whose driver verifies that
every implementation produces identical ciphertext.

Headline (µs/encrypt, 16-digit PAN, AES-128): Rust 1.07 · Java 1.47 · C/OpenSSL 1.68 ·
Go 1.88 · Elixir 7.94 | BouncyCastle 3.95 · Rust fpe 4.02 · capitalone 2.45.

## Try it

```bash
cd projects/ff1 && python3 bench/run.py --quick --rounds 1
```

## Review first

1. `projects/ff1/README.md` and `projects/ff1/results/results.md`: the tables.
2. `DECISIONS.md`: why every port shares one optimized algorithm and has no u64 fast path.
3. `projects/ff1/openssl/ff1.c`: the C port, the one most worth a careful memory/error-path review.
