import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, getAddress, type Abi } from 'viem';
import { tapeoutMinerPoolAbi, tapeoutReceiptDistributorAbi } from '../../sdk/abi.ts';
import { BATCH_GAS_BUDGET, TX_GAS_CAP } from '../../sdk/constants.ts';
import {
  CLAIM_GAS, DELIVER_GAS, HARVEST_GAS, ISSUE_GAS, SAFE_EXEC_GAS, admissionGasEstimate, assertWithinBudget, checkBatchSize, deliveryBatches, deliveryGas,
  groupForSafe, maxDeliverable, maxIdsPerTx, maxSafeDeliverable, reachableDeliveryGas, revokeGas, safeBatchGas, safePayloadBytes, worstReachableRanges,
} from '../../sdk/gas.ts';
import { canonicalClaimIds, claimPlans, deliveryPlans, depositPlans, harvestRangePlans, issuePlans, releasePlans } from '../../sdk/pool.ts';
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

/** Brute force: deliver `m` IDs starting at every pending offset the cursor can reach (others may have
 *  delivered any prefix first), emulating the distributor's range loop; returns the worst cost. */
function worstOverReachableStarts(ranges: { count: bigint; delivered: bigint }[], m: number) {
  const runs = ranges.map(r => Number(r.count - r.delivered)).filter(n => n > 0);
  const total = runs.reduce((s, n) => s + n, 0);
  let worst = { maxTouched: 0, gas: 0n };
  for (let k = 0; k < total; k++) {
    let skip = k, left = Math.min(m, total - k), touched = 0, taken = 0;
    for (const n of runs) {
      if (skip >= n) { skip -= n; continue; }
      if (left === 0) break;
      const take = Math.min(n - skip, left);
      touched++; taken += take; left -= take; skip = 0;
    }
    const gas = DELIVER_GAS.base + DELIVER_GAS.perId * BigInt(taken) + DELIVER_GAS.perRange * BigInt(touched);
    worst = { maxTouched: Math.max(worst.maxTouched, touched), gas: gas > worst.gas ? gas : worst.gas };
  }
  return worst;
}

test('review T-02: a delivery planned for one cursor still fits when others deliver first', () => {
  // One wallet: IDs 1..300 in one range, then 300 single-ID ranges (301..600).
  const wallet = [{ count: 300n, delivered: 0n }, ...Array.from({ length: 300 }, () => ({ count: 1n, delivered: 0n }))];
  // The snapshot-only cost the previous planner used: 300 IDs in one range, 11,300,000 gas. If a keeper
  // delivers that range first, the same call walks 300 single-ID ranges (model bound 41,200,000).
  assert.equal(deliveryGas(wallet, 300), 11_300_000n);
  assert.equal(reachableDeliveryGas(wallet, 300), 41_200_000n);
  // Every emitted call is bounded for any reachable cursor position, and stays within the budget.
  const batches = deliveryBatches(wallet, 300);
  assert.deepEqual(batches.map(b => b.maxIds), [91, 91, 91, 91, 91, 91, 54]);
  assert.deepEqual(batches.map(b => b.gas), [...Array(6).fill(12_567_000n), DELIVER_GAS.base + 54n * (DELIVER_GAS.perId + DELIVER_GAS.perRange)]);
  for (const b of batches) {
    assert.ok(b.gas <= BATCH_GAS_BUDGET);
    assert.equal(worstOverReachableStarts(wallet, b.maxIds).gas, b.gas);
  }
  assert.equal(maxSafeDeliverable(wallet), 91);
  // A contiguous wallet keeps large deliveries: one range can never become fragmented.
  assert.deepEqual(deliveryBatches([{ count: 300n, delivered: 0n }], 300).map(b => [b.maxIds, b.gas]), [[300, 11_300_000n]]);
  // Partial progress: the bound covers starting anywhere in the partly delivered range too.
  const partial = [{ count: 300n, delivered: 150n }, ...wallet.slice(1)];
  assert.equal(worstOverReachableStarts(partial, 91).gas, reachableDeliveryGas(partial, 91));
  // The mixed wallet of test/remediation/DeliveryRace.t.sol: NAND 1..200, 100 single LATCH ranges, NAND 201..300.
  const mixed = [{ count: 200n, delivered: 0n }, ...Array.from({ length: 100 }, () => ({ count: 1n, delivered: 0n })), { count: 100n, delivered: 0n }];
  assert.deepEqual(deliveryBatches(mixed, 300).slice(0, 4).map(b => [b.maxIds, b.gas]), Array(4).fill([91, 12_567_000n]));
});

test('the reachable-state bound equals a brute-force search over random wallets, including NAND and LATCH ranges', () => {
  let seed = 11;
  const rand = (m: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % m; };
  for (let t = 0; t < 60; t++) {
    // Ranges as a wallet's rangesOf returns them: NAND runs and LATCH runs interleaved, some partly delivered.
    const ranges = Array.from({ length: 1 + rand(40) }, () => {
      const count = BigInt(1 + (rand(3) === 0 ? rand(200) : rand(4)));
      return { count, delivered: rand(4) === 0 ? BigInt(rand(Number(count) + 1)) : 0n };
    });
    for (const m of [1, 2, 7, 50, 91, 300]) {
      const brute = worstOverReachableStarts(ranges, m);
      // Exactly the most ranges any reachable start touches, and never below any reachable cost.
      assert.equal(worstReachableRanges(ranges, m), brute.maxTouched);
      assert.ok(reachableDeliveryGas(ranges, m) >= brute.gas, `bound below a reachable cost for ${m} IDs`);
    }
    for (const b of deliveryBatches(ranges, 300)) assert.ok(b.gas <= BATCH_GAS_BUDGET && b.gas >= worstOverReachableStarts(ranges, b.maxIds).gas);
  }
});

test('deliveries never share a Safe transaction: a stale one reverts alone', () => {
  const ranges = [{ category: 0, firstId: 1n, count: 5n, delivered: 0n }];
  const deliveries = deliveryPlans(A, A, ranges, 2, true);
  assert.equal(deliveries.length, 3);
  assert.ok(deliveries.every(p => p.standalone === true));
  assert.deepEqual(groupForSafe([plan(1n), ...deliveries, plan(1n)]).map(g => g.length), [1, 1, 1, 1, 1]);
  assert.deepEqual(groupForSafe([plan(1n), plan(1n)]).map(g => g.length), [2]);
});

test('review P-01: claim inputs are sets per category; NAND #1 and LATCH #1 stay separate', () => {
  const c = canonicalClaimIds([1n, 1n, 2n, 1n], [1n, 3n, 3n]);
  assert.deepEqual([c.NAND, c.LATCH], [[1n, 2n], [1n, 3n]]);
  assert.deepEqual(c.duplicates, { NAND: [1n, 1n], LATCH: [3n] });
  assert.equal(c.normalized, true);
  assert.equal(canonicalClaimIds([1n], [1n]).normalized, false);
  // The plan builder refuses duplicates instead of silently changing the caller's input.
  assert.throws(() => claimPlans(A, [1n, 1n], []), /each ID once per category/);
  const [p] = claimPlans(A, c.NAND, c.LATCH);
  assert.deepEqual(decodeFunctionData({ abi: tapeoutMinerPoolAbi as Abi, data: p.data }).args, [[1n, 2n], [1n, 3n]]);
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
