import { getAddress, keccak256, zeroAddress, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { tapeoutEntitlementReceiptAbi, tapeoutMinerPoolAbi, tapeoutReceiptDistributorAbi } from './abi.js';
import bytecode from './bytecode.json' with { type: 'json' };
import { LATCH_CATEGORY, NAND_CATEGORY, POOL_ADDRESS_KEY, POOL_ROLES, type Addresses, type PoolRole, type SystemFile } from './config.js';

/**
 * Deployed identity of the production contracts. A runtime template (compiled runtime with immutable
 * slots unfilled) is not a deployed code hash: the pool and the distributor carry constructor-filled
 * values at the offsets their generated `immutableReferences` list (sdk/bytecode.json, exported from
 * the build), so their deployed hashes differ per deployment. Identity is therefore the deployed code
 * compared with the template outside those slots, plus the actual bindings read from the contracts.
 */

export type ContractName = 'TapeoutEntitlementReceipt' | 'TapeoutReceiptDistributor' | 'TapeoutMinerPool';
const templates = bytecode as unknown as Record<ContractName, { runtimeTemplate: Hex; immutableReferences: [number, number][] }>;

export function compareRuntime(name: ContractName, code: Hex | undefined) {
  const t = templates[name];
  const templateHash = keccak256(t.runtimeTemplate);
  if (!code || code === '0x') return { matches: false, runtimeTemplateHash: templateHash, reason: 'no code at the address' };
  if (code.length !== t.runtimeTemplate.length) return { matches: false, deployedCodeHash: keccak256(code), runtimeTemplateHash: templateHash, reason: `runtime is ${(code.length - 2) / 2} bytes, the template ${(t.runtimeTemplate.length - 2) / 2}` };
  const mask = (hex: Hex) => {
    const chars = hex.slice(2).toLowerCase().split('');
    for (const [start, length] of t.immutableReferences) chars.fill('0', start * 2, (start + length) * 2);
    return chars.join('');
  };
  const matches = mask(code) === mask(t.runtimeTemplate);
  return { matches, deployedCodeHash: keccak256(code), runtimeTemplateHash: templateHash, immutableSlots: t.immutableReferences.length, ...(matches ? {} : { reason: 'code differs from the template outside the immutable slots' }) };
}

const read = <T>(rpc: PublicClient, address: Address, abi: Abi, functionName: string, blockNumber: bigint) =>
  rpc.readContract({ address, abi, functionName, blockNumber } as never) as Promise<T>;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Identity and bindings of the addresses file's contracts at one block: code against the templates,
 * receipt categories, each pool's receipts and protocol, the distributor's two pools (exactly the
 * addresses file's optimal and regular pool, in those roles) and receipts, each pool's bound distributor,
 * and with `system` the protocol addresses, whitelists and initial roles. `problems` are hard
 * mismatches; `notes` are legitimate differences (a renounced owner, a recipient role that moved).
 */
export async function checkDeployment(rpc: PublicClient, addresses: Addresses, system?: SystemFile, blockNumber?: bigint) {
  const block = await rpc.getBlock(blockNumber === undefined ? { blockTag: 'latest' } : { blockNumber });
  const at = block.number!;
  const chainId = await rpc.getChainId();
  const problems: string[] = [];
  const notes: string[] = [];
  if (chainId !== addresses.chainId) problems.push(`the node serves chain ${chainId}, the addresses file names chain ${addresses.chainId}`);
  if (system && system.chainId !== addresses.chainId) problems.push(`the system file names chain ${system.chainId}, the addresses file ${addresses.chainId}`);
  const contracts: Record<string, unknown> = {};
  const code = async (label: string, address: Address, name: ContractName) => {
    const result = compareRuntime(name, await rpc.getCode({ address, blockNumber: at }));
    contracts[label] = { address, ...result };
    if (!result.matches) problems.push(`${label} ${address}: ${result.reason}`);
    return result.matches;
  };
  const receipts = { NAND: getAddress(addresses.nandReceipt), LATCH: getAddress(addresses.latchReceipt) };
  for (const [c, expected] of [['NAND', NAND_CATEGORY], ['LATCH', LATCH_CATEGORY]] as const) {
    if (!await code(`${c.toLowerCase()}Receipt`, receipts[c], 'TapeoutEntitlementReceipt')) continue;
    const category = await read<Hex>(rpc, receipts[c], tapeoutEntitlementReceiptAbi as Abi, 'category', at);
    if (!same(category, expected)) problems.push(`${c} receipt ${receipts[c]} reports another category (${category})`);
    if (system) {
      const owner = await read<Address>(rpc, receipts[c], tapeoutEntitlementReceiptAbi as Abi, 'owner', at);
      if (same(owner, zeroAddress)) notes.push(`${c} receipt ownership is renounced`);
      else if (!same(owner, system.receipts.issuer)) problems.push(`${c} receipt owner ${owner} is not the system file's issuer ${system.receipts.issuer}`);
    }
  }
  // 2.3.0: a processor's two custody pools share the receipts (and one distributor).
  const pools: Partial<Record<PoolRole, Address>> = {};
  const protocolOf: Partial<Record<PoolRole, Record<'bem' | 'mining' | 'minerCollection', Address>>> = {};
  for (const role of POOL_ROLES) {
    const configured = addresses[POOL_ADDRESS_KEY[role]];
    if (!configured) continue;
    const pool = getAddress(configured);
    if (!await code(POOL_ADDRESS_KEY[role], pool, 'TapeoutMinerPool')) continue;
    pools[role] = pool;
    const p = <T>(fn: string) => read<T>(rpc, pool, tapeoutMinerPoolAbi as Abi, fn, at);
    for (const [c, fn] of [['NAND', 'nandReceipt'], ['LATCH', 'latchReceipt']] as const) {
      const bound = await p<Address>(fn);
      if (!same(bound, receipts[c])) problems.push(`${role} pool ${pool} is bound to ${c} receipt ${bound}, not ${receipts[c]}`);
    }
    const [bem, mining, minerCollection] = await Promise.all([p<Address>('bem'), p<Address>('mining'), p<Address>('minerCollection')]);
    protocolOf[role] = { bem, mining, minerCollection };
    if (system) {
      const expectedPool = system.pools[role];
      for (const fn of ['bem', 'mining', 'minerCollection'] as const) {
        if (!same(protocolOf[role][fn], system.protocol[fn])) problems.push(`${role} pool ${fn} is ${protocolOf[role][fn]}, the system file names ${system.protocol[fn]}`);
      }
      const depositors = (await p<readonly Address[]>('depositors')).map(a => a.toLowerCase()).sort();
      const expected = expectedPool.depositors.map(a => a.toLowerCase()).sort();
      if (JSON.stringify(depositors) !== JSON.stringify(expected)) problems.push(`${role} pool depositors ${depositors.join(',')} are not the system file's ${expected.join(',')}`);
      const owner = await p<Address>('owner');
      if (same(owner, zeroAddress)) notes.push(`${role} pool ownership is renounced`);
      else if (!same(owner, expectedPool.owner)) problems.push(`${role} pool owner ${owner} is not the system file's ${expectedPool.owner}`);
      for (const [r, fn] of [['A', 'recipientA'], ['B', 'recipientB']] as const) {
        const current = await p<Address>(fn);
        if (!same(current, expectedPool[fn])) notes.push(`${role} pool recipient ${r} is ${current}, not the initial ${expectedPool[fn]} (only the role holder can move it)`);
      }
    }
  }
  if (addresses.optimalPool && addresses.regularPool && same(addresses.optimalPool, addresses.regularPool)) {
    problems.push(`the addresses file names ${addresses.optimalPool} as both pools; a processor has two distinct custody pools`);
  }
  if (protocolOf.optimal && protocolOf.regular) {
    for (const fn of ['bem', 'mining', 'minerCollection'] as const) {
      if (!same(protocolOf.optimal[fn], protocolOf.regular[fn])) problems.push(`the pools report different ${fn} (${protocolOf.optimal[fn]}, ${protocolOf.regular[fn]}); one distributor serves only pools of the same processor`);
    }
  }
  if (addresses.distributor) {
    const distributor = getAddress(addresses.distributor);
    if (await code('distributor', distributor, 'TapeoutReceiptDistributor')) {
      const d = <T>(fn: string, args: readonly unknown[] = []) =>
        rpc.readContract({ address: distributor, abi: tapeoutReceiptDistributorAbi as Abi, functionName: fn, args, blockNumber: at } as never) as Promise<T>;
      const fixed: Record<PoolRole, Address> = { optimal: await d<Address>('optimalPool'), regular: await d<Address>('regularPool') };
      for (const role of POOL_ROLES) {
        const configured = addresses[POOL_ADDRESS_KEY[role]];
        if (!configured || !same(fixed[role], configured)) problems.push(`distributor ${distributor} serves ${fixed[role]} as its ${role} pool, the addresses file names ${configured ?? 'none'}`);
      }
      for (const [c, fn] of [['NAND', 'nandReceipt'], ['LATCH', 'latchReceipt']] as const) {
        const bound = await d<Address>(fn);
        if (!same(bound, receipts[c])) problems.push(`distributor is bound to ${c} receipt ${bound}, not ${receipts[c]}`);
      }
      if (system) {
        const owner = await d<Address>('owner');
        if (same(owner, zeroAddress)) notes.push('distributor ownership is renounced');
        else if (!same(owner, system.distributor.owner)) problems.push(`distributor owner ${owner} is not the system file's ${system.distributor.owner}`);
      }
      // Each pool binds the shared distributor once; a pool bound to any other contract is a mismatch.
      for (const role of POOL_ROLES) {
        const pool = pools[role];
        if (!pool) continue;
        if (!await d<boolean>('isPool', [pool])) problems.push(`distributor ${distributor} does not count the ${role} pool ${pool} among its pools`);
        const bound = await read<Address>(rpc, pool, tapeoutMinerPoolAbi as Abi, 'distributor', at);
        if (same(bound, zeroAddress)) notes.push(`the ${role} pool has no distributor bound yet (bind-distributor --pool ${role}, before activation)`);
        else if (!same(bound, distributor)) problems.push(`${role} pool is bound to distributor ${bound}, not ${distributor}`);
      }
    }
  }
  return { status: problems.length ? 'MISMATCH' : 'MATCHES', chainId, block: { number: at, hash: block.hash }, contracts, problems, notes };
}
