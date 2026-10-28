import { BATCH_GAS_BUDGET, TX_GAS_CAP } from './constants.js';

/**
 * Admission gas model from the real-protocol fork run (reports/fork-test.json, BSC block 128,713,128):
 * one admission settles every registered miner, ~27.8k gas each with real Mining.claim (cold accounts,
 * one hour of accrual), on top of a base of ~0.29M for a single incoming miner. Incoming miners cost
 * more each (custody transfer, composition reads, registration, carried-income claim).
 */
export const ADMISSION_GAS_MODEL = {
  base: 300_000n,
  perRegisteredMiner: 30_000n, // measured marginal 27,849 rounded up
  perIncomingMiner: 250_000n,
} as const;

/**
 * The first admission also opens custody (2.2.0): it reads the receipts' and the distributor's owners and
 * writes the custody latch and the first values of the category ledger and carried totals. On the BSC fork
 * (block 128,713,128) a first admission of one real miner used 514,781 gas (2.1.0: 398,165), and the same
 * sent by the CLI 538,382 gas, against the 550,000 of the general model; later admissions cost about 9.7k
 * more than under 2.1.0, within the model.
 */
export const FIRST_ADMISSION_GAS = 150_000n;

export function admissionGasEstimate(registered: bigint, incoming: bigint, first = false): bigint {
  return ADMISSION_GAS_MODEL.base + ADMISSION_GAS_MODEL.perRegisteredMiner * registered + ADMISSION_GAS_MODEL.perIncomingMiner * incoming
    + (first ? FIRST_ADMISSION_GAS : 0n);
}

/** Largest registry size at which an admission of `incoming` miners still fits `limit` gas. */
export function maxRegisteredForAdmission(incoming: bigint, limit: bigint = BATCH_GAS_BUDGET): bigint {
  const room = limit - ADMISSION_GAS_MODEL.base - ADMISSION_GAS_MODEL.perIncomingMiner * incoming;
  return room <= 0n ? 0n : room / ADMISSION_GAS_MODEL.perRegisteredMiner;
}

/** Largest batch of incoming miners that fits next to `registered` already-registered miners (`first`: the
 *  admission that opens custody). */
export function maxAdmissionBatch(registered: bigint, limit: bigint = BATCH_GAS_BUDGET, first = false): bigint {
  const room = limit - ADMISSION_GAS_MODEL.base - ADMISSION_GAS_MODEL.perRegisteredMiner * registered - (first ? FIRST_ADMISSION_GAS : 0n);
  if (room <= 0n) return 0n;
  const n = room / ADMISSION_GAS_MODEL.perIncomingMiner;
  return n > 50n ? 50n : n; // TapeoutMinerPool.MAX_ADMISSION_BATCH
}

/**
 * Worst-case bounds for whole transactions (21,000 base and calldata included). They are used as gas
 * limits, so test/unit/GasModel.t.sol runs each call as its own transaction with exactly its bound as
 * the limit (refunds cannot help: a limit must cover gas before refunds). Gas used per ID: issue ~47k to
 * a wallet and ~50k into the distributor, funding ~34k, allocate ~26k plus up to ~98k per new-wallet
 * range, delivery ~30k, BEM claims ~28k. Harvest runs the real Mining contract: ~62k per miner on the
 * BSC fork, bounded here at 100k.
 */
export const ISSUE_GAS = { base: 100_000n, perId: 54_000n } as const;
export const FUND_GAS = { base: 100_000n, perId: 40_000n } as const;
export const ALLOCATE_GAS = { base: 60_000n, perId: 27_000n, perRange: 120_000n } as const;
export const REVOKE_GAS = { base: 100_000n, perId: 8_000n, perRange: 30_000n } as const;
export const DELIVER_GAS = { base: 100_000n, perId: 37_000n, perRange: 100_000n } as const;
export const CLAIM_GAS = { base: 200_000n, perId: 32_000n } as const;
export const HARVEST_GAS = { base: 150_000n, perId: 100_000n } as const;
export const DEPLOY_GAS = { receipt: 3_000_000n, pool: 7_000_000n, distributor: 2_500_000n } as const;
/**
 * Single calls; every measured value is far below. A 2.1.0 release pays its role and C (two transfers,
 * three balance checks): ~207k at most in test/unit/GasModel.t.sol (cold, with an inflow to recognize
 * and first payments into empty balances), hence 300k.
 */
export const CALL_GAS = {
  finalizeIssuance: 100_000n, finalizeAllocation: 150_000n, activate: 250_000n, renounceOwnership: 100_000n,
  releaseA: 300_000n, releaseB: 300_000n, setRecipient: 150_000n, setApprovalForAll: 150_000n, bindDistributor: 150_000n,
} as const;

export const idsGas = (model: { base: bigint; perId: bigint }, ids: number | bigint) => model.base + model.perId * BigInt(ids);

/** Most IDs one transaction of this kind can carry within `limit`. */
export function maxIdsPerTx(model: { base: bigint; perId: bigint }, limit: bigint = BATCH_GAS_BUDGET): number {
  return limit <= model.base ? 0 : Number((limit - model.base) / model.perId);
}

interface WalletRange { count: bigint; delivered: bigint }

/**
 * Cost of delivering up to `maxIds` of a wallet's receipts if the call starts exactly at this
 * snapshot's cursor: the distributor resumes at the first range with undelivered IDs (`nextRangeOf`),
 * so completed ranges cost nothing. Not a safe gas limit when others can deliver first; plans use
 * `reachableDeliveryGas`.
 */
export function deliveryGas(ranges: readonly WalletRange[], maxIds: number): bigint {
  let gas = DELIVER_GAS.base;
  let left = BigInt(maxIds);
  for (const r of ranges) {
    const pending = r.count - r.delivered;
    if (left === 0n) break;
    if (pending === 0n) continue;
    const n = pending < left ? pending : left;
    gas += DELIVER_GAS.perRange + DELIVER_GAS.perId * n;
    left -= n;
  }
  return gas;
}

/** Largest `maxIds` whose delivery from this snapshot's cursor stays within `limit` (0 if nothing is
 *  pending). Snapshot only; see `maxSafeDeliverable`. */
export function maxDeliverable(ranges: readonly WalletRange[], limit: bigint = BATCH_GAS_BUDGET): number {
  let gas = DELIVER_GAS.base;
  let n = 0n;
  for (const r of ranges) {
    const pending = r.count - r.delivered;
    if (pending === 0n) continue;
    if (gas + DELIVER_GAS.perRange + DELIVER_GAS.perId > limit) break;
    gas += DELIVER_GAS.perRange;
    const fit = (limit - gas) / DELIVER_GAS.perId;
    const take = pending < fit ? pending : fit;
    n += take;
    gas += DELIVER_GAS.perId * take;
    if (take < pending) break;
  }
  return Number(n);
}

/** Undelivered IDs per range, in delivery order (completed ranges dropped). */
const pendingRuns = (ranges: readonly WalletRange[]) => ranges.map(r => r.count - r.delivered).filter(n => n > 0n);

/**
 * Most ranges one delivery of up to `maxIds` IDs can touch from any cursor position reachable from
 * this state. `deliver` is permissionless and only moves forward, so before a planned call executes
 * anyone may deliver any number of the wallet's IDs: the call can start at any pending ID. It touches
 * the most ranges when it starts on the last pending ID of some range.
 */
export function worstReachableRanges(ranges: readonly WalletRange[], maxIds: number): number {
  const runs = pendingRuns(ranges);
  if (maxIds <= 0 || runs.length === 0) return 0;
  const prefix = [0n];
  for (const n of runs) prefix.push(prefix[prefix.length - 1] + n);
  const need = BigInt(maxIds - 1);
  let worst = 0;
  for (let j = 0; j < runs.length; j++) {
    // One ID from run j, then `need` more from the runs after it.
    const after = runs.length - 1 - j;
    let t = after;
    if (prefix[runs.length] - prefix[j + 1] > need) {
      let lo = 0;
      while (lo < t) {
        const mid = (lo + t) >> 1;
        if (prefix[j + 1 + mid] - prefix[j + 1] >= need) t = mid;
        else lo = mid + 1;
      }
    }
    if (1 + t > worst) worst = 1 + t;
  }
  return worst;
}

/**
 * Gas bound for `deliver(wallet, maxIds)` / `claim(maxIds)` that holds at every cursor position
 * reachable from this state (not only at the snapshot's cursor): the most IDs the call can transfer
 * plus the most ranges it can touch.
 */
export function reachableDeliveryGas(ranges: readonly WalletRange[], maxIds: number): bigint {
  const pending = pendingRuns(ranges).reduce((s, n) => s + n, 0n);
  const ids = BigInt(maxIds) < pending ? BigInt(maxIds) : pending;
  return DELIVER_GAS.base + DELIVER_GAS.perId * ids + DELIVER_GAS.perRange * BigInt(worstReachableRanges(ranges, Number(ids)));
}

/** Largest `maxIds` whose reachable-state bound stays within `limit` (0 if nothing is pending). */
export function maxSafeDeliverable(ranges: readonly WalletRange[], limit: bigint = BATCH_GAS_BUDGET): number {
  let lo = 0;
  let hi = Number(pendingRuns(ranges).reduce((s, n) => s + n, 0n));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (reachableDeliveryGas(ranges, mid) <= limit) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Deliveries that hand over every pending ID, each at most `cap` IDs. Every call carries the bound for
 * any reachable cursor position, so it still fits its gas limit when others deliver first: a wallet
 * whose later ranges are fragmented gets smaller calls from the start. If others deliver everything
 * first, a remaining call reverts cheaply with `NothingToDeliver`.
 */
export function deliveryBatches(ranges: readonly WalletRange[], cap: number, limit: bigint = BATCH_GAS_BUDGET) {
  const pending = Number(pendingRuns(ranges).reduce((s, n) => s + n, 0n));
  const size = Math.min(cap, maxSafeDeliverable(ranges, limit));
  const batches: { maxIds: number; gas: bigint }[] = [];
  if (size === 0) return batches;
  for (let left = pending; left > 0; left -= Math.min(size, left)) {
    const n = Math.min(size, left);
    batches.push({ maxIds: n, gas: reachableDeliveryGas(ranges, n) });
  }
  return batches;
}

/** Bound for `revokeWallet`, which clears every range of the wallet in one call. */
export function revokeGas(ranges: readonly { count: bigint }[]): bigint {
  return ranges.reduce<bigint>((s, r) => s + REVOKE_GAS.perRange + REVOKE_GAS.perId * r.count, REVOKE_GAS.base);
}

/** A planned transaction as far as gas is concerned (structurally a TxPlan). */
interface Sized { description: string; gas?: bigint; data?: string; standalone?: boolean }

/** Refuse plans whose worst case exceeds the budget (a plan without a bound is left to simulation). */
export function assertWithinBudget(plans: readonly Sized[]) {
  for (const plan of plans) {
    if (plan.gas !== undefined && plan.gas > BATCH_GAS_BUDGET) {
      throw new Error(`"${plan.description}" may need up to ${plan.gas} gas; BSC limits a transaction to ${TX_GAS_CAP} (BEP-652) and planned transactions stay within ${BATCH_GAS_BUDGET}: use a smaller batch`);
    }
  }
}

/**
 * Executing a batch file through a Safe adds the Safe's own work to its plans' bounds:
 * - base: the proxy, the nonce (first use included), the guard check, events, and signature checks
 *   for up to 10 owners;
 * - per payload byte: the Safe hashes and copies the payload, and SafeL2 also logs all of it;
 * - 1/30 of the plans' bounds: each nested call must leave 1/64 of the remaining gas behind
 *   (EIP-150), and a MultiSend batch nests two calls deep.
 * Each plan's bound also includes a 21,000 base cost and its calldata, which a call inside the batch
 * does not pay again. Measured on a BSC fork with SafeL2 1.4.1 and GnosisSafeL2 1.3.0
 * (reports/fork-safe-e2e.json).
 */
export const SAFE_EXEC_GAS = { base: 150_000n, perPayloadByte: 16n, retainedDivisor: 30n } as const;

/** MultiSend packs each transaction as operation (1 byte), to (20), value (32), data length (32), data. */
export const safePayloadBytes = (plans: readonly { data?: string }[]) =>
  plans.reduce((s, p) => s + 85 + (p.data ? (p.data.length - 2) / 2 : 0), 0);

/** Worst case of one Safe transaction executing these plans (unbounded plans count as the budget). */
export function safeBatchGas(plans: readonly Sized[]): bigint {
  const inner = plans.reduce((s, p) => s + (p.gas ?? BATCH_GAS_BUDGET), 0n);
  return inner + SAFE_EXEC_GAS.base + SAFE_EXEC_GAS.perPayloadByte * BigInt(safePayloadBytes(plans)) + inner / SAFE_EXEC_GAS.retainedDivisor;
}

/** Split plans, in order, into Safe batches: the Transaction Builder executes one batch file as one
 *  transaction. A batch takes further plans while its Safe bound stays within the budget. A plan that
 *  exceeds the budget once the Safe's overhead is added goes alone, and must still fit the cap. A
 *  `standalone` plan (one that may legitimately revert because others acted first, such as a delivery)
 *  always goes alone, so its revert cannot roll back other plans. */
export function groupForSafe<T extends Sized>(plans: readonly T[]): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  for (const plan of plans) {
    if (current.length > 0 && (plan.standalone || current[0].standalone || safeBatchGas([...current, plan]) > BATCH_GAS_BUDGET)) {
      groups.push(current);
      current = [];
    }
    current.push(plan);
  }
  if (current.length > 0) groups.push(current);
  for (const group of groups) {
    const gas = safeBatchGas(group);
    if (gas > TX_GAS_CAP) throw new Error(`"${group[0].description}" through a Safe may need up to ${gas} gas, above the BSC per-transaction cap ${TX_GAS_CAP} (BEP-652): use a smaller batch`);
  }
  return groups;
}

/** Refuse a requested batch size above the largest that fits the budget. */
export function checkBatchSize(command: string, size: number, max: number): number {
  if (size > max) {
    throw new Error(`--batch-size ${size} is above ${max} for ${command}: BSC limits a transaction's gas to ${TX_GAS_CAP} (BEP-652) and planned transactions stay within ${BATCH_GAS_BUDGET} gas`);
  }
  return size;
}

export { BATCH_GAS_BUDGET, TX_GAS_CAP };
