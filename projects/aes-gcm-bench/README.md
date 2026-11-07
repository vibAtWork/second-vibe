# aes-gcm-bench

Benchmark Java's AES-GCM (JCA, default provider SunJCE) against OpenSSL's
AES-GCM (libcrypto EVP API) on your own machine, with one command.

```bash
docker run --rm -t ghcr.io/vibatwork/aes-gcm-bench --quick
```

Or natively, with your own JDK and OpenSSL:

```bash
./run.sh --quick
```

It checks both implementations against NIST GCM test vectors, then measures
AES-128 and AES-256, encrypt and decrypt, over message sizes from 16 B to
1 MiB. You get a live progress line, then a report like this one (JDK 27-ea,
OpenSSL 3.5.7, GCC 16.2, a 4-vCPU AVX-512 cloud VM; AES-128 encrypt table shown):

```
 AES-GCM throughput: Java vs OpenSSL
 ───────────────────────────────────
 CPU         Intel(R) Xeon(R) Processor @ 2.10GHz · 4 threads
 Crypto      pclmulqdq aes avx2 avx512f sha_ni vaes vpclmulqdq
 Java        27-ea+34-2321 · provider SunJCE
 OpenSSL     OpenSSL 3.5.7 9 Jun 2026 (Library: OpenSSL 3.5.7 9 Jun 2026)
 C compiler  gcc (GCC) 16.2.0
 Method      1 s per cell · best of 2 · pinned to CPU 2

 AES-128-GCM encrypt                                               MB/s, higher is better
 ┌───────────────────────────┬───────┬───────┬───────┬───────┬────────┬────────┬────────┐
 │ message size              │  16 B │  64 B │ 256 B │ 1 KiB │  8 KiB │ 16 KiB │  1 MiB │
 ├───────────────────────────┼───────┼───────┼───────┼───────┼────────┼────────┼────────┤
 │ Java SunJCE               │    31 │   205 │   687 │ 2,413 │  8,262 │  9,427 │ 11,396 │
 │ OpenSSL EVP               │    28 │   105 │   424 │ 1,532 │  6,986 │  8,964 │ 13,894 │
 │ OpenSSL EVP, key set once │   166 │   604 │ 2,011 │ 5,374 │ 11,845 │ 12,924 │ 14,140 │
 │ openssl speed             │    90 │   362 │ 1,373 │ 3,879 │ 10,940 │ 12,171 │ 14,516 │
 ├───────────────────────────┼───────┼───────┼───────┼───────┼────────┼────────┼────────┤
 │ Java ÷ EVP                │ 1.12× │ 1.95× │ 1.62× │ 1.58× │  1.18× │  1.05× │  0.82× │
 │ Java ÷ EVP, key set once  │ 0.19× │ 0.34× │ 0.34× │ 0.45× │  0.70× │  0.73× │  0.81× │
 └───────────────────────────┴───────┴───────┴───────┴───────┴────────┴────────┴────────┘

 Summary  (geometric mean of Java ÷ OpenSSL across key sizes and directions)
 vs OpenSSL EVP:                 ≤1 KiB Java 1.78× faster  │  >1 KiB about even (1.03×)
 vs OpenSSL EVP, key set once:   ≤1 KiB OpenSSL 2.73× faster  │  >1 KiB OpenSSL 1.33× faster
```

In a terminal, the report is in colour: the best value in each column is
bold, and ratios are green when Java wins and red when it loses. **Why** the
numbers come out this way is explained in
[`analysis/ANALYSIS.md`](analysis/ANALYSIS.md).

A full run takes about 3 minutes, `--quick` about 30 seconds.

## Run with Docker

```bash
docker pull ghcr.io/vibatwork/aes-gcm-bench:latest
docker run --rm -t ghcr.io/vibatwork/aes-gcm-bench                  # full run
docker run --rm -t ghcr.io/vibatwork/aes-gcm-bench --repeat 3 --cpu 2
```

`-t` gives you colours and a live progress line. Without it you get plain
text, which is handy for piping into a file. To keep the raw CSV:

```bash
mkdir -p results && docker run --rm -t --user "$(id -u):$(id -g)" -v "$PWD/results:/app/results" ghcr.io/vibatwork/aes-gcm-bench
```

- **Toolchain in the image:** JDK 27 (early-access build 27-ea+34; GA is due
  March 2027), GCC 16.2, and Debian trixie's OpenSSL 3.5. It's built for
  `linux/amd64` and `linux/arm64`.
- **Other versions:** change them with build args, e.g.
  `docker build --build-arg JDK_IMAGE=openjdk:27-ea-35-jdk --build-arg GCC_IMAGE=gcc:15-trixie -t aes-gcm-bench .`
- **Publishing:** `.github/workflows/aes-gcm-bench-image.yml` runs the smoke
  test, then builds and pushes `:latest` and `:sha-<commit>` on every change to
  this directory.
- **Measuring your host instead:** Docker adds no meaningful overhead to
  CPU-bound crypto on Linux, but the image measures *its own* JDK and OpenSSL.
  To benchmark your host's versions, run `./run.sh` natively.

## Run natively

| Need | Debian/Ubuntu | Fedora | Arch |
|---|---|---|---|
| JDK 17+ (`javac`) | `openjdk-21-jdk-headless` | `java-21-openjdk-devel` | `jdk-openjdk` |
| C compiler | `build-essential` | `gcc` | `base-devel` |
| OpenSSL + headers | `openssl libssl-dev` | `openssl openssl-devel` | `openssl` |

`run.sh` tells you what's missing if something isn't installed.

## Options

```
--quick              fewer sizes, AES-128 only, short runs
--repeat N           run everything N times, report the best value per cell
--cpu N              pin to CPU N with taskset (less noise)
--seconds S          time per measurement (default 1)
--sizes 1500,9000    message sizes in bytes (e.g. MTU / jumbo frames)
--keys 256           key sizes (128,192,256)
--provider NAME      a different JCA provider (must be on the classpath)
--no-speed           skip the `openssl speed` rows
--color/--no-color   force colours on or off (default: on when stdout is a terminal; NO_COLOR respected)
--ascii              ASCII-only table borders and symbols
--out DIR            where to write results (default results/)
```

- To see what the JIT intrinsics are worth:
  `JAVA_OPTS="-XX:UseAVX=2" ./run.sh`
- To re-render a saved run: `./report.sh results/aes-gcm-<stamp>.csv`

Every run saves `results/aes-gcm-<stamp>.csv` (raw data) and
`results/aes-gcm-<stamp>.env.txt` (CPU, CPU flags, governor, Java, OpenSSL and
compiler versions).

## What the rows mean

All rows measure one-shot AEAD: each message is a separate seal or open with a
16-byte tag and no AAD.

- **Java SunJCE:** per message, `Cipher.init(key, new GCMParameterSpec(128, iv))`
  then `doFinal`. Encryption uses a fresh counter IV each time, because SunJCE
  refuses to reuse a key+IV pair for encryption. The JIT is warmed up first,
  and each cell gets a short warmup again right before it's timed.
- **OpenSSL EVP:** the same API calls in C. Per message,
  `EVP_EncryptInit_ex(ctx, EVP_aes_128_gcm(), NULL, key, iv)`, then Update,
  Final, and GET_TAG. This is the "obvious" way to call OpenSSL. On OpenSSL 3
  it pays a provider fetch and a context rebuild on every message. Java doesn't
  pay either, and caches its key schedule. So this row loses to Java on small
  messages for API reasons, not crypto reasons. See the analysis.
- **OpenSSL EVP, key set once:** the cipher and key are set once, and each
  message passes only a new IV. This is how a well-written C program calls
  OpenSSL, and it's the fairer comparison for crypto speed.
- **openssl speed:** `openssl speed -evp aes-N-gcm -bytes S`, a sanity check
  against OpenSSL's own tool. What it redoes per message depends on the
  version. 3.5 re-keys and adds 13 bytes of AAD; 3.0 does not.

## Why one is faster (short version)

The full write-up with measurements is in
[`analysis/ANALYSIS.md`](analysis/ANALYSIS.md).

- **Small messages, Java vs "OpenSSL EVP":** the OpenSSL row wastes about
  500 ns per message. About 270 ns goes to an implicit provider fetch, about
  175 ns to rebuilding the context, and about 70 ns to key setup. SunJCE skips
  all of that.
- **Small messages, Java vs "key set once":** Java has about 250 ns of fixed
  cost per message against OpenSSL's 77 ns. It rebuilds its GCM engine objects
  (about 800 B of heap per message), recomputes H, and computes the tag in Java
  code. Below 512 bytes it doesn't use the fused AES+GHASH stub at all.
- **Large messages:** both use AVX-512 VAES/VPCLMULQDQ assembly, but OpenSSL's
  loop handles 48 blocks per iteration with fewer GHASH reductions and caches H
  powers per key. HotSpot's handles 32 blocks and rebuilds its H-power table on
  every call. The result is about 20% in OpenSSL's favour.

## Getting stable numbers on a laptop

- Plug in to AC power and close the browser.
- Use `--cpu N --repeat 3`.
- If you can, set the performance governor for the run:
  `sudo cpupower frequency-set -g performance`. Set it back afterwards.
- Turbo and thermal throttling still add noise. Compare ratios within a run, not
  absolute MB/s across runs.

## Limitations

- Measures single-threaded throughput only. There's no multi-core scaling test.
- No AAD and no streaming (multi-`update`) mode. Only one-shot messages.
- Java numbers come from a hand-rolled timing loop with warmup, not JMH. Cells
  under 1 KiB can be noisy, so use `--repeat`.
- Java heap arrays only (no direct `ByteBuffer`s).
- Linux-focused: reads `/proc/cpuinfo`, and `--cpu` uses `taskset`.
  `analysis/simd_paths.sh` is x86-64 only.

## Tests

```bash
tests/smoke.sh
```

It builds both harnesses, runs the NIST known-answer self-tests, runs a tiny
benchmark, and checks that the CSV and the report are well-formed.

## Layout

```
run.sh                      one-command driver (progress, env capture, report)
report.sh                   re-render a saved CSV
java/GcmBench.java          JCA harness
java/Report.java            report renderer (tables, ratios, summary)
c/gcm_bench.c               OpenSSL EVP harness
Dockerfile                  JDK 27 + GCC 16 + OpenSSL 3.5 image (ENTRYPOINT run.sh)
analysis/ANALYSIS.md        why the faster one is faster
analysis/ablate_openssl.c   OpenSSL per-message cost breakdown
analysis/JavaAblate.java    SunJCE per-message cost breakdown + allocation
analysis/simd_paths.sh      which SIMD path each side uses (feature masking)
tests/smoke.sh              smoke test
```
