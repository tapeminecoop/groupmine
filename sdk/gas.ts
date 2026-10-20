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
 * Setup-phase models (whole transaction, including the 21,000 base and calldata), checked as upper
 * bounds by test/unit/SetupGas.t.sol. Measured: issue ~47k per ID to a wallet and ~50k straight into
 * the distributor, funding ~33k per ID, allocate ~26k per ID plus up to ~98k per range (new wallet).
 */
export const ISSUE_GAS = { base: 100_000n, perId: 54_000n } as const;
export const FUND_GAS = { base: 100_000n, perId: 40_000n } as const;
export const ALLOCATE_GAS = { base: 60_000n, perId: 27_000n, perRange: 120_000n } as const;

/** Most IDs one issue or funding transaction can carry within `limit`. */
export function maxIdsPerTx(model: { base: bigint; perId: bigint }, limit: bigint = BATCH_GAS_BUDGET): number {
  return limit <= model.base ? 0 : Number((limit - model.base) / model.perId);
}

export { BATCH_GAS_BUDGET, TX_GAS_CAP };
