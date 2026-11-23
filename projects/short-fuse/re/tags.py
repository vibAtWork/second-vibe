# List an uncompressed SWF's header (version, fps, stage) and tags, incl. code-tag offsets. Usage: tags.py raw.swf
import sys, struct, collections
d = open(sys.argv[1], 'rb').read()
nbits = d[8] >> 3; rect_bytes = (5 + 4 * nbits + 7) // 8
p = 8 + rect_bytes
fps = d[p + 1] + d[p] / 256; frames = struct.unpack('<H', d[p + 2:p + 4])[0]
def rect(b):
    n = b[0] >> 3; bits = int.from_bytes(b[:(5 + 4 * n + 7) // 8], 'big'); tot = (5 + 4 * n + 7) // 8 * 8
    vals = [(bits >> (tot - 5 - n * (i + 1))) & ((1 << n) - 1) for i in range(4)]
    return [v / 20 for v in vals]
print('version', d[3], 'fps', fps, 'frames', frames, 'stage', rect(d[8:]))
p += 4
names = {0: 'End', 1: 'ShowFrame', 2: 'DefineShape', 9: 'SetBackgroundColor', 12: 'DoAction', 26: 'PlaceObject2', 39: 'DefineSprite', 43: 'FrameLabel', 56: 'ExportAssets', 59: 'DoInitAction', 14: 'DefineSound', 15: 'StartSound', 22: 'DefineShape2', 32: 'DefineShape3', 37: 'DefineEditText', 36: 'DefineBitsLossless2', 21: 'DefineBitsJPEG2', 35: 'DefineBitsJPEG3', 48: 'DefineFont2', 11: 'DefineText', 33: 'DefineText2', 34: 'DefineButton2', 28: 'RemoveObject2', 24: 'Protect', 58: 'EnableDebugger', 64: 'EnableDebugger2', 20: 'DefineBitsLossless', 6: 'DefineBits', 8: 'JPEGTables', 18: 'SoundStreamHead', 19: 'SoundStreamBlock', 45: 'SoundStreamHead2', 13: 'DefineFontInfo', 10: 'DefineFont', 62: 'DefineFontInfo2', 46: 'DefineMorphShape', 7: 'DefineButton', 17: 'DefineButtonSound', 88: 'DefineFontName', 69: 'FileAttributes', 77: 'Metadata', 41: 'ProductInfo', 65: 'ScriptLimits', 66: 'SetTabIndex'}
cnt = collections.Counter(); code = 0; out = []
def walk(p, end, depth):
    global code
    while p < end:
        h = struct.unpack('<H', d[p:p + 2])[0]; t = h >> 6; l = h & 63; p += 2
        if l == 63: l = struct.unpack('<I', d[p:p + 4])[0]; p += 4
        cnt[names.get(t, t)] += 1
        if t in (12, 59): code += l; out.append((depth, names[t], p, l))
        if t == 39: walk(p + 4, p + l, depth + 1)
        if t == 56:
            n = struct.unpack('<H', d[p:p + 2])[0]; q = p + 2
            for _ in range(n):
                cid = struct.unpack('<H', d[q:q + 2])[0]; j = d.index(b'\0', q + 2); print('export', cid, d[q + 2:j].decode('latin1')); q = j + 1
        p += l
        if t == 0 and depth: return
walk(p, len(d), 0)
print(cnt.most_common())
print('code tags', len(out), 'bytes', code)
for o in out[:400]: print(*o)
