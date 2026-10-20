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

/**
 * Bound for delivering up to `maxIds` of a wallet's receipts. The distributor resumes at the wallet's
 * first range with undelivered IDs (its `nextRangeOf` cursor), so completed ranges cost nothing and
 * only the ranges and IDs this delivery transfers count.
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

/** Largest `maxIds` whose delivery stays within `limit` (0 if nothing is pending). */
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

/** Sizes of successive deliveries that hand over every pending ID, each at most `cap` and within `limit`. */
export function deliveryBatches(ranges: readonly WalletRange[], cap: number, limit: bigint = BATCH_GAS_BUDGET) {
  const state = ranges.map(r => ({ count: r.count, delivered: r.delivered }));
  const batches: { maxIds: number; gas: bigint }[] = [];
  for (;;) {
    const n = Math.min(cap, maxDeliverable(state, limit));
    if (n === 0) return batches;
    batches.push({ maxIds: n, gas: deliveryGas(state, n) });
    let left = BigInt(n);
    for (const r of state) {
      if (left === 0n) break;
      const take = r.count - r.delivered < left ? r.count - r.delivered : left;
      r.delivered += take;
      left -= take;
    }
  }
}

/** Bound for `revokeWallet`, which clears every range of the wallet in one call. */
export function revokeGas(ranges: readonly { count: bigint }[]): bigint {
  return ranges.reduce<bigint>((s, r) => s + REVOKE_GAS.perRange + REVOKE_GAS.perId * r.count, REVOKE_GAS.base);
}

/** A planned transaction as far as gas is concerned (structurally a TxPlan). */
interface Sized { description: string; gas?: bigint; data?: string }

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
 *  exceeds the budget once the Safe's overhead is added goes alone, and must still fit the cap. */
export function groupForSafe<T extends Sized>(plans: readonly T[]): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  for (const plan of plans) {
    if (current.length > 0 && safeBatchGas([...current, plan]) > BATCH_GAS_BUDGET) {
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
