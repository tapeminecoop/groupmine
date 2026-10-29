#!/usr/bin/env node
/**
 * Local end-to-end run of the operator CLI on a throwaway Anvil chain with the mock protocol: the full
 * two-pool workflow (2.3.0) from receipt deployment to user claims. One receipt pair and one
 * distributor serve the Optimal and the Regular Pool; each pool binds the distributor, activates and
 * admits miners on its own, and a holder claims each receipt's income from each pool independently.
 * Writes reports/local-e2e.json. All transaction hashes belong to the temporary local chain only.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createPublicClient, encodeDeployData, encodeFunctionData, http, parseEventLogs, type Abi, type Address, type Hex } from 'viem';
import { main as cli, json } from '../cli/pool.ts';
import { startAnvil } from './lib/anvil.ts';
import bytecode from '../sdk/bytecode.json' with { type: 'json' };
import { mockBEMAbi, mockMiningAbi, mockNFTAbi, tapeoutEntitlementReceiptAbi, tapeoutMinerPoolAbi, tapeoutReceiptDistributorAbi } from '../sdk/abi.ts';
import { loadSystemFile } from '../sdk/config.ts';
import { CATEGORY, erc20Abi } from '../sdk/constants.ts';
import { deployDistributorPlan, deployPoolPlan } from '../sdk/pool.ts';
import { simulate } from '../sdk/tx.ts';

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
    const systemJson = {
      chainId: 31337,
      protocol: { bem, mining, minerCollection: nft },
      receipts: { issuer: operator, nand: { name: 'Local NAND Entitlement', symbol: 'lNAND', uri: '' }, latch: { name: 'Local LATCH Entitlement', symbol: 'lLATCH', uri: '' } },
      pools: {
        optimal: { name: 'Local E2E Optimal Pool', owner: operator, recipientA, recipientB, depositors: [depositor] },
        regular: { name: 'Local E2E Regular Pool', owner: operator, recipientA, recipientB, depositors: [depositor] },
      },
      distributor: { owner: operator },
    };
    await writeFile(systemFile, json(systemJson));

    // 0. A single-pool system file (2.2.0 and earlier) is refused by name, never reinterpreted.
    const { pools: _pools, ...base } = systemJson;
    const singlePoolFile = `${DIR}/system-single-pool.json`;
    await writeFile(singlePoolFile, json({ ...base, pool: systemJson.pools.optimal }));
    const singlePool = await fails('check-system-refuses-single-pool-file', ['check-system', '--system', singlePoolFile]);
    check('singlePoolSystemFileRefused', /single-pool key "pool"/.test(singlePool), singlePool);

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

    // 2. Both pools against the existing receipts, then the one distributor serving both; fund it.
    await step('deploy-pools-and-distributor', ['deploy', '--system', systemFile, '--addresses', addressesFile, '--from', operator, '--send-local']);
    addresses = JSON.parse(await readFile(addressesFile, 'utf8'));
    const pool = addresses.optimalPool as Address;
    const regular = addresses.regularPool as Address;
    const distributor = addresses.distributor as Address;
    const dRead = <T>(fn: string, args: unknown[] = []) => read<T>(distributor, tapeoutReceiptDistributorAbi as Abi, fn, args);
    check('oneDistributorServesBothPools', pool !== regular && (await dRead<Address>('optimalPool')) === pool && (await dRead<Address>('regularPool')) === regular
      && await dRead<boolean>('isPool', [pool]) && await dRead<boolean>('isPool', [regular]), addresses);
    const singlePoolAddresses = `${DIR}/addresses-single-pool.json`;
    await writeFile(singlePoolAddresses, json({ chainId: addresses.chainId, nandReceipt: addresses.nandReceipt, latchReceipt: addresses.latchReceipt, pool, distributor }));
    const oldAddresses = await fails('single-pool-addresses-file-refused', ['inspect', '--addresses', singlePoolAddresses, '--pool', 'optimal']);
    check('singlePoolAddressesFileRefused', /single-pool key "pool"/.test(oldAddresses), oldAddresses);
    const noSelector = await fails('pool-command-needs-a-pool', ['finality', '--addresses', addressesFile]);
    check('poolScopedCommandsNeedThePoolSelector', /--pool optimal or --pool regular/.test(noSelector), noSelector);
    const earlyPool = await fails('renounce-pool-before-activation', ['renounce', '--addresses', addressesFile, '--target', 'pool', '--pool', 'optimal', '--from', operator, '--send-local']);
    const earlyDistributor = await fails('renounce-distributor-before-finalization', ['renounce', '--addresses', addressesFile, '--target', 'distributor', '--from', operator, '--send-local']);
    check('renounceRefusedBeforeActivationAndAllocation', /not activated/.test(earlyPool) && /allocation is not finalized/.test(earlyDistributor), { earlyPool, earlyDistributor });
    // Plan mode (the mainnet path): the distributor deployment is planned from the two recorded pools.
    const planned = await step('plan-distributor-deployment', ['deploy-distributor', '--system', systemFile, '--addresses', addressesFile, '--from', operator]);
    const plan = (planned.plans as { to: Address | null; simulation?: { ok: boolean }; cast: string }[])[0];
    check('distributorDeploymentPlannedFromBothPools', planned.mode === 'PLAN_ONLY_NOT_SENT' && plan.to === null && plan.simulation?.ok === true, planned);
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
    const vr = verified as { verified: { wallets: number }; review: { status: string; assignment: { status: string } }; coverage: Record<string, { excluded: { count: number } }>; identity: { pools: Record<string, { expected: string; distributor: string }> } };
    check('allocationVerified', verified.status === 'READY_TO_FINALIZE' && vr.verified.wallets === 3, verified);
    // Remediation T-5 and T-3: the reviewed JSON is tied to the artifact, and the whole supply is covered.
    check('reviewedJsonVerifiedAgainstArtifact', vr.review.status === 'VERIFIED' && vr.review.assignment.status === 'VERIFIED', vr.review);
    check('fullSupplyCovered', vr.coverage.NAND.excluded.count === 0 && vr.coverage.LATCH.excluded.count === 0, vr.coverage);
    check('verificationNamesBothPools', vr.identity.pools.optimal.distributor === pool && vr.identity.pools.regular.distributor === regular, vr.identity);
    // Remediation T-01, two-pool form: a third valid pool Q sharing the same receipts. The distributor
    // serves only P (optimal) and R (regular); an addresses file naming Q in either role must not verify,
    // writes against it are refused, and Q cannot bind the distributor on chain.
    const system = await loadSystemFile(systemFile);
    const poolQ = (await send(operator, null, deployPoolPlan(system, 'regular', addresses.nandReceipt, addresses.latchReceipt).data)).contractAddress as Address;
    const addressesQ = `${DIR}/addresses-q.json`;
    await writeFile(addressesQ, json({ ...addresses, regularPool: poolQ }));
    const wrongPool = await step('verify-with-another-pool', ['verify-allocation', '--addresses', addressesQ, '--artifact', `${DIR}/artifact.json`, '--allocation', allocationFile]);
    check('verifyRejectsAPoolTheDistributorDoesNotServe', wrongPool.status === 'MISMATCH' && (wrongPool.mismatches as string[]).some(m => m.toLowerCase().includes(`configured regular pool ${poolQ.toLowerCase()} is not the distributor`)), wrongPool);
    const swappedFile = `${DIR}/addresses-swapped.json`;
    await writeFile(swappedFile, json({ ...addresses, optimalPool: regular, regularPool: pool }));
    const swapped = await step('verify-with-swapped-roles', ['verify-allocation', '--addresses', swappedFile, '--artifact', `${DIR}/artifact.json`]);
    check('verifyRejectsSwappedPoolRoles', swapped.status === 'MISMATCH', swapped);
    const wrongPoolWrite = await fails('write-with-another-pool', ['release', '--addresses', addressesQ, '--pool', 'regular', '--from', outsider, '--send-local']);
    check('writesRefusedForInconsistentDeployment', /Deployment check failed/.test(wrongPoolWrite) && /as its regular pool/.test(wrongPoolWrite), wrongPoolWrite);
    const thirdBind = await simulate(rpc, { to: poolQ, value: 0n, description: 'a third pool binding the distributor', data: encodeFunctionData({ abi: tapeoutMinerPoolAbi as Abi, functionName: 'bindDistributor', args: [distributor] }) }, operator);
    check('thirdPoolWithTheSameReceiptsCannotBind', !thirdBind.ok && /InvalidDistributor/.test(thirdBind.error ?? '') && !await dRead<boolean>('isPool', [poolQ]), thirdBind);
    const deploymentOk = await step('verify-deployment', ['verify-deployment', '--addresses', addressesFile, '--system', systemFile]);
    check('deploymentMatchesTemplatesAndBindings', deploymentOk.status === 'MATCHES', deploymentOk);
    const finalizedPlan = await step('finalize-allocation', ['finalize-allocation', '--addresses', addressesFile, '--artifact', `${DIR}/artifact.json`, '--allocation', allocationFile, '--from', operator, '--send-local']);
    check('finalizeRecordsItsVerification', (finalizedPlan.verification as { status: string }).status === 'READY_TO_FINALIZE', finalizedPlan.verification);
    const finalized = await step('verify-after-finalization', ['verify-allocation', '--addresses', addressesFile, '--artifact', `${DIR}/artifact.json`]);
    check('verifyAfterFinalizationMatches', finalized.status === 'FINALIZED_AND_MATCHES', finalized);
    const emptyAfter = await variant('no-wallets-finalized', a => ({ ...a, wallets: [], totals: { NAND: 0, LATCH: 0, wallets: 0 } }));
    check('verifyNeverMatchesEmptyArtifactAfterFinalization', emptyAfter.status === 'MISMATCH', emptyAfter);

    // 4. Initialization (SALUS #3, per pool): each pool binds the shared distributor once and activates;
    //    every ownership is renounced separately, and the first admission into either pool is refused
    //    until its own owner and the shared receipts and distributor are renounced.
    const unbound = await fails('activate-before-binding', ['activate', '--addresses', addressesFile, '--pool', 'optimal', '--nand-shares', '30', '--latch-shares', '10', '--from', operator, '--send-local']);
    check('activationRefusedWithoutDistributorBinding', /no distributor is bound/.test(unbound), unbound);
    await step('bind-distributor-optimal', ['bind-distributor', '--addresses', addressesFile, '--pool', 'optimal', '--from', operator, '--send-local']);
    const rebind = await fails('bind-distributor-twice', ['bind-distributor', '--addresses', addressesFile, '--pool', 'optimal', '--from', operator, '--send-local']);
    check('distributorBindingIsOneTime', /already bound/.test(rebind), rebind);
    const regularUnbound = await fails('activate-regular-before-its-binding', ['activate', '--addresses', addressesFile, '--pool', 'regular', '--nand-shares', '30', '--latch-shares', '10', '--from', operator, '--send-local']);
    check('eachPoolNeedsItsOwnBinding', /no distributor is bound/.test(regularUnbound), regularUnbound);
    await step('bind-distributor-regular', ['bind-distributor', '--addresses', addressesFile, '--pool', 'regular', '--from', operator, '--send-local']);
    check('bothPoolsBoundTheSameDistributor', (await read<Address>(pool, tapeoutMinerPoolAbi as Abi, 'distributor')) === distributor && (await read<Address>(regular, tapeoutMinerPoolAbi as Abi, 'distributor')) === distributor);
    // A second genuine distributor for the same two pools is never "the" distributor: neither pool reads
    // the other's binding on chain, so the deployment check names every pool bound elsewhere.
    const second = (await send(operator, null, deployDistributorPlan(operator, pool, regular).data)).contractAddress as Address;
    const secondFile = `${DIR}/addresses-second-distributor.json`;
    await writeFile(secondFile, json({ ...addresses, distributor: second }));
    const secondCheck = await step('verify-deployment-with-a-second-distributor', ['verify-deployment', '--addresses', secondFile, '--system', systemFile]);
    const secondProblems = (secondCheck.problems as string[]).join('\n').toLowerCase();
    check('aSecondDistributorIsFlaggedForBothPools', secondCheck.status === 'MISMATCH' && secondProblems.includes(`optimal pool is bound to distributor ${distributor}, not ${second}`.toLowerCase())
      && secondProblems.includes(`regular pool is bound to distributor ${distributor}, not ${second}`.toLowerCase()), secondCheck.problems);
    await fails('activate-rejects-wrong-counts', ['activate', '--addresses', addressesFile, '--pool', 'optimal', '--nand-shares', '31', '--latch-shares', '10', '--from', operator, '--send-local']);
    await step('activate-optimal', ['activate', '--addresses', addressesFile, '--pool', 'optimal', '--nand-shares', '30', '--latch-shares', '10', '--from', operator, '--send-local']);
    await step('activate-regular', ['activate', '--addresses', addressesFile, '--pool', 'regular', '--nand-shares', '30', '--latch-shares', '10', '--from', operator, '--send-local']);
    for (const [id, n, l] of [[1n, 9, 1], [2n, 1, 9], [3n, 4, 4], [4n, 2, 2], [6n, 3, 1], [7n, 1, 3]] as const) {
      await write(nft, mockNFTAbi as Abi, 'mint', [depositor, id]);
      await write(mining, mockMiningAbi as Abi, 'start', [nft, id, n, l]);
    }
    const early = await fails('deposit-before-finality', ['deposit', '--addresses', addressesFile, '--pool', 'optimal', '--token-ids', '1', '--from', depositor, '--send-local']);
    check('cliRefusesTheFirstAdmissionBeforeFinality', /custody is not open/.test(early) && /poolOwnerRenounced/.test(early) && /nandOwnerRenounced/.test(early), early);
    await write(nft, mockNFTAbi as Abi, 'setApprovalForAll', [pool, true], depositor);
    await write(nft, mockNFTAbi as Abi, 'setApprovalForAll', [regular, true], depositor);
    const bypassInto = (target: Address, id: bigint) => simulate(rpc, { to: target, value: 0n, description: 'deposit bypassing the CLI preflight', data: encodeFunctionData({ abi: tapeoutMinerPoolAbi as Abi, functionName: 'depositMiners', args: [[id]] }) }, depositor);
    const gateBypass = await bypassInto(pool, 1n);
    check('chainRefusesTheFirstAdmissionBeforeFinality', !gateBypass.ok && /OwnershipNotRenounced/.test(gateBypass.error ?? ''), gateBypass);
    // Everything but the shared distributor renounced: it alone still blocks the first admission into BOTH pools.
    for (const [target, role] of [['pool', 'optimal'], ['pool', 'regular'], ['nand', undefined], ['latch', undefined]] as const) {
      await step(`renounce-${role ?? target}`, ['renounce', '--addresses', addressesFile, '--target', target, ...(role ? ['--pool', role] : []), '--from', operator, '--send-local']);
    }
    const [finalityOptimal, finalityRegular] = [await step('finality-optimal-before-distributor', ['finality', '--addresses', addressesFile, '--pool', 'optimal']), await step('finality-regular-before-distributor', ['finality', '--addresses', addressesFile, '--pool', 'regular'])];
    const onlyDistributorMissing = (f: Record<string, unknown>) => f.status === 'NOT_FINAL' && JSON.stringify(f.missing) === JSON.stringify(['distributorOwnerRenounced']);
    const [optimalBlocked, regularBlocked] = [await bypassInto(pool, 1n), await bypassInto(regular, 6n)];
    check('sharedDistributorOwnerBlocksBothPools', onlyDistributorMissing(finalityOptimal) && onlyDistributorMissing(finalityRegular)
      && !optimalBlocked.ok && /OwnershipNotRenounced/.test(optimalBlocked.error ?? '') && !regularBlocked.ok && /OwnershipNotRenounced/.test(regularBlocked.error ?? ''), { finalityOptimal, finalityRegular });
    await step('renounce-distributor', ['renounce', '--addresses', addressesFile, '--target', 'distributor', '--from', operator, '--send-local']);
    check('allOwnershipsRenounced', (await read<Address>(pool, tapeoutMinerPoolAbi as Abi, 'owner')) === '0x0000000000000000000000000000000000000000'
      && (await read<Address>(regular, tapeoutMinerPoolAbi as Abi, 'owner')) === '0x0000000000000000000000000000000000000000');
    const finality = await step('finality', ['finality', '--addresses', addressesFile, '--pool', 'optimal']);
    check('readyForFirstAdmission', finality.status === 'READY_FOR_FIRST_ADMISSION' && (finality.missing as string[]).length === 0, finality);
    const regularFinality = await step('finality-regular', ['finality', '--addresses', addressesFile, '--pool', 'regular']);
    check('regularReadyForFirstAdmission', regularFinality.status === 'READY_FOR_FIRST_ADMISSION', regularFinality);

    // 5. Admissions by the whitelisted depositor: the specification's acceptance example (optimal pool),
    //    and an independent admission into the regular pool.
    const comp = await step('composition', ['composition', '--addresses', addressesFile, '--pool', 'optimal', '--token-ids', '1-2']);
    check('compositionReadable', (comp.miners as { admissible: boolean }[]).every(m => m.admissible));
    await step('deposit-first-miner', ['deposit', '--addresses', addressesFile, '--pool', 'optimal', '--token-ids', '1', '--from', depositor, '--send-local']);
    // 105 BEM per miner: 100 for the participants under 80 : 1 : 1 : 2 of 84.
    await write(mining, mockMiningAbi as Abi, 'accrue', [nft, 1n, 105n * BEM]);
    await write(mining, mockMiningAbi as Abi, 'accrue', [nft, 2n, 105n * BEM]);
    await step('deposit-second-miner', ['deposit', '--addresses', addressesFile, '--pool', 'optimal', '--token-ids', '2', '--from', depositor, '--send-local']);
    const accrual = await read<{ nandIncome: bigint; latchIncome: bigint; recipientA: bigint; recipientB: bigint; sink: bigint }>(pool, tapeoutMinerPoolAbi as Abi, 'accrual');
    // 2.2.0: the old miner's 100 BEM go 9:1, the incoming miner's carried 100 BEM by its own 1:9 burn
    // (under 2.1.0 the carried BEM went by the 10:10 post-batch composition: NAND 140, LATCH 60).
    check('acceptanceExampleCarriedByOwnBurnNand100Latch100', accrual.nandIncome === 100n * BEM && accrual.latchIncome === 100n * BEM && accrual.recipientA === 250_000_000n && accrual.recipientB === 250_000_000n && accrual.sink === 5n * BEM, accrual);
    check('carriedIncomeRecordedPerMiner', (await read<{ carriedIncome: bigint }>(pool, tapeoutMinerPoolAbi as Abi, 'miner', [2n])).carriedIncome === 105n * BEM
      && (await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'carriedIncome')) === 105n * BEM);
    check('depositorKeptNothing', (await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [depositor])) === 0n);
    // The regular pool opens its own custody with miner 6 (3:1); its accounting is independent of the optimal pool's.
    await step('regular-deposit', ['deposit', '--addresses', addressesFile, '--pool', 'regular', '--token-ids', '6', '--from', depositor, '--send-local']);
    await write(mining, mockMiningAbi as Abi, 'accrue', [nft, 6n, 84n * BEM]);
    await step('regular-harvest', ['harvest', '--addresses', addressesFile, '--pool', 'regular', '--all', '--from', keeper, '--send-local']);
    const regularAccrual = await read<{ nandIncome: bigint; latchIncome: bigint }>(regular, tapeoutMinerPoolAbi as Abi, 'accrual');
    check('regularPoolAccountsOnItsOwn', regularAccrual.nandIncome === 60n * BEM && regularAccrual.latchIncome === 20n * BEM
      && (await read<bigint>(regular, tapeoutMinerPoolAbi as Abi, 'minerCount')) === 1n && (await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'minerCount')) === 2n, regularAccrual);

    // 6. Unauthorized admission paths.
    await write(nft, mockNFTAbi as Abi, 'mint', [alice, 5n]);
    await write(mining, mockMiningAbi as Abi, 'start', [nft, 5n, 1, 1]);
    const notWhitelisted = await fails('deposit-by-non-depositor', ['deposit', '--addresses', addressesFile, '--pool', 'optimal', '--token-ids', '5', '--from', alice, '--send-local']);
    check('nonDepositorRejected', /not a whitelisted depositor/.test(notWhitelisted), notWhitelisted);
    await write(nft, mockNFTAbi as Abi, 'transferFrom', [alice, pool, 5n], alice);
    const bypass = await fails('register-by-non-depositor', ['register', '--addresses', addressesFile, '--pool', 'optimal', '--token-ids', '5', '--from', alice, '--send-local']);
    check('registrationBypassRejected', /not a whitelisted depositor/.test(bypass), bypass);
    check('plainTransferDidNotAdmit', (await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'minerCount')) === 2n);

    // 7. Users claim receipts (late) and BEM from each pool independently; entitlement follows a transfer in both.
    const aliceReceipts = await step('alice-claims-receipts', ['claim-receipts', '--addresses', addressesFile, '--from', alice, '--send-local']);
    check('deliveriesReplannedBeforeEachSend', aliceReceipts.replannedBeforeEachSend === true && (aliceReceipts.transactions as unknown[]).length >= 1, aliceReceipts);
    const claimedIn = (target: Address, id: bigint) => read<bigint>(target, tapeoutMinerPoolAbi as Abi, 'claimed', [CATEGORY.NAND, id]);
    const regularHistoryBefore = await claimedIn(regular, 1n);
    const regularDueBefore = await read<bigint>(regular, tapeoutMinerPoolAbi as Abi, 'claimable', [CATEGORY.NAND, 1n]);
    // Remediation P-01: repeated IDs are claimed once; preview and payment agree in the same state.
    const before = await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [alice]);
    const dup = await step('alice-claims-with-repeated-ids', ['claim', '--addresses', addressesFile, '--pool', 'optimal', '--from', alice, '--nand', '1,1,2', '--latch', '1', '--send-local']);
    const dupNorm = dup.normalized as { removedDuplicates: { NAND: bigint[]; LATCH: bigint[] } } | undefined;
    const dupPaid = (await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [alice])) - before;
    check('repeatedClaimIdsNormalizedAndPreviewEqualsPayment', !!dupNorm && dupNorm.removedDuplicates.NAND.map(String).join(',') === '1' && dupNorm.removedDuplicates.LATCH.length === 0
      && dupPaid === BigInt(dup.expectedPayoutRaw as string | bigint) && dupPaid > 0n, { dup, dupPaid });
    const aliceBefore = await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [alice]);
    const aliceClaim = await step('alice-claims-bem', ['claim', '--addresses', addressesFile, '--pool', 'optimal', '--from', alice, '--all', '--send-local']);
    check('aliceExactPayout', (await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [alice])) - aliceBefore === BigInt(aliceClaim.expectedPayoutRaw as string | bigint));
    // Claiming in the optimal pool left the regular pool's history and entitlement for the same receipt unchanged.
    const optimalHistory = await claimedIn(pool, 1n);
    check('claimInOnePoolLeavesTheOtherUnchanged', optimalHistory > 0n && await claimedIn(regular, 1n) === regularHistoryBefore && regularHistoryBefore === 0n
      && await read<bigint>(regular, tapeoutMinerPoolAbi as Abi, 'claimable', [CATEGORY.NAND, 1n]) === regularDueBefore && regularDueBefore === 2n * BEM, { optimalHistory, regularDueBefore });
    const aliceRegularBefore = await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [alice]);
    const aliceRegular = await step('alice-claims-bem-regular', ['claim', '--addresses', addressesFile, '--pool', 'regular', '--from', alice, '--all', '--send-local']);
    const aliceRegularPaid = (await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [alice])) - aliceRegularBefore;
    check('sameReceiptsClaimIndependentlyFromTheRegularPool', aliceRegularPaid === BigInt(aliceRegular.expectedPayoutRaw as string | bigint) && aliceRegularPaid === 50n * BEM
      && await claimedIn(pool, 1n) === optimalHistory && await claimedIn(regular, 1n) === 2n * BEM, { aliceRegularPaid });
    await write(mining, mockMiningAbi as Abi, 'accrue', [nft, 1n, 51n * BEM]);
    await write(mining, mockMiningAbi as Abi, 'accrue', [nft, 6n, 42n * BEM]);
    await step('harvest', ['harvest', '--addresses', addressesFile, '--pool', 'optimal', '--all', '--from', keeper, '--send-local']);
    await step('harvest-regular', ['harvest', '--addresses', addressesFile, '--pool', 'regular', '--all', '--from', keeper, '--send-local']);
    await step('bob-claims-receipts-late', ['claim-receipts', '--addresses', addressesFile, '--from', bob, '--send-local']);
    const nandReceipt = addresses.nandReceipt as Address;
    const due = await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'claimable', [CATEGORY.NAND, 21n]);
    const regularDue = await read<bigint>(regular, tapeoutMinerPoolAbi as Abi, 'claimable', [CATEGORY.NAND, 21n]);
    check('lateReceiptKeptAccumulatedBem', due > 0n && regularDue === 3n * BEM, { due, regularDue });
    await write(nandReceipt, tapeoutEntitlementReceiptAbi as Abi, 'safeTransferFrom', [bob, carol, 21n, 1n, '0x'], bob);
    for (const role of ['optimal', 'regular'] as const) {
      const former = await step(`former-holder-simulation-${role}`, ['claim', '--addresses', addressesFile, '--pool', role, '--holder', bob, '--nand', '21', '--from', bob]);
      const sim = (former.plans as { simulation: { ok: boolean; error?: string } }[])[0].simulation;
      check(`formerHolderRejected${role === 'optimal' ? '' : 'InRegularPool'}`, !sim.ok && /NotHolder\(0, 21\)/.test(sim.error ?? ''), sim);
    }
    await step('carol-claims-receipts', ['claim-receipts', '--addresses', addressesFile, '--from', carol, '--send-local']);
    const carolBefore = await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [carol]);
    await step('carol-claims-bem', ['claim', '--addresses', addressesFile, '--pool', 'optimal', '--from', carol, '--all', '--send-local']);
    check('newHolderGotTransferredEntitlement', (await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [carol])) - carolBefore >= due);
    check('transferredEntitlementStillWholeInTheRegularPool', await read<bigint>(regular, tapeoutMinerPoolAbi as Abi, 'claimable', [CATEGORY.NAND, 21n]) === regularDue && await claimedIn(regular, 21n) === 0n);
    const carolRegularBefore = await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [carol]);
    await step('carol-claims-bem-regular', ['claim', '--addresses', addressesFile, '--pool', 'regular', '--from', carol, '--nand', '21', '--send-local']);
    check('newHolderGotTransferredEntitlementInTheRegularPool', (await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [carol])) - carolRegularBefore === regularDue);
    // Every receipt has been delivered (and NAND #21 moved on to carol): the artifact must still match.
    const afterDelivery = await step('verify-after-delivery', ['verify-allocation', '--addresses', addressesFile, '--artifact', `${DIR}/artifact.json`]);
    const deliveredIds = (afterDelivery.verified as { delivered: { NAND: bigint; LATCH: bigint } }).delivered;
    check('verifyAfterDeliveryMatches', afterDelivery.status === 'FINALIZED_AND_MATCHES' && deliveredIds.NAND === 30n && deliveredIds.LATCH === 10n, afterDelivery);
    await step('release', ['release', '--addresses', addressesFile, '--pool', 'optimal', '--from', outsider, '--send-local']);
    check('outsiderReceivedNothing', (await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [outsider])) === 0n);
    // Each release pays its role and all of C's unpaid weight; after A then B everything accrued is paid.
    const released = await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'totalAccounted');
    const sinkAddress = await read<Address>(pool, tapeoutMinerPoolAbi as Abi, 'SINK');
    const [paidA, paidB, paidC, sinkBalance] = await Promise.all([
      read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'recipientAPaid'), read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'recipientBPaid'),
      read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'sinkPaid'), read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [sinkAddress]),
    ]);
    check('releasePaidRolesAndSinkTheirCumulativeWeights', sinkAddress === '0x000000000000000000000000000000000000dEaD' && paidA === released / 84n && paidB === released / 84n
      && paidC === (released * 2n) / 84n && sinkBalance === paidC && (await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [recipientA])) === paidA, { released, paidA, paidB, paidC, sinkBalance });
    const releaseAgain = await step('release-again', ['release', '--addresses', addressesFile, '--pool', 'optimal', '--from', outsider, '--send-local']);
    check('repeatedReleasePaysNothingMore', (await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [sinkAddress])) === sinkBalance
      && (await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'sinkPaid')) === paidC, releaseAgain);
    await step('release-regular', ['release', '--addresses', addressesFile, '--pool', 'regular', '--from', outsider, '--send-local']);
    const regularTotal = await read<bigint>(regular, tapeoutMinerPoolAbi as Abi, 'totalAccounted');
    check('regularReleasePaysItsOwnSink', regularTotal === 126n * BEM && (await read<bigint>(regular, tapeoutMinerPoolAbi as Abi, 'sinkPaid')) === (regularTotal * 2n) / 84n
      && (await read<bigint>(bem, erc20Abi as Abi, 'balanceOf', [sinkAddress])) === sinkBalance + (regularTotal * 2n) / 84n, { regularTotal });

    // 8. Settlement exceptions (mock fault injection): a REVOKED old miner is skipped explicitly; any
    //    other failure of an old miner (a COOLING status, a failing claim) rolls the admission back.
    await write(mining, mockMiningAbi as Abi, 'setStatus', [nft, 1n, 2]);
    const skipped = await step('deposit-with-revoked-old-miner', ['deposit', '--addresses', addressesFile, '--pool', 'optimal', '--token-ids', '3', '--from', depositor, '--send-local']);
    const skipReceipt = await rpc.getTransactionReceipt({ hash: (skipped.transactions as { hash: Hex }[]).at(-1)!.hash });
    const skipLogs = parseEventLogs({ abi: tapeoutMinerPoolAbi as Abi, eventName: 'RevokedMinerSkipped', logs: skipReceipt.logs });
    check('revokedMinerSkippedExplicitly', skipLogs.length === 1);
    await write(mining, mockMiningAbi as Abi, 'setStatus', [nft, 2n, 3]);
    const cooling = await fails('deposit-rolls-back-on-cooling-old-miner', ['deposit', '--addresses', addressesFile, '--pool', 'optimal', '--token-ids', '4', '--from', depositor, '--send-local']);
    check('coolingOldMinerBlocksAdmission', /SettlementFailed\(2,/.test(cooling) && (await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'minerCount')) === 3n, cooling);
    await write(mining, mockMiningAbi as Abi, 'setStatus', [nft, 2n, 1]);
    await write(mining, mockMiningAbi as Abi, 'setKeyBroken', [nft, 2n, true]);
    const rollback = await fails('deposit-rolls-back-on-failed-settlement', ['deposit', '--addresses', addressesFile, '--pool', 'optimal', '--token-ids', '4', '--from', depositor, '--send-local']);
    check('failedSettlementRolledBack', /SettlementFailed\(2,/.test(rollback) && (await read<bigint>(pool, tapeoutMinerPoolAbi as Abi, 'minerCount')) === 3n, rollback);
    await write(mining, mockMiningAbi as Abi, 'setKeyBroken', [nft, 2n, false]);
    await step('deposit-after-recovery', ['deposit', '--addresses', addressesFile, '--pool', 'optimal', '--token-ids', '4', '--from', depositor, '--send-local']);
    // A second regular-pool admission settles the regular pool's own miner only.
    await step('regular-second-deposit', ['deposit', '--addresses', addressesFile, '--pool', 'regular', '--token-ids', '7', '--from', depositor, '--send-local']);

    // 9. Reconciliation of both pools and the CLI entrypoint.
    const reconcile = await step('reconcile-deep', ['reconcile', '--addresses', addressesFile, '--pool', 'optimal', '--deep', '--out', 'reports/local-e2e-reconcile.json']);
    check('reconcilePass', reconcile.status === 'PASS', reconcile);
    check('carriedRecordsReconcile', (reconcile.carriedRecords as { match: boolean; miners: number }).match && (reconcile.carriedRecords as { miners: number }).miners === 4, reconcile.carriedRecords);
    const regularReconcile = await step('reconcile-deep-regular', ['reconcile', '--addresses', addressesFile, '--pool', 'regular', '--deep', '--out', `${DIR}/regular-reconcile.json`]);
    check('regularReconcilePass', regularReconcile.status === 'PASS' && (regularReconcile.carriedRecords as { miners: number }).miners === 2, regularReconcile);
    const inspect = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'cli/pool.ts', 'inspect', '--addresses', addressesFile, '--pool', 'optimal', '--holder', alice, '--miners', '--pending', '--rpc-url', node.url], { encoding: 'utf8' }));
    check('cliEntrypointInspect', inspect.pool.active === true && inspect.miners.length === 4 && inspect.holdings.NAND.ids.length === 20 && inspect.role === 'optimal');
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
