import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, type Address } from 'viem';
import { allocationArtifact, type AllocationFile } from '../../sdk/allocation.ts';
import { LATCH_CATEGORY, NAND_CATEGORY } from '../../sdk/config.ts';
import { inventoryRecordFor, parseAllocationArtifact, verifyAllocation, type AllocationState } from '../../sdk/verify.ts';
import type { OnChainRange } from '../../sdk/pool.ts';

const D = getAddress('0x00000000000000000000000000000000000000d1');
const NAND = getAddress('0x00000000000000000000000000000000000000a1');
const LATCH = getAddress('0x00000000000000000000000000000000000000a2');
const POOL = getAddress('0x00000000000000000000000000000000000000a3');
const POOL_Q = getAddress('0x00000000000000000000000000000000000000a4');
const ISSUER = getAddress('0x0000000000000000000000000000000000001555');
const ALICE = getAddress('0x00000000000000000000000000000000000a11ce');
const BOB = getAddress('0x0000000000000000000000000000000000000b0b');
const CAROL = getAddress('0x00000000000000000000000000000000000ca401');
const TARGET = { chainId: 56, distributor: D, pool: POOL, nandReceipt: NAND, latchReceipt: LATCH };
const ids = (first: number, count: number) => Array.from({ length: count }, (_, i) => first + i);

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
    distributorReceipts: { NAND, LATCH }, poolReceipts: { NAND, LATCH }, receiptCategories: { NAND: NAND_CATEGORY, LATCH: LATCH_CATEGORY }, finalized: false,
    totals: { NAND: { inventory: 100n, allocated: 100n, delivered: delivered.NAND }, LATCH: { inventory: 50n, allocated: 50n, delivered: delivered.LATCH } },
    issuance: { NAND: { finalized: true, supply: 100n }, LATCH: { finalized: true, supply: 50n } },
    wallets, holders, ...overrides,
  };
}

const ALICE_ROW = { wallet: ALICE, NAND: [[1, 90]] as [number, number][], LATCH: [] as [number, number][] };
const BOB_ROW = { wallet: BOB, NAND: [[91, 10]] as [number, number][], LATCH: [[1, 50]] as [number, number][] };
const SHA = 'ab'.repeat(32);
const META = { chainId: 56, distributor: D, nandReceipt: NAND, latchReceipt: LATCH, sourceSha256: SHA, blockNumber: 1n };
const INVENTORY = inventoryRecordFor({ NAND: ids(1, 100), LATCH: ids(1, 50) }, 1n, `0x${'11'.repeat(32)}`);
const roundTrip = (v: unknown) => parseAllocationArtifact(JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))));
/** An artifact as import-allocation writes it, round-tripped through JSON and runtime validation
 *  (`inventory: null` for an artifact written before inventory provenance existed). */
const artifact = (rows = [ALICE_ROW, BOB_ROW], meta: Partial<typeof META> = {}, inventory: typeof INVENTORY | null = INVENTORY) =>
  roundTrip(allocationArtifact({ ...META, ...meta }, rows, inventory ?? undefined));
/** The reviewed allocation JSON that produced ALICE_ROW, BOB_ROW (file order = assignment order). */
const REVIEWED: AllocationFile = { allocations: [{ wallet: ALICE, nandCount: 90, latchCount: 0 }, { wallet: BOB, nandCount: 10, latchCount: 50 }] };
const review = (file: AllocationFile = REVIEWED, sha256 = SHA) => ({ file, sha256 });

test('a complete, matching artifact is ready before finalization and matches after it', () => {
  const ready = verifyAllocation(artifact(), chain(), TARGET);
  assert.equal(ready.status, 'READY_TO_FINALIZE', JSON.stringify(ready.mismatches));
  assert.deepEqual(ready.verified.ids, { NAND: 100n, LATCH: 50n });
  assert.equal(ready.verified.holdingsChecked, 150);
  assert.equal(ready.mode, 'full-round');
  assert.deepEqual(ready.identity.pool, { expected: POOL, distributorPool: POOL });
  assert.equal(ready.blockHash, '0x01');
  assert.equal(verifyAllocation(artifact(), chain({ finalized: true }), TARGET).status, 'FINALIZED_AND_MATCHES');
});

test('review T-01: a distributor of pool P does not verify against a configuration naming pool Q', () => {
  // Valid pools P and Q can share the same receipts; the distributor belongs to P (distributor.pool()),
  // the addresses file names Q. Every wallet and ID matches, so only the pool comparison catches it.
  const r = verifyAllocation(artifact(), chain({ pool: POOL, poolReceipts: { NAND, LATCH } }), { ...TARGET, pool: POOL_Q });
  assert.equal(r.status, 'MISMATCH');
  assert.deepEqual(r.mismatches, [`configured pool ${POOL_Q} is not the distributor's pool ${POOL}`]);
  assert.deepEqual(r.identity.pool, { expected: POOL_Q, distributorPool: POOL });
  // The configured distributor is compared with the one actually read, and receipt categories are checked.
  const other = getAddress('0x00000000000000000000000000000000000000ee');
  assert.ok(verifyAllocation(artifact(), chain({ distributor: other }), TARGET).mismatches.some(m => m.includes(`configured distributor ${D} is not the one read`)));
  const swappedCategories = verifyAllocation(artifact(), chain({ receiptCategories: { NAND: LATCH_CATEGORY, LATCH: LATCH_CATEGORY } }), TARGET);
  assert.ok(swappedCategories.mismatches.some(m => m.includes('reports category')));
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
  const r = verifyAllocation(artifact(), state, TARGET, { review: review() });
  assert.equal(r.status, 'READY_TO_FINALIZE', JSON.stringify(r.mismatches));
  assert.equal(r.verified.listedWallets, 3);
  assert.equal(r.verified.wallets, 2);
  assert.equal(r.review.status, 'VERIFIED');
  assert.equal(verifyAllocation(artifact([ALICE_ROW, BOB_ROW, { wallet: CAROL, NAND: [], LATCH: [[1, 1]] }]), state, TARGET).status, 'MISMATCH');
});

test('verification stays meaningful after partial and complete delivery and later transfers', () => {
  // alice took 40 of her NAND, bob all of his; receipts may since have moved on to anyone.
  const delivered = chain({ finalized: true, wallets: [{ wallet: ALICE, ranges: [range(0, 1, 90, 40)] }, { wallet: BOB, ranges: [range(0, 91, 10, 10), range(1, 1, 50, 50)] }] });
  (delivered.holders.NAND as Address[])[0] = CAROL; // alice transferred NAND #1 onward
  const r = verifyAllocation(artifact(), delivered, TARGET, { review: review() });
  assert.equal(r.status, 'FINALIZED_AND_MATCHES', JSON.stringify(r.mismatches));
  assert.deepEqual(r.verified.delivered, { NAND: 50n, LATCH: 50n });
  // Coverage after delivery compares cumulative accepted inventory with delivered/undelivered records,
  // never the distributor's current balance with the supply.
  assert.deepEqual([r.coverage.NAND.acceptedInventory, r.coverage.NAND.assigned, r.coverage.NAND.delivered, r.coverage.NAND.undelivered], [100n, 100n, 50n, 50n]);
  assert.equal(r.coverage.NAND.excluded.count, 0);
  // The reviewed JSON is still tied to the artifact: the recorded inventory is reproduced from the ranges.
  assert.equal(r.review.status, 'VERIFIED');
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
  // An accepted LATCH receipt (#51, held by the distributor) that nobody is assigned.
  const uncovered = chain({ issuance: { NAND: { finalized: true, supply: 100n }, LATCH: { finalized: true, supply: 51n } } });
  (uncovered.holders.LATCH as Address[]).push(D);
  uncovered.totals.LATCH.inventory = 51n;
  const u = verifyAllocation(artifact(), uncovered, TARGET);
  assert.equal(u.status, 'NOT_READY', JSON.stringify(u.mismatches));
  assert.ok(u.readinessGaps.includes('LATCH: 50 assigned of 51 accepted'));
  assert.equal(u.coverage.LATCH.unassignedInventory, 1n);
  // An inventory counter that the visible IDs cannot explain is a mismatch.
  const inconsistent = chain();
  inconsistent.totals.LATCH.inventory = 51n;
  assert.ok(verifyAllocation(artifact(), inconsistent, TARGET).mismatches.some(m => m.includes('reports 51 accepted receipts but 50 are allocated or held by it')));
});

test('review T-3: 90 of 100 issued receipts funded and assigned is not a ready full round', () => {
  // Supply 100 NAND; the issuer kept #91-100, only 90 entered the distributor and were assigned.
  const holders = { NAND: [...Array<Address>(90).fill(D), ...Array<Address>(10).fill(ISSUER)], LATCH: [] as Address[] };
  const state = chain({
    wallets: [{ wallet: ALICE, ranges: [range(0, 1, 90)] }], holders,
    totals: { NAND: { inventory: 90n, allocated: 90n, delivered: 0n }, LATCH: { inventory: 0n, allocated: 0n, delivered: 0n } },
    issuance: { NAND: { finalized: true, supply: 100n }, LATCH: { finalized: true, supply: 0n } },
  });
  const rows = [{ wallet: ALICE, NAND: [[1, 90]] as [number, number][], LATCH: [] as [number, number][] }];
  const inv = inventoryRecordFor({ NAND: ids(1, 90), LATCH: [] }, 1n, `0x${'11'.repeat(32)}`);
  const full = verifyAllocation(artifact(rows, {}, inv), state, TARGET);
  assert.equal(full.status, 'NOT_READY');
  assert.ok(full.readinessGaps.some(g => g.startsWith('NAND: 10 of 100 issued receipts never entered the distributor (#91-100)')));
  assert.deepEqual(full.coverage.NAND.excluded, { count: 10, ids: '#91-100', holders: [{ holder: ISSUER, count: 10 }] });
  assert.deepEqual([full.coverage.NAND.supply, full.coverage.NAND.acceptedInventory, full.coverage.NAND.assigned], [100n, 90n, 90n]);
  // Retention must be selected explicitly, and every positive status then says PARTIAL.
  const partial = verifyAllocation(artifact(rows, {}, inv), state, TARGET, { mode: 'partial' });
  assert.equal(partial.status, 'READY_TO_FINALIZE_PARTIAL');
  assert.equal(partial.coverage.NAND.excluded.count, 10);
  // A distributor finalized like this never verifies as a complete round.
  assert.equal(verifyAllocation(artifact(rows, {}, inv), { ...state, finalized: true }, TARGET).status, 'FINALIZED_INCOMPLETE_COVERAGE');
  assert.equal(verifyAllocation(artifact(rows, {}, inv), { ...state, finalized: true }, TARGET, { mode: 'partial' }).status, 'FINALIZED_PARTIAL_AND_MATCHES');
});

test('review T-5: the reviewed JSON is tied to the artifact by hash, counts and the deterministic assignment', () => {
  const ok = verifyAllocation(artifact(), chain(), TARGET, { review: review() });
  assert.equal(ok.status, 'READY_TO_FINALIZE', JSON.stringify(ok.mismatches));
  assert.equal(ok.review.status, 'VERIFIED');
  assert.equal(ok.review.assignment.status, 'VERIFIED');
  assert.match(ok.review.assignment.inventorySource!, /recorded inventory/);
  // Another file (hash) than the one the artifact records.
  const wrongHash = verifyAllocation(artifact(), chain(), TARGET, { review: review(REVIEWED, 'cd'.repeat(32)) });
  assert.equal(wrongHash.status, 'MISMATCH');
  assert.ok(wrongHash.mismatches.some(m => m.includes('is not the artifact\'s sourceSha256')));
  // Different counts for a beneficiary; a wallet the artifact lacks; a wallet the file lacks.
  const counts: AllocationFile = { allocations: [{ wallet: ALICE, nandCount: 89, latchCount: 1 }, { wallet: BOB, nandCount: 11, latchCount: 49 }] };
  assert.ok(verifyAllocation(artifact(), chain(), TARGET, { review: review(counts) }).mismatches.some(m => m.includes('reviewed 89 NAND / 1 LATCH')));
  const extra: AllocationFile = { allocations: [...REVIEWED.allocations, { wallet: CAROL, nandCount: 1, latchCount: 0 }] };
  assert.ok(verifyAllocation(artifact(), chain(), TARGET, { review: review(extra) }).mismatches.some(m => m.includes(`lists ${CAROL}, which is not in the artifact`)));
  const missing: AllocationFile = { allocations: [REVIEWED.allocations[0]] };
  assert.ok(verifyAllocation(artifact(), chain(), TARGET, { review: review(missing) }).mismatches.some(m => m.includes(`assigns ${BOB}, which the reviewed allocation does not list`)));
  // Same counts, but the artifact (and the chain) do not follow the file order: bob first.
  const reordered: AllocationFile = { allocations: [REVIEWED.allocations[1], REVIEWED.allocations[0]] };
  const notDeterministic = verifyAllocation(artifact(), chain(), TARGET, { review: review(reordered) });
  assert.equal(notDeterministic.review.assignment.status, 'MISMATCH');
  assert.ok(notDeterministic.mismatches.some(m => m.includes('not the deterministic assignment of the reviewed allocation')));
  // A duplicate wallet in the file is rejected as the import would reject it.
  const dup: AllocationFile = { allocations: [REVIEWED.allocations[0], REVIEWED.allocations[0]] };
  assert.equal(verifyAllocation(artifact(), chain(), TARGET, { review: review(dup) }).review.status, 'MISMATCH');
});

test('review T-5: without inventory provenance the assignment is UNVERIFIED, never certified from today\'s state', () => {
  // An older artifact without a recorded inventory, and no historical state: what was verified is
  // reported, the assignment is not, and the allocation is not ready to finalize.
  const legacy = verifyAllocation(artifact(undefined, {}, null), chain(), TARGET, { review: review(), historicalInventory: 'unavailable' });
  assert.equal(legacy.review.status, 'UNVERIFIED');
  assert.equal(legacy.review.assignment.status, 'UNVERIFIED');
  assert.equal(legacy.status, 'NOT_READY');
  assert.equal(legacy.review.sha256!.matches, true);
  // The historical inventory at the artifact's block (read by the caller) verifies it.
  const historical = verifyAllocation(artifact(undefined, {}, null), chain(), TARGET, { review: review(), historicalInventory: { NAND: ids(1, 100), LATCH: ids(1, 50) } });
  assert.equal(historical.review.status, 'VERIFIED');
  assert.match(historical.review.assignment.inventorySource!, /historical distributor holdings/);
  // A recorded inventory the current state cannot reproduce (another ID set) is not silently replaced.
  const other = inventoryRecordFor({ NAND: ids(2, 100), LATCH: ids(1, 50) }, 1n, `0x${'11'.repeat(32)}`);
  const stale = verifyAllocation(artifact(undefined, {}, other), chain(), TARGET, { review: review(), historicalInventory: 'unavailable' });
  assert.equal(stale.review.assignment.status, 'UNVERIFIED');
});
