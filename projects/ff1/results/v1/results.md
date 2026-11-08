# FF1 benchmark results

Generated 2026-11-07 23:58:34 UTC by `bench/run.py` (3 rounds, 18.7 min). Every implementation produced identical ciphertext for every workload.

Each cell: median microseconds per operation (lower is better). Each number is the median of 3 process runs; each run reports the median of 9 timed samples of ~0.3 s after a 2 s warm-up. Single thread. Tweak is 8 bytes in all workloads.


## Encrypt (µs/op)

| Workload | java | elixir | rust | go | c-openssl | java-bouncycastle | rust-fpe-crate | go-capitalone |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| SSN: radix 10, 9 digits, AES-128 | 1.48 | 7.86 | **1.03** | 1.95 | 1.60 | 3.59 | 3.20 | 2.35 |
| PAN: radix 10, 16 digits, AES-128 | 1.47 | 7.94 | **1.07** | 1.88 | 1.68 | 3.95 | 4.02 | 2.45 |
| PAN: radix 10, 16 digits, AES-256 | 1.56 | 8.24 | **1.10** | 1.90 | 1.68 | 4.54 | 4.26 | 2.54 |
| Token: radix 36, 32 chars, AES-128 | 3.26 | 13.47 | 2.36 | 3.66 | **2.20** | 8.18 | 8.77 | 4.75 |
| Long: radix 10, 128 digits, AES-128 | 6.12 | 34.03 | 3.76 | 5.05 | **3.75** | 21.44 | 31.96 | 6.93 |

## Decrypt (µs/op)

| Workload | java | elixir | rust | go | c-openssl | java-bouncycastle | rust-fpe-crate | go-capitalone |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| SSN: radix 10, 9 digits, AES-128 | 1.68 | 7.70 | **1.09** | 2.00 | 1.72 | 3.71 | 3.76 | 2.44 |
| PAN: radix 10, 16 digits, AES-128 | 1.59 | 7.98 | **1.16** | 1.96 | 1.78 | 4.23 | 4.69 | 2.68 |
| PAN: radix 10, 16 digits, AES-256 | 1.65 | 8.23 | **1.20** | 1.92 | 1.80 | 4.59 | 4.75 | 2.68 |
| Token: radix 36, 32 chars, AES-128 | 3.53 | 14.81 | 2.50 | 3.66 | **2.31** | 9.19 | 9.43 | 4.82 |
| Long: radix 10, 128 digits, AES-128 | 6.36 | 35.67 | **3.96** | 5.23 | 3.96 | 22.04 | 33.14 | 7.37 |

## Throughput, encrypt (operations per second, single thread)

| Workload | java | elixir | rust | go | c-openssl | java-bouncycastle | rust-fpe-crate | go-capitalone |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| SSN: radix 10, 9 digits, AES-128 | 674,445 | 127,280 | 972,479 | 513,954 | 624,844 | 278,552 | 312,813 | 425,749 |
| PAN: radix 10, 16 digits, AES-128 | 679,579 | 125,949 | 932,401 | 532,481 | 594,813 | 253,479 | 248,595 | 408,013 |
| PAN: radix 10, 16 digits, AES-256 | 641,108 | 121,290 | 911,328 | 525,127 | 595,593 | 220,240 | 234,467 | 393,685 |
| Token: radix 36, 32 chars, AES-128 | 306,513 | 74,225 | 423,962 | 273,508 | 454,835 | 122,296 | 114,047 | 210,580 |
| Long: radix 10, 128 digits, AES-128 | 163,471 | 29,386 | 265,752 | 197,988 | 266,930 | 46,637 | 31,290 | 144,388 |

## Relative to the fastest implementation (encrypt, ×slower)

| Workload | java | elixir | rust | go | c-openssl | java-bouncycastle | rust-fpe-crate | go-capitalone |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| SSN: radix 10, 9 digits, AES-128 | 1.44× | 7.64× | 1.00× | 1.89× | 1.56× | 3.49× | 3.11× | 2.28× |
| PAN: radix 10, 16 digits, AES-128 | 1.37× | 7.40× | 1.00× | 1.75× | 1.57× | 3.68× | 3.75× | 2.29× |
| PAN: radix 10, 16 digits, AES-256 | 1.42× | 7.51× | 1.00× | 1.74× | 1.53× | 4.14× | 3.89× | 2.31× |
| Token: radix 36, 32 chars, AES-128 | 1.48× | 6.13× | 1.07× | 1.66× | 1.00× | 3.72× | 3.99× | 2.16× |
| Long: radix 10, 128 digits, AES-128 | 1.63× | 9.08× | 1.00× | 1.35× | 1.00× | 5.72× | 8.53× | 1.85× |

## This repository vs. the established library in the same language (encrypt speed-up)

| Workload | java vs java-bouncycastle | rust vs rust-fpe-crate | go vs go-capitalone |
|---|---:|---:|---:|
| SSN: radix 10, 9 digits, AES-128 | 2.42× | 3.11× | 1.21× |
| PAN: radix 10, 16 digits, AES-128 | 2.68× | 3.75× | 1.31× |
| PAN: radix 10, 16 digits, AES-256 | 2.91× | 3.89× | 1.33× |
| Token: radix 36, 32 chars, AES-128 | 2.51× | 3.72× | 1.30× |
| Long: radix 10, 128 digits, AES-128 | 3.51× | 8.49× | 1.37× |

## Spread (encrypt, min–max µs across rounds)

| Workload | java | elixir | rust | go | c-openssl | java-bouncycastle | rust-fpe-crate | go-capitalone |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| SSN: radix 10, 9 digits, AES-128 | 1.48–1.48 | 7.21–7.96 | 1.03–1.03 | 1.90–2.01 | 1.58–1.60 | 3.59–3.62 | 3.17–3.23 | 2.23–2.45 |
| PAN: radix 10, 16 digits, AES-128 | 1.47–1.52 | 7.63–8.21 | 1.06–1.08 | 1.81–1.90 | 1.64–1.79 | 3.90–4.01 | 4.02–4.13 | 2.34–2.64 |
| PAN: radix 10, 16 digits, AES-256 | 1.52–1.59 | 7.91–8.48 | 1.09–1.12 | 1.81–2.05 | 1.67–1.69 | 4.49–4.75 | 4.03–4.69 | 2.42–2.54 |
| Token: radix 36, 32 chars, AES-128 | 3.22–3.28 | 13.38–13.83 | 2.36–2.40 | 3.48–3.83 | 2.19–2.33 | 8.01–8.19 | 8.60–8.77 | 4.69–4.80 |
| Long: radix 10, 128 digits, AES-128 | 6.09–6.23 | 33.74–35.18 | 3.76–3.80 | 5.02–5.07 | 3.74–3.79 | 21.28–21.86 | 31.94–32.56 | 6.71–7.47 |

## Environment

- **CPU**: Intel(R) Xeon(R) Processor @ 2.10GHz (4 vCPU), Linux 6.18.44-fc-v310
- **Java**: openjdk version "21.0.12.1" 2026-08-18
- **Elixir**: Erlang/OTP 25 [erts-13.2.2.5] [source] [64-bit] [smp:4:4] [ds:4:4:10] [async-threads:1] [jit:ns] / Elixir 1.14.0 (compiled with Erlang/OTP 24)
- **Rust**: rustc 1.97.0 (2d8144b78 2026-07-07)
- **Go**: go version go1.24.7 linux/amd64
- **OpenSSL**: OpenSSL 3.0.13 30 Jan 2024 (Library: OpenSSL 3.0.13 30 Jan 2024); cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0
- Baselines: BouncyCastle bcprov-jdk18on 1.86 (`FPEFF1Engine`, default AES engine), Rust `fpe` 0.7.0 (`FlexibleNumeralString`), Go `github.com/capitalone/fpe` v1.2.1 (string API).
