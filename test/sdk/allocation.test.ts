import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import { allocationArtifact, allocationBatchGas, allocationBatches, allocationFileSchema, assignIds, runs, validateAllocation, MAX_RANGE } from '../../sdk/allocation.ts';
import { BATCH_GAS_BUDGET } from '../../sdk/constants.ts';
import example from '../../deployments/examples/allocation.example.json' with { type: 'json' };

const W1 = '0x1111111111111111111111111111111111111111';
const W2 = '0x2222222222222222222222222222222222222222';

test('the specification example validates and gets deterministic contiguous IDs', () => {
  const { entries, totals } = validateAllocation(allocationFileSchema.parse(example));
  assert.deepEqual(totals, { NAND: 30, LATCH: 5 });
  const inv = { NAND: Array.from({ length: 30 }, (_, i) => i + 1), LATCH: [1, 2, 3, 4, 5] };
  const a = assignIds(entries, inv);
  assert.deepEqual(a[0].NAND, [[1, 20]]);
  assert.deepEqual(a[0].LATCH, [[1, 5]]);
  assert.deepEqual(a[1].NAND, [[21, 10]]);
  assert.deepEqual(a[1].LATCH, []);
  assert.deepEqual(assignIds(entries, { NAND: [...inv.NAND].reverse(), LATCH: inv.LATCH }), a); // inventory order irrelevant
});

test('assignment follows the actual inventory, including gaps', () => {
  const { entries } = validateAllocation({ allocations: [{ wallet: W1, nandCount: 4, latchCount: 0 }, { wallet: W2, nandCount: 2, latchCount: 1 }] });
  const a = assignIds(entries, { NAND: [3, 4, 7, 8, 9, 12], LATCH: [2] });
  assert.deepEqual(a[0].NAND, [[3, 2], [7, 2]]);
  assert.deepEqual(a[1].NAND, [[9, 1], [12, 1]]);
  assert.deepEqual(runs([1, 2, 3, 5]), [[1, 3], [5, 1]]);
});

test('validation rejects duplicates, bad addresses, empty entries and unknown fields', () => {
  assert.throws(() => validateAllocation({ allocations: [{ wallet: W1, nandCount: 1, latchCount: 0 }, { wallet: W1.toUpperCase().replace('0X', '0x'), nandCount: 1, latchCount: 0 }] }), /already listed/);
  assert.throws(() => validateAllocation({ allocations: [{ wallet: '0x0000000000000000000000000000000000000000', nandCount: 1, latchCount: 0 }] }), /zero address/);
  assert.throws(() => validateAllocation({ allocations: [{ wallet: W2, nandCount: 0, latchCount: 0 }] }), /receives nothing/);
  // EIP-55 vector with one letter's case flipped: valid hex, invalid checksum.
  assert.throws(() => validateAllocation({ allocations: [{ wallet: '0x52908400098527886E0F7030069857D2E4169Ee7', nandCount: 1, latchCount: 0 }] }), /checksum/);
  assert.doesNotThrow(() => validateAllocation({ allocations: [{ wallet: '0x52908400098527886e0f7030069857d2e4169ee7', nandCount: 1, latchCount: 0 }] }));
  assert.throws(() => allocationFileSchema.parse({ allocations: [{ wallet: W1, nandCount: 1, latchCount: 0, ids: [1] }] }));
  assert.throws(() => allocationFileSchema.parse({ allocations: [{ wallet: W1, nandCount: -1, latchCount: 0 }] }));
  assert.throws(() => allocationFileSchema.parse({ allocations: [{ wallet: W1, nandCount: 1.5, latchCount: 0 }] }));
});

test('inventory coverage must be exact and IDs unique', () => {
  const { entries } = validateAllocation({ allocations: [{ wallet: W1, nandCount: 3, latchCount: 1 }] });
  assert.throws(() => assignIds(entries, { NAND: [1, 2], LATCH: [1] }), /holds 2/);
  assert.throws(() => assignIds(entries, { NAND: [1, 2, 3, 4], LATCH: [1] }), /holds 4/);
  assert.throws(() => assignIds(entries, { NAND: [1, 2, 2], LATCH: [1] }), /twice/);
});

test('batches respect the per-transaction ID limit and the contract range limit', () => {
  const { entries } = validateAllocation({ allocations: [{ wallet: W1, nandCount: 2500, latchCount: 7 }, { wallet: W2, nandCount: 3, latchCount: 0 }] });
  const a = assignIds(entries, { NAND: Array.from({ length: 2503 }, (_, i) => i + 1), LATCH: [1, 2, 3, 4, 5, 6, 7] });
  const batches = allocationBatches(a, 400);
  const ids = batches.flatMap(b => b.flatMap(e => Array.from({ length: Number(e.count) }, (_, i) => `${e.category}:${Number(e.firstId) + i}`)));
  assert.equal(ids.length, 2510);
  assert.equal(new Set(ids).size, 2510);
  assert.ok(batches.every(b => b.reduce((s, e) => s + Number(e.count), 0) <= 400));
  assert.ok(batches.every(b => b.every(e => Number(e.count) <= MAX_RANGE)));
  const artifact = allocationArtifact({ chainId: 56, distributor: getAddress(W2), nandReceipt: getAddress(W1), latchReceipt: getAddress(W1), sourceSha256: 'ab', blockNumber: 7n }, a);
  assert.deepEqual(artifact.totals, { NAND: 2503, LATCH: 7, wallets: 2 });
});

test('many small wallets are split by gas, not only by ID count', () => {
  const wallets = Array.from({ length: 300 }, (_, i) => `0x${(0x10000 + i).toString(16).padStart(40, '0')}`);
  const { entries } = validateAllocation({ allocations: wallets.map(wallet => ({ wallet, nandCount: 1, latchCount: 1 })) });
  const a = assignIds(entries, { NAND: Array.from({ length: 300 }, (_, i) => i + 1), LATCH: Array.from({ length: 300 }, (_, i) => i + 1) });
  const batches = allocationBatches(a, 400);
  // 600 single-ID ranges: the ID limit alone would put 400 ranges (~50M gas) in one transaction.
  assert.ok(batches.every(b => allocationBatchGas(b) <= BATCH_GAS_BUDGET));
  assert.ok(batches.every(b => b.length <= 85));
  assert.equal(batches.reduce((s, b) => s + b.length, 0), 600);
  // One large range keeps the ID limit as the binding constraint.
  const big = assignIds(validateAllocation({ allocations: [{ wallet: W1, nandCount: 1200, latchCount: 0 }] }).entries, { NAND: Array.from({ length: 1200 }, (_, i) => i + 1), LATCH: [] });
  assert.deepEqual(allocationBatches(big, 400).map(b => b.reduce((s, e) => s + Number(e.count), 0)), [400, 400, 400]);
});
