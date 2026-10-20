#!/usr/bin/env node
/**
 * Local end-to-end run of the HistoricalDistributor CLI flow on a throwaway Anvil chain with the mock
 * protocol: a real pool with the distributor as its historical NAND recipient, deployment checks,
 * releases, pushed and self claims, deep audits, a full 400-contributor list, and the per-transaction
 * gas guards (BSC BEP-652). Every write transaction is planned first; it must be sent with the plan's
 * worst-case `maxGas` as its gas limit and use no more than that. Writes reports/distributor-e2e.json.
 * All transaction hashes belong to the temporary local chain only.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createPublicClient, encodeDeployData, encodeFunctionData, http, keccak256, toHex, type Abi, type Address, type Hex } from 'viem';
import { main as cli, json } from '../cli/pool.ts';
import { startAnvil } from './lib/anvil.ts';
import bytecode from '../sdk/bytecode.json' with { type: 'json' };
import { historicalDistributorAbi, mockBEMAbi, mockMiningAbi, mockNFTAbi, tapeoutMinerPoolAbi } from '../sdk/abi.ts';
import { CATEGORY, erc20Abi } from '../sdk/constants.ts';
import { BATCH_GAS_BUDGET } from '../sdk/gas.ts';

const DIR = '.runtime/distributor-e2e';
const BEM = 10n ** 8n;
const report: { scope: string; startedAt: string; status: string; steps: unknown[]; checks: Record<string, boolean>; final?: unknown; error?: string } = {
  scope: 'LOCAL_ANVIL_MOCK_PROTOCOL_ONLY', startedAt: new Date().toISOString(), status: 'IN_PROGRESS', steps: [], checks: {},
};

interface Plan { description: string; to: Address | null; data: Hex; maxGas?: bigint; cast: string; simulation?: { ok: boolean; gas?: bigint; returnData?: Hex; error?: string; aboveBatchGasBudget?: boolean; exceedsTxGasCap?: boolean } }
interface Sent { hash: Hex; gasUsed: bigint; description: string }
type Result = Record<string, unknown> & { plans?: Plan[]; transactions?: Sent[]; contributors?: unknown[] };

function check(name: string, ok: boolean, detail?: unknown) {
  report.checks[name] = ok;
  if (!ok) throw new Error(`CHECK_FAILED ${name} ${detail === undefined ? '' : json(detail)}`);
}

/** Reports keep plans without calldata and large lists short (a 900-ID claim batch or a deep
 *  inspect of 400 contributors would otherwise dominate the file). */
const compact = (result: Result) => ({
  ...result,
  ...(result.plans ? { plans: result.plans.map(({ data: _data, cast: _cast, simulation, ...rest }) => ({ ...rest, ...(simulation ? { simulation: { ...simulation, returnData: undefined } } : {}) })) } : {}),
  ...(Array.isArray(result.contributors) && result.contributors.length > 10 ? { contributors: { count: result.contributors.length } } : {}),
});

async function main() {
  await mkdir(DIR, { recursive: true });
  await mkdir('reports', { recursive: true });
  const node = await startAnvil(18547, ['--chain-id', '31337', '--silent', '--accounts', '20']);
  try {
    const rpc = createPublicClient({ transport: http(node.url) });
    const accounts = await rpc.request({ method: 'eth_accounts' } as never) as Address[];
    const [operator, alice, bob, keeper, feeTo, histLatchTo, c1, c2, c3, outsider] = accounts;
    const same = (a: unknown, b: Address) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

    const send = async (from: Address, to: Address | null, data: Hex) => {
      const hash = await rpc.request({ method: 'eth_sendTransaction', params: [{ from, ...(to ? { to } : {}), data }] } as never) as Hex;
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`setup tx failed ${hash}`);
      return receipt;
    };
    const deployMock = async (name: 'MockBEM' | 'MockMining' | 'MockNFT', abi: Abi, args: unknown[] = []) =>
      (await send(operator, null, encodeDeployData({ abi, bytecode: bytecode[name].bytecode as Hex, args }))).contractAddress as Address;
    const write = (to: Address, abi: Abi, functionName: string, args: unknown[], from = operator) =>
      send(from, to, encodeFunctionData({ abi, functionName, args } as never));
    const read = <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
      rpc.readContract({ address, abi, functionName, args } as never) as Promise<T>;
    const step = async (label: string, argv: string[]) => {
      const result = await cli([...argv, '--rpc-url', node.url]) as Result;
      const txs = result.transactions ?? [];
      report.steps.push({ label, argv, mode: result.mode, transactions: txs.map(t => ({ hash: t.hash, gasUsed: t.gasUsed, description: t.description })), result: txs.length ? undefined : compact(result) });
      return result;
    };
    /** Plan first, then send the same plans locally: each transaction is sent with its plan's maxGas
     *  as the gas limit and must use at most that. */
    const sendChecked = async (label: string, argv: string[], from: Address) => {
      const planned = await cli([...argv, '--rpc-url', node.url]) as Result;
      const sent = await step(label, [...argv, '--from', from, '--send-local']);
      const plans = planned.plans ?? [];
      const txs = sent.transactions ?? [];
      const within = plans.length === txs.length && txs.every((t, i) => plans[i].maxGas !== undefined && t.gasUsed <= plans[i].maxGas! && plans[i].maxGas! <= BATCH_GAS_BUDGET);
      check(`gasWithinModel:${label}`, within, txs.map((t, i) => ({ gasUsed: t.gasUsed, maxGas: plans[i]?.maxGas, description: t.description })));
      const limits = await Promise.all(txs.map(t => rpc.getTransaction({ hash: t.hash }).then(tx => tx.gas)));
      check(`gasLimitIsPlanMaxGas:${label}`, limits.every((gas, i) => gas === plans[i].maxGas), limits.map((gas, i) => ({ gasLimit: gas, maxGas: plans[i]?.maxGas })));
      return sent;
    };
    const refused = async (argv: string[]) => {
      try {
        await cli([...argv, '--rpc-url', node.url]);
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };

    const bem = await deployMock('MockBEM', mockBEMAbi as Abi);
    const mining = await deployMock('MockMining', mockMiningAbi as Abi, [bem]);
    const nft = await deployMock('MockNFT', mockNFTAbi as Abi);
    const balance = (account: Address) => read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [account]);

    // 1. The pool exists first: the distributor binds to it.
    const poolFile = `${DIR}/pool.json`;
    const poolDefinition = (historicalNand: Address) => ({
      chainId: 31337,
      protocol: { bem, mining, minerCollection: nft },
      pool: { name: 'Distributor E2E Pool', owner: operator, nandReceipt: { name: 'D NAND', symbol: 'dNAND', uri: '' }, latchReceipt: { name: 'D LATCH', symbol: 'dLATCH', uri: '' } },
      economics: { nandShares: 900, latchShares: 80, historicalNandShares: 100, historicalLatchShares: 20, nandWeight: '0.8' },
      recipients: { fee: feeTo, historicalNand, historicalLatch: histLatchTo },
    });
    await writeFile(poolFile, json(poolDefinition(outsider)));
    const deployed = await sendChecked('deploy-pool', ['deploy', '--config', poolFile], operator);
    const pool = deployed.pool as Address;

    // 2. Weights file: offline check, deployment plan and pool checks, then a local deployment.
    const weightsFile = `${DIR}/historical-nand.json`;
    await writeFile(weightsFile, json({ category: 'NAND', totalWeight: 100, contributors: [
      { account: c1, weight: 50, ref: 'c1' }, { account: c2, weight: 30, ref: 'c2' }, { account: c3, weight: 20, ref: 'c3' },
    ] }));
    const checked = await step('distributor-check', ['distributor-check', '--weights', weightsFile, '--pool', pool, '--income', '80', '--out', `${DIR}/args.json`]);
    check('checkValid', checked.status === 'WEIGHTS_VALID' && (checked.preview as { residueRaw: bigint }).residueRaw === 0n, checked.preview);
    const planned = await step('distributor-deploy-plan', ['distributor-deploy', '--weights', weightsFile, '--pool', pool, '--from', operator]);
    const deployPlan = planned.plans![0];
    check('deployPlanOnly', planned.mode === 'PLAN_ONLY_NOT_SENT' && planned.plans!.length === 1 && deployPlan.to === null && deployPlan.simulation?.ok === true, deployPlan.simulation);
    check('deployPlanHasCastCreate', /cast send .* --create 0x/.test(deployPlan.cast));
    const poolChecks = planned.poolChecks as { historicalShares: bigint; warnings: string[] };
    check('poolChecksWarnBeforeConfiguration', poolChecks.historicalShares === 0n && poolChecks.warnings.length === 1, poolChecks);
    const safeCreate = await refused(['distributor-deploy', '--weights', weightsFile, '--pool', pool, '--safe-json', `${DIR}/never.json`]);
    check('safeCannotCreate', /Contract creation cannot be batched/.test(safeCreate), safeCreate);
    const sent = await sendChecked('distributor-deploy', ['distributor-deploy', '--weights', weightsFile, '--pool', pool], operator);
    const distributor = sent.distributor as Address;
    check('deployedListHashMatches', sent.listHashMatches === true && sent.onChainContributorsHash === checked.contributorsHash);

    // 3. The distributor becomes the historical NAND recipient through the configuration.
    await writeFile(poolFile, json(poolDefinition(distributor)));
    await sendChecked('configure', ['configure', '--pool', pool, '--config', poolFile], operator);
    const allocationFile = `${DIR}/allocation.json`;
    await writeFile(allocationFile, json({ nand: [{ holder: alice, shares: 900 }], latch: [{ holder: bob, shares: 80 }] }));
    const issued = await sendChecked('issue', ['issue', '--pool', pool, '--config', poolFile, '--allocation', allocationFile], operator);
    check('issuedInBatchesOf200', (issued.transactions ?? []).length === 6);
    await sendChecked('activate', ['activate', '--pool', pool, '--config', poolFile], operator);
    for (const id of [1n, 2n, 3n]) {
      await write(nft, mockNFTAbi as Abi, 'mint', [operator, id]);
      await write(mining, mockMiningAbi as Abi, 'start', [nft, id]);
    }
    await sendChecked('deposit', ['deposit', '--pool', pool, '--token-ids', '1,2,3'], operator);
    await write(mining, mockMiningAbi as Abi, 'accrue', [nft, 1n, 500n * BEM]);
    await write(mining, mockMiningAbi as Abi, 'accrue', [nft, 2n, 300n * BEM]);
    await write(mining, mockMiningAbi as Abi, 'accrueUnsettled', [nft, 3n, 220n * BEM]); // pending() does not show it
    await sendChecked('harvest', ['harvest', '--pool', pool, '--all'], keeper);
    check('harvested1020Bem', await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'totalAccounted') === 1020n * BEM);

    // 4. Before release: the role, the pending amount and the reviewed file all check out.
    const before = await step('distributor-inspect', ['distributor-inspect', '--distributor', distributor, '--weights', weightsFile, '--deep', '--contributor', c1]);
    const summary = before.summary as { isPoolRecipient: boolean; pendingFromPool: bigint };
    check('inspectPass', before.status === 'PASS', before.checks);
    check('isPoolRecipientWithPendingIncome', summary.isPoolRecipient && summary.pendingFromPool === 80n * BEM, summary);
    check('fileMatchesDeployment', Object.values(before.fileChecks as Record<string, boolean>).every(Boolean), before.fileChecks);
    check('contributorViewBeforeRelease', (before.contributor as { isContributor: boolean; claimableRaw: bigint }).claimableRaw === 0n);
    const stranger = await step('distributor-inspect-outsider', ['distributor-inspect', '--distributor', distributor, '--contributor', outsider]);
    check('outsiderIsNotAContributor', (stranger.contributor as { isContributor: boolean }).isContributor === false);

    // 5. A keeper releases and pays everyone: 80 BEM split 50/30/20.
    const all = await sendChecked('distributor-claim-release-all', ['distributor-claim', '--distributor', distributor, '--release', '--all', '--batch-size', '2'], keeper);
    check('releaseAndTwoClaimBatches', (all.transactions ?? []).length === 3, all.transactions);
    check('expectedPayoutPrinted', all.expectedPayoutRaw === 80n * BEM, all.expectedPayoutRaw);
    check('contributor1Paid40Bem', await balance(c1) === 40n * BEM);
    check('contributor2Paid24Bem', await balance(c2) === 24n * BEM);
    check('contributor3Paid16Bem', await balance(c3) === 16n * BEM);
    check('keeperPaidNothing', await balance(keeper) === 0n);
    const nothing = await step('distributor-claim-nothing', ['distributor-claim', '--distributor', distributor, '--contributor', c1]);
    check('nothingToClaim', nothing.status === 'NOTHING_TO_CLAIM');

    // 6. More income through the pool's own release; a self claim, a listed claim, refusals.
    await write(mining, mockMiningAbi as Abi, 'accrue', [nft, 1n, 102_000_003n]);
    await sendChecked('harvest-2', ['harvest', '--pool', pool, '--all'], keeper);
    await sendChecked('release-pool', ['release', '--pool', pool], keeper);
    const self = await sendChecked('distributor-claim-self', ['distributor-claim', '--distributor', distributor, '--contributor', c2], c2);
    const payouts = self.payouts as { account: Address }[];
    check('selfClaimPaysOnlyItself', payouts.length === 1 && same(payouts[0].account, c2), payouts);
    const listed = await sendChecked('distributor-claim-listed', ['distributor-claim', '--distributor', distributor, '--contributor', `${c1},${c3},${c1}`], outsider);
    check('listedClaimIsOneTransaction', (listed.transactions ?? []).length === 1);
    const notContributor = await refused(['distributor-claim', '--distributor', distributor, '--contributor', outsider]);
    check('cliRejectsNonContributor', /Not contributors/.test(notContributor), notContributor);

    // 7. A distributor that is not the recipient: the CLI refuses --release, the contract reverts.
    const other = await sendChecked('distributor-deploy-unbound', ['distributor-deploy', '--weights', weightsFile, '--pool', pool], operator);
    const noRole = await refused(['distributor-claim', '--distributor', other.distributor as string, '--release']);
    check('cliRejectsReleaseWithoutRole', /needs the distributor to be the pool's historical NAND recipient/.test(noRole), noRole);
    const contractError = await rpc.call({ account: keeper, to: other.distributor as Address, data: encodeFunctionData({ abi: historicalDistributorAbi, functionName: 'releaseFromPool' }) })
      .then(() => 'no revert', (error: unknown) => String((error as { shortMessage?: string }).shortMessage ?? error));
    check('contractRejectsReleaseWithoutRole', /revert/i.test(contractError), contractError);

    // 8. Deep audits of the distributor and the pool.
    const final = await step('distributor-inspect-final', ['distributor-inspect', '--distributor', distributor, '--weights', weightsFile, '--deep', '--out', `${DIR}/distributor-inspect.json`]);
    check('finalInspectPass', final.status === 'PASS', final.checks);
    const finalSummary = final.summary as { totalAccounted: bigint; totalPaid: bigint };
    check('distributorReceivedAllHistoricalNand', finalSummary.totalAccounted === await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'historicalPaid', [CATEGORY.NAND]));
    check('contributorsHoldTotalPaid', (await balance(c1)) + (await balance(c2)) + (await balance(c3)) === finalSummary.totalPaid);
    const reconcile = await step('pool-reconcile', ['reconcile', '--pool', pool, '--deep']);
    check('poolReconcilePass', reconcile.status === 'PASS', reconcile.checks);

    // 9. A full list (MAX_CONTRIBUTORS = 400) deploys within the gas budget and audits cleanly.
    const fullFile = `${DIR}/historical-400.json`;
    await writeFile(fullFile, json({ category: 'LATCH', contributors: Array.from({ length: 400 }, (_, i) => ({ account: `0x${keccak256(toHex(i)).slice(26)}`, weight: 1 + (i % 97) })) }));
    const full = await sendChecked('distributor-deploy-400', ['distributor-deploy', '--weights', fullFile, '--pool', pool], operator);
    check('fullListDeployed', full.listHashMatches === true);
    const fullInspect = await step('distributor-inspect-400', ['distributor-inspect', '--distributor', full.distributor as string, '--weights', fullFile, '--deep']);
    check('fullListInspectPass', fullInspect.status === 'PASS' && (fullInspect.contributors ?? []).length === 400, fullInspect.checks);
    const tooMany = `${DIR}/historical-401.json`;
    await writeFile(tooMany, json({ category: 'LATCH', contributors: Array.from({ length: 401 }, (_, i) => ({ account: `0x${keccak256(toHex(i)).slice(26)}`, weight: 1 })) }));
    const tooManyError = await refused(['distributor-check', '--weights', tooMany]);
    check('weightsFileAbove400Refused', /at most 400/.test(tooManyError), tooManyError);

    // 10. BEP-652 guards: batch-size maxima, oversized plans, Safe batch files split by gas.
    const issueTooBig = await refused(['issue', '--pool', pool, '--config', poolFile, '--allocation', allocationFile, '--batch-size', '201']);
    check('issueBatchAbove200Refused', /above 200 for issue: BSC limits a transaction's gas to 16777216 \(BEP-652\)/.test(issueTooBig), issueTooBig);
    const claimTooBig = await refused(['distributor-claim', '--distributor', distributor, '--all', '--batch-size', '151']);
    check('distributorBatchAbove150Refused', /above 150/.test(claimTooBig), claimTooBig);
    const longRevoke = await refused(['revoke', '--pool', pool, '--category', 'NAND', '--ids', Array.from({ length: 700 }, (_, i) => i + 1).join(',')]);
    check('oversizedRevokeRefused', /may need up to 14100000 gas/.test(longRevoke), longRevoke);
    const split = await step('claim-safe-split', ['claim', '--pool', pool, '--holder', alice, '--all', '--safe-json', `${DIR}/alice-claim.json`]);
    const files = split.safeBatchFiles as string[];
    check('safeClaimSplitIntoThreeFiles', Array.isArray(files) && files.length === 3 && split.plans!.length === 5, { files, plans: split.plans!.length });
    let covered = 0;
    for (const file of files) {
      const batch = JSON.parse(await readFile(file, 'utf8')) as { transactions: { data: Hex }[] };
      const bound = split.plans!.filter(p => batch.transactions.some(t => t.data === p.data)).reduce((sum, p) => sum + p.maxGas!, 0n);
      covered += batch.transactions.length;
      check(`safeFileWithinBudget:${file.split('/').pop()}`, bound <= BATCH_GAS_BUDGET, { file, transactions: batch.transactions.length, bound });
    }
    check('safeFilesCoverEveryPlanOnce', covered === split.plans!.length);
    const single = await step('release-safe-single', ['release', '--pool', pool, '--safe-json', `${DIR}/release.json`]);
    check('smallSafeBatchStaysOneFile', single.safeBatchFile === `${DIR}/release.json` && single.safeBatchFiles === undefined);
    const simulated = await step('claim-simulated', ['claim', '--pool', pool, '--holder', alice, '--nand', '1,2,3', '--from', alice]);
    const sim = simulated.plans![0];
    check('simulationWithinModelNotFlagged', sim.simulation?.ok === true && sim.simulation.aboveBatchGasBudget === undefined && sim.maxGas! >= sim.simulation.gas!, sim);

    // 11. A printed cast command runs as printed, with the plan's maxGas as its gas limit.
    const printed = await step('release-plan-for-cast', ['release', '--pool', pool]);
    const castPlan = printed.plans![0];
    const castArgs = castPlan.cast.replace('"$RPC_URL"', node.url).replace('<SIGNER_FLAGS>', `--unlocked --from ${keeper}`).split(' ').slice(1);
    const castReceipt = JSON.parse(execFileSync('cast', [...castArgs, '--json'], { encoding: 'utf8' })) as { status: string; transactionHash: Hex };
    const castTx = await rpc.getTransaction({ hash: castReceipt.transactionHash });
    check('printedCastCommandUsesPlanGasLimit', castReceipt.status === '0x1' && castPlan.cast.includes(`--gas-limit ${castPlan.maxGas}`) && castTx.gas === castPlan.maxGas, { cast: castPlan.cast.slice(0, 120), gas: castTx.gas });

    report.final = { pool, distributor, summary: final.summary, checks: final.checks };
    report.status = 'PASS';
  } finally {
    await node.stop();
  }
}

main().catch(error => {
  report.status = 'FAIL';
  report.error = error instanceof Error ? error.message : String(error);
}).finally(async () => {
  await writeFile('reports/distributor-e2e.json', json(report) + '\n');
  console.log(json({ status: report.status, checks: Object.keys(report.checks).length, failed: Object.entries(report.checks).filter(([, ok]) => !ok).map(([name]) => name), steps: report.steps.length, error: report.error, report: 'reports/distributor-e2e.json' }));
  if (report.status !== 'PASS') process.exitCode = 1;
});
