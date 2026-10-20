import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getAddress, isAddress, zeroAddress, type Address } from 'viem';
import { z } from 'zod';
import { BATCH_GAS_BUDGET, type CategoryName } from './constants.js';
import { ALLOCATE_GAS } from './gas.js';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x-prefixed 20-byte address');

/** Operator-facing allocation file: wallet addresses and receipt counts per collection. */
export const allocationFileSchema = z.object({
  allocations: z.array(z.object({
    wallet: address,
    nandCount: z.number().int().nonnegative().max(1_000_000),
    latchCount: z.number().int().nonnegative().max(1_000_000),
    ref: z.string().max(128).optional(),
  }).strict()).min(1),
}).strict();

export type AllocationFile = z.infer<typeof allocationFileSchema>;

export interface AllocationEntry {
  wallet: Address;
  nandCount: number;
  latchCount: number;
  ref?: string;
}

/** [firstId, count] runs of consecutive IDs. */
export type Range = readonly [number, number];

export interface Assignment {
  wallet: Address;
  ref?: string;
  NAND: Range[];
  LATCH: Range[];
}

export const MAX_RANGE = 1000; // TapeoutReceiptDistributor.MAX_RANGE

export async function loadAllocationFile(file: string) {
  const bytes = await readFile(file);
  const parsed = allocationFileSchema.parse(JSON.parse(bytes.toString('utf8')));
  return { file: parsed, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Normalizes and validates wallets and counts; throws with every problem found. */
export function validateAllocation(file: AllocationFile): { entries: AllocationEntry[]; totals: Record<CategoryName, number> } {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  const entries: AllocationEntry[] = [];
  file.allocations.forEach((a, i) => {
    // Mixed-case addresses must carry a valid EIP-55 checksum (catches copy errors); all-lowercase is accepted.
    if (!isAddress(a.wallet, { strict: true })) {
      problems.push(`allocations[${i}]: invalid address checksum ${a.wallet}`);
      return;
    }
    const wallet = getAddress(a.wallet);
    if (wallet === zeroAddress) problems.push(`allocations[${i}]: zero address`);
    const key = wallet.toLowerCase();
    if (seen.has(key)) problems.push(`allocations[${i}]: wallet ${wallet} already listed at allocations[${seen.get(key)}]`);
    seen.set(key, i);
    if (a.nandCount === 0 && a.latchCount === 0) problems.push(`allocations[${i}]: ${wallet} receives nothing`);
    entries.push({ wallet, nandCount: a.nandCount, latchCount: a.latchCount, ...(a.ref ? { ref: a.ref } : {}) });
  });
  if (problems.length) throw new Error(`Allocation file rejected:\n- ${problems.join('\n- ')}`);
  return { entries, totals: { NAND: entries.reduce((s, e) => s + e.nandCount, 0), LATCH: entries.reduce((s, e) => s + e.latchCount, 0) } };
}

export function runs(ids: number[]): Range[] {
  const out: [number, number][] = [];
  for (const id of ids) {
    const last = out.at(-1);
    if (last && last[0] + last[1] === id) last[1]++;
    else out.push([id, 1]);
  }
  return out;
}

/**
 * Deterministically assigns IDs from the distributor's inventory: wallets in file order take the lowest
 * remaining IDs of each collection. Every inventory ID must be assigned (coverage) and no ID twice.
 */
export function assignIds(entries: AllocationEntry[], inventory: Record<CategoryName, number[]>): Assignment[] {
  const problems: string[] = [];
  const pools: Record<CategoryName, number[]> = { NAND: [], LATCH: [] };
  for (const c of ['NAND', 'LATCH'] as const) {
    const sorted = [...inventory[c]].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) if (sorted[i] === sorted[i - 1]) problems.push(`${c}: inventory lists ID ${sorted[i]} twice`);
    if (sorted.some(id => !Number.isInteger(id) || id < 1)) problems.push(`${c}: invalid ID in inventory`);
    pools[c] = sorted;
    const wanted = entries.reduce((s, e) => s + (c === 'NAND' ? e.nandCount : e.latchCount), 0);
    if (wanted !== sorted.length) problems.push(`${c}: allocation totals ${wanted} but the distributor holds ${sorted.length} (every held receipt must be allocated)`);
  }
  if (problems.length) throw new Error(`Allocation cannot cover the inventory:\n- ${problems.join('\n- ')}`);
  const cursor: Record<CategoryName, number> = { NAND: 0, LATCH: 0 };
  return entries.map(e => {
    const take = (c: CategoryName, count: number) => {
      const ids = pools[c].slice(cursor[c], cursor[c] + count);
      cursor[c] += count;
      return runs(ids);
    };
    return { wallet: e.wallet, ...(e.ref ? { ref: e.ref } : {}), NAND: take('NAND', e.nandCount), LATCH: take('LATCH', e.latchCount) };
  });
}

export interface DistributorInput {
  category: number;
  wallet: Address;
  firstId: bigint;
  count: bigint;
}

/**
 * Distributor `allocate` batches. Each carries at most `maxIdsPerTx` IDs and stays within `gasBudget`
 * under ALLOCATE_GAS, which charges every range (many small wallets cost more than one large one).
 */
export function allocationBatches(assignments: Assignment[], maxIdsPerTx = 400, gasBudget: bigint = BATCH_GAS_BUDGET): DistributorInput[][] {
  if (maxIdsPerTx < 1) throw new Error('maxIdsPerTx must be positive');
  const g = { base: Number(ALLOCATE_GAS.base), perId: Number(ALLOCATE_GAS.perId), perRange: Number(ALLOCATE_GAS.perRange) };
  const budget = Number(gasBudget);
  if (budget < g.base + g.perRange + g.perId) throw new Error('gas budget cannot fit a single allocation');
  const batches: DistributorInput[][] = [];
  let current: DistributorInput[] = [];
  let used = 0;
  let gas = g.base;
  const flush = () => {
    batches.push(current);
    current = [];
    used = 0;
    gas = g.base;
  };
  for (const a of assignments) {
    for (const [c, category] of [['NAND', 0], ['LATCH', 1]] as const) {
      for (const [first, count] of a[c]) {
        let offset = 0;
        while (offset < count) {
          const fitsByGas = Math.floor((budget - gas - g.perRange) / g.perId);
          if (used === maxIdsPerTx || fitsByGas < 1) {
            flush();
            continue;
          }
          const n = Math.min(count - offset, maxIdsPerTx - used, MAX_RANGE, fitsByGas);
          current.push({ category, wallet: a.wallet, firstId: BigInt(first + offset), count: BigInt(n) });
          offset += n;
          used += n;
          gas += g.perRange + n * g.perId;
        }
      }
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Upper-bound gas of one `allocate` batch under ALLOCATE_GAS. */
export function allocationBatchGas(batch: readonly DistributorInput[]): bigint {
  return ALLOCATE_GAS.base + batch.reduce((s, e) => s + ALLOCATE_GAS.perRange + e.count * ALLOCATE_GAS.perId, 0n);
}

export function allocationArtifact(meta: { chainId: number; distributor: Address; nandReceipt: Address; latchReceipt: Address; sourceSha256: string; blockNumber: bigint }, assignments: Assignment[]) {
  const count = (ranges: Range[]) => ranges.reduce((s, [, n]) => s + n, 0);
  return {
    schema: 'tapeout-allocation-artifact/1',
    ...meta,
    blockNumber: meta.blockNumber.toString(),
    totals: { NAND: assignments.reduce((s, a) => s + count(a.NAND), 0), LATCH: assignments.reduce((s, a) => s + count(a.LATCH), 0), wallets: assignments.length },
    wallets: assignments.map(a => ({ wallet: a.wallet, ...(a.ref ? { ref: a.ref } : {}), nand: { count: count(a.NAND), ranges: a.NAND }, latch: { count: count(a.LATCH), ranges: a.LATCH } })),
    howToClaim: 'Call claim(maxIds) on the distributor from your wallet (or anyone may call deliver(yourWallet, maxIds)); receipts arrive with all BEM accrued so far, then claim BEM on the pool with claimBatch(nandIds, latchIds).',
  };
}
