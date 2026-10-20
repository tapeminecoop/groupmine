import { readFile } from 'node:fs/promises';
import { encodeAbiParameters, encodeDeployData, encodeFunctionData, getAddress, keccak256, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { z } from 'zod';
import { historicalDistributorAbi, tapeoutMinerPoolAbi } from './abi.js';
import bytecode from './bytecode.json' with { type: 'json' };
import { CATEGORY, RECIPIENT, type CategoryName } from './constants.js';
import { chunk } from './pool.js';
import type { TxPlan } from './tx.js';

/** Mirrors HistoricalDistributor.MAX_CONTRIBUTORS / MAX_PAGE and the uint96 weight type. */
export const MAX_CONTRIBUTORS = 400;
export const DISTRIBUTOR_PAGE = 500;
export const MAX_WEIGHT = 2n ** 96n - 1n;
/** EIP-3860: a creation transaction's data (code plus constructor arguments) is at most 49,152 bytes. */
export const MAX_INITCODE_SIZE = 49_152;

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x-prefixed 20-byte address');
/** Positive integer: a JSON number up to 2^53-1, or a decimal string for larger values. */
const integer = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9]\d*$/, 'expected a positive integer')]);

/** Manually decided historical contributors of one category and their weights (only ratios matter).
 *  `totalWeight` (optional) is a reviewed checksum that must equal the sum of the weights. */
export const weightsFileSchema = z.object({
  category: z.enum(['NAND', 'LATCH']),
  totalWeight: integer.optional(),
  contributors: z.array(z.object({ account: address, weight: integer, ref: z.string().max(128).optional() }).strict()).min(1).max(MAX_CONTRIBUTORS),
}).strict();

export type WeightsFile = z.infer<typeof weightsFileSchema>;

export interface Contributor {
  index: number;
  account: Address;
  weight: bigint;
  ref?: string;
}

export interface ContributorList {
  category: CategoryName;
  contributors: Contributor[];
  totalWeight: bigint;
  contributorsHash: Hex;
}

export async function loadWeights(file: string): Promise<WeightsFile> {
  return weightsFileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

/** Validate and normalize a weights file into the constructor's order (strictly ascending by
 *  address). Rejects duplicates (case-insensitive), the zero address, mixed-case addresses with a
 *  bad EIP-55 checksum, weights outside 1..2^96-1, a wrong `totalWeight` checksum, and accounts the
 *  contract refuses (`exclude`, e.g. the pool). */
export function buildContributorList(file: WeightsFile, exclude: Address[] = []): ContributorList {
  if (file.contributors.length < 1 || file.contributors.length > MAX_CONTRIBUTORS) {
    throw new Error(`${file.contributors.length} contributors; a distributor takes 1..${MAX_CONTRIBUTORS} (nest distributors for more)`);
  }
  const seen = new Map<Address, number>();
  const banned = new Set(exclude.map(a => getAddress(a)));
  const entries = file.contributors.map((c, position) => {
    const account = getAddress(c.account);
    const label = `contributors[${position}]${c.ref ? ` (${c.ref})` : ''}`;
    const hex = c.account.slice(2);
    if (hex !== hex.toLowerCase() && hex !== hex.toUpperCase() && c.account !== account) {
      throw new Error(`${label}: ${c.account} has an invalid EIP-55 checksum (expected ${account})`);
    }
    if (account === zeroAddress) throw new Error(`${label}: zero address`);
    if (banned.has(account)) throw new Error(`${label}: ${account} cannot be a contributor of this distributor`);
    const first = seen.get(account);
    if (first !== undefined) throw new Error(`${label}: ${account} already listed at contributors[${first}]`);
    seen.set(account, position);
    const weight = BigInt(c.weight);
    if (weight > MAX_WEIGHT) throw new Error(`${label}: weight ${weight} exceeds uint96`);
    return { account, weight, ...(c.ref ? { ref: c.ref } : {}) };
  });
  entries.sort((a, b) => (BigInt(a.account) < BigInt(b.account) ? -1 : 1));
  const contributors = entries.map((e, index) => ({ index, ...e }));
  const totalWeight = contributors.reduce((sum, c) => sum + c.weight, 0n);
  if (file.totalWeight !== undefined && BigInt(file.totalWeight) !== totalWeight) {
    throw new Error(`totalWeight checksum ${file.totalWeight} does not match the sum of the weights ${totalWeight}`);
  }
  return { category: file.category, contributors, totalWeight, contributorsHash: contributorsHash(contributors.map(c => c.account), contributors.map(c => c.weight)) };
}

/** Same value as HistoricalDistributor.contributorsHash(): keccak256(abi.encode(accounts, weights)). */
export function contributorsHash(accounts: readonly Address[], weights: readonly bigint[]): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address[]' }, { type: 'uint96[]' }], [accounts, weights]));
}

/** Exact bigint mirror of the distributor: entitlement(i) = floor(total * w(i) / W). */
export function distributorSplit(total: bigint, weights: readonly bigint[]) {
  if (total < 0n) throw new Error('total must be non-negative');
  const totalWeight = weights.reduce((sum, w) => sum + w, 0n);
  if (totalWeight === 0n) throw new Error('total weight must be positive');
  const entitlements = weights.map(w => (total * w) / totalWeight);
  const entitled = entitlements.reduce((sum, e) => sum + e, 0n);
  return { total, totalWeight, entitlements, entitled, residue: total - entitled, residueBound: BigInt(weights.length - 1) };
}

// ------------------------------------------------------------------ transaction plans

export function distributorConstructorArgs(pool: Address, list: ContributorList) {
  return [getAddress(pool), CATEGORY[list.category], list.contributors.map(c => c.account), list.contributors.map(c => c.weight)] as const;
}

export function distributorDeployPlan(pool: Address, list: ContributorList): TxPlan {
  const data = encodeDeployData({ abi: historicalDistributorAbi, bytecode: bytecode.HistoricalDistributor.bytecode as Hex, args: distributorConstructorArgs(pool, list) });
  const size = (data.length - 2) / 2;
  if (size > MAX_INITCODE_SIZE) throw new Error(`creation data is ${size} bytes, above the EIP-3860 initcode limit of ${MAX_INITCODE_SIZE}; split the list across nested distributors`);
  return { to: null, data, value: 0n, description: `deploy HistoricalDistributor for pool ${getAddress(pool)} ${list.category}: ${list.contributors.length} contributors, total weight ${list.totalWeight}, list hash ${list.contributorsHash}` };
}

/** ABI-encoded constructor arguments (the creation data after the bytecode), as block explorers
 *  ask for when verifying the source. */
export function distributorEncodedArgs(pool: Address, list: ContributorList): Hex {
  return `0x${distributorDeployPlan(pool, list).data.slice(bytecode.HistoricalDistributor.bytecode.length)}`;
}

const call = (distributor: Address, functionName: string, args: readonly unknown[], description: string): TxPlan =>
  ({ to: distributor, data: encodeFunctionData({ abi: historicalDistributorAbi, functionName, args } as never), value: 0n, description });

export function distributorReleasePlan(distributor: Address): TxPlan {
  return call(distributor, 'releaseFromPool', [], 'release this category\'s historical income from the pool into the distributor');
}

/** claimRange batches covering every contributor index 0..count-1. */
export function distributorClaimRangePlans(distributor: Address, count: number, batchSize = 100): TxPlan[] {
  if (batchSize < 1) throw new Error('batch size must be positive');
  const plans: TxPlan[] = [];
  for (let start = 0; start < count; start += batchSize) {
    plans.push(call(distributor, 'claimRange', [BigInt(start), BigInt(batchSize)], `pay contributors #${start}..#${Math.min(start + batchSize, count) - 1}`));
  }
  return plans;
}

export function distributorClaimPlans(distributor: Address, accounts: Address[], batchSize = 100): TxPlan[] {
  return chunk(accounts, batchSize).map(part => part.length === 1
    ? call(distributor, 'claim', [part[0]], `pay contributor ${part[0]}`)
    : call(distributor, 'claimBatch', [part], `pay ${part.length} listed contributors`));
}

// ------------------------------------------------------------------ reads and checks

export interface DistributorReconciliation {
  bemBalance: bigint; unrecognized: bigint; deficit: bigint; totalAccounted: bigint; totalPaid: bigint; entitled: bigint; residue: bigint;
}

const read = <T>(rpc: PublicClient, distributor: Address, functionName: string, args: readonly unknown[] = [], blockNumber?: bigint) =>
  rpc.readContract({ address: distributor, abi: historicalDistributorAbi, functionName, args, blockNumber } as never) as Promise<T>;

export async function readDistributor(rpc: PublicClient, distributor: Address, blockNumber?: bigint) {
  const r = <T>(fn: string, args: readonly unknown[] = []) => read<T>(rpc, distributor, fn, args, blockNumber);
  const [version, pool, category, role, bem, totalWeight, contributorsHash, contributorCount, totalAccounted, totalPaid, reconciliation, pendingFromPool] = await Promise.all([
    r<string>('VERSION'), r<Address>('pool'), r<number>('category'), r<number>('role'), r<Address>('bem'), r<bigint>('totalWeight'), r<Hex>('contributorsHash'),
    r<bigint>('contributorCount'), r<bigint>('totalAccounted'), r<bigint>('totalPaid'), r<DistributorReconciliation>('reconciliation'), r<bigint>('pendingFromPool'),
  ]);
  const poolRecipient = await rpc.readContract({ address: pool, abi: tapeoutMinerPoolAbi, functionName: 'recipientOf', args: [role], blockNumber }) as Address;
  const categoryName: CategoryName = category === CATEGORY.NAND ? 'NAND' : 'LATCH';
  return { distributor: getAddress(distributor), version, pool, category: categoryName, role, bem, totalWeight, contributorsHash, contributorCount, totalAccounted, totalPaid, reconciliation, pendingFromPool, poolRecipient, isPoolRecipient: poolRecipient === getAddress(distributor) };
}

export type DistributorSummary = Awaited<ReturnType<typeof readDistributor>>;

/** Every contributor with its weight and claimed history, in contract order. */
export async function readContributors(rpc: PublicClient, distributor: Address, count: bigint, blockNumber?: bigint) {
  const out: { index: number; account: Address; weight: bigint; claimed: bigint }[] = [];
  for (let offset = 0n; offset < count; offset += BigInt(DISTRIBUTOR_PAGE)) {
    const [accounts, weights, claimed] = await read<readonly [readonly Address[], readonly bigint[], readonly bigint[]]>(rpc, distributor, 'contributorsPage', [offset, BigInt(DISTRIBUTOR_PAGE)], blockNumber);
    accounts.forEach((account, i) => out.push({ index: out.length, account, weight: weights[i], claimed: claimed[i] }));
  }
  return out;
}

/** Ledger identities from `reconciliation()`; with the contributor list also the per-contributor
 *  checks: histories sum to totalPaid, nobody is overpaid, and the off-chain split matches. */
export function checkDistributor(s: DistributorSummary, contributors?: Awaited<ReturnType<typeof readContributors>>) {
  const r = s.reconciliation;
  const checks: Record<string, boolean> = {
    balanceIdentity: r.bemBalance + r.deficit === r.totalAccounted - r.totalPaid + r.unrecognized,
    accruedIdentity: r.totalAccounted === r.entitled + r.residue,
    noDeficit: r.deficit === 0n,
    residueWithinBound: r.residue <= s.contributorCount - 1n,
    paidWithinAccounted: r.totalPaid <= r.totalAccounted,
  };
  if (contributors) {
    const split = distributorSplit(r.totalAccounted, contributors.map(c => c.weight));
    checks.listMatchesStoredHash = contributorsHash(contributors.map(c => c.account), contributors.map(c => c.weight)) === s.contributorsHash;
    checks.totalWeightMatches = split.totalWeight === s.totalWeight;
    checks.offChainMathMatches = split.entitled === r.entitled && split.residue === r.residue;
    checks.claimedSumMatchesPaid = contributors.reduce((sum, c) => sum + c.claimed, 0n) === r.totalPaid;
    checks.noContributorOverpaid = contributors.every((c, i) => c.claimed <= split.entitlements[i]);
  }
  return { status: Object.values(checks).every(Boolean) ? 'PASS' as const : 'FAIL' as const, checks };
}

/** Pool-side facts a deployment should be checked against before it is made a recipient. */
export async function distributorPoolChecks(rpc: PublicClient, pool: Address, category: CategoryName) {
  const r = <T>(fn: string, args: readonly unknown[] = []) => rpc.readContract({ address: pool, abi: tapeoutMinerPoolAbi, functionName: fn, args } as never) as Promise<T>;
  const role = category === 'NAND' ? RECIPIENT.HISTORICAL_NAND : RECIPIENT.HISTORICAL_LATCH;
  const [version, bem, active, historicalShares, currentRecipient] = await Promise.all([
    r<string>('VERSION'), r<Address>('bem'), r<boolean>('active'), r<bigint>('historicalShareCount', [CATEGORY[category]]), r<Address>('recipientOf', [role]),
  ]);
  const warnings: string[] = [];
  if (historicalShares === 0n) warnings.push(`pool has no historical ${category} shares (H = 0) in its ${active ? 'active' : 'current setup'} configuration: the distributor would receive no pool income`);
  return { version, bem, active, historicalShares, currentRecipient, warnings };
}
