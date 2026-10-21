#!/usr/bin/env python3
"""Static analysis of the Mining status lifecycle on the deployed bytecode (release gate U-01).

Reads the implementation and its linked library as fetched by scripts/fetch-mining-code.ts and, for the
two code hashes below only, re-derives from the bytecode:
  1. every storage write site, the external functions that can reach it (control-flow exploration of
     all dispatcher entries) and the slot it writes (bounded symbolic execution, plus the listed
     internal starting points);
  2. that a miner record's status byte is written at exactly three sites, with the values written;
  3. the status conditions every explored path satisfies where it passes start's status gate, at the
     first state change of stop/claim/reclaim, at challenge's status write and payout, and wherever
     claimMany/kick/reclaim reach the settlement routine (the only path to the BEM mint);
  4. that the library writes storage only from the counterexample-registration function, only below
     the storage pointer Mining passes it, and that Mining calls that function only from
     registerCounterexample;
  5. who can replace the implementation or the owner (upgradeToAndCall, ownership functions and the
     initializer are owner- or initializer-gated), and, from the fetched state, that the owner is
     renounced and the proxy itself cannot write storage.
Every derived fact is checked; a mismatch exits with status 1. Writes a JSON report.

usage: python3 -I scripts/mining-analysis/lifecycle.py [reports/mining-code] [reports/mining-lifecycle-analysis.json]
Standard library only; runs in well under a minute.
"""
import json
import os
import re
import sys
import time

sys.dont_write_bytecode = True  # keep the repository free of __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cfg import Graph  # noqa: E402
from keccak import keccak256  # noqa: E402
from sym import Explorer, Program, fmt, is_c, mapping_of, mk  # noqa: E402

MINING_PROXY = 0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46
EXPECTED = {
    'implementation': '0x63b1124d3448fdeb28b163c52142e15a7a464d7ae7d817e51f6c242b62424479',
    'library': '0x028ff888dc6b7505d507ffd33ef99d8541a23852d36a0463de235af6772e4737',
}
MINERS = 8  # storage slot of mapping(bytes32 key => Miner); record word +2 holds the status in its low byte
IMPLEMENTATION_SLOT = 0x360894A13BA1A3210667C828492DB98DCA3E2076CC3735A920A3CA505D382BBC  # ERC-1967
OWNER_SLOT = 0x9016D09D72D40FDAE2FD8CEAC6B6234C7706214FD39C1CD1E609A0528C199300  # OZ 5 OwnableUpgradeable
INITIALIZABLE_SLOT = 0xF0C57E16840DF040F15088DC2F81FE391C3923BEC73E23A9662EFC9C229C6A00  # OZ 5 Initializable

NAMES = {
    0xa3494614: 'start', 0x63c4f031: 'stop', 0x2d33823a: 'challenge', 0x96afb365: 'reclaim', 0x919c1ada: 'kick',
    0xbd66528a: 'claim', 0x7ed51748: 'claimMany', 0xec2f8441: 'registerCounterexample', 0x2a24c84b: 'arm',
    0xc7b21b6c: 'commitDesign', 0x4f1ef286: 'upgradeToAndCall', 0x0527edc2: 'getMiner', 0x1808eeb8: 'pending',
    0x10eafa00: 'minerKey', 0x6c3d4470: 'cachedBurn', 0x6687aabd: 'circuitBurn', 0x8456cb59: 'pause',
    0x3f4ba83a: 'unpause', 0x715018a6: 'renounceOwnership', 0xf2fde38b: 'transferOwnership', 0x8da5cb5b: 'owner',
    0x5c975abb: 'paused', 0x52d1902d: 'proxiableUUID', 0xad3cb1cc: 'UPGRADE_INTERFACE_VERSION', 0xfc0c546a: 'token',
    0x6f1e9d41: 'STOP_COOLDOWN', 0x11d5a55c: 'bestSlot', 0x462afa31: 'armedAt', 0xe16ed3de: 'designCommits',
    0xb0d60279: 'passesCounterexamples', 0x2060b9db: 'ceCount', 0xfa1ea911: 'task setup (owner; emits TaskAdded)',
    0x7879ec31: 'initializer', 0xef6aff46: 'totalVerifWeight', 0x63967742: 'totalUnverWeight',
}

# Program points of implementation 0x63b1…2479 (see docs/MINING_LIFECYCLE.md for the disassembly excerpts).
START_GATE_PASSED = 0x1505  # first instruction after start's status gate (0x14eb-0x1504 and 0x1daf-0x1de4)
SETTLE = 0x50AC  # settlement: debt := weight * acc / 1e27, then BEM.mint(holder, accrued - old debt)
SETTLE_CALL_SITES = {0x127D: 'claim', 0x2082: 'reclaim', 0x25B3: 'claimMany', 0x2A02: 'stop', 0x34D7: 'challenge',
                     0x57D6: 'demotion helper (ACTIVE branch)'}
DEMOTE_CLEAR = 0x57B5  # demotion helper, branch for a demoted record that is not ACTIVE: clears bonus/optimal only
MINT_CALL = 0x51D9  # the implementation's only CALL: BEM.mint(holder, amount)
CE_LIBRARY_CALL = 0x0DF4  # DELEGATECALL to library 0x42e970bb (counterexample registration)
STATUS_WRITES = {0x1954: ('start', 1), 0x2A33: ('stop', 3), 0x3527: ('challenge', 2)}
# Entries whose writes sit behind longer loops (task setup copies its arrays before writing the task).
LOOP_BOUND = {0xFA1EA911: 6}
# Internal starting points for sites the entry-level symbolic runs do not reach (unknown stack below):
# start's leader-record update (0x172b computes mapping 9[taskId][circuits], 0x1750 mapping 0x19).
INTERNAL_STARTS = [(0x172B, 40)]
# Sites that no symbolic run reaches, classified from the fork trace of a real restart (start of #672 on
# the pinned block: storage writes at these pcs into the record keccak(key . 8) + offset) and from the code.
TRACED = {
    0x1808: 'slot 0xa (total verified weight)', 0x182B: 'slot 0x11 (counter)', 0x1848: 'slot 0x10 (counter; trace)',
    0x186C: 'record +0 (trace)', 0x189F: 'record +0 (trace)', 0x1905: 'record +1 (trace)',
    0x1954: 'record +2: status := 1 (constant stored at 0x15d2, written as the record word; trace)',
    0x197A: 'record +3 (trace)', 0x19D1: 'record +3 (trace)', 0x19EC: 'record +4 (trace)', 0x1A43: 'record +5 (trace)',
    0x1A48: 'record +6, debt (trace)', 0x1C25: 'slot 0xc (trace)',
    0x0B3B: 'tasks[id] + 2 (task name string)', 0x0B50: 'tasks[id] + 2 data area (string)',
    0x0B66: 'tasks[id] + 2 data area (string)', 0x0BA5: 'tasks[id] + 2 data area (string, clearing)',
    0x212F: 'slot 0xa', 0x2155: 'record +6 of reclaim\'s own key (debt := weight * acc / 1e27)',
    0x469F: 'nested mapping keyed by keccak (circuit cache)', 0x48E2: 'mapping 0x12[address][id]',
    0x4B42: 'record +4 high 128 bits (verified weight; trace: start writes 0 for an unverified restart)',
    0x5519: 'mapping 0x14[address][id] (cached depth)', 0x5844: 'slot 0xa',
    0x5853: 'record +6 of the demoted ACTIVE record (debt := weight * acc / 1e27)',
}

FRESH = re.compile(r'\?(?:sha3u|memu|mem|extcode|code|gasprice|gas|msize|create)\d+')


def norm(text):
    return FRESH.sub('?K', text)


def load_hex(path):
    h = open(path).read().strip()
    return bytes.fromhex(h[2:] if h.startswith('0x') else h)


def is_status_atom(atom):
    if is_c(atom) or atom.op != 'and' or atom.args[1] != 0xFF:
        return False
    inner = atom.args[0]
    if is_c(inner) or inner.op != 'sload':
        return False
    m = mapping_of(inner.args[0])
    return bool(m and m[1] == MINERS and m[2] == 2)


def facts_text(facts):
    keep = [f'{fmt(a)} {f}' for a, f in facts.items() if is_status_atom(a) or 'number' in fmt(a)]
    return '; '.join(sorted(set(norm(x) for x in keep)))


def explorer(prog, **kw):
    ex = Explorer(prog, loop_bound=kw.pop('loop', 3), max_paths=kw.pop('paths', 20000), time_limit=kw.pop('time', 300),
                  stop_at=kw.pop('stop_at', None))
    ex.keep_all = kw.pop('keep_all', False)
    return ex


def run_entry(prog, sel, **kw):
    ex = explorer(prog, **kw)
    ex.run(ex.initial(sel))
    return ex


def gate_facts(prog, graph, sel, points=(), effects=False, **kw):
    stop = set(points)
    if effects:
        reach = graph.explore(dict(graph.entries())[sel])
        stop |= {pc for pc in reach if graph.ins[pc][0] in ('SSTORE', 'CALL', 'CALLCODE', 'DELEGATECALL', 'TSTORE',
                                                             'CREATE', 'CREATE2', 'SELFDESTRUCT')
                 or graph.ins[pc][0].startswith('LOG')}
    ex = run_entry(prog, sel, stop_at=stop, **kw)
    groups = {}
    for s in ex.stopped:
        key = (f'{s.pc:#06x}', facts_text(s.facts))
        groups[key] = groups.get(key, 0) + 1
    return {'ends': ex.ends, 'truncated': ex.truncated,
            'points': [{'pc': pc, 'facts': f, 'paths': n} for (pc, f), n in sorted(groups.items())]}


def all_facts(prog, sel, points, **kw):
    """Every fact (not only status) of each path stopped at one of `points`."""
    ex = run_entry(prog, sel, stop_at=set(points), **kw)
    return [(s.pc, sorted(set(norm(f'{fmt(a)} {f}') for a, f in s.facts.items()))) for s in ex.stopped]


def slot_shapes(ex):
    shapes = {}
    for s, _ in list(ex.ok_paths) + list(ex.other_paths):
        for pc, slot, *_ in s.writes:
            shapes.setdefault(pc, set()).add(norm(fmt(slot)))
    return shapes


def record_offset(shape):
    """Record offset k when a slot shape reads `keccak(<key>, 0x8) + k` (k = 0 without '+')."""
    m = re.fullmatch(r'\(?keccak\((.*), 0x8\)(?: \+ (\d+))?\)?', shape)
    return None if not m else int(m.group(2) or 0)


class Checks:
    def __init__(self):
        self.failures = []

    def require(self, ok, what):
        print(('  ok   ' if ok else '  FAIL ') + what)
        if not ok:
            self.failures.append(what)


def main():
    code_dir = sys.argv[1] if len(sys.argv) > 1 else 'reports/mining-code'
    out_path = sys.argv[2] if len(sys.argv) > 2 else 'reports/mining-lifecycle-analysis.json'
    t0 = time.time()
    check = Checks()
    manifest = json.load(open(os.path.join(code_dir, 'manifest.json')))
    impl_code = load_hex(os.path.join(code_dir, manifest['implementation']['file']))
    lib_code = load_hex(os.path.join(code_dir, manifest['library']['file']))
    impl_hash = '0x' + keccak256(impl_code).hex()
    lib_hash = '0x' + keccak256(lib_code).hex()
    print('identity')
    check.require(impl_hash == EXPECTED['implementation'], f'implementation code hash {impl_hash}')
    check.require(lib_hash == EXPECTED['library'], f'library code hash {lib_hash}')
    if check.failures:
        sys.exit('this analysis applies only to the code hashes it was written for')

    impl, lib = Program(impl_code, MINING_PROXY), Program(lib_code, MINING_PROXY)
    gi, gl = Graph(impl_code), Graph(lib_code)
    gi.window, gl.window, gl.entry_depth = 48, 48, 3
    entries = dict(gi.entries())
    name = lambda s: NAMES.get(s, f'0x{s:08x}')

    # 1. Reachability of every storage write and external call.
    print('control flow')
    sstores = [pc for pc in gi.order if gi.ins[pc][0] == 'SSTORE']
    calls = [pc for pc in gi.order if gi.ins[pc][0] in ('CALL', 'DELEGATECALL', 'CALLCODE', 'CREATE', 'CREATE2', 'SELFDESTRUCT')]
    reach = {sel: gi.explore(e) for sel, e in entries.items()}
    by_site = {pc: [name(s) for s, r in reach.items() if pc in r] for pc in sstores + calls}
    check.require(not gi.problems, f'all jumps resolved in {len(entries)} entries (problems: {sorted(set(gi.problems))[:3]})')
    check.require(by_site[MINT_CALL] and gi.ins[MINT_CALL][0] == 'CALL' and len([c for c in calls if gi.ins[c][0] == 'CALL']) == 1,
                  'one CALL in the implementation (BEM mint at 0x51d9)')
    check.require(by_site[CE_LIBRARY_CALL] == ['registerCounterexample'], 'library counterexample call reachable only from registerCounterexample')

    # 2. Slot shapes: symbolic runs from every entry that can reach a write, plus internal starting points.
    print('symbolic slot shapes')
    shapes = {}
    for sel in entries:
        if not any(pc in reach[sel] for pc in sstores):
            continue
        deep = sel in LOOP_BOUND
        ex = run_entry(impl, sel, keep_all=True, loop=LOOP_BOUND.get(sel, 2), paths=8000 if deep else 4000, time=200 if deep else 90)
        for pc, ss in slot_shapes(ex).items():
            shapes.setdefault(pc, set()).update(ss)
    for pc, depth in INTERNAL_STARTS:
        ex = explorer(impl, keep_all=True, loop=2, paths=6000, time=120)
        s = ex.initial(0xA3494614)
        s.pc, s.stack = pc, [mk('stk', depth - i) for i in range(depth)]
        for i in range(32):
            s.mem[0x40 + i] = (0x80, i)
        ex.run(s)
        for wpc, ss in slot_shapes(ex).items():
            shapes.setdefault(wpc, set()).update(ss)
    sites = []
    status_sites = set()
    for pc in sstores:
        observed = sorted(shapes.get(pc, ()))
        offsets = {record_offset(x) for x in observed} - {None}
        traced = TRACED.get(pc)
        if 2 in offsets or (traced and traced.startswith('record +2')):
            status_sites.add(pc)
        sites.append({'pc': f'{pc:#06x}', 'reachableFrom': by_site[pc], 'slotShapes': observed[:6],
                      'classification': traced or ('miner record +' + ','.join(map(str, sorted(offsets))) if offsets else 'other storage')})
        check.require(bool(observed) or traced is not None, f'write site {pc:#06x} classified')
    check.require(status_sites == set(STATUS_WRITES), 'status byte written only at ' + ', '.join(f'{pc:#06x}' for pc in sorted(status_sites)))

    # 3. Status conditions on the paths.
    print('status conditions')
    gates = {
        'start: gate passed': gate_facts(impl, gi, 0xA3494614, [START_GATE_PASSED], time=120),
        'stop: first state change': gate_facts(impl, gi, 0x63C4F031, effects=True, time=180),
        'claim: first state change': gate_facts(impl, gi, 0xBD66528A, effects=True, time=180),
        'reclaim: first state change': gate_facts(impl, gi, 0x96AFB365, effects=True, time=180),
        'challenge: payout call': gate_facts(impl, gi, 0x2D33823A, [0x34D7], time=300),
        'challenge: status write': gate_facts(impl, gi, 0x2D33823A, [0x3527], time=600, paths=60000),
        'claimMany: settlement': gate_facts(impl, gi, 0x7ED51748, [SETTLE], time=200),
        'kick: settlement or bonus clear': gate_facts(impl, gi, 0x919C1ADA, [SETTLE, DEMOTE_CLEAR], time=300),
        'reclaim: settlement or bonus clear': gate_facts(impl, gi, 0x96AFB365, [SETTLE, DEMOTE_CLEAR], time=300),
    }
    own = 'and(sload((keccak(cd[4], 0x8) + 2)), 0xff)'
    start_pts = gates['start: gate passed']['points']
    check.require(start_pts and all(('== 0' in p['facts'] and '== 3' not in p['facts']) or
                                    ('== 3' in p['facts'] and '+ 0x4b0)) ∉ {0}' in p['facts']) for p in start_pts),
                  'start passes its gate only with status 0, or status 3 and block.number > stopBlock + 1200')
    for g in ('stop: first state change', 'claim: first state change', 'reclaim: first state change'):
        pts = gates[g]['points']
        check.require(pts and all(f'{own} == 1' in p['facts'] for p in pts), f'{g}: only with status 1')
    pay = gates['challenge: payout call']['points']
    check.require(pay and all(f'{own} == 1' in p['facts'] for p in pay), 'challenge pays out only with status 1')
    rev = gates['challenge: status write']['points']
    check.require(rev and all(f'{own} == 1' in p['facts'] or (f'{own} == 3' in p['facts'] and '+ 0x4b0)) == 0' in p['facts'])
                              for p in rev)
                  and any(f'{own} == 1' in p['facts'] for p in rev) and any(f'{own} == 3' in p['facts'] for p in rev),
                  'challenge revokes only from status 1, or status 3 with block.number <= stopBlock + 1200')
    cm = gates['claimMany: settlement']['points']
    check.require(cm and all('== 1' in p['facts'] for p in cm), 'claimMany reaches settlement only after a key with status 1')
    kk = gates['kick: settlement or bonus clear']['points']
    check.require(kk and all(('== 1' in p['facts']) == (p['pc'] == '0x50ac') for p in kk),
                  'kick settles a demoted record only with status 1; otherwise it only clears its bonus')

    # The status checks sit before any loop: every path from the entry to each check is explored in full.
    prefixes = {'start': (0xA3494614, [START_GATE_PASSED]), 'stop': (0x63C4F031, [0x29A9]), 'claim': (0xBD66528A, [0x1279]),
                'challenge': (0x2D33823A, [0x344F]), 'reclaim': (0x96AFB365, [0x1F40, 0x2269])}
    for fn, (sel, pts) in prefixes.items():
        g = gate_facts(impl, gi, sel, pts, time=120)
        gates[f'{fn}: entry to status check'] = g
        check.require(not g['truncated'] and not {'loop_bound', 'unexplored', 'path_steps', 'bad_jump'} & set(g['ends']),
                      f'{fn}: every path from the entry to its status check explored in full ({g["ends"]})')
    rc = gates['reclaim: settlement or bonus clear']['points']
    check.require(rc and all(f'{own} == 1' in p['facts'] for p in rc), 'reclaim settles or demotes only when its own key has status 1')

    # Settlement call sites per function (control flow, each site alone).
    settlement = {}
    for sel in entries:
        if SETTLE not in reach[sel]:
            continue
        settlement[name(sel)] = [f'{s:#06x} {SETTLE_CALL_SITES[s]}' for s in SETTLE_CALL_SITES
                                 if SETTLE in gi.explore(entries[sel], frozenset(x for x in SETTLE_CALL_SITES if x != s))]
        check.require(SETTLE not in gi.explore(entries[sel], frozenset(SETTLE_CALL_SITES)),
                      f'{name(sel)} reaches settlement only through the known call sites')

    # Upgrade and ownership authority: who can replace the implementation or become owner.
    print('upgrade authority')
    owner_gate = f'sub(caller, and(sload({fmt(OWNER_SLOT)}), 0xffffffffffffffffffffffffffffffffffffffff)) == 0'
    slot_sites = lambda slot: sorted(pc for pc, ss in shapes.items() if fmt(slot) in ss)
    impl_sites, owner_sites = slot_sites(IMPLEMENTATION_SLOT), slot_sites(OWNER_SLOT)
    init_sites = slot_sites(INITIALIZABLE_SLOT)
    check.require(impl_sites == [0x30AF] and by_site[0x30AF] == ['upgradeToAndCall'],
                  'implementation slot written only by upgradeToAndCall (0x30af)')
    authority = {}
    for group, label in ((impl_sites, 'implementation slot'), (owner_sites, 'owner slot'), (init_sites, 'initializer slot')):
        for pc in group:
            for entry in by_site[pc]:
                sel = next(k for k, v in entries.items() if name(k) == entry)
                paths = all_facts(impl, sel, group, time=120)
                authority[f'{label} {pc:#06x} via {entry}'] = paths
                owner_only = all(owner_gate in f for _, f in paths)
                initializer = all(any(f'and(sload({fmt(INITIALIZABLE_SLOT)}), 0xffffffffffffffff) == 0' in x for x in f) or
                                  (any(f'and(sload({fmt(INITIALIZABLE_SLOT)}), 0xffffffffffffffff) == 1' in x for x in f) and
                                   any(f'extcodesize({fmt(MINING_PROXY)}) == 0' in x for x in f)) for _, f in paths)
                check.require(bool(paths) and (owner_only or initializer),
                              f'{label} write {pc:#06x} via {entry}: ' + ('owner only' if owner_only else 'initializer guard only'))
    owner_word = int(manifest['storage']['owner'], 16)
    init_word = int(manifest['storage']['initializableWord'], 16)
    check.require(owner_word == 0, f'owner renounced at block {manifest["block"]} (owner slot is zero)')
    check.require(init_word & 0xFFFFFFFFFFFFFFFF == 1 and (init_word >> 64) & 0xFF == 0,
                  'initialized (version 1, not initializing): the initializer guard cannot pass at a proxy with code')
    proxy = Graph(load_hex(os.path.join(code_dir, manifest['proxyCode']['file'])))
    ops = [proxy.ins[pc] for pc in proxy.order]
    check.require(not any(op in ('SSTORE', 'CALL', 'CALLCODE', 'CREATE', 'CREATE2', 'SELFDESTRUCT') for op, _ in ops)
                  and [op for op, _ in ops].count('DELEGATECALL') == 1 and ('PUSH32', IMPLEMENTATION_SLOT) in ops,
                  'proxy: one DELEGATECALL to the ERC-1967 slot, no storage writes, no other calls')
    for g, label in ((gi, 'implementation'), (gl, 'library')):
        check.require(not any(g.ins[pc][0] in ('SELFDESTRUCT', 'CREATE', 'CREATE2', 'CALLCODE') for pc in g.order),
                      f'{label}: no SELFDESTRUCT, CREATE, CREATE2 or CALLCODE')

    # 4. Library.
    print('library')
    lib_entries = dict(gl.entries())
    lib_sstores = [pc for pc in gl.order if gl.ins[pc][0] == 'SSTORE']
    lib_reach = {sel: gl.explore(e) for sel, e in lib_entries.items()}
    lib_by_site = {pc: [f'0x{s:08x}' for s, r in lib_reach.items() if pc in r] for pc in lib_sstores}
    check.require(not gl.problems, 'library: all jumps resolved')
    check.require(all(v == ['0x42e970bb'] for v in lib_by_site.values()), 'library writes storage only from 0x42e970bb')
    ex = run_entry(lib, 0x42E970BB, keep_all=True, loop=5, paths=30000, time=600)
    lib_shapes = slot_shapes(ex)
    check.require(lib_shapes and all('cd[4]' in s for ss in lib_shapes.values() for s in ss),
                  f'library slots all derive from its storage-pointer argument ({sum(map(len, lib_shapes.values()))} shapes, {len(lib_shapes)}/{len(lib_sstores)} sites reached)')

    report = {
        'schema': 'tapeout-mining-lifecycle-analysis/1',
        'source': {k: manifest[k] for k in ('chainId', 'block', 'blockHash', 'proxy', 'implementation', 'library')},
        'method': [
            'Control flow: abstract interpretation of every dispatcher entry, tracking only jump-target constants on the stack (both branches of every JUMPI), memoized on the top 48 stack entries.',
            'Slots and conditions: bounded symbolic execution (loops unrolled up to 2-6 times, storage and calldata symbolic, external calls return unknowns); conditions are the facts a path established about miner status bytes and the block number. The path from each lifecycle function\'s entry to its status check is explored in full.',
            'Sites no symbolic run reaches are classified from the fork trace of a real restart and from the code, as listed under classification.',
            'Applies to the two code hashes in source only; an upgrade of the Mining proxy invalidates it.',
        ],
        'storageLayout': {'minersMappingSlot': MINERS, 'record': {'+2 low byte': 'status (0 none, 1 active, 2 revoked, 3 cooling)',
                                                                   '+4 bits 64-127': 'stopBlock', '+4 bits 128-255': 'verified weight',
                                                                   '+5 low 128 bits': 'unverified weight', '+6': 'debt (accumulator checkpoint)'}},
        'entries': {f'0x{s:08x}': name(s) for s in entries},
        'writeSites': sites,
        'statusWrites': [{'pc': f'{pc:#06x}', 'function': f, 'value': v} for pc, (f, v) in sorted(STATUS_WRITES.items())],
        'upgradeAuthority': {'implementationSlotWriters': [f'{pc:#06x}' for pc in impl_sites],
                             'ownerSlotWriters': [f'{pc:#06x}' for pc in owner_sites],
                             'initializerSlotWriters': [f'{pc:#06x}' for pc in init_sites],
                             'owner': manifest['storage']['owner'], 'initializableWord': manifest['storage']['initializableWord'],
                             'proxyCode': manifest['proxyCode'],
                             'paths': {k: [{'pc': f'{pc:#06x}', 'facts': [x for x in f if 'caller' in x or 'f0c57e' in x or 'extcodesize' in x]}
                                           for pc, f in v] for k, v in authority.items()}},
        'callSites': {f'{pc:#06x}': {'op': gi.ins[pc][0], 'reachableFrom': by_site[pc]} for pc in calls},
        'conditions': gates,
        'settlementCallSites': settlement,
        'library': {'writeSites': {f'{pc:#06x}': v for pc, v in lib_by_site.items()},
                    'slotShapes': {f'{pc:#06x}': sorted(v)[:6] for pc, v in sorted(lib_shapes.items())}},
        'checks': {'failed': check.failures},
        'status': 'PASS' if not check.failures else 'FAIL',
        'seconds': round(time.time() - t0),
    }
    with open(out_path, 'w') as f:
        json.dump(report, f, indent=1)
        f.write('\n')
    print(f'{report["status"]}: {len(check.failures)} failed checks; report {out_path} ({report["seconds"]} s)')
    sys.exit(1 if check.failures else 0)


if __name__ == '__main__':
    main()
