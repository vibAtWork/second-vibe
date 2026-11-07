# Backlog

Prioritized, top first. [x] = done.

1. [x] FF1 (NIST SP 800-38G) in Java, Elixir, Rust, Go, C/OpenSSL with a cross-checked benchmark (`projects/ff1/`)
2. [ ] FF1: machine-word fast path (u64/u128 when radix^v < 2^64/2^96) in every port, re-benchmarked against the bignum path
3. [ ] FF1: Elixir AES via a Rustler NIF that does a whole FF1 call per NIF invocation (removes the ~490 ns per-AES-block `:crypto` overhead)
4. [ ] FF1: multi-threaded throughput benchmark (per-thread cipher instances), to show scaling per language
5. [ ] FF1: string/alphabet front-end (credit card, SSN, alphanumeric tokens), with Luhn-preserving PAN helper
6. [ ] FF3-1 alongside FF1 in the same five languages, reusing the harness
7. [ ] FF1: ACVP-style JSON vector runner shared by all ports (one vector file, five consumers)
8. [ ] FF1: C port, swap EVP for direct AES-NI intrinsics and compare per-block overhead
9. [ ] FF1: JMH version of the Java bench, to confirm the hand-rolled harness numbers
10. [ ] CLI: `fpe` command-line tool (encrypt/decrypt CSV columns with FF1) built on the Go port
11. [ ] Reference doc: FPE cheat sheet (FF1 vs FF3-1, domain-size rules, tweak guidance, NIST 2025 revision notes)
12. [ ] Template: polyglot benchmark harness (same CLI/CSV protocol + Python driver) extracted from projects/ff1/bench
