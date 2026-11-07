# FF1 benchmark protocol

Every implementation ships a bench executable with the same CLI and output, so
`run.py` can drive them uniformly.

## Invocation

```
<bench> [impl] <radix> <n> <keybits> <tweaklen>
```

`impl` picks "ours" or the baseline library where a bench binary covers both
(Java: `ours|bc`, Rust: `ours|fpe`, Go: `ours|capitalone`; the C and Elixir
benches only run "ours").

## Inputs (deterministic, identical everywhere)

- key: `keybits/8` bytes, `key[i] = i`
- tweak: `tweaklen` bytes, `tweak[i] = i`
- plaintext: `n` digits, `pt[i] = (7*i + 3) mod radix`

## Procedure

1. Encrypt `pt` once to get `ct`, decrypt `ct` and check it equals `pt`
   (the process exits non-zero otherwise).
2. For encrypt, then for decrypt, chain the operation (`x = f(x)`) so the
   result of every call is used and the compiler can't drop it:
   - warm-up: run for `FF1_WARMUP` seconds (default 1; `run.py` uses 2) and count calls
   - pick `per = calls * FF1_SAMPLE / FF1_WARMUP` (≈ `FF1_SAMPLE` s per sample)
   - time `FF1_SAMPLES` samples of `per` calls each (`run.py`: 9 × 0.3 s)
   - report the **median** ns/op
3. Print two CSV lines:

```
<impl-name>,<radix>,<n>,<keybits>,<tweaklen>,<encrypt|decrypt>,<ns_per_op>,<ct as base-36 digits>
```

`run.py` runs every (workload, implementation) pair in a fresh process,
repeats the whole matrix `--rounds` times (default 3), reports the median across
rounds, and **fails if any two implementations disagree on the ciphertext**.

## What is timed

One full FF1 call on an already-keyed instance: input validation, the ten
Feistel rounds, and digit-array ↔ integer conversion on entry and exit. The
AES key schedule is not timed, because it happens once per key at construction
in every implementation.

Digits travel as native arrays/lists (`uint16`/`int`/list-of-integers), except
for the Go capitalone baseline, which only has a string API. Its numbers
therefore include string ↔ big.Int conversion, as they would in real use.
