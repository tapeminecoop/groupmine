import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, getAddress, type Abi } from 'viem';
import { tapeoutMinerPoolAbi, tapeoutReceiptDistributorAbi } from '../../sdk/abi.ts';
import { BATCH_GAS_BUDGET, TX_GAS_CAP } from '../../sdk/constants.ts';
import {
  CLAIM_GAS, DELIVER_GAS, HARVEST_GAS, ISSUE_GAS, SAFE_EXEC_GAS, admissionGasEstimate, assertWithinBudget, checkBatchSize, deliveryBatches, deliveryGas,
  groupForSafe, maxDeliverable, maxIdsPerTx, revokeGas, safeBatchGas, safePayloadBytes,
} from '../../sdk/gas.ts';
import { claimPlans, deliveryPlans, depositPlans, harvestRangePlans, issuePlans, releasePlans } from '../../sdk/pool.ts';
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

test('Safe batches are split so each file fits one transaction, the Safe overhead included', () => {
  const five = 5_000_000n;
  const groups = groupForSafe([plan(five), plan(five), plan(five), plan(), plan(1n)]);
  assert.deepEqual(groups.map(g => g.map(p => p.gas)), [[five, five], [five], [undefined], [1n]]);
  assert.equal(safeBatchGas([plan(five), plan(five)]), 2n * five + SAFE_EXEC_GAS.base + 170n * SAFE_EXEC_GAS.perPayloadByte + (2n * five) / 30n);
  assert.ok(groups.filter(g => g.length > 1).every(g => safeBatchGas(g) <= BATCH_GAS_BUDGET));
  // Two plans whose bounds alone fit the budget are split once the Safe's work is added.
  const six = 6_200_000n;
  assert.ok(2n * six <= BATCH_GAS_BUDGET);
  assert.deepEqual(groupForSafe([plan(six), plan(six)]).map(g => g.length), [1, 1]);
  // The payload counts: the Safe hashes and copies it, and SafeL2 logs it.
  const big = (gas: bigint): TxPlan => ({ ...plan(gas), data: `0x${'ab'.repeat(40_000)}` });
  assert.equal(safePayloadBytes([big(1n)]), 40_085);
  assert.deepEqual(groupForSafe([big(5_500_000n), big(5_500_000n)]).map(g => g.length), [1, 1]);
  // A plan at the budget goes alone and stays under the cap; one whose Safe bound would not is refused.
  assert.ok(safeBatchGas([plan(BATCH_GAS_BUDGET)]) > BATCH_GAS_BUDGET && safeBatchGas([plan(BATCH_GAS_BUDGET)]) <= TX_GAS_CAP);
  assert.deepEqual(groupForSafe([plan(BATCH_GAS_BUDGET), plan(1n)]).map(g => g.length), [1, 1]);
  assert.throws(() => groupForSafe([{ ...plan(12_500_000n), data: `0x${'ab'.repeat(250_000)}` }]), /through a Safe may need up to \d+ gas, above the BSC per-transaction cap/);
});

test('a fragmented wallet is delivered in planned steps whose bounds ignore completed ranges', () => {
  // The review case: 183 single-ID ranges. The distributor resumes at its range cursor, so the final
  // one-ID delivery is bounded like any single-range delivery (checked on the EVM in GasModelTest).
  const ranges = Array.from({ length: 183 }, (_, i) => ({ category: 0, firstId: BigInt(i + 1), count: 1n, delivered: 0n }));
  assert.deepEqual(deliveryBatches(ranges, 300), [
    { maxIds: 91, gas: 12_567_000n }, { maxIds: 91, gas: 12_567_000n }, { maxIds: 1, gas: 237_000n },
  ]);
  const plans = deliveryPlans(A, A, ranges, 300, true);
  assert.deepEqual(plans.map(p => p.gas), [12_567_000n, 12_567_000n, 237_000n]);
  assert.deepEqual(decodeFunctionData({ abi: tapeoutReceiptDistributorAbi as Abi, data: plans[2].data }).args, [getAddress(A), 1n]);
  assert.equal(decodeFunctionData({ abi: tapeoutReceiptDistributorAbi as Abi, data: deliveryPlans(A, A, ranges, 300, false)[0].data }).functionName, 'claim');
  // A partly delivered range: the next delivery starts inside it, and --max-ids caps each step.
  const partial = [{ count: 5n, delivered: 5n }, { count: 10n, delivered: 4n }, { count: 3n, delivered: 0n }];
  assert.deepEqual(deliveryBatches(partial, 4).map(b => b.maxIds), [4, 4, 1]);
  assert.equal(deliveryBatches(partial, 100)[0].gas, DELIVER_GAS.base + 2n * DELIVER_GAS.perRange + 9n * DELIVER_GAS.perId);
});

test('maxDeliverable matches a step-by-step search', () => {
  const slow = (r: { count: bigint; delivered: bigint }[]) => {
    const pending = r.reduce((s, x) => s + Number(x.count - x.delivered), 0);
    let n = 0;
    while (n < pending && deliveryGas(r, n + 1) <= BATCH_GAS_BUDGET) n++;
    return n;
  };
  let seed = 7;
  const rand = (m: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % m; };
  for (let t = 0; t < 40; t++) {
    const r = Array.from({ length: 1 + rand(120) }, () => { const count = BigInt(1 + rand(12)); return { count, delivered: BigInt(rand(Number(count) + 1)) }; });
    assert.equal(maxDeliverable(r), slow(r));
  }
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
