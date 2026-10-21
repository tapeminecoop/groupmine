import { getAddress, keccak256, zeroAddress, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { tapeoutEntitlementReceiptAbi, tapeoutMinerPoolAbi, tapeoutReceiptDistributorAbi } from './abi.js';
import bytecode from './bytecode.json' with { type: 'json' };
import { LATCH_CATEGORY, NAND_CATEGORY, type Addresses, type SystemFile } from './config.js';

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
 * receipt categories, the pool's receipts, the distributor's pool and receipts, and with `system` the
 * protocol addresses, whitelist and initial roles. `problems` are hard mismatches; `notes` are
 * legitimate differences (a renounced owner, a recipient role that moved).
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
  if (addresses.pool) {
    const pool = getAddress(addresses.pool);
    if (await code('pool', pool, 'TapeoutMinerPool')) {
      const p = <T>(fn: string) => read<T>(rpc, pool, tapeoutMinerPoolAbi as Abi, fn, at);
      for (const [c, fn] of [['NAND', 'nandReceipt'], ['LATCH', 'latchReceipt']] as const) {
        const bound = await p<Address>(fn);
        if (!same(bound, receipts[c])) problems.push(`pool ${pool} is bound to ${c} receipt ${bound}, not ${receipts[c]}`);
      }
      if (system) {
        for (const fn of ['bem', 'mining', 'minerCollection'] as const) {
          const bound = await p<Address>(fn);
          if (!same(bound, system.protocol[fn])) problems.push(`pool ${fn} is ${bound}, the system file names ${system.protocol[fn]}`);
        }
        const depositors = (await p<readonly Address[]>('depositors')).map(a => a.toLowerCase()).sort();
        const expected = system.pool.depositors.map(a => a.toLowerCase()).sort();
        if (JSON.stringify(depositors) !== JSON.stringify(expected)) problems.push(`pool depositors ${depositors.join(',')} are not the system file's ${expected.join(',')}`);
        const owner = await p<Address>('owner');
        if (same(owner, zeroAddress)) notes.push('pool ownership is renounced');
        else if (!same(owner, system.pool.owner)) problems.push(`pool owner ${owner} is not the system file's ${system.pool.owner}`);
        for (const [role, fn] of [['A', 'recipientA'], ['B', 'recipientB']] as const) {
          const current = await p<Address>(fn);
          if (!same(current, system.pool[fn])) notes.push(`recipient ${role} is ${current}, not the initial ${system.pool[fn]} (only the role holder can move it)`);
        }
      }
    }
  }
  if (addresses.distributor) {
    const distributor = getAddress(addresses.distributor);
    if (await code('distributor', distributor, 'TapeoutReceiptDistributor')) {
      const d = <T>(fn: string) => read<T>(rpc, distributor, tapeoutReceiptDistributorAbi as Abi, fn, at);
      const pool = await d<Address>('pool');
      if (!addresses.pool || !same(pool, addresses.pool)) problems.push(`distributor ${distributor} belongs to pool ${pool}, the addresses file names ${addresses.pool ?? 'none'}`);
      for (const [c, fn] of [['NAND', 'nandReceipt'], ['LATCH', 'latchReceipt']] as const) {
        const bound = await d<Address>(fn);
        if (!same(bound, receipts[c])) problems.push(`distributor is bound to ${c} receipt ${bound}, not ${receipts[c]}`);
      }
      if (system) {
        const owner = await d<Address>('owner');
        if (same(owner, zeroAddress)) notes.push('distributor ownership is renounced');
        else if (!same(owner, system.distributor.owner)) problems.push(`distributor owner ${owner} is not the system file's ${system.distributor.owner}`);
      }
    }
  }
  return { status: problems.length ? 'MISMATCH' : 'MATCHES', chainId, block: { number: at, hash: block.hash }, contracts, problems, notes };
}
