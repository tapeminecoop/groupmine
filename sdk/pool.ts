import {
  BaseError,
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { tapeoutEntitlementReceiptAbi, tapeoutMinerPoolAbi, tapeoutReceiptDistributorAbi } from './abi.js';
import bytecode from './bytecode.json' with { type: 'json' };
import { CATEGORY, MINER_STATUS_ACTIVE, erc20Abi, erc721Abi, miningAbi, type CategoryName } from './constants.js';
import { poolDeployment, receiptConstructorArgs, type SystemFile } from './config.js';
import { accrue, PARTICIPANT_PARTS, RECIPIENT_PARTS, residueBound, SINK, SINK_PARTS, TOTAL_PARTS, type Accrual, type State } from './math.js';
import { allocationBatchGas, type DistributorInput } from './allocation.js';
import {
  CALL_GAS, CLAIM_GAS, DEPLOY_GAS, FUND_GAS, HARVEST_GAS, ISSUE_GAS, admissionGasEstimate, deliveryBatches, idsGas, maxIdsPerTx,
  reachableDeliveryGas, revokeGas,
} from './gas.js';
import type { TxPlan } from './tx.js';

const call = (to: Address, abi: Abi, functionName: string, args: readonly unknown[], description: string, gas: bigint): TxPlan =>
  ({ to, data: encodeFunctionData({ abi, functionName, args } as never), value: 0n, description, gas });
const poolCall = (pool: Address, fn: string, args: readonly unknown[], d: string, gas: bigint) => call(pool, tapeoutMinerPoolAbi as Abi, fn, args, d, gas);
const receiptCall = (r: Address, fn: string, args: readonly unknown[], d: string, gas: bigint) => call(r, tapeoutEntitlementReceiptAbi as Abi, fn, args, d, gas);
const distributorCall = (x: Address, fn: string, args: readonly unknown[], d: string, gas: bigint) => call(x, tapeoutReceiptDistributorAbi as Abi, fn, args, d, gas);

export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error('batch size must be positive');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const ownableAbi = [{ type: 'function', name: 'renounceOwnership', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'owner', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }] as const;

// ------------------------------------------------------------------ transaction plans
// Every plan carries its worst-case gas bound from sdk/gas.ts.

export function deployReceiptPlans(f: SystemFile): TxPlan[] {
  const args = receiptConstructorArgs(f);
  const make = (label: string, a: readonly unknown[]) => ({ to: null, value: 0n, description: `deploy ${label} entitlement receipt (issuer ${f.receipts.issuer})`,
    data: encodeDeployData({ abi: tapeoutEntitlementReceiptAbi as Abi, bytecode: bytecode.TapeoutEntitlementReceipt.bytecode as Hex, args: a }), gas: DEPLOY_GAS.receipt });
  return [make('NAND', args.nand), make('LATCH', args.latch)];
}

export function deployPoolPlan(f: SystemFile, nandReceipt: Address, latchReceipt: Address): TxPlan {
  const d = poolDeployment(f, nandReceipt, latchReceipt);
  return { to: null, value: 0n, description: `deploy TapeoutMinerPool "${d.poolName}" (owner ${d.owner}, ${d.depositors.length} whitelisted depositors)`,
    data: encodeDeployData({ abi: tapeoutMinerPoolAbi as Abi, bytecode: bytecode.TapeoutMinerPool.bytecode as Hex, args: [d] }), gas: DEPLOY_GAS.pool };
}

export function deployDistributorPlan(owner: Address, pool: Address): TxPlan {
  return { to: null, value: 0n, description: `deploy TapeoutReceiptDistributor (owner ${owner}) for pool ${pool}`,
    data: encodeDeployData({ abi: tapeoutReceiptDistributorAbi as Abi, bytecode: bytecode.TapeoutReceiptDistributor.bytecode as Hex, args: [owner, pool] }), gas: DEPLOY_GAS.distributor };
}

export function issuePlans(receipt: Address, label: CategoryName, to: Address, count: number, batch = maxIdsPerTx(ISSUE_GAS)): TxPlan[] {
  const plans: TxPlan[] = [];
  for (let left = count; left > 0; left -= Math.min(batch, left)) {
    const n = Math.min(batch, left);
    plans.push(receiptCall(receipt, 'issue', [to, BigInt(n)], `issue the next ${n} ${label} receipt IDs to ${to}`, idsGas(ISSUE_GAS, n)));
  }
  return plans;
}

export const finalizeIssuancePlan = (receipt: Address, label: CategoryName) =>
  receiptCall(receipt, 'finalizeIssuance', [], `finalize ${label} issuance (supply fixed forever)`, CALL_GAS.finalizeIssuance);

/** Before finalization: burn the highest `count` IDs, which the issuer must still hold (undo over-issuance). */
export function retractPlans(receipt: Address, label: CategoryName, count: number, batch = maxIdsPerTx(ISSUE_GAS)): TxPlan[] {
  const plans: TxPlan[] = [];
  for (let left = count; left > 0; left -= Math.min(batch, left)) {
    const n = Math.min(batch, left);
    plans.push(receiptCall(receipt, 'retract', [BigInt(n)], `retract the highest ${n} ${label} receipt IDs (issuer-held, before finalization)`, idsGas(ISSUE_GAS, n)));
  }
  return plans;
}

export function fundPlans(receipt: Address, label: CategoryName, from: Address, distributor: Address, ids: bigint[], batch = 300): TxPlan[] {
  return chunk(ids, batch).map(part => receiptCall(receipt, 'safeBatchTransferFrom', [from, distributor, part, part.map(() => 1n), '0x'],
    `move ${part.length} ${label} receipts (#${part[0]}..#${part.at(-1)}) into the distributor`, idsGas(FUND_GAS, part.length)));
}

export function allocatePlans(distributor: Address, batches: DistributorInput[][]): TxPlan[] {
  return batches.map(b => distributorCall(distributor, 'allocate', [b],
    `allocate ${b.reduce((s, e) => s + e.count, 0n)} receipt IDs in ${b.length} ranges`, allocationBatchGas(b)));
}

/** `ranges`: the wallet's current ranges (`rangesOf`), which size the call. */
export const revokeWalletPlan = (distributor: Address, wallet: Address, ranges: readonly OnChainRange[]) =>
  distributorCall(distributor, 'revokeWallet', [wallet], `revoke every range allocated to ${wallet} (before finalization)`, revokeGas(ranges));
export const finalizeAllocationPlan = (distributor: Address) =>
  distributorCall(distributor, 'finalizeAllocation', [], 'finalize the allocation (beneficiaries become immutable; claims open)', CALL_GAS.finalizeAllocation);
/** One delivery, bounded for any cursor position reachable from `ranges` (others may deliver first). */
export const claimReceiptsPlan = (distributor: Address, maxIds: number, ranges: readonly OnChainRange[]): TxPlan =>
  ({ ...distributorCall(distributor, 'claim', [BigInt(maxIds)], `claim up to ${maxIds} allocated receipts`, reachableDeliveryGas(ranges, maxIds)), standalone: true });
export const deliverPlan = (distributor: Address, wallet: Address, maxIds: number, ranges: readonly OnChainRange[]): TxPlan =>
  ({ ...distributorCall(distributor, 'deliver', [wallet, BigInt(maxIds)], `deliver up to ${maxIds} receipts to their beneficiary ${wallet}`, reachableDeliveryGas(ranges, maxIds)), standalone: true });

/**
 * Every delivery `wallet` still needs (`claim` by the wallet itself, or `deliver` pushed by anyone when
 * `push`). Each is bounded for any cursor position reachable from this snapshot, so a call still fits
 * its gas limit if others deliver part of the wallet first; if they deliver all of it, a remaining call
 * reverts with NothingToDeliver. Each is `standalone`: never bundled into one Safe transaction.
 */
export function deliveryPlans(distributor: Address, wallet: Address, ranges: readonly OnChainRange[], cap: number, push: boolean): TxPlan[] {
  return deliveryBatches(ranges, cap).map(({ maxIds, gas }, i, all) => {
    const step = all.length > 1 ? ` (${i + 1} of ${all.length})` : '';
    const plan = push
      ? distributorCall(distributor, 'deliver', [wallet, BigInt(maxIds)], `deliver up to ${maxIds} receipts to their beneficiary ${wallet}${step}`, gas)
      : distributorCall(distributor, 'claim', [BigInt(maxIds)], `claim up to ${maxIds} allocated receipts${step}`, gas);
    return { ...plan, standalone: true };
  });
}

export const activatePlan = (pool: Address, nandShares: bigint, latchShares: bigint) =>
  poolCall(pool, 'activate', [nandShares, latchShares], `activate with S_N=${nandShares}, S_L=${latchShares}`, CALL_GAS.activate);

export const approveMinersPlan = (collection: Address, pool: Address) =>
  call(collection, erc721Abi as Abi, 'setApprovalForAll', [pool, true], `approve pool ${pool} to pull the caller's miners`, CALL_GAS.setApprovalForAll);

/** `registered`: miners registered before the first batch; each batch settles all of them plus earlier batches. */
function admissionPlans(pool: Address, fn: 'depositMiners' | 'registerMiners', ids: bigint[], batch: number, registered: bigint): TxPlan[] {
  let before = registered;
  return chunk(ids, batch).map(part => {
    const plan = poolCall(pool, fn, [part], `admit ${fn === 'registerMiners' ? 'pool-held ' : ''}miners ${part.join(',')} (settles every registered miner first)`,
      admissionGasEstimate(before, BigInt(part.length)));
    before += BigInt(part.length);
    return plan;
  });
}

export const depositPlans = (pool: Address, ids: bigint[], batch: number, registered: bigint) => admissionPlans(pool, 'depositMiners', ids, batch, registered);
export const registerPlans = (pool: Address, ids: bigint[], batch: number, registered: bigint) => admissionPlans(pool, 'registerMiners', ids, batch, registered);

export const harvestPlans = (pool: Address, ids: bigint[], batch: number) =>
  chunk(ids, batch).map(part => poolCall(pool, 'harvest', [part], `harvest miners ${part.join(',')}`, idsGas(HARVEST_GAS, part.length)));

export function harvestRangePlans(pool: Address, minerCount: bigint, batch: number): TxPlan[] {
  const plans: TxPlan[] = [];
  for (let start = 0n; start < minerCount; start += BigInt(batch)) {
    const count = minerCount - start < BigInt(batch) ? minerCount - start : BigInt(batch);
    plans.push(poolCall(pool, 'harvestRange', [start, BigInt(batch)], `harvest registry entries ${start}..${start + count - 1n}`, idsGas(HARVEST_GAS, count)));
  }
  return plans;
}

/**
 * Claim inputs as sets: every ID once per category, in first-seen order, with what was dropped. NAND #1
 * and LATCH #1 are different receipts. The pool's `claimableBatch` view counts a repeated ID once per
 * occurrence while `claimBatch` pays it once, so a preview and a transaction must use these inputs.
 */
export function canonicalClaimIds(nand: readonly bigint[], latch: readonly bigint[]) {
  const dedupe = (ids: readonly bigint[]) => {
    const seen = new Set<bigint>();
    const unique: bigint[] = [];
    const duplicates: bigint[] = [];
    for (const id of ids) {
      if (seen.has(id)) duplicates.push(id);
      else {
        seen.add(id);
        unique.push(id);
      }
    }
    return { unique, duplicates };
  };
  const n = dedupe(nand), l = dedupe(latch);
  return { NAND: n.unique, LATCH: l.unique, duplicates: { NAND: n.duplicates, LATCH: l.duplicates }, normalized: n.duplicates.length + l.duplicates.length > 0 };
}

/** `claimBatch` plans. Inputs must already be sets per category (see `canonicalClaimIds`). */
export function claimPlans(pool: Address, nandIds: bigint[], latchIds: bigint[], batch = 200): TxPlan[] {
  const canonical = canonicalClaimIds(nandIds, latchIds);
  if (canonical.normalized) {
    throw new Error(`claimPlans needs each ID once per category; repeated NAND ${canonical.duplicates.NAND.join(',') || '-'} LATCH ${canonical.duplicates.LATCH.join(',') || '-'} (normalize with canonicalClaimIds)`);
  }
  const items = [...nandIds.map(id => ['NAND', id] as const), ...latchIds.map(id => ['LATCH', id] as const)];
  return chunk(items, batch).map(part => {
    const n = part.filter(([c]) => c === 'NAND').map(([, id]) => id);
    const l = part.filter(([c]) => c === 'LATCH').map(([, id]) => id);
    return poolCall(pool, 'claimBatch', [n, l], `claim BEM for ${n.length} NAND + ${l.length} LATCH receipts`, idsGas(CLAIM_GAS, part.length));
  });
}

export const releasePlans = (pool: Address) => [
  poolCall(pool, 'releaseA', [], `pay recipient A its unpaid 1/84, and transfer C's whole unpaid 2/84 to the sink ${SINK}`, CALL_GAS.releaseA),
  poolCall(pool, 'releaseB', [], `pay recipient B its unpaid 1/84, and transfer C's whole unpaid 2/84 to the sink ${SINK}`, CALL_GAS.releaseB),
];

export const setRecipientPlan = (pool: Address, role: 0 | 1, to: Address) =>
  poolCall(pool, 'setRecipient', [role, to], `move recipient ${role === 0 ? 'A' : 'B'} to ${to} (sent by the current recipient)`, CALL_GAS.setRecipient);

export const renouncePlan = (target: Address, label: string) =>
  call(target, ownableAbi as unknown as Abi, 'renounceOwnership', [], `renounce ownership of the ${label}`, CALL_GAS.renounceOwnership);

// ------------------------------------------------------------------ reads

const readAs = <T>(rpc: PublicClient, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], blockNumber?: bigint) =>
  rpc.readContract({ address, abi, functionName, args, blockNumber } as never) as Promise<T>;
const readPool = <T>(rpc: PublicClient, pool: Address, fn: string, args: readonly unknown[] = [], b?: bigint) => readAs<T>(rpc, pool, tapeoutMinerPoolAbi as Abi, fn, args, b);
const readReceipt = <T>(rpc: PublicClient, r: Address, fn: string, args: readonly unknown[] = [], b?: bigint) => readAs<T>(rpc, r, tapeoutEntitlementReceiptAbi as Abi, fn, args, b);
const readDistributor = <T>(rpc: PublicClient, d: Address, fn: string, args: readonly unknown[] = [], b?: bigint) => readAs<T>(rpc, d, tapeoutReceiptDistributorAbi as Abi, fn, args, b);

export async function readReceiptSummary(rpc: PublicClient, receipt: Address, blockNumber?: bigint) {
  const [category, name, symbol, owner, issuanceFinalized, supply] = await Promise.all([
    readReceipt<Hex>(rpc, receipt, 'category', [], blockNumber), readReceipt<string>(rpc, receipt, 'name', [], blockNumber),
    readReceipt<string>(rpc, receipt, 'symbol', [], blockNumber), readReceipt<Address>(rpc, receipt, 'owner', [], blockNumber),
    readReceipt<boolean>(rpc, receipt, 'issuanceFinalized', [], blockNumber), readReceipt<bigint>(rpc, receipt, 'totalSupply', [], blockNumber),
  ]);
  return { address: receipt, category, name, symbol, owner, issuanceFinalized, supply };
}

/** IDs of `receipt` currently held by `holder` (scans the holder index). */
export async function readHeldIds(rpc: PublicClient, receipt: Address, holder: Address, blockNumber?: bigint): Promise<number[]> {
  const supply = await readReceipt<bigint>(rpc, receipt, 'totalSupply', [], blockNumber);
  const target = getAddress(holder);
  const ids: number[] = [];
  for (let first = 1n; first <= supply; first += 1000n) {
    const count = supply - first + 1n < 1000n ? supply - first + 1n : 1000n;
    const holders = await readReceipt<readonly Address[]>(rpc, receipt, 'holdersPage', [first, count], blockNumber);
    holders.forEach((h, i) => { if (h === target) ids.push(Number(first) + i); });
  }
  return ids;
}

export async function readDistributorSummary(rpc: PublicClient, distributor: Address, blockNumber?: bigint) {
  const [owner, finalized, totals, walletCount, pool] = await Promise.all([
    readDistributor<Address>(rpc, distributor, 'owner', [], blockNumber), readDistributor<boolean>(rpc, distributor, 'allocationFinalized', [], blockNumber),
    readDistributor<readonly [readonly [bigint, bigint], readonly [bigint, bigint], readonly [bigint, bigint]]>(rpc, distributor, 'totals', [], blockNumber),
    readDistributor<bigint>(rpc, distributor, 'walletCount', [], blockNumber), readDistributor<Address>(rpc, distributor, 'pool', [], blockNumber),
  ]);
  const [inventory, allocated, delivered] = totals;
  return { address: distributor, pool, owner, allocationFinalized: finalized, walletCount,
    NAND: { inventory: inventory[0], allocated: allocated[0], delivered: delivered[0] }, LATCH: { inventory: inventory[1], allocated: allocated[1], delivered: delivered[1] } };
}

export interface OnChainRange { category: number; firstId: bigint; count: bigint; delivered: bigint }

export async function readWalletRanges(rpc: PublicClient, distributor: Address, wallet: Address, blockNumber?: bigint) {
  return readDistributor<readonly OnChainRange[]>(rpc, distributor, 'rangesOf', [wallet], blockNumber);
}

export const ERC1155_RECEIVER_INTERFACE = '0x4e2312e0' as const;
const erc165Abi = [{ type: 'function', name: 'supportsInterface', stateMutability: 'view', inputs: [{ name: 'interfaceId', type: 'bytes4' }], outputs: [{ type: 'bool' }] }] as const;

const erc1155ReceiverAbi = [
  { type: 'function', name: 'onERC1155Received', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }], outputs: [{ type: 'bytes4' }] },
  { type: 'function', name: 'onERC1155BatchReceived', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256[]' }, { type: 'uint256[]' }, { type: 'bytes' }], outputs: [{ type: 'bytes4' }] },
] as const;
const RECEIVED = { single: '0xf23a6e61', batch: '0xbc197c81' } as const;

/**
 * Allocation wallets that could not take delivery. Contracts (including EIP-7702 delegated accounts)
 * must declare IERC1155Receiver through ERC-165; with `hooks` (the receipt and the distributor), the
 * single and batch receive hooks are also simulated from the receipt contract and must return their
 * selectors. Plain EOAs need no hook. A wallet that passes may still be unable to claim from the pool or
 * transfer later: only its actual implementation shows that (docs/OPERATIONS.md lists the tested ones).
 */
export async function receiverProblems(rpc: PublicClient, wallets: readonly Address[], blockNumber?: bigint, hooks?: { receipt: Address; operator: Address }): Promise<string[]> {
  const problems: string[] = [];
  for (const group of chunk([...wallets], 20)) {
    const results = await Promise.all(group.map(async wallet => {
      const code = await rpc.getCode({ address: wallet, blockNumber });
      if (!code || code === '0x') return undefined;
      const kind = code.toLowerCase().startsWith('0xef0100') ? 'an EIP-7702 delegated account' : 'a contract';
      const declared = await rpc.readContract({ address: wallet, abi: erc165Abi, functionName: 'supportsInterface', args: [ERC1155_RECEIVER_INTERFACE], blockNumber })
        .catch(() => false);
      if (!declared) return `${wallet} is ${kind} that does not declare IERC1155Receiver: delivery would revert and its receipts could never leave the distributor`;
      if (!hooks) return undefined;
      const answer = async (fn: 'onERC1155Received' | 'onERC1155BatchReceived') => {
        const args = fn === 'onERC1155Received' ? [hooks.operator, hooks.operator, 1n, 1n, '0x'] : [hooks.operator, hooks.operator, [1n], [1n], '0x'];
        try {
          const { data } = await rpc.call({ account: hooks.receipt, to: wallet, data: encodeFunctionData({ abi: erc1155ReceiverAbi, functionName: fn, args } as never), blockNumber });
          return data && data.length >= 10 ? (data.slice(0, 10).toLowerCase() as Hex) : undefined;
        } catch {
          return undefined;
        }
      };
      const [single, batch] = await Promise.all([answer('onERC1155Received'), answer('onERC1155BatchReceived')]);
      if (single === RECEIVED.single && batch === RECEIVED.batch) return undefined;
      return `${wallet} is ${kind} that declares IERC1155Receiver but its receive hook did not accept a simulated transfer (single ${single ?? 'reverted'}, batch ${batch ?? 'reverted'})`;
    }));
    problems.push(...results.filter((p): p is string => p !== undefined));
  }
  return problems;
}

export interface Reconciliation {
  bemBalance: bigint; unrecognized: bigint; deficit: bigint; totalAccounted: bigint; totalPaid: bigint;
  recipientAAccrued: bigint; recipientAPaid: bigint; recipientBAccrued: bigint; recipientBPaid: bigint;
  sinkAccrued: bigint; sinkPaid: bigint;
  nandIncome: bigint; nandReceiptsAccrued: bigint; nandReceiptsPaid: bigint;
  latchIncome: bigint; latchReceiptsAccrued: bigint; latchReceiptsPaid: bigint; residue: bigint;
}

/**
 * Read-layout policy (follow-up reviews: Fable T2-1, GPT ABI requirement). 2.1.0 inserted the sink fields
 * into the tuples of `accrual()`, `previewAccrual()` and `reconciliation()` without changing their
 * selectors, so a decoder for another layout misreads them without an error. The standard readers read
 * `VERSION` first and decode those tuples only for a version whose layout this SDK has.
 *
 * A self-reported version does not authenticate code. Write commands keep the stronger controls: the
 * runtime-template, immutable-binding and addresses-file checks of `checkDeployment`.
 */
export const READ_LAYOUT_VERSIONS = ['TapeoutMinerPool/2.1.0'] as const;
/** The local-only canary candidate has the same layout. It is decoded only when the caller opts in (the
 *  CLI does so on a loopback development node, where canary rehearsals run); that is never an approval. */
export const LOCAL_CANARY_LAYOUT_VERSIONS = ['RecoverableTapeoutMinerPool/canary-2-local'] as const;
export interface ReadLayoutPolicy { allowLocalCanary?: boolean }

/** The read-layout policy for a planning node of `kind` (see `executionContext`). */
export const readLayoutPolicyFor = (kind: string): ReadLayoutPolicy => ({ allowLocalCanary: kind === 'LOCAL_DEV_NODE' });

/** A read failure for an error message: viem's short message without request details, URLs removed. */
const readFailure = (error: unknown) => (error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : String(error))
  .replace(/https?:\/\/[^\s"'<>]+/g, '[RPC]').slice(0, 300);

/**
 * `VERSION` of `pool` at `blockNumber` if this SDK decodes its tuple layout; otherwise throws before any
 * version-sensitive tuple is read. An unreadable, missing or malformed `VERSION` is refused as well, never
 * taken for compatibility. No result is cached: each check belongs to its own node, pool and block.
 */
export async function assertReadLayout(rpc: PublicClient, pool: Address, blockNumber?: bigint, policy: ReadLayoutPolicy = {}): Promise<string> {
  let version: unknown;
  try {
    version = await readPool<string>(rpc, pool, 'VERSION', [], blockNumber);
  } catch (error) {
    throw new Error(`pool ${pool}: VERSION() could not be read (${readFailure(error)}); refusing to decode its accrual and reconciliation tuples`);
  }
  const supported: string[] = [...READ_LAYOUT_VERSIONS, ...(policy.allowLocalCanary ? LOCAL_CANARY_LAYOUT_VERSIONS : [])];
  if (typeof version !== 'string' || !supported.includes(version)) {
    const canary = (LOCAL_CANARY_LAYOUT_VERSIONS as readonly string[]).includes(String(version)) ? ' (the local canary layout is read only on a loopback development node)' : '';
    throw new Error(`pool ${pool} reports VERSION ${JSON.stringify(version)}; this SDK decodes accrual(), previewAccrual() and reconciliation() only for ${supported.join(', ')}${canary}. Use the SDK release that matches the pool.`);
  }
  return version;
}

/** Pool state for operators: `VERSION` is checked first (`assertReadLayout`), then everything is read at
 *  the same block. */
export async function readPoolSummary(rpc: PublicClient, pool: Address, blockNumber?: bigint, policy: ReadLayoutPolicy = {}) {
  const version = await assertReadLayout(rpc, pool, blockNumber, policy);
  const r = <T>(fn: string, args: readonly unknown[] = []) => readPool<T>(rpc, pool, fn, args, blockNumber);
  const [name, owner, active, activatedAt, nandShares, latchShares, totalNandBurn, totalLatchBurn, compositionPeriod, state, accrual, reconciliation, minerCount, recipientA, recipientB, sink, depositors, nandReceipt, latchReceipt, bem, mining, collection] = await Promise.all([
    r<string>('poolName'), r<Address>('owner'), r<boolean>('active'), r<bigint>('activatedAt'), r<bigint>('nandShares'), r<bigint>('latchShares'),
    r<bigint>('totalNandBurn'), r<bigint>('totalLatchBurn'), r<bigint>('compositionPeriod'), r<State>('state'), r<Accrual>('accrual'), r<Reconciliation>('reconciliation'),
    r<bigint>('minerCount'), r<Address>('recipientA'), r<Address>('recipientB'), r<Address>('SINK'), r<readonly Address[]>('depositors'), r<Address>('nandReceipt'), r<Address>('latchReceipt'),
    r<Address>('bem'), r<Address>('mining'), r<Address>('minerCollection'),
  ]);
  return { pool, name, version, owner, active, activatedAt, nandShares, latchShares, composition: { totalNandBurn, totalLatchBurn, compositionPeriod },
    state, accrual, reconciliation, minerCount, recipientA, recipientB, sink, depositors, nandReceipt, latchReceipt, bem, mining, collection };
}

/** Recompute the allocation off-chain and check every ledger identity. */
export function checkReconciliation(state: State, r: Reconciliation) {
  const expected = accrue(r.totalAccounted, state);
  const outstanding = (r.recipientAAccrued - r.recipientAPaid) + (r.recipientBAccrued - r.recipientBPaid) + (r.sinkAccrued - r.sinkPaid)
    + (r.nandReceiptsAccrued - r.nandReceiptsPaid) + (r.latchReceiptsAccrued - r.latchReceiptsPaid);
  const checks = {
    offChainMathMatches: expected.recipientA === r.recipientAAccrued && expected.sink === r.sinkAccrued && expected.nandIncome === r.nandIncome
      && expected.latchIncome === r.latchIncome && expected.nandReceipts === r.nandReceiptsAccrued && expected.latchReceipts === r.latchReceiptsAccrued
      && expected.residue === r.residue,
    recipientsAccrueEqually: r.recipientAAccrued === r.recipientBAccrued,
    // Each outer part is its own floor of T: C is floor(2T/84), never 2 * floor(T/84).
    outerPartsFromTotal: r.recipientAAccrued === (r.totalAccounted * RECIPIENT_PARTS) / TOTAL_PARTS && r.sinkAccrued === (r.totalAccounted * SINK_PARTS) / TOTAL_PARTS
      && r.nandIncome + r.latchIncome <= (r.totalAccounted * PARTICIPANT_PARTS) / TOTAL_PARTS,
    balanceIdentity: r.bemBalance + r.deficit === outstanding + r.residue + r.unrecognized,
    paidIdentity: r.totalPaid === r.recipientAPaid + r.recipientBPaid + r.sinkPaid + r.nandReceiptsPaid + r.latchReceiptsPaid,
    accruedIdentity: r.totalAccounted === r.recipientAAccrued + r.recipientBAccrued + r.sinkAccrued + r.nandReceiptsAccrued + r.latchReceiptsAccrued + r.residue,
    noDeficit: r.deficit === 0n,
    residueWithinBound: r.residue <= residueBound(state.nandShares, state.latchShares),
    noBucketOverpaid: r.recipientAPaid <= r.recipientAAccrued && r.recipientBPaid <= r.recipientBAccrued && r.sinkPaid <= r.sinkAccrued
      && r.nandReceiptsPaid <= r.nandReceiptsAccrued && r.latchReceiptsPaid <= r.latchReceiptsAccrued,
    categoryWithoutReceiptsHasNoIncome: (state.nandShares !== 0n || r.nandIncome === 0n) && (state.latchShares !== 0n || r.latchIncome === 0n),
  };
  return { status: Object.values(checks).every(Boolean) ? 'PASS' as const : 'FAIL' as const, checks, outstanding: {
    recipientA: r.recipientAAccrued - r.recipientAPaid, recipientB: r.recipientBAccrued - r.recipientBPaid, sink: r.sinkAccrued - r.sinkPaid,
    nandReceipts: r.nandReceiptsAccrued - r.nandReceiptsPaid, latchReceipts: r.latchReceiptsAccrued - r.latchReceiptsPaid,
  } };
}

/** Per-ID sum check: sum(claimed[id]) must equal receiptsPaid for each collection. */
export async function checkPerIdHistories(rpc: PublicClient, pool: Address, shares: Record<CategoryName, bigint>, blockNumber?: bigint) {
  const out: Record<CategoryName, { ids: number; claimedSum: bigint; receiptsPaid: bigint; match: boolean }> = {} as never;
  for (const c of ['NAND', 'LATCH'] as const) {
    let claimedSum = 0n;
    for (const ids of chunk(Array.from({ length: Number(shares[c]) }, (_, i) => BigInt(i + 1)), 100)) {
      const values = await Promise.all(ids.map(id => readPool<bigint>(rpc, pool, 'claimed', [CATEGORY[c], id], blockNumber)));
      claimedSum += values.reduce((a, b) => a + b, 0n);
    }
    const receiptsPaid = await readPool<bigint>(rpc, pool, 'receiptsPaid', [CATEGORY[c]], blockNumber);
    out[c] = { ids: Number(shares[c]), claimedSum, receiptsPaid, match: claimedSum === receiptsPaid };
  }
  return out;
}

/** Receipts `holder` holds (with claimable BEM) and receipts still waiting for it in the distributor. */
export async function readHoldings(rpc: PublicClient, pool: Address, holder: Address, distributor?: Address, blockNumber?: bigint) {
  const out: Record<CategoryName, { ids: number[]; claimable: bigint[]; total: bigint }> = {} as never;
  for (const c of ['NAND', 'LATCH'] as const) {
    const receipt = await readPool<Address>(rpc, pool, 'receiptOf', [CATEGORY[c]], blockNumber);
    const ids = await readHeldIds(rpc, receipt, holder, blockNumber);
    let claimable: bigint[] = [];
    let total = 0n;
    if (ids.length > 0) {
      const [amounts, sum] = await readPool<readonly [readonly bigint[], bigint]>(rpc, pool, 'claimableBatch', [CATEGORY[c], ids.map(BigInt)], blockNumber);
      claimable = [...amounts];
      total = sum;
    }
    out[c] = { ids, claimable, total };
  }
  const waiting = distributor ? await readDistributor<readonly [bigint, bigint]>(rpc, distributor, 'pendingOf', [holder], blockNumber) : undefined;
  return { holder: getAddress(holder), ...out, ...(waiting ? { inDistributor: { NAND: waiting[0], LATCH: waiting[1] } } : {}) };
}

export async function readMiners(rpc: PublicClient, pool: Address, withPending = false, blockNumber?: bigint) {
  const count = await readPool<bigint>(rpc, pool, 'minerCount', [], blockNumber);
  const mining = await readPool<Address>(rpc, pool, 'mining', [], blockNumber);
  const miners: { tokenId: bigint; key: Hex; nandBurn?: number; latchBurn?: number; status?: number; pendingEstimate?: bigint }[] = [];
  for (let offset = 0n; offset < count; offset += 500n) {
    const [tokenIds, keys] = await readPool<readonly [readonly bigint[], readonly Hex[]]>(rpc, pool, 'minersPage', [offset, 500n], blockNumber);
    tokenIds.forEach((tokenId, i) => miners.push({ tokenId, key: keys[i] }));
  }
  await Promise.all(miners.map(async m => {
    const record = await readPool<{ nandBurn: number; latchBurn: number }>(rpc, pool, 'miner', [m.tokenId], blockNumber);
    m.nandBurn = Number(record.nandBurn);
    m.latchBurn = Number(record.latchBurn);
    const live = await rpc.readContract({ address: mining, abi: miningAbi, functionName: 'getMiner', args: [m.key], blockNumber }).catch(() => undefined);
    m.status = live ? Number(live.status) : undefined;
    // Display only: pending() is an estimate and can be 0 while claim() pays. Never used to skip a claim.
    if (withPending) m.pendingEstimate = await rpc.readContract({ address: mining, abi: miningAbi, functionName: 'pending', args: [m.key], blockNumber }).catch(() => undefined);
  }));
  return miners;
}

/** Authoritative composition of candidate miners as the pool will read it at admission. */
export async function readComposition(rpc: PublicClient, mining: Address, collection: Address, tokenIds: bigint[], blockNumber?: bigint) {
  return Promise.all(tokenIds.map(async tokenId => {
    const key = await rpc.readContract({ address: mining, abi: miningAbi, functionName: 'minerKey', args: [collection, tokenId], blockNumber });
    const [record, cache, owner] = await Promise.all([
      rpc.readContract({ address: mining, abi: miningAbi, functionName: 'getMiner', args: [key], blockNumber }),
      rpc.readContract({ address: mining, abi: miningAbi, functionName: 'cachedBurn', args: [collection, tokenId], blockNumber }),
      rpc.readContract({ address: collection, abi: erc721Abi, functionName: 'ownerOf', args: [tokenId], blockNumber }).catch(() => zeroAddress),
    ]);
    const problems: string[] = [];
    if (Number(record.status) !== MINER_STATUS_ACTIVE) problems.push(`status ${record.status} (only ACTIVE miners earn and can be claimed)`);
    if (getAddress(record.circuits) !== getAddress(collection) || record.circuitId !== tokenId) problems.push('miner record belongs to a different circuit');
    if (!cache[0] || Number(cache[1]) !== Number(record.nandBurn) || Number(cache[2]) !== Number(record.latchBurn)) problems.push('miner record and cachedBurn disagree');
    if (Number(record.nandBurn) + Number(record.latchBurn) === 0) problems.push('burned nothing');
    return { tokenId, key, owner, status: Number(record.status), nandBurn: Number(record.nandBurn), latchBurn: Number(record.latchBurn),
      gateCount: Number(record.gateCount), bstar: record.bstar, cachedBurn: { cached: cache[0], nand: Number(cache[1]), latch: Number(cache[2]) }, admissible: problems.length === 0, problems };
  }));
}

/** Simulate harvest batches and bisect any batch with failures to name the failing miners. */
export async function findFailingMiners(rpc: PublicClient, pool: Address, tokenIds: bigint[], from: Address): Promise<bigint[]> {
  const failedOf = async (ids: bigint[]) => {
    const data = encodeFunctionData({ abi: tapeoutMinerPoolAbi as Abi, functionName: 'harvest', args: [ids] });
    const result = await rpc.call({ account: from, to: pool, data });
    const [, failed] = decodeFunctionResult({ abi: tapeoutMinerPoolAbi as Abi, functionName: 'harvest', data: result.data! }) as readonly [bigint, bigint];
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

export async function ownerOf(rpc: PublicClient, target: Address) {
  return rpc.readContract({ address: target, abi: ownableAbi, functionName: 'owner' });
}
