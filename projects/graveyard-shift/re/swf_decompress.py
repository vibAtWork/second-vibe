import sys,zlib,struct
d=open(sys.argv[1],'rb').read()
print(d[:3],d[3],struct.unpack('<I',d[4:8]))
if d[:3]==b'CWS': body=zlib.decompress(d[8:])
else: body=d[8:]
open(sys.argv[2],'wb').write(d[:8]+body)
