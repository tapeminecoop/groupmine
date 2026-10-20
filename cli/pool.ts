#!/usr/bin/env node
/**
 * TapeOut pooled-mining operator CLI (receipts, distributor, custody pool).
 *
 * Write commands never sign. By default they print the transaction plan (calldata, the equivalent
 * `cast send` command, and a simulation when --from is given). `--safe-json FILE` writes a Safe
 * Transaction Builder batch; `--send-local` executes on a loopback Anvil node only.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { getAddress, keccak256, zeroAddress, type Address } from 'viem';
import {
  ALLOCATE_GAS, BATCH_GAS_BUDGET, BSC_IDENTITY, BSC_PROTOCOL, CATEGORY, CLAIM_GAS, ERC1967_BEACON_SLOT, ERC1967_IMPLEMENTATION_SLOT, FUND_GAS,
  HARVEST_GAS, ISSUE_GAS, LATCH_CATEGORY, NAND_CATEGORY, RECIPIENT, TX_GAS_CAP, accrue, activatePlan, admissionGasEstimate, allocatePlans,
  allocationArtifact, assertWithinBudget, checkBatchSize, groupForSafe, maxDeliverable, maxIdsPerTx, safeBatchGas,
  allocationBatches, approveMinersPlan, assertLocalAnvil, assignIds, beaconAbi, castCommand, checkPerIdHistories,
  checkReconciliation, claimPlans, client, deliveryPlans, depositPlans, deployDistributorPlan,
  deployPoolPlan, deployReceiptPlans, describeError, erc20Abi, erc721Abi, finalizeAllocationPlan, finalizeIssuancePlan,
  findFailingMiners, formatBem, fundPlans, harvestPlans, harvestRangePlans, impersonate, issuePlans, loadAddresses,
  loadAllocationFile, loadSystemFile, maxAdmissionBatch, maxRegisteredForAdmission, parseBem, readComposition,
  readDistributorSummary, readHeldIds, readHoldings, readMiners, readPoolSummary, readReceiptSummary, readWalletRanges,
  receiverProblems, registerPlans, releasePlans, renouncePlan, residueBound, retractPlans, revokeWalletPlan, runs, safeBatch, sendLocal, setRecipientPlan, simulate,
  systemProblems, tapeoutMinerPoolAbi, validateAllocation, type Addresses, type CategoryName, type SentTx, type TxPlan,
  parseAllocationArtifact, readAllocationState, tapeoutEntitlementReceiptAbi, tapeoutReceiptDistributorAbi, verifyAllocation,
} from '../sdk/index.js';

type Flags = Record<string, string | boolean>;
const BOOLEAN = new Set(['send-local', 'impersonate', 'all', 'all-held', 'miners', 'pending', 'deep', 'isolate-failures', 'help']);
const VALUE = new Set(['system', 'addresses', 'addresses-out', 'allocation', 'artifact', 'artifact-out', 'rpc-url', 'from', 'holder', 'wallet', 'out',
  'safe-json', 'safe', 'income', 'token-ids', 'nand', 'latch', 'ids', 'batch-size', 'category', 'to', 'count', 'role', 'target', 'max-ids',
  'nand-shares', 'latch-shares', 'nand-burn', 'latch-burn']);
export const COMMANDS = ['preview', 'check-system', 'protocol-check', 'deploy-receipts', 'issue', 'retract', 'finalize-issuance', 'deploy', 'deploy-distributor',
  'fund-distributor', 'import-allocation', 'verify-allocation', 'revoke-wallet', 'finalize-allocation', 'activate', 'renounce', 'composition', 'deposit', 'register', 'harvest',
  'claim-receipts', 'deliver', 'claim', 'release', 'set-recipient', 'inspect', 'reconcile'] as const;

export const json = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

function parse(argv: string[]) {
  const [command, ...rest] = argv;
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].replace(/^--/, '');
    if (!rest[i].startsWith('--') || (!BOOLEAN.has(key) && !VALUE.has(key))) throw new Error(`Unknown argument ${rest[i]}`);
    if (key in flags) throw new Error(`Duplicate flag --${key}`);
    if (BOOLEAN.has(key)) flags[key] = true;
    else {
      const value = rest[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
      flags[key] = value;
    }
  }
  return { command, flags };
}

const str = (f: Flags, k: string) => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
const need = (f: Flags, k: string) => { const v = str(f, k); if (!v) throw new Error(`Missing --${k}`); return v; };
const addr = (raw: string) => getAddress(raw);
const uint = (raw: string) => { if (!/^\d+$/.test(raw)) throw new Error(`Invalid integer ${raw}`); return BigInt(raw); };
/** "1,2,5-9" -> [1n,2n,5n..9n] */
const idList = (raw?: string) => {
  if (!raw) return [];
  const out: bigint[] = [];
  for (const part of raw.split(',').filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`Invalid id or range ${part}`);
    const a = BigInt(m[1]), b = BigInt(m[2] ?? m[1]);
    if (b < a || b - a > 100_000n) throw new Error(`Invalid range ${part}`);
    for (let i = a; i <= b; i++) out.push(i);
  }
  return out;
};
/** `--batch-size`, refused above `max`: the largest batch whose worst case fits the BSC gas budget. */
const batch = (f: Flags, fallback: number, max: number, command: string) => {
  const v = Number(str(f, 'batch-size') ?? Math.min(fallback, max));
  if (!Number.isInteger(v) || v < 1) throw new Error('Invalid --batch-size');
  return checkBatchSize(command, v, max);
};
const category = (f: Flags): CategoryName => { const c = need(f, 'category').toUpperCase(); if (c !== 'NAND' && c !== 'LATCH') throw new Error('--category must be NAND or LATCH'); return c; };
const rpcUrl = (f: Flags) => str(f, 'rpc-url') ?? process.env.RPC_URL ?? (() => { throw new Error('Missing --rpc-url (or RPC_URL)'); })();
const receiptAddress = (a: Addresses, c: CategoryName) => addr(c === 'NAND' ? a.nandReceipt : a.latchReceipt);
const poolOf = (a: Addresses) => { if (!a.pool) throw new Error('addresses file has no pool yet (run deploy)'); return addr(a.pool); };
const distributorOf = (a: Addresses) => { if (!a.distributor) throw new Error('addresses file has no distributor yet (run deploy)'); return addr(a.distributor); };

/** Shared execution path for every write command. Every plan must fit the per-transaction gas budget
 *  (BSC caps a transaction's gas limit at 2^24, BEP-652); its worst-case bound is the gas limit for
 *  local sends and printed cast commands. Safe batch files are split so each Safe transaction, the
 *  Safe's own work included, fits the budget (a single oversized plan goes alone, within the cap). */
async function execute(command: string, flags: Flags, plans: TxPlan[], extra: Record<string, unknown> = {}) {
  assertWithinBudget(plans);
  const from = str(flags, 'from') ? addr(need(flags, 'from')) : undefined;
  if (flags['send-local']) {
    if (!from) throw new Error('--send-local needs --from (an unlocked or impersonated Anvil account)');
    const url = rpcUrl(flags);
    const rpc = client(url);
    const node = await assertLocalAnvil(url, rpc);
    if (flags.impersonate) await impersonate(rpc, from);
    const sent: SentTx[] = [];
    for (const plan of plans) sent.push(await sendLocal(rpc, plan, from));
    return { command, mode: 'SENT_LOCAL_ANVIL', node, from, transactions: sent, ...extra };
  }
  const hasRpc = !!(flags['rpc-url'] || process.env.RPC_URL);
  const chainId = hasRpc ? await client(rpcUrl(flags)).getChainId() : undefined;
  const safePath = str(flags, 'safe-json');
  const safeFiles: { file: string; transactions: number; plansMaxGas?: bigint; maxGas?: bigint }[] = [];
  if (safePath) {
    // The Transaction Builder executes a whole batch file as one transaction; maxGas adds the Safe's
    // own work to the plans' bounds and is the gas limit to execute it with.
    const groups = groupForSafe(plans);
    for (const [i, group] of groups.entries()) {
      const file = groups.length === 1 ? safePath : safePath.replace(/(\.json)?$/, `.${i + 1}$1`);
      const name = `TapeOut pool: ${command}${groups.length === 1 ? '' : ` (${i + 1} of ${groups.length})`}`;
      await writeFile(file, json(safeBatch(group, chainId ?? 56, name, str(flags, 'safe') ? addr(need(flags, 'safe')) : undefined)) + '\n');
      const bounded = group.every(p => p.gas !== undefined);
      safeFiles.push({ file, transactions: group.length, ...(bounded ? { plansMaxGas: group.reduce((s, p) => s + p.gas!, 0n), maxGas: safeBatchGas(group) } : {}) });
    }
  }
  const simulations = from && hasRpc ? await simulateSequentially(client(rpcUrl(flags)), plans, from) : undefined;
  return {
    command, mode: 'PLAN_ONLY_NOT_SENT', chainId, ...extra,
    ...(safeFiles.length ? { safeBatchFiles: safeFiles, ...(safeFiles.length > 1 ? { safeBatchNote: 'each file is one Safe transaction; execute them in order' } : {}) } : {}),
    plans: plans.map((p, i) => ({ description: p.description, to: p.to, value: p.value, data: p.data, maxGas: p.gas, cast: castCommand(p), ...(simulations ? { simulation: simulations[i] } : {}) })),
  };
}

/** Plans often depend on earlier ones (approve -> deposit); only the first is simulated precisely. */
async function simulateSequentially(rpc: ReturnType<typeof client>, plans: TxPlan[], from: Address) {
  const results = [];
  for (const [i, plan] of plans.entries()) {
    const sim = await simulate(rpc, plan, from);
    results.push(i === 0 || sim.ok ? sim : { ...sim, note: 'may depend on earlier plans being executed first' });
  }
  return results;
}

const expand = (ranges: readonly (readonly [number, number])[]) => ranges.flatMap(([first, count]) => Array.from({ length: count }, (_, i) => first + i));
const idSets = (ranges: readonly { category: number; firstId: bigint; count: bigint }[]) => {
  const out = { NAND: new Set<number>(), LATCH: new Set<number>() };
  for (const r of ranges) for (let i = 0n; i < r.count; i++) out[r.category === 0 ? 'NAND' : 'LATCH'].add(Number(r.firstId + i));
  return out;
};

async function writeAddresses(file: string, a: Addresses) {
  await writeFile(file, json(a) + '\n');
}

export async function main(argv = process.argv.slice(2)): Promise<unknown> {
  const { command, flags } = parse(argv);
  if (!command || command === 'help' || flags.help || !(COMMANDS as readonly string[]).includes(command)) {
    return { usage: 'npm run pool -- <command> [flags]', commands: COMMANDS, docs: 'docs/OPERATIONS.md' };
  }

  if (command === 'preview') {
    const income = parseBem(need(flags, 'income'));
    const state = { nandBase: 0n, latchBase: 0n, participantBase: 0n, totalNandBurn: uint(need(flags, 'nand-burn')), totalLatchBurn: uint(need(flags, 'latch-burn')),
      nandShares: uint(need(flags, 'nand-shares')), latchShares: uint(need(flags, 'latch-shares')) };
    const a = accrue(income, state);
    return { command, note: 'One composition period, starting from zero', incomeRaw: income,
      allocation: Object.fromEntries(Object.entries(a).map(([k, v]) => [k, { raw: v, bem: formatBem(v) }])), residueBound: residueBound(state.nandShares, state.latchShares) };
  }

  if (command === 'check-system') {
    const f = await loadSystemFile(need(flags, 'system'));
    return { command, status: 'SYSTEM_FILE_VALID', problems: systemProblems(f), depositors: f.pool.depositors, recipients: { A: f.pool.recipientA, B: f.pool.recipientB } };
  }

  if (command === 'deploy-receipts') {
    const f = await loadSystemFile(need(flags, 'system'));
    const result = await execute(command, flags, deployReceiptPlans(f)) as Record<string, unknown>;
    const sent = result.transactions as SentTx[] | undefined;
    if (sent) {
      const a: Addresses = { chainId: f.chainId, nandReceipt: addr(sent[0].contractAddress!), latchReceipt: addr(sent[1].contractAddress!) };
      await writeAddresses(need(flags, 'addresses-out'), a);
      Object.assign(result, { addresses: a });
    }
    return result;
  }

  const rpc = client(rpcUrl(flags));

  if (command === 'protocol-check') {
    const block = await rpc.getBlock({ blockTag: 'latest' });
    const at = { blockNumber: block.number };
    const p = BSC_PROTOCOL;
    const [miningImpl, beacon, decimals] = await Promise.all([
      rpc.getStorageAt({ address: p.mining, slot: ERC1967_IMPLEMENTATION_SLOT, ...at }),
      rpc.getStorageAt({ address: p.minerCollection, slot: ERC1967_BEACON_SLOT, ...at }),
      rpc.readContract({ address: p.bem, abi: erc20Abi, functionName: 'decimals', ...at }),
    ]);
    const implementation = miningImpl ? (`0x${miningImpl.slice(26)}` as Address) : zeroAddress;
    const beaconAddress = beacon ? (`0x${beacon.slice(26)}` as Address) : zeroAddress;
    const implCode = await rpc.getCode({ address: implementation, ...at });
    const collectionImpl = await rpc.readContract({ address: beaconAddress, abi: beaconAbi, functionName: 'implementation', ...at });
    const checks = {
      bemDecimals8: decimals === BSC_IDENTITY.bemDecimals,
      miningImplementationUnchanged: implementation.toLowerCase() === BSC_IDENTITY.miningImplementation.toLowerCase(),
      miningImplementationCodeHash: !!implCode && keccak256(implCode) === BSC_IDENTITY.miningImplementationCodeHash,
      collectionBeaconUnchanged: beaconAddress.toLowerCase() === BSC_IDENTITY.collectionBeacon.toLowerCase(),
      collectionImplementationUnchanged: collectionImpl.toLowerCase() === BSC_IDENTITY.collectionImplementation.toLowerCase(),
    };
    return { command, status: Object.values(checks).every(Boolean) ? 'IDENTITY_MATCHES_RECORDED' : 'REVIEW_REQUIRED', blockNumber: block.number, blockHash: block.hash, checks };
  }

  const addresses = await loadAddresses(need(flags, 'addresses'));

  if (command === 'issue') {
    const c = category(flags);
    // ~50k gas per ID: a 500-ID batch (the contract maximum) would not fit a BSC transaction.
    return execute(command, flags, issuePlans(receiptAddress(addresses, c), c, addr(need(flags, 'to')), Number(uint(need(flags, 'count'))), batch(flags, 500, maxIdsPerTx(ISSUE_GAS), command)));
  }
  if (command === 'retract') {
    const c = category(flags);
    const receipt = receiptAddress(addresses, c);
    const s = await readReceiptSummary(rpc, receipt);
    const count = Number(uint(need(flags, 'count')));
    if (s.issuanceFinalized) throw new Error(`${c} issuance is finalized; nothing can be retracted`);
    if (count < 1 || BigInt(count) > s.supply) throw new Error(`--count must be between 1 and the supply ${s.supply}`);
    const held = new Set(await readHeldIds(rpc, receipt, s.owner));
    const notHeld = Array.from({ length: count }, (_, i) => Number(s.supply) - i).filter(id => !held.has(id));
    if (notHeld.length) throw new Error(`Only issuer-held top IDs can be retracted; not held by the issuer: ${notHeld.slice(0, 20).join(',')}`);
    return execute(command, flags, retractPlans(receipt, c, count, batch(flags, 500, maxIdsPerTx(ISSUE_GAS), command)), { supplyAfter: s.supply - BigInt(count) });
  }
  if (command === 'finalize-issuance') {
    const c = category(flags);
    const s = await readReceiptSummary(rpc, receiptAddress(addresses, c));
    if (s.category !== (c === 'NAND' ? NAND_CATEGORY : LATCH_CATEGORY)) throw new Error(`${c} address holds a ${s.category} receipt`);
    return execute(command, flags, [finalizeIssuancePlan(s.address, c)], { supplyToFix: s.supply });
  }

  if (command === 'deploy') {
    const f = await loadSystemFile(need(flags, 'system'));
    const poolPlan = deployPoolPlan(f, addr(addresses.nandReceipt), addr(addresses.latchReceipt));
    if (!flags['send-local']) return execute(command, flags, [poolPlan], { note: 'after deployment, add "pool" to the addresses file and run deploy-distributor' });
    const first = await execute(command, flags, [poolPlan]) as { transactions: SentTx[] };
    const pool = addr(first.transactions[0].contractAddress!);
    const second = await execute(command, flags, [deployDistributorPlan(addr(f.distributor.owner), pool)]) as { transactions: SentTx[] };
    const updated: Addresses = { ...addresses, pool, distributor: addr(second.transactions[0].contractAddress!) };
    await writeAddresses(need(flags, 'addresses'), updated);
    return { command, mode: 'SENT_LOCAL_ANVIL', transactions: [...first.transactions, ...second.transactions], addresses: updated };
  }

  if (command === 'deploy-distributor') {
    const f = await loadSystemFile(need(flags, 'system'));
    const pool = poolOf(addresses);
    const bound = await Promise.all((['nandReceipt', 'latchReceipt'] as const).map(fn => rpc.readContract({ address: pool, abi: tapeoutMinerPoolAbi, functionName: fn })));
    if (getAddress(bound[0]) !== addr(addresses.nandReceipt) || getAddress(bound[1]) !== addr(addresses.latchReceipt)) {
      throw new Error(`Pool ${pool} is bound to receipts ${bound.join(', ')}, not the ones in the addresses file`);
    }
    const result = await execute(command, flags, [deployDistributorPlan(addr(f.distributor.owner), pool)]) as Record<string, unknown>;
    const sent = result.transactions as SentTx[] | undefined;
    if (sent) {
      const updated: Addresses = { ...addresses, distributor: addr(sent[0].contractAddress!) };
      await writeAddresses(need(flags, 'addresses'), updated);
      Object.assign(result, { addresses: updated });
    }
    return result;
  }

  if (command === 'fund-distributor') {
    const c = category(flags);
    const receipt = receiptAddress(addresses, c);
    const from = addr(need(flags, 'from'));
    const held = (await readHeldIds(rpc, receipt, from)).map(BigInt);
    const ids = flags['all-held'] ? held : idList(str(flags, 'ids'));
    const missing = ids.filter(id => !held.includes(id));
    if (missing.length) throw new Error(`${from} does not hold ${c} IDs ${missing.slice(0, 20).join(',')}`);
    if (ids.length === 0) return { command, status: 'NOTHING_TO_FUND' };
    return execute(command, flags, fundPlans(receipt, c, from, distributorOf(addresses), ids, batch(flags, 300, maxIdsPerTx(FUND_GAS), command)), { count: ids.length });
  }

  if (command === 'import-allocation') {
    const distributor = distributorOf(addresses);
    const { file, sha256 } = await loadAllocationFile(need(flags, 'allocation'));
    const { entries, totals } = validateAllocation(file);
    const block = await rpc.getBlock({ blockTag: 'latest' });
    const unreachable = await receiverProblems(rpc, entries.map(e => e.wallet), block.number);
    if (unreachable.length) throw new Error(`Allocation preflight failed (wallets that cannot receive ERC-1155):\n- ${unreachable.join('\n- ')}`);
    const inventory = {
      NAND: await readHeldIds(rpc, addr(addresses.nandReceipt), distributor, block.number),
      LATCH: await readHeldIds(rpc, addr(addresses.latchReceipt), distributor, block.number),
    };
    const summary = await readDistributorSummary(rpc, distributor, block.number);
    if (summary.allocationFinalized) throw new Error('Allocation is already finalized');
    const assignments = assignIds(entries, inventory);
    // Resume safely: IDs already recorded for a wallet are skipped; anything recorded outside the
    // wallet's planned IDs stops the import (revoke that wallet first).
    const pending: typeof assignments = [];
    let alreadyImported = 0;
    for (const a of assignments) {
      const onChain = idSets(await readWalletRanges(rpc, distributor, a.wallet, block.number));
      const planned = { NAND: expand(a.NAND), LATCH: expand(a.LATCH) };
      const stray = (['NAND', 'LATCH'] as const).flatMap(c => [...onChain[c]].filter(id => !planned[c].includes(id)).map(id => `${c} #${id}`));
      if (stray.length) throw new Error(`${a.wallet} already holds allocations outside this file (${stray.slice(0, 10).join(', ')}); revoke it before importing`);
      const remaining = { NAND: runs(planned.NAND.filter(id => !onChain.NAND.has(id))), LATCH: runs(planned.LATCH.filter(id => !onChain.LATCH.has(id))) };
      if (remaining.NAND.length + remaining.LATCH.length === 0) alreadyImported++;
      else pending.push({ ...a, ...remaining });
    }
    const artifact = allocationArtifact({ chainId: addresses.chainId, distributor, nandReceipt: addr(addresses.nandReceipt), latchReceipt: addr(addresses.latchReceipt), sourceSha256: sha256, blockNumber: block.number }, assignments);
    const out = str(flags, 'artifact-out');
    if (out) await writeFile(out, json(artifact) + '\n');
    // IDs per transaction; the batcher also splits by range count so each batch fits the gas budget.
    const maxIds = maxIdsPerTx({ base: ALLOCATE_GAS.base + ALLOCATE_GAS.perRange, perId: ALLOCATE_GAS.perId });
    return execute(command, flags, allocatePlans(distributor, allocationBatches(pending, batch(flags, 400, maxIds, command))),
      { totals, inventory: { NAND: inventory.NAND.length, LATCH: inventory.LATCH.length }, wallets: assignments.length, alreadyImported, ...(out ? { artifact: out } : {}) });
  }

  if (command === 'verify-allocation') {
    const distributor = distributorOf(addresses);
    // Untrusted input: validated at runtime, then compared with the chain (pinned to one block) in both directions.
    const artifact = parseAllocationArtifact(JSON.parse(await readFile(need(flags, 'artifact'), 'utf8')));
    const state = await readAllocationState(rpc, distributor);
    const result = verifyAllocation(artifact, state, { chainId: addresses.chainId, distributor, nandReceipt: addr(addresses.nandReceipt), latchReceipt: addr(addresses.latchReceipt) });
    // Wallets that still have receipts to take must be able to receive them.
    const waiting = state.wallets.filter(w => w.ranges.some(r => r.delivered < r.count)).map(w => w.wallet);
    const unreachableWallets = await receiverProblems(rpc, waiting, state.blockNumber);
    if (result.status === 'READY_TO_FINALIZE' && unreachableWallets.length) {
      return { command, ...result, status: 'NOT_READY', readinessGaps: [...result.readinessGaps, 'some wallets cannot receive ERC-1155'], unreachableWallets };
    }
    return { command, ...result, unreachableWallets };
  }

  if (command === 'revoke-wallet') {
    const distributor = distributorOf(addresses);
    const wallet = addr(need(flags, 'wallet'));
    const ranges = await readWalletRanges(rpc, distributor, wallet);
    if (ranges.length === 0) return { command, status: 'NOTHING_ALLOCATED', wallet };
    return execute(command, flags, [revokeWalletPlan(distributor, wallet, ranges)], { removes: ranges.map(r => ({ category: r.category === 0 ? 'NAND' : 'LATCH', firstId: r.firstId, count: r.count })) });
  }

  if (command === 'finalize-allocation') return execute(command, flags, [finalizeAllocationPlan(distributorOf(addresses))]);

  if (command === 'activate') {
    const nandShares = uint(need(flags, 'nand-shares'));
    const latchShares = uint(need(flags, 'latch-shares'));
    const receipts = await Promise.all([readReceiptSummary(rpc, addr(addresses.nandReceipt)), readReceiptSummary(rpc, addr(addresses.latchReceipt))]);
    const problems: string[] = [];
    if (!receipts[0].issuanceFinalized || !receipts[1].issuanceFinalized) problems.push('issuance not finalized for both collections');
    if (receipts[0].supply !== nandShares || receipts[1].supply !== latchShares) problems.push(`supplies are ${receipts[0].supply}/${receipts[1].supply}, not the reviewed ${nandShares}/${latchShares}`);
    if (problems.length) throw new Error(`Activation preflight failed: ${problems.join('; ')}`);
    return execute(command, flags, [activatePlan(poolOf(addresses), nandShares, latchShares)]);
  }

  if (command === 'renounce') {
    const target = need(flags, 'target');
    const map: Record<string, Address | undefined> = { pool: addresses.pool as Address, distributor: addresses.distributor as Address, nand: addresses.nandReceipt as Address, latch: addresses.latchReceipt as Address };
    if (!map[target]) throw new Error('--target must be pool, distributor, nand or latch (and deployed)');
    const contract = addr(map[target]!);
    // Renouncing before a contract's one-time setup is done would leave it permanently unusable.
    const check = {
      pool: { abi: tapeoutMinerPoolAbi, fn: 'active', unready: 'the pool is not activated: activation (the owner\'s only power) would become impossible', removes: 'nothing further: activation was the owner\'s only power' },
      distributor: { abi: tapeoutReceiptDistributorAbi, fn: 'allocationFinalized', unready: 'the allocation is not finalized: it could never be finalized and no receipt could be delivered', removes: 'nothing further: allocation functions are closed after finalization' },
      nand: { abi: tapeoutEntitlementReceiptAbi, fn: 'issuanceFinalized', unready: 'NAND issuance is not finalized: it could never be finalized and the pool could never activate', removes: 'the issuer\'s setURI (metadata only); the supply is already fixed' },
      latch: { abi: tapeoutEntitlementReceiptAbi, fn: 'issuanceFinalized', unready: 'LATCH issuance is not finalized: it could never be finalized and the pool could never activate', removes: 'the issuer\'s setURI (metadata only); the supply is already fixed' },
    }[target]!;
    const ready = await rpc.readContract({ address: contract, abi: check.abi, functionName: check.fn } as never) as boolean;
    if (!ready) throw new Error(`Refusing to plan renounceOwnership of the ${target}: ${check.unready}`);
    return execute(command, flags, [renouncePlan(contract, target)], { removes: check.removes, note: 'Each contract is renounced separately; renouncing one finalizes nothing else' });
  }

  const pool = poolOf(addresses);

  if (command === 'composition') {
    const s = await readPoolSummary(rpc, pool);
    return { command, miners: await readComposition(rpc, s.mining, s.collection, idList(need(flags, 'token-ids'))) };
  }

  if (command === 'deposit' || command === 'register') {
    const from = addr(need(flags, 'from'));
    const ids = idList(need(flags, 'token-ids'));
    const s = await readPoolSummary(rpc, pool);
    const problems: string[] = [];
    if (!s.active) problems.push('pool is not active');
    if (!s.depositors.map(d => d.toLowerCase()).includes(from.toLowerCase())) problems.push(`${from} is not a whitelisted depositor`);
    const composition = await readComposition(rpc, s.mining, s.collection, ids);
    for (const m of composition) {
      const expectedHolder = command === 'deposit' ? from : pool;
      if (m.owner.toLowerCase() !== expectedHolder.toLowerCase()) problems.push(`miner ${m.tokenId} is held by ${m.owner}, not ${expectedHolder}`);
      if (!m.admissible) problems.push(`miner ${m.tokenId}: ${m.problems.join(', ')}`);
      if (m.nandBurn > 0 && s.nandShares === 0n) problems.push(`miner ${m.tokenId} burns NAND but the NAND collection has no receipts`);
      if (m.latchBurn > 0 && s.latchShares === 0n) problems.push(`miner ${m.tokenId} burns LATCH but the LATCH collection has no receipts`);
    }
    if (problems.length) throw new Error(`Admission preflight failed:\n- ${problems.join('\n- ')}`);
    // Every admission settles all registered miners first; size batches for the BSC per-transaction cap.
    const fits = Number(maxAdmissionBatch(s.minerCount));
    if (fits === 0) throw new Error(`With ${s.minerCount} registered miners an admission would exceed the ${BATCH_GAS_BUDGET} gas budget (BSC cap ${TX_GAS_CAP}); see docs/VERIFICATION_REPORT.md`);
    const size = batch(flags, 10, fits, command);
    const plans: TxPlan[] = [];
    if (command === 'deposit') {
      const approved = await rpc.readContract({ address: s.collection, abi: erc721Abi, functionName: 'isApprovedForAll', args: [from, pool] });
      if (!approved) plans.push(approveMinersPlan(s.collection, pool));
      plans.push(...depositPlans(pool, ids, size, s.minerCount));
    } else plans.push(...registerPlans(pool, ids, size, s.minerCount));
    return execute(command, flags, plans, { registeredMiners: s.minerCount, batchSize: size,
      registryLimitForSingleAdmission: maxRegisteredForAdmission(1n), composition: composition.map(m => ({ tokenId: m.tokenId, nandBurn: m.nandBurn, latchBurn: m.latchBurn })) });
  }

  if (command === 'harvest') {
    const s = await readPoolSummary(rpc, pool);
    let ids = idList(str(flags, 'token-ids'));
    if (flags.all || ids.length === 0) ids = (await readMiners(rpc, pool)).map(m => m.tokenId);
    let failing: bigint[] = [];
    if (flags['isolate-failures']) {
      failing = await findFailingMiners(rpc, pool, ids, addr(need(flags, 'from')));
      ids = ids.filter(id => !failing.includes(id));
    }
    const size = batch(flags, 100, maxIdsPerTx(HARVEST_GAS), command);
    const plans = flags.all && !flags['isolate-failures'] ? harvestRangePlans(pool, s.minerCount, size) : harvestPlans(pool, ids, size);
    return execute(command, flags, plans, { miners: ids.length, excludedFailingMiners: failing });
  }

  if (command === 'claim-receipts' || command === 'deliver') {
    const distributor = distributorOf(addresses);
    const wallet = addr(need(flags, command === 'deliver' ? 'wallet' : 'from'));
    const ranges = await readWalletRanges(rpc, distributor, wallet);
    const waiting = { NAND: 0n, LATCH: 0n };
    for (const r of ranges) waiting[r.category === 0 ? 'NAND' : 'LATCH'] += r.count - r.delivered;
    if (waiting.NAND + waiting.LATCH === 0n) return { command, status: 'NOTHING_TO_DELIVER', wallet };
    // A delivery's cost grows with the IDs and ranges it transfers; plan as many deliveries as needed,
    // each within the gas budget (--max-ids caps every delivery).
    const fits = maxDeliverable(ranges);
    const cap = str(flags, 'max-ids') ? Number(uint(need(flags, 'max-ids'))) : 300;
    if (cap < 1) throw new Error('Invalid --max-ids');
    if (str(flags, 'max-ids') && cap > fits) throw new Error(`--max-ids ${cap} is above ${fits} for this wallet's ranges: BSC limits a transaction's gas to ${TX_GAS_CAP} (BEP-652)`);
    const plans = deliveryPlans(distributor, wallet, ranges, cap, command === 'deliver');
    return execute(command, flags, plans, { waiting, deliveries: plans.length });
  }

  if (command === 'claim') {
    const holder = addr(str(flags, 'holder') ?? need(flags, 'from'));
    const holdings = await readHoldings(rpc, pool, holder, addresses.distributor ? addr(addresses.distributor) : undefined);
    let nand = idList(str(flags, 'nand'));
    let latch = idList(str(flags, 'latch'));
    if (flags.all) {
      nand = holdings.NAND.ids.filter((_, i) => holdings.NAND.claimable[i] > 0n).map(BigInt);
      latch = holdings.LATCH.ids.filter((_, i) => holdings.LATCH.claimable[i] > 0n).map(BigInt);
    }
    if (nand.length + latch.length === 0) return { command, status: 'NOTHING_TO_CLAIM', holdings };
    if (str(flags, 'from') && addr(need(flags, 'from')) !== holder) throw new Error('BEM claims must be sent by the receipt holder');
    const expected = holdings.NAND.ids.reduce((s, id, i) => (nand.includes(BigInt(id)) ? s + holdings.NAND.claimable[i] : s), 0n)
      + holdings.LATCH.ids.reduce((s, id, i) => (latch.includes(BigInt(id)) ? s + holdings.LATCH.claimable[i] : s), 0n);
    return execute(command, flags, claimPlans(pool, nand, latch, batch(flags, 200, maxIdsPerTx(CLAIM_GAS), command)), { holder, expectedPayoutRaw: expected, expectedPayoutBem: formatBem(expected) });
  }

  if (command === 'release') return execute(command, flags, releasePlans(pool));

  if (command === 'set-recipient') {
    const role = need(flags, 'role').toUpperCase();
    if (role !== 'A' && role !== 'B') throw new Error('--role must be A or B');
    return execute(command, flags, [setRecipientPlan(pool, RECIPIENT[role], addr(need(flags, 'to')))]);
  }

  if (command === 'inspect') {
    const block = await rpc.getBlock({ blockTag: 'latest' });
    const summary = await readPoolSummary(rpc, pool, block.number);
    const receipts = await Promise.all([readReceiptSummary(rpc, addr(addresses.nandReceipt), block.number), readReceiptSummary(rpc, addr(addresses.latchReceipt), block.number)]);
    const distributor = addresses.distributor ? await readDistributorSummary(rpc, addr(addresses.distributor), block.number) : undefined;
    const holder = str(flags, 'holder');
    return {
      command, blockNumber: block.number, blockHash: block.hash, pool: summary, receipts, distributor,
      admission: { registeredMiners: summary.minerCount, estimatedGasForOneMiner: admissionGasEstimate(summary.minerCount, 1n), registryLimitForSingleAdmission: maxRegisteredForAdmission(1n) },
      ...(holder ? { holdings: await readHoldings(rpc, pool, addr(holder), addresses.distributor ? addr(addresses.distributor) : undefined, block.number) } : {}),
      ...(flags.miners ? { miners: await readMiners(rpc, pool, !!flags.pending, block.number) } : {}),
    };
  }

  if (command === 'reconcile') {
    const block = await rpc.getBlock({ blockTag: 'latest' });
    const summary = await readPoolSummary(rpc, pool, block.number);
    const ledger = checkReconciliation(summary.state, summary.reconciliation);
    const perId = flags.deep ? await checkPerIdHistories(rpc, pool, { NAND: summary.nandShares, LATCH: summary.latchShares }, block.number) : undefined;
    const { status: ledgerStatus, ...ledgerDetail } = ledger;
    const status = ledgerStatus === 'PASS' && (!perId || (perId.NAND.match && perId.LATCH.match)) ? 'PASS' : 'FAIL';
    const report = { command, status, ledgerStatus, blockNumber: block.number, blockHash: block.hash, pool, composition: summary.composition, reconciliation: summary.reconciliation, ...ledgerDetail, ...(perId ? { perIdHistories: perId } : {}) };
    const out = str(flags, 'out');
    if (out) await writeFile(out, json(report) + '\n');
    return report;
  }

  throw new Error(`Unhandled command ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => console.log(json(result))).catch(error => {
    console.error(json({ status: 'ERROR', error: describeError(error) }));
    process.exitCode = 1;
  });
}

export { CATEGORY };
