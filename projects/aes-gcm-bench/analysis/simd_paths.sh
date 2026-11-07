#!/usr/bin/env bash
# Which SIMD code path does each side use for bulk AES-GCM, and what is each worth?
# Masks CPU features for OpenSSL (OPENSSL_ia32cap) and for the JVM (-XX:UseAVX)
# and measures AES-128-GCM encrypt throughput on 16 KiB and 1 MiB messages.
# x86-64 only. Run from projects/aes-gcm-bench after ./run.sh has built build/.
set -euo pipefail
cd "$(dirname "$0")/.."
SECS=${SECS:-1}
PIN=(); [[ -n "${CPU:-}" ]] && PIN=(taskset -c "$CPU")

ossl() {  # label, OPENSSL_ia32cap value ('' = no masking)
  local r1 r2
  r1=$(env ${2:+OPENSSL_ia32cap=$2} ${PIN[@]+"${PIN[@]}"} build/gcm_bench --seconds "$SECS" --warmup 0.3 --sizes 16384,1048576 --keys 128 --no-rekey 2>/dev/null | awk -F, '$2=="enc"{printf "%9.0f", $7}')
  printf '  %-44s %s\n' "$1" "$r1"
}
java_() {  # label, extra JVM flags
  local r
  r=$(${PIN[@]+"${PIN[@]}"} java $2 -cp build GcmBench --seconds "$SECS" --warmup 2 --sizes 16384,1048576 --keys 128 2>/dev/null | awk -F, '$2=="enc"{printf "%9.0f", $7}')
  printf '  %-44s %s\n' "$1" "$r"
}

echo "AES-128-GCM encrypt, MB/s                           16 KiB    1 MiB"
echo "OpenSSL $(openssl version | awk '{print $2}') (EVP, key set once)"
ossl "all CPU features (default)" ""
# 2nd word = CPUID(7).EBX | CPUID(7).ECX<<32 ; bit 41 = VAES, bit 16 = AVX512F
ossl "no VAES (-> AVX AES-NI 'stitched' path)" ":~0x20000000000"
ossl "no AVX512F + no VAES" ":~0x20000010000"
# 1st word = CPUID(1).EDX | CPUID(1).ECX<<32 ; bit 60 = AVX, bit 33 = PCLMULQDQ
ossl "no AVX (-> plain AES-NI + PCLMUL)" "~0x1000000000000000:~0x20000010000"
ossl "no AES-NI (bit 57) (-> software)" "~0x200000000000000:~0x20000010000"
echo "Java $(java -version 2>&1 | grep -v '^Picked' | sed -n 's/.*Runtime Environment[^(]*(build \(.*\))/\1/p') (SunJCE)"
java_ "all CPU features (default)" ""
java_ "-XX:UseAVX=2 (no AVX-512 stubs)" "-XX:UseAVX=2"
java_ "-XX:UseAVX=1" "-XX:UseAVX=1"
java_ "-XX:UseAVX=0 (SSE only)" "-XX:UseAVX=0"
java_ "-XX:-UseAESIntrinsics -XX:-UseAESCTRIntrinsics" "-XX:+UnlockDiagnosticVMOptions -XX:-UseAESIntrinsics -XX:-UseAESCTRIntrinsics"
