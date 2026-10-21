/** Exact bigint mirror of src/PoolMath.sol. Off-chain previews must agree with the contract to the raw unit.
 *  Relative weights NAND + LATCH 100 : A 1.25 : B 1.25 : C 2.5 (105 displayed parts), held exactly as
 *  80 : 1 : 1 : 2 of 84 parts. */
export const TOTAL_PARTS = 84n;
export const PARTICIPANT_PARTS = 80n;
export const RECIPIENT_PARTS = 1n;
export const SINK_PARTS = 2n;
/** C's fixed destination (TapeoutMinerPool.SINK): BEM is transferred there, not burned by the token. */
export const SINK = '0x000000000000000000000000000000000000dEaD' as const;
export const BEM_DECIMALS = 8;

/** Pool accounting state that the allocation depends on (see TapeoutMinerPool.state()). */
export interface State {
  nandBase: bigint;
  latchBase: bigint;
  participantBase: bigint;
  totalNandBurn: bigint;
  totalLatchBurn: bigint;
  nandShares: bigint;
  latchShares: bigint;
}

export interface Accrual {
  total: bigint;
  recipientA: bigint;
  recipientB: bigint;
  sink: bigint;
  participants: bigint;
  nandIncome: bigint;
  latchIncome: bigint;
  perNandShare: bigint;
  perLatchShare: bigint;
  nandReceipts: bigint;
  latchReceipts: bigint;
  residue: bigint;
}

export function accrue(total: bigint, s: State): Accrual {
  if (total < 0n) throw new Error('total must be non-negative');
  const recipientA = (total * RECIPIENT_PARTS) / TOTAL_PARTS;
  const recipientB = recipientA;
  const sink = (total * SINK_PARTS) / TOTAL_PARTS;
  const participants = (total * PARTICIPANT_PARTS) / TOTAL_PARTS;
  let nandIncome = s.nandBase;
  let latchIncome = s.latchBase;
  const weight = s.totalNandBurn + s.totalLatchBurn;
  if (weight !== 0n) {
    const d = participants - s.participantBase;
    if (d < 0n) throw new Error('state participantBase exceeds participants at this total');
    nandIncome += (d * s.totalNandBurn) / weight;
    latchIncome += (d * s.totalLatchBurn) / weight;
  }
  const perNandShare = s.nandShares === 0n ? 0n : nandIncome / s.nandShares;
  const perLatchShare = s.latchShares === 0n ? 0n : latchIncome / s.latchShares;
  const nandReceipts = s.nandShares * perNandShare;
  const latchReceipts = s.latchShares * perLatchShare;
  const residue = total - recipientA - recipientB - sink - nandReceipts - latchReceipts;
  return { total, recipientA, recipientB, sink, participants, nandIncome, latchIncome, perNandShare, perLatchShare, nandReceipts, latchReceipts, residue };
}

/** State after an admission boundary: the old period is frozen and the composition grows. */
export function checkpoint(total: bigint, s: State, addNand: bigint, addLatch: bigint): State {
  const a = accrue(total, s);
  return { ...s, nandBase: a.nandIncome, latchBase: a.latchIncome, participantBase: a.nandIncome + a.latchIncome,
    totalNandBurn: s.totalNandBurn + addNand, totalLatchBurn: s.totalLatchBurn + addLatch };
}

/** Maximum rounding residue the pool can retain (raw BEM units): up to 3 from the four outer floors
 *  (r - floor(2r/84) - floor(80r/84) with r = T mod 84, 3 for r = 64..83), 1 from the NAND/LATCH split
 *  of the current period, and S - 1 per collection from the per-share floors. */
export function residueBound(nandShares: bigint, latchShares: bigint): bigint {
  return 4n + (nandShares === 0n ? 0n : nandShares - 1n) + (latchShares === 0n ? 0n : latchShares - 1n);
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
