# FF1 benchmark results

Generated 2026-11-08 01:15:47 UTC by `bench/run.py` (3 rounds, 20.7 min). Every implementation produced identical ciphertext for every workload.

Each cell: median microseconds per operation (lower is better). Each number is the median of 3 process runs; each run reports the median of 9 timed samples of ~0.3 s after a 2 s warm-up. Single thread. Tweak is 8 bytes in all workloads.


## Encrypt (µs/op)

| Workload | java | java-jce | elixir | rust | go | c-openssl | java-bouncycastle | rust-fpe-crate | go-capitalone |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| SSN: radix 10, 9 digits, AES-128 | 0.41 | 0.54 | 5.12 | **0.27** | 0.36 | 0.33 | 3.40 | 3.33 | 2.36 |
| PAN: radix 10, 16 digits, AES-128 | 0.41 | 0.56 | 5.16 | **0.28** | 0.40 | 0.34 | 3.57 | 4.10 | 2.42 |
| PAN: radix 10, 16 digits, AES-256 | 0.46 | 0.59 | 5.25 | **0.31** | 0.43 | 0.39 | 4.38 | 4.11 | 2.43 |
| Token: radix 36, 32 chars, AES-128 | 0.49 | 0.66 | 7.11 | **0.40** | 0.51 | 0.44 | 8.26 | 8.78 | 5.05 |
| Long: radix 10, 128 digits, AES-128 | 1.66 | 2.10 | 21.11 | **1.38** | 1.73 | 1.51 | 20.04 | 32.98 | 6.89 |

## Decrypt (µs/op)

| Workload | java | java-jce | elixir | rust | go | c-openssl | java-bouncycastle | rust-fpe-crate | go-capitalone |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| SSN: radix 10, 9 digits, AES-128 | 0.42 | 0.55 | 5.22 | **0.27** | 0.37 | 0.33 | 3.54 | 3.76 | 2.55 |
| PAN: radix 10, 16 digits, AES-128 | 0.43 | 0.56 | 5.16 | **0.29** | 0.39 | 0.34 | 3.66 | 4.80 | 2.67 |
| PAN: radix 10, 16 digits, AES-256 | 0.47 | 0.59 | 5.28 | **0.33** | 0.43 | 0.39 | 4.57 | 4.78 | 2.68 |
| Token: radix 36, 32 chars, AES-128 | 0.50 | 0.67 | 7.92 | **0.41** | 0.52 | 0.44 | 8.04 | 9.58 | 5.28 |
| Long: radix 10, 128 digits, AES-128 | 1.70 | 2.07 | 22.73 | **1.29** | 1.70 | 1.53 | 20.45 | 34.08 | 7.03 |

## Throughput, encrypt (operations per second, single thread)

| Workload | java | java-jce | elixir | rust | go | c-openssl | java-bouncycastle | rust-fpe-crate | go-capitalone |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| SSN: radix 10, 9 digits, AES-128 | 2,451,581 | 1,840,943 | 195,416 | 3,769,318 | 2,747,253 | 3,027,551 | 294,473 | 300,237 | 422,958 |
| PAN: radix 10, 16 digits, AES-128 | 2,424,242 | 1,787,630 | 193,847 | 3,577,818 | 2,522,704 | 2,915,452 | 280,411 | 244,188 | 413,428 |
| PAN: radix 10, 16 digits, AES-256 | 2,189,142 | 1,687,194 | 190,520 | 3,180,662 | 2,346,316 | 2,579,314 | 228,264 | 243,410 | 410,745 |
| Token: radix 36, 32 chars, AES-128 | 2,031,282 | 1,523,461 | 140,740 | 2,529,084 | 1,958,864 | 2,268,603 | 121,080 | 113,882 | 197,844 |
| Long: radix 10, 128 digits, AES-128 | 603,537 | 476,485 | 47,372 | 726,639 | 576,502 | 661,332 | 49,896 | 30,322 | 145,100 |

## Relative to the fastest implementation (encrypt, ×slower)

| Workload | java | java-jce | elixir | rust | go | c-openssl | java-bouncycastle | rust-fpe-crate | go-capitalone |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| SSN: radix 10, 9 digits, AES-128 | 1.54× | 2.05× | 19.29× | 1.00× | 1.37× | 1.25× | 12.80× | 12.55× | 8.91× |
| PAN: radix 10, 16 digits, AES-128 | 1.48× | 2.00× | 18.46× | 1.00× | 1.42× | 1.23× | 12.76× | 14.65× | 8.65× |
| PAN: radix 10, 16 digits, AES-256 | 1.45× | 1.89× | 16.69× | 1.00× | 1.36× | 1.23× | 13.93× | 13.07× | 7.74× |
| Token: radix 36, 32 chars, AES-128 | 1.25× | 1.66× | 17.97× | 1.00× | 1.29× | 1.11× | 20.89× | 22.21× | 12.78× |
| Long: radix 10, 128 digits, AES-128 | 1.20× | 1.52× | 15.34× | 1.00× | 1.26× | 1.10× | 14.56× | 23.96× | 5.01× |

## This repository vs. the established library in the same language (encrypt speed-up)

| Workload | java vs java-bouncycastle | java-jce vs java-bouncycastle | rust vs rust-fpe-crate | go vs go-capitalone |
|---|---:|---:|---:|---:|
| SSN: radix 10, 9 digits, AES-128 | 8.33× | 6.25× | 12.55× | 6.50× |
| PAN: radix 10, 16 digits, AES-128 | 8.65× | 6.38× | 14.65× | 6.10× |
| PAN: radix 10, 16 digits, AES-256 | 9.59× | 7.39× | 13.07× | 5.71× |
| Token: radix 36, 32 chars, AES-128 | 16.78× | 12.58× | 22.21× | 9.90× |
| Long: radix 10, 128 digits, AES-128 | 12.10× | 9.55× | 23.96× | 3.97× |

## Speed-up vs. the first version (v1, 2026-11-07; encrypt)

| Workload | java | elixir | rust | go | c-openssl |
|---|---:|---:|---:|---:|---:|
| SSN: radix 10, 9 digits, AES-128 | 1.48 → 0.41 (3.6×) | 7.86 → 5.12 (1.5×) | 1.03 → 0.27 (3.9×) | 1.95 → 0.36 (5.3×) | 1.60 → 0.33 (4.8×) |
| PAN: radix 10, 16 digits, AES-128 | 1.47 → 0.41 (3.6×) | 7.94 → 5.16 (1.5×) | 1.07 → 0.28 (3.8×) | 1.88 → 0.40 (4.7×) | 1.68 → 0.34 (4.9×) |
| PAN: radix 10, 16 digits, AES-256 | 1.56 → 0.46 (3.4×) | 8.24 → 5.25 (1.6×) | 1.10 → 0.31 (3.5×) | 1.90 → 0.43 (4.5×) | 1.68 → 0.39 (4.3×) |
| Token: radix 36, 32 chars, AES-128 | 3.26 → 0.49 (6.6×) | 13.47 → 7.11 (1.9×) | 2.36 → 0.40 (6.0×) | 3.66 → 0.51 (7.2×) | 2.20 → 0.44 (5.0×) |
| Long: radix 10, 128 digits, AES-128 | 6.12 → 1.66 (3.7×) | 34.03 → 21.11 (1.6×) | 3.76 → 1.38 (2.7×) | 5.05 → 1.73 (2.9×) | 3.75 → 1.51 (2.5×) |

## Spread (encrypt, min–max µs across rounds)

| Workload | java | java-jce | elixir | rust | go | c-openssl | java-bouncycastle | rust-fpe-crate | go-capitalone |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| SSN: radix 10, 9 digits, AES-128 | 0.40–0.42 | 0.54–0.59 | 4.99–5.32 | 0.27–0.27 | 0.36–0.37 | 0.33–0.33 | 3.37–3.54 | 3.27–3.35 | 2.25–2.39 |
| PAN: radix 10, 16 digits, AES-128 | 0.41–0.42 | 0.56–0.57 | 5.12–5.31 | 0.28–0.28 | 0.38–0.41 | 0.34–0.35 | 3.45–4.03 | 4.03–4.23 | 2.40–2.52 |
| PAN: radix 10, 16 digits, AES-256 | 0.45–0.46 | 0.57–0.60 | 5.16–5.37 | 0.31–0.32 | 0.42–0.45 | 0.37–0.39 | 4.25–4.42 | 4.06–4.24 | 2.41–2.83 |
| Token: radix 36, 32 chars, AES-128 | 0.49–0.50 | 0.65–0.68 | 6.98–7.73 | 0.38–0.41 | 0.50–0.54 | 0.43–0.45 | 7.81–8.28 | 8.76–9.38 | 4.89–5.21 |
| Long: radix 10, 128 digits, AES-128 | 1.62–1.68 | 1.98–2.13 | 20.62–22.49 | 1.37–1.39 | 1.73–1.86 | 1.51–1.54 | 19.90–21.19 | 32.43–33.68 | 6.86–7.04 |

## Environment

- **CPU**: Intel(R) Xeon(R) Processor @ 2.10GHz (4 vCPU), Linux 6.18.44-fc-v310
- **Java**: openjdk version "25.0.4.1" 2026-08-18
- **Elixir**: Erlang/OTP 25 [erts-13.2.2.5] [source] [64-bit] [smp:4:4] [ds:4:4:10] [async-threads:1] [jit:ns] / Elixir 1.14.0 (compiled with Erlang/OTP 24)
- **Rust**: rustc 1.99.1 (58cf8f9c3 2026-10-13)
- **Go**: go version go1.27.3 linux/amd64
- **OpenSSL**: OpenSSL 3.0.13 30 Jan 2024 (Library: OpenSSL 3.0.13 30 Jan 2024); cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0 (`-O3 -march=native`)
- `java` = AES via the JDK's AES-NI intrinsic class (needs `--add-opens=java.base/com.sun.crypto.provider=ALL-UNNAMED`); `java-jce` = same code through the standard JCE `Cipher` API.
- Rust built with `-C target-cpu=native`; C with `-O3 -march=native`.
- Baselines: BouncyCastle bcprov-jdk18on 1.86 (`FPEFF1Engine`, default AES engine), Rust `fpe` 0.7.0 (`FlexibleNumeralString`), Go `github.com/capitalone/fpe` v1.2.1 (string API).
