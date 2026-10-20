#!/usr/bin/env node
/**
 * TapeOut miner pool operator CLI.
 *
 * Write commands never sign. By default they print the transaction plan (calldata, the equivalent
 * `cast send` command, and a simulation when --from is given). `--safe-json FILE` writes a Safe
 * Transaction Builder batch; `--send-local` executes on a loopback Anvil node only.
 */
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { encodeFunctionData, getAddress, keccak256, zeroAddress, type Address } from 'viem';
import {
  CATEGORY, RECIPIENT, BSC_IDENTITY, BSC_PROTOCOL, ERC1967_BEACON_SLOT, ERC1967_IMPLEMENTATION_SLOT,
  accrue, activatePlan, activationProblems, approveMinersPlan, assertLocalAnvil, beaconAbi, buildIssuance,
  castCommand, checkPerIdHistories, checkReconciliation, claimPlans, client, configHash, configurePlan,
  depositPlans, deployPlan, describeError, erc20Abi, erc721Abi, findFailingMiners, formatBem, harvestPlans,
  harvestRangePlans, impersonate, issuanceCalls, issuancePlans, loadAllocation, loadPoolFile,
  parseBem, readHoldings, readMiners, readSummary, receiverProblems, registerPlans, releasePlans, safeBatch, sendLocal,
  simulate, summarize, tapeoutMinerPoolAbi, tapeoutReceiptAbi, toConfig, toDeployment, toShares, type SentTx, type TxPlan,
} from '../sdk/index.js';

type Flags = Record<string, string | boolean>;
const BOOLEAN = new Set(['send-local', 'impersonate', 'all', 'miners', 'pending', 'deep', 'isolate-failures', 'help']);
const VALUE = new Set(['config', 'allocation', 'pool', 'rpc-url', 'from', 'holder', 'out', 'safe-json', 'safe', 'income', 'token-ids', 'nand', 'latch', 'batch-size', 'category', 'ids', 'role', 'to']);
const COMMANDS = ['preview', 'allocate', 'config-hash', 'protocol-check', 'inspect', 'reconcile', 'preflight', 'deploy', 'configure', 'issue', 'revoke', 'activate', 'deposit', 'register', 'harvest', 'claim', 'release', 'set-recipient'] as const;

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
const ids = (raw?: string) => (raw ? raw.split(',').filter(Boolean).map(x => { if (!/^\d+$/.test(x)) throw new Error(`Invalid id ${x}`); return BigInt(x); }) : []);
const batch = (f: Flags, fallback: number) => { const v = Number(str(f, 'batch-size') ?? fallback); if (!Number.isInteger(v) || v < 1) throw new Error('Invalid --batch-size'); return v; };
const rpcUrl = (f: Flags) => str(f, 'rpc-url') ?? process.env.RPC_URL ?? (() => { throw new Error('Missing --rpc-url (or RPC_URL)'); })();

/** Shared execution path for every write command. */
async function execute(command: string, flags: Flags, plans: TxPlan[], extra: Record<string, unknown> = {}) {
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
  const safePath = str(flags, 'safe-json');
  const chainId = flags['rpc-url'] || process.env.RPC_URL ? await client(rpcUrl(flags)).getChainId() : undefined;
  if (safePath) {
    await writeFile(safePath, json(safeBatch(plans, chainId ?? 56, `TapeOut pool: ${command}`, str(flags, 'safe') ? addr(need(flags, 'safe')) : undefined)) + '\n');
  }
  const simulations = from && chainId !== undefined ? await simulateSequentially(client(rpcUrl(flags)), plans, from) : undefined;
  return {
    command, mode: 'PLAN_ONLY_NOT_SENT', chainId, ...(safePath ? { safeBatchFile: safePath } : {}), ...extra,
    plans: plans.map((p, i) => ({ description: p.description, to: p.to, value: p.value, data: p.data, cast: castCommand(p), ...(simulations ? { simulation: simulations[i] } : {}) })),
  };
}

/** Plans often depend on earlier ones (approve -> deposit); only the first is simulated precisely. */
async function simulateSequentially(rpc: ReturnType<typeof client>, plans: TxPlan[], from: Address) {
  const results = [];
  for (const [i, plan] of plans.entries()) {
    const sim = await simulate(rpc, plan, from);
    results.push(i === 0 || sim.ok ? sim : { ...sim, note: 'may depend on earlier plans in this batch being executed first' });
  }
  return results;
}

async function poolAndConfig(flags: Flags) {
  const file = await loadPoolFile(need(flags, 'config'));
  return { file, config: toConfig(file) };
}

export async function main(argv = process.argv.slice(2)): Promise<unknown> {
  const { command, flags } = parse(argv);
  if (!command || command === 'help' || flags.help || !(COMMANDS as readonly string[]).includes(command)) {
    return { usage: 'npm run pool -- <command> [flags]', commands: COMMANDS, docs: 'docs/OPERATIONS.md' };
  }

  if (command === 'preview') {
    const { config } = await poolAndConfig(flags);
    const income = parseBem(need(flags, 'income'));
    const a = accrue(income, toShares(config));
    const fmt = Object.fromEntries(Object.entries(a).map(([k, v]) => [k, { raw: v, bem: formatBem(v) }]));
    return { command, incomeRaw: income, allocation: fmt, problems: activationProblems(config) };
  }

  if (command === 'config-hash') {
    const { config } = await poolAndConfig(flags);
    return { command, config, configHash: configHash(config), problems: activationProblems(config) };
  }

  if (command === 'allocate') {
    const { config } = await poolAndConfig(flags);
    const alloc = await loadAllocation(need(flags, 'allocation'));
    const nand = buildIssuance('NAND', Number(config.nandShares), alloc.nand, alloc.reserve);
    const latch = buildIssuance('LATCH', Number(config.latchShares), alloc.latch, alloc.reserve);
    const out = str(flags, 'out');
    if (out) await writeFile(out, json({ nand, latch }) + '\n');
    return { command, status: 'ALLOCATION_VALID', summary: [summarize(nand), summarize(latch)], calls: { NAND: issuanceCalls(nand).length, LATCH: issuanceCalls(latch).length }, ...(out ? { file: out } : {}) };
  }

  const rpc = client(rpcUrl(flags));

  if (command === 'protocol-check') {
    const file = str(flags, 'config') ? await loadPoolFile(need(flags, 'config')) : undefined;
    const protocol = file?.protocol ?? BSC_PROTOCOL;
    const block = await rpc.getBlock({ blockTag: 'latest' });
    const at = { blockNumber: block.number };
    const [miningImpl, beacon, decimals, bemCode, miningCode, collectionCode] = await Promise.all([
      rpc.getStorageAt({ address: protocol.mining as Address, slot: ERC1967_IMPLEMENTATION_SLOT, ...at }),
      rpc.getStorageAt({ address: protocol.minerCollection as Address, slot: ERC1967_BEACON_SLOT, ...at }),
      rpc.readContract({ address: protocol.bem as Address, abi: erc20Abi, functionName: 'decimals', ...at }),
      rpc.getCode({ address: protocol.bem as Address, ...at }), rpc.getCode({ address: protocol.mining as Address, ...at }), rpc.getCode({ address: protocol.minerCollection as Address, ...at }),
    ]);
    const implementation = miningImpl ? (`0x${miningImpl.slice(26)}` as Address) : zeroAddress;
    const beaconAddress = beacon ? (`0x${beacon.slice(26)}` as Address) : zeroAddress;
    const implCode = implementation !== zeroAddress ? await rpc.getCode({ address: implementation, ...at }) : undefined;
    const collectionImpl = beaconAddress !== zeroAddress ? await rpc.readContract({ address: beaconAddress, abi: beaconAbi, functionName: 'implementation', ...at }) : zeroAddress;
    const checks = {
      codePresent: !!bemCode && !!miningCode && !!collectionCode,
      bemDecimals8: decimals === BSC_IDENTITY.bemDecimals,
      miningImplementationUnchanged: implementation.toLowerCase() === BSC_IDENTITY.miningImplementation.toLowerCase(),
      miningImplementationCodeHash: !!implCode && keccak256(implCode) === BSC_IDENTITY.miningImplementationCodeHash,
      collectionBeaconUnchanged: beaconAddress.toLowerCase() === BSC_IDENTITY.collectionBeacon.toLowerCase(),
      collectionImplementationUnchanged: collectionImpl.toLowerCase() === BSC_IDENTITY.collectionImplementation.toLowerCase(),
    };
    return { command, status: Object.values(checks).every(Boolean) ? 'IDENTITY_MATCHES_RECORDED' : 'REVIEW_REQUIRED', blockNumber: block.number, blockHash: block.hash, protocol, observed: { miningImplementation: implementation, collectionBeacon: beaconAddress, collectionImplementation: collectionImpl, bemDecimals: decimals }, checks };
  }

  if (command === 'deploy') {
    const { file } = await poolAndConfig(flags);
    const result = await execute(command, flags, [deployPlan(toDeployment(file))]) as Record<string, unknown>;
    const sent = (result.transactions as SentTx[] | undefined)?.[0];
    if (sent?.contractAddress) {
      const deployed = addr(sent.contractAddress);
      const summary = await readSummary(rpc, deployed);
      Object.assign(result, { pool: deployed, nandReceipt: summary.nandReceipt, latchReceipt: summary.latchReceipt });
    }
    return result;
  }

  const pool = addr(need(flags, 'pool'));

  if (command === 'inspect') {
    const block = await rpc.getBlock({ blockTag: 'latest' });
    const summary = await readSummary(rpc, pool, block.number);
    const holder = str(flags, 'holder');
    return {
      command, blockNumber: block.number, blockHash: block.hash, summary,
      ...(holder ? { holdings: await readHoldings(rpc, pool, addr(holder), block.number) } : {}),
      ...(flags.miners ? { miners: await readMiners(rpc, pool, !!flags.pending, block.number) } : {}),
    };
  }

  if (command === 'reconcile') {
    const block = await rpc.getBlock({ blockTag: 'latest' });
    const summary = await readSummary(rpc, pool, block.number);
    const ledger = checkReconciliation(summary.config, summary.reconciliation);
    const perId = flags.deep ? await checkPerIdHistories(rpc, pool, summary.config, block.number) : undefined;
    const { status: ledgerStatus, ...ledgerDetail } = ledger;
    const status = ledgerStatus === 'PASS' && (!perId || (perId.NAND.match && perId.LATCH.match)) ? 'PASS' : 'FAIL';
    const report = { command, status, ledgerStatus, blockNumber: block.number, blockHash: block.hash, pool, reconciliation: summary.reconciliation, ...ledgerDetail, ...(perId ? { perIdHistories: perId } : {}) };
    const out = str(flags, 'out');
    if (out) await writeFile(out, json(report) + '\n');
    return report;
  }

  if (command === 'preflight') {
    const { config } = await poolAndConfig(flags);
    const summary = await readSummary(rpc, pool);
    const problems = activationProblems(config);
    if (summary.active) problems.push('pool is already active');
    if (summary.currentConfigHash !== configHash(config)) problems.push(`on-chain config hash ${summary.currentConfigHash} differs from file ${configHash(config)}`);
    for (const c of ['NAND', 'LATCH'] as const) {
      const s = summary.issuance[c];
      if (s.issued !== s.shares) problems.push(`${c}: ${s.issued} of ${s.shares} receipt IDs issued`);
    }
    return { command, ready: problems.length === 0, problems, configHash: configHash(config), issuance: summary.issuance };
  }

  if (command === 'configure') {
    const { config } = await poolAndConfig(flags);
    return execute(command, flags, [configurePlan(pool, config)], { configHash: configHash(config), problems: activationProblems(config) });
  }

  if (command === 'issue') {
    const { config } = await poolAndConfig(flags);
    const alloc = await loadAllocation(need(flags, 'allocation'));
    const plans: TxPlan[] = [];
    const skipped: Record<string, number> = {};
    for (const category of ['NAND', 'LATCH'] as const) {
      const issuance = buildIssuance(category, Number(category === 'NAND' ? config.nandShares : config.latchShares), alloc[category === 'NAND' ? 'nand' : 'latch'], alloc.reserve);
      const receipt = await rpc.readContract({ address: pool, abi: tapeoutMinerPoolAbi, functionName: 'receiptOf', args: [CATEGORY[category]] }) as Address;
      // Resume safely: skip IDs already issued to the intended holder; stop on any conflict.
      const issued = new Set<number>();
      const intended = new Map(issuance.assignments.flatMap(a => a.ids.map(id => [id, a.holder] as const)));
      for (let first = 1; first <= issuance.shares; first += 1000) {
        const count = Math.min(1000, issuance.shares - first + 1);
        const holders = await rpc.readContract({ address: receipt, abi: tapeoutReceiptAbi, functionName: 'holdersPage', args: [BigInt(first), BigInt(count)] }) as readonly Address[];
        holders.forEach((h, i) => {
          if (h === zeroAddress) return;
          if (h !== intended.get(first + i)) throw new Error(`${category} #${first + i} is held by ${h}, allocation says ${intended.get(first + i)}; revoke or fix the allocation first`);
          issued.add(first + i);
        });
      }
      skipped[category] = issued.size;
      const pendingHolders = issuance.assignments.filter(a => a.ids.some(id => !issued.has(id))).map(a => a.holder);
      const rejecting = await receiverProblems(rpc, receipt, pool, pendingHolders);
      if (rejecting.length) throw new Error(`${category} holders cannot receive ERC-1155 receipts: ${json(rejecting)}`);
      plans.push(...issuancePlans(pool, issuanceCalls(issuance, batch(flags, 200), issued)));
    }
    return execute(command, flags, plans, { alreadyIssued: skipped });
  }

  if (command === 'activate') {
    const { config } = await poolAndConfig(flags);
    const hash = configHash(config);
    const summary = await readSummary(rpc, pool);
    if (summary.currentConfigHash !== hash) throw new Error(`On-chain configuration ${summary.currentConfigHash} differs from the reviewed file ${hash}`);
    const problems = activationProblems(config);
    for (const c of ['NAND', 'LATCH'] as const) if (summary.issuance[c].issued !== summary.issuance[c].shares) problems.push(`${c} issuance incomplete`);
    if (problems.length) throw new Error(`Activation preflight failed: ${problems.join('; ')}`);
    return execute(command, flags, [activatePlan(pool, hash)], { configHash: hash });
  }

  if (command === 'deposit' || command === 'register') {
    const tokenIds = ids(need(flags, 'token-ids'));
    if (tokenIds.length === 0) throw new Error('No --token-ids');
    if (command === 'register') return execute(command, flags, registerPlans(pool, tokenIds, batch(flags, 20)));
    const summary = await readSummary(rpc, pool);
    const owner = str(flags, 'from') ? addr(need(flags, 'from')) : summary.owner;
    const holders = await Promise.all(tokenIds.map(id => rpc.readContract({ address: summary.collection, abi: erc721Abi, functionName: 'ownerOf', args: [id] })));
    const foreign = tokenIds.filter((_, i) => holders[i] !== owner);
    if (foreign.length) throw new Error(`Miners ${foreign.join(',')} are not held by the pool owner ${owner}`);
    const approved = await rpc.readContract({ address: summary.collection, abi: erc721Abi, functionName: 'isApprovedForAll', args: [owner, pool] });
    const plans = [...(approved ? [] : [approveMinersPlan(summary.collection, pool)]), ...depositPlans(pool, tokenIds, batch(flags, 20))];
    return execute(command, flags, plans);
  }

  if (command === 'harvest') {
    const summary = await readSummary(rpc, pool);
    let tokenIds = ids(str(flags, 'token-ids'));
    if (flags.all || tokenIds.length === 0) tokenIds = (await readMiners(rpc, pool)).map(m => m.tokenId);
    let failing: bigint[] = [];
    if (flags['isolate-failures']) {
      const from = addr(need(flags, 'from'));
      failing = await findFailingMiners(rpc, pool, tokenIds, from);
      tokenIds = tokenIds.filter(id => !failing.includes(id));
    }
    const plans = flags.all && !flags['isolate-failures'] ? harvestRangePlans(pool, summary.minerCount, batch(flags, 25)) : harvestPlans(pool, tokenIds, batch(flags, 25));
    return execute(command, flags, plans, { miners: tokenIds.length, excludedFailingMiners: failing });
  }

  if (command === 'claim') {
    const holder = addr(str(flags, 'holder') ?? need(flags, 'from'));
    const holdings = await readHoldings(rpc, pool, holder);
    let nand = ids(str(flags, 'nand'));
    let latch = ids(str(flags, 'latch'));
    if (flags.all) {
      nand = holdings.NAND.ids.filter((_, i) => holdings.NAND.claimable[i] > 0n);
      latch = holdings.LATCH.ids.filter((_, i) => holdings.LATCH.claimable[i] > 0n);
    }
    if (nand.length + latch.length === 0) return { command, status: 'NOTHING_TO_CLAIM', holder, holdings };
    if (str(flags, 'from') && addr(need(flags, 'from')) !== holder) throw new Error('Claims must be sent by the receipt holder');
    const expected = holdings.NAND.ids.reduce((s, id, i) => (nand.includes(id) ? s + holdings.NAND.claimable[i] : s), 0n)
      + holdings.LATCH.ids.reduce((s, id, i) => (latch.includes(id) ? s + holdings.LATCH.claimable[i] : s), 0n);
    return execute(command, flags, claimPlans(pool, nand, latch, batch(flags, 200)), { holder, expectedPayoutRaw: expected, expectedPayoutBem: formatBem(expected) });
  }

  if (command === 'release') return execute(command, flags, releasePlans(pool));

  if (command === 'revoke') {
    const category = need(flags, 'category').toUpperCase();
    if (category !== 'NAND' && category !== 'LATCH') throw new Error('--category must be NAND or LATCH');
    const list = ids(need(flags, 'ids'));
    const data = encodeFunctionData({ abi: tapeoutMinerPoolAbi, functionName: 'revokeReceipts', args: [CATEGORY[category], list] });
    return execute(command, flags, [{ to: pool, data, value: 0n, description: `revoke (burn) ${category} IDs ${list.join(',')} before activation` }]);
  }

  if (command === 'set-recipient') {
    const role = need(flags, 'role').toUpperCase() as keyof typeof RECIPIENT;
    if (!(role in RECIPIENT)) throw new Error('--role must be FEE, HISTORICAL_NAND or HISTORICAL_LATCH');
    const to = addr(need(flags, 'to'));
    const data = encodeFunctionData({ abi: tapeoutMinerPoolAbi, functionName: 'setRecipient', args: [RECIPIENT[role], to] });
    return execute(command, flags, [{ to: pool, data, value: 0n, description: `move ${role} recipient role to ${to} (must be sent by the current recipient)` }]);
  }
  throw new Error(`Unhandled command ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => console.log(json(result))).catch(error => {
    console.error(json({ status: 'ERROR', error: describeError(error) }));
    process.exitCode = 1;
  });
}

