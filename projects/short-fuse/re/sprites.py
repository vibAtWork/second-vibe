# Which character id (and frame count) is placed under an instance name. Usage: sprites.py raw.swf NAME...
import sys, struct
d = open(sys.argv[1], 'rb').read()
def u16(i): return struct.unpack('<H', d[i:i + 2])[0]
nbits = d[8] >> 3; p = 8 + (5 + 4 * nbits + 7) // 8 + 4
frames = {}; places = []
def walk(p, end, where):
    while p < end:
        h = u16(p); t = h >> 6; l = h & 63; p += 2
        if l == 63: l = struct.unpack('<I', d[p:p + 4])[0]; p += 4
        if t == 39: frames[u16(p)] = u16(p + 2); walk(p + 4, p + l, u16(p))
        if t == 26:
            f = d[p]; q = p + 3; cid = None
            if f & 2: cid = u16(q); q += 2
            if f & 0x20 and not (f & 4) and not (f & 8): pass
            # find name by scanning: only reliable when no matrix/cxform; so parse properly
            if f & 4:
                bits = int.from_bytes(d[q:q + 40], 'big'); pos = 0
                def rd(n):
                    global pos
                    return 0
            places.append((where, cid, p, f))
        p += l
        if t == 0 and where != 'root': return
walk(p, len(d), 'root')
import re
names = sys.argv[2:]
for (where, cid, pos, f) in places:
    if cid is None: continue
    blob = d[pos:pos + 80]
    for n in names:
        if n.encode() + b'\0' in blob: print(n, 'char', cid, 'in', where, 'frames', frames.get(cid))
