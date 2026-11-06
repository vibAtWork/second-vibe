# Progress

- 2026-11-06T23:47Z — Built `projects/aes-gcm-bench/`: one-command Java (SunJCE) vs OpenSSL (EVP) AES-GCM benchmark with NIST self-tests, best-of-N repeats, CPU pinning, CSV + table output. Status: done, `tests/smoke.sh` passes.
- 2026-11-06T23:56Z — aes-gcm-bench: added Dockerfile (Temurin 21 + Ubuntu OpenSSL, prebuilt harnesses) and a GitHub Actions workflow that pushes a multi-arch image to ghcr.io/vibatwork/aes-gcm-bench. Local image build + run verified.
