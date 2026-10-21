import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeDeployData, decodeFunctionData, type Abi, type Hex, type PublicClient } from 'viem';
import { systemFileSchema, systemProblems, NAND_CATEGORY } from '../../sdk/config.ts';
import { tapeoutEntitlementReceiptAbi, tapeoutMinerPoolAbi, tapeoutReceiptDistributorAbi } from '../../sdk/abi.ts';
import bytecode from '../../sdk/bytecode.json' with { type: 'json' };
import {
  ERC1155_RECEIVER_INTERFACE, allocatePlans, checkReconciliation, claimPlans, deployPoolPlan, deployReceiptPlans, fundPlans, issuePlans, receiverProblems, releasePlans,
  type Reconciliation,
} from '../../sdk/pool.ts';
import { CALL_GAS, FUND_GAS, ISSUE_GAS, admissionGasEstimate, maxAdmissionBatch, maxIdsPerTx, maxRegisteredForAdmission } from '../../sdk/gas.ts';
import { accrue, SINK, type State } from '../../sdk/math.ts';
import { BATCH_GAS_BUDGET, TX_GAS_CAP } from '../../sdk/constants.ts';
import { castCommand, printableLoopback, safeBatch } from '../../sdk/tx.ts';
import example from '../../deployments/examples/system.bsc.example.json' with { type: 'json' };

const A = '0x00000000000000000000000000000000000000aa' as const;

test('system file validation mirrors the pool constructor', () => {
  const f = systemFileSchema.parse(example);
  assert.deepEqual(systemProblems(f), []);
  assert.match(systemProblems({ ...f, pool: { ...f.pool, depositors: [f.pool.depositors[0], f.pool.depositors[0]] } }).join(), /twice/);
  assert.match(systemProblems({ ...f, pool: { ...f.pool, depositors: [f.protocol.mining] } }).join(), /protocol contract/);
  assert.throws(() => systemFileSchema.parse({ ...example, pool: { ...example.pool, depositors: [] } }));
  // C's sink is a constant, never a recipient (the constructor refuses it too).
  assert.match(systemProblems({ ...f, pool: { ...f.pool, recipientA: SINK } }).join(), /fixed sink/);
  assert.match(systemProblems({ ...f, pool: { ...f.pool, recipientB: SINK.toLowerCase() as typeof SINK } }).join(), /fixed sink/);
});

test('release plans: each call pays its role and C, with the 300k bound', () => {
  const plans = releasePlans(A);
  assert.ok(plans.every(p => p.gas === CALL_GAS.releaseA && p.description.includes(SINK) && /2\/84/.test(p.description)));
  assert.equal(CALL_GAS.releaseA, 300_000n);
});

test('reconciliation includes unpaid C and checks each outer part from T on its own', () => {
  const state: State = { nandBase: 0n, latchBase: 0n, participantBase: 0n, totalNandBurn: 3n, totalLatchBurn: 1n, nandShares: 4n, latchShares: 2n };
  const ledger = (t: bigint, paid: { a: bigint; b: bigint; c: bigint }): Reconciliation => {
    const x = accrue(t, state);
    const totalPaid = paid.a + paid.b + paid.c;
    return { bemBalance: t - totalPaid, unrecognized: 0n, deficit: 0n, totalAccounted: t, totalPaid, recipientAAccrued: x.recipientA, recipientAPaid: paid.a,
      recipientBAccrued: x.recipientB, recipientBPaid: paid.b, sinkAccrued: x.sink, sinkPaid: paid.c, nandIncome: x.nandIncome, nandReceiptsAccrued: x.nandReceipts,
      nandReceiptsPaid: 0n, latchIncome: x.latchIncome, latchReceiptsAccrued: x.latchReceipts, latchReceiptsPaid: 0n, residue: x.residue };
  };
  // T = 42: A = B = 0, C = 1 (not 2 * 0). Released by A: C paid, A and B nothing.
  const r = ledger(42n, { a: 0n, b: 0n, c: 1n });
  const ok = checkReconciliation(state, r);
  assert.equal(ok.status, 'PASS', JSON.stringify(ok.checks));
  assert.equal(ok.outstanding.sink, 0n);
  assert.equal(checkReconciliation(state, ledger(1_050n, { a: 0n, b: 0n, c: 0n })).outstanding.sink, 25n);
  // C reported as 2 * floor(T/84) fails the independent check; so does an overpaid sink.
  const doubled = checkReconciliation(state, { ...r, sinkAccrued: 2n * r.recipientAAccrued, residue: r.residue + 1n });
  assert.equal(doubled.checks.outerPartsFromTotal, false);
  assert.equal(doubled.status, 'FAIL');
  assert.equal(checkReconciliation(state, { ...r, sinkPaid: 2n, totalPaid: 2n, bemBalance: 40n }).checks.noBucketOverpaid, false);
});

test('deployment plans carry the intended constructor arguments', () => {
  const f = systemFileSchema.parse(example);
  const [nand, latch] = deployReceiptPlans(f);
  const decoded = decodeDeployData({ abi: tapeoutEntitlementReceiptAbi as Abi, bytecode: bytecode.TapeoutEntitlementReceipt.bytecode as Hex, data: nand.data });
  assert.equal(decoded.args?.[0], NAND_CATEGORY);
  assert.notEqual(nand.data, latch.data);
  const pool = deployPoolPlan(f, A, '0x00000000000000000000000000000000000000bb');
  const p = decodeDeployData({ abi: tapeoutMinerPoolAbi as Abi, bytecode: bytecode.TapeoutMinerPool.bytecode as Hex, data: pool.data });
  const d = p.args?.[0] as { depositors: string[]; recipientA: string; nandReceipt: string };
  assert.equal(d.depositors.length, 1);
  assert.equal(d.nandReceipt.toLowerCase(), A);
});

test('issue, fund, allocate, claim and release plans encode the right calls in bounded batches', () => {
  const issue = issuePlans(A, 'NAND', A, 1201, 500);
  assert.equal(issue.length, 3);
  assert.deepEqual(decodeFunctionData({ abi: tapeoutEntitlementReceiptAbi as Abi, data: issue[2].data }).args, ['0x00000000000000000000000000000000000000AA', 201n]);
  const fund = fundPlans(A, 'LATCH', A, A, [1n, 2n, 3n, 4n, 5n], 2);
  assert.equal(fund.length, 3);
  const allocate = allocatePlans(A, [[{ category: 0, wallet: A, firstId: 1n, count: 20n }]]);
  const args = decodeFunctionData({ abi: tapeoutReceiptDistributorAbi as Abi, data: allocate[0].data }).args as readonly (readonly { count: bigint }[])[];
  assert.equal(args[0][0].count, 20n);
  const claims = claimPlans(A, [1n, 2n, 3n], [1n], 2);
  assert.equal(claims.length, 2);
  assert.deepEqual(decodeFunctionData({ abi: tapeoutMinerPoolAbi as Abi, data: claims[1].data }).args, [[3n], [1n]]);
  assert.deepEqual(releasePlans(A).map(p => decodeFunctionData({ abi: tapeoutMinerPoolAbi as Abi, data: p.data }).functionName), ['releaseA', 'releaseB']);
  assert.match(castCommand(issue[0]), /^cast send --rpc-url "\$RPC_URL" <SIGNER_FLAGS> --gas-limit \d+ 0x/);
  assert.throws(() => safeBatch(deployReceiptPlans(systemFileSchema.parse(example)), 56, 'deploy'), /Contract creation/);
});

test('review O-05: printed commands are bound to the planning chain, and fork plans to the fork node', () => {
  const [p] = issuePlans(A, 'NAND', A, 1);
  // A signature for another chain id is not valid: $RPC_URL on another network cannot replay it.
  assert.match(castCommand(p, 56), /^cast send --rpc-url "\$RPC_URL" --chain 56 <SIGNER_FLAGS> --gas-limit/);
  // A local fork also answers chain 56: its plans target the loopback node, never $RPC_URL.
  assert.match(castCommand(p, 56, 'http://127.0.0.1:8545'), /^cast send --rpc-url "http:\/\/127\.0\.0\.1:8545" --chain 56 /);
  assert.equal(printableLoopback('http://127.0.0.1:8545/some/path?key=1'), 'http://127.0.0.1:8545');
  // Remote URLs and URLs with credentials are never printed.
  assert.equal(printableLoopback('https://bsc-dataseed.example.org/v1/SECRET'), undefined);
  assert.equal(printableLoopback('http://user:pass@127.0.0.1:8545'), undefined);
});

test('admission gas model stays inside the BSC per-transaction cap', () => {
  const limit = maxRegisteredForAdmission(1n);
  assert.ok(admissionGasEstimate(limit, 1n) <= BATCH_GAS_BUDGET);
  assert.ok(admissionGasEstimate(limit + 1n, 1n) > BATCH_GAS_BUDGET);
  assert.ok(maxRegisteredForAdmission(1n, TX_GAS_CAP) > limit);
  assert.equal(maxAdmissionBatch(0n), 49n); // (budget - base) / per-incoming-miner
  assert.equal(maxAdmissionBatch(10_000n), 0n);
  // Fork measurement: 867,619 gas with 23 registered miners; the model must not underestimate it.
  assert.ok(admissionGasEstimate(23n, 1n) >= 867_619n);
  // Default setup batches (bounds checked as gas limits in test/unit/GasModel.t.sol).
  assert.equal(maxIdsPerTx(ISSUE_GAS), 231);
  assert.equal(maxIdsPerTx(FUND_GAS), 312);
  assert.equal(maxIdsPerTx(ISSUE_GAS, 50_000n), 0);
});

test('allocation wallets must be able to take ERC-1155 delivery', async () => {
  const eoa = '0x00000000000000000000000000000000000000e0' as const;
  const safe = '0x00000000000000000000000000000000000000e1' as const;
  const plain = '0x00000000000000000000000000000000000000e2' as const;
  const delegated = '0x00000000000000000000000000000000000000e3' as const;
  const code: Record<string, Hex | undefined> = { [eoa]: undefined, [safe]: '0x6080', [plain]: '0x6080', [delegated]: '0xef0100000000000000000000000000000000000000ff' };
  const rpc = {
    getCode: async ({ address }: { address: string }) => code[address],
    readContract: async ({ address, args }: { address: string; args: readonly [Hex] }) => {
      assert.equal(args[0], ERC1155_RECEIVER_INTERFACE);
      if (address === safe) return true;
      if (address === plain) return false;
      throw new Error('execution reverted'); // a delegate without ERC-165
    },
  } as unknown as PublicClient;
  assert.deepEqual(await receiverProblems(rpc, [eoa, safe]), []);
  const problems = await receiverProblems(rpc, [eoa, plain, safe, delegated]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], new RegExp(`^${plain} is a contract`));
  assert.match(problems[1], new RegExp(`^${delegated} is an EIP-7702 delegated account`));
});
