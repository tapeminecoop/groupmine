import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, type Address } from 'viem';
import { allocationArtifact } from '../../sdk/allocation.ts';
import { parseAllocationArtifact, verifyAllocation, type AllocationState } from '../../sdk/verify.ts';
import type { OnChainRange } from '../../sdk/pool.ts';

const D = getAddress('0x00000000000000000000000000000000000000d1');
const NAND = getAddress('0x00000000000000000000000000000000000000a1');
const LATCH = getAddress('0x00000000000000000000000000000000000000a2');
const POOL = getAddress('0x00000000000000000000000000000000000000a3');
const ALICE = getAddress('0x00000000000000000000000000000000000a11ce');
const BOB = getAddress('0x0000000000000000000000000000000000000b0b');
const CAROL = getAddress('0x00000000000000000000000000000000000ca401');
const TARGET = { chainId: 56, distributor: D, nandReceipt: NAND, latchReceipt: LATCH };

const range = (category: number, firstId: number, count: number, delivered = 0): OnChainRange =>
  ({ category, firstId: BigInt(firstId), count: BigInt(count), delivered: BigInt(delivered) });

/** The review case on chain: alice NAND 1..90; bob NAND 91..100 and LATCH 1..50; everything still held. */
function chain(overrides: Partial<AllocationState> = {}): AllocationState {
  const wallets = overrides.wallets ?? [{ wallet: ALICE, ranges: [range(0, 1, 90)] }, { wallet: BOB, ranges: [range(0, 91, 10), range(1, 1, 50)] }];
  const delivered = { NAND: 0n, LATCH: 0n };
  const holders = { NAND: Array<Address>(100).fill(D), LATCH: Array<Address>(50).fill(D) };
  for (const w of wallets) for (const r of w.ranges) {
    const c = r.category === 0 ? 'NAND' : 'LATCH';
    delivered[c] += r.delivered;
    for (let i = 0n; i < r.delivered; i++) holders[c][Number(r.firstId + i) - 1] = w.wallet;
  }
  return {
    chainId: 56, blockNumber: 1000n, blockHash: '0x01', distributor: D, pool: POOL,
    distributorReceipts: { NAND, LATCH }, poolReceipts: { NAND, LATCH }, finalized: false,
    totals: { NAND: { inventory: 100n, allocated: 100n, delivered: delivered.NAND }, LATCH: { inventory: 50n, allocated: 50n, delivered: delivered.LATCH } },
    issuance: { NAND: { finalized: true, supply: 100n }, LATCH: { finalized: true, supply: 50n } },
    wallets, holders, ...overrides,
  };
}

const ALICE_ROW = { wallet: ALICE, NAND: [[1, 90]] as [number, number][], LATCH: [] as [number, number][] };
const BOB_ROW = { wallet: BOB, NAND: [[91, 10]] as [number, number][], LATCH: [[1, 50]] as [number, number][] };
const META = { chainId: 56, distributor: D, nandReceipt: NAND, latchReceipt: LATCH, sourceSha256: 'ab'.repeat(32), blockNumber: 1n };
/** An artifact as import-allocation writes it, round-tripped through JSON and runtime validation. */
const artifact = (rows = [ALICE_ROW, BOB_ROW], meta: Partial<typeof META> = {}) =>
  parseAllocationArtifact(JSON.parse(JSON.stringify(allocationArtifact({ ...META, ...meta }, rows), (_, v) => (typeof v === 'bigint' ? v.toString() : v))));

test('a complete, matching artifact is ready before finalization and matches after it', () => {
  const ready = verifyAllocation(artifact(), chain(), TARGET);
  assert.equal(ready.status, 'READY_TO_FINALIZE', JSON.stringify(ready.mismatches));
  assert.deepEqual(ready.verified.ids, { NAND: 100n, LATCH: 50n });
  assert.equal(ready.verified.holdingsChecked, 150);
  assert.equal(verifyAllocation(artifact(), chain({ finalized: true }), TARGET).status, 'FINALIZED_AND_MATCHES');
});

test('review case: an artifact that omits an allocated wallet is a mismatch', () => {
  const r = verifyAllocation(artifact([ALICE_ROW]), chain(), TARGET);
  assert.equal(r.status, 'MISMATCH');
  assert.ok(r.mismatches.some(m => m.includes(`${BOB} is allocated on chain but missing from the artifact`)));
  assert.ok(r.mismatches.some(m => m.includes('artifact totals.NAND 90 is not the 100 allocated on chain')));
});

test('review case: an empty wallet list never verifies a distribution', () => {
  assert.throws(() => parseAllocationArtifact({ wallets: [] }), /Invalid allocation artifact/);
  const empty = artifact([]);
  const before = verifyAllocation(empty, chain(), TARGET);
  assert.equal(before.status, 'MISMATCH');
  assert.ok(before.mismatches.includes('artifact lists no wallets'));
  // After finalization too: FINALIZED_AND_MATCHES needs the artifact to describe the whole allocation.
  assert.equal(verifyAllocation(empty, chain({ finalized: true }), TARGET).status, 'MISMATCH');
});

test('review case: wrong chain, distributor or receipts are mismatches even when wallet rows match', () => {
  const wrongChain = verifyAllocation(artifact(undefined, { chainId: 97 }), chain(), TARGET);
  assert.equal(wrongChain.status, 'MISMATCH');
  assert.ok(wrongChain.mismatches.some(m => m.includes('chainId 97')));
  const other = getAddress('0x00000000000000000000000000000000000000ee');
  assert.equal(verifyAllocation(artifact(undefined, { distributor: other }), chain(), TARGET).status, 'MISMATCH');
  assert.equal(verifyAllocation(artifact(undefined, { nandReceipt: other }), chain(), TARGET).status, 'MISMATCH');
  assert.equal(verifyAllocation(artifact(undefined, { latchReceipt: other }), chain(), TARGET).status, 'MISMATCH');
  // The addresses file and the distributor's own bindings are checked too.
  assert.equal(verifyAllocation(artifact(), chain(), { ...TARGET, chainId: 97 }).status, 'MISMATCH');
  assert.equal(verifyAllocation(artifact(), chain({ distributorReceipts: { NAND: other, LATCH } }), TARGET).status, 'MISMATCH');
  assert.equal(verifyAllocation(artifact(), chain({ poolReceipts: { NAND, LATCH: other } }), TARGET).status, 'MISMATCH');
});

test('ID-level differences are reported in both directions', () => {
  const shifted = { ...BOB_ROW, LATCH: [[2, 49]] as [number, number][] };
  const r = verifyAllocation(artifact([ALICE_ROW, shifted]), chain(), TARGET);
  assert.equal(r.status, 'MISMATCH');
  assert.ok(r.mismatches.some(m => m.includes(`${BOB} LATCH: on-chain IDs missing from the artifact #1`)));
  const swapped = verifyAllocation(artifact([{ ...ALICE_ROW, NAND: [[11, 90]] }, { ...BOB_ROW, NAND: [[1, 10]] }]), chain(), TARGET);
  assert.equal(swapped.status, 'MISMATCH');
  assert.ok(swapped.mismatches.some(m => m.includes(`${ALICE} NAND: artifact IDs not allocated to it on chain #91-100`)));
});

test('an internally inconsistent artifact is a mismatch', () => {
  const a = artifact();
  const bad = { ...a, wallets: [...a.wallets, { ...a.wallets[0] }], totals: { ...a.totals, wallets: 3 } };
  assert.ok(verifyAllocation(bad, chain(), TARGET).mismatches.some(m => m.includes('listed twice')));
  const miscounted = { ...a, wallets: [{ ...a.wallets[0], nand: { count: 89, ranges: a.wallets[0].nand.ranges } }, a.wallets[1]] };
  assert.ok(verifyAllocation(miscounted, chain(), TARGET).mismatches.some(m => m.includes('count 89 but its ranges hold 90')));
  assert.throws(() => parseAllocationArtifact({ ...JSON.parse(JSON.stringify(a)), extra: 1 }), /Invalid allocation artifact/);
});

test('revoked wallets stay listed on chain without ranges and are not part of the allocation', () => {
  // carol was allocated, revoked, and her IDs re-imported for bob (she remains in walletsPage).
  const state = chain({ wallets: [{ wallet: ALICE, ranges: [range(0, 1, 90)] }, { wallet: CAROL, ranges: [] }, { wallet: BOB, ranges: [range(0, 91, 10), range(1, 1, 50)] }] });
  const r = verifyAllocation(artifact(), state, TARGET);
  assert.equal(r.status, 'READY_TO_FINALIZE', JSON.stringify(r.mismatches));
  assert.equal(r.verified.listedWallets, 3);
  assert.equal(r.verified.wallets, 2);
  assert.equal(verifyAllocation(artifact([ALICE_ROW, BOB_ROW, { wallet: CAROL, NAND: [], LATCH: [[1, 1]] }]), state, TARGET).status, 'MISMATCH');
});

test('verification stays meaningful after partial and complete delivery', () => {
  // alice took 40 of her NAND, bob all of his; receipts may since have moved on to anyone.
  const delivered = chain({ finalized: true, wallets: [{ wallet: ALICE, ranges: [range(0, 1, 90, 40)] }, { wallet: BOB, ranges: [range(0, 91, 10, 10), range(1, 1, 50, 50)] }] });
  (delivered.holders.NAND as Address[])[0] = CAROL; // alice transferred NAND #1 onward
  const r = verifyAllocation(artifact(), delivered, TARGET);
  assert.equal(r.status, 'FINALIZED_AND_MATCHES', JSON.stringify(r.mismatches));
  assert.deepEqual(r.verified.delivered, { NAND: 50n, LATCH: 50n });
  // An undelivered ID that has left the distributor, or a delivered one still in it, is reported.
  const leaked = chain({ finalized: true, wallets: delivered.wallets });
  (leaked.holders.NAND as Address[])[60] = CAROL;
  assert.ok(verifyAllocation(artifact(), leaked, TARGET).mismatches.some(m => m.includes('NAND #61 is undelivered but held by')));
  const stuck = chain({ finalized: true, wallets: delivered.wallets });
  (stuck.holders.NAND as Address[])[0] = D;
  assert.ok(verifyAllocation(artifact(), stuck, TARGET).mismatches.some(m => m.includes('NAND #1 is recorded as delivered')));
  // Totals that disagree with the ranges are reported as well.
  const counter = chain({ finalized: true, wallets: delivered.wallets });
  counter.totals.NAND.delivered = 49n;
  assert.ok(verifyAllocation(artifact(), counter, TARGET).mismatches.some(m => m.includes('record 50 delivered but the distributor reports 49')));
});

test('a matching artifact is not ready while finalization would fail', () => {
  const unfinalized = chain({ issuance: { NAND: { finalized: false, supply: 100n }, LATCH: { finalized: true, supply: 50n } } });
  const r = verifyAllocation(artifact(), unfinalized, TARGET);
  assert.equal(r.status, 'NOT_READY');
  assert.deepEqual(r.readinessGaps, ['NAND issuance is not finalized']);
  const uncovered = chain();
  uncovered.totals.LATCH.inventory = 51n;
  assert.equal(verifyAllocation(artifact(), uncovered, TARGET).status, 'NOT_READY');
});
