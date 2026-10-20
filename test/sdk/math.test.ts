import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accrue, checkpoint, formatBem, parseBem, residueBound, type State } from '../../sdk/math.ts';

const empty = (nandShares: bigint, latchShares: bigint, totalNandBurn = 0n, totalLatchBurn = 0n): State =>
  ({ nandBase: 0n, latchBase: 0n, participantBase: 0n, totalNandBurn, totalLatchBurn, nandShares, latchShares });

test('specification acceptance example: 9:1 then 1:9 admitted -> NAND 140, LATCH 60, A 2, B 2', () => {
  const B = (x: number) => BigInt(x) * 10n ** 8n;
  const before = empty(10n, 10n, 9n, 1n);
  const old = accrue(B(102), before);
  assert.deepEqual([old.nandIncome, old.latchIncome, old.recipientA, old.recipientB], [B(90), B(10), B(1), B(1)]);
  const after = checkpoint(B(102), before, 1n, 9n);
  const a = accrue(B(204), after);
  assert.deepEqual([a.nandIncome, a.latchIncome, a.recipientA, a.recipientB, a.residue], [B(140), B(60), B(2), B(2), 0n]);
  // The forbidden rule (all history at the latest ratio) would give 100 / 100.
  assert.notEqual(a.nandIncome, (a.participants * after.totalNandBurn) / (after.totalNandBurn + after.totalLatchBurn));
});

test('outer split is 1 + 1 + 100 of 102, not 1% / 1% / 98%', () => {
  const a = accrue(1_020_000n, empty(10n, 10n, 1n, 1n));
  assert.deepEqual([a.recipientA, a.recipientB, a.participants, a.nandIncome, a.latchIncome], [10_000n, 10_000n, 1_000_000n, 500_000n, 500_000n]);
});

test('same rounding vectors as the Solidity tests', () => {
  const s = empty(10n, 10n, 1n, 1n);
  assert.equal(accrue(101n, s).participants, 99n);
  assert.equal(accrue(102n, s).recipientA, 1n);
  const t = accrue(103n, s);
  assert.equal(t.recipientA + t.recipientB + t.participants, 102n);
  // 2:1 period, then a checkpoint carrying one unit.
  const p1 = empty(10n, 10n, 2n, 1n);
  const a1 = accrue(10_200n, p1);
  assert.deepEqual([a1.nandIncome, a1.latchIncome], [6_666n, 3_333n]);
  const p2 = checkpoint(10_200n, p1, 1n, 1n);
  assert.equal(p2.participantBase, 9_999n);
  const a2 = accrue(10_710n, p2);
  assert.deepEqual([a2.nandIncome, a2.latchIncome], [6_666n + (501n * 3n) / 5n, 3_333n + (501n * 2n) / 5n]);
});

test('conservation, bounds and monotonicity over random periods', () => {
  let seed = 987654321n;
  const rand = (max: bigint) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n; return seed % max; };
  for (let i = 0; i < 1500; i++) {
    const sN = rand(4000n) + 1n, sL = rand(4000n) + 1n;
    let s = empty(sN, sL, rand(500n) + 1n, rand(500n));
    let total = 0n;
    let last = accrue(0n, s);
    for (let k = 0; k < 4; k++) {
      total += rand(10n ** 13n);
      const a = accrue(total, s);
      assert.equal(a.recipientA + a.recipientB + a.nandReceipts + a.latchReceipts + a.residue, total);
      assert.ok(a.residue <= residueBound(sN, sL));
      assert.ok(a.nandIncome >= last.nandIncome && a.latchIncome >= last.latchIncome && a.perNandShare >= last.perNandShare && a.recipientA >= last.recipientA);
      last = a;
      s = checkpoint(total, s, rand(300n), rand(300n) + 1n);
    }
  }
});

test('BEM parsing and formatting', () => {
  assert.equal(parseBem('0.00000323'), 323n);
  assert.equal(parseBem('1020'), 102_000_000_000n);
  assert.equal(formatBem(27_497_042n), '0.27497042');
  assert.throws(() => parseBem('1.123456789'));
});
