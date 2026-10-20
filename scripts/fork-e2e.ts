#!/usr/bin/env node
/**
 * Operator CLI end to end on a local Anvil fork of real BSC state (real miner collection, Mining and
 * BEM). Miner NFTs are moved from their current holders with Anvil impersonation; nothing is signed
 * or sent to BSC. Writes reports/fork-e2e.json; every transaction hash belongs to the local fork only.
 *
 * Env: FORK_RPC_URL (archive-capable), FORK_BLOCK (default 128713128), FORK_NAND_MINER (12733),
 *      FORK_LATCH_MINER (13948), FORK_EXTRA_MINERS (4183,1574): EOA-held active miners at that block.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createPublicClient, encodeFunctionData, getAddress, http, keccak256, parseEventLogs, stringToHex, toHex, type Abi, type Address, type Hex } from 'viem';
import { main as cli, json } from '../cli/pool.ts';
import { startAnvil } from './lib/anvil.ts';
import { BSC_PROTOCOL, erc20Abi, erc721Abi, miningAbi } from '../sdk/constants.ts';
import { tapeoutMinerPoolAbi } from '../sdk/abi.ts';
import { accrue, checkpoint, type State } from '../sdk/math.ts';
import { simulate } from '../sdk/tx.ts';

const DIR = '.runtime/fork-e2e';
const archiveUrl = process.env.FORK_RPC_URL ?? '';
if (!archiveUrl) throw new Error('Set FORK_RPC_URL to an archive-capable BSC RPC endpoint');
const forkBlock = BigInt(process.env.FORK_BLOCK ?? '128713128');
const nandMiner = BigInt(process.env.FORK_NAND_MINER ?? '12733');
const latchMiner = BigInt(process.env.FORK_LATCH_MINER ?? '13948');
const extraMiners = (process.env.FORK_EXTRA_MINERS ?? '4183,1574').split(',').map(BigInt);

const report: Record<string, unknown> & { steps: unknown[]; checks: Record<string, boolean>; observations: Record<string, unknown> } = {
  scope: 'REAL_BSC_STATE_LOCAL_ANVIL_FORK_ONLY', status: 'IN_PROGRESS', startedAt: new Date().toISOString(),
  source: { chainId: 56, forkBlock, archiveRpcHost: new URL(archiveUrl).host }, miners: { nandMiner, latchMiner, extraMiners }, steps: [], checks: {}, observations: {},
  mainnetTransactionsSent: 0, signaturesCreated: 0,
};
function check(name: string, ok: boolean, detail?: unknown) {
  report.checks[name] = ok;
  if (!ok) throw new Error(`CHECK_FAILED ${name} ${detail === undefined ? '' : json(detail)}`);
}

async function main() {
  await mkdir(DIR, { recursive: true });
  const node = await startAnvil(18546, ['--fork-url', archiveUrl, '--fork-block-number', String(forkBlock), '--hardfork', 'cancun',
    '--compute-units-per-second', '40', '--retries', '30', '--timeout', '60000', '--silent'], 600_000);
  try {
    const rpc = createPublicClient({ transport: http(node.url, { timeout: 600_000 }) });
    (report.source as Record<string, unknown>).blockHash = (await rpc.getBlock({ blockNumber: forkBlock })).hash;
    // Anvil's default accounts carry EIP-7702 delegations on BSC (their keys are public) and cannot
    // receive ERC-1155 receipts, so every actor is a fresh labelled address, impersonated and funded.
    const labels = ['operator', 'depositor', 'alice', 'bob', 'carol', 'keeper', 'outsider', 'recipientA', 'recipientB'];
    const actors = labels.map(l => getAddress(`0x${keccak256(stringToHex(`tapeout-fork-e2e-v2:${l}`)).slice(26)}`));
    for (const a of actors) {
      const code = await rpc.getCode({ address: a });
      if (code && code !== '0x') throw new Error(`actor ${a} has code on the fork`);
      await rpc.request({ method: 'anvil_impersonateAccount', params: [a] } as never);
      await rpc.request({ method: 'anvil_setBalance', params: [a, toHex(10n ** 18n)] } as never);
    }
    const [operator, depositor, alice, bob, carol, keeper, outsider, recipientA, recipientB] = actors;
    report.actors = Object.fromEntries(labels.map((l, i) => [l, actors[i]]));
    const read = <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) => rpc.readContract({ address, abi, functionName, args } as never) as Promise<T>;
    const bemOf = (a: Address) => read<bigint>(BSC_PROTOCOL.bem, erc20Abi as Abi, 'balanceOf', [a]);
    const raw = async (from: Address, to: Address, data: Hex, label: string) => {
      const hash = await rpc.request({ method: 'eth_sendTransaction', params: [{ from, to, data }] } as never) as Hex;
      const r = await rpc.waitForTransactionReceipt({ hash, timeout: 600_000 });
      if (r.status !== 'success') throw new Error(`${label} reverted`);
      report.steps.push({ label, transactions: [{ hash, gasUsed: r.gasUsed, blockNumber: r.blockNumber }] });
      return r;
    };
    const step = async (label: string, argv: string[]) => {
      const result = await cli([...argv, '--rpc-url', node.url]) as Record<string, unknown>;
      const txs = (result.transactions as { hash: Hex; gasUsed: bigint; blockNumber: bigint; description: string }[] | undefined) ?? [];
      report.steps.push({ label, argv, mode: result.mode, transactions: txs.map(t => ({ hash: t.hash, gasUsed: t.gasUsed, blockNumber: t.blockNumber, description: t.description })), ...(txs.length ? {} : { result }) });
      return result;
    };

    const identity = await step('protocol-check', ['protocol-check']);
    check('protocolIdentityMatchesRecorded', identity.status === 'IDENTITY_MATCHES_RECORDED', identity.checks);

    const systemFile = `${DIR}/system.json`;
    const addressesFile = `${DIR}/addresses.json`;
    await writeFile(systemFile, json({
      chainId: 56, protocol: BSC_PROTOCOL,
      receipts: { issuer: operator, nand: { name: 'Fork NAND Entitlement', symbol: 'fNAND', uri: '' }, latch: { name: 'Fork LATCH Entitlement', symbol: 'fLATCH', uri: '' } },
      pool: { name: 'Fork E2E Pool', owner: operator, recipientA, recipientB, depositors: [depositor] },
      distributor: { owner: operator },
    }));
    await step('deploy-receipts', ['deploy-receipts', '--system', systemFile, '--addresses-out', addressesFile, '--from', operator, '--send-local']);
    await step('issue-nand', ['issue', '--addresses', addressesFile, '--category', 'NAND', '--to', operator, '--count', '40', '--from', operator, '--send-local']);
    await step('issue-latch', ['issue', '--addresses', addressesFile, '--category', 'LATCH', '--to', operator, '--count', '12', '--from', operator, '--send-local']);
    await step('finalize-nand', ['finalize-issuance', '--addresses', addressesFile, '--category', 'NAND', '--from', operator, '--send-local']);
    await step('finalize-latch', ['finalize-issuance', '--addresses', addressesFile, '--category', 'LATCH', '--from', operator, '--send-local']);
    await step('deploy-pool-and-distributor', ['deploy', '--system', systemFile, '--addresses', addressesFile, '--from', operator, '--send-local']);
    const addresses = JSON.parse(await readFile(addressesFile, 'utf8'));
    const pool = addresses.pool as Address;
    await step('fund-nand', ['fund-distributor', '--addresses', addressesFile, '--category', 'NAND', '--from', operator, '--all-held', '--send-local']);
    await step('fund-latch', ['fund-distributor', '--addresses', addressesFile, '--category', 'LATCH', '--from', operator, '--all-held', '--send-local']);
    const allocationFile = `${DIR}/allocation.json`;
    await writeFile(allocationFile, json({ allocations: [
      { wallet: alice, nandCount: 20, latchCount: 5 }, { wallet: bob, nandCount: 20, latchCount: 0 }, { wallet: carol, nandCount: 0, latchCount: 7 },
    ] }));
    await step('import-allocation', ['import-allocation', '--addresses', addressesFile, '--allocation', allocationFile, '--artifact-out', `${DIR}/artifact.json`, '--from', operator, '--send-local']);
    const verified = await step('verify-allocation', ['verify-allocation', '--addresses', addressesFile, '--artifact', `${DIR}/artifact.json`]);
    check('allocationVerified', verified.status === 'READY_TO_FINALIZE', verified);
    await step('finalize-allocation', ['finalize-allocation', '--addresses', addressesFile, '--from', operator, '--send-local']);
    await step('activate', ['activate', '--addresses', addressesFile, '--nand-shares', '40', '--latch-shares', '12', '--from', operator, '--send-local']);
    await step('renounce-pool', ['renounce', '--addresses', addressesFile, '--target', 'pool', '--from', operator, '--send-local']);

    // Real miners: holders -> depositor (fork impersonation only).
    const moves = [];
    for (const id of [nandMiner, latchMiner, ...extraMiners]) {
      const holder = await read<Address>(BSC_PROTOCOL.minerCollection, erc721Abi as Abi, 'ownerOf', [id]);
      await rpc.request({ method: 'anvil_impersonateAccount', params: [holder] } as never);
      await rpc.request({ method: 'anvil_setBalance', params: [holder, toHex(10n ** 18n)] } as never);
      const holderBem = await bemOf(holder);
      await raw(holder, BSC_PROTOCOL.minerCollection, encodeFunctionData({ abi: erc721Abi, functionName: 'transferFrom', args: [holder, depositor, id] }), `impersonated holder moves miner ${id} to the depositor`);
      check(`noSettlementToHolderOnTransfer_${id}`, await bemOf(holder) === holderBem);
      moves.push({ id, holder });
      await rpc.request({ method: 'anvil_stopImpersonatingAccount', params: [holder] } as never);
    }
    const comp = await step('composition', ['composition', '--addresses', addressesFile, '--token-ids', [nandMiner, latchMiner, ...extraMiners].join(',')]);
    const byId = new Map((comp.miners as { tokenId: string | bigint; nandBurn: number; latchBurn: number; admissible: boolean }[]).map(m => [BigInt(m.tokenId), m]));
    check('realCompositionsAdmissible', [...byId.values()].every(m => m.admissible), comp.miners);
    check('nandMinerBurnsNoLatch', byId.get(nandMiner)!.latchBurn === 0 && byId.get(latchMiner)!.latchBurn > 0);

    // Whitelist enforced on chain even when the CLI preflight is bypassed.
    const unauthorized = await simulate(rpc, { to: pool, value: 0n, description: 'outsider deposit', data: encodeFunctionData({ abi: tapeoutMinerPoolAbi as Abi, functionName: 'depositMiners', args: [[nandMiner]] }) }, outsider);
    check('outsiderDepositRevertsOnChain', !unauthorized.ok && unauthorized.error === `NotDepositor(${outsider})`, unauthorized);

    // Admission boundary on real Mining: NAND-only first, LATCH-burning miner one hour later.
    const first = await step('deposit-nand-miner', ['deposit', '--addresses', addressesFile, '--token-ids', String(nandMiner), '--from', depositor, '--send-local']);
    const admitted = async (r: Record<string, unknown>) => {
      const receipt = await rpc.getTransactionReceipt({ hash: (r.transactions as { hash: Hex }[]).at(-1)!.hash });
      return parseEventLogs({ abi: tapeoutMinerPoolAbi as Abi, eventName: 'MinersAdmitted', logs: receipt.logs })[0].args as unknown as { settledOldIncome: bigint; carriedIncome: bigint };
    };
    const a1 = await admitted(first);
    check('carriedIncomeCollectedAtFirstAdmission', a1.carriedIncome > 0n);
    await rpc.request({ method: 'evm_increaseTime', params: [3600] } as never);
    await rpc.request({ method: 'evm_mine', params: [] } as never);
    const second = await step('deposit-latch-miner', ['deposit', '--addresses', addressesFile, '--token-ids', String(latchMiner), '--from', depositor, '--send-local']);
    const a2 = await admitted(second);
    check('oldIncomeSettledInsideAdmission', a2.settledOldIncome > 0n);
    const n1 = BigInt(byId.get(nandMiner)!.nandBurn), n2 = BigInt(byId.get(latchMiner)!.nandBurn), l2 = BigInt(byId.get(latchMiner)!.latchBurn);
    const s0: State = { nandBase: 0n, latchBase: 0n, participantBase: 0n, totalNandBurn: n1, totalLatchBurn: 0n, nandShares: 40n, latchShares: 12n };
    const s1 = checkpoint(a1.carriedIncome + a2.settledOldIncome, s0, n2, l2);
    const expected = accrue(a1.carriedIncome + a2.settledOldIncome + a2.carriedIncome, s1);
    const actual = await read<{ nandIncome: bigint; latchIncome: bigint; total: bigint }>(pool, tapeoutMinerPoolAbi as Abi, 'accrual');
    check('realBoundaryMatchesOldNewCompositionModel', actual.total === expected.total && actual.nandIncome === expected.nandIncome && actual.latchIncome === expected.latchIncome, { actual, expected });
    await step('deposit-batch-after-renounce', ['deposit', '--addresses', addressesFile, '--token-ids', extraMiners.join(','), '--from', depositor, '--send-local']);

    // Users: late receipt claims, BEM claims, transfer, releases.
    await rpc.request({ method: 'evm_increaseTime', params: [3600] } as never);
    await rpc.request({ method: 'evm_mine', params: [] } as never);
    await step('harvest-all', ['harvest', '--addresses', addressesFile, '--all', '--isolate-failures', '--from', keeper, '--send-local']);
    await step('alice-claims-receipts', ['claim-receipts', '--addresses', addressesFile, '--from', alice, '--send-local']);
    const aliceClaim = await step('alice-claims-bem', ['claim', '--addresses', addressesFile, '--from', alice, '--all', '--send-local']);
    check('aliceExactPayout', await bemOf(alice) === BigInt(aliceClaim.expectedPayoutRaw as string | bigint));
    await step('deliver-to-bob', ['deliver', '--addresses', addressesFile, '--wallet', bob, '--from', outsider, '--send-local']);
    check('deliveryWentToBob', (await read<bigint>(addresses.nandReceipt, [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] }] as Abi, 'balanceOf', [bob, 21n])) === 1n);
    await step('carol-claims-receipts', ['claim-receipts', '--addresses', addressesFile, '--from', carol, '--send-local']);
    await step('carol-claims-bem', ['claim', '--addresses', addressesFile, '--from', carol, '--all', '--send-local']);
    await step('bob-claims-bem', ['claim', '--addresses', addressesFile, '--from', bob, '--all', '--send-local']);
    await step('release', ['release', '--addresses', addressesFile, '--from', outsider, '--send-local']);
    check('outsiderReceivedNothing', await bemOf(outsider) === 0n);
    check('recipientsPaidEqually', await bemOf(recipientA) === await bemOf(recipientB) && await bemOf(recipientA) > 0n);
    const reconcile = await step('reconcile-deep', ['reconcile', '--addresses', addressesFile, '--deep', '--out', 'reports/fork-e2e-reconcile.json']);
    check('reconcilePass', reconcile.status === 'PASS', reconcile.checks);
    report.observations = { pool, moves, firstAdmission: a1, secondAdmission: a2, expectedAfterBoundary: expected, composition: comp.miners };
    report.status = 'PASS';
  } finally {
    await node.stop();
  }
}

main().catch(error => {
  report.status = 'FAIL';
  report.error = error instanceof Error ? error.message : String(error);
}).finally(async () => {
  report.completedAt = new Date().toISOString();
  const txs = report.steps.flatMap(s => ((s as { transactions?: unknown[] }).transactions ?? []));
  report.localForkTransactions = txs.length;
  await writeFile('reports/fork-e2e.json', json(report) + '\n');
  console.log(json({ status: report.status, checks: report.checks, localForkTransactions: txs.length, error: report.error, report: 'reports/fork-e2e.json' }));
  if (report.status !== 'PASS') process.exitCode = 1;
});
