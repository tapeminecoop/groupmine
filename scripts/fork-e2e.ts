#!/usr/bin/env node
/**
 * Operator CLI end to end on a local Anvil fork of real BSC state (real miner collection, Mining
 * and BEM). Miner NFTs are moved from their current holders with Anvil impersonation; nothing is
 * signed or sent to BSC. Writes reports/fork-e2e.json; every transaction hash belongs to the local
 * fork only.
 *
 * Env: FORK_RPC_URL (archive-capable), FORK_BLOCK (default 128611683), FORK_MINER_IDS (default
 *      4630,2458,6241: EOA-held miners with positive pending at that block).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createPublicClient, encodeFunctionData, getAddress, http, keccak256, stringToHex, toHex, type Abi, type Address, type Hex } from 'viem';
import { main as cli, json } from '../cli/pool.ts';
import { startAnvil } from './lib/anvil.ts';
import { BSC_PROTOCOL, CATEGORY, erc20Abi, erc721Abi, miningAbi } from '../sdk/constants.ts';
import { tapeoutMinerPoolAbi, tapeoutReceiptAbi } from '../sdk/abi.ts';

const DIR = '.runtime/fork-e2e';
const archiveUrl = process.env.FORK_RPC_URL ?? '';
if (!archiveUrl) throw new Error('Set FORK_RPC_URL to an archive-capable BSC RPC endpoint');
const forkBlock = BigInt(process.env.FORK_BLOCK ?? '128611683');
const minerIds = (process.env.FORK_MINER_IDS ?? '4630,2458,6241').split(',').map(BigInt);

const report: Record<string, unknown> & { steps: unknown[]; checks: Record<string, boolean>; observations: Record<string, unknown> } = {
  scope: 'REAL_BSC_STATE_LOCAL_ANVIL_FORK_ONLY', status: 'IN_PROGRESS', startedAt: new Date().toISOString(),
  source: { chainId: 56, forkBlock, archiveRpcHost: new URL(archiveUrl).host }, minerIds, steps: [], checks: {}, observations: {},
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
    const block = await rpc.getBlock({ blockNumber: forkBlock });
    (report.source as Record<string, unknown>).blockHash = block.hash;
    // Anvil's default accounts carry EIP-7702 delegations on BSC mainnet (their keys are public), so
    // they cannot receive ERC-1155 receipts. Use fresh labelled addresses, impersonated and funded.
    const labels = ['operator', 'alice', 'bob', 'carol', 'reserve', 'keeper', 'outsider', 'fee', 'historicalNand', 'historicalLatch'];
    const actors = labels.map(l => getAddress(`0x${keccak256(stringToHex(`tapeout-fork-e2e:${l}`)).slice(26)}`));
    for (const a of actors) {
      const code = await rpc.getCode({ address: a });
      if (code && code !== '0x') throw new Error(`actor ${a} has code on the fork`);
      await rpc.request({ method: 'anvil_impersonateAccount', params: [a] } as never);
      await rpc.request({ method: 'anvil_setBalance', params: [a, toHex(10n ** 18n)] } as never);
    }
    const [operator, alice, bob, carol, reserve, keeper, outsider, feeTo, histNandTo, histLatchTo] = actors;
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

    const poolFile = `${DIR}/pool.json`;
    const allocationFile = `${DIR}/allocation.json`;
    await writeFile(poolFile, json({
      chainId: 56, protocol: BSC_PROTOCOL,
      pool: { name: 'Fork E2E Pool', owner: operator, nandReceipt: { name: 'Fork NAND Receipt', symbol: 'fNAND', uri: '' }, latchReceipt: { name: 'Fork LATCH Receipt', symbol: 'fLATCH', uri: '' } },
      economics: { nandShares: 90, latchShares: 8, historicalNandShares: 10, historicalLatchShares: 2, nandWeight: '0.80000000' },
      recipients: { fee: feeTo, historicalNand: histNandTo, historicalLatch: histLatchTo },
    }));
    await writeFile(allocationFile, json({
      nand: [{ holder: alice, shares: 40 }, { holder: bob, shares: 45 }],
      latch: [{ holder: alice, shares: 4 }, { holder: carol, shares: 3 }],
      reserve,
    }));

    const deployed = await step('deploy', ['deploy', '--config', poolFile, '--from', operator, '--send-local']);
    const pool = deployed.pool as Address;
    await step('configure', ['configure', '--pool', pool, '--config', poolFile, '--from', operator, '--send-local']);
    await step('issue', ['issue', '--pool', pool, '--config', poolFile, '--allocation', allocationFile, '--from', operator, '--send-local']);
    const preflight = await step('preflight', ['preflight', '--pool', pool, '--config', poolFile]);
    check('preflightReady', preflight.ready === true, preflight.problems);

    // Move the real miners from their holders to the operator (fork impersonation only).
    const moves = [];
    for (const id of minerIds) {
      const holder = await read<Address>(BSC_PROTOCOL.minerCollection, erc721Abi as Abi, 'ownerOf', [id]);
      const key = await read<Hex>(BSC_PROTOCOL.mining, miningAbi as Abi, 'minerKey', [BSC_PROTOCOL.minerCollection, id]);
      await rpc.request({ method: 'anvil_impersonateAccount', params: [holder] } as never);
      await rpc.request({ method: 'anvil_setBalance', params: [holder, toHex(10n ** 18n)] } as never);
      const holderBem = await bemOf(holder);
      const pending = await read<bigint>(BSC_PROTOCOL.mining, miningAbi as Abi, 'pending', [key]);
      await raw(holder, BSC_PROTOCOL.minerCollection, encodeFunctionData({ abi: erc721Abi, functionName: 'transferFrom', args: [holder, operator, id] }), `impersonated holder moves miner ${id} to operator`);
      check(`noSettlementToHolderOnTransfer_${id}`, await bemOf(holder) === holderBem);
      moves.push({ id, holder, pendingBeforeTransfer: pending });
      await rpc.request({ method: 'anvil_stopImpersonatingAccount', params: [holder] } as never);
    }

    const poolBem0 = await bemOf(pool);
    await step('deposit-before-activation', ['deposit', '--pool', pool, '--token-ids', String(minerIds[0]), '--from', operator, '--send-local']);
    const carried = await bemOf(pool) - poolBem0;
    check('carriedIncomeCollectedAtDeposit', carried >= (moves[0].pendingBeforeTransfer as bigint) && carried > 0n, { carried, pending: moves[0].pendingBeforeTransfer });
    await step('activate', ['activate', '--pool', pool, '--config', poolFile, '--from', operator, '--send-local']);
    check('activationRecognizedCarriedIncome', await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'totalAccounted') === carried);
    await step('deposit-after-activation', ['deposit', '--pool', pool, '--token-ids', minerIds.slice(1).join(','), '--from', operator, '--send-local']);
    const afterDeposits = await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'totalAccounted');

    await rpc.request({ method: 'evm_increaseTime', params: [3600] } as never);
    await rpc.request({ method: 'evm_mine', params: [] } as never);
    const pendingBefore = await Promise.all(minerIds.map(async id => read<bigint>(BSC_PROTOCOL.mining, miningAbi as Abi, 'pending', [await read<Hex>(BSC_PROTOCOL.mining, miningAbi as Abi, 'minerKey', [BSC_PROTOCOL.minerCollection, id])])));
    await step('harvest-all', ['harvest', '--pool', pool, '--all', '--isolate-failures', '--from', keeper, '--send-local']);
    const harvested = await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'totalAccounted') - afterDeposits;
    check('realHarvestPositive', harvested > 0n, { harvested, pendingBefore });

    const aliceClaim = await step('alice-claim-all', ['claim', '--pool', pool, '--all', '--from', alice, '--send-local']);
    check('aliceExactPayout', await bemOf(alice) === BigInt(aliceClaim.expectedPayoutRaw as bigint | string));
    const due46 = await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'claimable', [CATEGORY.NAND, 46n]);
    const nandReceipt = deployed.nandReceipt as Address;
    await raw(bob, nandReceipt, encodeFunctionData({ abi: tapeoutReceiptAbi, functionName: 'safeTransferFrom', args: [bob, carol, 46n, 1n, '0x'] }), 'bob transfers NAND #46 (unclaimed) to carol');
    const rejected = await step('former-holder-simulation', ['claim', '--pool', pool, '--holder', bob, '--nand', '46', '--from', bob]);
    const sim = (rejected.plans as { simulation: { ok: boolean; error?: string } }[])[0].simulation;
    check('formerHolderRejectedNotHolder', !sim.ok && /NotHolder\(0, 46\)/.test(sim.error ?? ''), sim);
    const carolBefore = await bemOf(carol);
    await step('carol-claim-all', ['claim', '--pool', pool, '--all', '--from', carol, '--send-local']);
    check('newHolderGotTransferredIncome', await bemOf(carol) - carolBefore >= due46 && due46 > 0n);
    await step('bob-claim-all', ['claim', '--pool', pool, '--all', '--from', bob, '--send-local']);
    await step('release', ['release', '--pool', pool, '--from', outsider, '--send-local']);
    check('outsiderReceivedNothing', await bemOf(outsider) === 0n);

    const reconcile = await step('reconcile-deep', ['reconcile', '--pool', pool, '--deep', '--out', 'reports/fork-e2e-reconcile.json']);
    check('reconcilePass', reconcile.status === 'PASS', reconcile.checks);
    let paid = 0n;
    for (const a of [alice, bob, carol, reserve, feeTo, histNandTo, histLatchTo]) paid += await bemOf(a);
    check('payeeBalancesEqualTotalPaid', paid === await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'totalPaid'));

    report.observations = { pool, moves, carriedIncomeAtFirstDeposit: carried, pendingBeforeHarvestAfterOneHour: pendingBefore, harvestedAfterOneHour: harvested, transferredEntitlementNand46: due46 };
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
