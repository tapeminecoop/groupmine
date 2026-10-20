import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, type Abi } from 'viem';
import { tapeoutMinerPoolAbi } from '../../sdk/abi.ts';
import { BATCH_GAS_BUDGET } from '../../sdk/constants.ts';
import {
  CLAIM_GAS, DELIVER_GAS, HARVEST_GAS, ISSUE_GAS, admissionGasEstimate, assertWithinBudget, checkBatchSize, deliveryGas, groupForSafe,
  maxDeliverable, maxIdsPerTx, revokeGas,
} from '../../sdk/gas.ts';
import { claimPlans, depositPlans, harvestRangePlans, issuePlans, releasePlans } from '../../sdk/pool.ts';
import { castCommand, type TxPlan } from '../../sdk/tx.ts';

const A = '0x00000000000000000000000000000000000000aa' as const;
const plan = (gas?: bigint): TxPlan => ({ to: A, data: '0x', value: 0n, description: `plan ${gas ?? 'unbounded'}`, ...(gas !== undefined ? { gas } : {}) });

test('every plan carries a bound, and the bound is the printed gas limit', () => {
  const issue = issuePlans(A, 'NAND', A, 500);
  assert.deepEqual(issue.map(p => p.gas), [ISSUE_GAS.base + 231n * ISSUE_GAS.perId, ISSUE_GAS.base + 231n * ISSUE_GAS.perId, ISSUE_GAS.base + 38n * ISSUE_GAS.perId]);
  assert.ok(issue.every(p => p.gas! <= BATCH_GAS_BUDGET));
  assert.match(castCommand(issue[0]), new RegExp(` --gas-limit ${issue[0].gas} 0x`));
  assert.doesNotMatch(castCommand(plan()), /--gas-limit/);
  assert.equal(claimPlans(A, [1n, 2n, 3n], [], 2)[1].gas, CLAIM_GAS.base + CLAIM_GAS.perId);
  assert.ok(releasePlans(A).every(p => p.gas !== undefined));
});

test('admission bounds grow with the miners each batch must settle first', () => {
  const plans = depositPlans(A, [1n, 2n, 3n, 4n, 5n], 2, 10n);
  assert.deepEqual(plans.map(p => p.gas), [admissionGasEstimate(10n, 2n), admissionGasEstimate(12n, 2n), admissionGasEstimate(14n, 1n)]);
  assert.deepEqual(decodeFunctionData({ abi: tapeoutMinerPoolAbi as Abi, data: plans[2].data }).args, [[5n]]);
  // The last harvestRange batch is bounded by the miners it can actually reach.
  const harvest = harvestRangePlans(A, 250n, 100);
  assert.deepEqual(harvest.map(p => p.gas), [HARVEST_GAS.base + 100n * HARVEST_GAS.perId, HARVEST_GAS.base + 100n * HARVEST_GAS.perId, HARVEST_GAS.base + 50n * HARVEST_GAS.perId]);
});

test('plans over the budget are refused and oversize batch sizes rejected', () => {
  assert.doesNotThrow(() => assertWithinBudget([plan(BATCH_GAS_BUDGET), plan()]));
  assert.throws(() => assertWithinBudget([plan(BATCH_GAS_BUDGET + 1n)]), /BEP-652/);
  assert.equal(checkBatchSize('claim', maxIdsPerTx(CLAIM_GAS), maxIdsPerTx(CLAIM_GAS)), 386);
  assert.throws(() => checkBatchSize('claim', 387, maxIdsPerTx(CLAIM_GAS)), /--batch-size 387 is above 386/);
});

test('Safe batches are split so each file fits one transaction', () => {
  const five = 5_000_000n;
  const groups = groupForSafe([plan(five), plan(five), plan(five), plan(), plan(1n)]);
  assert.deepEqual(groups.map(g => g.map(p => p.gas)), [[five, five], [five], [undefined], [1n]]);
  assert.ok(groups.every(g => g.reduce((s, p) => s + (p.gas ?? BATCH_GAS_BUDGET), 0n) <= BATCH_GAS_BUDGET));
});

test('delivery and revocation bounds follow the wallet ranges', () => {
  const ranges = [{ count: 10n, delivered: 10n }, { count: 5n, delivered: 2n }, { count: 400n, delivered: 0n }];
  // Only the ranges the call reaches count: 3 left in the second, then 97 from the third.
  assert.equal(deliveryGas(ranges, 100), DELIVER_GAS.base + 2n * DELIVER_GAS.perRange + 100n * DELIVER_GAS.perId);
  const fits = maxDeliverable(ranges);
  assert.ok(deliveryGas(ranges, fits) <= BATCH_GAS_BUDGET && deliveryGas(ranges, fits + 1) > BATCH_GAS_BUDGET);
  assert.equal(maxDeliverable([{ count: 3n, delivered: 3n }]), 0);
  assert.equal(revokeGas([{ count: 1000n }, { count: 500n }]), 100_000n + 2n * 30_000n + 1500n * 8_000n);
  assert.ok(revokeGas([{ count: 1000n }, { count: 500n }]) <= BATCH_GAS_BUDGET);
});
