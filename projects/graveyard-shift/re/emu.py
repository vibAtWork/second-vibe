# Tiny AVM1 emulator for the obfuscator's dispatcher: executes a block from offset 0
# like Flash Player would, and logs every instruction actually executed (first visit).
import sys, struct
exec(open(__file__.replace('emu.py', 'flowdis.py')).read().split("d=open(sys.argv[1]")[0])
def run(code, maxsteps=200000, log=None):
    class S(list):
        def pop(self, *a): return super().pop(*a) if self else None
    pc=0; stack=S(); vars={}; funcs={}; pool=[]; trace=[]; steps=0; frames=[]
    while steps<maxsteps:
        steps+=1
        if pc>=len(code): break
        op=code[pc]; ln=0; data=b''
        if op>=0x80: ln=u16(code,pc+1); data=code[pc+3:pc+3+ln]
        nxt=pc+(3+ln if op>=0x80 else 1)
        name=NAMES.get(op,'Op_%02x'%op)
        trace.append((pc,name))
        if op==0x00:
            if frames: pc,stack=frames.pop(); stack.append(None); continue
            break
        elif op==0x96:
            k=0
            while k<len(data):
                t=data[k];k+=1
                if t==0: s,k=cstr(data,k);stack.append(s)
                elif t==1: stack.append(struct.unpack('<f',data[k:k+4])[0]);k+=4
                elif t in (2,3): stack.append(None)
                elif t==4: stack.append(('reg',data[k]));k+=1
                elif t==5: stack.append(bool(data[k]));k+=1
                elif t==6: x=data[k:k+8];x=x[4:]+x[:4];stack.append(struct.unpack('<d',x)[0]);k+=8
                elif t==7: stack.append(struct.unpack('<i',data[k:k+4])[0]);k+=4
                elif t==8: stack.append(pool[data[k]] if data[k]<len(pool) else '?');k+=1
                elif t==9: ix=u16(data,k);stack.append(pool[ix] if ix<len(pool) else '?');k+=2
        elif op==0x88:
            c=u16(data,0);k=2;pool=[]
            for _ in range(c): s,k=cstr(data,k);pool.append(s)
        elif op==0x1c: v=stack.pop(); stack.append(vars.get(v,0))
        elif op==0x1d: v=stack.pop(); n=stack.pop(); vars[n]=v
        elif op==0x3c: v=stack.pop(); n=stack.pop(); vars[n]=v
        elif op==0x41: n=stack.pop(); vars[n]=None
        elif op in (0x0a,0x47): b=stack.pop(); a=stack.pop(); stack.append((a or 0)+(b or 0) if not isinstance(a,str) and not isinstance(b,str) else str(a)+str(b))
        elif op==0x0b: b=stack.pop(); a=stack.pop(); stack.append((a or 0)-(b or 0))
        elif op in (0x0e,0x49,0x66): b=stack.pop(); a=stack.pop(); stack.append(a==b)
        elif op==0x12: a=stack.pop(); stack.append(not a)
        elif op==0x17: stack and stack.pop()
        elif op==0x4c: stack.append(stack[-1] if stack else None)
        elif op==0x99: pc=nxt+s16(data,0); continue
        elif op==0x9d:
            c=stack.pop() if stack else False
            if c: pc=nxt+s16(data,0); continue
        elif op in (0x9b,0x8e):
            fname,k=cstr(data,0)
            if op==0x9b:
                n=u16(data,k);k+=2
                for _ in range(n): s,k=cstr(data,k)
                csize=u16(data,k)
            else:
                n=u16(data,k);k+=2;k+=1;k+=2
                for _ in range(n): k+=1; s,k=cstr(data,k)
                csize=u16(data,k)
            if fname: funcs[fname]=nxt
            else: stack.append(('func',nxt))
            pc=nxt+csize; continue
        elif op==0x3d:
            fn=stack.pop(); nargs=stack.pop() or 0
            for _ in range(int(nargs)): stack.pop()
            if fn in funcs: frames.append((nxt,stack)); stack=S(); pc=funcs[fn]; continue
            stack.append(None)
        elif op==0x3e:
            v=stack.pop() if stack else None
            if frames: pc,stack=frames.pop(); stack.append(v); continue
            break
        else:
            # anything else is "real" work: stop the dispatcher emulation here
            return trace, vars, ('stopped at', pc, name)
        pc=nxt
    return trace, vars, ('ended', pc)
if __name__=='__main__':
    d=open(sys.argv[1],'rb').read()
    want=sys.argv[2]
    for label,body in tags(d):
        if label==want:
            tr,vs,end=run(body)
            print(label,'executed',len(tr),'instructions; end:',end,'vars:',vs)
            print(' '.join(n for _,n in tr[:80]))
