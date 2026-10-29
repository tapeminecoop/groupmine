import { createHash } from 'node:crypto';
import { getAddress, isAddress, zeroAddress, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { z } from 'zod';
import { tapeoutEntitlementReceiptAbi, tapeoutMinerPoolAbi, tapeoutReceiptDistributorAbi } from './abi.js';
import { assignIds, validateAllocation, type AllocationFile, type Range } from './allocation.js';
import { LATCH_CATEGORY, NAND_CATEGORY, POOL_ROLES, type PoolRole } from './config.js';
import type { CategoryName } from './constants.js';
import type { OnChainRange } from './pool.js';

/**
 * Verification of an allocation against the chain, in one pinned block. It establishes, as far as the
 * inputs allow:
 * - identity: the node's chain, the configured distributor, both pools and receipts, the artifact, the
 *   distributor's own bindings (its two pools and receipts) and each pool's receipts all name the same
 *   system;
 * - artifact <-> chain: the same beneficiaries with the same NAND and LATCH IDs in both directions, the
 *   same totals, and holdings consistent with what has been delivered;
 * - coverage: per category, finalized supply, cumulative accepted inventory, assigned, delivered and
 *   undelivered counts, and the receipts that never entered the distributor (with their holders);
 * - reviewed JSON -> artifact (optional input): the file's exact hash, every beneficiary's counts, and
 *   the deterministic ID assignment recomputed from the inventory the import used.
 * It verifies the operator's approved input; it cannot tell whether off-chain contributions are true.
 */

const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x-prefixed 20-byte address');
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const idRun = z.tuple([z.number().int().positive(), z.number().int().positive()]);
const categoryRows = z.object({ count: z.number().int().nonnegative(), ranges: z.array(idRun) }).strict();
const inventoryRecord = z.object({ count: z.number().int().nonnegative(), sha256: hex64 }).strict();

export const allocationArtifactSchema = z.object({
  schema: z.literal('tapeout-allocation-artifact/1'),
  chainId: z.number().int().positive(),
  distributor: hexAddress,
  nandReceipt: hexAddress,
  latchReceipt: hexAddress,
  sourceSha256: hex64,
  blockNumber: z.string().regex(/^\d+$/),
  totals: z.object({ NAND: z.number().int().nonnegative(), LATCH: z.number().int().nonnegative(), wallets: z.number().int().nonnegative() }).strict(),
  wallets: z.array(z.object({ wallet: hexAddress, ref: z.string().max(128).optional(), nand: categoryRows, latch: categoryRows }).strict()),
  /** The distributor inventory the import assigned IDs from (written by import-allocation since the
   *  security-review remediation; older artifacts lack it). */
  inventory: z.object({ blockNumber: z.string().regex(/^\d+$/), blockHash: z.string().regex(/^0x[0-9a-f]{64}$/), NAND: inventoryRecord, LATCH: inventoryRecord }).strict().optional(),
  howToClaim: z.string(),
}).strict();

export type AllocationArtifact = z.infer<typeof allocationArtifactSchema>;

/** Parse untrusted JSON as an artifact; throws with every schema problem. */
export function parseAllocationArtifact(json: unknown): AllocationArtifact {
  const parsed = allocationArtifactSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid allocation artifact:\n- ${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('\n- ')}`);
  return parsed.data;
}

/** Digest convention for an inventory: sha256 of the ascending decimal IDs joined by ",". */
export const inventoryDigest = (ids: readonly number[]) => createHash('sha256').update([...ids].sort((a, b) => a - b).join(',')).digest('hex');

type IdSets = Record<CategoryName, Set<number>>;
const CATEGORIES = ['NAND', 'LATCH'] as const;
const CATEGORY_ID: Record<CategoryName, Hex> = { NAND: NAND_CATEGORY, LATCH: LATCH_CATEGORY };
const expandRuns = (runs: readonly (readonly [number, number])[]) => runs.flatMap(([first, count]) => Array.from({ length: count }, (_, i) => first + i));

/** Internal consistency of an artifact: addresses, counts, duplicates, overlapping IDs and totals. */
export function artifactProblems(a: AllocationArtifact): string[] {
  const problems: string[] = [];
  if (a.wallets.length === 0) problems.push('artifact lists no wallets');
  const seenWallets = new Set<string>();
  const seenIds: IdSets = { NAND: new Set(), LATCH: new Set() };
  const sums = { NAND: 0, LATCH: 0 };
  for (const [i, w] of a.wallets.entries()) {
    if (!isAddress(w.wallet, { strict: true })) problems.push(`wallets[${i}]: invalid address checksum ${w.wallet}`);
    else if (getAddress(w.wallet) === zeroAddress) problems.push(`wallets[${i}]: zero address`);
    const key = w.wallet.toLowerCase();
    if (seenWallets.has(key)) problems.push(`wallets[${i}]: ${w.wallet} listed twice`);
    seenWallets.add(key);
    if (w.nand.count + w.latch.count === 0) problems.push(`wallets[${i}]: ${w.wallet} is assigned no IDs`);
    for (const [c, rows] of [['NAND', w.nand], ['LATCH', w.latch]] as const) {
      const ids = expandRuns(rows.ranges);
      if (ids.length !== rows.count) problems.push(`wallets[${i}].${c.toLowerCase()}: count ${rows.count} but its ranges hold ${ids.length} IDs`);
      for (const id of ids) {
        if (seenIds[c].has(id)) problems.push(`${c} #${id} is assigned twice in the artifact`);
        seenIds[c].add(id);
      }
      sums[c] += rows.count;
    }
  }
  for (const c of CATEGORIES) if (a.totals[c] !== sums[c]) problems.push(`totals.${c} is ${a.totals[c]} but the wallet rows hold ${sums[c]}`);
  if (a.totals.wallets !== a.wallets.length) problems.push(`totals.wallets is ${a.totals.wallets} but ${a.wallets.length} wallets are listed`);
  return problems.slice(0, 50);
}

/** Everything verification needs, read at one block. `wallets` is every listed wallet, including
 *  wallets whose ranges were revoked (they stay listed with no ranges). Holders are for IDs 1..supply. */
export interface AllocationState {
  chainId: number;
  blockNumber: bigint;
  blockHash: Hex;
  distributor: Address;
  /** `distributor.optimalPool()` and `distributor.regularPool()`. */
  pools: Record<PoolRole, Address>;
  distributorReceipts: Record<CategoryName, Address>;
  /** Each of the distributor's pools' `nandReceipt()` and `latchReceipt()`. */
  poolReceipts: Record<PoolRole, Record<CategoryName, Address>>;
  /** `category()` of the distributor's receipts. */
  receiptCategories: Record<CategoryName, Hex>;
  finalized: boolean;
  /** inventory: receipts the distributor accepted (cumulative, never decreases on delivery). */
  totals: Record<CategoryName, { inventory: bigint; allocated: bigint; delivered: bigint }>;
  issuance: Record<CategoryName, { finalized: boolean; supply: bigint }>;
  wallets: { wallet: Address; ranges: readonly OnChainRange[] }[];
  holders: Record<CategoryName, readonly Address[]>;
}

/** The system the operator configured (addresses file): every field is compared with the chain. */
export interface VerifyTarget { chainId: number; distributor: Address; optimalPool: Address; regularPool: Address; nandReceipt: Address; latchReceipt: Address }
const targetPool = (t: VerifyTarget, role: PoolRole) => (role === 'optimal' ? t.optimalPool : t.regularPool);

/**
 * full-round (default): this round distributes every issued receipt, so finalized supply, accepted
 * inventory and assigned IDs must all agree. partial: explicitly selected; receipts kept outside the
 * distributor are allowed, listed, and every status says PARTIAL.
 */
export type VerifyMode = 'full-round' | 'partial';

export interface VerifyOptions {
  mode?: VerifyMode;
  /** The reviewed allocation JSON (parsed) and the sha256 of its exact bytes. */
  review?: { file: AllocationFile; sha256: string };
  /** IDs the distributor held at the artifact's inventory block, read from historical state by the
   *  caller; 'unavailable' when that state could not be read. */
  historicalInventory?: Record<CategoryName, number[]> | 'unavailable';
}

export type VerifyStatus =
  | 'MISMATCH' | 'NOT_READY' | 'READY_TO_FINALIZE' | 'FINALIZED_AND_MATCHES' | 'FINALIZED_INCOMPLETE_COVERAGE'
  | 'READY_TO_FINALIZE_PARTIAL' | 'FINALIZED_PARTIAL_AND_MATCHES';

const summarize = (ids: number[]) => {
  const runs: string[] = [];
  const sorted = [...ids].sort((x, y) => x - y);
  for (let i = 0; i < sorted.length && runs.length < 6; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    runs.push(i === j ? `#${sorted[i]}` : `#${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return runs.join(',') + (sorted.length > 0 && runs.length === 6 ? ',…' : '');
};

/**
 * Pure comparison of an artifact (and optionally the reviewed JSON) with a state snapshot. MISMATCH:
 * something disagrees; NOT_READY: they agree but finalization would fail or the full round is not
 * covered; READY_TO_FINALIZE: everything agrees and covers the round; FINALIZED_AND_MATCHES: finalized,
 * agrees and covers the round; FINALIZED_INCOMPLETE_COVERAGE: finalized and agrees, but part of the
 * supply never entered the distributor. With mode 'partial' the two positive statuses carry _PARTIAL.
 */
export function verifyAllocation(artifact: AllocationArtifact, state: AllocationState, target: VerifyTarget, options: VerifyOptions = {}) {
  const mode: VerifyMode = options.mode ?? 'full-round';
  const mismatches = [...artifactProblems(artifact)];
  const gaps: string[] = [];
  const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();

  // Identity: the artifact, the addresses file and the chain must name the same system.
  if (artifact.chainId !== state.chainId) mismatches.push(`artifact chainId ${artifact.chainId} is not the node's ${state.chainId}`);
  if (target.chainId !== state.chainId) mismatches.push(`addresses file chainId ${target.chainId} is not the node's ${state.chainId}`);
  if (!same(target.distributor, state.distributor)) mismatches.push(`configured distributor ${target.distributor} is not the one read (${state.distributor})`);
  if (!same(artifact.distributor, target.distributor)) mismatches.push(`artifact distributor ${artifact.distributor} is not ${target.distributor}`);
  for (const role of POOL_ROLES) {
    if (!same(targetPool(target, role), state.pools[role])) mismatches.push(`configured ${role} pool ${targetPool(target, role)} is not the distributor's ${role} pool ${state.pools[role]}`);
  }
  const receipts = { NAND: [artifact.nandReceipt, target.nandReceipt], LATCH: [artifact.latchReceipt, target.latchReceipt] } as const;
  for (const c of CATEGORIES) {
    const [inArtifact, inFile] = receipts[c];
    if (!same(inArtifact, state.distributorReceipts[c])) mismatches.push(`artifact ${c} receipt ${inArtifact} is not the distributor's ${state.distributorReceipts[c]}`);
    if (!same(inFile, state.distributorReceipts[c])) mismatches.push(`addresses file ${c} receipt ${inFile} is not the distributor's ${state.distributorReceipts[c]}`);
    for (const role of POOL_ROLES) {
      if (!same(state.poolReceipts[role][c], state.distributorReceipts[c])) mismatches.push(`the ${role} pool's ${c} receipt ${state.poolReceipts[role][c]} is not the distributor's`);
    }
    if (!same(state.receiptCategories[c], CATEGORY_ID[c])) mismatches.push(`${c} receipt ${state.distributorReceipts[c]} reports category ${state.receiptCategories[c]}, not ${c}`);
  }

  // The effective on-chain allocation: wallets with at least one range (revoked wallets stay listed empty).
  const onChain = new Map<string, { wallet: Address; ids: IdSets; ranges: readonly OnChainRange[] }>();
  const owner: Record<CategoryName, Map<number, string>> = { NAND: new Map(), LATCH: new Map() };
  const allocatedSum = { NAND: 0n, LATCH: 0n };
  const deliveredSum = { NAND: 0n, LATCH: 0n };
  for (const { wallet, ranges } of state.wallets) {
    if (ranges.length === 0) continue;
    const ids: IdSets = { NAND: new Set(), LATCH: new Set() };
    for (const r of ranges) {
      const c: CategoryName = r.category === 0 ? 'NAND' : 'LATCH';
      allocatedSum[c] += r.count;
      deliveredSum[c] += r.delivered;
      for (let i = 0n; i < r.count; i++) {
        const id = Number(r.firstId + i);
        const prior = owner[c].get(id);
        if (prior !== undefined) mismatches.push(`on chain, ${c} #${id} is allocated to both ${prior} and ${wallet}`);
        owner[c].set(id, wallet);
        ids[c].add(id);
      }
    }
    onChain.set(wallet.toLowerCase(), { wallet, ids, ranges });
  }
  for (const c of CATEGORIES) {
    if (allocatedSum[c] !== state.totals[c].allocated) mismatches.push(`on chain, ${c} ranges hold ${allocatedSum[c]} IDs but the distributor reports ${state.totals[c].allocated} allocated`);
    if (deliveredSum[c] !== state.totals[c].delivered) mismatches.push(`on chain, ${c} ranges record ${deliveredSum[c]} delivered but the distributor reports ${state.totals[c].delivered}`);
  }

  // Both directions: every artifact wallet on chain with the same IDs, and no on-chain wallet missing.
  const listed = new Set<string>();
  for (const w of artifact.wallets) {
    const key = w.wallet.toLowerCase();
    listed.add(key);
    const chain = onChain.get(key);
    if (!chain) {
      mismatches.push(`${w.wallet} is in the artifact but has no allocation on chain`);
      continue;
    }
    for (const [c, rows] of [['NAND', w.nand], ['LATCH', w.latch]] as const) {
      const planned = new Set(expandRuns(rows.ranges));
      const missing = [...planned].filter(id => !chain.ids[c].has(id));
      const extra = [...chain.ids[c]].filter(id => !planned.has(id));
      if (missing.length) mismatches.push(`${w.wallet} ${c}: artifact IDs not allocated to it on chain ${summarize(missing)}`);
      if (extra.length) mismatches.push(`${w.wallet} ${c}: on-chain IDs missing from the artifact ${summarize(extra)}`);
    }
  }
  for (const [key, chain] of onChain) if (!listed.has(key)) mismatches.push(`${chain.wallet} is allocated on chain but missing from the artifact`);
  for (const c of CATEGORIES) if (BigInt(artifact.totals[c]) !== state.totals[c].allocated) mismatches.push(`artifact totals.${c} ${artifact.totals[c]} is not the ${state.totals[c].allocated} allocated on chain`);

  // Holdings: undelivered IDs must still be in the distributor, delivered ones must have left it.
  let holdingsChecked = 0;
  for (const { wallet, ranges } of onChain.values()) {
    for (const r of ranges) {
      const c: CategoryName = r.category === 0 ? 'NAND' : 'LATCH';
      for (let i = 0n; i < r.count; i++) {
        const id = Number(r.firstId + i);
        const holder = state.holders[c][id - 1];
        holdingsChecked++;
        if (holder === undefined) mismatches.push(`${c} #${id} (allocated to ${wallet}) does not exist`);
        else if (i < r.delivered && same(holder, state.distributor)) mismatches.push(`${c} #${id} is recorded as delivered to ${wallet} but the distributor still holds it`);
        else if (i >= r.delivered && !same(holder, state.distributor)) mismatches.push(`${c} #${id} is undelivered but held by ${holder}, not the distributor`);
      }
    }
  }

  // Coverage. Accepted inventory = every allocated ID (delivered or not) plus IDs the distributor holds
  // unallocated; it must match the distributor's cumulative counter. Excluded = issued, never accepted.
  const accepted: Record<CategoryName, number[]> = { NAND: [], LATCH: [] };
  const coverage = {} as Record<CategoryName, {
    supply: bigint; issuanceFinalized: boolean; acceptedInventory: bigint; assigned: bigint; delivered: bigint; undelivered: bigint;
    unassignedInventory: bigint; excluded: { count: number; ids: string; holders: { holder: Address; count: number }[] };
  }>;
  for (const c of CATEGORIES) {
    const set = new Set(owner[c].keys());
    state.holders[c].forEach((h, i) => { if (same(h, state.distributor)) set.add(i + 1); });
    accepted[c] = [...set].sort((x, y) => x - y);
    if (BigInt(accepted[c].length) !== state.totals[c].inventory) mismatches.push(`${c}: the distributor reports ${state.totals[c].inventory} accepted receipts but ${accepted[c].length} are allocated or held by it`);
    const excludedIds: number[] = [];
    const byHolder = new Map<string, { holder: Address; count: number }>();
    for (let id = 1; id <= state.holders[c].length; id++) {
      if (set.has(id)) continue;
      excludedIds.push(id);
      const h = state.holders[c][id - 1];
      const entry = byHolder.get(h.toLowerCase()) ?? { holder: h, count: 0 };
      entry.count++;
      byHolder.set(h.toLowerCase(), entry);
    }
    coverage[c] = {
      supply: state.issuance[c].supply, issuanceFinalized: state.issuance[c].finalized, acceptedInventory: state.totals[c].inventory,
      assigned: allocatedSum[c], delivered: deliveredSum[c], undelivered: allocatedSum[c] - deliveredSum[c],
      unassignedInventory: state.totals[c].inventory - allocatedSum[c],
      excluded: { count: excludedIds.length, ids: summarize(excludedIds), holders: [...byHolder.values()].slice(0, 20) },
    };
  }

  // Reviewed JSON -> artifact -> chain.
  const review = reviewChecks(artifact, state, accepted, options, mismatches);

  // Readiness (before finalization) and coverage of the full round.
  const excludedTotal = coverage.NAND.excluded.count + coverage.LATCH.excluded.count;
  for (const c of CATEGORIES) {
    if (!state.issuance[c].finalized) gaps.push(`${c} issuance is not finalized`);
    if (state.totals[c].allocated !== state.totals[c].inventory) gaps.push(`${c}: ${state.totals[c].allocated} assigned of ${state.totals[c].inventory} accepted`);
    if (mode === 'full-round' && coverage[c].excluded.count > 0) {
      gaps.push(`${c}: ${coverage[c].excluded.count} of ${coverage[c].supply} issued receipts never entered the distributor (${coverage[c].excluded.ids}); a full round distributes the whole supply (use --partial only if retaining them is intended)`);
    }
  }
  if (state.totals.NAND.allocated + state.totals.LATCH.allocated === 0n) gaps.push('nothing is allocated');
  if (review.status === 'UNVERIFIED') gaps.push(`reviewed allocation: ${review.assignment.reason}`);

  let status: VerifyStatus;
  if (mismatches.length) status = 'MISMATCH';
  else if (state.finalized) status = mode === 'partial' ? 'FINALIZED_PARTIAL_AND_MATCHES' : excludedTotal > 0 ? 'FINALIZED_INCOMPLETE_COVERAGE' : 'FINALIZED_AND_MATCHES';
  else if (gaps.length) status = 'NOT_READY';
  else status = mode === 'partial' ? 'READY_TO_FINALIZE_PARTIAL' : 'READY_TO_FINALIZE';

  return {
    status,
    mode,
    blockNumber: state.blockNumber,
    blockHash: state.blockHash,
    identity: {
      chainId: { expected: target.chainId, artifact: artifact.chainId, chain: state.chainId },
      distributor: { expected: target.distributor, artifact: artifact.distributor, chain: state.distributor },
      pools: Object.fromEntries(POOL_ROLES.map(role => [role, { expected: targetPool(target, role), distributor: state.pools[role] }])),
      receipts: Object.fromEntries(CATEGORIES.map(c => [c, {
        expected: receipts[c][1], artifact: receipts[c][0], distributor: state.distributorReceipts[c],
        pools: Object.fromEntries(POOL_ROLES.map(role => [role, state.poolReceipts[role][c]])),
        category: state.receiptCategories[c], categoryMatches: same(state.receiptCategories[c], CATEGORY_ID[c]),
      }])),
    },
    coverage,
    review,
    mismatches: mismatches.slice(0, 100),
    mismatchCount: mismatches.length,
    readinessGaps: gaps,
    verified: {
      wallets: onChain.size,
      listedWallets: state.wallets.length,
      ids: { NAND: allocatedSum.NAND, LATCH: allocatedSum.LATCH },
      delivered: { NAND: deliveredSum.NAND, LATCH: deliveredSum.LATCH },
      holdingsChecked,
      allocationFinalized: state.finalized,
    },
  };
}

type ReviewResult = {
  status: 'NOT_PROVIDED' | 'VERIFIED' | 'UNVERIFIED' | 'MISMATCH';
  sha256?: { file: string; artifact: string; matches: boolean };
  wallets?: number;
  totals?: Record<CategoryName, number>;
  assignment: { status: 'NOT_CHECKED' | 'VERIFIED' | 'UNVERIFIED' | 'MISMATCH'; inventorySource?: string; reason?: string };
};

/** The reviewed JSON against the artifact (hash, beneficiaries, counts) and the ID assignment recomputed
 *  from the inventory the import used: the recorded inventory when the current state reproduces its
 *  digest, else historical state at the inventory block. Never today's remaining availability. */
function reviewChecks(artifact: AllocationArtifact, state: AllocationState, accepted: Record<CategoryName, number[]>, options: VerifyOptions, mismatches: string[]): ReviewResult {
  if (!options.review) return { status: 'NOT_PROVIDED', assignment: { status: 'NOT_CHECKED' } };
  const before = mismatches.length;
  const { file, sha256 } = options.review;
  const result: ReviewResult = { status: 'VERIFIED', sha256: { file: sha256, artifact: artifact.sourceSha256, matches: sha256 === artifact.sourceSha256 }, assignment: { status: 'NOT_CHECKED' } };
  if (!result.sha256!.matches) mismatches.push(`reviewed allocation file sha256 ${sha256} is not the artifact's sourceSha256 ${artifact.sourceSha256}`);
  let entries;
  try {
    entries = validateAllocation(file).entries;
  } catch (error) {
    mismatches.push(error instanceof Error ? error.message : String(error));
    return { ...result, status: 'MISMATCH', assignment: { status: 'NOT_CHECKED', reason: 'the reviewed allocation file is invalid' } };
  }
  result.wallets = entries.length;
  result.totals = { NAND: entries.reduce((s, e) => s + e.nandCount, 0), LATCH: entries.reduce((s, e) => s + e.latchCount, 0) };
  const byWallet = new Map(artifact.wallets.map(w => [w.wallet.toLowerCase(), w]));
  for (const e of entries) {
    const w = byWallet.get(e.wallet.toLowerCase());
    if (!w) mismatches.push(`reviewed allocation lists ${e.wallet}, which is not in the artifact`);
    else if (w.nand.count !== e.nandCount || w.latch.count !== e.latchCount) mismatches.push(`${e.wallet}: reviewed ${e.nandCount} NAND / ${e.latchCount} LATCH but the artifact assigns ${w.nand.count} / ${w.latch.count}`);
  }
  const inFile = new Set(entries.map(e => e.wallet.toLowerCase()));
  for (const w of artifact.wallets) if (!inFile.has(w.wallet.toLowerCase())) mismatches.push(`artifact assigns ${w.wallet}, which the reviewed allocation does not list`);
  for (const c of CATEGORIES) if (result.totals[c] !== artifact.totals[c]) mismatches.push(`reviewed allocation totals ${result.totals[c]} ${c} but the artifact ${artifact.totals[c]}`);

  // The inventory the import assigned from.
  let inventory: Record<CategoryName, number[]> | undefined;
  let source = '';
  let reason = '';
  const recorded = artifact.inventory;
  const digestsMatch = (inv: Record<CategoryName, number[]>) => !!recorded && CATEGORIES.every(c => inventoryDigest(inv[c]) === recorded[c].sha256 && inv[c].length === recorded[c].count);
  if (recorded && digestsMatch(accepted)) {
    inventory = accepted;
    source = `recorded inventory (block ${recorded.blockNumber}) reproduced by the accepted inventory at block ${state.blockNumber}`;
  } else if (options.historicalInventory && options.historicalInventory !== 'unavailable' && (!recorded || digestsMatch(options.historicalInventory))) {
    inventory = options.historicalInventory;
    source = `historical distributor holdings at block ${recorded?.blockNumber ?? artifact.blockNumber}`;
  } else {
    reason = recorded
      ? `the inventory recorded at block ${recorded.blockNumber} could not be reproduced (current accepted inventory differs and historical state is ${options.historicalInventory === 'unavailable' ? 'unavailable' : 'not consistent with it'}); the ID assignment is not verified`
      : `the artifact records no inventory and the distributor's holdings at block ${artifact.blockNumber} are ${options.historicalInventory === 'unavailable' || !options.historicalInventory ? 'unavailable' : 'not usable'}; the ID assignment is not verified`;
  }
  if (inventory) {
    try {
      const expected = assignIds(entries, inventory);
      const norm = (r: readonly Range[] | readonly (readonly [number, number])[]) => JSON.stringify(r.map(([a, b]) => [a, b]));
      let wrong = 0;
      for (const a of expected) {
        const w = byWallet.get(a.wallet.toLowerCase());
        if (!w) continue;
        if (norm(a.NAND) !== norm(w.nand.ranges) || norm(a.LATCH) !== norm(w.latch.ranges)) {
          wrong++;
          if (wrong <= 20) mismatches.push(`${a.wallet}: the artifact's IDs are not the deterministic assignment of the reviewed allocation (expected NAND ${norm(a.NAND)} LATCH ${norm(a.LATCH)})`);
        }
      }
      result.assignment = { status: wrong ? 'MISMATCH' : 'VERIFIED', inventorySource: source };
    } catch (error) {
      mismatches.push(`reviewed allocation cannot be assigned from the import's inventory: ${error instanceof Error ? error.message : String(error)}`);
      result.assignment = { status: 'MISMATCH', inventorySource: source };
    }
  } else {
    result.assignment = { status: 'UNVERIFIED', reason };
  }
  result.status = mismatches.length > before ? 'MISMATCH' : result.assignment.status === 'UNVERIFIED' ? 'UNVERIFIED' : 'VERIFIED';
  return result;
}

const read = <T>(rpc: PublicClient, address: Address, abi: Abi, functionName: string, args: readonly unknown[], blockNumber: bigint) =>
  rpc.readContract({ address, abi, functionName, args, blockNumber } as never) as Promise<T>;

/** Read everything `verifyAllocation` compares, pinned to one block. */
export async function readAllocationState(rpc: PublicClient, distributor: Address, blockNumber?: bigint): Promise<AllocationState> {
  const block = await rpc.getBlock(blockNumber === undefined ? { blockTag: 'latest' } : { blockNumber });
  const at = block.number!;
  const d = (fn: string, args: readonly unknown[] = []) => read<never>(rpc, distributor, tapeoutReceiptDistributorAbi as Abi, fn, args, at);
  const [chainId, optimalPool, regularPool, nand, latch, finalized, totals, walletCount] = await Promise.all([
    rpc.getChainId(), d('optimalPool') as Promise<Address>, d('regularPool') as Promise<Address>,
    d('nandReceipt') as Promise<Address>, d('latchReceipt') as Promise<Address>,
    d('allocationFinalized') as Promise<boolean>,
    d('totals') as Promise<readonly [readonly [bigint, bigint], readonly [bigint, bigint], readonly [bigint, bigint]]>,
    d('walletCount') as Promise<bigint>,
  ]);
  const poolReceipts = async (pool: Address) => {
    const p = (fn: string) => read<Address>(rpc, pool, tapeoutMinerPoolAbi as Abi, fn, [], at);
    const [NAND, LATCH] = await Promise.all([p('nandReceipt'), p('latchReceipt')]);
    return { NAND, LATCH };
  };
  const [optimalReceipts, regularReceipts] = await Promise.all([poolReceipts(optimalPool), poolReceipts(regularPool)]);
  const wallets: { wallet: Address; ranges: readonly OnChainRange[] }[] = [];
  for (let offset = 0n; offset < walletCount; offset += 500n) {
    const page = await d('walletsPage', [offset, walletCount - offset < 500n ? walletCount - offset : 500n]) as readonly Address[];
    for (const wallet of page) wallets.push({ wallet, ranges: await d('rangesOf', [wallet]) as readonly OnChainRange[] });
  }
  const receiptState = async (receipt: Address) => {
    const r = (fn: string, args: readonly unknown[] = []) => read<never>(rpc, receipt, tapeoutEntitlementReceiptAbi as Abi, fn, args, at);
    const [isFinal, supply, category] = await Promise.all([r('issuanceFinalized') as Promise<boolean>, r('totalSupply') as Promise<bigint>, r('category') as Promise<Hex>]);
    const holders: Address[] = [];
    for (let first = 1n; first <= supply; first += 1000n) {
      const count = supply - first + 1n < 1000n ? supply - first + 1n : 1000n;
      holders.push(...(await r('holdersPage', [first, count]) as readonly Address[]));
    }
    return { issuance: { finalized: isFinal, supply }, holders, category };
  };
  const [n, l] = await Promise.all([receiptState(nand), receiptState(latch)]);
  const [inventory, allocated, delivered] = totals;
  return {
    chainId, blockNumber: at, blockHash: block.hash!, distributor: getAddress(distributor), pools: { optimal: optimalPool, regular: regularPool },
    distributorReceipts: { NAND: nand, LATCH: latch }, poolReceipts: { optimal: optimalReceipts, regular: regularReceipts },
    receiptCategories: { NAND: n.category, LATCH: l.category },
    finalized,
    totals: {
      NAND: { inventory: inventory[0], allocated: allocated[0], delivered: delivered[0] },
      LATCH: { inventory: inventory[1], allocated: allocated[1], delivered: delivered[1] },
    },
    issuance: { NAND: n.issuance, LATCH: l.issuance },
    wallets,
    holders: { NAND: n.holders, LATCH: l.holders },
  };
}

/** IDs the distributor held at `blockNumber` (historical state; throws when the node cannot serve it). */
export async function readInventoryAt(rpc: PublicClient, distributor: Address, receipts: Record<CategoryName, Address>, blockNumber: bigint): Promise<Record<CategoryName, number[]>> {
  const out: Record<CategoryName, number[]> = { NAND: [], LATCH: [] };
  for (const c of CATEGORIES) {
    const supply = await read<bigint>(rpc, receipts[c], tapeoutEntitlementReceiptAbi as Abi, 'totalSupply', [], blockNumber);
    for (let first = 1n; first <= supply; first += 1000n) {
      const count = supply - first + 1n < 1000n ? supply - first + 1n : 1000n;
      const holders = await read<readonly Address[]>(rpc, receipts[c], tapeoutEntitlementReceiptAbi as Abi, 'holdersPage', [first, count], blockNumber);
      holders.forEach((h, i) => { if (h.toLowerCase() === distributor.toLowerCase()) out[c].push(Number(first) + i); });
    }
  }
  return out;
}

/** Inventory provenance for a new artifact: what the distributor held at the import's block. */
export function inventoryRecordFor(inventory: Record<CategoryName, number[]>, blockNumber: bigint, blockHash: Hex) {
  return {
    blockNumber: blockNumber.toString(), blockHash: blockHash.toLowerCase(),
    NAND: { count: inventory.NAND.length, sha256: inventoryDigest(inventory.NAND) },
    LATCH: { count: inventory.LATCH.length, sha256: inventoryDigest(inventory.LATCH) },
  };
}
