#!/usr/bin/env node
/**
 * Local end-to-end run of the operator CLI on a throwaway Anvil chain with the mock protocol: the full
 * workflow from receipt deployment to user claims. Writes reports/local-e2e.json. All transaction
 * hashes belong to the temporary local chain only.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createPublicClient, encodeDeployData, encodeFunctionData, http, parseEventLogs, type Abi, type Address, type Hex } from 'viem';
import { main as cli, json } from '../cli/pool.ts';
import { startAnvil } from './lib/anvil.ts';
import bytecode from '../sdk/bytecode.json' with { type: 'json' };
import { mockBEMAbi, mockMiningAbi, mockNFTAbi, tapeoutEntitlementReceiptAbi, tapeoutMinerPoolAbi } from '../sdk/abi.ts';
import { CATEGORY, erc20Abi } from '../sdk/constants.ts';

const DIR = '.runtime/local-e2e';
const BEM = 10n ** 8n;
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
    const [operator, depositor, alice, bob, carol, keeper, outsider, recipientA, recipientB] = accounts;
    const send = async (from: Address, to: Address | null, data: Hex) => {
      const hash = await rpc.request({ method: 'eth_sendTransaction', params: [{ from, ...(to ? { to } : {}), data }] } as never) as Hex;
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`setup tx failed ${hash}`);
      return receipt;
    };
    const deploy = async (name: 'MockBEM' | 'MockMining' | 'MockNFT', abi: Abi, args: unknown[] = []) =>
      (await send(operator, null, encodeDeployData({ abi, bytecode: bytecode[name].bytecode as Hex, args }))).contractAddress as Address;
    const write = (to: Address, abi: Abi, functionName: string, args: unknown[], from = operator) => send(from, to, encodeFunctionData({ abi, functionName, args } as never));
    const read = <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) => rpc.readContract({ address, abi, functionName, args } as never) as Promise<T>;
    const step = async (label: string, argv: string[]) => {
      const result = await cli([...argv, '--rpc-url', node.url]) as Record<string, unknown>;
      const txs = (result.transactions as { hash: Hex; gasUsed: bigint; description: string }[] | undefined) ?? [];
      report.steps.push({ label, argv, mode: result.mode, transactions: txs.map(t => ({ hash: t.hash, gasUsed: t.gasUsed, description: t.description })), result: txs.length ? undefined : result });
      return result;
    };
    const fails = async (label: string, argv: string[]) => {
      try {
        await cli([...argv, '--rpc-url', node.url]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.steps.push({ label, argv, rejected: message.slice(0, 600) });
        return message;
      }
      throw new Error(`${label} unexpectedly succeeded`);
    };

    const bem = await deploy('MockBEM', mockBEMAbi as Abi);
    const mining = await deploy('MockMining', mockMiningAbi as Abi, [bem]);
    const nft = await deploy('MockNFT', mockNFTAbi as Abi);
    const systemFile = `${DIR}/system.json`;
    const addressesFile = `${DIR}/addresses.json`;
    await writeFile(systemFile, json({
      chainId: 31337,
      protocol: { bem, mining, minerCollection: nft },
      receipts: { issuer: operator, nand: { name: 'Local NAND Entitlement', symbol: 'lNAND', uri: '' }, latch: { name: 'Local LATCH Entitlement', symbol: 'lLATCH', uri: '' } },
      pool: { name: 'Local E2E Pool', owner: operator, recipientA, recipientB, depositors: [depositor] },
      distributor: { owner: operator },
    }));

    // 1. Receipts: deploy independently, issue in batches to the operator, finalize.
    await step('check-system', ['check-system', '--system', systemFile]);
    const deployed = await step('deploy-receipts', ['deploy-receipts', '--system', systemFile, '--addresses-out', addressesFile, '--from', operator, '--send-local']);
    check('receiptsDeployedIndependently', !!(deployed.addresses as Record<string, string>).nandReceipt);
    const issued = await step('issue-nand', ['issue', '--addresses', addressesFile, '--category', 'NAND', '--to', operator, '--count', '30', '--batch-size', '12', '--from', operator, '--send-local']);
    check('issuanceBatched', (issued.transactions as unknown[]).length === 3);
    await step('issue-latch', ['issue', '--addresses', addressesFile, '--category', 'LATCH', '--to', operator, '--count', '10', '--from', operator, '--send-local']);
    // Over-issue by mistake, then undo it before finalization.
    await step('issue-latch-too-many', ['issue', '--addresses', addressesFile, '--category', 'LATCH', '--to', operator, '--count', '3', '--from', operator, '--send-local']);
    await step('retract-latch', ['retract', '--addresses', addressesFile, '--category', 'LATCH', '--count', '3', '--from', operator, '--send-local']);
    const latchAddress = JSON.parse(await readFile(addressesFile, 'utf8')).latchReceipt as Address;
    check('overIssuanceRetracted', await read<bigint>(latchAddress, tapeoutEntitlementReceiptAbi as Abi, 'totalSupply') === 10n);
    await step('finalize-nand', ['finalize-issuance', '--addresses', addressesFile, '--category', 'NAND', '--from', operator, '--send-local']);
    await step('finalize-latch', ['finalize-issuance', '--addresses', addressesFile, '--category', 'LATCH', '--from', operator, '--send-local']);
    let addresses = JSON.parse(await readFile(addressesFile, 'utf8'));
    await fails('issue-after-finalization', ['issue', '--addresses', addressesFile, '--category', 'NAND', '--to', operator, '--count', '1', '--from', operator, '--send-local']);
    check('supplyFixedAfterFinalization', await read<bigint>(addresses.nandReceipt, tapeoutEntitlementReceiptAbi as Abi, 'totalSupply') === 30n);

    // 2. Pool and distributor bound to the existing receipts; fund the distributor.
    await step('deploy-pool-and-distributor', ['deploy', '--system', systemFile, '--addresses', addressesFile, '--from', operator, '--send-local']);
    addresses = JSON.parse(await readFile(addressesFile, 'utf8'));
    const pool = addresses.pool as Address;
    const distributor = addresses.distributor as Address;
    // Plan mode (the mainnet path): the distributor deployment is planned from the recorded pool address.
    const planned = await step('plan-distributor-deployment', ['deploy-distributor', '--system', systemFile, '--addresses', addressesFile, '--from', operator]);
    const plan = (planned.plans as { to: Address | null; simulation?: { ok: boolean } }[])[0];
    check('distributorDeploymentPlannedFromPool', planned.mode === 'PLAN_ONLY_NOT_SENT' && plan.to === null && plan.simulation?.ok === true, planned);
    await step('fund-nand', ['fund-distributor', '--addresses', addressesFile, '--category', 'NAND', '--from', operator, '--all-held', '--batch-size', '7', '--send-local']);
    await step('fund-latch', ['fund-distributor', '--addresses', addressesFile, '--category', 'LATCH', '--from', operator, '--all-held', '--send-local']);

    // 3. JSON allocation import -> verify -> finalize.
    const allocationFile = `${DIR}/allocation.json`;
    await writeFile(allocationFile, json({ allocations: [
      { wallet: alice, nandCount: 20, latchCount: 5 }, { wallet: bob, nandCount: 10, latchCount: 0 }, { wallet: carol, nandCount: 0, latchCount: 5 },
    ] }));
    const badFile = `${DIR}/allocation-bad.json`;
    await writeFile(badFile, json({ allocations: [{ wallet: alice, nandCount: 25, latchCount: 5 }, { wallet: alice, nandCount: 5, latchCount: 5 }] }));
    const rejected = await fails('import-rejects-duplicate-wallet', ['import-allocation', '--addresses', addressesFile, '--allocation', badFile, '--from', operator, '--send-local']);
    check('importRejectsDuplicates', /already listed/.test(rejected), rejected);
    await writeFile(badFile, json({ allocations: [{ wallet: alice, nandCount: 29, latchCount: 10 }] }));
    const coverage = await fails('import-rejects-uncovered-inventory', ['import-allocation', '--addresses', addressesFile, '--allocation', badFile, '--from', operator, '--send-local']);
    check('importRequiresCoverage', /holds 30/.test(coverage), coverage);
    // A contract wallet without an ERC-1155 receiver hook (the mock NFT stands in for one) could never take delivery.
    await writeFile(badFile, json({ allocations: [{ wallet: alice, nandCount: 20, latchCount: 5 }, { wallet: nft, nandCount: 10, latchCount: 0 }, { wallet: carol, nandCount: 0, latchCount: 5 }] }));
    const unreachable = await fails('import-rejects-non-receiver-contract', ['import-allocation', '--addresses', addressesFile, '--allocation', badFile, '--from', operator, '--send-local']);
    check('importRejectsWalletThatCannotReceive', /cannot receive ERC-1155/.test(unreachable) && unreachable.toLowerCase().includes(nft.toLowerCase()), unreachable);
    const imported = await step('import-allocation', ['import-allocation', '--addresses', addressesFile, '--allocation', allocationFile, '--artifact-out', `${DIR}/artifact.json`, '--batch-size', '9', '--from', operator, '--send-local']);
    check('importBatched', (imported.transactions as unknown[]).length >= 4);
    const again = await step('import-resume-is-noop', ['import-allocation', '--addresses', addressesFile, '--allocation', allocationFile]);
    check('importResumeHasNothingLeft', (again.plans as unknown[]).length === 0 && again.alreadyImported === 3);
    // Correct one wallet before finalization: revoke it, see verification fail, re-import (resume restores it).
    await step('revoke-carol', ['revoke-wallet', '--addresses', addressesFile, '--wallet', carol, '--from', operator, '--send-local']);
    const incomplete = await step('verify-after-revoke', ['verify-allocation', '--addresses', addressesFile, '--artifact', `${DIR}/artifact.json`]);
    check('revokedWalletBlocksFinalization', incomplete.status === 'NOT_READY', incomplete);
    const restored = await step('reimport-carol', ['import-allocation', '--addresses', addressesFile, '--allocation', allocationFile, '--from', operator, '--send-local']);
    check('reimportOnlyRestoresTheRevokedWallet', (restored.transactions as unknown[]).length === 1 && restored.alreadyImported === 2, restored);
    const verified = await step('verify-allocation', ['verify-allocation', '--addresses', addressesFile, '--artifact', `${DIR}/artifact.json`]);
    check('allocationVerified', verified.status === 'READY_TO_FINALIZE', verified);
    await step('finalize-allocation', ['finalize-allocation', '--addresses', addressesFile, '--from', operator, '--send-local']);

    // 4. Activation, then every ownership renounced separately.
    await fails('activate-rejects-wrong-counts', ['activate', '--addresses', addressesFile, '--nand-shares', '31', '--latch-shares', '10', '--from', operator, '--send-local']);
    await step('activate', ['activate', '--addresses', addressesFile, '--nand-shares', '30', '--latch-shares', '10', '--from', operator, '--send-local']);
    for (const target of ['pool', 'distributor', 'nand', 'latch']) await step(`renounce-${target}`, ['renounce', '--addresses', addressesFile, '--target', target, '--from', operator, '--send-local']);
    check('allOwnershipsRenounced', (await read<Address>(pool, tapeoutMinerPoolAbi as Abi, 'owner')) === '0x0000000000000000000000000000000000000000');

    // 5. Admissions by the whitelisted depositor: the specification's acceptance example.
    for (const [id, n, l] of [[1n, 9, 1], [2n, 1, 9], [3n, 4, 4], [4n, 2, 2]] as const) {
      await write(nft, mockNFTAbi as Abi, 'mint', [depositor, id]);
      await write(mining, mockMiningAbi as Abi, 'start', [nft, id, n, l]);
    }
    const comp = await step('composition', ['composition', '--addresses', addressesFile, '--token-ids', '1-2']);
    check('compositionReadable', (comp.miners as { admissible: boolean }[]).every(m => m.admissible));
    await step('deposit-first-miner', ['deposit', '--addresses', addressesFile, '--token-ids', '1', '--from', depositor, '--send-local']);
    await write(mining, mockMiningAbi as Abi, 'accrue', [nft, 1n, 102n * BEM]);
    await write(mining, mockMiningAbi as Abi, 'accrue', [nft, 2n, 102n * BEM]);
    await step('deposit-second-miner', ['deposit', '--addresses', addressesFile, '--token-ids', '2', '--from', depositor, '--send-local']);
    const accrual = await read<{ nandIncome: bigint; latchIncome: bigint; recipientA: bigint; recipientB: bigint }>(pool, tapeoutMinerPoolAbi as Abi, 'accrual');
    check('acceptanceExampleNand140Latch60', accrual.nandIncome === 140n * BEM && accrual.latchIncome === 60n * BEM && accrual.recipientA === 2n * BEM && accrual.recipientB === 2n * BEM, accrual);
    check('depositorKeptNothing', (await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [depositor])) === 0n);

    // 6. Unauthorized admission paths.
    await write(nft, mockNFTAbi as Abi, 'mint', [alice, 5n]);
    await write(mining, mockMiningAbi as Abi, 'start', [nft, 5n, 1, 1]);
    const notWhitelisted = await fails('deposit-by-non-depositor', ['deposit', '--addresses', addressesFile, '--token-ids', '5', '--from', alice, '--send-local']);
    check('nonDepositorRejected', /not a whitelisted depositor/.test(notWhitelisted), notWhitelisted);
    await write(nft, mockNFTAbi as Abi, 'transferFrom', [alice, pool, 5n], alice);
    const bypass = await fails('register-by-non-depositor', ['register', '--addresses', addressesFile, '--token-ids', '5', '--from', alice, '--send-local']);
    check('registrationBypassRejected', /not a whitelisted depositor/.test(bypass), bypass);
    check('plainTransferDidNotAdmit', (await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'minerCount')) === 2n);

    // 7. Users claim receipts (late) and BEM; entitlement follows a transfer.
    await step('alice-claims-receipts', ['claim-receipts', '--addresses', addressesFile, '--from', alice, '--send-local']);
    const aliceClaim = await step('alice-claims-bem', ['claim', '--addresses', addressesFile, '--from', alice, '--all', '--send-local']);
    check('aliceExactPayout', (await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [alice])) === BigInt(aliceClaim.expectedPayoutRaw as string | bigint));
    await write(mining, mockMiningAbi as Abi, 'accrue', [nft, 1n, 51n * BEM]);
    await step('harvest', ['harvest', '--addresses', addressesFile, '--all', '--from', keeper, '--send-local']);
    await step('bob-claims-receipts-late', ['claim-receipts', '--addresses', addressesFile, '--from', bob, '--send-local']);
    const nandReceipt = addresses.nandReceipt as Address;
    const due = await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'claimable', [CATEGORY.NAND, 21n]);
    check('lateReceiptKeptAccumulatedBem', due > 0n);
    await write(nandReceipt, tapeoutEntitlementReceiptAbi as Abi, 'safeTransferFrom', [bob, carol, 21n, 1n, '0x'], bob);
    const former = await step('former-holder-simulation', ['claim', '--addresses', addressesFile, '--holder', bob, '--nand', '21', '--from', bob]);
    const sim = (former.plans as { simulation: { ok: boolean; error?: string } }[])[0].simulation;
    check('formerHolderRejected', !sim.ok && /NotHolder\(0, 21\)/.test(sim.error ?? ''), sim);
    await step('carol-claims-receipts', ['claim-receipts', '--addresses', addressesFile, '--from', carol, '--send-local']);
    const carolBefore = await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [carol]);
    await step('carol-claims-bem', ['claim', '--addresses', addressesFile, '--from', carol, '--all', '--send-local']);
    check('newHolderGotTransferredEntitlement', (await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [carol])) - carolBefore >= due);
    await step('release', ['release', '--addresses', addressesFile, '--from', outsider, '--send-local']);
    check('outsiderReceivedNothing', (await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [outsider])) === 0n);

    // 8. Inactive old miner is skipped explicitly; a failing ACTIVE old miner rolls admission back.
    await write(mining, mockMiningAbi as Abi, 'setStatus', [nft, 1n, 2]);
    const skipped = await step('deposit-with-inactive-old-miner', ['deposit', '--addresses', addressesFile, '--token-ids', '3', '--from', depositor, '--send-local']);
    const skipReceipt = await rpc.getTransactionReceipt({ hash: (skipped.transactions as { hash: Hex }[]).at(-1)!.hash });
    const skipLogs = parseEventLogs({ abi: tapeoutMinerPoolAbi as Abi, eventName: 'InactiveMinerSkipped', logs: skipReceipt.logs });
    check('inactiveMinerSkippedExplicitly', skipLogs.length === 1);
    await write(mining, mockMiningAbi as Abi, 'setKeyBroken', [nft, 2n, true]);
    const rollback = await fails('deposit-rolls-back-on-failed-settlement', ['deposit', '--addresses', addressesFile, '--token-ids', '4', '--from', depositor, '--send-local']);
    check('failedSettlementRolledBack', /SettlementFailed\(2,/.test(rollback) && (await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'minerCount')) === 3n, rollback);
    await write(mining, mockMiningAbi as Abi, 'setKeyBroken', [nft, 2n, false]);
    await step('deposit-after-recovery', ['deposit', '--addresses', addressesFile, '--token-ids', '4', '--from', depositor, '--send-local']);

    // 9. Reconciliation and the CLI entrypoint.
    const reconcile = await step('reconcile-deep', ['reconcile', '--addresses', addressesFile, '--deep', '--out', 'reports/local-e2e-reconcile.json']);
    check('reconcilePass', reconcile.status === 'PASS', reconcile);
    const inspect = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'cli/pool.ts', 'inspect', '--addresses', addressesFile, '--holder', alice, '--miners', '--pending', '--rpc-url', node.url], { encoding: 'utf8' }));
    check('cliEntrypointInspect', inspect.pool.active === true && inspect.miners.length === 4 && inspect.holdings.NAND.ids.length === 20);
    report.final = inspect.pool;
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
