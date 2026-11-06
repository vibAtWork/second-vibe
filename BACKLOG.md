# Backlog

Prioritized; top = next.

1. ~~aes-gcm-bench: Java vs OpenSSL AES-GCM benchmark~~ (done, owner request)
2. aes-gcm-bench: add ChaCha20-Poly1305 comparison (Java 11+ and OpenSSL both support it)
3. aes-gcm-bench: multi-threaded scaling mode (N threads, aggregate MB/s)
4. aes-gcm-bench: optional JMH-based Java harness for more rigorous numbers
5. aes-gcm-bench: direct ByteBuffer variant in Java
6. aes-gcm-bench: optional BouncyCastle / Amazon Corretto Crypto Provider rows (download jar if present)
7. csv-to-markdown CLI: convert CSV to GitHub tables (handy for sharing bench results)
8. TLS cipher-suite cheat sheet: Java `jdk.tls` vs OpenSSL cipher names, checked against docs
9. log-histogram: tiny CLI that buckets timestamps from logs into per-minute counts
10. dotfiles template: bash/zsh + git config scaffold with sane defaults
11. cpu-feature report script: summarise crypto-relevant CPU flags and kernel crypto drivers
