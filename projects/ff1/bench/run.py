#!/usr/bin/env python3
"""Build and run the cross-language FF1 benchmark, check that every
implementation produces the same ciphertext, and write
results/results.csv and results/results.md.

    python3 bench/run.py [--rounds 3] [--no-build] [--quick]
"""
import argparse
import csv
import os
import platform
import statistics
import subprocess
import sys
import time
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULTS = os.path.join(ROOT, "results")

# (label, radix, n, keybits, tweaklen)
WORKLOADS = [
    ("SSN: radix 10, 9 digits, AES-128", 10, 9, 128, 8),
    ("PAN: radix 10, 16 digits, AES-128", 10, 16, 128, 8),
    ("PAN: radix 10, 16 digits, AES-256", 10, 16, 256, 8),
    ("Token: radix 36, 32 chars, AES-128", 36, 32, 128, 8),
    ("Long: radix 10, 128 digits, AES-128", 10, 128, 128, 8),
]

JAVA_CP = "target/ff1-0.1.0.jar:target/lib/*"

# name -> (cwd, command prefix, kind)
IMPLS = {
    "java": ("java", ["java", "-cp", JAVA_CP, "ff1.Bench", "ours"], "ours"),
    "elixir": ("elixir", ["mix", "run", "bench/ff1bench.exs", "ours"], "ours"),
    "rust": ("rust", ["./target/release/ff1bench", "ours"], "ours"),
    "go": ("go", ["./ff1bench", "ours"], "ours"),
    "c-openssl": ("openssl", ["./ff1bench"], "ours"),
    "java-bouncycastle": ("java", ["java", "-cp", JAVA_CP, "ff1.Bench", "bc"], "baseline"),
    "rust-fpe-crate": ("rust", ["./target/release/ff1bench", "fpe"], "baseline"),
    "go-capitalone": ("go", ["./ff1bench", "capitalone"], "baseline"),
}

BUILDS = [
    ("java", ["mvn", "-q", "-B", "package"]),
    ("elixir", ["mix", "do", "deps.get,", "compile"]),
    ("elixir", ["mix", "test"]),
    ("rust", ["cargo", "test", "--release", "-q"]),
    ("rust", ["cargo", "build", "--release", "-q"]),
    ("go", ["go", "test", "./..."]),
    ("go", ["go", "build", "-o", "ff1bench", "./cmd/ff1bench"]),
    ("openssl", ["make", "-s", "all"]),
    ("openssl", ["./ff1_test"]),
]


def env_for(cwd):
    env = dict(os.environ)
    if cwd == "elixir":
        env["MIX_ENV"] = "prod"
    return env


def build():
    for cwd, cmd in BUILDS:
        print(f"[build] {cwd}: {' '.join(cmd)}", flush=True)
        e = dict(os.environ)
        if cwd == "elixir" and cmd[1] != "test":
            e["MIX_ENV"] = "prod"
        subprocess.run(cmd, cwd=os.path.join(ROOT, cwd), check=True, env=e,
                       stdout=subprocess.DEVNULL)


def tool_versions():
    def first_line(cmd):
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            lines = [l for l in (out.stdout + out.stderr).splitlines()
                     if l.strip() and not l.startswith("Picked up")]
            return lines[0].strip() if lines else "?"
        except Exception as ex:  # noqa: BLE001
            return f"? ({ex})"

    cpu = "?"
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("model name"):
                    cpu = line.split(":", 1)[1].strip()
                    break
    except OSError:
        pass
    return {
        "CPU": f"{cpu} ({os.cpu_count()} vCPU), {platform.system()} {platform.release()}",
        "Java": first_line(["java", "-version"]),
        "Elixir": " / ".join(
            l for l in subprocess.run(["elixir", "--version"], capture_output=True,
                                      text=True).stdout.splitlines() if l.strip()),
        "Rust": first_line(["rustc", "--version"]),
        "Go": first_line(["go", "version"]),
        "OpenSSL": first_line(["openssl", "version"]) + "; " + first_line(["cc", "--version"]),
    }


def run_one(name, wl):
    cwd, cmd, _ = IMPLS[name]
    _, radix, n, keybits, tlen = wl
    full = cmd + [str(radix), str(n), str(keybits), str(tlen)]
    out = subprocess.run(full, cwd=os.path.join(ROOT, cwd), env=env_for(cwd),
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"{name} failed: {out.stderr}")
    rows = []
    for line in out.stdout.splitlines():
        parts = line.strip().split(",")
        if len(parts) == 8:
            rows.append(parts)
    if len(rows) != 2:
        raise RuntimeError(f"{name}: unexpected output {out.stdout!r} {out.stderr!r}")
    return rows


def fmt_ns(ns):
    return f"{ns / 1000:.2f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--no-build", action="store_true")
    ap.add_argument("--quick", action="store_true", help="short timings for smoke testing")
    ap.add_argument("--only", nargs="*", help="restrict to these implementations")
    args = ap.parse_args()

    if args.quick:
        os.environ.update(FF1_WARMUP="0.3", FF1_SAMPLE="0.1", FF1_SAMPLES="3")
    else:
        os.environ.setdefault("FF1_WARMUP", "2")
        os.environ.setdefault("FF1_SAMPLE", "0.3")
        os.environ.setdefault("FF1_SAMPLES", "9")

    if not args.no_build:
        build()

    impls = args.only or list(IMPLS)
    # samples[(impl, wl_index, op)] = [ns, ...] ; cts[wl_index][impl] = ct
    samples = defaultdict(list)
    cts = defaultdict(dict)
    raw_rows = []
    t_start = time.time()
    for rnd in range(args.rounds):
        for wi, wl in enumerate(WORKLOADS):
            for name in impls:
                rows = run_one(name, wl)
                for r in rows:
                    impl, radix, n, keybits, tlen, op, ns, ct = r
                    samples[(name, wi, op)].append(float(ns))
                    cts[wi][name] = ct
                    raw_rows.append([rnd + 1, wl[0]] + r)
                print(f"[round {rnd + 1}/{args.rounds}] {wl[0]:<38} {name:<18} "
                      f"enc {fmt_ns(float(rows[0][6])):>8} us  dec {fmt_ns(float(rows[1][6])):>8} us",
                      flush=True)
    elapsed = time.time() - t_start

    # Cross-implementation correctness: identical ciphertext for every workload.
    mismatches = []
    for wi, by_impl in cts.items():
        if len(set(by_impl.values())) != 1:
            mismatches.append((WORKLOADS[wi][0], by_impl))
    if mismatches:
        for label, by_impl in mismatches:
            print("CIPHERTEXT MISMATCH", label, by_impl, file=sys.stderr)
        sys.exit(1)

    os.makedirs(RESULTS, exist_ok=True)
    with open(os.path.join(RESULTS, "raw.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["round", "workload", "impl", "radix", "n", "keybits", "tweaklen", "op",
                    "ns_per_op", "ciphertext"])
        w.writerows(raw_rows)

    med = {k: statistics.median(v) for k, v in samples.items()}
    with open(os.path.join(RESULTS, "results.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["workload", "impl", "op", "median_ns_per_op", "min_ns", "max_ns", "ops_per_sec"])
        for wi, wl in enumerate(WORKLOADS):
            for name in impls:
                for op in ("encrypt", "decrypt"):
                    v = samples[(name, wi, op)]
                    m = med[(name, wi, op)]
                    w.writerow([wl[0], name, op, f"{m:.1f}", f"{min(v):.1f}", f"{max(v):.1f}",
                                f"{1e9 / m:.0f}"])

    ours = [i for i in impls if IMPLS[i][2] == "ours"]
    base = [i for i in impls if IMPLS[i][2] == "baseline"]
    lines = []
    lines.append("# FF1 benchmark results\n")
    lines.append(f"Generated {time.strftime('%Y-%m-%d %H:%M:%S %Z')} by `bench/run.py` "
                 f"({args.rounds} rounds, {elapsed / 60:.1f} min). Every implementation produced "
                 "identical ciphertext for every workload.\n")
    lines.append("Each cell: median microseconds per operation (lower is better). Each number is "
                 f"the median of {args.rounds} process runs; each run reports the median of "
                 f"{os.environ['FF1_SAMPLES']} timed samples of ~{os.environ['FF1_SAMPLE']} s "
                 f"after a {os.environ['FF1_WARMUP']} s warm-up. Single thread. "
                 "Tweak is 8 bytes in all workloads.\n")
    for op in ("encrypt", "decrypt"):
        lines.append(f"\n## {op.capitalize()} (µs/op)\n")
        hdr = ["Workload"] + ours + base
        lines.append("| " + " | ".join(hdr) + " |")
        lines.append("|" + "|".join(["---"] + ["---:"] * (len(hdr) - 1)) + "|")
        for wi, wl in enumerate(WORKLOADS):
            vals = {i: med[(i, wi, op)] for i in ours + base}
            best = min(vals[i] for i in ours)
            cells = []
            for i in ours + base:
                s = fmt_ns(vals[i])
                if i in ours and vals[i] == best:
                    s = f"**{s}**"
                cells.append(s)
            lines.append(f"| {wl[0]} | " + " | ".join(cells) + " |")

    lines.append("\n## Throughput, encrypt (operations per second, single thread)\n")
    hdr = ["Workload"] + ours + base
    lines.append("| " + " | ".join(hdr) + " |")
    lines.append("|" + "|".join(["---"] + ["---:"] * (len(hdr) - 1)) + "|")
    for wi, wl in enumerate(WORKLOADS):
        cells = [f"{1e9 / med[(i, wi, 'encrypt')]:,.0f}" for i in ours + base]
        lines.append(f"| {wl[0]} | " + " | ".join(cells) + " |")

    lines.append("\n## Relative to the fastest implementation (encrypt, ×slower)\n")
    lines.append("| " + " | ".join(hdr) + " |")
    lines.append("|" + "|".join(["---"] + ["---:"] * (len(hdr) - 1)) + "|")
    for wi, wl in enumerate(WORKLOADS):
        best = min(med[(i, wi, "encrypt")] for i in ours + base)
        cells = [f"{med[(i, wi, 'encrypt')] / best:.2f}×" for i in ours + base]
        lines.append(f"| {wl[0]} | " + " | ".join(cells) + " |")

    pairs = [("java", "java-bouncycastle"), ("rust", "rust-fpe-crate"), ("go", "go-capitalone")]
    pairs = [p for p in pairs if p[0] in impls and p[1] in impls]
    if pairs:
        lines.append("\n## This repository vs. the established library in the same language "
                     "(encrypt speed-up)\n")
        lines.append("| Workload | " + " | ".join(f"{a} vs {b}" for a, b in pairs) + " |")
        lines.append("|" + "|".join(["---"] + ["---:"] * len(pairs)) + "|")
        for wi, wl in enumerate(WORKLOADS):
            cells = [f"{med[(b, wi, 'encrypt')] / med[(a, wi, 'encrypt')]:.2f}×" for a, b in pairs]
            lines.append(f"| {wl[0]} | " + " | ".join(cells) + " |")

    lines.append("\n## Spread (encrypt, min–max µs across rounds)\n")
    lines.append("| " + " | ".join(hdr) + " |")
    lines.append("|" + "|".join(["---"] + ["---:"] * (len(hdr) - 1)) + "|")
    for wi, wl in enumerate(WORKLOADS):
        cells = []
        for i in ours + base:
            v = samples[(i, wi, "encrypt")]
            cells.append(f"{fmt_ns(min(v))}–{fmt_ns(max(v))}")
        lines.append(f"| {wl[0]} | " + " | ".join(cells) + " |")

    lines.append("\n## Environment\n")
    for k, v in tool_versions().items():
        lines.append(f"- **{k}**: {v}")
    lines.append("- Baselines: BouncyCastle bcprov-jdk18on 1.86 (`FPEFF1Engine`, default AES engine), "
                 "Rust `fpe` 0.7.0 (`FlexibleNumeralString`), Go `github.com/capitalone/fpe` v1.2.1 "
                 "(string API).")
    with open(os.path.join(RESULTS, "results.md"), "w") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
