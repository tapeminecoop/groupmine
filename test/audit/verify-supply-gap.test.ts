/**
 * Internal security review (f2c8e50), workstream B, tooling finding: `verifyAllocation` compares the
 * artifact with the distributor only. Receipts that were issued but never moved into the distributor
 * (still held by the issuer or anyone else) are outside the allocation, keep their full entitlement,
 * and are invisible to the verification result: READY_TO_FINALIZE / FINALIZED_AND_MATCHES is reported
 * although inventory < supply. The distributor contract itself only requires allocated == inventory.
 * Run: node --import tsx --test test/audit/verify-supply-gap.test.ts
 */
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
const ISSUER = getAddress('0x0000000000000000000000000000000000001555');
const ALICE = getAddress('0x00000000000000000000000000000000000a11ce');
const TARGET = { chainId: 56, distributor: D, nandReceipt: NAND, latchReceipt: LATCH };
const range = (category: number, firstId: number, count: number): OnChainRange => ({ category, firstId: BigInt(firstId), count: BigInt(count), delivered: 0n });

test('receipts retained outside the distributor pass verification unseen', () => {
  // Supply is 100 NAND, but only 90 were funded into the distributor; the issuer kept #91-100.
  const holders = { NAND: [...Array<Address>(90).fill(D), ...Array<Address>(10).fill(ISSUER)], LATCH: [] as Address[] };
  const state: AllocationState = {
    chainId: 56, blockNumber: 1000n, blockHash: '0x01', distributor: D, pool: POOL,
    distributorReceipts: { NAND, LATCH }, poolReceipts: { NAND, LATCH }, finalized: false,
    totals: { NAND: { inventory: 90n, allocated: 90n, delivered: 0n }, LATCH: { inventory: 0n, allocated: 0n, delivered: 0n } },
    issuance: { NAND: { finalized: true, supply: 100n }, LATCH: { finalized: true, supply: 0n } },
    wallets: [{ wallet: ALICE, ranges: [range(0, 1, 90)] }], holders,
  };
  const meta = { chainId: 56, distributor: D, nandReceipt: NAND, latchReceipt: LATCH, sourceSha256: 'ab'.repeat(32), blockNumber: 1n };
  const artifact = parseAllocationArtifact(JSON.parse(JSON.stringify(allocationArtifact(meta, [{ wallet: ALICE, NAND: [[1, 90]], LATCH: [] }]), (_, v) => (typeof v === 'bigint' ? v.toString() : v))));
  const result = verifyAllocation(artifact, state, TARGET);
  // Current behaviour (documents the gap): the 10 retained receipts are not reported anywhere.
  assert.equal(result.status, 'READY_TO_FINALIZE');
  assert.deepEqual(result.readinessGaps, []);
  assert.equal('supply' in result.verified, false, 'the supply is not part of the result');
  // Proposed behaviour: a readiness gap (or at least a reported count) for inventory < supply.
  const retained = Number(state.issuance.NAND.supply - state.totals.NAND.inventory);
  assert.equal(retained, 10);
});
