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

export function admissionGasEstimate(registered: bigint, incoming: bigint): bigint {
  return ADMISSION_GAS_MODEL.base + ADMISSION_GAS_MODEL.perRegisteredMiner * registered + ADMISSION_GAS_MODEL.perIncomingMiner * incoming;
}

/** Largest registry size at which an admission of `incoming` miners still fits `limit` gas. */
export function maxRegisteredForAdmission(incoming: bigint, limit: bigint = BATCH_GAS_BUDGET): bigint {
  const room = limit - ADMISSION_GAS_MODEL.base - ADMISSION_GAS_MODEL.perIncomingMiner * incoming;
  return room <= 0n ? 0n : room / ADMISSION_GAS_MODEL.perRegisteredMiner;
}

/** Largest batch of incoming miners that fits next to `registered` already-registered miners. */
export function maxAdmissionBatch(registered: bigint, limit: bigint = BATCH_GAS_BUDGET): bigint {
  const room = limit - ADMISSION_GAS_MODEL.base - ADMISSION_GAS_MODEL.perRegisteredMiner * registered;
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
export const DEPLOY_GAS = { receipt: 3_000_000n, pool: 6_000_000n, distributor: 2_500_000n } as const;
/** Single calls; every measured value is far below. */
export const CALL_GAS = {
  finalizeIssuance: 100_000n, finalizeAllocation: 150_000n, activate: 250_000n, renounceOwnership: 100_000n,
  releaseA: 250_000n, releaseB: 250_000n, setRecipient: 150_000n, setApprovalForAll: 150_000n,
} as const;

export const idsGas = (model: { base: bigint; perId: bigint }, ids: number | bigint) => model.base + model.perId * BigInt(ids);

/** Most IDs one transaction of this kind can carry within `limit`. */
export function maxIdsPerTx(model: { base: bigint; perId: bigint }, limit: bigint = BATCH_GAS_BUDGET): number {
  return limit <= model.base ? 0 : Number((limit - model.base) / model.perId);
}

interface WalletRange { count: bigint; delivered: bigint }

/** Bound for delivering up to `maxIds` of a wallet's receipts: only the ranges the call reaches count. */
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

/** Largest `maxIds` whose delivery stays within `limit` (0 if nothing is pending). */
export function maxDeliverable(ranges: readonly WalletRange[], limit: bigint = BATCH_GAS_BUDGET): number {
  const pending = ranges.reduce((s, r) => s + Number(r.count - r.delivered), 0);
  let n = 0;
  while (n < pending && deliveryGas(ranges, n + 1) <= limit) n++;
  return n;
}

/** Bound for `revokeWallet`, which clears every range of the wallet in one call. */
export function revokeGas(ranges: readonly { count: bigint }[]): bigint {
  return ranges.reduce<bigint>((s, r) => s + REVOKE_GAS.perRange + REVOKE_GAS.perId * r.count, REVOKE_GAS.base);
}

/** A planned transaction as far as gas is concerned (structurally a TxPlan). */
interface Sized { description: string; gas?: bigint }

/** Refuse plans whose worst case exceeds the budget (a plan without a bound is left to simulation). */
export function assertWithinBudget(plans: readonly Sized[]) {
  for (const plan of plans) {
    if (plan.gas !== undefined && plan.gas > BATCH_GAS_BUDGET) {
      throw new Error(`"${plan.description}" may need up to ${plan.gas} gas; BSC limits a transaction to ${TX_GAS_CAP} (BEP-652) and planned transactions stay within ${BATCH_GAS_BUDGET}: use a smaller batch`);
    }
  }
}

/** Split plans, in order, into Safe batches whose summed worst case fits the budget: the Transaction
 *  Builder executes one batch file as one MultiSend transaction. A plan without a bound goes alone. */
export function groupForSafe<T extends Sized>(plans: readonly T[]): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let used = 0n;
  for (const plan of plans) {
    const gas = plan.gas ?? BATCH_GAS_BUDGET;
    if (current.length > 0 && used + gas > BATCH_GAS_BUDGET) {
      groups.push(current);
      current = [];
      used = 0n;
    }
    current.push(plan);
    used += gas;
  }
  if (current.length > 0) groups.push(current);
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
