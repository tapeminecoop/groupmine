#!/usr/bin/env node
/**
 * The operator CLI's Safe Transaction Builder files, executed through real Safe contracts on a local
 * Anvil fork of BSC (real Mining, BEM and miner collection).
 *
 * Three Safe proxies are created from the canonical Safe deployments on BSC, with owner keys this
 * script derives for the fork only:
 * - operator (SafeL2 1.4.1, 2 of 3): receipt issuer, pool and distributor owner, recipient A;
 * - member (GnosisSafeL2 1.3.0, 2 of 3): whitelisted depositor and an allocated wallet;
 * - recipient (SafeL2 1.4.1, 10 of 10): recipient B, the widest signer set the Safe bound covers.
 * The CLI writes each step's batch files (--safe-json). Each file is executed the way Safe{Wallet}
 * executes a Transaction Builder batch: one Safe transaction, a call for a single entry and a
 * DELEGATECALL to the version's MultiSendCallOnly for several, signed by the threshold of owners
 * (EIP-712) and sent with the file's planned bound (maxGas) as the gas limit. Miner NFTs are moved from
 * their current holders by fork-only impersonation. Nothing is sent to BSC and no real key signs
 * anything. Writes reports/fork-safe-e2e.json.
 *
 * Env: FORK_RPC_URL (archive), FORK_BLOCK (128713128), FORK_SAFE_MINERS (12733,13948,4183,1574):
 *      EOA-held ACTIVE miners at that block; the first two are admitted together, the rest later.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  concat, createPublicClient, encodeFunctionData, encodePacked, getAddress, hashTypedData, http, keccak256, parseAbi, parseEventLogs, size,
  stringToHex, toHex, zeroAddress, type Abi, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { main as cli, json } from '../cli/pool.ts';
import { startAnvil } from './lib/anvil.ts';
import { BATCH_GAS_BUDGET, BSC_PROTOCOL, TX_GAS_CAP, erc20Abi, erc721Abi } from '../sdk/constants.ts';
import { tapeoutEntitlementReceiptAbi, tapeoutMinerPoolAbi } from '../sdk/abi.ts';
import { safePayloadBytes } from '../sdk/gas.ts';
import { readHeldIds } from '../sdk/pool.ts';

const DIR = '.runtime/fork-safe-e2e';
const archiveUrl = process.env.FORK_RPC_URL ?? '';
if (!archiveUrl) throw new Error('Set FORK_RPC_URL to an archive-capable BSC RPC endpoint');
const forkBlock = BigInt(process.env.FORK_BLOCK ?? '128713128');
const miners = (process.env.FORK_SAFE_MINERS ?? '12733,13948,4183,1574').split(',').map(BigInt);
if (miners.length < 3) throw new Error('FORK_SAFE_MINERS needs at least three miners');

// Canonical Safe deployments; code and VERSION() are checked on the fork before use.
const SAFE_DEPLOYMENTS = {
  '1.4.1': {
    singletonName: 'SafeL2', singleton: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762', factory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
    multiSendCallOnly: '0x9641d764fc13c8B624c04430C7356C1C7C8102e2', fallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
  },
  '1.3.0': {
    singletonName: 'GnosisSafeL2', singleton: '0x3E5c63644E683549055b9Be8653de26E0B4CD36E', factory: '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2',
    multiSendCallOnly: '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D', fallbackHandler: '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4',
  },
} as const;
type SafeVersion = keyof typeof SAFE_DEPLOYMENTS;

const safeAbi = parseAbi([
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function nonce() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function VERSION() view returns (string)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
]);
const factoryAbi = parseAbi(['function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)']);
const multiSendAbi = parseAbi(['function multiSend(bytes transactions) payable']);
const ownableAbi = parseAbi(['function owner() view returns (address)']);
// Safe 1.3.0 logs the hash as data, 1.4.1 as a topic; the signature is the same.
const EXECUTION_SUCCESS = keccak256(stringToHex('ExecutionSuccess(bytes32,uint256)'));
const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' }, { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
  ],
} as const;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

interface SafeInfo { label: string; address: Address; version: SafeVersion; owners: PrivateKeyAccount[]; threshold: number; multiSendCallOnly: Address }
interface SafeFile { file: string; transactions: number; plansMaxGas?: bigint; maxGas?: bigint }
interface SafeTxRecord {
  step: string; safe: string; file: string; fileSha256: string; entries: number; operation: string; signatures: number; payloadBytes: number;
  plansMaxGas: bigint; maxGas: bigint; estimate: bigint; gasUsed: bigint; hash: Hex; blockNumber: bigint; safeNonce: bigint;
}

const report: Record<string, unknown> & { steps: unknown[]; safeTransactions: SafeTxRecord[]; checks: Record<string, boolean>; observations: Record<string, unknown> } = {
  scope: 'REAL_BSC_STATE_LOCAL_ANVIL_FORK_ONLY', status: 'IN_PROGRESS', startedAt: new Date().toISOString(),
  source: { chainId: 56, forkBlock, archiveRpcHost: new URL(archiveUrl).host }, miners,
  method: [
    'Fork state is read from BSC at the pinned block; no protocol or Safe code or storage is modified.',
    'Safes are created through the canonical SafeProxyFactory deployments on BSC, from the canonical L2 singletons (SafeL2 1.4.1, GnosisSafeL2 1.3.0) with their CompatibilityFallbackHandler.',
    'Owner keys are derived by this script from fixed labels; they sign EIP-712 SafeTx messages for the local fork only.',
    'Each CLI batch file is executed like Safe{Wallet} executes a Transaction Builder batch: one entry as a call, several as a DELEGATECALL to the version\'s MultiSendCallOnly; safeTxGas, baseGas and gasPrice 0.',
    'Every Safe transaction is sent with the file\'s maxGas (the CLI\'s planned bound) as its gas limit, after checking that the node\'s estimate does not exceed it.',
    'Miner NFTs are moved from their current holders with fork-only impersonation; EOA actors are impersonated labelled addresses.',
    'Not exercised: the Safe{Wallet} interface itself (Transaction Builder import and checksum, its own gas estimation), Safe modules and guards, more than 10 signatures.',
  ],
  safeContracts: {}, safes: {}, steps: [], safeTransactions: [], checks: {}, observations: {},
  mainnetTransactionsSent: 0, liveSignaturesCreated: 0, forkTestKeySignatures: 0,
};
function check(name: string, ok: boolean, detail?: unknown) {
  report.checks[name] = ok;
  if (!ok) throw new Error(`CHECK_FAILED ${name} ${detail === undefined ? '' : json(detail)}`);
}

async function main() {
  await mkdir(DIR, { recursive: true });
  const node = await startAnvil(18547, ['--fork-url', archiveUrl, '--fork-block-number', String(forkBlock), '--hardfork', 'cancun',
    '--compute-units-per-second', '40', '--retries', '30', '--timeout', '60000', '--silent'], 600_000);
  try {
    const rpc = createPublicClient({ transport: http(node.url, { timeout: 600_000 }) });
    (report.source as Record<string, unknown>).blockHash = (await rpc.getBlock({ blockNumber: forkBlock })).hash;
    const read = <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) => rpc.readContract({ address, abi, functionName, args } as never) as Promise<T>;
    const bemOf = (a: Address) => read<bigint>(BSC_PROTOCOL.bem, erc20Abi as Abi, 'balanceOf', [a]);
    const advance = async (seconds: number) => {
      await rpc.request({ method: 'evm_increaseTime', params: [seconds] } as never);
      await rpc.request({ method: 'evm_mine', params: [] } as never);
    };
    const noCode = async (a: Address) => {
      const code = await rpc.getCode({ address: a });
      if (code && code !== '0x') throw new Error(`${a} has code on the fork`);
    };
    const send = async (from: Address, to: Address, data: Hex, label: string) => {
      const hash = await rpc.request({ method: 'eth_sendTransaction', params: [{ from, to, data }] } as never) as Hex;
      const r = await rpc.waitForTransactionReceipt({ hash, timeout: 600_000 });
      if (r.status !== 'success') throw new Error(`${label} reverted`);
      report.steps.push({ label, transactions: [{ hash, gasUsed: r.gasUsed, blockNumber: r.blockNumber }] });
      return r;
    };

    // The Safe contracts are the canonical deployments, present on BSC at the fork block.
    const contracts: Record<string, unknown> = {};
    for (const [version, d] of Object.entries(SAFE_DEPLOYMENTS)) {
      const entry: Record<string, unknown> = { singletonName: d.singletonName };
      for (const name of ['singleton', 'factory', 'multiSendCallOnly', 'fallbackHandler'] as const) {
        const code = await rpc.getCode({ address: d[name] });
        check(`safe${version}_${name}Deployed`, !!code && code !== '0x', d[name]);
        entry[name] = { address: d[name], bytes: size(code!), codeHash: keccak256(code!) };
      }
      const v = await read<string>(d.singleton, safeAbi as Abi, 'VERSION');
      check(`safe${version}_singletonVersion`, v === version, v);
      contracts[version] = entry;
    }
    report.safeContracts = contracts;

    // EOA actors are fresh labelled addresses, impersonated and funded (Anvil's default accounts carry
    // EIP-7702 delegations on BSC).
    const labels = ['deployer', 'executor', 'keeper', 'alice', 'bob', 'newRecipientA', 'newRecipientB'] as const;
    const actor = Object.fromEntries(labels.map(l => [l, getAddress(`0x${keccak256(stringToHex(`tapeout-fork-safe-e2e:${l}`)).slice(26)}`)])) as Record<(typeof labels)[number], Address>;
    for (const a of Object.values(actor)) {
      await noCode(a);
      await rpc.request({ method: 'anvil_impersonateAccount', params: [a] } as never);
      await rpc.request({ method: 'anvil_setBalance', params: [a, toHex(10n ** 18n)] } as never);
    }
    report.actors = actor;

    const createSafe = async (label: string, version: SafeVersion, ownerCount: number, threshold: number): Promise<SafeInfo> => {
      const d = SAFE_DEPLOYMENTS[version];
      const owners = Array.from({ length: ownerCount }, (_, i) => privateKeyToAccount(keccak256(stringToHex(`tapeout-fork-safe-e2e:${label}:owner${i + 1}`))));
      for (const o of owners) await noCode(o.address);
      const initializer = encodeFunctionData({ abi: safeAbi, functionName: 'setup', args: [owners.map(o => o.address), BigInt(threshold), zeroAddress, '0x', d.fallbackHandler, zeroAddress, 0n, zeroAddress] });
      const args = [d.singleton, initializer, BigInt(keccak256(stringToHex(`tapeout-fork-safe-e2e:${label}`)))] as const;
      const { result } = await rpc.simulateContract({ address: d.factory, abi: factoryAbi, functionName: 'createProxyWithNonce', args, account: actor.deployer });
      await send(actor.deployer, d.factory, encodeFunctionData({ abi: factoryAbi, functionName: 'createProxyWithNonce', args }), `create the ${label} (${d.singletonName} ${version}, ${threshold} of ${ownerCount})`);
      const address = getAddress(result);
      const onChainOwners = (await read<readonly Address[]>(address, safeAbi as Abi, 'getOwners')).map(o => getAddress(o)).sort();
      check(`${label}_ownersAndThreshold`, json(onChainOwners) === json(owners.map(o => o.address).sort()) && await read<bigint>(address, safeAbi as Abi, 'getThreshold') === BigInt(threshold));
      check(`${label}_version`, await read<string>(address, safeAbi as Abi, 'VERSION') === version);
      // Through its fallback handler the Safe declares IERC1155Receiver, so receipts can be sent to it.
      check(`${label}_declaresErc1155Receiver`, await read<boolean>(address, safeAbi as Abi, 'supportsInterface', ['0x4e2312e0']));
      (report.safes as Record<string, unknown>)[label] = { address, version, singleton: d.singletonName, owners: owners.map(o => o.address), threshold, fallbackHandler: d.fallbackHandler, multiSendCallOnly: d.multiSendCallOnly };
      return { label, address, version, owners, threshold, multiSendCallOnly: d.multiSendCallOnly };
    };

    /** The SafeTx an owner's wallet signs (EIP-712), checked against the Safe's own hash. */
    const safeTx = async (safe: SafeInfo, to: Address, value: bigint, data: Hex, operation: number) => {
      const nonce = await read<bigint>(safe.address, safeAbi as Abi, 'nonce');
      const message = { to, value, data, operation, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress, nonce };
      const domain = { chainId: 56, verifyingContract: safe.address };
      const hash = await read<Hex>(safe.address, safeAbi as Abi, 'getTransactionHash', [to, value, data, operation, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce]);
      const typed = hashTypedData({ domain, types: SAFE_TX_TYPES, primaryType: 'SafeTx', message });
      const sign = async (signers: PrivateKeyAccount[]) => {
        const sorted = [...signers].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
        report.forkTestKeySignatures = (report.forkTestKeySignatures as number) + sorted.length;
        return concat(await Promise.all(sorted.map(s => s.signTypedData({ domain, types: SAFE_TX_TYPES, primaryType: 'SafeTx', message }))));
      };
      const exec = (signatures: Hex) => encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [to, value, data, operation, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures] });
      return { nonce, hash, typedMatches: typed === hash, sign, exec };
    };

    /** Execute one batch file through the Safe, with the file's planned bound as the gas limit. */
    const execFile = async (step: string, safe: SafeInfo, f: SafeFile) => {
      const text = await readFile(f.file, 'utf8');
      const batch = JSON.parse(text) as { version: string; chainId: string; meta: { createdFromSafeAddress: string }; transactions: { to: string; value: string; data: Hex }[] };
      check(`${step}_fileFormat`, batch.version === '1.0' && batch.chainId === '56' && getAddress(batch.meta.createdFromSafeAddress) === safe.address
        && batch.transactions.length === f.transactions && batch.transactions.every(t => /^\d+$/.test(t.value) && /^0x([0-9a-f]{2})*$/i.test(t.data)), batch.meta);
      check(`${step}_boundPlannedUnderCap`, f.maxGas !== undefined && f.plansMaxGas !== undefined && f.maxGas <= TX_GAS_CAP, f);
      const entries = batch.transactions.map(t => ({ to: getAddress(t.to), value: BigInt(t.value), data: t.data }));
      // Safe{Wallet}: one entry is a call; several are a DELEGATECALL to MultiSendCallOnly.
      const single = entries.length === 1;
      const to = single ? entries[0].to : safe.multiSendCallOnly;
      const data = single ? entries[0].data : encodeFunctionData({ abi: multiSendAbi, functionName: 'multiSend',
        args: [concat(entries.map(t => encodePacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [0, t.to, t.value, BigInt(size(t.data)), t.data])))] });
      const tx = await safeTx(safe, to, single ? entries[0].value : 0n, data, single ? 0 : 1);
      check(`${step}_eip712HashMatchesSafe`, tx.typedMatches);
      const execData = tx.exec(await tx.sign(safe.owners.slice(0, safe.threshold)));
      const estimate = await rpc.estimateGas({ account: actor.executor, to: safe.address, data: execData });
      check(`${step}_estimateWithinPlannedBound`, estimate <= f.maxGas!, { estimate, maxGas: f.maxGas });
      const hash = await rpc.request({ method: 'eth_sendTransaction', params: [{ from: actor.executor, to: safe.address, data: execData, gas: toHex(f.maxGas!) }] } as never) as Hex;
      const receipt = await rpc.waitForTransactionReceipt({ hash, timeout: 600_000 });
      const executed = receipt.status === 'success' && receipt.logs.some(l => getAddress(l.address) === safe.address && l.topics[0] === EXECUTION_SUCCESS
        && (l.topics[1] ?? l.data.slice(0, 66)).toLowerCase() === tx.hash.toLowerCase());
      check(`${step}_executedBySafe`, executed, { hash, status: receipt.status });
      check(`${step}_nonceAdvanced`, await read<bigint>(safe.address, safeAbi as Abi, 'nonce') === tx.nonce + 1n);
      report.safeTransactions.push({
        step, safe: safe.label, file: f.file.replace(`${DIR}/`, ''), fileSha256: sha256(text), entries: entries.length,
        operation: single ? 'CALL' : 'DELEGATECALL MultiSendCallOnly', signatures: safe.threshold, payloadBytes: safePayloadBytes(entries),
        plansMaxGas: f.plansMaxGas!, maxGas: f.maxGas!, estimate, gasUsed: receipt.gasUsed, hash, blockNumber: receipt.blockNumber, safeNonce: tx.nonce,
      });
      return receipt;
    };

    /** A CLI write step planned for a Safe: its batch files, each executed through the Safe in order. */
    const safeStep = async (label: string, argv: string[], safe: SafeInfo) => {
      const result = await cli([...argv, '--from', safe.address, '--safe', safe.address, '--safe-json', `${DIR}/${label}.json`, '--rpc-url', node.url]) as Record<string, unknown>;
      const files = (result.safeBatchFiles ?? []) as SafeFile[];
      const plans = (result.plans ?? []) as { to: Address; value: bigint; data: Hex }[];
      check(`${label}_plannedNotSent`, result.mode === 'PLAN_ONLY_NOT_SENT' && files.length > 0, result.mode);
      // The files hold every plan once, in order.
      const entries = (await Promise.all(files.map(async f => (JSON.parse(await readFile(f.file, 'utf8')) as { transactions: { to: string; value: string; data: Hex }[] }).transactions))).flat();
      check(`${label}_filesHoldEveryPlanInOrder`, entries.length === plans.length
        && entries.every((e, i) => getAddress(e.to) === getAddress(plans[i].to) && e.data === plans[i].data && BigInt(e.value) === BigInt(plans[i].value)));
      // A file with several plans fits the budget with the Safe's own work included.
      check(`${label}_filesWithinBudget`, files.every(f => f.transactions === 1 || f.maxGas! <= BATCH_GAS_BUDGET), files);
      const receipts = [];
      for (const [i, f] of files.entries()) receipts.push(await execFile(files.length === 1 ? label : `${label}#${i + 1}`, safe, f));
      report.steps.push({ label, argv, safe: safe.label, files: files.map(f => ({ file: f.file.replace(`${DIR}/`, ''), transactions: f.transactions, plansMaxGas: f.plansMaxGas, maxGas: f.maxGas })) });
      return { result, files, receipts };
    };
    const step = async (label: string, argv: string[]) => {
      const result = await cli([...argv, '--rpc-url', node.url]) as Record<string, unknown>;
      const txs = (result.transactions as { hash: Hex; gasUsed: bigint; blockNumber: bigint; description: string }[] | undefined) ?? [];
      report.steps.push({ label, argv, mode: result.mode, transactions: txs.map(t => ({ hash: t.hash, gasUsed: t.gasUsed, blockNumber: t.blockNumber, description: t.description })), ...(txs.length ? {} : { status: result.status }) });
      return result;
    };

    const operator = await createSafe('operatorSafe', '1.4.1', 3, 2);
    const member = await createSafe('memberSafe', '1.3.0', 3, 2);
    const recipient = await createSafe('recipientSafe', '1.4.1', 10, 10);

    const systemFile = `${DIR}/system.json`;
    const addressesFile = `${DIR}/addresses.json`;
    await writeFile(systemFile, json({
      chainId: 56, protocol: BSC_PROTOCOL,
      receipts: { issuer: operator.address, nand: { name: 'Fork Safe NAND Entitlement', symbol: 'sNAND', uri: '' }, latch: { name: 'Fork Safe LATCH Entitlement', symbol: 'sLATCH', uri: '' } },
      pool: { name: 'Fork Safe E2E Pool', owner: operator.address, recipientA: operator.address, recipientB: recipient.address, depositors: [member.address] },
      distributor: { owner: operator.address },
    }));

    // Contract creation cannot go through a Safe: the CLI refuses to write such a file.
    let refusal = '';
    try {
      await cli(['deploy-receipts', '--system', systemFile, '--safe-json', `${DIR}/deploy.json`, '--safe', operator.address, '--rpc-url', node.url]);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    check('deploymentRefusedAsSafeBatch', /Contract creation cannot be batched through a Safe/.test(refusal), refusal);

    // Setup by the operator Safe. Deployments come from an EOA with the Safe as owner.
    await step('deploy-receipts', ['deploy-receipts', '--system', systemFile, '--addresses-out', addressesFile, '--from', actor.deployer, '--send-local']);
    let addresses = JSON.parse(await readFile(addressesFile, 'utf8'));
    const nand = getAddress(addresses.nandReceipt), latch = getAddress(addresses.latchReceipt);
    const receiptAbi = tapeoutEntitlementReceiptAbi as Abi;
    check('receiptsOwnedByOperatorSafe', await read<Address>(nand, ownableAbi, 'owner') === operator.address && await read<Address>(latch, ownableAbi, 'owner') === operator.address);
    // 500 NAND in five plans of 100 IDs: two fit one Safe transaction within the budget, three do not.
    const issueNand = await safeStep('issue-nand', ['issue', '--addresses', addressesFile, '--category', 'NAND', '--to', operator.address, '--count', '500', '--batch-size', '100'], operator);
    check('issueSplitIntoThreeSafeTransactions', issueNand.files.map(f => f.transactions).join(',') === '2,2,1', issueNand.files);
    await safeStep('issue-latch', ['issue', '--addresses', addressesFile, '--category', 'LATCH', '--to', operator.address, '--count', '60'], operator);
    check('operatorSafeHoldsTheSupply', (await readHeldIds(rpc, nand, operator.address)).length === 500 && (await readHeldIds(rpc, latch, operator.address)).length === 60);
    await step('deploy-pool-and-distributor', ['deploy', '--system', systemFile, '--addresses', addressesFile, '--from', actor.deployer, '--send-local']);
    addresses = JSON.parse(await readFile(addressesFile, 'utf8'));
    const pool = getAddress(addresses.pool), distributor = getAddress(addresses.distributor);
    const poolAbi = tapeoutMinerPoolAbi as Abi;
    check('poolAndDistributorOwnedByOperatorSafe', await read<Address>(pool, ownableAbi, 'owner') === operator.address && await read<Address>(distributor, ownableAbi, 'owner') === operator.address);
    const fundNand = await safeStep('fund-nand', ['fund-distributor', '--addresses', addressesFile, '--category', 'NAND', '--all-held', '--batch-size', '125'], operator);
    check('fundingSplitIntoTwoSafeTransactions', fundNand.files.map(f => f.transactions).join(',') === '2,2', fundNand.files);
    await safeStep('fund-latch', ['fund-distributor', '--addresses', addressesFile, '--category', 'LATCH', '--all-held'], operator);
    check('distributorHoldsTheSupply', (await readHeldIds(rpc, nand, distributor)).length === 500 && (await readHeldIds(rpc, latch, distributor)).length === 60
      && (await readHeldIds(rpc, nand, operator.address)).length === 0);
    await safeStep('finalize-issuance-nand', ['finalize-issuance', '--addresses', addressesFile, '--category', 'NAND'], operator);
    await safeStep('finalize-issuance-latch', ['finalize-issuance', '--addresses', addressesFile, '--category', 'LATCH'], operator);
    check('issuanceFinalized', await read<boolean>(nand, receiptAbi, 'issuanceFinalized') && await read<boolean>(latch, receiptAbi, 'issuanceFinalized'));

    // The member Safe is one of the allocated wallets.
    const allocationFile = `${DIR}/allocation.json`;
    await writeFile(allocationFile, json({ allocations: [
      { wallet: member.address, nandCount: 50, latchCount: 10 }, { wallet: actor.alice, nandCount: 250, latchCount: 25 }, { wallet: actor.bob, nandCount: 200, latchCount: 25 },
    ] }));
    await safeStep('import-allocation', ['import-allocation', '--addresses', addressesFile, '--allocation', allocationFile, '--artifact-out', `${DIR}/artifact.json`], operator);
    const ready = await step('verify-allocation', ['verify-allocation', '--addresses', addressesFile, '--artifact', `${DIR}/artifact.json`, '--allocation', allocationFile]);
    check('allocationReadyToFinalize', ready.status === 'READY_TO_FINALIZE', ready);
    await safeStep('finalize-allocation', ['finalize-allocation', '--addresses', addressesFile, '--artifact', `${DIR}/artifact.json`, '--allocation', allocationFile], operator);
    // 2.2.0 (SALUS #3): the Safe binds the distributor once, activates, and renounces all four owners.
    await safeStep('bind-distributor', ['bind-distributor', '--addresses', addressesFile], operator);
    check('distributorBoundOnce', (await read<Address>(pool, poolAbi, 'distributor')).toLowerCase() === distributor.toLowerCase());
    await safeStep('activate', ['activate', '--addresses', addressesFile, '--nand-shares', '500', '--latch-shares', '60'], operator);
    check('poolActive', await read<boolean>(pool, poolAbi, 'active'));
    for (const target of ['nand', 'latch', 'distributor', 'pool']) await safeStep(`renounce-${target}`, ['renounce', '--addresses', addressesFile, '--target', target], operator);
    check('everyOwnershipRenounced', (await Promise.all([nand, latch, distributor, pool].map(a => read<Address>(a, ownableAbi, 'owner')))).every(o => o === zeroAddress));
    const finality = await step('finality', ['finality', '--addresses', addressesFile]);
    check('readyForFirstAdmission', finality.status === 'READY_FOR_FIRST_ADMISSION', finality);

    // Below the threshold the Safe refuses: one signature of two.
    const lone = await safeTx(operator, pool, 0n, encodeFunctionData({ abi: poolAbi, functionName: 'releaseA' }), 0);
    let loneError = '';
    await rpc.call({ account: actor.executor, to: operator.address, data: lone.exec(await lone.sign(operator.owners.slice(0, 1))) }).catch(e => { loneError = e instanceof Error ? e.message : String(e); });
    check('oneSignatureRefusedBySafe', /GS020/.test(loneError), loneError.slice(0, 300));

    // Real miners: current holders -> member Safe (fork impersonation only).
    const moves = [];
    for (const id of miners) {
      const holder = await read<Address>(BSC_PROTOCOL.minerCollection, erc721Abi as Abi, 'ownerOf', [id]);
      await rpc.request({ method: 'anvil_impersonateAccount', params: [holder] } as never);
      await rpc.request({ method: 'anvil_setBalance', params: [holder, toHex(10n ** 18n)] } as never);
      await send(holder, BSC_PROTOCOL.minerCollection, encodeFunctionData({ abi: erc721Abi, functionName: 'transferFrom', args: [holder, member.address, id] }), `impersonated holder moves miner ${id} to the member Safe`);
      await rpc.request({ method: 'anvil_stopImpersonatingAccount', params: [holder] } as never);
      moves.push({ id, holder });
    }
    const [firstA, firstB, ...later] = miners;
    const first = await safeStep('deposit-first', ['deposit', '--addresses', addressesFile, '--token-ids', `${firstA},${firstB}`], member);
    check('approvalAndDepositInOneSafeTransaction', first.files.length === 1 && first.files[0].transactions === 2, first.files);
    const firstAdmission = parseEventLogs({ abi: poolAbi, eventName: 'MinersAdmitted', logs: first.receipts[0].logs })[0]?.args as { settledOldIncome: bigint; carriedIncome: bigint; newPeriodIncome: bigint } | undefined;
    check('firstAdmissionCarriesRealIncome', firstAdmission !== undefined && firstAdmission.carriedIncome > 0n, firstAdmission);
    await advance(3600);
    const second = await safeStep('deposit-later', ['deposit', '--addresses', addressesFile, '--token-ids', later.join(',')], member);
    check('laterDepositIsOneCall', second.files.length === 1 && second.files[0].transactions === 1, second.files);
    const laterAdmission = parseEventLogs({ abi: poolAbi, eventName: 'MinersAdmitted', logs: second.receipts[0].logs })[0]?.args as { settledOldIncome: bigint; carriedIncome: bigint; newPeriodIncome: bigint } | undefined;
    check('oldIncomeSettledInsideSafeAdmission', laterAdmission !== undefined && laterAdmission.settledOldIncome > 0n && laterAdmission.carriedIncome > 0n, laterAdmission);
    const custody = await Promise.all(miners.map(id => read<Address>(BSC_PROTOCOL.minerCollection, erc721Abi as Abi, 'ownerOf', [id])));
    check('everyMinerInPoolCustody', await read<bigint>(pool, poolAbi, 'minerCount') === BigInt(miners.length) && custody.every(o => getAddress(o) === pool), custody);

    // The member Safe takes its receipts and claims their BEM.
    await advance(3600);
    await step('harvest', ['harvest', '--addresses', addressesFile, '--all', '--isolate-failures', '--from', actor.keeper, '--send-local']);
    await safeStep('member-claims-receipts', ['claim-receipts', '--addresses', addressesFile], member);
    check('memberSafeHoldsItsReceipts', (await readHeldIds(rpc, nand, member.address)).length === 50 && (await readHeldIds(rpc, latch, member.address)).length === 10);
    const matches = await step('verify-after-delivery', ['verify-allocation', '--addresses', addressesFile, '--artifact', `${DIR}/artifact.json`]);
    check('allocationMatchesAfterSafeDelivery', matches.status === 'FINALIZED_AND_MATCHES', matches);
    const before = await bemOf(member.address);
    const claim = await safeStep('member-claims-bem', ['claim', '--addresses', addressesFile, '--all'], member);
    const expected = BigInt(claim.result.expectedPayoutRaw as bigint | string);
    check('memberSafeReceivedExactPayout', expected > 0n && (await bemOf(member.address)) - before === expected, { expected });

    // Recipients: A is the operator Safe, B the 10-of-10 Safe; each moves its own role. Each release also
    // transfers C's whole unpaid floor(2T/84) to the fixed sink (which already holds BEM on BSC).
    const sink = await read<Address>(pool, poolAbi, 'SINK');
    const sinkBefore = await bemOf(sink);
    await step('release', ['release', '--addresses', addressesFile, '--from', actor.keeper, '--send-local']);
    const paidA = await bemOf(operator.address), paidB = await bemOf(recipient.address);
    check('safeRecipientsPaidEqually', paidA > 0n && paidA === paidB, { paidA, paidB });
    const sinkPaid1 = await read<bigint>(pool, poolAbi, 'sinkPaid');
    const total1 = await read<bigint>(pool, poolAbi, 'totalAccounted');
    check('sinkPaidCsWeightWithTheRelease', sinkPaid1 === (total1 * 2n) / 84n && (await bemOf(sink)) - sinkBefore === sinkPaid1 && paidA === total1 / 84n, { sinkPaid1, total1 });
    await safeStep('set-recipient-a', ['set-recipient', '--addresses', addressesFile, '--role', 'A', '--to', actor.newRecipientA], operator);
    await safeStep('set-recipient-b', ['set-recipient', '--addresses', addressesFile, '--role', 'B', '--to', actor.newRecipientB], recipient);
    check('rolesMovedBySafes', await read<Address>(pool, poolAbi, 'recipientA') === actor.newRecipientA && await read<Address>(pool, poolAbi, 'recipientB') === actor.newRecipientB);
    await advance(3600);
    await step('harvest-2', ['harvest', '--addresses', addressesFile, '--all', '--isolate-failures', '--from', actor.keeper, '--send-local']);
    // Releases are permissionless: the operator Safe, no longer a recipient, runs this one (a MultiSend of
    // releaseA and releaseB with the planned bound as gas limit).
    await safeStep('release-2-by-safe', ['release', '--addresses', addressesFile], operator);
    const newA = await bemOf(actor.newRecipientA), newB = await bemOf(actor.newRecipientB);
    check('newRecipientsPaidAndSafesNoLonger', newA > 0n && newA === newB && await bemOf(operator.address) === paidA && await bemOf(recipient.address) === paidB, { newA, newB });
    const sinkPaid2 = await read<bigint>(pool, poolAbi, 'sinkPaid');
    const total2 = await read<bigint>(pool, poolAbi, 'totalAccounted');
    check('sinkPaidOnceForTheWholeBacklog', sinkPaid2 === (total2 * 2n) / 84n && (await bemOf(sink)) - sinkBefore === sinkPaid2 && sinkPaid2 > sinkPaid1, { sinkPaid2, total2 });

    // Wallet capability beyond ERC-165 (review O-04): the member Safe transfers a delivered receipt
    // (an owner-signed Safe transaction, not a CLI plan), and the new holder claims what accrued since.
    const transfer = await safeTx(member, nand, 0n, encodeFunctionData({ abi: receiptAbi, functionName: 'safeTransferFrom', args: [member.address, actor.alice, 1n, 1n, '0x'] }), 0);
    const transferData = transfer.exec(await transfer.sign(member.owners.slice(0, member.threshold)));
    await send(actor.executor, member.address, transferData, 'member Safe transfers NAND #1 to alice (owner-signed Safe transaction)');
    check('memberSafeTransferredAReceipt', await read<bigint>(nand, receiptAbi, 'balanceOf', [actor.alice, 1n]) === 1n && await read<bigint>(nand, receiptAbi, 'balanceOf', [member.address, 1n]) === 0n);
    await advance(3600);
    await step('harvest-3', ['harvest', '--addresses', addressesFile, '--all', '--isolate-failures', '--from', actor.keeper, '--send-local']);
    const aliceBefore = await bemOf(actor.alice);
    const aliceClaim = await step('alice-claims-transferred-receipt', ['claim', '--addresses', addressesFile, '--from', actor.alice, '--nand', '1', '--send-local']);
    const alicePaid = (await bemOf(actor.alice)) - aliceBefore;
    check('newHolderClaimsAfterSafeTransfer', alicePaid > 0n && alicePaid === BigInt(aliceClaim.expectedPayoutRaw as bigint | string), { alicePaid });
    const formerHolder = await step('member-preview-for-transferred-receipt', ['claim', '--addresses', addressesFile, '--holder', member.address, '--nand', '1']);
    check('formerSafeHolderCannotClaimIt', json(formerHolder.notHeld ?? {}).includes('"1"'), formerHolder);

    const reconcile = await step('reconcile-deep', ['reconcile', '--addresses', addressesFile, '--deep']);
    check('reconcilePass', reconcile.status === 'PASS', reconcile.checks);

    // Across every Safe transaction: estimate <= planned bound <= cap, and both execution paths used.
    const st = report.safeTransactions;
    check('everySafeTransactionWithinItsBoundAndTheCap', st.length > 0 && st.every(t => t.estimate <= t.maxGas && t.gasUsed <= t.maxGas && t.maxGas <= TX_GAS_CAP));
    check('callAndMultiSendBothExecuted', st.some(t => t.entries === 1) && st.some(t => t.entries > 1));
    check('everySafeExecuted', new Set(st.map(t => t.safe)).size === 3);
    const max = (xs: bigint[]) => xs.reduce((a, b) => (b > a ? b : a));
    const min = (xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));
    report.observations = {
      pool, distributor, nandReceipt: nand, latchReceipt: latch, moves, firstAdmission, laterAdmission, memberPayout: expected, recipientPayments: { paidA, paidB, newA, newB },
      sinkPayments: { sink, sinkBalanceBefore: sinkBefore, sinkPaidAfterFirstRelease: sinkPaid1, sinkPaidAfterSafeRelease: sinkPaid2, sinkBalanceAfter: await bemOf(sink) },
      reconciliation: reconcile.reconciliation,
      gas: {
        safeTransactions: st.length, largestEstimate: max(st.map(t => t.estimate)), largestPlannedBound: max(st.map(t => t.maxGas)), largestPayloadBytes: Math.max(...st.map(t => t.payloadBytes)),
        smallestMargin: min(st.map(t => t.maxGas - t.estimate)),
        // How far the Safe's own work went beyond the plans' bounds (positive only for small single calls).
        largestEstimateOverPlans: max(st.map(t => t.estimate - t.plansMaxGas)),
      },
    };
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
  report.localForkTransactions = txs.length + report.safeTransactions.length;
  await writeFile('reports/fork-safe-e2e.json', json(report) + '\n');
  console.log(json({ status: report.status, checks: Object.keys(report.checks).length, safeTransactions: report.safeTransactions.length,
    localForkTransactions: report.localForkTransactions, gas: report.observations.gas, error: report.error, report: 'reports/fork-safe-e2e.json' }));
  if (report.status !== 'PASS') process.exitCode = 1;
});
