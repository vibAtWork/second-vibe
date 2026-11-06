# Summary

## Built
- **projects/aes-gcm-bench**: benchmarks Java's AES-GCM against OpenSSL's on your own machine.
  Try it: `projects/aes-gcm-bench/run.sh --quick` (~20s), or with Docker: `docker run --rm ghcr.io/vibatwork/aes-gcm-bench --quick`.

## Review first
- `projects/aes-gcm-bench/README.md`, section "What the rows mean". It explains
  why there are three OpenSSL rows and which one is the like-for-like comparison.
