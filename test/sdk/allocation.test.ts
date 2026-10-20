import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocationSchema, buildIssuance, issuanceCalls, runs, summarize } from '../../sdk/allocation.ts';

const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';
const R = '0x00000000000000000000000000000000000000e1';

test('shares entries take the lowest free IDs around pinned IDs', () => {
  const issuance = buildIssuance('NAND', 10, [
    { holder: A, shares: 3 },
    { holder: B, ids: [2, 9] },
    { holder: A, shares: 2 },
  ], R);
  const ids = Object.fromEntries(issuance.assignments.map(a => [a.ref ?? a.holder.toLowerCase() + a.ids[0], a.ids]));
  assert.deepEqual(issuance.assignments[0].ids, [1, 3, 4]);
  assert.deepEqual(issuance.assignments[1].ids, [2, 9]);
  assert.deepEqual(issuance.assignments[2].ids, [5, 6]);
  assert.deepEqual(ids.reserve, [7, 8, 10]);
  const all = issuance.assignments.flatMap(a => a.ids).sort((x, y) => x - y);
  assert.deepEqual(all, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('allocation errors: duplicates, out of range, over-allocation, unallocated without reserve, zero holder', () => {
  assert.throws(() => buildIssuance('NAND', 5, [{ holder: A, ids: [1] }, { holder: B, ids: [1] }]), /allocated twice/);
  assert.throws(() => buildIssuance('NAND', 5, [{ holder: A, ids: [6] }]), /outside 1..5/);
  assert.throws(() => buildIssuance('NAND', 5, [{ holder: A, shares: 4 }, { holder: B, shares: 2 }]), /exceed/);
  assert.throws(() => buildIssuance('LATCH', 5, [{ holder: A, shares: 4 }]), /unallocated/);
  assert.throws(() => buildIssuance('LATCH', 1, [{ holder: '0x0000000000000000000000000000000000000000', shares: 1 }]), /zero address/);
  assert.throws(() => allocationSchema.parse({ nand: [{ holder: A, shares: 0 }] }));
  assert.throws(() => allocationSchema.parse({ nand: [{ holder: A, shares: 1, extra: true }] }));
});

test('issuance calls use contiguous ranges, chunk by size, batch singles, and resume', () => {
  assert.deepEqual(runs([9, 1, 2, 3, 7]), [[1, 3], [7, 1], [9, 1]]);
  const issuance = buildIssuance('NAND', 500, [{ holder: A, shares: 450 }, { holder: B, ids: [452, 454, 499] }], R);
  const calls = issuanceCalls(issuance, 200);
  const minted = calls.flatMap(c => (c.kind === 'range' ? Array.from({ length: c.count }, (_, i) => c.firstId + i) : c.ids)).sort((x, y) => x - y);
  assert.deepEqual(minted, Array.from({ length: 500 }, (_, i) => i + 1));
  assert.ok(calls.every(c => (c.kind === 'range' ? c.count : c.ids.length) <= 200));
  const resumed = issuanceCalls(issuance, 200, new Set(Array.from({ length: 300 }, (_, i) => i + 1)));
  const remaining = resumed.flatMap(c => (c.kind === 'range' ? Array.from({ length: c.count }, (_, i) => c.firstId + i) : c.ids));
  assert.equal(remaining.length, 200);
  assert.ok(remaining.every(id => id > 300));
  assert.equal(summarize(issuance).holders.length, 3);
});
