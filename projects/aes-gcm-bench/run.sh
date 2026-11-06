#!/usr/bin/env bash
# One-command AES-GCM benchmark: Java (JCA) vs OpenSSL libcrypto.
# Usage: ./run.sh [--quick] [--seconds N] [--sizes 16,1024,...] [--keys 128,256]
#                 [--repeat N] [--cpu N] [--provider NAME] [--no-speed] [--out DIR]
set -euo pipefail
cd "$(dirname "$0")"

SECONDS_PER=1; JWARM=3; SIZES="16,64,256,1024,8192,16384,1048576"; KEYS="128,256"
CPU=""; PROVIDER=""; SPEED=1; OUT="results"; REPEAT=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick) SECONDS_PER=0.3; JWARM=1; SIZES="64,1024,16384,1048576"; KEYS="128" ;;
    --seconds) SECONDS_PER="$2"; shift ;;
    --sizes) SIZES="$2"; shift ;;
    --keys) KEYS="$2"; shift ;;
    --cpu) CPU="$2"; shift ;;
    --provider) PROVIDER="$2"; shift ;;
    --no-speed) SPEED=0 ;;
    --repeat) REPEAT="$2"; shift ;;
    --out) OUT="$2"; shift ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing '$1'. $2" >&2; exit 1; }; }
need javac "Install a JDK 17+ (Debian/Ubuntu: sudo apt install openjdk-21-jdk-headless; Fedora: sudo dnf install java-21-openjdk-devel)"
need openssl "Install openssl."
CC_BIN="${CC:-cc}"
need "$CC_BIN" "Install a C compiler (sudo apt install build-essential / sudo dnf install gcc)."

PIN=()
if [[ -n "$CPU" ]]; then need taskset "taskset is in util-linux."; PIN=(taskset -c "$CPU"); fi

mkdir -p build "$OUT"
echo ">> building" >&2
javac -d build java/GcmBench.java
if ! "$CC_BIN" -O2 -o build/gcm_bench c/gcm_bench.c -lcrypto 2>build/cc.log; then
  cat build/cc.log >&2
  echo "C build failed: install OpenSSL headers (Debian/Ubuntu: libssl-dev, Fedora: openssl-devel, Arch: openssl)." >&2
  exit 1
fi

STAMP=$(date +%Y%m%d-%H%M%S)
CSV="$OUT/aes-gcm-$STAMP.csv"
LOG="$OUT/aes-gcm-$STAMP.env.txt"
JAVA_ARGS=(--seconds "$SECONDS_PER" --warmup "$JWARM" --sizes "$SIZES" --keys "$KEYS")
[[ -n "$PROVIDER" ]] && JAVA_ARGS+=(--provider "$PROVIDER")
C_ARGS=(--seconds "$SECONDS_PER" --warmup 1 --sizes "$SIZES" --keys "$KEYS")

{
  echo "date:     $(date -Is)"
  echo "kernel:   $(uname -sr)"
  echo "cpu:      $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ *//')"
  echo "cpu flags: $(grep -m1 '^flags' /proc/cpuinfo | tr ' ' '\n' | grep -xE 'aes|pclmulqdq|vaes|vpclmulqdq|avx2|avx512f' | tr '\n' ' ')"
  gov=/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor
  [[ -r $gov ]] && echo "governor: $(cat $gov)"
  echo "java:     $(java -version 2>&1 | grep -v '^Picked up' | head -1)"
  echo "openssl:  $(openssl version)"
  echo "pinned:   ${CPU:-no}"
  echo "repeat:   $REPEAT (report shows best of N)"
} | tee "$LOG" >&2

echo "impl,op,keybits,size,ops,seconds,MBps" > "$CSV"

echo ">> self-tests (NIST GCM vectors)" >&2
java -cp build GcmBench --self-test 2>&1 | grep -v '^Picked up' >&2
build/gcm_bench --self-test

for ((r = 1; r <= REPEAT; r++)); do
[[ $REPEAT -gt 1 ]] && echo ">> round $r/$REPEAT" >&2
echo ">> java" >&2
${PIN[@]+"${PIN[@]}"} java ${JAVA_OPTS:-} -cp build GcmBench "${JAVA_ARGS[@]}" 2> >(grep -v '^Picked up' >&2) | tee -a "$CSV"
echo ">> openssl EVP (same per-message method as Java)" >&2
${PIN[@]+"${PIN[@]}"} build/gcm_bench "${C_ARGS[@]}" | tee -a "$CSV"
${PIN[@]+"${PIN[@]}"} build/gcm_bench "${C_ARGS[@]}" --no-rekey | tee -a "$CSV"

if [[ $SPEED -eq 1 ]]; then
  echo ">> openssl speed (reference: streaming, no per-message init)" >&2
  sec=${SECONDS_PER%.*}; [[ -z "$sec" || "$sec" -lt 1 ]] && sec=1
  for kb in ${KEYS//,/ }; do
    for op in enc dec; do
      flag=(); [[ $op == dec ]] && flag=(-decrypt)
      for sz in ${SIZES//,/ }; do
        line=$(${PIN[@]+"${PIN[@]}"} openssl speed -mr -seconds "$sec" -bytes "$sz" "${flag[@]}" -evp "aes-$kb-gcm" 2>&1 | grep '^+R:' | tail -1) || true
        [[ -z "$line" ]] && continue
        IFS=: read -r _ ops _ t <<<"$line"
        awk -v k="$kb" -v o="$op" -v s="$sz" -v n="$ops" -v t="$t" \
          'BEGIN{ if (t>0) printf "openssl-speed,%s,%s,%s,%s,%.6f,%.2f\n", o, k, s, n, t, n*s/t/1e6 }' | tee -a "$CSV"
      done
    done
  done
fi

done

echo >&2
./report.sh "$CSV"
echo >&2
echo "raw CSV: $CSV   environment: $LOG" >&2
