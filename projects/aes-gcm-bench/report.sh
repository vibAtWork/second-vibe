#!/usr/bin/env bash
# Re-render the report for a saved run:  ./report.sh results/aes-gcm-<stamp>.csv [--color] [--ascii]
# (the matching .env.txt next to the CSV is picked up automatically)
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -f build/Report.class ]]; then mkdir -p build && javac -d build java/Report.java; fi
args=("$@"); [[ -t 1 && -z "${NO_COLOR:-}" ]] && args+=(--color)
exec java -cp build Report "${args[@]}" 2> >(grep -v '^Picked up' >&2)
