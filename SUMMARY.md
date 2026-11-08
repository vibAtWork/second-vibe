# Summary (2026-11-07 session)

## Built

**`projects/ff1/`**: NIST SP 800-38G FF1 in Java, Elixir, Rust, Go and
C/OpenSSL (modeled on BouncyCastle), each with NIST vectors and round-trip
tests. It includes a cross-language benchmark (5 workloads × 8 implementations
including BouncyCastle, Rust `fpe`, Go capitalone) whose driver verifies that
every implementation produces identical ciphertext.

Headline v2 (µs/encrypt, 16-digit PAN, AES-128): Rust 0.28 · C/OpenSSL 0.34 · Go 0.40 ·
Java 0.41 (JCE 0.56) · Elixir 5.16 | BouncyCastle 3.57 · Rust fpe 4.10 · capitalone 2.42.
(v1 was Rust 1.07 · Java 1.47 · C 1.68 · Go 1.88 · Elixir 7.94.)

## Try it

```bash
cd projects/ff1 && python3 bench/run.py --quick --rounds 1
```

## Review first

1. `projects/ff1/README.md` and `projects/ff1/results/results.md`: the tables.
2. `DECISIONS.md`: why every port shares one optimized algorithm and has no u64 fast path.
3. `projects/ff1/openssl/ff1.c` and the limb-path (Knuth D) code in each port: the most intricate arithmetic.
4. `BLOCKED.md`: Erlang/OTP, Elixir and OpenSSL could not be upgraded in this environment.
