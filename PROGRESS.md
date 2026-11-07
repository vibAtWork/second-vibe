# Progress

- 2026-11-06T23:47Z — Built `projects/aes-gcm-bench/`: one-command Java (SunJCE) vs OpenSSL (EVP) AES-GCM benchmark with NIST self-tests, best-of-N repeats, CPU pinning, CSV + table output. Status: done, `tests/smoke.sh` passes.
- 2026-11-06T23:56Z — aes-gcm-bench: added Dockerfile (Temurin 21 + Ubuntu OpenSSL, prebuilt harnesses) and a GitHub Actions workflow that pushes a multi-arch image to ghcr.io/vibatwork/aes-gcm-bench. Local image build + run verified.
- 2026-11-07T00:24Z — aes-gcm-bench: image moved to JDK 27-ea+34 + GCC 16.2 + OpenSSL 3.5.7 (Debian trixie). New report (env header, boxed tables, ratios, summary) rendered by java/Report.java, live progress in run.sh. Ran the full benchmark and wrote `analysis/ANALYSIS.md` explaining the gaps, backed by ablation programs and SIMD feature masking. Smoke test passes; CI publishes the image.
