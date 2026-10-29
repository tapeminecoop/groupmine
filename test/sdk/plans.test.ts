import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeDeployData, decodeFunctionData, type Abi, type Hex, type PublicClient } from 'viem';
import { parseAddresses, parseSystemFile, systemFileSchema, systemProblems, NAND_CATEGORY } from '../../sdk/config.ts';
import { tapeoutEntitlementReceiptAbi, tapeoutMinerPoolAbi, tapeoutReceiptDistributorAbi } from '../../sdk/abi.ts';
import bytecode from '../../sdk/bytecode.json' with { type: 'json' };
import {
  ERC1155_RECEIVER_INTERFACE, activatePlan, allocatePlans, bindDistributorPlan, checkReconciliation, claimPlans, deployDistributorPlan, deployPoolPlan, deployReceiptPlans, depositPlans, fundPlans, issuePlans,
  receiverProblems, releasePlans, type Reconciliation,
} from '../../sdk/pool.ts';
import { CALL_GAS, FIRST_ADMISSION_GAS, FUND_GAS, ISSUE_GAS, admissionGasEstimate, maxAdmissionBatch, maxIdsPerTx, maxRegisteredForAdmission } from '../../sdk/gas.ts';
import { accrue, SINK, type State } from '../../sdk/math.ts';
import { BATCH_GAS_BUDGET, TX_GAS_CAP } from '../../sdk/constants.ts';
import { castCommand, printableLoopback, safeBatch } from '../../sdk/tx.ts';
import example from '../../deployments/examples/system.bsc.example.json' with { type: 'json' };
import addressesExample from '../../deployments/examples/addresses.bsc.example.json' with { type: 'json' };

const A = '0x00000000000000000000000000000000000000aa' as const;

test('system file validation mirrors each pool constructor', () => {
  const f = systemFileSchema.parse(example);
  assert.deepEqual(systemProblems(f), []);
  const withPool = (role: 'optimal' | 'regular', change: Partial<typeof f.pools.optimal>) => ({ ...f, pools: { ...f.pools, [role]: { ...f.pools[role], ...change } } });
  assert.match(systemProblems(withPool('optimal', { depositors: [f.pools.optimal.depositors[0], f.pools.optimal.depositors[0]] })).join(), /optimal pool: .*twice/);
  assert.match(systemProblems(withPool('regular', { depositors: [f.protocol.mining] })).join(), /regular pool: .*protocol contract/);
  assert.throws(() => systemFileSchema.parse({ ...example, pools: { ...example.pools, regular: { ...example.pools.regular, depositors: [] } } }));
  // C's sink is a constant, never a recipient (the constructor refuses it too).
  assert.match(systemProblems(withPool('optimal', { recipientA: SINK })).join(), /fixed sink/);
  assert.match(systemProblems(withPool('regular', { recipientB: SINK.toLowerCase() as typeof SINK })).join(), /fixed sink/);
  assert.match(systemProblems(withPool('regular', { name: f.pools.optimal.name })).join(), /both pools are named/);
});

test('single-pool system and addresses files (2.2.0 and earlier) are refused, never reinterpreted', () => {
  const { pools, ...base } = example;
  assert.throws(() => parseSystemFile({ ...base, pool: pools.optimal }), /single-pool key "pool"/);
  // Even with both pools present, a leftover single-pool key is refused rather than ignored.
  assert.throws(() => parseSystemFile({ ...example, pool: pools.optimal }), /single-pool key "pool"/);
  assert.throws(() => parseAddresses({ chainId: 56, nandReceipt: A, latchReceipt: A, pool: A, distributor: A }), /single-pool key "pool"/);
  assert.equal(parseAddresses(addressesExample).regularPool, addressesExample.regularPool);
  assert.throws(() => parseAddresses({ ...addressesExample, extra: A }));
});

test('release plans: each call pays its role and C, with the 300k bound', () => {
  const plans = releasePlans(A);
  assert.ok(plans.every(p => p.gas === CALL_GAS.releaseA && p.description.includes(SINK) && /2\/84/.test(p.description)));
  assert.equal(CALL_GAS.releaseA, 300_000n);
});

test('reconciliation includes unpaid C and checks each outer part from T on its own', () => {
  const state: State = { accountedBase: 0n, nandBase: 0n, latchBase: 0n, totalNandBurn: 3n, totalLatchBurn: 1n, nandShares: 4n, latchShares: 2n };
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

test('2.2.0 initialization plans: bind the distributor once, then activate (each with its bound)', () => {
  const D = '0x00000000000000000000000000000000000000dd' as const;
  const bind = bindDistributorPlan(A, D);
  const call = decodeFunctionData({ abi: tapeoutMinerPoolAbi as Abi, data: bind.data });
  assert.equal(call.functionName, 'bindDistributor');
  assert.deepEqual(call.args, [D]);
  assert.equal(bind.gas, CALL_GAS.bindDistributor);
  assert.match(bind.description, /once, before activation; never replaceable/);
  assert.match(activatePlan(A, 10n, 4n).description, /allocation finalized/);
});

test('reconciliation checks the 2.2.0 ledger identities and the carried totals', () => {
  const state: State = { accountedBase: 21n, nandBase: (21n * 80n * 10n ** 18n) / 3n, latchBase: 21n * 80n * 10n ** 18n - (21n * 80n * 10n ** 18n) / 3n,
    totalNandBurn: 1n, totalLatchBurn: 2n, nandShares: 1n, latchShares: 1n };
  const x = accrue(21n, state);
  const r: Reconciliation = { bemBalance: 21n, unrecognized: 0n, deficit: 0n, totalAccounted: 21n, totalPaid: 0n, recipientAAccrued: x.recipientA, recipientAPaid: 0n,
    recipientBAccrued: x.recipientB, recipientBPaid: 0n, sinkAccrued: x.sink, sinkPaid: 0n, nandIncome: x.nandIncome, nandReceiptsAccrued: x.nandReceipts, nandReceiptsPaid: 0n,
    latchIncome: x.latchIncome, latchReceiptsAccrued: x.latchReceipts, latchReceiptsPaid: 0n, residue: x.residue };
  const carried = { carriedIncome: 21n, carriedNandUnits: state.nandBase };
  const ok = checkReconciliation(state, r, carried);
  assert.equal(ok.status, 'PASS', JSON.stringify(ok.checks));
  assert.equal(checkReconciliation({ ...state, latchBase: state.latchBase + 1n }, r, carried).checks.ledgerBoundaryIdentity, false);
  assert.equal(checkReconciliation(state, r, { ...carried, carriedIncome: 22n }).checks.carriedIncomeWithinRecognized, false);
  assert.equal(checkReconciliation(state, r, { carriedIncome: 1n, carriedNandUnits: 81n * 10n ** 18n }).checks.carriedUnitsWithinItsShare, false);
});

test('deployment plans carry the intended constructor arguments', () => {
  const f = systemFileSchema.parse(example);
  const [nand, latch] = deployReceiptPlans(f);
  const decoded = decodeDeployData({ abi: tapeoutEntitlementReceiptAbi as Abi, bytecode: bytecode.TapeoutEntitlementReceipt.bytecode as Hex, data: nand.data });
  assert.equal(decoded.args?.[0], NAND_CATEGORY);
  assert.notEqual(nand.data, latch.data);
  const decodePool = (role: 'optimal' | 'regular') => decodeDeployData({ abi: tapeoutMinerPoolAbi as Abi, bytecode: bytecode.TapeoutMinerPool.bytecode as Hex,
    data: deployPoolPlan(f, role, A, '0x00000000000000000000000000000000000000bb').data }).args?.[0] as { depositors: string[]; nandReceipt: string; latchReceipt: string; poolName: string };
  const [optimal, regular] = [decodePool('optimal'), decodePool('regular')];
  assert.equal(optimal.depositors.length, 1);
  assert.equal(optimal.nandReceipt.toLowerCase(), A);
  // Both pools take the same receipt pair; each has its own name.
  assert.equal(regular.nandReceipt, optimal.nandReceipt);
  assert.equal(regular.latchReceipt, optimal.latchReceipt);
  assert.deepEqual([optimal.poolName, regular.poolName], [f.pools.optimal.name, f.pools.regular.name]);
  const O = '0x00000000000000000000000000000000000000c1', R = '0x00000000000000000000000000000000000000c2';
  const distributor = decodeDeployData({ abi: tapeoutReceiptDistributorAbi as Abi, bytecode: bytecode.TapeoutReceiptDistributor.bytecode as Hex, data: deployDistributorPlan(A, O, R).data });
  assert.deepEqual(distributor.args?.map(a => String(a).toLowerCase()), [A, O, R]);
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
  // Fork measurement (2.2.0): 877,605 gas with 23 registered miners; the model must not underestimate it.
  assert.ok(admissionGasEstimate(23n, 1n) >= 877_605n);
  // 2.2.0: the admission that opens custody gets an allowance (fork: 514,781 for one miner, 538,382 as a CLI transaction).
  assert.equal(admissionGasEstimate(0n, 1n, true) - admissionGasEstimate(0n, 1n), FIRST_ADMISSION_GAS);
  assert.ok(admissionGasEstimate(0n, 1n, true) >= 538_382n + 100_000n);
  const firstPlans = depositPlans('0x00000000000000000000000000000000000000f1', [1n, 2n, 3n], 2, 0n, false);
  assert.deepEqual(firstPlans.map(p => p.gas), [admissionGasEstimate(0n, 2n, true), admissionGasEstimate(2n, 1n)]);
  assert.match(firstPlans[0].description, /opens custody/);
  assert.equal(maxAdmissionBatch(0n, BATCH_GAS_BUDGET, true) <= maxAdmissionBatch(0n), true);
  // Default setup batches (bounds checked as gas limits in test/unit/GasModel.t.sol).
  // 2.3.0 re-measurement (two claim-history reads per received ID): 231 -> 222 and 312 -> 283.
  assert.equal(maxIdsPerTx(ISSUE_GAS), 222);
  assert.equal(maxIdsPerTx(FUND_GAS), 283);
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
