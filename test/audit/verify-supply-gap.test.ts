/**
 * Internal security review (f2c8e50), workstream B, tooling finding T-3: `verifyAllocation` compared the
 * artifact with the distributor only. Receipts that were issued but never moved into the distributor
 * (still held by the issuer or anyone else) were outside the allocation, kept their full entitlement,
 * and were invisible to the verification result: at f2c8e50 this fixture returned READY_TO_FINALIZE with
 * no readiness gap and no supply figure although inventory < supply.
 *
 * Updated with the remediation (docs/AUDIT_REMEDIATION_REPORT.md), as this review's README anticipated:
 * the default full-round verification now reports supply coverage and is NOT_READY; retaining receipts
 * must be selected explicitly (mode 'partial') and is labelled PARTIAL with the retained IDs and holders.
 * Run: node --import tsx --test test/audit/verify-supply-gap.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, type Address } from 'viem';
import { allocationArtifact } from '../../sdk/allocation.ts';
import { LATCH_CATEGORY, NAND_CATEGORY } from '../../sdk/config.ts';
import { parseAllocationArtifact, verifyAllocation, type AllocationState } from '../../sdk/verify.ts';
import type { OnChainRange } from '../../sdk/pool.ts';

const D = getAddress('0x00000000000000000000000000000000000000d1');
const NAND = getAddress('0x00000000000000000000000000000000000000a1');
const LATCH = getAddress('0x00000000000000000000000000000000000000a2');
const POOL = getAddress('0x00000000000000000000000000000000000000a3');
const REGULAR = getAddress('0x00000000000000000000000000000000000000a5'); // 2.3.0: the distributor's second pool
const ISSUER = getAddress('0x0000000000000000000000000000000000001555');
const ALICE = getAddress('0x00000000000000000000000000000000000a11ce');
const TARGET = { chainId: 56, distributor: D, optimalPool: POOL, regularPool: REGULAR, nandReceipt: NAND, latchReceipt: LATCH };
const range = (category: number, firstId: number, count: number): OnChainRange => ({ category, firstId: BigInt(firstId), count: BigInt(count), delivered: 0n });

test('receipts retained outside the distributor are reported and block an unqualified full round', () => {
  // Supply is 100 NAND, but only 90 were funded into the distributor; the issuer kept #91-100.
  const holders = { NAND: [...Array<Address>(90).fill(D), ...Array<Address>(10).fill(ISSUER)], LATCH: [] as Address[] };
  const state: AllocationState = {
    chainId: 56, blockNumber: 1000n, blockHash: '0x01', distributor: D, pools: { optimal: POOL, regular: REGULAR },
    distributorReceipts: { NAND, LATCH }, poolReceipts: { optimal: { NAND, LATCH }, regular: { NAND, LATCH } }, receiptCategories: { NAND: NAND_CATEGORY, LATCH: LATCH_CATEGORY }, finalized: false,
    totals: { NAND: { inventory: 90n, allocated: 90n, delivered: 0n }, LATCH: { inventory: 0n, allocated: 0n, delivered: 0n } },
    issuance: { NAND: { finalized: true, supply: 100n }, LATCH: { finalized: true, supply: 0n } },
    wallets: [{ wallet: ALICE, ranges: [range(0, 1, 90)] }], holders,
  };
  const meta = { chainId: 56, distributor: D, nandReceipt: NAND, latchReceipt: LATCH, sourceSha256: 'ab'.repeat(32), blockNumber: 1n };
  const artifact = parseAllocationArtifact(JSON.parse(JSON.stringify(allocationArtifact(meta, [{ wallet: ALICE, NAND: [[1, 90]], LATCH: [] }]), (_, v) => (typeof v === 'bigint' ? v.toString() : v))));
  const result = verifyAllocation(artifact, state, TARGET);
  // Remediated behaviour: a readiness gap and the supply coverage, with the retained IDs and holder.
  assert.equal(result.status, 'NOT_READY');
  assert.ok(result.readinessGaps.some(g => g.startsWith('NAND: 10 of 100 issued receipts never entered the distributor (#91-100)')));
  assert.equal(result.coverage.NAND.supply, 100n);
  assert.deepEqual(result.coverage.NAND.excluded.holders, [{ holder: ISSUER, count: 10 }]);
  const retained = Number(state.issuance.NAND.supply - state.totals.NAND.inventory);
  assert.equal(retained, 10);
  // Only an explicitly partial verification accepts it, and says so.
  assert.equal(verifyAllocation(artifact, state, TARGET, { mode: 'partial' }).status, 'READY_TO_FINALIZE_PARTIAL');
});
