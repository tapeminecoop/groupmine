/** Exact bigint mirror of src/PoolMath.sol. Off-chain previews must agree with the contract to the raw unit. */
export const WEIGHT_SCALE = 100_000_000n;
export const FEE_PARTS = 2n;
export const ENTITLEMENT_PARTS = 100n;
export const TOTAL_PARTS = 102n;
export const BEM_DECIMALS = 8;

export interface Shares {
  nandShares: bigint;
  latchShares: bigint;
  historicalNandShares: bigint;
  historicalLatchShares: bigint;
  nandWeight: bigint;
}

export interface Accrual {
  total: bigint;
  fee: bigint;
  entitlement: bigint;
  nandIncome: bigint;
  latchIncome: bigint;
  perNandShare: bigint;
  perLatchShare: bigint;
  nandReceipts: bigint;
  latchReceipts: bigint;
  historicalNand: bigint;
  historicalLatch: bigint;
  residue: bigint;
}

export function accrue(total: bigint, s: Shares): Accrual {
  if (total < 0n) throw new Error('total must be non-negative');
  if (s.nandWeight < 0n || s.nandWeight > WEIGHT_SCALE) throw new Error('nandWeight out of range');
  const fee = (total * FEE_PARTS) / TOTAL_PARTS;
  const entitlement = total - fee;
  const nandIncome = (entitlement * s.nandWeight) / WEIGHT_SCALE;
  const latchIncome = (entitlement * (WEIGHT_SCALE - s.nandWeight)) / WEIGHT_SCALE;
  const nandDenominator = s.nandShares + s.historicalNandShares;
  const latchDenominator = s.latchShares + s.historicalLatchShares;
  const perNandShare = nandDenominator === 0n ? 0n : nandIncome / nandDenominator;
  const perLatchShare = latchDenominator === 0n ? 0n : latchIncome / latchDenominator;
  const nandReceipts = s.nandShares * perNandShare;
  const latchReceipts = s.latchShares * perLatchShare;
  const historicalNand = s.historicalNandShares * perNandShare;
  const historicalLatch = s.historicalLatchShares * perLatchShare;
  const residue = total - fee - nandReceipts - latchReceipts - historicalNand - historicalLatch;
  return { total, fee, entitlement, nandIncome, latchIncome, perNandShare, perLatchShare, nandReceipts, latchReceipts, historicalNand, historicalLatch, residue };
}

/** Maximum rounding residue the pool can retain for a configuration (raw BEM units). */
export function residueBound(s: Shares): bigint {
  const dN = s.nandShares + s.historicalNandShares;
  const dL = s.latchShares + s.historicalLatchShares;
  return 1n + (dN === 0n ? 0n : dN - 1n) + (dL === 0n ? 0n : dL - 1n);
}

/** Parse a fraction in [0, 1] with at most 8 decimals, e.g. "0.9", "0.90000000", "1". */
export function parseWeight(text: string): bigint {
  const match = /^(0|1)(?:\.(\d{1,8}))?$/.exec(text.trim());
  if (!match) throw new Error(`Invalid weight "${text}": use a decimal fraction between 0 and 1 with at most 8 decimals`);
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? '').padEnd(8, '0'));
  const value = whole * WEIGHT_SCALE + fraction;
  if (value > WEIGHT_SCALE) throw new Error(`Invalid weight "${text}": greater than 1`);
  return value;
}

export function formatWeight(weight: bigint): string {
  return `${weight / WEIGHT_SCALE}.${(weight % WEIGHT_SCALE).toString().padStart(8, '0')}`;
}

/** Parse a BEM amount ("1020", "0.00000323") into raw 8-decimal units. */
export function parseBem(text: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(text.trim());
  if (!match) throw new Error(`Invalid BEM amount "${text}"`);
  return BigInt(match[1]) * 10n ** 8n + BigInt((match[2] ?? '').padEnd(8, '0'));
}

export function formatBem(raw: bigint): string {
  const sign = raw < 0n ? '-' : '';
  const value = raw < 0n ? -raw : raw;
  return `${sign}${value / 10n ** 8n}.${(value % 10n ** 8n).toString().padStart(8, '0')}`;
}
