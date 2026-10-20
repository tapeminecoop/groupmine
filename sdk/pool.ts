import {
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { tapeoutMinerPoolAbi, tapeoutReceiptAbi } from './abi.js';
import bytecode from './bytecode.json' with { type: 'json' };
import { CATEGORY, erc20Abi, erc721Abi, miningAbi, type CategoryName } from './constants.js';
import { configHash, toShares, type PoolConfig } from './config.js';
import { accrue, residueBound, type Accrual } from './math.js';
import type { IssuanceCall } from './allocation.js';
import type { TxPlan } from './tx.js';

const call = (to: Address, data: Hex, description: string): TxPlan => ({ to, data, value: 0n, description });
const poolCall = (pool: Address, functionName: string, args: readonly unknown[], description: string) =>
  call(pool, encodeFunctionData({ abi: tapeoutMinerPoolAbi, functionName, args } as never), description);

export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error('batch size must be positive');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ------------------------------------------------------------------ transaction plans

export function deployPlan(deployment: ReturnType<typeof import('./config.js').toDeployment>): TxPlan {
  const data = encodeDeployData({ abi: tapeoutMinerPoolAbi, bytecode: bytecode.TapeoutMinerPool.bytecode as Hex, args: [deployment] });
  return { to: null, data, value: 0n, description: `deploy TapeoutMinerPool "${deployment.poolName}" owned by ${deployment.owner}` };
}

export function configurePlan(pool: Address, c: PoolConfig): TxPlan {
  return poolCall(pool, 'configure', [c], `configure S_N=${c.nandShares} S_L=${c.latchShares} H_N=${c.historicalNandShares} H_L=${c.historicalLatchShares} W_N=${c.nandWeight} (hash ${configHash(c)})`);
}

export function issuancePlans(pool: Address, calls: IssuanceCall[]): TxPlan[] {
  return calls.map(c => c.kind === 'range'
    ? poolCall(pool, 'issueReceiptRange', [CATEGORY[c.category], c.holder, BigInt(c.firstId), BigInt(c.count)], `issue ${c.category} #${c.firstId}..#${c.firstId + c.count - 1} to ${c.holder}`)
    : poolCall(pool, 'issueReceipts', [CATEGORY[c.category], c.holders, c.ids.map(BigInt)], `issue ${c.ids.length} ${c.category} IDs to listed holders`));
}

export function activatePlan(pool: Address, hash: Hex): TxPlan {
  return poolCall(pool, 'activate', [hash], `activate with reviewed config hash ${hash}`);
}

export function approveMinersPlan(collection: Address, pool: Address): TxPlan {
  return call(collection, encodeFunctionData({ abi: erc721Abi, functionName: 'setApprovalForAll', args: [pool, true] }), `approve pool ${pool} to pull miners`);
}

export function depositPlans(pool: Address, tokenIds: bigint[], batchSize = 20): TxPlan[] {
  return chunk(tokenIds, batchSize).map(ids => poolCall(pool, 'depositMiners', [ids], `deposit miners ${ids.join(',')}`));
}

export function registerPlans(pool: Address, tokenIds: bigint[], batchSize = 20): TxPlan[] {
  return chunk(tokenIds, batchSize).map(ids => poolCall(pool, 'registerMiners', [ids], `register miners ${ids.join(',')}`));
}

export function harvestPlans(pool: Address, tokenIds: bigint[], batchSize = 25): TxPlan[] {
  return chunk(tokenIds, batchSize).map(ids => poolCall(pool, 'harvest', [ids], `harvest miners ${ids.join(',')}`));
}

export function harvestRangePlans(pool: Address, minerCount: bigint, batchSize = 25): TxPlan[] {
  const plans: TxPlan[] = [];
  for (let start = 0n; start < minerCount; start += BigInt(batchSize)) {
    plans.push(poolCall(pool, 'harvestRange', [start, BigInt(batchSize)], `harvest registry entries ${start}..${start + BigInt(batchSize) - 1n}`));
  }
  return plans;
}

export function claimPlans(pool: Address, nandIds: bigint[], latchIds: bigint[], batchSize = 200): TxPlan[] {
  const items = [...nandIds.map(id => ['NAND', id] as const), ...latchIds.map(id => ['LATCH', id] as const)];
  return chunk(items, batchSize).map(part => {
    const n = part.filter(([c]) => c === 'NAND').map(([, id]) => id);
    const l = part.filter(([c]) => c === 'LATCH').map(([, id]) => id);
    return poolCall(pool, 'claimBatch', [n, l], `claim ${n.length} NAND + ${l.length} LATCH IDs`);
  });
}

export function releasePlans(pool: Address): TxPlan[] {
  return [
    poolCall(pool, 'releaseFee', [], 'release accrued fee to the fee recipient'),
    poolCall(pool, 'releaseHistorical', [CATEGORY.NAND], 'release historical NAND income to its recipient'),
    poolCall(pool, 'releaseHistorical', [CATEGORY.LATCH], 'release historical LATCH income to its recipient'),
  ];
}

// ------------------------------------------------------------------ reads

const read = <T>(rpc: PublicClient, pool: Address, functionName: string, args: readonly unknown[] = [], blockNumber?: bigint) =>
  rpc.readContract({ address: pool, abi: tapeoutMinerPoolAbi, functionName, args, blockNumber } as never) as Promise<T>;

export interface Reconciliation {
  bemBalance: bigint; unrecognized: bigint; deficit: bigint; totalAccounted: bigint; totalPaid: bigint;
  feeAccrued: bigint; feePaid: bigint; nandReceiptsAccrued: bigint; nandReceiptsPaid: bigint;
  latchReceiptsAccrued: bigint; latchReceiptsPaid: bigint; historicalNandAccrued: bigint; historicalNandPaid: bigint;
  historicalLatchAccrued: bigint; historicalLatchPaid: bigint; residue: bigint;
}

export async function readSummary(rpc: PublicClient, pool: Address, blockNumber?: bigint) {
  const r = <T>(fn: string, args: readonly unknown[] = []) => read<T>(rpc, pool, fn, args, blockNumber);
  const [name, version, owner, active, activatedAt, activationConfigHash, config, currentConfigHash, nandReceipt, latchReceipt, bem, mining, collection, minerCount, accrual, reconciliation, nandIssuance, latchIssuance] = await Promise.all([
    r<string>('poolName'), r<string>('VERSION'), r<Address>('owner'), r<boolean>('active'), r<bigint>('activatedAt'), r<Hex>('activationConfigHash'),
    r<PoolConfig>('config'), r<Hex>('currentConfigHash'), r<Address>('nandReceipt'), r<Address>('latchReceipt'), r<Address>('bem'), r<Address>('mining'),
    r<Address>('minerCollection'), r<bigint>('minerCount'), r<Accrual>('accrual'), r<Reconciliation>('reconciliation'),
    r<readonly [bigint, bigint, bigint, boolean]>('issuance', [CATEGORY.NAND]), r<readonly [bigint, bigint, bigint, boolean]>('issuance', [CATEGORY.LATCH]),
  ]);
  const issuance = (v: readonly [bigint, bigint, bigint, boolean]) => ({ shares: v[0], issued: v[1], remaining: v[2], mintingFinalized: v[3] });
  return { pool, name, version, owner, active, activatedAt, activationConfigHash, config, currentConfigHash, nandReceipt, latchReceipt, bem, mining, collection, minerCount, accrual, reconciliation, issuance: { NAND: issuance(nandIssuance), LATCH: issuance(latchIssuance) } };
}

/** Recompute the accrual off-chain and check the reconciliation identities. */
export function checkReconciliation(config: PoolConfig, r: Reconciliation) {
  const expected = accrue(r.totalAccounted, toShares(config));
  const outstanding = (r.feeAccrued - r.feePaid) + (r.nandReceiptsAccrued - r.nandReceiptsPaid) + (r.latchReceiptsAccrued - r.latchReceiptsPaid)
    + (r.historicalNandAccrued - r.historicalNandPaid) + (r.historicalLatchAccrued - r.historicalLatchPaid);
  const checks = {
    offChainMathMatches: expected.fee === r.feeAccrued && expected.nandReceipts === r.nandReceiptsAccrued && expected.latchReceipts === r.latchReceiptsAccrued
      && expected.historicalNand === r.historicalNandAccrued && expected.historicalLatch === r.historicalLatchAccrued && expected.residue === r.residue,
    balanceIdentity: r.bemBalance + r.deficit === outstanding + r.residue + r.unrecognized,
    paidIdentity: r.totalPaid === r.feePaid + r.nandReceiptsPaid + r.latchReceiptsPaid + r.historicalNandPaid + r.historicalLatchPaid,
    accruedIdentity: r.totalAccounted === r.feeAccrued + r.nandReceiptsAccrued + r.latchReceiptsAccrued + r.historicalNandAccrued + r.historicalLatchAccrued + r.residue,
    noDeficit: r.deficit === 0n,
    residueWithinBound: r.residue <= residueBound(toShares(config)),
    noBucketOverpaid: r.feePaid <= r.feeAccrued && r.nandReceiptsPaid <= r.nandReceiptsAccrued && r.latchReceiptsPaid <= r.latchReceiptsAccrued
      && r.historicalNandPaid <= r.historicalNandAccrued && r.historicalLatchPaid <= r.historicalLatchAccrued,
  };
  return { status: Object.values(checks).every(Boolean) ? 'PASS' as const : 'FAIL' as const, checks, outstanding: {
    fee: r.feeAccrued - r.feePaid, nandReceipts: r.nandReceiptsAccrued - r.nandReceiptsPaid, latchReceipts: r.latchReceiptsAccrued - r.latchReceiptsPaid,
    historicalNand: r.historicalNandAccrued - r.historicalNandPaid, historicalLatch: r.historicalLatchAccrued - r.historicalLatchPaid,
  } };
}

/** Per-ID sum check: sum(claimed[id]) must equal receiptsPaid for each collection. */
export async function checkPerIdHistories(rpc: PublicClient, pool: Address, config: PoolConfig, blockNumber?: bigint) {
  const result: Record<CategoryName, { ids: number; claimedSum: bigint; receiptsPaid: bigint; match: boolean }> = {} as never;
  for (const category of ['NAND', 'LATCH'] as const) {
    const shares = Number(category === 'NAND' ? config.nandShares : config.latchShares);
    let claimedSum = 0n;
    for (const ids of chunk(Array.from({ length: shares }, (_, i) => BigInt(i + 1)), 100)) {
      const values = await Promise.all(ids.map(id => read<bigint>(rpc, pool, 'claimed', [CATEGORY[category], id], blockNumber)));
      claimedSum += values.reduce((a, b) => a + b, 0n);
    }
    const receiptsPaid = await read<bigint>(rpc, pool, 'receiptsPaid', [CATEGORY[category]], blockNumber);
    result[category] = { ids: shares, claimedSum, receiptsPaid, match: claimedSum === receiptsPaid };
  }
  return result;
}

/** IDs held by `holder` in each collection, with their claimable income. */
export async function readHoldings(rpc: PublicClient, pool: Address, holder: Address, blockNumber?: bigint) {
  const target = getAddress(holder);
  const out: Record<CategoryName, { ids: bigint[]; claimable: bigint[]; total: bigint }> = {} as never;
  for (const category of ['NAND', 'LATCH'] as const) {
    const receipt = await read<Address>(rpc, pool, 'receiptOf', [CATEGORY[category]], blockNumber);
    const shares = await read<bigint>(rpc, pool, 'shareCount', [CATEGORY[category]], blockNumber);
    const ids: bigint[] = [];
    for (let first = 1n; first <= shares; first += 1000n) {
      const count = shares - first + 1n < 1000n ? shares - first + 1n : 1000n;
      const holders = await rpc.readContract({ address: receipt, abi: tapeoutReceiptAbi, functionName: 'holdersPage', args: [first, count], blockNumber }) as readonly Address[];
      holders.forEach((h, i) => { if (h === target) ids.push(first + BigInt(i)); });
    }
    let claimable: bigint[] = [];
    let total = 0n;
    if (ids.length > 0) {
      const [amounts, sum] = await read<readonly [readonly bigint[], bigint]>(rpc, pool, 'claimableBatch', [CATEGORY[category], ids], blockNumber);
      claimable = [...amounts];
      total = sum;
    }
    out[category] = { ids, claimable, total };
  }
  return out;
}

export async function readMiners(rpc: PublicClient, pool: Address, withPending = false, blockNumber?: bigint) {
  const count = await read<bigint>(rpc, pool, 'minerCount', [], blockNumber);
  const mining = await read<Address>(rpc, pool, 'mining', [], blockNumber);
  const miners: { tokenId: bigint; key: Hex; pendingEstimate?: bigint }[] = [];
  for (let offset = 0n; offset < count; offset += 500n) {
    const [tokenIds, keys] = await read<readonly [readonly bigint[], readonly Hex[]]>(rpc, pool, 'minersPage', [offset, 500n], blockNumber);
    tokenIds.forEach((tokenId, i) => miners.push({ tokenId, key: keys[i] }));
  }
  if (withPending) {
    // Display only: pending() is an estimate and can be 0 while claim() pays. Never used to skip a claim.
    await Promise.all(miners.map(async m => {
      m.pendingEstimate = await rpc.readContract({ address: mining, abi: miningAbi, functionName: 'pending', args: [m.key], blockNumber }).catch(() => undefined);
    }));
  }
  return miners;
}

const receiverAbi = [{
  type: 'function', name: 'onERC1155BatchReceived', stateMutability: 'nonpayable',
  inputs: [{ name: 'operator', type: 'address' }, { name: 'from', type: 'address' }, { name: 'ids', type: 'uint256[]' }, { name: 'values', type: 'uint256[]' }, { name: 'data', type: 'bytes' }],
  outputs: [{ name: '', type: 'bytes4' }],
}] as const;

/**
 * Holders that cannot receive ERC-1155 receipts. Addresses with code (contracts, and EOAs with an
 * EIP-7702 delegation) must return the receiver selector, exactly as the receipt's mint checks.
 */
export async function receiverProblems(rpc: PublicClient, receipt: Address, pool: Address, holders: Address[]) {
  const problems: { holder: Address; reason: string }[] = [];
  for (const holder of [...new Set(holders)]) {
    const code = await rpc.getCode({ address: holder });
    if (!code || code === '0x') continue;
    const kind = code.startsWith('0xef0100') ? `EIP-7702 delegation to 0x${code.slice(8, 48)}` : 'contract';
    try {
      const data = encodeFunctionData({ abi: receiverAbi, functionName: 'onERC1155BatchReceived', args: [pool, zeroAddress, [1n], [1n], '0x'] });
      const result = await rpc.call({ account: receipt, to: holder, data });
      if (!result.data || result.data.slice(0, 10).toLowerCase() !== '0xbc197c81') problems.push({ holder, reason: `${kind} does not accept ERC-1155 batches` });
    } catch {
      problems.push({ holder, reason: `${kind} reverts onERC1155BatchReceived` });
    }
  }
  return problems;
}

/** Simulate harvest batches and bisect any batch with failures to name the failing miners. */
export async function findFailingMiners(rpc: PublicClient, pool: Address, tokenIds: bigint[], from: Address): Promise<bigint[]> {
  const failedOf = async (ids: bigint[]) => {
    const data = encodeFunctionData({ abi: tapeoutMinerPoolAbi, functionName: 'harvest', args: [ids] });
    const result = await rpc.call({ account: from, to: pool, data });
    const [, failed] = decodeFunctionResult({ abi: tapeoutMinerPoolAbi, functionName: 'harvest', data: result.data! }) as readonly [bigint, bigint];
    return failed;
  };
  const bisect = async (ids: bigint[]): Promise<bigint[]> => {
    if (ids.length === 0 || (await failedOf(ids)) === 0n) return [];
    if (ids.length === 1) return ids;
    const mid = Math.floor(ids.length / 2);
    return [...await bisect(ids.slice(0, mid)), ...await bisect(ids.slice(mid))];
  };
  return bisect(tokenIds);
}

export async function bemBalance(rpc: PublicClient, bem: Address, account: Address, blockNumber?: bigint) {
  return rpc.readContract({ address: bem, abi: erc20Abi, functionName: 'balanceOf', args: [account], blockNumber });
}
