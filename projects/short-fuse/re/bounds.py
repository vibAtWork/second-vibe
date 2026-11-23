# Bounding boxes of shapes/sprites (union over all frames, translated by placements). Usage: bounds.py raw.swf CHARID...
import sys, struct
d = open(sys.argv[1], 'rb').read()
def u16(i): return struct.unpack('<H', d[i:i + 2])[0]
class Bits:
    def __init__(s, b): s.v = int.from_bytes(b[:64], 'big'); s.n = 512; s.p = 0
    def u(s, k): x = (s.v >> (s.n - s.p - k)) & ((1 << k) - 1) if k else 0; s.p += k; return x
    def s(s, k):
        x = s.u(k); return x - (1 << k) if k and x >> (k - 1) else x
def rect(b):
    r = Bits(b); n = r.u(5); return [r.s(n) / 20 for _ in range(4)]
def matrix(b):
    r = Bits(b); sx = sy = 1; r0 = r1 = 0
    if r.u(1): n = r.u(5); sx = r.s(n) / 65536; sy = r.s(n) / 65536
    if r.u(1): n = r.u(5); r0 = r.s(n) / 65536; r1 = r.s(n) / 65536
    n = r.u(5); tx = r.s(n) / 20; ty = r.s(n) / 20
    return sx, sy, r0, r1, tx, ty
shapes = {}; kids = {}
nbits = d[8] >> 3; p = 8 + (5 + 4 * nbits + 7) // 8 + 4
def walk(p, end, where):
    frame = 0
    while p < end:
        h = u16(p); t = h >> 6; l = h & 63; p += 2
        if l == 63: l = struct.unpack('<I', d[p:p + 4])[0]; p += 4
        if t in (2, 22, 32, 46): shapes[u16(p)] = rect(d[p + 2:])
        if t == 39: walk(p + 4, p + l, u16(p))
        if t == 1: frame += 1
        if t == 26 and where != 'root':
            f = d[p]; q = p + 3; cid = None; m = (1, 1, 0, 0, 0, 0)
            if f & 2: cid = u16(q); q += 2
            if f & 4: m = matrix(d[q:])
            if cid: kids.setdefault(where, []).append((frame, cid, m))
        p += l
        if t == 0 and where != 'root': return
walk(p, len(d), 'root')
def bounds(cid, depth=0):
    if cid in shapes: return shapes[cid]
    bs = []
    for frame, k, (sx, sy, r0, r1, tx, ty) in kids.get(cid, []):
        b = bounds(k, depth + 1)
        if b: bs.append([b[0] * sx + tx, b[1] * sx + tx, b[2] * sy + ty, b[3] * sy + ty])
    if not bs: return None
    return [min(b[0] for b in bs), max(b[1] for b in bs), min(b[2] for b in bs), max(b[3] for b in bs)]
for c in map(int, sys.argv[2:]):
    print(c, 'bounds xmin,xmax,ymin,ymax', bounds(c), 'first-frame kids', [(f, k) for f, k, _ in kids.get(c, [])[:3]])
