#!/usr/bin/env node
/**
 * Parameterized local check of the largest wallet allocation (review O-04): correction (revoke and
 * re-import), finalization, delivery and BEM claims for one wallet of LARGEST_WALLET_NAND NAND and
 * LARGEST_WALLET_LATCH LATCH IDs, through the operator CLI on a throwaway Anvil chain with the mock
 * protocol. Every transaction is sent with its planned bound as the gas limit (sendLocal refuses an
 * estimate above it; the CLI refuses a plan above the budget). If the wallet is too large for its
 * revocation to fit one transaction, the refusal is the recorded result.
 *
 * The launch-specific gate stays PENDING: the actual largest allocation was not supplied, so the
 * defaults below are parameters, not launch assumptions.
 * Env: LARGEST_WALLET_NAND (default 1200), LARGEST_WALLET_LATCH (default 300), LARGEST_WALLET_REPORT
 * (default reports/largest-wallet.json).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createPublicClient, encodeDeployData, encodeFunctionData, http, type Abi, type Address, type Hex } from 'viem';
import { main as cli, json } from '../cli/pool.ts';
import { startAnvil } from './lib/anvil.ts';
import bytecode from '../sdk/bytecode.json' with { type: 'json' };
import { mockBEMAbi, mockMiningAbi, mockNFTAbi, tapeoutReceiptDistributorAbi } from '../sdk/abi.ts';
import { erc20Abi } from '../sdk/constants.ts';

const DIR = '.runtime/largest-wallet';
const N = Number(process.env.LARGEST_WALLET_NAND ?? 1200);
const L = Number(process.env.LARGEST_WALLET_LATCH ?? 300);
const OUT = process.env.LARGEST_WALLET_REPORT ?? 'reports/largest-wallet.json';
const report: Record<string, unknown> & { steps: unknown[]; checks: Record<string, boolean> } = {
  scope: 'LOCAL_ANVIL_MOCK_PROTOCOL_ONLY', status: 'IN_PROGRESS', parameters: { largestWallet: { NAND: N, LATCH: L }, otherWallet: { NAND: 10, LATCH: 5 } },
  launchGate: 'PENDING: run again with the actual largest allocation before finalization (these sizes are parameters, not launch inputs)',
  steps: [], checks: {}, startedAt: new Date().toISOString(),
};
function check(name: string, ok: boolean, detail?: unknown) {
  report.checks[name] = ok;
  if (!ok) throw new Error(`CHECK_FAILED ${name} ${detail === undefined ? '' : json(detail)}`);
}

async function main() {
  await mkdir(DIR, { recursive: true });
  const node = await startAnvil(18549, ['--chain-id', '31337', '--silent']);
  try {
    const rpc = createPublicClient({ transport: http(node.url, { timeout: 600_000 }) });
    const [operator, depositor, largest, other] = await rpc.request({ method: 'eth_accounts' } as never) as Address[];
    const send = async (from: Address, to: Address | null, data: Hex) => {
      const hash = await rpc.request({ method: 'eth_sendTransaction', params: [{ from, ...(to ? { to } : {}), data }] } as never) as Hex;
      const r = await rpc.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') throw new Error(`setup tx failed ${hash}`);
      return r;
    };
    const deploy = async (name: 'MockBEM' | 'MockMining' | 'MockNFT', abi: Abi, args: unknown[] = []) =>
      (await send(operator, null, encodeDeployData({ abi, bytecode: bytecode[name].bytecode as Hex, args }))).contractAddress as Address;
    const step = async (label: string, argv: string[]) => {
      const result = await cli([...argv, '--rpc-url', node.url]) as Record<string, unknown>;
      const txs = (result.transactions as { gasUsed: bigint; description: string }[] | undefined) ?? [];
      report.steps.push({ label, transactions: txs.length, maxGasUsed: txs.reduce((m, t) => (t.gasUsed > m ? t.gasUsed : m), 0n), ...(txs.length ? {} : { status: result.status }) });
      return result;
    };
    const bem = await deploy('MockBEM', mockBEMAbi as Abi);
    const mining = await deploy('MockMining', mockMiningAbi as Abi, [bem]);
    const nft = await deploy('MockNFT', mockNFTAbi as Abi);
    const systemFile = `${DIR}/system.json`, addressesFile = `${DIR}/addresses.json`, allocationFile = `${DIR}/allocation.json`, artifact = `${DIR}/artifact.json`;
    await writeFile(systemFile, json({
      chainId: 31337, protocol: { bem, mining, minerCollection: nft },
      receipts: { issuer: operator, nand: { name: 'Scale NAND', symbol: 'sN', uri: '' }, latch: { name: 'Scale LATCH', symbol: 'sL', uri: '' } },
      pool: { name: 'Largest wallet check', owner: operator, recipientA: operator, recipientB: other, depositors: [depositor] }, distributor: { owner: operator },
    }));
    const as = (from: Address) => ['--from', from, '--send-local'];
    await step('deploy-receipts', ['deploy-receipts', '--system', systemFile, '--addresses-out', addressesFile, ...as(operator)]);
    await step('issue-nand', ['issue', '--addresses', addressesFile, '--category', 'NAND', '--to', operator, '--count', String(N + 10), ...as(operator)]);
    await step('issue-latch', ['issue', '--addresses', addressesFile, '--category', 'LATCH', '--to', operator, '--count', String(L + 5), ...as(operator)]);
    await step('finalize-nand', ['finalize-issuance', '--addresses', addressesFile, '--category', 'NAND', ...as(operator)]);
    await step('finalize-latch', ['finalize-issuance', '--addresses', addressesFile, '--category', 'LATCH', ...as(operator)]);
    await step('deploy', ['deploy', '--system', systemFile, '--addresses', addressesFile, ...as(operator)]);
    await step('fund-nand', ['fund-distributor', '--addresses', addressesFile, '--category', 'NAND', '--all-held', ...as(operator)]);
    await step('fund-latch', ['fund-distributor', '--addresses', addressesFile, '--category', 'LATCH', '--all-held', ...as(operator)]);
    await writeFile(allocationFile, json({ allocations: [{ wallet: largest, nandCount: N, latchCount: L }, { wallet: other, nandCount: 10, latchCount: 5 }] }));
    await step('import', ['import-allocation', '--addresses', addressesFile, '--allocation', allocationFile, '--artifact-out', artifact, ...as(operator)]);

    // Correction before finalization: one revocation of the whole wallet, then re-import.
    let revocation: string;
    try {
      await step('revoke-largest', ['revoke-wallet', '--addresses', addressesFile, '--wallet', largest, ...as(operator)]);
      revocation = 'FITS_ONE_TRANSACTION';
    } catch (error) {
      revocation = `REFUSED: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`;
    }
    report.revocation = revocation;
    if (revocation === 'FITS_ONE_TRANSACTION') {
      const reverify = await step('verify-after-revoke', ['verify-allocation', '--addresses', addressesFile, '--artifact', artifact]);
      check('revokedWalletIsAMismatchUntilReimported', reverify.status === 'MISMATCH');
      await step('reimport', ['import-allocation', '--addresses', addressesFile, '--allocation', allocationFile, '--artifact-out', artifact, ...as(operator)]);
    }
    const verified = await step('verify', ['verify-allocation', '--addresses', addressesFile, '--artifact', artifact, '--allocation', allocationFile]);
    check('verifiedReadyWithReviewedJson', verified.status === 'READY_TO_FINALIZE' && (verified.review as { status: string }).status === 'VERIFIED', verified.readinessGaps);
    await step('finalize-allocation', ['finalize-allocation', '--addresses', addressesFile, '--artifact', artifact, '--allocation', allocationFile, ...as(operator)]);
    await step('activate', ['activate', '--addresses', addressesFile, '--nand-shares', String(N + 10), '--latch-shares', String(L + 5), ...as(operator)]);
    const write = (to: Address, abi: Abi, functionName: string, args: unknown[]) => send(operator, to, encodeFunctionData({ abi, functionName, args } as never));
    await write(nft, mockNFTAbi as Abi, 'mint', [depositor, 1n]);
    await write(mining, mockMiningAbi as Abi, 'start', [nft, 1n, 1, 1]);
    await step('deposit', ['deposit', '--addresses', addressesFile, '--token-ids', '1', ...as(depositor)]);
    await write(mining, mockMiningAbi as Abi, 'accrue', [nft, 1n, 1_000_000n * 10n ** 8n]);
    await step('harvest', ['harvest', '--addresses', addressesFile, '--all', ...as(depositor)]);

    // Delivery of the whole wallet (replanned before each send) and the BEM claim for every ID.
    const delivered = await step('claim-receipts', ['claim-receipts', '--addresses', addressesFile, ...as(largest)]);
    const { distributor } = JSON.parse(await readFile(addressesFile, 'utf8')) as { distributor: Address };
    const pending = await rpc.readContract({ address: distributor, abi: tapeoutReceiptDistributorAbi as Abi, functionName: 'pendingOf', args: [largest] }) as readonly [bigint, bigint];
    check('everyIdDelivered', pending[0] === 0n && pending[1] === 0n, pending);
    report.deliveries = (delivered.transactions as unknown[]).length;
    const before = await rpc.readContract({ address: bem, abi: erc20Abi, functionName: 'balanceOf', args: [largest] });
    const claimed = await step('claim-bem', ['claim', '--addresses', addressesFile, '--all', ...as(largest)]);
    const after = await rpc.readContract({ address: bem, abi: erc20Abi, functionName: 'balanceOf', args: [largest] });
    check('exactPayoutForEveryId', after - before === BigInt(claimed.expectedPayoutRaw as bigint | string) && after > before);
    report.claimTransactions = (claimed.transactions as unknown[]).length;
    const reconcile = await step('reconcile', ['reconcile', '--addresses', addressesFile, '--deep']);
    check('reconcilePass', reconcile.status === 'PASS');
    // A wallet whose revocation cannot be planned as one transaction cannot be corrected before
    // finalization (revokeWallet clears the whole wallet at once): that fails this gate.
    report.status = revocation === 'FITS_ONE_TRANSACTION' ? 'PASS' : 'FAIL_CORRECTION_NOT_POSSIBLE';
  } finally {
    await node.stop();
  }
}

main().catch(error => {
  report.status = 'FAIL';
  report.error = error instanceof Error ? error.message.slice(0, 2000) : String(error);
}).finally(async () => {
  report.completedAt = new Date().toISOString();
  await writeFile(OUT, json(report) + '\n');
  console.log(json({ status: report.status, parameters: report.parameters, revocation: report.revocation, deliveries: report.deliveries, claimTransactions: report.claimTransactions, error: report.error, report: OUT }));
  if (report.status !== 'PASS') process.exitCode = 1;
});
