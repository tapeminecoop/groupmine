/** Exact bigint mirror of src/PoolMath.sol. Off-chain previews must agree with the contract to the raw unit.
 *  Relative weights NAND + LATCH 100 : A 1.25 : B 1.25 : C 2.5 (105 displayed parts), held exactly as
 *  80 : 1 : 1 : 2 of 84 parts. */
export const TOTAL_PARTS = 84n;
export const PARTICIPANT_PARTS = 80n;
export const RECIPIENT_PARTS = 1n;
export const SINK_PARTS = 2n;
/** Category ledger (2.2.0): NAND and LATCH entitlements are kept in units of 1 / LEDGER_UNIT raw BEM, in
 *  which the participants' share of T raw units is exactly T * 80 * 10^18. */
export const LEDGER_PRECISION = 10n ** 18n;
export const LEDGER_UNIT = TOTAL_PARTS * LEDGER_PRECISION;
/** C's fixed destination (TapeoutMinerPool.SINK): BEM is transferred there, not burned by the token. */
export const SINK = '0x000000000000000000000000000000000000dEaD' as const;
export const BEM_DECIMALS = 8;

/** Pool accounting state that the allocation depends on (TapeoutMinerPool.ledgerState()). The bases are
 *  the category entitlements at the last admission boundary, in ledger units; `accountedBase` is the
 *  recognized total there. */
export interface State {
  accountedBase: bigint;
  nandBase: bigint;
  latchBase: bigint;
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

/** The participants' exact share of `amount` raw BEM, in ledger units. */
export const participantUnits = (amount: bigint) => amount * PARTICIPANT_PARTS * LEDGER_PRECISION;

/** Category entitlements at `total` in ledger units: the boundary values plus the open period's ordinary
 *  income split by the pool's composition (NAND the floor, LATCH the rest). */
export function categoryUnits(total: bigint, s: State): { nandUnits: bigint; latchUnits: bigint } {
  if (total < s.accountedBase) throw new Error('total is below the state\'s boundary total');
  let nandUnits = s.nandBase;
  let latchUnits = s.latchBase;
  const weight = s.totalNandBurn + s.totalLatchBurn;
  if (weight !== 0n) {
    const d = participantUnits(total - s.accountedBase);
    const toNand = (d * s.totalNandBurn) / weight;
    nandUnits += toNand;
    latchUnits += d - toNand;
  }
  return { nandUnits, latchUnits };
}

/** An incoming miner's carried income split by its own burn (`nand` : `latch`), in ledger units. */
export function carriedUnits(received: bigint, nand: bigint, latch: bigint): { toNand: bigint; toLatch: bigint } {
  if (nand + latch === 0n) throw new Error('a miner must have burned something');
  const units = participantUnits(received);
  const toNand = (units * nand) / (nand + latch);
  return { toNand, toLatch: units - toNand };
}

export function accrue(total: bigint, s: State): Accrual {
  if (total < 0n) throw new Error('total must be non-negative');
  const recipientA = (total * RECIPIENT_PARTS) / TOTAL_PARTS;
  const recipientB = recipientA;
  const sink = (total * SINK_PARTS) / TOTAL_PARTS;
  const participants = (total * PARTICIPANT_PARTS) / TOTAL_PARTS;
  const { nandUnits, latchUnits } = categoryUnits(total, s);
  const nandIncome = nandUnits / LEDGER_UNIT;
  const latchIncome = latchUnits / LEDGER_UNIT;
  const perNandShare = s.nandShares === 0n ? 0n : nandIncome / s.nandShares;
  const perLatchShare = s.latchShares === 0n ? 0n : latchIncome / s.latchShares;
  const nandReceipts = s.nandShares * perNandShare;
  const latchReceipts = s.latchShares * perLatchShare;
  const residue = total - recipientA - recipientB - sink - nandReceipts - latchReceipts;
  return { total, recipientA, recipientB, sink, participants, nandIncome, latchIncome, perNandShare, perLatchShare, nandReceipts, latchReceipts, residue };
}

/** The old period frozen at `total`, fractions included (an admission's checkpoint). */
export function checkpoint(total: bigint, s: State): State {
  const { nandUnits, latchUnits } = categoryUnits(total, s);
  return { ...s, accountedBase: total, nandBase: nandUnits, latchBase: latchUnits };
}

export interface IncomingMiner { received: bigint; nand: bigint; latch: bigint }

/**
 * One admission's ledger effect after the old period was settled up to `total`: checkpoint, each incoming
 * miner's carried income by its own burn (in any order: the result is the same), then the batch joins the
 * composition. BEM held but not attributable to a miner (only at a first admission) is recognized
 * afterwards by the caller, as ordinary income of the new period.
 */
export function admit(total: bigint, s: State, incoming: readonly IncomingMiner[]): { total: bigint; state: State } {
  let state = checkpoint(total, s);
  let t = total;
  for (const m of incoming) {
    const { toNand, toLatch } = carriedUnits(m.received, m.nand, m.latch);
    t += m.received;
    state = { ...state, nandBase: state.nandBase + toNand, latchBase: state.latchBase + toLatch, accountedBase: t };
  }
  return { total: t, state: { ...state, totalNandBurn: state.totalNandBurn + incoming.reduce((x, m) => x + m.nand, 0n),
    totalLatchBurn: state.totalLatchBurn + incoming.reduce((x, m) => x + m.latch, 0n) } };
}

/** Maximum rounding residue the pool can retain (raw BEM units): up to 3 from the four outer floors
 *  (r - floor(2r/84) - floor(80r/84) with r = T mod 84, 3 for r = 64..83), 1 from flooring the NAND and
 *  LATCH ledger entitlements to raw units, and S - 1 per collection from the per-share floors. */
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
