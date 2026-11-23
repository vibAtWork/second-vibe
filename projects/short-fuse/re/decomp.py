# Tiny AVM1 stack-to-expression decompiler over dis.py output. Usage: decomp.py dis.txt [block-header-filter]
import sys, re
lines = open(sys.argv[1]).read().split('\n')
want = sys.argv[2] if len(sys.argv) > 2 else None
BIN = {'Add2': '+', 'Add': '+', 'Subtract': '-', 'Multiply': '*', 'Divide': '/', 'Modulo': '%', 'Equals2': '==', 'Equals': '==', 'StrictEquals': '===', 'Less2': '<', 'Less': '<', 'Greater': '>', 'And': '&&', 'Or': '||', 'StringAdd': '..', 'StringEquals': 'eq', 'BitAnd': '&', 'BitOr': '|', 'BitXor': '^', 'BitLShift': '<<', 'BitRShift': '>>', 'BitURShift': '>>>'}
PROPS = ['_x', '_y', '_xscale', '_yscale', '_currentframe', '_totalframes', '_alpha', '_visible', '_width', '_height', '_rotation', '_target', '_framesloaded', '_name', '_droptarget', '_url', '_highquality', '_focusrect', '_soundbuftime', '_quality', '_xmouse', '_ymouse']
def run(block, header):
    print(header)
    st = []; regs = {}
    def pop(): return st.pop() if st else '?'
    for ln in block:
        m = re.match(r'(\s*)\s*(\d+) (.*)', ln)
        if not m:
            if ln.strip() == '}': print(ln)
            continue
        ind, off, ins = m.group(1), m.group(2), m.group(3)
        sp = ind + f'{off:>5}  '
        op = ins.split(' ')[0]
        if op == 'Push':
            body = ins[5:]
            vals = re.findall(r"'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\"|[^, ]+", body)
            for v in vals:
                if re.match(r'r\d+$', v): st.append(regs.get(v, v))
                else: st.append(v)
        elif op in BIN: b = pop(); a = pop(); st.append(f'({a} {BIN[op]} {b})')
        elif op == 'Not': st.append(f'!{pop()}')
        elif op == 'GetVariable': st.append(pop().strip("'"))
        elif op == 'SetVariable': v = pop(); n = pop().strip("'"); print(f'{sp}{n} = {v}')
        elif op == 'GetMember': k = pop(); o = pop(); st.append(f'{o}.{k.strip(chr(39))}')
        elif op == 'SetMember': v = pop(); k = pop(); o = pop(); print(f'{sp}{o}.{k.strip(chr(39))} = {v}')
        elif op == 'GetProperty': i = pop(); t = pop(); st.append(f'{t.strip(chr(39))}.{PROPS[int(float(i))] if i.replace(".", "").isdigit() else "prop" + i}')
        elif op == 'SetProperty': v = pop(); i = pop(); t = pop(); print(f'{sp}{t.strip(chr(39))}.{PROPS[int(float(i))] if i.replace(".", "").isdigit() else "prop" + i} = {v}')
        elif op in ('CallFunction', 'CallMethod', 'NewObject', 'NewMethod'):
            if op in ('CallMethod', 'NewMethod'): name = pop().strip("'"); obj = pop()
            else: name = pop().strip("'"); obj = None
            n = pop(); n = int(float(n)) if n.replace('.', '').isdigit() else 0
            args = [pop() for _ in range(n)]
            f = (f'{obj}.{name}' if obj else name)
            st.append(('new ' if op.startswith('New') else '') + f'{f}({", ".join(args)})')
        elif op == 'Pop': v = pop(); print(f'{sp}{v};')
        elif op == 'StoreRegister': r = ins.split()[1]; regs[r] = st[-1] if st else '?'; 
        elif op == 'PushDuplicate': st.append(st[-1] if st else '?')
        elif op == 'If': print(f'{sp}if {pop()} goto {ins.split("-> ")[1]}')
        elif op == 'Jump': print(f'{sp}goto {ins.split("-> ")[1]}')
        elif op in ('RandomNumber',): st.append(f'random({pop()})')
        elif op in ('ToInteger',): st.append(f'int({pop()})')
        elif op in ('ToNumber',): st.append(f'Number({pop()})')
        elif op in ('ToString',): st.append(f'String({pop()})')
        elif op == 'Increment': st.append(f'({pop()} + 1)')
        elif op == 'Decrement': st.append(f'({pop()} - 1)')
        elif op == 'DefineLocal': v = pop(); n = pop().strip("'"); print(f'{sp}var {n} = {v}')
        elif op == 'DefineLocal2': print(f'{sp}var {pop()}')
        elif op == 'Return': print(f'{sp}return {pop()}')
        elif op == 'GetTime': st.append('getTimer()')
        elif op == 'InitArray':
            n = int(float(pop())); st.append('[' + ', '.join(pop() for _ in range(n)) + ']')
        elif op == 'InitObject':
            n = int(float(pop())); kv = []
            for _ in range(n): v = pop(); k = pop(); kv.append(f'{k}: {v}')
            st.append('{' + ', '.join(kv) + '}')
        elif op == 'TypeOf': st.append(f'typeof({pop()})')
        elif op == 'StackSwap': st[-1], st[-2] = st[-2], st[-1]
        elif op == 'CloneSprite': d = pop(); t = pop(); s = pop(); print(f'{sp}duplicateMovieClip({s}, {t}, {d})')
        elif op == 'RemoveSprite': print(f'{sp}removeMovieClip({pop()})')
        elif op == 'Trace': print(f'{sp}trace({pop()})')
        elif op == 'Delete' or op == 'Delete2': print(f'{sp}delete {pop()}'); 
        elif op in ('Stop', 'Play', 'NextFrame', 'PrevFrame', 'End', 'ConstantPool'):
            if op != 'ConstantPool' and op != 'End': print(f'{sp}{op.lower()}()')
        elif op == 'function': print(f'{sp}{ins}')
        else: print(f'{sp}{ins}   ; stack={st[-3:]}')
blocks = []; cur = None
for ln in lines:
    if ln.startswith('==== '):
        cur = [ln, []]; blocks.append(cur)
    elif cur and ln: cur[1].append(ln)
for h, b in blocks:
    if want is None or want in h: run(b, h)
