# Per-block whole-buffer walk: resolve every name in a block against that block's real pool.
import sys, re, collections
sys.path.insert(0, sys.argv[0].rsplit('/', 1)[0])
from fulldis import decode, disasm, code_tags

def disasm_fixed(d, entry, pool):
    out = {}; work = [entry]; seen = set()
    while work:
        pc = work.pop()
        while 0 <= pc < len(d) and pc not in seen:
            seen.add(pc)
            try: txt, size, succ, _, stop = decode(d, pc, pool)
            except (IndexError, ValueError): break
            out[pc] = (txt, size)
            for s in succ[1:]: work.append(s)
            if stop or not succ: break
            pc = succ[0]
    return out

d = open(sys.argv[1], 'rb').read()
total = collections.Counter()
with open(sys.argv[2], 'w') as f:
    for label, start, end in code_tags(d):
        if end - start > 1_000_000: continue
        first = disasm(d, [start])
        pools = [t for t, _ in first.values() if t.startswith('ConstantPool(') and 'DECOY' not in t]
        if not pools: continue
        real = max(pools, key=lambda t: int(t[13:t.index(')')]))
        names = real[real.index(')') + 2:].split(' ')
        ins = disasm_fixed(d, start, names)
        bad = sum(t.count('"?') for t, _ in ins.values())
        total['blocks'] += 1; total['unresolved'] += bad
        f.write('\n=== %s  pool=%d names  unresolved=%d\n' % (label, len(names), bad))
        for a in sorted(ins): f.write('%d: %s\n' % (a, ins[a][0]))
print(dict(total))
