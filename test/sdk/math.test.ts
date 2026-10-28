import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accrue, admit, carriedUnits, categoryUnits, checkpoint, formatBem, LEDGER_UNIT, parseBem, participantUnits, residueBound, SINK, SINK_PARTS, TOTAL_PARTS,
  type IncomingMiner, type State,
} from '../../sdk/math.ts';

const empty = (nandShares: bigint, latchShares: bigint, totalNandBurn = 0n, totalLatchBurn = 0n): State =>
  ({ accountedBase: 0n, nandBase: 0n, latchBase: 0n, totalNandBurn, totalLatchBurn, nandShares, latchShares });
const B = (x: number) => BigInt(x) * 10n ** 8n;

test('specification acceptance example (2.2.0): the carried 105 BEM go by the incoming 1:9 miner\'s own burn', () => {
  const before = empty(10n, 10n, 9n, 1n);
  const old = accrue(B(105), before);
  assert.deepEqual([old.nandIncome, old.latchIncome, old.recipientA, old.recipientB, old.sink], [B(90), B(10), 125_000_000n, 125_000_000n, B(2) + B(1) / 2n]);
  const { total, state } = admit(B(105), before, [{ received: B(105), nand: 1n, latch: 9n }]);
  assert.equal(total, B(210));
  const a = accrue(total, state);
  assert.deepEqual([a.nandIncome, a.latchIncome, a.recipientA, a.recipientB, a.sink, a.residue], [B(100), B(100), 250_000_000n, 250_000_000n, B(5), 0n]);
  assert.notEqual(a.nandIncome, B(140), 'not the 2.1.0 post-batch split');
  assert.deepEqual([state.totalNandBurn, state.totalLatchBurn], [10n, 10n]);
});

test('SALUS example: X (10:0) and Y (5:5), 105 BEM each, give NAND 150 / LATCH 50 in every order and batching', () => {
  const X: IncomingMiner = { received: B(105), nand: 10n, latch: 0n };
  const Y: IncomingMiner = { received: B(105), nand: 5n, latch: 5n };
  const s0 = empty(10n, 10n);
  const xy = admit(B(105), admit(0n, s0, [X]).state, [Y]);
  const yx = admit(B(105), admit(0n, s0, [Y]).state, [X]);
  const batch = admit(0n, s0, [X, Y]);
  const reversed = admit(0n, s0, [Y, X]);
  for (const r of [xy, yx, batch, reversed]) {
    const a = accrue(r.total, r.state);
    assert.deepEqual([a.nandIncome, a.latchIncome], [B(150), B(50)]);
    assert.deepEqual([r.state.totalNandBurn, r.state.totalLatchBurn], [15n, 5n]);
    assert.deepEqual([r.state.nandBase, r.state.latchBase], [batch.state.nandBase, batch.state.latchBase]);
  }
  // Ordinary income afterwards follows the aggregate 15 : 5.
  const after = accrue(B(315), batch.state);
  assert.deepEqual([after.nandIncome, after.latchIncome], [B(225), B(75)]);
});

test('carried units: NAND takes the floor, LATCH the rest; nothing is lost', () => {
  const { toNand, toLatch } = carriedUnits(21n, 1n, 2n);
  assert.equal(toNand + toLatch, participantUnits(21n));
  assert.equal(toNand, (21n * 80n * 10n ** 18n) / 3n);
  assert.throws(() => carriedUnits(1n, 0n, 0n));
  // Two such miners: floor(40/3) = 13 and floor(80/3) = 26 together, not 6 + 6 and 13 + 13.
  const r = admit(0n, empty(1n, 1n, 1n, 2n), [{ received: 21n, nand: 1n, latch: 2n }, { received: 21n, nand: 1n, latch: 2n }]);
  const a = accrue(r.total, r.state);
  assert.deepEqual([a.nandIncome, a.latchIncome, a.participants], [13n, 26n, 40n]);
  assert.equal(LEDGER_UNIT, 84n * 10n ** 18n);
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
  // 2:1 period, then a checkpoint that keeps the fractions (2.2.0).
  const p1 = empty(10n, 10n, 2n, 1n);
  const a1 = accrue(10_500n, p1);
  assert.deepEqual([a1.nandIncome, a1.latchIncome], [6_666n, 3_333n]);
  const p2 = { ...checkpoint(10_500n, p1), totalNandBurn: 3n, totalLatchBurn: 2n };
  assert.deepEqual([p2.accountedBase, p2.nandBase, p2.latchBase], [10_500n, 560_000n * 10n ** 18n, 280_000n * 10n ** 18n]);
  const a2 = accrue(11_025n, p2);
  assert.deepEqual([a2.nandIncome, a2.latchIncome], [6_966n, 3_533n]);
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
      const units = categoryUnits(total, s);
      assert.equal(units.nandUnits + units.latchUnits, participantUnits(total), 'the participants\' share is exact in the ledger');
      assert.ok(a.participants - a.nandIncome - a.latchIncome <= 1n);
      last = a;
      // An admission: checkpoint, a random carried miner by its own burn, then the composition grows.
      const incoming = { received: rand(10n ** 12n), nand: rand(300n), latch: rand(300n) + 1n };
      const next = admit(total, s, [incoming]);
      total = next.total;
      s = next.state;
      const b = accrue(total, s);
      assert.ok(b.nandIncome >= last.nandIncome && b.latchIncome >= last.latchIncome, 'no entitlement decreases at a boundary');
      last = b;
    }
  }
});

test('residue bound: 3 outer units, 1 category unit, S - 1 per collection', () => {
  // The two category floors of the exact ledger leave at most one participant unit.

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
