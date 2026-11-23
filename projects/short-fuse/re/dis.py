# Linear AVM1 (ActionScript 1/2) disassembler for every DoAction / DoInitAction / button
# and clip-event action, with constant-pool names resolved. Usage: dis.py raw.swf out.txt
import sys, struct
NAMES={0x00:'End',0x04:'NextFrame',0x05:'PrevFrame',0x06:'Play',0x07:'Stop',0x0a:'Add',0x0b:'Subtract',0x0c:'Multiply',0x0d:'Divide',0x0e:'Equals',0x0f:'Less',0x10:'And',0x11:'Or',0x12:'Not',0x13:'StringEquals',0x14:'StringLength',0x15:'StringExtract',0x17:'Pop',0x18:'ToInteger',0x1c:'GetVariable',0x1d:'SetVariable',0x20:'SetTarget2',0x21:'StringAdd',0x22:'GetProperty',0x23:'SetProperty',0x24:'CloneSprite',0x25:'RemoveSprite',0x26:'Trace',0x27:'StartDrag',0x28:'EndDrag',0x29:'StringLess',0x2a:'Throw',0x2b:'CastOp',0x2c:'ImplementsOp',0x30:'RandomNumber',0x31:'MBStringLength',0x32:'CharToAscii',0x33:'AsciiToChar',0x34:'GetTime',0x35:'MBStringExtract',0x36:'MBCharToAscii',0x37:'MBAsciiToChar',0x3a:'Delete',0x3b:'Delete2',0x3c:'DefineLocal',0x3d:'CallFunction',0x3e:'Return',0x3f:'Modulo',0x40:'NewObject',0x41:'DefineLocal2',0x42:'InitArray',0x43:'InitObject',0x44:'TypeOf',0x45:'TargetPath',0x46:'Enumerate',0x47:'Add2',0x48:'Less2',0x49:'Equals2',0x4a:'ToNumber',0x4b:'ToString',0x4c:'PushDuplicate',0x4d:'StackSwap',0x4e:'GetMember',0x4f:'SetMember',0x50:'Increment',0x51:'Decrement',0x52:'CallMethod',0x53:'NewMethod',0x54:'InstanceOf',0x55:'Enumerate2',0x60:'BitAnd',0x61:'BitOr',0x62:'BitXor',0x63:'BitLShift',0x64:'BitRShift',0x65:'BitURShift',0x66:'StrictEquals',0x67:'Greater',0x68:'StringGreater',0x69:'Extends',0x81:'GotoFrame',0x83:'GetURL',0x87:'StoreRegister',0x88:'ConstantPool',0x8a:'WaitForFrame',0x8b:'SetTarget',0x8c:'GotoLabel',0x8d:'WaitForFrame2',0x8e:'DefineFunction2',0x8f:'Try',0x94:'With',0x96:'Push',0x99:'Jump',0x9a:'GetURL2',0x9b:'DefineFunction',0x9d:'If',0x9e:'Call',0x9f:'GotoFrame2'}
d = open(sys.argv[1], 'rb').read()
out = open(sys.argv[2], 'w')
def u16(i): return struct.unpack('<H', d[i:i + 2])[0]
def cstr(i):
    j = d.index(b'\0', i); return d[i:j].decode('latin1'), j + 1
def dis(start, end, label):
    out.write(f'\n==== {label} @{start} len {end - start}\n')
    pool = []; pc = start; ind = 0; fends = []
    while pc < end:
        while fends and pc >= fends[-1]: fends.pop(); ind -= 1; out.write('  ' * ind + '}\n')
        op = d[pc]
        if op == 0: out.write('  ' * ind + f'{pc - start:5} End\n'); pc += 1; continue
        ln = u16(pc + 1) if op >= 0x80 else 0
        data = d[pc + 3:pc + 3 + ln] if op >= 0x80 else b''
        name = NAMES.get(op, 'Op_%02x' % op); txt = name
        if op == 0x88:
            c = struct.unpack('<H', data[:2])[0]; k = pc + 5; pool = []
            for _ in range(c): s, k = cstr(k); pool.append(s)
            txt = f'ConstantPool {pool}'
        elif op == 0x96:
            k = 0; vals = []
            while k < len(data):
                t = data[k]; k += 1
                if t == 0: j = data.index(b'\0', k); vals.append(repr(data[k:j].decode('latin1'))); k = j + 1
                elif t == 1: vals.append('%g' % struct.unpack('<f', data[k:k + 4])[0]); k += 4
                elif t == 2: vals.append('null')
                elif t == 3: vals.append('undef')
                elif t == 4: vals.append('r%d' % data[k]); k += 1
                elif t == 5: vals.append(str(bool(data[k]))); k += 1
                elif t == 6: vals.append('%r' % struct.unpack('<d', data[k + 4:k + 8] + data[k:k + 4])[0]); k += 8
                elif t == 7: vals.append(str(struct.unpack('<i', data[k:k + 4])[0])); k += 4
                elif t == 8: vals.append(repr(pool[data[k]]) if data[k] < len(pool) else '?c%d' % data[k]); k += 1
                elif t == 9: i = struct.unpack('<H', data[k:k + 2])[0]; vals.append(repr(pool[i]) if i < len(pool) else '?C'); k += 2
                else: vals.append('??'); break
            txt = 'Push ' + ', '.join(vals)
        elif op in (0x99, 0x9d):
            off = struct.unpack('<h', data[:2])[0]; txt = f'{name} -> {pc + 5 + off - start}'
        elif op == 0x8e or op == 0x9b:
            fn, k = cstr(pc + 3); n = u16(k); k += 2
            if op == 0x8e:
                regs = d[k]; k += 1; flags = u16(k); k += 2; args = []
                for _ in range(n): r = d[k]; a, k = cstr(k + 1); args.append(f'{a}=r{r}' if r else a)
            else:
                args = []
                for _ in range(n): a, k = cstr(k); args.append(a)
            body = u16(k); txt = f'function {fn}({", ".join(args)}) {{'
            out.write('  ' * ind + f'{pc - start:5} {txt}\n'); pc += 3 + ln; fends.append(pc + body); ind += 1; continue
        elif op == 0x8c: txt = f'GotoLabel {cstr(pc + 3)[0]}'
        elif op == 0x83: a, k = cstr(pc + 3); b, _ = cstr(k); txt = f'GetURL {a} {b}'
        elif op == 0x81: txt = f'GotoFrame {u16(pc + 3)}'
        elif op == 0x87: txt = f'StoreRegister r{data[0]}'
        elif op == 0x8b: txt = f'SetTarget {cstr(pc + 3)[0]!r}'
        elif op == 0x9f: txt = f'GotoFrame2 play={data[0] & 1}'
        out.write('  ' * ind + f'{pc - start:5} {txt}\n')
        pc += 1 + (2 + ln if op >= 0x80 else 0)
# walk tags (incl. inside sprites), also PlaceObject2 clip actions and DefineButton2 actions
nbits = d[8] >> 3; p = 8 + (5 + 4 * nbits + 7) // 8 + 4
def walk(p, end, where):
    frame = 0
    while p < end:
        h = u16(p); t = h >> 6; l = h & 63; p += 2
        if l == 63: l = struct.unpack('<I', d[p:p + 4])[0]; p += 4
        if t == 12: dis(p, p + l, f'DoAction {where} frame {frame + 1}')
        if t == 59: dis(p + 2, p + l, f'DoInitAction sprite {u16(p)}')
        if t == 1: frame += 1
        if t == 43: out.write(f'\n#### label {cstr(p)[0]!r} {where} frame {frame + 1}\n')
        if t == 39: walk(p + 4, p + l, f'sprite {u16(p)}')
        if t == 34: # DefineButton2: id, flags, actionOffset
            bid = u16(p); off = u16(p + 3)
            if off:
                q = p + 3 + off
                while True:
                    size = u16(q); cond = u16(q + 2)
                    dis(q + 4, (q + size) if size else p + l, f'Button {bid} cond {cond:#x} in {where}')
                    if not size: break
                    q += size
        if t == 26: # PlaceObject2 with clip actions
            flags = d[p]
            if flags & 0x80:
                q = p + 3
                if flags & 2: q += 2
                if flags & 4:  # matrix
                    bits = int.from_bytes(d[q:q + 32], 'big'); pos = 0
                    def rd(n):
                        nonlocal pos; v = (bits >> (256 - pos - n)) & ((1 << n) - 1); pos += n; return v
                    if rd(1): n = rd(5); rd(n); rd(n)
                    if rd(1): n = rd(5); rd(n); rd(n)
                    n = rd(5); rd(n); rd(n); q += (pos + 7) // 8
                if flags & 8:  # cxform with alpha
                    bits = int.from_bytes(d[q:q + 32], 'big'); pos = 0
                    def rd2(n):
                        nonlocal pos; v = (bits >> (256 - pos - n)) & ((1 << n) - 1); pos += n; return v
                    ha = rd2(1); hm = rd2(1); n = rd2(4)
                    if hm: [rd2(n) for _ in range(4)]
                    if ha: [rd2(n) for _ in range(4)]
                    q += (pos + 7) // 8
                if flags & 0x10: q += 2
                nm = ''
                if flags & 0x20: nm, q = cstr(q)
                if flags & 0x40: q += 2
                q += 2 + 4  # reserved + all event flags (SWF6: 32-bit)
                while True:
                    ev = struct.unpack('<I', d[q:q + 4])[0]
                    if not ev: break
                    size = struct.unpack('<I', d[q + 4:q + 8])[0]; q += 8
                    st = q
                    if ev & 0x20000: q += 1
                    dis(st, st + size, f'ClipAction ev {ev:#x} on {nm!r} in {where} frame {frame + 1}'); q = st + size
        p += l
        if t == 0 and where != 'root': return
walk(p, len(d), 'root')
