# Control-flow-following AVM1 (ActionScript 2) disassembler for obfuscated SWFs.
# Decodes only instructions reachable from entry points, follows Jump/If targets,
# treats DefineFunction(2) bodies as separate entry points. Usage: flowdis.py raw.swf out.txt
import sys, struct
NAMES={0x00:'End',0x04:'NextFrame',0x05:'PrevFrame',0x06:'Play',0x07:'Stop',0x0a:'Add',0x0b:'Subtract',0x0c:'Multiply',0x0d:'Divide',0x0e:'Equals',0x0f:'Less',0x10:'And',0x11:'Or',0x12:'Not',0x13:'StringEquals',0x14:'StringLength',0x15:'StringExtract',0x17:'Pop',0x18:'ToInteger',0x1c:'GetVariable',0x1d:'SetVariable',0x20:'SetTarget2',0x21:'StringAdd',0x22:'GetProperty',0x23:'SetProperty',0x24:'CloneSprite',0x25:'RemoveSprite',0x26:'Trace',0x27:'StartDrag',0x28:'EndDrag',0x29:'StringLess',0x2a:'Throw',0x2b:'CastOp',0x2c:'ImplementsOp',0x30:'RandomNumber',0x31:'MBStringLength',0x32:'CharToAscii',0x33:'AsciiToChar',0x34:'GetTime',0x35:'MBStringExtract',0x36:'MBCharToAscii',0x37:'MBAsciiToChar',0x3a:'Delete',0x3b:'Delete2',0x3c:'DefineLocal',0x3d:'CallFunction',0x3e:'Return',0x3f:'Modulo',0x40:'NewObject',0x41:'DefineLocal2',0x42:'InitArray',0x43:'InitObject',0x44:'TypeOf',0x45:'TargetPath',0x46:'Enumerate',0x47:'Add2',0x48:'Less2',0x49:'Equals2',0x4a:'ToNumber',0x4b:'ToString',0x4c:'PushDuplicate',0x4d:'StackSwap',0x4e:'GetMember',0x4f:'SetMember',0x50:'Increment',0x51:'Decrement',0x52:'CallMethod',0x53:'NewMethod',0x54:'InstanceOf',0x55:'Enumerate2',0x60:'BitAnd',0x61:'BitOr',0x62:'BitXor',0x63:'BitLShift',0x64:'BitRShift',0x65:'BitURShift',0x66:'StrictEquals',0x67:'Greater',0x68:'StringGreater',0x69:'Extends',0x81:'GotoFrame',0x83:'GetURL',0x87:'StoreRegister',0x88:'ConstantPool',0x8a:'WaitForFrame',0x8b:'SetTarget',0x8c:'GotoLabel',0x8d:'WaitForFrame2',0x8e:'DefineFunction2',0x8f:'Try',0x94:'With',0x96:'Push',0x99:'Jump',0x9a:'GetURL2',0x9b:'DefineFunction',0x9d:'If',0x9e:'Call',0x9f:'GotoFrame2'}
def u16(b,i):return struct.unpack('<H',b[i:i+2])[0]
def s16(b,i):return struct.unpack('<h',b[i:i+2])[0]
def cstr(b,i):
    j=b.find(b'\0',i)
    if j<0: j=len(b)
    return b[i:j].decode('latin1'),j+1
def clean(s): # make obfuscated names readable
    return s if all(32<=ord(c)<127 for c in s) else 'X_'+s.encode('latin1').hex()
def disasm(code):
    """Return {offset: (text, length)} for reachable instructions; pool tracking along the walk."""
    out={}; pool=[]; work=[0]; seen=set()
    while work:
        pc=work.pop()
        while 0<=pc<len(code) and pc not in seen:
            seen.add(pc)
            op=code[pc]; ln=0; data=b''
            if op>=0x80:
                if pc+3>len(code): break
                ln=u16(code,pc+1); data=code[pc+3:pc+3+ln]
            size=1+(3+ln-1 if op>=0x80 else 0)
            name=NAMES.get(op,'Op_%02x'%op)
            txt=name; nxt=pc+size; succ=[nxt]; stop=False
            if op==0x88:
                c=u16(data,0);k=2;pool=[]
                for _ in range(c):
                    s,k=cstr(data,k);pool.append(clean(s))
                txt='ConstantPool(%d) %s'%(c,' '.join(pool[:400]))
            elif op==0x96:
                k=0;vals=[]
                while k<len(data):
                    t=data[k];k+=1
                    if t==0: s,k=cstr(data,k);vals.append(repr(clean(s)))
                    elif t==1: vals.append('%g'%struct.unpack('<f',data[k:k+4])[0]);k+=4
                    elif t==2: vals.append('null')
                    elif t==3: vals.append('undef')
                    elif t==4: vals.append('r%d'%data[k]);k+=1
                    elif t==5: vals.append(str(bool(data[k])));k+=1
                    elif t==6:
                        x=data[k:k+8];x=x[4:]+x[:4];vals.append(repr(struct.unpack('<d',x)[0]));k+=8
                    elif t==7: vals.append(str(struct.unpack('<i',data[k:k+4])[0]));k+=4
                    elif t==8: vals.append('"%s"'%(pool[data[k]] if data[k]<len(pool) else '?%d'%data[k]));k+=1
                    elif t==9: ix=u16(data,k);vals.append('"%s"'%(pool[ix] if ix<len(pool) else '?%d'%ix));k+=2
                    else: vals.append('?t%d'%t);break
                txt='Push '+', '.join(vals)
            elif op==0x99:
                tgt=nxt+s16(data,0); txt='Jump L%d'%tgt; succ=[tgt]
            elif op==0x9d:
                tgt=nxt+s16(data,0); txt='If L%d'%tgt; succ=[nxt,tgt]
            elif op in (0x9b,0x8e):
                fname,k=cstr(data,0); fname=clean(fname)
                if op==0x9b:
                    n=u16(data,k);k+=2;params=[]
                    for _ in range(n): s,k=cstr(data,k);params.append(clean(s))
                    csize=u16(data,k)
                else:
                    n=u16(data,k);k+=2;nregs=data[k];k+=1;flags=u16(data,k);k+=2;params=[]
                    for _ in range(n): reg=data[k];k+=1;s,k=cstr(data,k);params.append('r%d=%s'%(reg,clean(s)))
                    csize=u16(data,k)
                body=nxt
                txt='DefineFunction%s %s(%s) body L%d..L%d'%('2' if op==0x8e else '',fname,','.join(params),body,body+csize)
                succ=[body+csize,body]
            elif op==0x87: txt='StoreRegister r%d'%data[0]
            elif op==0x8f: txt='Try'
            elif op in (0x00,0x3e,0x2a): stop=True; succ=[]
            out[pc]=(txt,size)
            for s in succ[1:]: work.append(s)
            if stop or not succ: break
            pc=succ[0]
    return out
def tags(d):
    p=8;nb=d[p]>>3;p+=(5+4*nb+7)//8+4
    res=[]
    def walk(b,p,label):
        while p<len(b):
            h=u16(b,p);p+=2;code=h>>6;ln=h&63
            if ln==63: ln=struct.unpack('<I',b[p:p+4])[0];p+=4
            body=b[p:p+ln];p+=ln
            if code==0: break
            if code==39: walk(body,4,'sprite%d'%u16(body,0))
            elif code==12: res.append(('DoAction '+label,body))
            elif code==59: res.append(('DoInitAction sprite %d'%u16(body,0),body[2:]))
    walk(d,p,'main')
    return res
d=open(sys.argv[1],'rb').read()
with open(sys.argv[2],'w') as f:
    for label,body in tags(d):
        ins=disasm(body)
        f.write('\n=== %s (%d reachable of %d bytes)\n'%(label,sum(s for _,s in ins.values()),len(body)))
        for off in sorted(ins): f.write('L%d: %s\n'%(off,ins[off][0]))
