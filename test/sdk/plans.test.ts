import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeDeployData, decodeFunctionData, type Abi, type Hex, type PublicClient } from 'viem';
import { systemFileSchema, systemProblems, NAND_CATEGORY } from '../../sdk/config.ts';
import { tapeoutEntitlementReceiptAbi, tapeoutMinerPoolAbi, tapeoutReceiptDistributorAbi } from '../../sdk/abi.ts';
import bytecode from '../../sdk/bytecode.json' with { type: 'json' };
import {
  ERC1155_RECEIVER_INTERFACE, allocatePlans, claimPlans, deployPoolPlan, deployReceiptPlans, fundPlans, issuePlans, receiverProblems, releasePlans,
} from '../../sdk/pool.ts';
import { FUND_GAS, ISSUE_GAS, admissionGasEstimate, maxAdmissionBatch, maxIdsPerTx, maxRegisteredForAdmission } from '../../sdk/gas.ts';
import { BATCH_GAS_BUDGET, TX_GAS_CAP } from '../../sdk/constants.ts';
import { castCommand, safeBatch } from '../../sdk/tx.ts';
import example from '../../deployments/examples/system.bsc.example.json' with { type: 'json' };

const A = '0x00000000000000000000000000000000000000aa' as const;

test('system file validation mirrors the pool constructor', () => {
  const f = systemFileSchema.parse(example);
  assert.deepEqual(systemProblems(f), []);
  assert.match(systemProblems({ ...f, pool: { ...f.pool, depositors: [f.pool.depositors[0], f.pool.depositors[0]] } }).join(), /twice/);
  assert.match(systemProblems({ ...f, pool: { ...f.pool, depositors: [f.protocol.mining] } }).join(), /protocol contract/);
  assert.throws(() => systemFileSchema.parse({ ...example, pool: { ...example.pool, depositors: [] } }));
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
  assert.match(castCommand(issue[0]), /^cast send --rpc-url "\$RPC_URL" <SIGNER_FLAGS> 0x/);
  assert.throws(() => safeBatch(deployReceiptPlans(systemFileSchema.parse(example)), 56, 'deploy'), /Contract creation/);
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
  // Default setup batches (bounded against measurements in test/unit/SetupGas.t.sol).
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
