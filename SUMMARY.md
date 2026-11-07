# Summary

## Built
- **projects/aes-gcm-bench**: benchmarks Java's AES-GCM against OpenSSL's on your own machine.
  Try it: `projects/aes-gcm-bench/run.sh --quick` (~20s), or with Docker: `docker run --rm ghcr.io/vibatwork/aes-gcm-bench --quick`.

- **projects/aes-gcm-bench/analysis/ANALYSIS.md**: why Java or OpenSSL wins at each message size, backed by ablation programs and source reading.

## Review first
- `projects/aes-gcm-bench/README.md`, section "What the rows mean". It explains
  why there are three OpenSSL rows and which one is the like-for-like comparison.
- `projects/aes-gcm-bench/analysis/ANALYSIS.md`: the "why" write-up. Its large-message attribution comes from reading the source; `perf` was unavailable in the sandbox, so there are no hardware-counter measurements.
