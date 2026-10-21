"""Control-flow-only abstract exploration of EVM bytecode (standard library only).

Values on the abstract stack are either a JUMPDEST constant (a potential jump target, e.g. a pushed
return address) or None. Branch conditions are ignored (both sides of every JUMPI are explored), so
the reachable set over-approximates every real execution, provided every jump target is such a
constant (any jump to an unknown target is reported). States are memoized by (pc, stack).

usage: python3 -I cfg.py <code.hex> reach                       # entries that can reach each SSTORE
       python3 -I cfg.py <code.hex> avoid <entry> <target> <pc,pc,...>
           # can <target> be reached from function <entry> (a selector) without executing any listed pc?
"""
import os
import sys

sys.dont_write_bytecode = True  # keep the repository free of __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from evm import disassemble, load  # noqa: E402

POPS = {'ADD': 2, 'MUL': 2, 'SUB': 2, 'DIV': 2, 'SDIV': 2, 'MOD': 2, 'SMOD': 2, 'ADDMOD': 3, 'MULMOD': 3, 'EXP': 2,
        'SIGNEXTEND': 2, 'LT': 2, 'GT': 2, 'SLT': 2, 'SGT': 2, 'EQ': 2, 'ISZERO': 1, 'AND': 2, 'OR': 2, 'XOR': 2,
        'NOT': 1, 'BYTE': 2, 'SHL': 2, 'SHR': 2, 'SAR': 2, 'KECCAK256': 2, 'ADDRESS': 0, 'BALANCE': 1, 'ORIGIN': 0,
        'CALLER': 0, 'CALLVALUE': 0, 'CALLDATALOAD': 1, 'CALLDATASIZE': 0, 'CALLDATACOPY': 3, 'CODESIZE': 0,
        'CODECOPY': 3, 'GASPRICE': 0, 'EXTCODESIZE': 1, 'EXTCODECOPY': 4, 'RETURNDATASIZE': 0, 'RETURNDATACOPY': 3,
        'EXTCODEHASH': 1, 'BLOCKHASH': 1, 'COINBASE': 0, 'TIMESTAMP': 0, 'NUMBER': 0, 'PREVRANDAO': 0, 'GASLIMIT': 0,
        'CHAINID': 0, 'SELFBALANCE': 0, 'BASEFEE': 0, 'BLOBHASH': 1, 'BLOBBASEFEE': 0, 'POP': 1, 'MLOAD': 1,
        'MSTORE': 2, 'MSTORE8': 2, 'SLOAD': 1, 'SSTORE': 2, 'PC': 0, 'MSIZE': 0, 'GAS': 0, 'TLOAD': 1, 'TSTORE': 2,
        'MCOPY': 3, 'CREATE': 3, 'CALL': 7, 'CALLCODE': 7, 'DELEGATECALL': 6, 'CREATE2': 4, 'STATICCALL': 6,
        'LOG0': 2, 'LOG1': 3, 'LOG2': 4, 'LOG3': 5, 'LOG4': 6}
PUSHES = {op: 0 if op in ('CALLDATACOPY', 'CODECOPY', 'EXTCODECOPY', 'RETURNDATACOPY', 'POP', 'MSTORE', 'MSTORE8',
                          'SSTORE', 'TSTORE', 'MCOPY', 'LOG0', 'LOG1', 'LOG2', 'LOG3', 'LOG4') else 1 for op in POPS}
TERMINAL = {'STOP', 'RETURN', 'REVERT', 'INVALID', 'SELFDESTRUCT'}


class Graph:
    def __init__(self, code):
        self.ins, self.order = {}, []
        for pc, op, arg in disassemble(code):
            self.ins[pc] = (op, arg)
            self.order.append(pc)
        self.next = {pc: self.order[i + 1] if i + 1 < len(self.order) else None for i, pc in enumerate(self.order)}
        self.jumpdests = {pc for pc, (op, _) in self.ins.items() if op == 'JUMPDEST'}
        self.problems = []

    def entries(self):
        sels = []
        for i in range(len(self.order) - 3):
            a, b, c, d = (self.ins[self.order[i + k]] for k in range(4))
            if a[0] == 'PUSH4' and b[0] == 'EQ' and c[0] == 'PUSH2' and d[0] == 'JUMPI':
                sels.append((a[1], c[1]))
            if self.order[i] > 0x600:
                break
        return sels

    entry_depth = 1
    window = 0

    def explore(self, entry, avoid=frozenset(), max_states=400_000):
        """Returns the set of pcs reachable from `entry` (the dispatcher's stack: `entry_depth` unknown
        values, the selector on top) without executing a pc in `avoid`."""
        seen = set()
        reached = set()
        work = [(entry, (None,) * self.entry_depth)]
        while work:
            pc, stack = work.pop()
            while True:
                if pc in avoid or pc is None:
                    break
                # Memoize on the top `window` entries only, so recursion (which pushes the same return
                # addresses again) terminates; deeper frames are explored when their shallower copy returns.
                state = (pc, stack[-self.window:] if self.window else stack)
                if state in seen:
                    break
                seen.add(state)
                if len(seen) > max_states:
                    self.problems.append(('state_limit', entry))
                    return reached
                reached.add(pc)
                op, arg = self.ins[pc]
                st = list(stack)
                if op.startswith('PUSH'):
                    v = arg if arg is not None else 0
                    st.append(v if v in self.jumpdests else None)
                elif op.startswith('DUP'):
                    n = int(op[3:])
                    if len(st) < n:
                        self.problems.append(('underflow', pc))
                        break
                    st.append(st[-n])
                elif op.startswith('SWAP'):
                    n = int(op[4:])
                    if len(st) < n + 1:
                        self.problems.append(('underflow', pc))
                        break
                    st[-1], st[-1 - n] = st[-1 - n], st[-1]
                elif op == 'JUMPDEST':
                    pass
                elif op == 'JUMP':
                    t = st.pop()
                    if t is None or t not in self.jumpdests:
                        self.problems.append(('unknown_jump', pc))
                        break
                    pc, stack = t, tuple(st)
                    continue
                elif op == 'JUMPI':
                    t = st.pop()
                    st.pop()
                    if t is None or t not in self.jumpdests:
                        self.problems.append(('unknown_jumpi', pc))
                        break
                    work.append((t, tuple(st)))
                elif op in TERMINAL:
                    break
                elif op in POPS:
                    n = POPS[op]
                    if len(st) < n:
                        self.problems.append(('underflow', pc))
                        break
                    del st[len(st) - n:]
                    if PUSHES[op]:
                        st.append(None)
                else:
                    self.problems.append(('unknown_op', pc, op))
                    break
                pc, stack = self.next[pc], tuple(st)
        return reached


def main():
    g = Graph(load(sys.argv[1]))
    mode = sys.argv[2]
    if '--window' in sys.argv:
        g.window = int(sys.argv[sys.argv.index('--window') + 1])
    if '--entry-depth' in sys.argv:
        g.entry_depth = int(sys.argv[sys.argv.index('--entry-depth') + 1])
    sstores = [pc for pc in g.order if g.ins[pc][0] == 'SSTORE']
    if mode == 'reach':
        by_site = {pc: [] for pc in sstores}
        for sel, entry in g.entries():
            r = g.explore(entry)
            for pc in sstores:
                if pc in r:
                    by_site[pc].append(f'0x{sel:08x}')
        for pc in sstores:
            print(f'{pc:#06x}: {", ".join(by_site[pc]) or "unreachable from any entry"}')
        print('problems:', sorted(set(g.problems))[:20], len(g.problems))
    elif mode == 'avoid':
        sel = int(sys.argv[3], 16)
        target = int(sys.argv[4], 16)
        avoid = frozenset(int(x, 16) for x in sys.argv[5].split(',') if x)
        entry = dict(g.entries())[sel]
        r = g.explore(entry, avoid)
        print(f'0x{sel:08x}: target {target:#06x} reachable while avoiding {sorted(hex(a) for a in avoid)}: {target in r}')
        print('problems:', sorted(set(g.problems))[:20])


if __name__ == '__main__':
    main()
