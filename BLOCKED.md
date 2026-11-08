# Blocked

Nothing blocked so far.

Notes:
- Erlang `:crypto.crypto_update/2` costs ~490 ns per call on this box (measured
  with a microbenchmark), against ~20–50 ns for a native AES block. FF1 needs
  ≥21 AES calls per operation, so the Elixir port is bound by NIF overhead. This
  is a platform limit, not a bug. A batched-NIF or Rustler-based AES would be
  the way around it (see BACKLOG).

## 2026-11-08 — newer Erlang/OTP, Elixir, OpenSSL (and JDK > 25)

User asked for the latest version of each language. Results:
- Go 1.27.3 (module-proxy toolchain), Rust 1.99.1 (rustup), OpenJDK 25.0.4
  (apt, latest LTS) installed fine.
- **JDK 26/27**: no reachable source. adoptium.net, download.java.net, azul,
  corretto all blocked by the network policy, and apt/conda-forge top out at 25.
- **Erlang/OTP 29.1.2, Elixir 1.20.x, OpenSSL 4.x**: binaries exist on
  conda-forge (reachable), but running the downloaded `micromamba` binary was
  denied by the auto-mode permission classifier. Source tarballs from the Ubuntu
  archive (erlang 29.1.2, elixir-lang 1.20.1, openssl 4.0.3, in /opt/src) were
  downloaded, but running their configure/make build script was also denied. I
  did not try to get around either denial. The benchmarks therefore use the
  system Elixir 1.14 / OTP 25 and OpenSSL 3.0.13.
  To unblock: allow the build (e.g. a Bash permission rule for
  `bash /opt/src/build.sh`, or run it yourself), then rerun
  `python3 projects/ff1/bench/run.py`.
