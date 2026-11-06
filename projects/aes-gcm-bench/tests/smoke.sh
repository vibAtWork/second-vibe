#!/usr/bin/env bash
# Smoke test: builds both harnesses, runs NIST self-tests, does a tiny benchmark
# run and checks the CSV/report are well-formed. Takes ~15s.
set -euo pipefail
cd "$(dirname "$0")/.."
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
./run.sh --seconds 0.1 --sizes 16,4096 --keys 128,256 --out "$out" >"$out/report.txt" 2>"$out/err.txt" \
  || { cat "$out/err.txt"; exit 1; }
csv=$(ls "$out"/*.csv)
grep -q 'java self-test: OK' "$out/err.txt"
grep -q 'openssl self-test: OK' "$out/err.txt"
# 4 impls x 2 keys x 2 ops x 2 sizes = 32 rows + header
rows=$(($(wc -l <"$csv") - 1))
[[ $rows -eq 32 ]] || { echo "expected 32 rows, got $rows"; cat "$csv"; exit 1; }
awk -F, 'NR>1 && (NF!=7 || $5<=0 || $7<=0) { print "bad row: " $0; bad=1 } END { exit bad }' "$csv"
for t in "AES-128-GCM encrypt" "AES-128-GCM decrypt" "AES-256-GCM encrypt" "AES-256-GCM decrypt"; do
  grep -q "$t" "$out/report.txt" || { echo "missing table: $t"; exit 1; }
done
grep -q 'java/openssl-evp' "$out/report.txt"
echo "smoke test: PASS"
