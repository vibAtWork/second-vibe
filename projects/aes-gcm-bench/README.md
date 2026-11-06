# aes-gcm-bench

Benchmark Java's AES-GCM (JCA, default provider SunJCE) against OpenSSL's
AES-GCM (libcrypto EVP API) on your own machine, with one command.

```bash
./run.sh
```

It builds both harnesses, checks each against NIST GCM test vectors, runs them
over a range of message sizes for AES-128 and AES-256, encrypt and decrypt, then
prints a table like this (numbers from a 4-vCPU cloud VM, AES-NI + VAES, best of 2):

```
AES-128-GCM encrypt  (MB/s, higher is better)
impl \ msg size              64B      1KiB     16KiB      1MiB
java-SunJCE                  211      2290      9233     11868
openssl-evp                   84      1195      7922     13895
openssl-evp-norekey          329      3547     11960     14021
java/openssl-evp           2.51x     1.92x     1.17x     0.85x
```

A full run takes about 2–3 minutes. `./run.sh --quick` takes about 20 seconds.

## Run with Docker (nothing to install but Docker)

```bash
docker run --rm ghcr.io/vibatwork/aes-gcm-bench --quick
```

Any `run.sh` option can go after the image name. To keep the CSV files:

```bash
mkdir -p results && docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/results:/app/results" ghcr.io/vibatwork/aes-gcm-bench --repeat 3 --cpu 2
```

- The image is built for `linux/amd64` and `linux/arm64` by
  `.github/workflows/aes-gcm-bench-image.yml`, which pushes `:latest` and
  `:sha-<commit>` to GHCR on every change to this directory.
- Docker adds no meaningful overhead to CPU-bound crypto on Linux. But the
  image measures **its own** Java (Temurin 21) and OpenSSL (Ubuntu 24.04,
  3.0.x), not the versions on your host. To benchmark your host's
  OpenSSL/JDK, run `./run.sh` natively.
- To build the image locally: `docker build -t aes-gcm-bench projects/aes-gcm-bench`.

## Requirements

| Need | Debian/Ubuntu | Fedora | Arch |
|---|---|---|---|
| JDK 17+ (`javac`) | `openjdk-21-jdk-headless` | `java-21-openjdk-devel` | `jdk-openjdk` |
| C compiler | `build-essential` | `gcc` | `base-devel` |
| OpenSSL + headers | `openssl libssl-dev` | `openssl openssl-devel` | `openssl` |

```bash
sudo apt install openjdk-21-jdk-headless build-essential openssl libssl-dev
```

`run.sh` tells you what's missing if something isn't installed.

## Options

```
./run.sh --quick              # fewer sizes, AES-128 only, short runs
./run.sh --repeat 3           # run everything 3x, report the best value per cell
./run.sh --cpu 2              # pin to CPU 2 with taskset (less noise)
./run.sh --seconds 2          # time per measurement (default 1)
./run.sh --sizes 1500,9000    # message sizes in bytes (e.g. MTU / jumbo frames)
./run.sh --keys 256           # key sizes (128,192,256)
./run.sh --provider BC        # use a different JCA provider (must be on the classpath)
./run.sh --no-speed           # skip the `openssl speed` reference rows
JAVA_OPTS="-XX:-UseAESIntrinsics -XX:-UseGHASHIntrinsics" ./run.sh   # see what the JIT intrinsics are worth
./report.sh results/aes-gcm-<stamp>.csv   # re-print the table from a saved run
```

Every run saves `results/aes-gcm-<stamp>.csv` (raw data) and
`results/aes-gcm-<stamp>.env.txt` (CPU, CPU flags, governor, Java and OpenSSL versions).

## What the rows mean

All rows measure one-shot AEAD: each message is a separate seal or open with a
16-byte tag and no AAD.

- **java-SunJCE**: per message, `Cipher.init(key, new GCMParameterSpec(128, iv))`
  then `doFinal`. Encryption uses a fresh counter IV each time, because SunJCE
  refuses to reuse a key+IV pair for encryption. Decryption reuses one fixed
  ciphertext. The JIT gets warmed up for 3s per key size before timing starts.
- **openssl-evp**: the same steps in C. Per message, `EVP_EncryptInit_ex(ctx, cipher, key, iv)`,
  then Update, Final, and GET_TAG. Like Java's `init`, it passes the key every
  time, so the key schedule is counted. This is the like-for-like comparison,
  and the `java/openssl-evp` ratio row is based on it.
- **openssl-evp-norekey**: the cipher and key are set once, and each message
  passes only a new IV. This is how a carefully tuned C program would call
  OpenSSL. On OpenSSL 3.x, re-passing the cipher on every init costs a lot for
  small messages, so this row is noticeably faster.
- **openssl-speed**: `openssl speed -evp aes-N-gcm -bytes S`. OpenSSL's own
  streaming loop, with no per-message init. Treat it as a ceiling, not a peer.

## How to read the results

- **Large messages (≥16 KiB)** are limited by raw AES-CTR and GHASH throughput.
  Both sides use AES-NI and PCLMULQDQ (or VAES/VPCLMULQDQ). OpenSSL's
  hand-written assembly usually leads by 10–20%.
- **Small messages** are limited by per-call overhead: object setup, key
  expansion, and OpenSSL 3's provider dispatch. Java can beat OpenSSL here when
  OpenSSL is called the naive way. It loses to the `norekey` style.
- If `cpu flags` in the env file doesn't list `aes` and `pclmulqdq`, both sides
  fall back to software and the numbers mean little.

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
- Java numbers come from a hand-rolled timing loop with warmup, not JMH. Good
  enough for comparing against OpenSSL at this granularity, but JIT and GC
  effects can make single cells noisy. Use `--repeat`.
- Java heap arrays only (no direct `ByteBuffer`s).
- Linux-focused: reads `/proc/cpuinfo`, and `--cpu` uses `taskset`.

## Tests

```bash
tests/smoke.sh
```

It builds both harnesses, runs the NIST known-answer self-tests (test cases 4
and 16 from the GCM spec), runs a tiny benchmark, and checks that the CSV and
the report are well-formed.

## Layout

```
run.sh               one-command driver
report.sh            CSV -> tables
java/GcmBench.java   JCA harness
c/gcm_bench.c        OpenSSL EVP harness
tests/smoke.sh       smoke test
Dockerfile           runnable image (prebuilt harnesses, ENTRYPOINT run.sh)
```
