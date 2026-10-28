/**
 * Review-only tests (candidate 8cf31dc), risk group 6 for the TypeScript consumers: the SDK's math
 * mirror against an independent bigint implementation of the specification, the stale-ABI misread,
 * and the reconciliation checks with unpaid or overpaid C.
 * Run: node --import tsx --test test/audit2/fee-split-consumers.test.ts
 * Adapted for TapeoutMinerPool/2.2.0 (SALUS remediation): the independent `incomes` follows 2.2.0's
 * category ledger (bases in units of 1 / (84 * 10^18) raw BEM with their fractions, NAND the floor of each
 * split, LATCH the rest), the State literals have 2.2.0's fields, and a checkpoint's identity is the
 * ledger's (bases add up to the participants' exact share). As committed: a74f6d4.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters, encodeAbiParameters } from 'viem';
import { accrue, checkpoint, residueBound, SINK, type State } from '../../sdk/math.ts';
const U = 80n * 10n ** 18n; // 2.2.0: ledger units of one raw unit's participant share
const LU = 84n * 10n ** 18n; // 2.2.0: ledger units per raw unit
import { checkReconciliation, releasePlans, type Reconciliation } from '../../sdk/pool.ts';
import { tapeoutMinerPoolAbi } from '../../sdk/abi.ts';
import { CALL_GAS } from '../../sdk/gas.ts';

// ---- independent specification arithmetic (no import from sdk/math beyond the subject under test)
const A = (t: bigint) => t / 84n;
const C = (t: bigint) => (t * 2n) / 84n;
const P = (t: bigint) => (t * 80n) / 84n;
function incomes(t: bigint, s: State) {
  let nand = s.nandBase, latch = s.latchBase;
  const w = s.totalNandBurn + s.totalLatchBurn;
  if (w !== 0n) { const d = (t - s.accountedBase) * U, toNand = (d * s.totalNandBurn) / w; nand += toNand; latch += d - toNand; }
  return { nand: nand / LU, latch: latch / LU, nandUnits: nand, latchUnits: latch };
}
let seed = 20261021n;
const rand = (max: bigint) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n); return seed % max; };

test('sdk/math.accrue equals the specification for every remainder and for random periods', () => {
  let s: State = { accountedBase: 0n, nandBase: 0n, latchBase: 0n, totalNandBurn: 3n, totalLatchBurn: 1n, nandShares: 10n, latchShares: 4n };
  for (const base of [0n, 84n, 84n * 10n ** 12n]) for (let r = 0n; r < 84n; r++) {
    const t = base + r, a = accrue(t, s), i = incomes(t, s);
    assert.deepEqual([a.recipientA, a.recipientB, a.sink, a.participants, a.nandIncome, a.latchIncome], [A(t), A(t), C(t), P(t), i.nand, i.latch], `T=${t}`);
    assert.equal(a.residue, t - 2n * A(t) - C(t) - 10n * (i.nand / 10n) - 4n * (i.latch / 4n));
    assert.ok(t - 2n * A(t) - C(t) - P(t) <= 3n);
  }
  let t = 0n, lastC = 0n, lastN = 0n, lastL = 0n;
  for (let k = 0; k < 2000; k++) {
    t += rand(10n ** 12n);
    const a = accrue(t, s), i = incomes(t, s);
    assert.deepEqual([a.recipientA, a.sink, a.participants, a.nandIncome, a.latchIncome], [A(t), C(t), P(t), i.nand, i.latch]);
    assert.ok(a.sink >= lastC && a.nandIncome >= lastN && a.latchIncome >= lastL, 'monotone');
    assert.ok(a.residue <= residueBound(10n, 4n));
    assert.ok(P(t) - a.nandIncome - a.latchIncome <= 1n);
    [lastC, lastN, lastL] = [a.sink, a.nandIncome, a.latchIncome];
    if (k % 50 === 49) {
      const c = { ...checkpoint(t, s), totalNandBurn: s.totalNandBurn + rand(50n), totalLatchBurn: s.totalLatchBurn + rand(50n) + 1n };
      assert.deepEqual([c.nandBase, c.latchBase, c.nandBase + c.latchBase], [i.nandUnits, i.latchUnits, t * U]);
      s = c;
    }
  }
});

test('a 2.0.0 decoder reads the 2.1.0 accrual tuple shifted, without an error', () => {
  const item = (tapeoutMinerPoolAbi as readonly { type: string; name?: string; outputs?: unknown }[]).find(i => i.type === 'function' && i.name === 'accrual')!;
  const outputs = (item as { outputs: readonly { components: readonly { name: string; type: string }[] }[] }).outputs[0].components;
  assert.deepEqual(outputs.map(o => o.name), ['total', 'recipientA', 'recipientB', 'sink', 'participants', 'nandIncome', 'latchIncome', 'perNandShare', 'perLatchShare', 'nandReceipts', 'latchReceipts', 'residue']);
  const values = { total: 1050n, recipientA: 12n, recipientB: 12n, sink: 25n, participants: 1000n, nandIncome: 750n, latchIncome: 250n, perNandShare: 75n, perLatchShare: 25n, nandReceipts: 750n, latchReceipts: 250n, residue: 1n };
  const encoded = encodeAbiParameters([{ type: 'tuple', components: outputs }], [values]);
  const old = ['total', 'recipientA', 'recipientB', 'participants', 'nandIncome', 'latchIncome', 'perNandShare', 'perLatchShare', 'nandReceipts', 'latchReceipts', 'residue'];
  const stale = decodeAbiParameters([{ type: 'tuple', components: old.map(name => ({ name, type: 'uint256' })) }], encoded)[0] as Record<string, bigint>;
  assert.equal(stale.participants, 25n, 'stale participants = sink');
  assert.equal(stale.nandIncome, 1000n);
  assert.equal(stale.residue, 250n, 'stale residue = latchReceipts');
  const fresh = decodeAbiParameters([{ type: 'tuple', components: outputs }], encoded)[0] as Record<string, bigint>;
  assert.equal(fresh.participants, 1000n);
  assert.equal(fresh.residue, 1n);
});

test('reconciliation checks: unpaid C is an obligation; C paid as 2*floor(T/84) or above its accrual fails', () => {
  const state: State = { accountedBase: 0n, nandBase: 0n, latchBase: 0n, totalNandBurn: 1n, totalLatchBurn: 1n, nandShares: 2n, latchShares: 2n };
  const ledger = (t: bigint, a: bigint, b: bigint, c: bigint, extra: Partial<Reconciliation> = {}): Reconciliation => {
    const x = accrue(t, state); const totalPaid = a + b + c;
    return { bemBalance: t - totalPaid, unrecognized: 0n, deficit: 0n, totalAccounted: t, totalPaid, recipientAAccrued: x.recipientA, recipientAPaid: a, recipientBAccrued: x.recipientB, recipientBPaid: b,
      sinkAccrued: x.sink, sinkPaid: c, nandIncome: x.nandIncome, nandReceiptsAccrued: x.nandReceipts, nandReceiptsPaid: 0n, latchIncome: x.latchIncome, latchReceiptsAccrued: x.latchReceipts, latchReceiptsPaid: 0n, residue: x.residue, ...extra };
  };
  const good = checkReconciliation(state, ledger(1050n, 12n, 0n, 25n));
  assert.equal(good.status, 'PASS', JSON.stringify(good.checks));
  assert.equal(good.outstanding.recipientB, 12n);
  assert.equal(good.outstanding.sink, 0n);
  // T = 126: C = 3, 2 * A = 2. A ledger claiming C = 2 fails the independent outer check.
  const doubled = checkReconciliation(state, { ...ledger(126n, 1n, 0n, 2n), sinkAccrued: 2n, residue: accrue(126n, state).residue + 1n });
  assert.equal(doubled.checks.outerPartsFromTotal, false);
  // C paid above its accrual (3 paid at T = 126 where C = 3 is fine; 4 is not).
  assert.equal(checkReconciliation(state, ledger(126n, 1n, 1n, 3n)).status, 'PASS');
  const over = checkReconciliation(state, ledger(126n, 1n, 1n, 4n));
  assert.equal(over.checks.noBucketOverpaid, false);
  assert.equal(over.status, 'FAIL');
  // Release plans carry the 300k bound and name the fixed sink.
  for (const p of releasePlans('0x00000000000000000000000000000000000000a3')) { assert.equal(p.gas, 300_000n); assert.ok(p.description.includes(SINK)); }
  assert.equal(CALL_GAS.releaseA, 300_000n);
});
