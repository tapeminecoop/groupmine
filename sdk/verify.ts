import { getAddress, isAddress, zeroAddress, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { z } from 'zod';
import { tapeoutEntitlementReceiptAbi, tapeoutMinerPoolAbi, tapeoutReceiptDistributorAbi } from './abi.js';
import type { CategoryName } from './constants.js';
import type { OnChainRange } from './pool.js';

/**
 * Verification of an allocation artifact (written by `import-allocation`) against the distributor it
 * names. Success means the artifact and the chain agree completely: same chain and contracts, the
 * same beneficiaries with the same NAND and LATCH IDs in both directions, the same totals, and
 * receipt holdings consistent with what has been delivered.
 */

const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x-prefixed 20-byte address');
const idRun = z.tuple([z.number().int().positive(), z.number().int().positive()]);
const categoryRows = z.object({ count: z.number().int().nonnegative(), ranges: z.array(idRun) }).strict();

export const allocationArtifactSchema = z.object({
  schema: z.literal('tapeout-allocation-artifact/1'),
  chainId: z.number().int().positive(),
  distributor: hexAddress,
  nandReceipt: hexAddress,
  latchReceipt: hexAddress,
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  blockNumber: z.string().regex(/^\d+$/),
  totals: z.object({ NAND: z.number().int().nonnegative(), LATCH: z.number().int().nonnegative(), wallets: z.number().int().nonnegative() }).strict(),
  wallets: z.array(z.object({ wallet: hexAddress, ref: z.string().max(128).optional(), nand: categoryRows, latch: categoryRows }).strict()),
  howToClaim: z.string(),
}).strict();

export type AllocationArtifact = z.infer<typeof allocationArtifactSchema>;

/** Parse untrusted JSON as an artifact; throws with every schema problem. */
export function parseAllocationArtifact(json: unknown): AllocationArtifact {
  const parsed = allocationArtifactSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid allocation artifact:\n- ${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('\n- ')}`);
  return parsed.data;
}

type IdSets = Record<CategoryName, Set<number>>;
const CATEGORIES = ['NAND', 'LATCH'] as const;
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
  pool: Address;
  distributorReceipts: Record<CategoryName, Address>;
  poolReceipts: Record<CategoryName, Address>;
  finalized: boolean;
  totals: Record<CategoryName, { inventory: bigint; allocated: bigint; delivered: bigint }>;
  issuance: Record<CategoryName, { finalized: boolean; supply: bigint }>;
  wallets: { wallet: Address; ranges: readonly OnChainRange[] }[];
  holders: Record<CategoryName, readonly Address[]>;
}

export interface VerifyTarget { chainId: number; distributor: Address; nandReceipt: Address; latchReceipt: Address }

export type VerifyStatus = 'MISMATCH' | 'NOT_READY' | 'READY_TO_FINALIZE' | 'FINALIZED_AND_MATCHES';

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
 * Pure comparison. MISMATCH: the artifact and chain disagree (or the artifact is inconsistent);
 * NOT_READY: they agree but finalization would fail or is not yet meaningful; READY_TO_FINALIZE:
 * they agree and finalization's preconditions hold; FINALIZED_AND_MATCHES: finalized and they agree.
 */
export function verifyAllocation(artifact: AllocationArtifact, state: AllocationState, target: VerifyTarget) {
  const mismatches = [...artifactProblems(artifact)];
  const gaps: string[] = [];
  const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();

  // Identity: the artifact, the addresses file and the chain must name the same system.
  if (artifact.chainId !== state.chainId) mismatches.push(`artifact chainId ${artifact.chainId} is not the node's ${state.chainId}`);
  if (target.chainId !== state.chainId) mismatches.push(`addresses file chainId ${target.chainId} is not the node's ${state.chainId}`);
  if (!same(artifact.distributor, target.distributor)) mismatches.push(`artifact distributor ${artifact.distributor} is not ${target.distributor}`);
  const receipts = { NAND: [artifact.nandReceipt, target.nandReceipt], LATCH: [artifact.latchReceipt, target.latchReceipt] } as const;
  for (const c of CATEGORIES) {
    const [inArtifact, inFile] = receipts[c];
    if (!same(inArtifact, state.distributorReceipts[c])) mismatches.push(`artifact ${c} receipt ${inArtifact} is not the distributor's ${state.distributorReceipts[c]}`);
    if (!same(inFile, state.distributorReceipts[c])) mismatches.push(`addresses file ${c} receipt ${inFile} is not the distributor's ${state.distributorReceipts[c]}`);
    if (!same(state.poolReceipts[c], state.distributorReceipts[c])) mismatches.push(`the pool's ${c} receipt ${state.poolReceipts[c]} is not the distributor's`);
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

  // Readiness: what finalizeAllocation requires, and that there is something to finalize.
  for (const c of CATEGORIES) {
    if (!state.issuance[c].finalized) gaps.push(`${c} issuance is not finalized`);
    if (state.totals[c].allocated !== state.totals[c].inventory) gaps.push(`${c}: ${state.totals[c].allocated} allocated of ${state.totals[c].inventory} held`);
  }
  if (state.totals.NAND.allocated + state.totals.LATCH.allocated === 0n) gaps.push('nothing is allocated');

  const status: VerifyStatus = mismatches.length ? 'MISMATCH' : state.finalized ? 'FINALIZED_AND_MATCHES' : gaps.length ? 'NOT_READY' : 'READY_TO_FINALIZE';
  return {
    status,
    blockNumber: state.blockNumber,
    blockHash: state.blockHash,
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

const read = <T>(rpc: PublicClient, address: Address, abi: Abi, functionName: string, args: readonly unknown[], blockNumber: bigint) =>
  rpc.readContract({ address, abi, functionName, args, blockNumber } as never) as Promise<T>;

/** Read everything `verifyAllocation` compares, pinned to one block. */
export async function readAllocationState(rpc: PublicClient, distributor: Address, blockNumber?: bigint): Promise<AllocationState> {
  const block = await rpc.getBlock(blockNumber === undefined ? { blockTag: 'latest' } : { blockNumber });
  const at = block.number!;
  const d = (fn: string, args: readonly unknown[] = []) => read<never>(rpc, distributor, tapeoutReceiptDistributorAbi as Abi, fn, args, at);
  const [chainId, pool, nand, latch, finalized, totals, walletCount] = await Promise.all([
    rpc.getChainId(), d('pool') as Promise<Address>, d('nandReceipt') as Promise<Address>, d('latchReceipt') as Promise<Address>,
    d('allocationFinalized') as Promise<boolean>,
    d('totals') as Promise<readonly [readonly [bigint, bigint], readonly [bigint, bigint], readonly [bigint, bigint]]>,
    d('walletCount') as Promise<bigint>,
  ]);
  const p = (fn: string) => read<Address>(rpc, pool, tapeoutMinerPoolAbi as Abi, fn, [], at);
  const [poolNand, poolLatch] = await Promise.all([p('nandReceipt'), p('latchReceipt')]);
  const wallets: { wallet: Address; ranges: readonly OnChainRange[] }[] = [];
  for (let offset = 0n; offset < walletCount; offset += 500n) {
    const page = await d('walletsPage', [offset, walletCount - offset < 500n ? walletCount - offset : 500n]) as readonly Address[];
    for (const wallet of page) wallets.push({ wallet, ranges: await d('rangesOf', [wallet]) as readonly OnChainRange[] });
  }
  const receiptState = async (receipt: Address) => {
    const r = (fn: string, args: readonly unknown[] = []) => read<never>(rpc, receipt, tapeoutEntitlementReceiptAbi as Abi, fn, args, at);
    const [isFinal, supply] = await Promise.all([r('issuanceFinalized') as Promise<boolean>, r('totalSupply') as Promise<bigint>]);
    const holders: Address[] = [];
    for (let first = 1n; first <= supply; first += 1000n) {
      const count = supply - first + 1n < 1000n ? supply - first + 1n : 1000n;
      holders.push(...(await r('holdersPage', [first, count]) as readonly Address[]));
    }
    return { issuance: { finalized: isFinal, supply }, holders };
  };
  const [n, l] = await Promise.all([receiptState(nand), receiptState(latch)]);
  const [inventory, allocated, delivered] = totals;
  return {
    chainId, blockNumber: at, blockHash: block.hash!, distributor: getAddress(distributor), pool,
    distributorReceipts: { NAND: nand, LATCH: latch }, poolReceipts: { NAND: poolNand, LATCH: poolLatch },
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
