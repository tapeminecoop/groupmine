import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accrue, checkpoint, formatBem, parseBem, residueBound, SINK, SINK_PARTS, TOTAL_PARTS, type State } from '../../sdk/math.ts';

const empty = (nandShares: bigint, latchShares: bigint, totalNandBurn = 0n, totalLatchBurn = 0n): State =>
  ({ nandBase: 0n, latchBase: 0n, participantBase: 0n, totalNandBurn, totalLatchBurn, nandShares, latchShares });
const B = (x: number) => BigInt(x) * 10n ** 8n;

test('specification acceptance example under the 105-part weights: NAND 140, LATCH 60, A 2.5, B 2.5, C 5', () => {
  const before = empty(10n, 10n, 9n, 1n);
  const old = accrue(B(105), before);
  assert.deepEqual([old.nandIncome, old.latchIncome, old.recipientA, old.recipientB, old.sink], [B(90), B(10), 125_000_000n, 125_000_000n, B(2) + B(1) / 2n]);
  const after = checkpoint(B(105), before, 1n, 9n);
  const a = accrue(B(210), after);
  assert.deepEqual([a.nandIncome, a.latchIncome, a.recipientA, a.recipientB, a.sink, a.residue], [B(140), B(60), 250_000_000n, 250_000_000n, B(5), 0n]);
  // The forbidden rule (all history at the latest ratio) would give 100 / 100.
  assert.notEqual(a.nandIncome, (a.participants * after.totalNandBurn) / (after.totalNandBurn + after.totalLatchBurn));
});

test('outer split is 80 + 1 + 1 + 2 of 84 (100 : 1.25 : 1.25 : 2.5), not a 95% / 5% fee', () => {
  assert.equal(TOTAL_PARTS, 84n);
  assert.equal(SINK_PARTS, 2n);
  assert.equal(SINK, '0x000000000000000000000000000000000000dEaD');
  const a = accrue(B(1_050), empty(10n, 10n, 1n, 1n));
  assert.deepEqual([a.participants, a.recipientA, a.recipientB, a.sink], [B(1_000), 1_250_000_000n, 1_250_000_000n, B(25)]);
  assert.equal(a.participants + a.recipientA + a.recipientB + a.sink, B(1_050));
  assert.notEqual(a.participants, (B(1_050) * 95n) / 100n);
});

test('small totals: independent floors, C is floor(2T/84) and not 2 * floor(T/84)', () => {
  const s = empty(10n, 10n, 1n, 1n);
  // [T, A (= B), C, participants], computed by hand from the definition.
  const table: [bigint, bigint, bigint, bigint][] = [
    [0n, 0n, 0n, 0n], [1n, 0n, 0n, 0n], [41n, 0n, 0n, 39n], [42n, 0n, 1n, 40n], [43n, 0n, 1n, 40n], [83n, 0n, 1n, 79n],
    [84n, 1n, 2n, 80n], [85n, 1n, 2n, 80n], [126n, 1n, 3n, 120n], [168n, 2n, 4n, 160n], [1_050n, 12n, 25n, 1_000n],
  ];
  for (const [t, ab, c, p] of table) {
    const a = accrue(t, s);
    assert.deepEqual([a.recipientA, a.recipientB, a.sink, a.participants], [ab, ab, c, p], `T = ${t}`);
    assert.ok(t - 2n * ab - c - p <= 3n, `outer floors leave at most 3 at T = ${t}`);
  }
  assert.notEqual(accrue(42n, s).sink, 2n * accrue(42n, s).recipientA);
});

test('same rounding vectors as the Solidity tests', () => {
  const s = empty(10n, 10n, 1n, 1n);
  assert.equal(accrue(83n, s).participants, 79n);
  assert.equal(accrue(84n, s).recipientA, 1n);
  const t = accrue(85n, s);
  assert.equal(t.recipientA + t.recipientB + t.sink + t.participants, 84n);
  // 2:1 period, then a checkpoint carrying one unit.
  const p1 = empty(10n, 10n, 2n, 1n);
  const a1 = accrue(10_500n, p1);
  assert.deepEqual([a1.nandIncome, a1.latchIncome], [6_666n, 3_333n]);
  const p2 = checkpoint(10_500n, p1, 1n, 1n);
  assert.equal(p2.participantBase, 9_999n);
  const a2 = accrue(11_025n, p2);
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
      assert.equal(a.recipientA + a.recipientB + a.sink + a.nandReceipts + a.latchReceipts + a.residue, total);
      assert.ok(a.residue <= residueBound(sN, sL));
      assert.equal(a.recipientA, total / 84n);
      assert.equal(a.sink, (total * 2n) / 84n);
      assert.equal(a.participants, (total * 80n) / 84n);
      assert.ok(a.nandIncome >= last.nandIncome && a.latchIncome >= last.latchIncome && a.perNandShare >= last.perNandShare
        && a.recipientA >= last.recipientA && a.sink >= last.sink);
      last = a;
      s = checkpoint(total, s, rand(300n), rand(300n) + 1n);
    }
  }
});

test('residue bound: 3 outer units, 1 category unit, S - 1 per collection', () => {
  assert.equal(residueBound(1n, 1n), 4n);
  assert.equal(residueBound(10n, 0n), 13n);
  // Every remainder: the outer floors never leave more than 3 units.
  let max = 0n;
  for (let r = 0n; r < 84n; r++) {
    const outer = r - (2n * r) / 84n - (80n * r) / 84n;
    if (outer > max) max = outer;
  }
  assert.equal(max, 3n);
});

test('BEM parsing and formatting', () => {
  assert.equal(parseBem('0.00000323'), 323n);
  assert.equal(parseBem('1050'), 105_000_000_000n);
  assert.equal(formatBem(27_497_042n), '0.27497042');
  assert.throws(() => parseBem('1.123456789'));
});
