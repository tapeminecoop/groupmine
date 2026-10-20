import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeFunctionData, getAddress, type Address } from 'viem';
import { tapeoutMinerPoolAbi } from '../../sdk/abi.ts';
import { buildIssuance, issuanceCalls } from '../../sdk/allocation.ts';
import { poolFileSchema, toConfig, toDeployment } from '../../sdk/config.ts';
import { CATEGORY } from '../../sdk/constants.ts';
import { MAX_CONTRIBUTORS, buildContributorList, distributorClaimPlans, distributorClaimRangePlans, distributorDeployPlan, distributorReleasePlan, weightsFileSchema } from '../../sdk/distributor.ts';
import { BATCH_GAS_BUDGET, GAS_MODEL, MAX_BATCH, TX_GAS_CAP, assertWithinBudget, checkBatchSize, gasBound, groupForSafe } from '../../sdk/gas.ts';
import { activatePlan, approveMinersPlan, claimPlans, configurePlan, deployPlan, depositPlans, harvestPlans, harvestRangePlans, issuancePlans, registerPlans, releasePlans } from '../../sdk/pool.ts';
import { castCommand } from '../../sdk/tx.ts';
import example from '../../deployments/examples/pool.bsc.example.json' with { type: 'json' };

const POOL = '0x00000000000000000000000000000000000000aa' as Address;
const DIST = '0x00000000000000000000000000000000000000dd' as Address;
const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => BigInt(from + i));
const model = (kind: keyof typeof GAS_MODEL, n: number) => GAS_MODEL[kind].fixed + GAS_MODEL[kind].perItem * BigInt(n);

test('BSC cap and budget: 2^24 (BEP-652) and three quarters of it', () => {
  assert.equal(TX_GAS_CAP, 2n ** 24n);
  assert.equal(BATCH_GAS_BUDGET, 12_582_912n);
});

test('every command maximum fits the budget in its costliest form', () => {
  assert.ok(model('issueReceipts', MAX_BATCH.issue) <= BATCH_GAS_BUDGET);
  assert.ok(model('issueReceiptRange', MAX_BATCH.issue) <= BATCH_GAS_BUDGET);
  assert.ok(model('claimBatch', MAX_BATCH.claim) <= BATCH_GAS_BUDGET);
  assert.ok(model('depositMiners', MAX_BATCH.deposit) <= BATCH_GAS_BUDGET);
  assert.ok(model('registerMiners', MAX_BATCH.register) <= BATCH_GAS_BUDGET);
  assert.ok(model('harvest', MAX_BATCH.harvest) <= BATCH_GAS_BUDGET);
  assert.ok(model('distributorClaimBatch', MAX_BATCH['distributor-claim']) <= BATCH_GAS_BUDGET);
  assert.ok(model('distributorClaimRange', MAX_BATCH['distributor-claim']) <= BATCH_GAS_BUDGET);
  assert.ok(model('distributorDeploy', MAX_CONTRIBUTORS) <= BATCH_GAS_BUDGET);
  // The CLI defaults are inside the maxima.
  for (const [kind, fallback] of [['issue', 200], ['claim', 200], ['deposit', 20], ['register', 20], ['harvest', 25], ['distributor-claim', 100]] as const) {
    assert.equal(checkBatchSize(kind, fallback), fallback);
  }
  assert.throws(() => checkBatchSize('issue', 201), /above 200 for issue: BSC limits a transaction's gas to 16777216 \(BEP-652\)/);
  assert.throws(() => checkBatchSize('distributor-claim', 151), /above 150/);
});

test('the model is at or above the gas measured by test/unit/BatchGasBudget.t.sol', () => {
  const measured = JSON.parse(readFileSync('reports/gas-batch.json', 'utf8')) as Record<string, number>;
  const pairs: [number, bigint][] = [
    [measured.issueReceiptRangeMax, model('issueReceiptRange', MAX_BATCH.issue)],
    [measured.issueReceiptsListMax, model('issueReceipts', MAX_BATCH.issue)],
    [measured.revokeReceiptsMax, model('revokeReceipts', MAX_BATCH.issue)],
    [measured.claimBatchMax, model('claimBatch', MAX_BATCH.claim)],
    [measured.distributorClaimRangeMax, model('distributorClaimRange', MAX_BATCH['distributor-claim'])],
    [measured.distributorClaimBatchMax, model('distributorClaimBatch', MAX_BATCH['distributor-claim'])],
    [measured.distributorDeployMax, model('distributorDeploy', MAX_CONTRIBUTORS)],
  ];
  for (const [gas, bound] of pairs) assert.ok(BigInt(gas) <= bound, `${gas} > ${bound}`);
  assert.equal(BigInt(measured.txGasCap), TX_GAS_CAP);
});

test('gas bounds of the plans the CLI builds', () => {
  const file = poolFileSchema.parse(example);
  const A = getAddress('0x00000000000000000000000000000000000000a1');
  const issuance = buildIssuance('NAND', 900, [{ holder: A, shares: 450 }, { holder: A, ids: [452, 454, 899] }], A);
  const issues = issuancePlans(POOL, issuanceCalls(issuance, 200));
  for (const plan of issues) assert.ok(gasBound(plan)! <= BATCH_GAS_BUDGET);
  assert.equal(gasBound(issues[0]), model('issueReceiptRange', 200));
  assert.equal(gasBound(claimPlans(POOL, ids(250), ids(150), 400)[0]), model('claimBatch', 400));
  assert.equal(gasBound(depositPlans(POOL, ids(20), 20)[0]), model('depositMiners', 20));
  assert.equal(gasBound(registerPlans(POOL, ids(3), 20)[0]), model('registerMiners', 3));
  assert.equal(gasBound(harvestPlans(POOL, ids(25), 25)[0]), model('harvest', 25));
  assert.equal(gasBound(harvestRangePlans(POOL, 60n, 25)[2]), model('harvest', 25));
  for (const plan of [...releasePlans(POOL), configurePlan(POOL, toConfig(file)), activatePlan(POOL, `0x${'11'.repeat(32)}`), approveMinersPlan(POOL, POOL)]) {
    assert.ok(gasBound(plan)! <= 400_000n, plan.description);
  }
  assert.equal(gasBound(deployPlan(toDeployment(file))), 8_500_000n);
  const list = buildContributorList(weightsFileSchema.parse({ category: 'LATCH', contributors: Array.from({ length: MAX_CONTRIBUTORS }, (_, i) => ({ account: `0x${(i + 1).toString(16).padStart(40, '0')}`, weight: 1 })) }));
  assert.equal(gasBound(distributorDeployPlan(POOL, list)), model('distributorDeploy', MAX_CONTRIBUTORS));
  assert.equal(gasBound(distributorClaimRangePlans(DIST, 400, 150)[0]), model('distributorClaimRange', 150));
  assert.equal(gasBound(distributorClaimPlans(DIST, list.contributors.slice(0, 150).map(c => c.account), 150)[0]), model('distributorClaimBatch', 150));
  assert.ok(gasBound(distributorClaimPlans(DIST, [A])[0])! <= 300_000n);
  assert.ok(gasBound(distributorReleasePlan(DIST))! <= 300_000n);
  assert.equal(gasBound({ to: POOL, data: '0xdeadbeef', value: 0n, description: 'unknown' }), undefined);
});

test('oversized plans are refused before anything is signed', () => {
  const revoke = (n: number) => ({ to: POOL, value: 0n, description: `revoke ${n}`, data: encodeFunctionData({ abi: tapeoutMinerPoolAbi, functionName: 'revokeReceipts', args: [CATEGORY.NAND, ids(n)] }) });
  assert.doesNotThrow(() => assertWithinBudget([revoke(200)]));
  assert.throws(() => assertWithinBudget([revoke(700)]), /may need up to 14100000 gas; BSC limits a transaction to 16777216 \(BEP-652\)/);
  const range = (count: number) => ({ to: POOL, value: 0n, description: `issue ${count}`, data: encodeFunctionData({ abi: tapeoutMinerPoolAbi, functionName: 'issueReceiptRange', args: [CATEGORY.NAND, POOL, 1n, BigInt(count)] }) });
  assert.throws(() => assertWithinBudget([range(300)]), /split it/);
});

test('Safe batches are split so each file (one MultiSend transaction) fits the budget', () => {
  const issues = issuancePlans(POOL, issuanceCalls(buildIssuance('NAND', 1000, [], getAddress(POOL)), 200));
  assert.equal(issues.length, 5);
  assert.equal(groupForSafe(issues).length, 5); // 10.15M bound each: one per file
  const deposits = [approveMinersPlan(POOL, POOL), ...depositPlans(POOL, ids(100), 20)];
  const groups = groupForSafe(deposits);
  assert.deepEqual(groups.map(g => g.length), [3, 2, 1]);
  assert.deepEqual(groups.flat(), deposits);
  for (const group of groups) assert.ok(group.reduce((sum, p) => sum + gasBound(p)!, 0n) <= BATCH_GAS_BUDGET);
  assert.equal(groupForSafe(releasePlans(POOL)).length, 1);
  const unknown = { to: POOL, data: '0xdeadbeef' as const, value: 0n, description: 'unknown' };
  assert.deepEqual(groupForSafe([...releasePlans(POOL), unknown, ...releasePlans(POOL)]).map(g => g.length), [3, 1, 3]);
});

test('printed cast commands fix the gas limit at the plan bound, and only when given one', () => {
  const plan = harvestPlans(POOL, ids(25), 25)[0];
  const bound = gasBound(plan)!;
  assert.match(castCommand(plan, bound), new RegExp(`^cast send --rpc-url "\\$RPC_URL" <SIGNER_FLAGS> --gas-limit ${bound} 0x0+aa 0x[0-9a-f]+$`));
  assert.doesNotMatch(castCommand(plan), /--gas-limit/);
  const create = deployPlan(toDeployment(poolFileSchema.parse(example)));
  assert.match(castCommand(create, gasBound(create)), /<SIGNER_FLAGS> --gas-limit 8500000 --create 0x/);
  assert.ok(gasBound(plan)! <= BATCH_GAS_BUDGET && gasBound(create)! <= BATCH_GAS_BUDGET);
});
