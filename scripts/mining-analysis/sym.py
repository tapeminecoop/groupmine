"""Bounded symbolic execution of EVM bytecode (standard library only).

Used to enumerate, per external function of the Mining implementation (and its linked library), every
storage write on paths that end without reverting, together with the path conditions. Unsound in the
usual places (documented in the report): loops are unrolled a bounded number of times, memory and
storage aliasing is syntactic, external calls return fresh unknowns.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from evm import disassemble  # noqa: E402
from keccak import keccak256  # noqa: E402

M = (1 << 256) - 1


def is_c(x):
    return isinstance(x, int)


class E:
    __slots__ = ('op', 'args', 'h', 'b')

    def __hash__(self):
        return self.h

    def __eq__(self, other):
        return self is other

    def __repr__(self):
        return fmt(self)


_tab = {}


def mk(op, *args):
    key = (op,) + args
    e = _tab.get(key)
    if e is None:
        e = E()
        e.op, e.args, e.h, e.b = op, args, hash(key), None
        _tab[key] = e
    return e


_counter = [0]


def fresh(tag, *info):
    _counter[0] += 1
    return mk('fresh', tag, _counter[0], *info)


def hkey(x):
    return (0, x) if is_c(x) else (1, x.h)


def bits(e):
    """Upper bound of the bits that can be set."""
    if is_c(e):
        return e
    if e.b is not None:
        return e.b
    op, a = e.op, e.args
    if op == 'and':
        b = bits(a[0]) & bits(a[1])
    elif op == 'or':
        b = bits(a[0]) | bits(a[1])
    elif op == 'shl' and is_c(a[0]):
        b = (bits(a[1]) << a[0]) & M if a[0] < 256 else 0
    elif op == 'shr' and is_c(a[0]):
        b = bits(a[1]) >> a[0] if a[0] < 256 else 0
    elif op in ('eq', 'lt', 'gt', 'slt', 'sgt', 'iszero', 'callok'):
        b = 1
    elif op in ('caller', 'origin', 'coinbase'):
        b = (1 << 160) - 1
    elif op == 'cdlow':
        b = (1 << 224) - 1
    elif op == 'byte':
        b = 0xff
    else:
        b = M
    e.b = b
    return b


# ---- expression constructors with folding -------------------------------------------------------

def lin(x):
    if is_c(x):
        return x, ()
    if x.op == 'add':
        return x.args[0], x.args[1:]
    return 0, (x,)


def mk_lin(const, terms):
    const &= M
    terms = tuple(sorted(terms, key=lambda t: t.h))
    if not terms:
        return const
    if const == 0 and len(terms) == 1:
        return terms[0]
    return mk('add', const, *terms)


def add(a, b):
    if is_c(a) and is_c(b):
        return (a + b) & M
    ca, ta = lin(a)
    cb, tb = lin(b)
    return mk_lin(ca + cb, ta + tb)


def sub(a, b):
    if is_c(a) and is_c(b):
        return (a - b) & M
    if is_c(b):
        return add(a, (-b) & M)
    ca, ta = lin(a)
    cb, tb = lin(b)
    ta = list(ta)
    rest = []
    for t in tb:
        if t in ta:
            ta.remove(t)
        else:
            rest.append(t)
    if not rest:
        return mk_lin(ca - cb, ta)
    return mk('sub', mk_lin(ca, ta), mk_lin(cb, rest))


def comm(op, a, b, fold):
    if is_c(a) and is_c(b):
        return fold(a, b) & M
    if is_c(a):
        a, b = b, a
    if not is_c(b) and b.h < a.h:
        a, b = b, a
    return mk(op, a, b)


def mul(a, b):
    if is_c(a) and not is_c(b):
        a, b = b, a
    if is_c(b):
        if b == 0:
            return 0
        if b == 1:
            return a
    return comm('mul', a, b, lambda x, y: x * y)


def div(a, b):
    if is_c(a) and is_c(b):
        return 0 if b == 0 else a // b
    if is_c(b) and b == 1:
        return a
    if is_c(a) and a == 0:
        return 0
    return mk('div', a, b)


def sgn(x):
    return x - (1 << 256) if x >> 255 else x


def sdiv(a, b):
    if is_c(a) and is_c(b):
        if b == 0:
            return 0
        x, y = sgn(a), sgn(b)
        q = abs(x) // abs(y)
        return (-q if (x < 0) != (y < 0) else q) & M
    return mk('sdiv', a, b)


def mod(a, b):
    if is_c(a) and is_c(b):
        return 0 if b == 0 else a % b
    return mk('mod', a, b)


def smod(a, b):
    if is_c(a) and is_c(b):
        if b == 0:
            return 0
        x, y = sgn(a), sgn(b)
        r = abs(x) % abs(y)
        return (-r if x < 0 else r) & M
    return mk('smod', a, b)


def exp(a, b):
    if is_c(a) and is_c(b):
        return pow(a, b, 1 << 256)
    return mk('exp', a, b)


def and_(a, b):
    if is_c(a) and is_c(b):
        return a & b
    if is_c(a):
        a, b = b, a
    if is_c(b):
        if b == 0:
            return 0
        ba = bits(a)
        if ba & b == 0:
            return 0
        if ba & ~b & M == 0:
            return a
        if a.op == 'and' and is_c(a.args[1]):
            return and_(a.args[0], a.args[1] & b)
        if a.op == 'or':
            return or_(and_(a.args[0], b), and_(a.args[1], b))
        return mk('and', a, b)
    if a is b:
        return a
    return comm('and', a, b, lambda x, y: x & y)


def or_(a, b):
    if is_c(a) and is_c(b):
        return a | b
    if is_c(a):
        a, b = b, a
    if is_c(b) and b == 0:
        return a
    if a is b:
        return a
    return comm('or', a, b, lambda x, y: x | y)


def xor(a, b):
    if is_c(a) and is_c(b):
        return a ^ b
    if a is b:
        return 0
    if is_c(a):
        a, b = b, a
    if is_c(b) and b == 0:
        return a
    return comm('xor', a, b, lambda x, y: x ^ y)


def not_(a):
    if is_c(a):
        return ~a & M
    if a.op == 'not':
        return a.args[0]
    return mk('not', a)


def shl(s, v):
    if is_c(s) and is_c(v):
        return (v << s) & M if s < 256 else 0
    if is_c(s):
        if s >= 256:
            return 0
        if s == 0:
            return v
    if is_c(v) and v == 0:
        return 0
    return mk('shl', s, v)


def shr(s, v):
    if is_c(s) and is_c(v):
        return v >> s if s < 256 else 0
    if is_c(s):
        if s >= 256:
            return 0
        if s == 0:
            return v
        if bits(v) >> s == 0:
            return 0
        if v.op == 'or':
            return or_(shr(s, v.args[0]), shr(s, v.args[1]))
        if v.op == 'shl' and is_c(v.args[0]) and v.args[0] == s:
            return and_(v.args[1], M >> s)
        if v.op == 'and' and is_c(v.args[1]):
            return and_(shr(s, v.args[0]), v.args[1] >> s)
    return mk('shr', s, v)


def sar(s, v):
    if is_c(s) and is_c(v):
        return (sgn(v) >> min(s, 256)) & M
    return mk('sar', s, v)


def eq(a, b):
    if is_c(a) and is_c(b):
        return int(a == b)
    if a is b:
        return 1
    if is_c(a):
        a, b = b, a
    if is_c(b) and bits(a) & b != b:
        return 0
    return comm('eq', a, b, lambda x, y: int(x == y))


def lt(a, b):
    if is_c(a) and is_c(b):
        return int(a < b)
    if is_c(b) and b == 0:
        return 0
    return mk('lt', a, b)


def gt(a, b):
    if is_c(a) and is_c(b):
        return int(a > b)
    if is_c(a) and a == 0:
        return 0
    return mk('gt', a, b)


def slt(a, b):
    if is_c(a) and is_c(b):
        return int(sgn(a) < sgn(b))
    return mk('slt', a, b)


def sgt(a, b):
    if is_c(a) and is_c(b):
        return int(sgn(a) > sgn(b))
    return mk('sgt', a, b)


def iszero(a):
    if is_c(a):
        return int(a == 0)
    if a.op == 'iszero' and not is_c(a.args[0]) and a.args[0].op == 'iszero':
        return a.args[0]
    return mk('iszero', a)


def byte_(i, x):
    if is_c(i) and is_c(x):
        return (x >> (8 * (31 - i))) & 0xff if i < 32 else 0
    if is_c(i):
        if i >= 32:
            return 0
        return and_(shr(8 * (31 - i), x), 0xff)
    return mk('byte', i, x)


def signextend(b, x):
    if is_c(b) and is_c(x):
        if b >= 31:
            return x
        bit = 8 * b + 7
        mask = (1 << (bit + 1)) - 1
        return (x | (M ^ mask)) & M if (x >> bit) & 1 else x & mask
    if is_c(b) and b >= 31:
        return x
    if is_c(b) and bits(x) >> (8 * b + 7) == 0:
        return x
    return mk('signextend', b, x)


# ---- formatting -------------------------------------------------------------------------------

NAMES = {}


def fmt(x, depth=0):
    if is_c(x):
        return hex(x) if x > 9 else str(x)
    if isinstance(x, (tuple, str, bytes)):
        return str(x)
    if depth > 7:
        return '…'
    if x in NAMES:
        return NAMES[x]
    op, a = x.op, x.args
    if op == 'add':
        parts = [fmt(t, depth + 1) for t in a[1:]]
        if a[0]:
            parts.append(fmt(a[0], depth + 1))
        return '(' + ' + '.join(parts) + ')'
    if op == 'sha3':
        return 'keccak(' + ', '.join(
            (hex(int.from_bytes(r, 'big')) if isinstance(r, bytes) else (fmt(r[0], depth + 1) if (r[1], r[2]) == (0, 32) else f'{fmt(r[0], depth + 1)}[{r[1]}:{r[2]}]'))
            for r in a[0]) + ')'
    if op == 'fresh':
        return f'?{a[0]}{a[1]}'
    if op in ('caller', 'callvalue', 'timestamp', 'number', 'cds', 'address', 'origin', 'selfbalance', 'gasprice',
              'coinbase', 'prevrandao', 'gaslimit', 'basefee', 'blobbasefee'):
        return op
    if op == 'cd':
        return f'cd[{fmt(a[0], depth + 1)}]'
    if op == 'cdlow':
        return 'cd[0][4:]'
    return f'{op}(' + ', '.join(fmt(y, depth + 1) for y in a) + ')'


# ---- path facts -------------------------------------------------------------------------------

class Fact:
    __slots__ = ('eq', 'neq', 'lo', 'hi')

    def __init__(self, atom):
        self.eq, self.neq, self.lo = None, frozenset(), 0
        self.hi = bits(atom) if not is_c(bits(atom)) else bits(atom)

    def copy(self):
        f = Fact.__new__(Fact)
        f.eq, f.neq, f.lo, f.hi = self.eq, self.neq, self.lo, self.hi
        return f

    def ok(self):
        if self.lo > self.hi:
            return False
        if self.eq is not None:
            return self.lo <= self.eq <= self.hi and self.eq not in self.neq
        if self.lo == self.hi:
            return self.lo not in self.neq
        if self.hi - self.lo < 64 and all(v in self.neq for v in range(self.lo, self.hi + 1)):
            return False
        return True

    def __repr__(self):
        if self.eq is not None:
            return f'== {self.eq}'
        parts = []
        if self.neq:
            parts.append('∉ {' + ', '.join(str(v) for v in sorted(self.neq)) + '}')
        if self.lo:
            parts.append(f'>= {self.lo}')
        return ' and '.join(parts) or 'any'


def relation(cond, truth):
    """Normalizes `cond != 0 == truth` into (atom, kind, value) or ('const', ok)."""
    while not is_c(cond) and cond.op == 'iszero':
        cond, truth = cond.args[0], not truth
    if is_c(cond):
        return ('const', (cond != 0) == truth)
    op, a = cond.op, cond.args
    if op == 'eq' and is_c(a[1]):
        return (a[0], 'eq' if truth else 'ne', a[1])
    if op in ('sub', 'xor') and (is_c(a[0]) or is_c(a[1])):
        x, k = (a[1], a[0]) if is_c(a[0]) else (a[0], a[1])
        return (x, 'ne' if truth else 'eq', k)
    if op == 'add' and len(a) == 2:
        return (a[1], 'ne' if truth else 'eq', (-a[0]) & M)
    if op == 'lt' and is_c(a[1]):
        return (a[0], 'lt', a[1]) if truth else (a[0], 'ge', a[1])
    if op == 'lt' and is_c(a[0]):
        return (a[1], 'gt', a[0]) if truth else (a[1], 'le', a[0])
    if op == 'gt' and is_c(a[1]):
        return (a[0], 'gt', a[1]) if truth else (a[0], 'le', a[1])
    if op == 'gt' and is_c(a[0]):
        return (a[1], 'lt', a[0]) if truth else (a[1], 'ge', a[0])
    return (cond, 'ne' if truth else 'eq', 0)


def apply(facts, rel):
    """Returns updated facts (copy-on-write) or None when infeasible."""
    if rel[0] == 'const':
        return facts if rel[1] else None
    atom, kind, v = rel
    f = facts.get(atom)
    f = f.copy() if f else Fact(atom)
    if kind == 'eq':
        if f.eq is not None and f.eq != v:
            return None
        f.eq = v
    elif kind == 'ne':
        f.neq = f.neq | {v}
    elif kind == 'lt':
        f.hi = min(f.hi, v - 1)
    elif kind == 'le':
        f.hi = min(f.hi, v)
    elif kind == 'gt':
        f.lo = max(f.lo, v + 1)
    elif kind == 'ge':
        f.lo = max(f.lo, v)
    if not f.ok():
        return None
    out = dict(facts)
    out[atom] = f
    return out


def decide(facts, cond):
    """True/False when the facts decide `cond != 0`, else None."""
    t = apply(facts, relation(cond, True))
    f = apply(facts, relation(cond, False))
    if t is None and f is None:
        return 'dead'
    if t is None:
        return False
    if f is None:
        return True
    return None


# ---- machine ------------------------------------------------------------------------------------

class State:
    __slots__ = ('pc', 'stack', 'mem', 'unknown_from', 'smem', 'store', 'tstore', 'facts', 'visits', 'writes',
                 'logs', 'calls', 'steps', 'rd', 'trail')

    def fork(self):
        s = State.__new__(State)
        s.pc, s.stack, s.mem, s.unknown_from = self.pc, list(self.stack), dict(self.mem), self.unknown_from
        s.smem, s.store, s.tstore = dict(self.smem), dict(self.store), dict(self.tstore)
        s.facts, s.visits = self.facts, dict(self.visits)
        s.writes, s.logs, s.calls = list(self.writes), list(self.logs), list(self.calls)
        s.steps, s.rd, s.trail = self.steps, self.rd, self.trail
        return s


class Program:
    def __init__(self, code, address):
        self.code = code
        self.ins = {}
        self.order = []
        for pc, op, arg in disassemble(code):
            self.ins[pc] = (op, arg)
            self.order.append(pc)
        self.next = {pc: self.order[i + 1] if i + 1 < len(self.order) else None for i, pc in enumerate(self.order)}
        self.jumpdests = {pc for pc, (op, _) in self.ins.items() if op == 'JUMPDEST'}
        self.address = address


def mem_write_word(s, off, val):
    for i in range(32):
        s.mem[off + i] = (val, i)


def mem_byte(s, o):
    ent = s.mem.get(o)
    if ent is None:
        if s.unknown_from is not None and o >= s.unknown_from:
            return None
        return (0, 31)
    return ent


def mem_read(s, off, n=32):
    """Reads n bytes at a concrete offset as a list of (source, index)."""
    return [mem_byte(s, off + i) for i in range(n)]


def assemble(parts):
    """parts: list of (source, index) for consecutive bytes (big-endian); returns an expression."""
    if any(p is None for p in parts):
        return None
    n = len(parts)
    if all(is_c(p[0]) for p in parts):
        v = 0
        for src, i in parts:
            v = (v << 8) | ((src >> (8 * (31 - i))) & 0xff)
        return v
    if n == 32 and all(p[0] is parts[0][0] and p[1] == i for i, p in enumerate(parts)):
        return parts[0][0]
    # Runs of bytes from the same word at consecutive indices.
    out = 0
    j = 0
    while j < n:
        src, i0 = parts[j]
        k = j + 1
        while k < n and parts[k][0] is src and parts[k][1] == i0 + (k - j):
            k += 1
        length = k - j
        piece = and_(shr(8 * (32 - i0 - length), src), (1 << (8 * length)) - 1)
        out = or_(out, shl(8 * (n - k), piece))
        j = k
    return out


def sha3_runs(s, off, n):
    parts = mem_read(s, off, n)
    if any(p is None for p in parts):
        return None
    runs = []
    j = 0
    while j < n:
        src, i0 = parts[j]
        if is_c(src):
            k = j
            buf = bytearray()
            while k < n and is_c(parts[k][0]):
                buf.append((parts[k][0] >> (8 * (31 - parts[k][1]))) & 0xff)
                k += 1
            runs.append(bytes(buf))
        else:
            k = j + 1
            while k < n and parts[k][0] is src and parts[k][1] == i0 + (k - j):
                k += 1
            runs.append((src, i0, i0 + (k - j)))
        j = k
    if all(isinstance(r, bytes) for r in runs):
        return int.from_bytes(keccak256(b''.join(runs)), 'big')
    return mk('sha3', tuple(runs))


def mapping_of(slot):
    """(key, mapping slot, offset) when slot == keccak(key . uint256(m)) + offset."""
    c, terms = lin(slot)
    if len(terms) != 1 or terms[0].op != 'sha3':
        return None
    runs = terms[0].args[0]
    if len(runs) == 2 and isinstance(runs[1], bytes) and len(runs[1]) == 32 and not isinstance(runs[0], bytes) \
            and runs[0][1:] == (0, 32):
        return runs[0][0], int.from_bytes(runs[1], 'big'), c
    return None


class Explorer:
    def __init__(self, prog, loop_bound=2, max_paths=4000, max_steps=3_000_000, time_limit=300, stop_at=None,
                 path_steps=150_000):
        self.p = prog
        self.loop_bound, self.max_paths, self.max_steps, self.time_limit = loop_bound, max_paths, max_steps, time_limit
        self.path_steps = path_steps
        self.stop_at = stop_at or set()
        self.ends = {}
        self.ok_paths = []
        self.stopped = []
        self.total_steps = 0
        self.truncated = False
        self.keep_all = False
        self.other_paths = []

    def initial(self, selector, calldata=None, symbolic_words=()):
        self.symbolic_words = set(symbolic_words)
        s = State.__new__(State)
        s.pc, s.stack, s.mem, s.unknown_from = 0, [], {}, None
        s.smem, s.store, s.tstore, s.facts, s.visits = {}, {}, {}, {}, {}
        s.writes, s.logs, s.calls, s.steps, s.rd, s.trail = [], [], [], 0, None, ()
        self.selector, self.calldata = selector, calldata
        return s

    def cdload(self, off):
        if self.calldata is not None and is_c(off) and off in self.symbolic_words:
            return mk('cd', off)
        if self.calldata is not None and is_c(off):
            b = self.calldata[off:off + 32].ljust(32, b'\0') if off < len(self.calldata) else b'\0' * 32
            return int.from_bytes(b, 'big')
        if is_c(off) and off == 0:
            return or_(self.selector << 224, mk('cdlow'))
        if is_c(off) and off < 4:
            return mk('cd', off)
        return mk('cd', off)

    def run(self, s0):
        t0 = time.time()
        work = [s0]
        while work:
            if len(self.ok_paths) + sum(self.ends.values()) >= self.max_paths or self.total_steps > self.max_steps \
                    or time.time() - t0 > self.time_limit:
                self.truncated = True
                self.ends['unexplored'] = self.ends.get('unexplored', 0) + len(work)
                break
            s = work.pop()
            result = self.step_path(s, work)
            if result:
                self.ends[result] = self.ends.get(result, 0) + 1

    def end(self, s, kind, extra=None):
        if kind == 'ok':
            self.ok_paths.append((s, extra))
        elif self.keep_all:
            self.other_paths.append((s, kind))
        return kind

    def step_path(self, s, work):
        p = self.p
        while True:
            if s.pc in self.stop_at:
                self.stopped.append(s)
                return 'stop_at'
            ins = p.ins.get(s.pc)
            if ins is None:
                return self.end(s, 'fell_off')
            op, arg = ins
            s.steps += 1
            self.total_steps += 1
            if s.steps > self.path_steps:
                return self.end(s, 'path_steps')
            st = s.stack
            nxt = p.next[s.pc]
            try:
                if op.startswith('PUSH'):
                    st.append(arg if arg is not None else 0)
                elif op.startswith('DUP'):
                    st.append(st[-int(op[3:])])
                elif op.startswith('SWAP'):
                    n = int(op[4:])
                    st[-1], st[-1 - n] = st[-1 - n], st[-1]
                elif op == 'POP':
                    st.pop()
                elif op == 'JUMPDEST':
                    pass
                elif op in BIN:
                    a = st.pop()
                    b = st.pop()
                    st.append(BIN[op](a, b))
                elif op == 'ISZERO':
                    st.append(iszero(st.pop()))
                elif op == 'NOT':
                    st.append(not_(st.pop()))
                elif op == 'ADDMOD':
                    a, b, n = st.pop(), st.pop(), st.pop()
                    st.append((a + b) % n if is_c(a) and is_c(b) and is_c(n) and n else mk('addmod', a, b, n))
                elif op == 'MULMOD':
                    a, b, n = st.pop(), st.pop(), st.pop()
                    st.append((a * b) % n if is_c(a) and is_c(b) and is_c(n) and n else mk('mulmod', a, b, n))
                elif op == 'KECCAK256':
                    off, n = st.pop(), st.pop()
                    v = sha3_runs(s, off, n) if is_c(off) and is_c(n) and n <= 4096 else None
                    st.append(v if v is not None else fresh('sha3u', s.pc))
                elif op == 'ADDRESS':
                    st.append(p.address)
                elif op in ENV:
                    st.append(mk(ENV[op]))
                elif op == 'CHAINID':
                    st.append(56)
                elif op == 'CALLDATALOAD':
                    st.append(self.cdload(st.pop()))
                elif op == 'CALLDATASIZE':
                    st.append(len(self.calldata) if self.calldata is not None else mk('cds'))
                elif op == 'CALLDATACOPY':
                    dst, off, n = st.pop(), st.pop(), st.pop()
                    self.copy_in(s, dst, n, lambda k: self.cdload(add(off, k)) if not is_c(off) else self.cdload(off + k))
                elif op == 'CODESIZE':
                    st.append(len(p.code))
                elif op == 'CODECOPY':
                    dst, off, n = st.pop(), st.pop(), st.pop()
                    if is_c(off) and is_c(n):
                        data = p.code[off:off + n].ljust(n, b'\0')
                        self.copy_in(s, dst, n, lambda k: int.from_bytes(data[k:k + 32].ljust(32, b'\0'), 'big'))
                    else:
                        self.copy_in(s, dst, n, lambda k: fresh('code', s.pc))
                elif op in ('EXTCODESIZE', 'EXTCODEHASH', 'BALANCE', 'BLOCKHASH'):
                    st.append(mk(op.lower(), st.pop()))
                elif op == 'EXTCODECOPY':
                    st.pop()
                    dst, off, n = st.pop(), st.pop(), st.pop()
                    self.copy_in(s, dst, n, lambda k: fresh('extcode', s.pc))
                elif op == 'RETURNDATASIZE':
                    st.append(0 if s.rd is None else mk('rds', s.rd))
                elif op == 'RETURNDATACOPY':
                    dst, off, n = st.pop(), st.pop(), st.pop()
                    rd = s.rd
                    self.copy_in(s, dst, n, lambda k: mk('rdw', rd, add(off, k)))
                elif op in ('GAS', 'MSIZE', 'GASPRICE', 'COINBASE', 'PREVRANDAO', 'GASLIMIT', 'BASEFEE', 'BLOBBASEFEE', 'BLOBHASH'):
                    if op == 'BLOBHASH':
                        st.pop()
                    st.append(fresh(op.lower(), s.pc))
                elif op == 'PC':
                    st.append(s.pc)
                elif op == 'MLOAD':
                    off = st.pop()
                    st.append(self.mload(s, off))
                elif op == 'MSTORE':
                    off, v = st.pop(), st.pop()
                    if is_c(off):
                        mem_write_word(s, off, v)
                    else:
                        s.smem[off] = v
                elif op == 'MSTORE8':
                    off, v = st.pop(), st.pop()
                    if is_c(off):
                        s.mem[off] = (and_(v, 0xff), 31) if not is_c(v) else (v & 0xff, 31)
                elif op == 'MCOPY':
                    dst, src, n = st.pop(), st.pop(), st.pop()
                    if is_c(dst) and is_c(src) and is_c(n) and n <= 8192:
                        parts = mem_read(s, src, n)
                        for i, prt in enumerate(parts):
                            if prt is None:
                                s.mem.pop(dst + i, None)
                            else:
                                s.mem[dst + i] = prt
                    else:
                        self.invalidate(s, dst)
                elif op == 'SLOAD':
                    slot = st.pop()
                    st.append(s.store[slot] if slot in s.store else mk('sload', slot))
                elif op == 'SSTORE':
                    slot, v = st.pop(), st.pop()
                    s.store[slot] = v
                    s.writes.append((s.pc, slot, v, s.facts, s.trail))
                elif op == 'TLOAD':
                    slot = st.pop()
                    st.append(s.tstore.get(slot, 0))
                elif op == 'TSTORE':
                    slot, v = st.pop(), st.pop()
                    s.tstore[slot] = v
                elif op.startswith('LOG'):
                    n = int(op[3:])
                    off, size = st.pop(), st.pop()
                    topics = [st.pop() for _ in range(n)]
                    s.logs.append((s.pc, topics[0] if topics else None, topics[1:]))
                elif op in ('CALL', 'CALLCODE', 'DELEGATECALL', 'STATICCALL'):
                    gas, to = st.pop(), st.pop()
                    val = st.pop() if op in ('CALL', 'CALLCODE') else 0
                    ino, ins_, outo, outs = st.pop(), st.pop(), st.pop(), st.pop()
                    sel = None
                    words = None
                    if is_c(ino):
                        w = assemble(mem_read(s, ino, 4))
                        sel = w if is_c(w) else None
                        if is_c(ins_) and ins_ <= 4 + 32 * 24:
                            words = tuple(assemble(mem_read(s, ino + 4 + 32 * i)) for i in range((ins_ - 4) // 32))
                    _counter[0] += 1
                    s.rd = (s.pc, _counter[0])
                    s.calls.append((s.pc, op, to, sel, val, words))
                    self.copy_in(s, outo, outs, lambda k: mk('rdw', s.rd, k))
                    st.append(mk('callok', s.rd))
                elif op in ('CREATE', 'CREATE2'):
                    for _ in range(3 if op == 'CREATE' else 4):
                        st.pop()
                    st.append(fresh('create', s.pc))
                elif op == 'JUMP':
                    dst = st.pop()
                    if not is_c(dst) or dst not in p.jumpdests:
                        return self.end(s, 'bad_jump')
                    s.pc = dst
                    continue
                elif op == 'JUMPI':
                    dst, cond = st.pop(), st.pop()
                    if not is_c(dst) or dst not in p.jumpdests:
                        return self.end(s, 'bad_jump')
                    d = decide(s.facts, cond)
                    if d == 'dead':
                        return 'infeasible'
                    if d is True:
                        s.pc = dst
                        continue
                    if d is False:
                        s.pc = nxt
                        continue
                    n = s.visits.get(s.pc, 0) + 1
                    if n > self.loop_bound:
                        return self.end(s, 'loop_bound')
                    s.visits[s.pc] = n
                    t = s.fork()
                    t.facts = apply(s.facts, relation(cond, True))
                    t.pc = dst
                    t.trail = s.trail + ((s.pc, True),)
                    s.facts = apply(s.facts, relation(cond, False))
                    s.trail = s.trail + ((s.pc, False),)
                    s.pc = nxt
                    work.append(t)
                    continue
                elif op in ('STOP', 'RETURN'):
                    if op == 'RETURN':
                        st.pop()
                        st.pop()
                    return self.end(s, 'ok', op)
                elif op == 'SELFDESTRUCT':
                    return self.end(s, 'ok', op)
                elif op == 'REVERT':
                    off, n = st.pop(), st.pop()
                    return self.end(s, 'revert')
                elif op == 'INVALID' or op.startswith('UNKNOWN'):
                    return self.end(s, 'invalid')
                else:
                    raise NotImplementedError(op)
            except IndexError:
                return self.end(s, 'stack_underflow')
            s.pc = nxt
            if s.pc is None:
                return self.end(s, 'ok', 'end')

    def mload(self, s, off):
        if is_c(off):
            v = assemble(mem_read(s, off))
            return v if v is not None else fresh('mem', s.pc)
        if off in s.smem:
            return s.smem[off]
        return fresh('memu', s.pc)

    def invalidate(self, s, dst):
        if is_c(dst):
            for k in [k for k in s.mem if k >= dst]:
                del s.mem[k]
            s.unknown_from = dst if s.unknown_from is None else min(s.unknown_from, dst)
        else:
            s.smem.clear()

    def copy_in(self, s, dst, n, word):
        if is_c(dst) and is_c(n) and n <= 8192:
            for k in range(0, n, 32):
                w = word(k)
                for i in range(min(32, n - k)):
                    s.mem[dst + k + i] = (w, i)
        else:
            self.invalidate(s, dst)


BIN = {
    'ADD': add, 'MUL': mul, 'SUB': sub, 'DIV': div, 'SDIV': sdiv, 'MOD': mod, 'SMOD': smod, 'EXP': exp,
    'LT': lt, 'GT': gt, 'SLT': slt, 'SGT': sgt, 'EQ': eq, 'AND': and_, 'OR': or_, 'XOR': xor,
    'BYTE': byte_, 'SHL': shl, 'SHR': shr, 'SAR': sar, 'SIGNEXTEND': signextend,
}
ENV = {'CALLER': 'caller', 'CALLVALUE': 'callvalue', 'ORIGIN': 'origin', 'TIMESTAMP': 'timestamp',
       'NUMBER': 'number', 'SELFBALANCE': 'selfbalance'}
