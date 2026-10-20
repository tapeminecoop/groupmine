#!/usr/bin/env node
/**
 * Local end-to-end run of the operator CLI on a throwaway Anvil chain with the mock protocol.
 * Exercises every command through the same code paths operators use and writes
 * reports/local-e2e.json. All transaction hashes belong to the temporary local chain only.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createPublicClient, encodeDeployData, encodeFunctionData, http, type Abi, type Address, type Hex } from 'viem';
import { main as cli, json } from '../cli/pool.ts';
import { startAnvil } from './lib/anvil.ts';
import bytecode from '../sdk/bytecode.json' with { type: 'json' };
import { mockBEMAbi, mockMiningAbi, mockNFTAbi, tapeoutMinerPoolAbi, tapeoutReceiptAbi } from '../sdk/abi.ts';
import { CATEGORY, erc20Abi } from '../sdk/constants.ts';

const DIR = '.runtime/local-e2e';
const report: { scope: string; startedAt: string; status: string; steps: unknown[]; checks: Record<string, boolean>; final?: unknown; error?: string } = {
  scope: 'LOCAL_ANVIL_MOCK_PROTOCOL_ONLY', startedAt: new Date().toISOString(), status: 'IN_PROGRESS', steps: [], checks: {},
};

function check(name: string, ok: boolean, detail?: unknown) {
  report.checks[name] = ok;
  if (!ok) throw new Error(`CHECK_FAILED ${name} ${detail === undefined ? '' : json(detail)}`);
}

async function main() {
  await mkdir(DIR, { recursive: true });
  await mkdir('reports', { recursive: true });
  const node = await startAnvil(18545, ['--chain-id', '31337', '--silent']);
  try {
    const rpc = createPublicClient({ transport: http(node.url) });
    const accounts = await rpc.request({ method: 'eth_accounts' } as never) as Address[];
    const [operator, alice, bob, carol, reserve, keeper, outsider, feeTo, histNandTo, histLatchTo] = accounts;

    const send = async (from: Address, to: Address | null, data: Hex) => {
      const hash = await rpc.request({ method: 'eth_sendTransaction', params: [{ from, ...(to ? { to } : {}), data }] } as never) as Hex;
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`setup tx failed ${hash}`);
      return receipt;
    };
    const deploy = async (name: 'MockBEM' | 'MockMining' | 'MockNFT', abi: Abi, args: unknown[] = []) =>
      (await send(operator, null, encodeDeployData({ abi, bytecode: bytecode[name].bytecode as Hex, args }))).contractAddress as Address;
    const write = (to: Address, abi: Abi, functionName: string, args: unknown[], from = operator) =>
      send(from, to, encodeFunctionData({ abi, functionName, args } as never));
    const read = <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
      rpc.readContract({ address, abi, functionName, args } as never) as Promise<T>;
    const step = async (label: string, argv: string[]) => {
      const result = await cli([...argv, '--rpc-url', node.url]) as Record<string, unknown>;
      const txs = (result.transactions as { hash: Hex; gasUsed: bigint; description: string }[] | undefined) ?? [];
      report.steps.push({ label, argv, mode: result.mode, transactions: txs.map(t => ({ hash: t.hash, gasUsed: t.gasUsed, description: t.description })), result: txs.length ? undefined : result });
      return result;
    };

    const bem = await deploy('MockBEM', mockBEMAbi as Abi);
    const mining = await deploy('MockMining', mockMiningAbi as Abi, [bem]);
    const nft = await deploy('MockNFT', mockNFTAbi as Abi);

    const poolFile = `${DIR}/pool.json`;
    const allocationFile = `${DIR}/allocation.json`;
    await writeFile(poolFile, json({
      chainId: 31337,
      protocol: { bem, mining, minerCollection: nft },
      pool: { name: 'Local E2E Pool', owner: operator, nandReceipt: { name: 'Local NAND Receipt', symbol: 'lNAND', uri: '' }, latchReceipt: { name: 'Local LATCH Receipt', symbol: 'lLATCH', uri: '' } },
      economics: { nandShares: 12, latchShares: 6, historicalNandShares: 2, historicalLatchShares: 1, nandWeight: '0.75' },
      recipients: { fee: feeTo, historicalNand: histNandTo, historicalLatch: histLatchTo },
    }));
    await writeFile(allocationFile, json({
      nand: [{ holder: alice, shares: 5, ref: 'alice' }, { holder: bob, shares: 4, ref: 'bob' }, { holder: carol, ids: [12], ref: 'carol pinned' }],
      latch: [{ holder: alice, shares: 3, ref: 'alice' }, { holder: carol, ids: [5], ref: 'carol pinned' }],
      reserve,
    }));

    // 1. Deploy, configure, issue (in small batches), check resume, preflight, deposit during setup, activate.
    const deployed = await step('deploy', ['deploy', '--config', poolFile, '--from', operator, '--send-local']);
    const pool = deployed.pool as Address;
    const nandReceipt = deployed.nandReceipt as Address;
    check('deployedReceiptsBoundToPool', (await read<Address>(nandReceipt, tapeoutReceiptAbi as Abi, 'pool')) === pool);
    await step('configure', ['configure', '--pool', pool, '--config', poolFile, '--from', operator, '--send-local']);
    // Receiver preflight: a holder whose code rejects ERC-1155 (here a token contract) is named
    // before anything is sent; the same applies to EOAs with an incompatible EIP-7702 delegation.
    const badAllocation = `${DIR}/allocation-bad-receiver.json`;
    await writeFile(badAllocation, json({ nand: [{ holder: bem, shares: 12 }], latch: [{ holder: alice, shares: 6 }] }));
    let rejection = '';
    try {
      await cli(['issue', '--pool', pool, '--config', poolFile, '--allocation', badAllocation, '--from', operator, '--send-local', '--rpc-url', node.url]);
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error);
    }
    report.steps.push({ label: 'issue-rejects-non-receiver-holder', error: rejection });
    check('issueRejectsNonReceiverHolder', rejection.includes('cannot receive ERC-1155 receipts') && rejection.toLowerCase().includes(bem.toLowerCase()), rejection);
    check('nothingIssuedByRejectedPlan', (await read<bigint>(nandReceipt, tapeoutReceiptAbi as Abi, 'totalSupply')) === 0n);
    const issued = await step('issue', ['issue', '--pool', pool, '--config', poolFile, '--allocation', allocationFile, '--from', operator, '--send-local', '--batch-size', '4']);
    check('issuanceSentInBatches', (issued.transactions as unknown[]).length >= 4);
    const resume = await step('issue-resume-is-noop', ['issue', '--pool', pool, '--config', poolFile, '--allocation', allocationFile]);
    check('issuanceResumeHasNothingLeft', (resume.plans as unknown[]).length === 0, resume.alreadyIssued);
    const preflight = await step('preflight', ['preflight', '--pool', pool, '--config', poolFile]);
    check('preflightReady', preflight.ready === true, preflight.problems);

    for (const id of [101n, 102n, 103n, 104n]) {
      await write(nft, mockNFTAbi as Abi, 'mint', [operator, id]);
      await write(mining, mockMiningAbi as Abi, 'start', [nft, id]);
    }
    await write(mining, mockMiningAbi as Abi, 'accrue', [nft, 101n, 3_000_000n]); // pre-deposit, visible to pending
    await write(mining, mockMiningAbi as Abi, 'accrueUnsettled', [nft, 102n, 2_100_000n]); // pre-deposit, pending()==0
    await step('deposit-before-activation', ['deposit', '--pool', pool, '--token-ids', '101,102', '--from', operator, '--send-local']);
    check('preDepositIncomeCollectedIntoPool', await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [pool]) === 5_100_000n);
    await step('activate', ['activate', '--pool', pool, '--config', poolFile, '--from', operator, '--send-local']);
    check('activationRecognizedSetupIncome', await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'totalAccounted') === 5_100_000n);
    await step('deposit-after-activation', ['deposit', '--pool', pool, '--token-ids', '103,104', '--from', operator, '--send-local']);

    // 2. Harvest all miners (one only has income pending() does not report), then claims.
    await write(mining, mockMiningAbi as Abi, 'accrue', [nft, 101n, 1_000_000n]);
    await write(mining, mockMiningAbi as Abi, 'accrueUnsettled', [nft, 103n, 4_000_000n]);
    await write(mining, mockMiningAbi as Abi, 'accrue', [nft, 104n, 77_777n]);
    const beforeHarvest = await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'totalAccounted');
    await step('harvest-all', ['harvest', '--pool', pool, '--all', '--from', keeper, '--send-local', '--batch-size', '3']);
    check('harvestAccountedActualReceipts', await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'totalAccounted') - beforeHarvest === 5_077_777n);

    const aliceClaim = await step('alice-claim-all', ['claim', '--pool', pool, '--all', '--from', alice, '--send-local']);
    check('aliceReceivedExpected', await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [alice]) === BigInt(aliceClaim.expectedPayoutRaw as string | bigint));
    await step('bob-claim-all', ['claim', '--pool', pool, '--all', '--from', bob, '--send-local']);

    // 3. New income, then alice transfers NAND #1 (unclaimed) to carol: former holder rejected, carol paid.
    await write(mining, mockMiningAbi as Abi, 'accrue', [nft, 104n, 10_200_000n]);
    await step('harvest-range', ['harvest', '--pool', pool, '--all', '--from', keeper, '--send-local']);
    const unclaimed1 = await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'claimable', [CATEGORY.NAND, 1n]);
    check('id1HasUnclaimedIncome', unclaimed1 > 0n);
    await write(nandReceipt, tapeoutReceiptAbi as Abi, 'safeTransferFrom', [alice, carol, 1n, 1n, '0x'], alice);
    const rejected = await step('former-holder-simulation', ['claim', '--pool', pool, '--holder', alice, '--nand', '1', '--from', alice]);
    const sim = (rejected.plans as { simulation: { ok: boolean; error?: string } }[])[0].simulation;
    check('formerHolderRejectedNotHolder', !sim.ok && /NotHolder\(0, 1\)/.test(sim.error ?? ''), sim);
    const carolBefore = await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [carol]);
    const carolClaim = await step('new-holder-claim-all', ['claim', '--pool', pool, '--all', '--from', carol, '--send-local']);
    const carolGot = await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [carol]) - carolBefore;
    check('newHolderReceivedTransferredEntitlement', carolGot === BigInt(carolClaim.expectedPayoutRaw as string | bigint) && carolGot >= unclaimed1);
    check('id1NowFullyClaimed', await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'claimable', [CATEGORY.NAND, 1n]) === 0n);

    // 4. Releases are permissionless pushes to the configured recipients.
    await step('release', ['release', '--pool', pool, '--from', outsider, '--send-local']);
    check('recipientsPaid', (await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [feeTo])) > 0n && (await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [histNandTo])) > 0n && (await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [histLatchTo])) > 0n);
    check('outsiderReceivedNothing', (await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [outsider])) === 0n);

    // 5. A failing miner is isolated by simulation and excluded; the others are harvested.
    await write(mining, mockMiningAbi as Abi, 'setKeyBroken', [nft, 103n, true]);
    for (const id of [101n, 102n, 103n, 104n]) await write(mining, mockMiningAbi as Abi, 'accrue', [nft, id, 500_000n]);
    const isolated = await step('harvest-isolate-failures', ['harvest', '--pool', pool, '--all', '--isolate-failures', '--from', keeper, '--send-local']);
    check('failingMinerIsolated', json(isolated.excludedFailingMiners) === json(['103']), isolated.excludedFailingMiners);

    // 6. Exports: Safe batch file and the printed cast command (raw calldata) both work.
    const planned = await step('release-safe-export', ['release', '--pool', pool, '--safe-json', `${DIR}/release.safe.json`]);
    check('safeBatchWritten', planned.safeBatchFile === `${DIR}/release.safe.json`);
    const harvestPlan = await cli(['harvest', '--pool', pool, '--token-ids', '101', '--rpc-url', node.url]) as { plans: { to: Address; data: Hex }[] };
    const castOut = execFileSync('cast', ['send', '--rpc-url', node.url, '--unlocked', '--from', keeper, harvestPlan.plans[0].to, harvestPlan.plans[0].data, '--json'], { encoding: 'utf8' });
    check('castRawCalldataExecutes', JSON.parse(castOut).status === '0x1');

    // 7. Final reconciliation through the CLI, including the per-ID history sums.
    await step('reconcile-deep', ['reconcile', '--pool', pool, '--deep', '--out', 'reports/local-e2e-reconcile.json']);
    const reconcile = await cli(['reconcile', '--pool', pool, '--deep', '--rpc-url', node.url]) as { status: string };
    check('reconcilePass', reconcile.status === 'PASS', reconcile);
    const payees = [alice, bob, carol, reserve, feeTo, histNandTo, histLatchTo];
    let paid = 0n;
    for (const p of payees) paid += await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [p]);
    check('payeeBalancesEqualTotalPaid', paid === await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'totalPaid'));
    const supply = await read<bigint>(bem, erc20Abi as Abi, 'totalSupply');
    check('allBemAccountedFor', supply === paid + await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [pool]));

    // 8. The CLI entrypoint itself (separate process).
    const inspect = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'cli/pool.ts', 'inspect', '--pool', pool, '--holder', reserve, '--miners', '--pending', '--rpc-url', node.url], { encoding: 'utf8' }));
    check('cliEntrypointInspect', inspect.summary.active === true && inspect.holdings.NAND.ids.length === 2 && inspect.miners.length === 4);
    report.final = inspect.summary;
    report.status = 'PASS';
  } finally {
    await node.stop();
  }
}

main().catch(error => {
  report.status = 'FAIL';
  report.error = error instanceof Error ? error.message : String(error);
}).finally(async () => {
  await writeFile('reports/local-e2e.json', json(report) + '\n');
  console.log(json({ status: report.status, checks: report.checks, steps: report.steps.length, error: report.error, report: 'reports/local-e2e.json' }));
  if (report.status !== 'PASS') process.exitCode = 1;
});
