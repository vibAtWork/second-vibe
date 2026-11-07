#!/usr/bin/env bash
# One-command AES-GCM benchmark: Java (JCA) vs OpenSSL libcrypto.
# Usage: ./run.sh [--quick] [--seconds N] [--sizes 16,1024,...] [--keys 128,256]
#                 [--repeat N] [--cpu N] [--provider NAME] [--no-speed] [--out DIR]
#                 [--color|--no-color] [--ascii]
set -euo pipefail
shopt -s lastpipe   # so `cmd | record` updates the progress counter in this shell
cd "$(dirname "$0")"

SECONDS_PER=1; JWARM=3; SIZES="16,64,256,1024,8192,16384,1048576"; KEYS="128,256"
CPU=""; PROVIDER=""; SPEED=1; OUT="results"; REPEAT=1; ASCII=0
COLOR=auto
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick) SECONDS_PER=0.3; JWARM=2; SIZES="64,1024,16384,1048576"; KEYS="128" ;;
    --seconds) SECONDS_PER="$2"; shift ;;
    --sizes) SIZES="$2"; shift ;;
    --keys) KEYS="$2"; shift ;;
    --cpu) CPU="$2"; shift ;;
    --provider) PROVIDER="$2"; shift ;;
    --no-speed) SPEED=0 ;;
    --repeat) REPEAT="$2"; shift ;;
    --out) OUT="$2"; shift ;;
    --color) COLOR=always ;;
    --no-color) COLOR=never ;;
    --ascii) ASCII=1 ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

TTY=0; [[ -t 2 ]] && TTY=1
if [[ $COLOR == auto ]]; then
  COLOR=never; [[ -t 1 && -z "${NO_COLOR:-}" ]] && COLOR=always
fi
if [[ $COLOR == always ]]; then B=$'\e[1m'; D=$'\e[2m'; R=$'\e[31m'; G=$'\e[32m'; N=$'\e[0m'; else B= D= R= G= N=; fi
say()  { printf '%s\n' "$*" >&2; }
step() { say "${B}==>${N} $*"; }
die()  { say "${R}error:${N} $*"; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "missing '$1'. $2"; }
need java "Install a JDK 17+ (Debian/Ubuntu: sudo apt install openjdk-21-jdk-headless; Fedora: sudo dnf install java-21-openjdk-devel)"
need openssl "Install openssl."

PIN=()
if [[ -n "$CPU" ]]; then need taskset "taskset is in util-linux."; PIN=(taskset -c "$CPU"); fi

mkdir -p build "$OUT"
# AESGCM_PREBUILT=1 (set in the Docker image) skips compiling and uses build/ as-is.
if [[ "${AESGCM_PREBUILT:-0}" != 1 ]]; then
  need javac "Install a JDK 17+ (Debian/Ubuntu: sudo apt install openjdk-21-jdk-headless; Fedora: sudo dnf install java-21-openjdk-devel)"
  CC_BIN="${CC:-cc}"
  need "$CC_BIN" "Install a C compiler (sudo apt install build-essential / sudo dnf install gcc)."
  step "building"
  javac -d build java/GcmBench.java java/Report.java
  if ! "$CC_BIN" -O2 -o build/gcm_bench c/gcm_bench.c -lcrypto 2>build/cc.log; then
    cat build/cc.log >&2
    die "C build failed: install OpenSSL headers (Debian/Ubuntu: libssl-dev, Fedora: openssl-devel, Arch: openssl)."
  fi
  "$CC_BIN" --version | head -1 > build/cc-version.txt
fi

STAMP=$(date +%Y%m%d-%H%M%S)
CSV="$OUT/aes-gcm-$STAMP.csv"
ENVF="$OUT/aes-gcm-$STAMP.env.txt"
LOG=$(mktemp "${TMPDIR:-/tmp}/aes-gcm-bench.XXXXXX.log")
: > "$LOG"
JAVA_ARGS=(--seconds "$SECONDS_PER" --warmup "$JWARM" --sizes "$SIZES" --keys "$KEYS")
[[ -n "$PROVIDER" ]] && JAVA_ARGS+=(--provider "$PROVIDER")
C_ARGS=(--seconds "$SECONDS_PER" --warmup 1 --sizes "$SIZES" --keys "$KEYS")

flags=$(grep -m1 '^flags' /proc/cpuinfo 2>/dev/null | tr ' ' '\n' \
        | grep -xE 'aes|pclmulqdq|vaes|vpclmulqdq|avx2|avx512f|sha_ni' | tr '\n' ' ' || true)
[[ -z "$flags" ]] && flags=$(grep -m1 '^Features' /proc/cpuinfo 2>/dev/null | tr ' ' '\n' \
        | grep -xE 'aes|pmull|sha2|sve|sve2' | tr '\n' ' ' || true)   # arm64
cpu=$(grep -m1 -E 'model name|^Model' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//' || true)
gov=/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor
{
  echo "date=$(date -Is)"
  echo "kernel=$(uname -sr) $(uname -m)"
  echo "cpu=${cpu:-unknown}"
  echo "threads=$(nproc)"
  echo "cpu_flags=${flags% }"
  [[ -r $gov ]] && echo "governor=$(cat $gov)"
  echo "java=$(java -version 2>&1 | grep -v '^Picked up' | sed -n 's/.*Runtime Environment[^(]*(build \(.*\))/\1/p' | head -1)"
  echo "openssl=$(openssl version)"
  [[ -r build/cc-version.txt ]] && echo "cc=$(cat build/cc-version.txt)"
  echo "seconds=$SECONDS_PER"
  echo "repeat=$REPEAT"
  echo "pinned=${CPU:-no}"
} > "$ENVF"

echo "impl,op,keybits,size,ops,seconds,MBps" > "$CSV"

nk=$(tr ',' '\n' <<<"$KEYS" | wc -l); ns=$(tr ',' '\n' <<<"$SIZES" | wc -l)
TOTAL=$(( (3 + SPEED) * nk * 2 * ns * REPEAT )); DONE=0

human() { local s=$1; if (( s >= 1048576 && s % 1048576 == 0 )); then echo "$((s/1048576)) MiB";
          elif (( s >= 1024 && s % 1024 == 0 )); then echo "$((s/1024)) KiB"; else echo "$s B"; fi; }

# Reads CSV lines from stdin, appends them to $CSV and shows progress.
record() {
  local impl op kb sz ops secs mbps
  while IFS=, read -r impl op kb sz ops secs mbps; do
    [[ -z "$impl" || "$impl" == \#* ]] && continue
    echo "$impl,$op,$kb,$sz,$ops,$secs,$mbps" >> "$CSV"
    DONE=$((DONE + 1))
    local msg
    msg=$(printf '[%3d/%d] %-20s AES-%s %s %8s  %9s MB/s' "$DONE" "$TOTAL" "$impl" "$kb" "$op" "$(human "$sz")" \
          "$(printf '%.0f' "$mbps" | sed ':a;s/\B[0-9]\{3\}\>/,&/;ta')")
    if [[ $TTY == 1 ]]; then printf '\r\e[K  %s' "$msg" >&2; else say "  $msg"; fi
  done
}
endline() { [[ $TTY == 1 ]] && printf '\r\e[K' >&2; return 0; }

fail() { endline; say "${R}benchmark failed${N}; last output (full log: $LOG):"; tail -20 "$LOG" >&2; exit 1; }
trap fail ERR

step "self-tests ${D}(NIST GCM test cases 4 and 16)${N}"
java -cp build GcmBench --self-test >>"$LOG" 2>&1
say "  ${G}✓${N} Java $(sed -n 's/^java=//p' "$ENVF")"
build/gcm_bench --self-test >>"$LOG" 2>&1
say "  ${G}✓${N} $(sed -n 's/^openssl=//p' "$ENVF")"

say "${D}  ${TOTAL} measurements × ${SECONDS_PER}s + warmup; results → ${CSV}${N}"
for ((r = 1; r <= REPEAT; r++)); do
  sfx=""; [[ $REPEAT -gt 1 ]] && sfx=" ${D}(round $r/$REPEAT)${N}"
  step "Java$sfx"
  ${PIN[@]+"${PIN[@]}"} java ${JAVA_OPTS:-} -cp build GcmBench "${JAVA_ARGS[@]}" 2>>"$LOG" | record; endline
  step "OpenSSL EVP$sfx"
  ${PIN[@]+"${PIN[@]}"} build/gcm_bench "${C_ARGS[@]}" 2>>"$LOG" | record
  ${PIN[@]+"${PIN[@]}"} build/gcm_bench "${C_ARGS[@]}" --no-rekey 2>>"$LOG" | record; endline

  if [[ $SPEED -eq 1 ]]; then
    step "openssl speed$sfx"
    sec=${SECONDS_PER%.*}; [[ -z "$sec" || "$sec" -lt 1 ]] && sec=1
    for kb in ${KEYS//,/ }; do
      for op in enc dec; do
        flag=(); [[ $op == dec ]] && flag=(-decrypt)
        for sz in ${SIZES//,/ }; do
          line=$(${PIN[@]+"${PIN[@]}"} openssl speed -mr -seconds "$sec" -bytes "$sz" ${flag[@]+"${flag[@]}"} \
                   -evp "aes-$kb-gcm" 2>&1 | grep '^+R:' | tail -1) || true
          [[ -z "$line" ]] && { DONE=$((DONE + 1)); continue; }
          IFS=: read -r _ ops _ t <<<"$line"
          awk -v k="$kb" -v o="$op" -v s="$sz" -v n="$ops" -v t="$t" \
            'BEGIN{ if (t>0) printf "openssl-speed,%s,%s,%s,%s,%.6f,%.2f\n", o, k, s, n, t, n*s/t/1e6 }' | record
        done
      done
    done
    endline
  fi
done
trap - ERR

RARGS=("$CSV" --env "$ENVF")
[[ $COLOR == always ]] && RARGS+=(--color)
[[ $ASCII == 1 ]] && RARGS+=(--ascii)
java -cp build Report "${RARGS[@]}" 2> >(grep -v '^Picked up' >&2)
say "${D}raw data: $CSV · environment: $ENVF · re-render: ./report.sh $CSV${N}"
rm -f "$LOG"
