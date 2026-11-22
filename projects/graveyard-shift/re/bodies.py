# For every function body found in the whole-file walk, pick the constant pool that decodes it
# best (no unresolved names, most `this.mX = const` patterns) and print its constant field writes.
import sys, re, collections
sys.path.insert(0, sys.argv[0].rsplit('/', 1)[0])
from fulldis import decode, disasm, code_tags

d = open(sys.argv[1], 'rb').read()
tags = [t for t in code_tags(d) if t[2] - t[1] < 1_000_000]
allins = disasm(d, [s for _, s, _ in tags])
pools = {}
for t, _ in allins.values():
    if t.startswith('ConstantPool(') and 'DECOY' not in t:
        names = t[t.index(')') + 2:].split(' ')
        if len(names) > 8: pools[tuple(names)] = names
pools = list(pools.values())
bodies = sorted({tuple(map(int, m.groups())) for t, _ in allins.values() for m in [re.search(r'body (\d+)\.\.(\d+)', t)] if m})
FIELD = re.compile(r'Push (r\d+), "(m[A-Z][A-Za-z0-9_]*|_CLASSID_)", (-?[0-9.e+-]+|True|False|"[^"]*")$')

def walk(lo, hi, pool):
    out = []; pc = lo; prev = None
    work = [lo]; seen = set()
    while work:
        pc = work.pop()
        while lo <= pc < hi and pc not in seen:
            seen.add(pc)
            try: txt, size, succ, _, stop = decode(d, pc, pool)
            except (IndexError, ValueError): break
            out.append((pc, txt))
            for s in succ[1:]: work.append(s)
            if stop or not succ: break
            pc = succ[0]
    out.sort()
    return out

results = []
for lo, hi in bodies:
    if hi - lo > 20000: continue
    best = None
    for pool in pools:
        ins = walk(lo, hi, pool)
        bad = sum(t.count('"?') for _, t in ins)
        fields = []
        for (a, t), (_, n) in zip(ins, ins[1:]):
            m = FIELD.match(t)
            if m and n == 'SetMember': fields.append((m.group(2), m.group(3).strip('"')))
        score = (-bad, len(fields))
        if fields and (best is None or score > best[0]): best = (score, fields)
    if best and best[0][0] == 0 and len(best[1]) >= 2: results.append((lo, best[1]))
for lo, fs in results:
    print(lo, '; '.join(f'{k}={v}' for k, v in fs))
