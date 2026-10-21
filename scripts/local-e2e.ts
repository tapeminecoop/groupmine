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
import { loadSystemFile } from '../sdk/config.ts';
import { CATEGORY, erc20Abi } from '../sdk/constants.ts';
import { deployPoolPlan } from '../sdk/pool.ts';

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
    const earlyReceipt = await fails('renounce-receipt-before-finalization', ['renounce', '--addresses', addressesFile, '--target', 'nand', '--from', operator, '--send-local']);
    check('renounceRefusedBeforeIssuanceFinalized', /issuance is not finalized/.test(earlyReceipt), earlyReceipt);
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
    const earlyPool = await fails('renounce-pool-before-activation', ['renounce', '--addresses', addressesFile, '--target', 'pool', '--from', operator, '--send-local']);
    const earlyDistributor = await fails('renounce-distributor-before-finalization', ['renounce', '--addresses', addressesFile, '--target', 'distributor', '--from', operator, '--send-local']);
    check('renounceRefusedBeforeActivationAndAllocation', /not activated/.test(earlyPool) && /allocation is not finalized/.test(earlyDistributor), { earlyPool, earlyDistributor });
    // Plan mode (the mainnet path): the distributor deployment is planned from the recorded pool address.
    const planned = await step('plan-distributor-deployment', ['deploy-distributor', '--system', systemFile, '--addresses', addressesFile, '--from', operator]);
    const plan = (planned.plans as { to: Address | null; simulation?: { ok: boolean }; cast: string }[])[0];
    check('distributorDeploymentPlannedFromPool', planned.mode === 'PLAN_ONLY_NOT_SENT' && plan.to === null && plan.simulation?.ok === true, planned);
    // Remediation O-05: a plan made on a local development node names that context, is bound to its
    // chain, and its printed command targets the local node instead of $RPC_URL.
    const ctx = planned.context as { kind: string; chainId: number };
    check('planBoundToLocalNodeAndChain', ctx.kind === 'LOCAL_DEV_NODE' && ctx.chainId === 31337 && plan.cast.includes(`--rpc-url "${node.url}" --chain 31337`) && !plan.cast.includes('$RPC_URL'), { ctx, cast: plan.cast.slice(0, 80) });
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
    // Verification must cover the whole on-chain allocation (review finding): artifacts that omit a
    // wallet, list no wallets, or name another chain are rejected.
    const fullArtifact = JSON.parse(await readFile(`${DIR}/artifact.json`, 'utf8'));
    const variant = async (label: string, change: (a: typeof fullArtifact) => unknown) => {
      const file = `${DIR}/artifact-${label}.json`;
      await writeFile(file, json(change(structuredClone(fullArtifact))));
      return step(`verify-${label}`, ['verify-allocation', '--addresses', addressesFile, '--artifact', file]);
    };
    const omitted = await variant('omits-bob', a => ({ ...a, wallets: a.wallets.filter((w: { wallet: string }) => w.wallet.toLowerCase() !== bob.toLowerCase()) }));
    check('verifyRejectsArtifactOmittingAWallet', omitted.status === 'MISMATCH' && JSON.stringify(omitted.mismatches).toLowerCase().includes(`${bob.toLowerCase()} is allocated on chain but missing`), omitted);
    const emptyWallets = await variant('no-wallets', a => ({ ...a, wallets: [], totals: { NAND: 0, LATCH: 0, wallets: 0 } }));
    check('verifyRejectsEmptyWalletList', emptyWallets.status === 'MISMATCH', emptyWallets);
    const bare = await fails('verify-bare-wallet-list', ['verify-allocation', '--addresses', addressesFile, '--artifact', await (async () => { const f = `${DIR}/artifact-bare.json`; await writeFile(f, '{"wallets": []}'); return f; })()]);
    check('verifyRejectsUnvalidatedArtifact', /Invalid allocation artifact/.test(bare), bare);
    const wrongChain = await variant('wrong-chain', a => ({ ...a, chainId: 97 }));
    check('verifyRejectsWrongChainIdentity', wrongChain.status === 'MISMATCH', wrongChain);

    // Correct one wallet before finalization: revoke it, see verification fail, re-import (resume restores it).
    await step('revoke-carol', ['revoke-wallet', '--addresses', addressesFile, '--wallet', carol, '--from', operator, '--send-local']);
    const incomplete = await step('verify-after-revoke', ['verify-allocation', '--addresses', addressesFile, '--artifact', `${DIR}/artifact.json`]);
    check('revokedWalletBlocksFinalization', incomplete.status === 'MISMATCH', incomplete);
    // Remediation T-4: finalization re-verifies the current state with the reviewed inputs; it refuses
    // without them, and refuses while the allocation does not match.
    const noInputs = await fails('finalize-without-review-inputs', ['finalize-allocation', '--addresses', addressesFile, '--from', operator, '--send-local']);
    check('finalizeRequiresReviewInputs', /needs --artifact and --allocation/.test(noInputs), noInputs);
    const premature = await fails('finalize-while-revoked', ['finalize-allocation', '--addresses', addressesFile, '--artifact', `${DIR}/artifact.json`, '--allocation', allocationFile, '--from', operator, '--send-local']);
    check('finalizeRefusedWhileAllocationMismatches', /Finalization preflight failed/.test(premature) && /MISMATCH/.test(premature), premature);
    const restored = await step('reimport-carol', ['import-allocation', '--addresses', addressesFile, '--allocation', allocationFile, '--artifact-out', `${DIR}/artifact.json`, '--from', operator, '--send-local']);
    check('reimportOnlyRestoresTheRevokedWallet', (restored.transactions as unknown[]).length === 1 && restored.alreadyImported === 2, restored);
    const verified = await step('verify-allocation', ['verify-allocation', '--addresses', addressesFile, '--artifact', `${DIR}/artifact.json`, '--allocation', allocationFile]);
    const vr = verified as { verified: { wallets: number }; review: { status: string; assignment: { status: string } }; coverage: Record<string, { excluded: { count: number } }>; identity: { pool: { expected: string; distributorPool: string } } };
    check('allocationVerified', verified.status === 'READY_TO_FINALIZE' && vr.verified.wallets === 3, verified);
    // Remediation T-5 and T-3: the reviewed JSON is tied to the artifact, and the whole supply is covered.
    check('reviewedJsonVerifiedAgainstArtifact', vr.review.status === 'VERIFIED' && vr.review.assignment.status === 'VERIFIED', vr.review);
    check('fullSupplyCovered', vr.coverage.NAND.excluded.count === 0 && vr.coverage.LATCH.excluded.count === 0, vr.coverage);
    // Remediation T-01: a second valid pool Q sharing the same receipts. The distributor belongs to P;
    // an addresses file naming Q must not verify, even though every wallet and ID matches.
    const system = await loadSystemFile(systemFile);
    const poolQ = (await send(operator, null, deployPoolPlan(system, addresses.nandReceipt, addresses.latchReceipt).data)).contractAddress as Address;
    const addressesQ = `${DIR}/addresses-q.json`;
    await writeFile(addressesQ, json({ ...addresses, pool: poolQ }));
    const wrongPool = await step('verify-with-another-pool', ['verify-allocation', '--addresses', addressesQ, '--artifact', `${DIR}/artifact.json`, '--allocation', allocationFile]);
    check('verifyRejectsAPoolTheDistributorDoesNotBelongTo', wrongPool.status === 'MISMATCH' && (wrongPool.mismatches as string[]).some(m => m.toLowerCase().includes(`configured pool ${poolQ.toLowerCase()} is not the distributor`)), wrongPool);
    const wrongPoolWrite = await fails('write-with-another-pool', ['release', '--addresses', addressesQ, '--from', outsider, '--send-local']);
    check('writesRefusedForInconsistentDeployment', /Deployment check failed/.test(wrongPoolWrite) && /belongs to pool/.test(wrongPoolWrite), wrongPoolWrite);
    const deploymentOk = await step('verify-deployment', ['verify-deployment', '--addresses', addressesFile, '--system', systemFile]);
    check('deploymentMatchesTemplatesAndBindings', deploymentOk.status === 'MATCHES', deploymentOk);
    const finalizedPlan = await step('finalize-allocation', ['finalize-allocation', '--addresses', addressesFile, '--artifact', `${DIR}/artifact.json`, '--allocation', allocationFile, '--from', operator, '--send-local']);
    check('finalizeRecordsItsVerification', (finalizedPlan.verification as { status: string }).status === 'READY_TO_FINALIZE', finalizedPlan.verification);
    const finalized = await step('verify-after-finalization', ['verify-allocation', '--addresses', addressesFile, '--artifact', `${DIR}/artifact.json`]);
    check('verifyAfterFinalizationMatches', finalized.status === 'FINALIZED_AND_MATCHES', finalized);
    const emptyAfter = await variant('no-wallets-finalized', a => ({ ...a, wallets: [], totals: { NAND: 0, LATCH: 0, wallets: 0 } }));
    check('verifyNeverMatchesEmptyArtifactAfterFinalization', emptyAfter.status === 'MISMATCH', emptyAfter);

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
    const aliceReceipts = await step('alice-claims-receipts', ['claim-receipts', '--addresses', addressesFile, '--from', alice, '--send-local']);
    check('deliveriesReplannedBeforeEachSend', aliceReceipts.replannedBeforeEachSend === true && (aliceReceipts.transactions as unknown[]).length >= 1, aliceReceipts);
    // Remediation P-01: repeated IDs are claimed once; preview and payment agree in the same state.
    const before = await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [alice]);
    const dup = await step('alice-claims-with-repeated-ids', ['claim', '--addresses', addressesFile, '--from', alice, '--nand', '1,1,2', '--latch', '1', '--send-local']);
    const dupNorm = dup.normalized as { removedDuplicates: { NAND: bigint[]; LATCH: bigint[] } } | undefined;
    const dupPaid = (await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [alice])) - before;
    check('repeatedClaimIdsNormalizedAndPreviewEqualsPayment', !!dupNorm && dupNorm.removedDuplicates.NAND.map(String).join(',') === '1' && dupNorm.removedDuplicates.LATCH.length === 0
      && dupPaid === BigInt(dup.expectedPayoutRaw as string | bigint) && dupPaid > 0n, { dup, dupPaid });
    const aliceBefore = await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [alice]);
    const aliceClaim = await step('alice-claims-bem', ['claim', '--addresses', addressesFile, '--from', alice, '--all', '--send-local']);
    check('aliceExactPayout', (await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [alice])) - aliceBefore === BigInt(aliceClaim.expectedPayoutRaw as string | bigint));
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
    // Every receipt has been delivered (and NAND #21 moved on to carol): the artifact must still match.
    const afterDelivery = await step('verify-after-delivery', ['verify-allocation', '--addresses', addressesFile, '--artifact', `${DIR}/artifact.json`]);
    const deliveredIds = (afterDelivery.verified as { delivered: { NAND: bigint; LATCH: bigint } }).delivered;
    check('verifyAfterDeliveryMatches', afterDelivery.status === 'FINALIZED_AND_MATCHES' && deliveredIds.NAND === 30n && deliveredIds.LATCH === 10n, afterDelivery);
    await step('release', ['release', '--addresses', addressesFile, '--from', outsider, '--send-local']);
    check('outsiderReceivedNothing', (await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [outsider])) === 0n);

    // 8. Settlement exceptions (mock fault injection): a REVOKED old miner is skipped explicitly; any
    //    other failure of an old miner (a COOLING status, a failing claim) rolls the admission back.
    await write(mining, mockMiningAbi as Abi, 'setStatus', [nft, 1n, 2]);
    const skipped = await step('deposit-with-revoked-old-miner', ['deposit', '--addresses', addressesFile, '--token-ids', '3', '--from', depositor, '--send-local']);
    const skipReceipt = await rpc.getTransactionReceipt({ hash: (skipped.transactions as { hash: Hex }[]).at(-1)!.hash });
    const skipLogs = parseEventLogs({ abi: tapeoutMinerPoolAbi as Abi, eventName: 'RevokedMinerSkipped', logs: skipReceipt.logs });
    check('revokedMinerSkippedExplicitly', skipLogs.length === 1);
    await write(mining, mockMiningAbi as Abi, 'setStatus', [nft, 2n, 3]);
    const cooling = await fails('deposit-rolls-back-on-cooling-old-miner', ['deposit', '--addresses', addressesFile, '--token-ids', '4', '--from', depositor, '--send-local']);
    check('coolingOldMinerBlocksAdmission', /SettlementFailed\(2,/.test(cooling) && (await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'minerCount')) === 3n, cooling);
    await write(mining, mockMiningAbi as Abi, 'setStatus', [nft, 2n, 1]);
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
