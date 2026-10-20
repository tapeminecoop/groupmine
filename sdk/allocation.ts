import { readFile } from 'node:fs/promises';
import { getAddress, zeroAddress, type Address } from 'viem';
import { z } from 'zod';
import type { CategoryName } from './constants.js';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x-prefixed 20-byte address');
const entry = z.union([
  z.object({ holder: address, shares: z.number().int().positive(), ref: z.string().max(128).optional() }).strict(),
  z.object({ holder: address, ids: z.array(z.number().int().positive()).min(1), ref: z.string().max(128).optional() }).strict(),
]);

/** Manual allocation decided from the EOA contribution records. `shares` entries receive the
 *  lowest free IDs in file order; `ids` entries pin exact IDs. `reserve` (optional) receives every
 *  remaining ID so that IDs 1..S are all issued before activation. */
export const allocationSchema = z.object({
  nand: z.array(entry).default([]),
  latch: z.array(entry).default([]),
  reserve: address.optional(),
}).strict();

export type AllocationFile = z.infer<typeof allocationSchema>;

export interface Assignment {
  holder: Address;
  ids: number[];
  ref?: string;
}

export interface Issuance {
  category: CategoryName;
  shares: number;
  assignments: Assignment[];
}

export async function loadAllocation(file: string): Promise<AllocationFile> {
  return allocationSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

export function buildIssuance(category: CategoryName, shares: number, entries: AllocationFile['nand'], reserve?: string): Issuance {
  const taken = new Map<number, number>();
  const assignments: Assignment[] = entries.map(e => ({ holder: holderAddress(e.holder), ids: [], ...(e.ref ? { ref: e.ref } : {}) }));
  entries.forEach((e, index) => {
    if (!('ids' in e)) return;
    for (const id of e.ids) {
      if (id < 1 || id > shares) throw new Error(`${category}: id ${id} outside 1..${shares}`);
      if (taken.has(id)) throw new Error(`${category}: id ${id} allocated twice`);
      taken.set(id, index);
      assignments[index].ids.push(id);
    }
  });
  let next = 1;
  entries.forEach((e, index) => {
    if (!('shares' in e)) return;
    for (let n = 0; n < e.shares; n++) {
      while (taken.has(next)) next++;
      if (next > shares) throw new Error(`${category}: allocations exceed the ${shares} configured shares`);
      taken.set(next, index);
      assignments[index].ids.push(next);
    }
  });
  const missing: number[] = [];
  for (let id = 1; id <= shares; id++) if (!taken.has(id)) missing.push(id);
  if (missing.length > 0) {
    if (!reserve) throw new Error(`${category}: ${missing.length} of ${shares} shares unallocated; allocate them or name a reserve holder`);
    assignments.push({ holder: holderAddress(reserve), ids: missing, ref: 'reserve' });
  }
  for (const a of assignments) a.ids.sort((x, y) => x - y);
  return { category, shares, assignments: assignments.filter(a => a.ids.length > 0) };
}

function holderAddress(raw: string): Address {
  const value = getAddress(raw);
  if (value === zeroAddress) throw new Error('holder cannot be the zero address');
  return value;
}

/** Contiguous runs of a sorted ID list, e.g. [1,2,3,7,9,10] -> [[1,3],[7,1],[9,2]] as [first,count]. */
export function runs(ids: number[]): Array<[number, number]> {
  const sorted = [...ids].sort((a, b) => a - b);
  const result: Array<[number, number]> = [];
  for (const id of sorted) {
    const last = result.at(-1);
    if (last && last[0] + last[1] === id) last[1]++;
    else result.push([id, 1]);
  }
  return result;
}

export type IssuanceCall =
  | { kind: 'range'; category: CategoryName; holder: Address; firstId: number; count: number }
  | { kind: 'list'; category: CategoryName; holders: Address[]; ids: number[] };

/** Minimal set of issuance calls, each minting at most `maxIdsPerCall` IDs. IDs listed in
 *  `alreadyIssued` are skipped, so a partially executed plan can be resumed safely. */
export function issuanceCalls(issuance: Issuance, maxIdsPerCall = 200, alreadyIssued: Set<number> = new Set()): IssuanceCall[] {
  if (maxIdsPerCall < 1) throw new Error('maxIdsPerCall must be positive');
  const calls: IssuanceCall[] = [];
  let singles: { holder: Address; id: number }[] = [];
  const flush = () => {
    for (let i = 0; i < singles.length; i += maxIdsPerCall) {
      const chunk = singles.slice(i, i + maxIdsPerCall);
      calls.push({ kind: 'list', category: issuance.category, holders: chunk.map(s => s.holder), ids: chunk.map(s => s.id) });
    }
    singles = [];
  };
  for (const a of issuance.assignments) {
    for (const [first, count] of runs(a.ids.filter(id => !alreadyIssued.has(id)))) {
      if (count === 1) { singles.push({ holder: a.holder, id: first }); continue; }
      for (let offset = 0; offset < count; offset += maxIdsPerCall) {
        calls.push({ kind: 'range', category: issuance.category, holder: a.holder, firstId: first + offset, count: Math.min(maxIdsPerCall, count - offset) });
      }
    }
  }
  flush();
  return calls;
}

export function summarize(issuance: Issuance) {
  const byHolder = new Map<string, number>();
  for (const a of issuance.assignments) byHolder.set(a.holder, (byHolder.get(a.holder) ?? 0) + a.ids.length);
  return {
    category: issuance.category,
    shares: issuance.shares,
    holders: [...byHolder.entries()].map(([holder, count]) => ({ holder, count, fractionOfCategory: `${((count / issuance.shares) * 100).toFixed(4)}%` })),
  };
}
