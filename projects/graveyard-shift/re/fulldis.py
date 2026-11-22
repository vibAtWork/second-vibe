# Whole-file, control-flow-following AVM1 disassembler.
# The obfuscator relies on Flash Player not bounds-checking action jumps against
# their tag: real code is scattered through other tags' bytes. So we decode over
# the entire decompressed SWF buffer with absolute addresses, starting at every
# DoAction/DoInitAction entry and following Jump/If/function bodies anywhere.
# Usage: fulldis.py raw.swf out.txt
import sys, struct, collections

NAMES = {0x00: 'End', 0x04: 'NextFrame', 0x05: 'PrevFrame', 0x06: 'Play', 0x07: 'Stop', 0x0a: 'Add', 0x0b: 'Subtract', 0x0c: 'Multiply', 0x0d: 'Divide', 0x0e: 'Equals', 0x0f: 'Less', 0x10: 'And', 0x11: 'Or', 0x12: 'Not', 0x13: 'StringEquals', 0x14: 'StringLength', 0x15: 'StringExtract', 0x17: 'Pop', 0x18: 'ToInteger', 0x1c: 'GetVariable', 0x1d: 'SetVariable', 0x20: 'SetTarget2', 0x21: 'StringAdd', 0x22: 'GetProperty', 0x23: 'SetProperty', 0x24: 'CloneSprite', 0x25: 'RemoveSprite', 0x26: 'Trace', 0x2a: 'Throw', 0x2b: 'CastOp', 0x2c: 'ImplementsOp', 0x30: 'RandomNumber', 0x34: 'GetTime', 0x3a: 'Delete', 0x3b: 'Delete2', 0x3c: 'DefineLocal', 0x3d: 'CallFunction', 0x3e: 'Return', 0x3f: 'Modulo', 0x40: 'NewObject', 0x41: 'DefineLocal2', 0x42: 'InitArray', 0x43: 'InitObject', 0x44: 'TypeOf', 0x45: 'TargetPath', 0x46: 'Enumerate', 0x47: 'Add2', 0x48: 'Less2', 0x49: 'Equals2', 0x4a: 'ToNumber', 0x4b: 'ToString', 0x4c: 'PushDuplicate', 0x4d: 'StackSwap', 0x4e: 'GetMember', 0x4f: 'SetMember', 0x50: 'Increment', 0x51: 'Decrement', 0x52: 'CallMethod', 0x53: 'NewMethod', 0x54: 'InstanceOf', 0x55: 'Enumerate2', 0x60: 'BitAnd', 0x61: 'BitOr', 0x62: 'BitXor', 0x63: 'BitLShift', 0x64: 'BitRShift', 0x65: 'BitURShift', 0x66: 'StrictEquals', 0x67: 'Greater', 0x68: 'StringGreater', 0x69: 'Extends', 0x81: 'GotoFrame', 0x83: 'GetURL', 0x87: 'StoreRegister', 0x88: 'ConstantPool', 0x8a: 'WaitForFrame', 0x8b: 'SetTarget', 0x8c: 'GotoLabel', 0x8d: 'WaitForFrame2', 0x8e: 'DefineFunction2', 0x8f: 'Try', 0x94: 'With', 0x96: 'Push', 0x99: 'Jump', 0x9a: 'GetURL2', 0x9b: 'DefineFunction', 0x9d: 'If', 0x9e: 'Call', 0x9f: 'GotoFrame2'}

u16 = lambda b, i: struct.unpack_from('<H', b, i)[0]
s16 = lambda b, i: struct.unpack_from('<h', b, i)[0]


def cstr(b, i, end):
    j = b.find(b'\0', i, end)
    if j < 0: raise ValueError('unterminated string')
    return b[i:j].decode('latin1'), j + 1


def clean(s):
    return s if all(32 <= ord(c) < 127 for c in s) else 'X_' + s.encode('latin1').hex()


def decode(d, pc, pool):
    """Decode one instruction at pc. Returns (text, size, successors, new_pool, stops)."""
    op = d[pc]
    ln = u16(d, pc + 1) if op >= 0x80 else 0
    size = 3 + ln if op >= 0x80 else 1
    a, end = pc + 3, pc + 3 + ln
    if end > len(d): raise ValueError('truncated')
    nxt = pc + size
    name = NAMES.get(op, 'Op_%02x' % op)
    if op == 0x88:
        c = u16(d, a); k = a + 2; pl = []
        for _ in range(c): s, k = cstr(d, k, end); pl.append(clean(s))
        decoy = c <= 8 and sum(x.startswith('X_') for x in pl) * 2 >= c  # obfuscator junk table
        return 'ConstantPool(%d)%s %s' % (c, ' DECOY' if decoy else '', ' '.join(pl)), size, [nxt], (pool if decoy else pl), False
    if op == 0x96:
        k = a; vals = []
        while k < end:
            t = d[k]; k += 1
            if t == 0: s, k = cstr(d, k, end); vals.append(repr(clean(s)))
            elif t == 1: vals.append('%g' % struct.unpack_from('<f', d, k)[0]); k += 4
            elif t == 2: vals.append('null')
            elif t == 3: vals.append('undef')
            elif t == 4: vals.append('r%d' % d[k]); k += 1
            elif t == 5: vals.append(str(bool(d[k]))); k += 1
            elif t == 6: x = d[k:k + 8]; vals.append(repr(struct.unpack('<d', x[4:] + x[:4])[0])); k += 8
            elif t == 7: vals.append(str(struct.unpack_from('<i', d, k)[0])); k += 4
            elif t == 8: vals.append('"%s"' % (pool[d[k]] if d[k] < len(pool) else '?%d' % d[k])); k += 1
            elif t == 9: ix = u16(d, k); vals.append('"%s"' % (pool[ix] if ix < len(pool) else '?%d' % ix)); k += 2
            else: raise ValueError('bad push type')
        return 'Push ' + ', '.join(vals), size, [nxt], pool, False
    if op == 0x99:
        t = nxt + s16(d, a); return 'Jump %d' % t, size, [t], pool, False
    if op == 0x9d:
        t = nxt + s16(d, a); return 'If %d' % t, size, [nxt, t], pool, False
    if op in (0x9b, 0x8e):
        fname, k = cstr(d, a, end)
        n = u16(d, k); k += 2
        params = []
        if op == 0x9b:
            for _ in range(n): s, k = cstr(d, k, end); params.append(clean(s))
        else:
            k += 3
            for _ in range(n): reg = d[k]; k += 1; s, k = cstr(d, k, end); params.append('r%d=%s' % (reg, clean(s)))
        csize = u16(d, k)
        return '%s %s(%s) body %d..%d' % (name, clean(fname), ','.join(params), nxt, nxt + csize), size, [nxt + csize, nxt], pool, False
    if op == 0x87: return 'StoreRegister r%d' % d[a], size, [nxt], pool, False
    if op == 0x94:  # With: block of given size, continues after
        return 'With %d bytes' % u16(d, a), size, [nxt], pool, False
    if op in (0x00, 0x3e, 0x2a): return name, size, [], pool, True
    return name, size, [nxt], pool, False


def disasm(d, entries):
    out = {}
    work = [(e, []) for e in entries]
    seen = set()
    while work:
        pc, pool = work.pop()
        while 0 <= pc < len(d) and pc not in seen:
            seen.add(pc)
            try:
                txt, size, succ, pool, stop = decode(d, pc, pool)
            except (IndexError, ValueError, struct.error):
                break
            out[pc] = (txt, size)
            for s in succ[1:]: work.append((s, pool))
            if stop or not succ: break
            pc = succ[0]
    return out


def code_tags(d):
    p = 8; nb = d[p] >> 3; p += (5 + 4 * nb + 7) // 8 + 4
    res = []
    def walk(p, end, label):
        while p < end:
            h = u16(d, p); p += 2; code = h >> 6; ln = h & 63
            if ln == 63: ln = struct.unpack_from('<I', d, p)[0]; p += 4
            start = p; p += ln
            if code == 0: break
            if code == 39: walk(start + 4, start + ln, 'sprite%d' % u16(d, start))
            elif code == 12: res.append(('DoAction ' + label, start, start + ln))
            elif code == 59: res.append(('DoInitAction sprite %d' % u16(d, start), start + 2, start + ln))
    walk(p, len(d), 'main')
    return res


if __name__ == '__main__':
    d = open(sys.argv[1], 'rb').read()
    tags = code_tags(d)
    small = [t for t in tags if t[2] - t[1] < 1_000_000]  # the 4.6 MB model-data block is plain data code
    ins = disasm(d, [s for _, s, _ in small])
    inside = lambda a: any(s <= a < e for _, s, e in tags)
    outside = [a for a in ins if not inside(a)]
    ops = collections.Counter(t.split(' ')[0].split('(')[0] for t, _ in ins.values())
    print('reachable instructions', len(ins), '| outside any code tag:', len(outside))
    print(ops.most_common(32))
    with open(sys.argv[2], 'w') as f:
        for a in sorted(ins): f.write('%s%d: %s\n' % (' ' if inside(a) else '*', a, ins[a][0]))
