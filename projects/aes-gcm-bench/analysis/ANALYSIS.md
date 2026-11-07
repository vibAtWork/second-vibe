# Why is one faster than the other?

Measured on 2026-11-07 inside the Docker image: JDK 27-ea+34 (SunJCE),
OpenSSL 3.5.7, GCC 16.2. The CPU was a 4-vCPU Intel Xeon @ 2.10 GHz cloud VM
with AES-NI, AVX-512, VAES and VPCLMULQDQ. Runs were pinned to one CPU, best of 2.
The VM is shared, so expect ±10% noise per cell.

## The results being explained

AES-128-GCM encrypt, MB/s (the AES-256 and decrypt tables show the same pattern):

| | 16 B | 64 B | 256 B | 1 KiB | 8 KiB | 16 KiB | 1 MiB |
|---|---:|---:|---:|---:|---:|---:|---:|
| Java SunJCE | 31 | 205 | 687 | 2,413 | 8,262 | 9,427 | 11,396 |
| OpenSSL EVP (key passed every message) | 28 | 105 | 424 | 1,532 | 6,986 | 8,964 | 13,894 |
| OpenSSL EVP, key set once | 166 | 604 | 2,011 | 5,374 | 11,845 | 12,924 | 14,140 |

There are three questions here:

1. Why does Java beat the "OpenSSL EVP" row by 1.5–2× on small messages?
2. Why does OpenSSL "key set once" beat Java by about 3× on small messages?
3. Why does OpenSSL win by about 20% on large messages, even though both use AES-NI?

## 1. Java beats the "OpenSSL EVP" row because that row wastes about 500 ns per message

`analysis/ablate_openssl.c` times one seal under progressively lighter
re-initialisation. Fixed cost per message, measured at 0 bytes:

| What is redone per message | ns/msg |
|---|---:|
| A: `EVP_EncryptInit_ex(ctx, EVP_aes_128_gcm(), NULL, key, iv)` | 590 |
| B: same, but with a cipher fetched once via `EVP_CIPHER_fetch` | 322 |
| C: `EVP_EncryptInit_ex(ctx, NULL, NULL, key, iv)` (context kept) | 148 |
| D: `EVP_EncryptInit_ex(ctx, NULL, NULL, NULL, iv)` (IV only) | 77 |

So of the 590 ns, the costs break down like this:

- **About 270 ns: implicit fetch.** `EVP_aes_128_gcm()` returns a legacy
  `EVP_CIPHER`. On OpenSSL 3.x, every init with it has to look up the provider
  implementation again (method store lookup, locks, reference counts).
- **About 175 ns: context rebuild.** Passing any cipher, even the same one,
  makes EVP free and re-create the provider's GCM context.
- **About 70 ns: key setup.** That's AES key expansion plus precomputing
  H = AES_K(0) and the table of H powers used by the AVX-512 GHASH.
- **About 77 ns: the actual per-message work.**

Java does none of the first two. Its key setup is cached as well:
`com.sun.crypto.provider.AES_Crypt.init` keeps `prevKey` and only re-expands
the key schedule when the key bytes change. Source (JDK 27):

```java
if (!MessageDigest.isEqual(prevKey, key)) {
    sessionKe = genRoundKeys(key, rounds);
    ...
    prevKey = key.clone();
}
```

`analysis/JavaAblate.java` confirms it. `Cipher.init` alone costs about 80 ns.
Forcing a key change on every message (alternating two keys) adds 150–200 ns,
because Java expands the key in plain Java code, not an intrinsic.

**Conclusion:** the "Java ÷ EVP" ratio compares API call patterns more than
crypto. Calling OpenSSL 3 the obvious way (passing the cipher and key every
time) costs 4–7× on small messages. The "key set once" row is how OpenSSL
should be called.

## 2. OpenSSL "key set once" beats Java on small messages because of Java's fixed cost per message

Fixed cost per message (0-byte payload):

| | ns/msg |
|---|---:|
| OpenSSL, IV only (D) | 77 |
| Java, same key | 240–315 |
| of which `Cipher.init` | about 80 |

Java spends about 170–240 ns per message beyond what OpenSSL does. In
`GaloisCounterMode` (JDK 27), every init-plus-doFinal does the following:

- **Rebuilds the engine.** It creates a new `GCMEncrypt`/`GCMDecrypt`, a new
  `GCTR`, and a new `GHASH` object, and clones the IV and parameter spec.
  Measured allocation: **792 bytes of heap per 64-byte message**, via
  `ThreadMXBean.getThreadAllocatedBytes`. Switching to ParallelGC with a large
  young generation didn't change the timing. So the cost is building those
  objects, not GC pauses.
- **Recomputes H on every init.** H = AES_K(0^128) is encrypted again, and
  J0 is derived, even though H depends only on the key. OpenSSL computes H once,
  at key setup.
- **Computes the tag in Java code.** The length block, `ghash.digest()`, and a
  new `GCTR` for the tag all run per message.
- **Does bounds, overlap and IV-reuse checks.** It keeps the last IV for
  encryption and refuses to reuse it.
- **Skips the stitched GCM stub for anything under 512 bytes.**
  `PARALLEL_LEN = 512`: only whole 512-byte chunks go to the fused
  AES-CTR+GHASH intrinsic (`implGCMCrypt0`). Shorter messages, and the tail of
  longer ones, take two separate passes: the AES-CTR intrinsic, then the GHASH
  intrinsic. That's why Java's gap is widest from 16 to 256 bytes.

## 3. OpenSSL wins about 20% on large messages because its bulk loop is better

From the ablations, the steady per-byte cost is 0.090 ns/B for Java
(about 11.1 GB/s) and 0.074 ns/B for OpenSSL (about 13.6 GB/s). This gap is
in the bulk loop itself, not just per-call overhead.

`analysis/simd_paths.sh` masks CPU features to show which code path each
side uses. AES-128-GCM encrypt, MB/s:

| | 16 KiB | 1 MiB |
|---|---:|---:|
| OpenSSL, all features | 12,837 | 13,759 |
| OpenSSL, no VAES (AVX AES-NI stitched path) | 4,921 | 5,250 |
| OpenSSL, no AVX (plain AES-NI + PCLMUL) | 3,197 | 3,330 |
| OpenSSL, no AES-NI (software) | 439 | 450 |
| Java, all features | 9,016 | 11,830 |
| Java `-XX:UseAVX=2` (AVX2 stub) | 4,188 | 4,895 |
| Java `-XX:UseAVX=1` | 3,467 | 3,594 |
| Java `-XX:UseAVX=0` (SSE) | 1,100 | 1,174 |
| Java without AES intrinsics (pure Java) | 125 | 149 |

Both sides get their speed from the same place: AVX-512 with VAES and
VPCLMULQDQ, 2.5–2.8× faster than their AVX2 paths. Both stubs descend from
Intel's design. They differ in how much work they do per loop and per call.
I got this from reading the source (HotSpot
`src/hotspot/cpu/x86/stubGenerator_x86_64_aes.cpp`; OpenSSL 3.5
`crypto/modes/asm/aes-gcm-avx512.pl`):

| | OpenSSL 3.5 | HotSpot (JDK 27) |
|---|---|---|
| Blocks per main-loop iteration | 48 | 32 (2 × 16) |
| GHASH reductions | 1 per 48 blocks | 1 per 32 blocks |
| H powers | H¹–H¹⁶ precomputed once per key, in the context. H¹⁷–H⁴⁸ built per call | all 32 powers rebuilt on the stack on every stub call (`generateHtbl_32_blocks_avx512`) |
| Data handed to the stub | the whole message in one call | only multiples of 512 B. The tail goes through separate CTR and GHASH passes. Input over 1 MiB is split into 1 MiB calls |
| Tag and length block | in assembly/C | in Java (`GHASH.digest`, new `GCTR`) |

The 48-block loop with fewer reductions explains most of the steady-state
gap at 1 MiB. Per-call setup (rebuilding 32 H powers, the Java-side tag)
explains the extra gap at 8–16 KiB, where Java reaches only about 72% of
OpenSSL. I couldn't confirm this with hardware counters, because `perf` isn't
available in the sandbox. That attribution comes from the source, not from a
profile.

## What this means in practice

- **OpenSSL users (C):** fetch the cipher once (`EVP_CIPHER_fetch`), set the
  key once, and pass only the IV per message
  (`EVP_EncryptInit_ex(ctx, NULL, NULL, NULL, iv)`). On small messages that's
  4–7× faster than the obvious pattern.
- **Java users:** reusing one `Cipher` and one key is already the best you can
  do with SunJCE, because the key schedule is cached for you. Expect about
  250 ns of fixed cost per message and about 80% of OpenSSL's bulk throughput
  on AVX-512 machines. On a CPU without VAES/AVX-512 (many laptops before Ice
  Lake / Zen 4), compare the AVX2 rows above. There the two are much closer.
- If a Java service needs OpenSSL-class small-message throughput, the usual
  route is a native-backed provider such as Amazon Corretto Crypto Provider
  (AWS-LC). That wasn't measured here.

## Reproduce

The tables:

```bash
docker run --rm -t ghcr.io/vibatwork/aes-gcm-bench --repeat 2 --cpu 2
```

The ablations, natively from `projects/aes-gcm-bench`. They need a JDK,
gcc, and libssl-dev. Run `./run.sh --quick` once first so `build/` exists for
`simd_paths.sh`:

```bash
cc -O2 -o /tmp/ab analysis/ablate_openssl.c -lcrypto && /tmp/ab
java analysis/JavaAblate.java
CPU=2 analysis/simd_paths.sh
```

Results depend on your CPU, JDK, and OpenSSL version. OpenSSL 3.0, for
example, behaves differently in `openssl speed`, and CPUs without VAES use the
AVX2 paths.
