import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accrue, formatBem, formatWeight, parseBem, parseWeight, residueBound, WEIGHT_SCALE, type Shares } from '../../sdk/math.ts';

const shares = (nandShares: number, latchShares: number, historicalNandShares: number, historicalLatchShares: number, weight: string): Shares => ({
  nandShares: BigInt(nandShares), latchShares: BigInt(latchShares), historicalNandShares: BigInt(historicalNandShares),
  historicalLatchShares: BigInt(historicalLatchShares), nandWeight: parseWeight(weight),
});

test('specification example: 1,020 BEM, 80/20, 900+100 NAND, 80+20 LATCH', () => {
  const a = accrue(parseBem('1020'), shares(900, 80, 100, 20, '0.80000000'));
  assert.equal(a.fee, parseBem('20'));
  assert.equal(a.nandIncome, parseBem('800'));
  assert.equal(a.latchIncome, parseBem('200'));
  assert.equal(a.perNandShare, parseBem('0.8'));
  assert.equal(a.perLatchShare, parseBem('2'));
  assert.equal(a.nandReceipts, parseBem('720'));
  assert.equal(a.historicalNand, parseBem('80'));
  assert.equal(a.latchReceipts, parseBem('160'));
  assert.equal(a.historicalLatch, parseBem('40'));
  assert.equal(a.residue, 0n);
});

test('fee is 2/102 of gross, not 2%', () => {
  const a = accrue(1_000_000n, shares(9, 4, 1, 1, '0.8'));
  assert.equal(a.fee, 19_607n);
  assert.equal(a.entitlement, 980_393n);
});

test('same vectors as the Solidity tests', () => {
  const a = accrue(10_200n, shares(3, 7, 0, 0, '0.33333333'));
  assert.deepEqual([a.fee, a.nandIncome, a.latchIncome, a.perNandShare, a.perLatchShare, a.residue], [200n, 3_333n, 6_666n, 1_111n, 952n, 3n]);
  const h = accrue(102_000n, shares(8, 4, 2, 1, '0.8'));
  assert.deepEqual([h.perNandShare, h.perLatchShare, h.historicalNand, h.historicalLatch], [8_000n, 4_000n, 16_000n, 4_000n]);
  const only = accrue(102_000n, shares(0, 4, 5, 0, '0.5'));
  assert.deepEqual([only.historicalNand, only.perLatchShare], [50_000n, 12_500n]);
});

test('conservation, residue bound and monotonicity over random inputs', () => {
  let seed = 12345n;
  const rand = (max: bigint) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n; return seed % max; };
  for (let i = 0; i < 2000; i++) {
    const s: Shares = { nandShares: rand(5000n), latchShares: rand(5000n) + 1n, historicalNandShares: rand(500n) + 1n, historicalLatchShares: rand(500n), nandWeight: rand(WEIGHT_SCALE + 1n) };
    const total = rand(10n ** 16n);
    const a = accrue(total, s);
    assert.equal(a.fee + a.nandReceipts + a.latchReceipts + a.historicalNand + a.historicalLatch + a.residue, total);
    assert.ok(a.residue >= 0n && a.residue <= residueBound(s));
    assert.ok(a.fee * 102n <= total * 2n && (a.fee + 1n) * 102n > total * 2n);
    const b = accrue(total + rand(10n ** 9n), s);
    assert.ok(b.perNandShare >= a.perNandShare && b.perLatchShare >= a.perLatchShare && b.fee >= a.fee);
  }
});

test('weight parsing is exact to 8 decimals and bounded to [0, 1]', () => {
  assert.equal(parseWeight('0.9'), 90_000_000n);
  assert.equal(parseWeight('0.90000000'), 90_000_000n);
  assert.equal(parseWeight('0.00000001'), 1n);
  assert.equal(parseWeight('1'), WEIGHT_SCALE);
  assert.equal(parseWeight('0'), 0n);
  assert.equal(formatWeight(12_345_678n), '0.12345678');
  for (const bad of ['1.00000001', '0.123456789', '-0.1', '2', '.5', '0,5', '']) assert.throws(() => parseWeight(bad));
  assert.equal(parseBem('0.00000323'), 323n);
  assert.equal(formatBem(13_697_739n), '0.13697739');
});
