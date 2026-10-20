import { decodeDeployData, decodeFunctionData, type Abi, type Hex } from 'viem';
import { historicalDistributorAbi, tapeoutMinerPoolAbi } from './abi.js';
import bytecode from './bytecode.json' with { type: 'json' };
import { erc721Abi } from './constants.js';
import type { TxPlan } from './tx.js';

/** BSC BEP-652, part of the Mendel hardfork (BEP-658; enabled on mainnet 2026-04-28 02:30 UTC),
 *  implements EIP-7825: a transaction whose gas *limit* exceeds 2^24 is not accepted into the txpool
 *  and a block containing one is invalid. The block gas limit (70M at the time of writing) is separate. */
export const TX_GAS_CAP = 16_777_216n;

/** Every planned transaction, and every Safe batch file (one MultiSend transaction), is sized so its
 *  worst-case gas stays within 3/4 of the cap. A signer that adds up to a third on top of the
 *  estimate (forge script adds 30% by default) then still stays under the cap. */
export const BATCH_GAS_BUDGET = (TX_GAS_CAP * 3n) / 4n;

/** Worst-case gas = fixed + perItem × items. Pool-internal operations and the distributor are measured
 *  at the maxima below by test/unit/BatchGasBudget.t.sol (cold, written to reports/gas-batch.json).
 *  Deposit, register and harvest run the real collection and Mining contracts, so they use bounds
 *  above the fork measurements (reports/fork-e2e.json: one cold deposit 269,071 gas; harvest of three
 *  miners 205,615 gas, 145,723 cold without the base in reports/fork-test.json). */
export const GAS_MODEL = {
  issueReceiptRange: { fixed: 150_000n, perItem: 50_000n },
  issueReceipts: { fixed: 150_000n, perItem: 60_000n },
  revokeReceipts: { fixed: 100_000n, perItem: 20_000n },
  claimBatch: { fixed: 200_000n, perItem: 30_000n },
  depositMiners: { fixed: 150_000n, perItem: 250_000n },
  registerMiners: { fixed: 150_000n, perItem: 250_000n },
  harvest: { fixed: 150_000n, perItem: 100_000n },
  distributorClaimRange: { fixed: 150_000n, perItem: 65_000n },
  distributorClaimBatch: { fixed: 150_000n, perItem: 72_000n },
  distributorDeploy: { fixed: 1_600_000n, perItem: 25_000n },
} as const satisfies Record<string, { fixed: bigint; perItem: bigint }>;

/** Generous bounds for single-call operations (all measured well below these). */
const SINGLE_CALL: Record<string, bigint> = {
  configure: 400_000n, activate: 400_000n, claim: 250_000n, releaseFee: 250_000n, releaseHistorical: 250_000n,
  setRecipient: 150_000n, setReceiptURI: 400_000n, sync: 150_000n, transferOwnership: 100_000n, acceptOwnership: 100_000n,
  releaseFromPool: 300_000n, setApprovalForAll: 150_000n,
};

/** Pool creation (both receipt collections included): 7,788,283 gas measured on the fork. */
const POOL_DEPLOY_GAS = 8_500_000n;

/** Largest `--batch-size` per command whose worst case fits BATCH_GAS_BUDGET. */
export const MAX_BATCH = {
  issue: 200, // issueReceipts with distinct new holders is the costlier form
  claim: 400,
  deposit: 40,
  register: 40,
  harvest: 100,
  'distributor-claim': 150, // claimBatch with its account lookups is the costlier form
} as const;
export type BatchKind = keyof typeof MAX_BATCH;

const bound = (kind: keyof typeof GAS_MODEL, items: number | bigint) => GAS_MODEL[kind].fixed + GAS_MODEL[kind].perItem * BigInt(items);

export function checkBatchSize(kind: BatchKind, size: number) {
  if (size > MAX_BATCH[kind]) {
    throw new Error(`--batch-size ${size} is above ${MAX_BATCH[kind]} for ${kind}: BSC limits a transaction's gas to ${TX_GAS_CAP} (BEP-652) and planned batches stay within ${BATCH_GAS_BUDGET} gas`);
  }
  return size;
}

function decode(abi: Abi, data: Hex) {
  try {
    return decodeFunctionData({ abi, data });
  } catch {
    return undefined;
  }
}

/** Worst-case gas of a planned transaction, or undefined if the call is not one the tooling plans. */
export function gasBound(plan: TxPlan): bigint | undefined {
  if (plan.to === null) {
    if (plan.data.startsWith(bytecode.TapeoutMinerPool.bytecode)) return POOL_DEPLOY_GAS;
    if (plan.data.startsWith(bytecode.HistoricalDistributor.bytecode)) {
      const { args } = decodeDeployData({ abi: historicalDistributorAbi, bytecode: bytecode.HistoricalDistributor.bytecode as Hex, data: plan.data });
      return bound('distributorDeploy', (args[2] as readonly unknown[]).length);
    }
    return undefined;
  }
  const pool = decode(tapeoutMinerPoolAbi as Abi, plan.data);
  if (pool) {
    const args = (pool.args ?? []) as readonly unknown[];
    const length = (i: number) => (args[i] as readonly unknown[]).length;
    switch (pool.functionName) {
      case 'issueReceiptRange': return bound('issueReceiptRange', args[3] as bigint);
      case 'issueReceipts': return bound('issueReceipts', length(2));
      case 'revokeReceipts': return bound('revokeReceipts', length(1));
      case 'claimBatch': return bound('claimBatch', length(0) + length(1));
      case 'depositMiners': return bound('depositMiners', length(0));
      case 'registerMiners': return bound('registerMiners', length(0));
      case 'harvest': return bound('harvest', length(0));
      case 'harvestRange': return bound('harvest', args[1] as bigint);
      default: return SINGLE_CALL[pool.functionName];
    }
  }
  const distributor = decode(historicalDistributorAbi as Abi, plan.data);
  if (distributor) {
    const args = (distributor.args ?? []) as readonly unknown[];
    if (distributor.functionName === 'claimRange') return bound('distributorClaimRange', args[1] as bigint);
    if (distributor.functionName === 'claimBatch') return bound('distributorClaimBatch', (args[0] as readonly unknown[]).length);
    return SINGLE_CALL[distributor.functionName];
  }
  const erc721 = decode(erc721Abi as Abi, plan.data);
  return erc721 ? SINGLE_CALL[erc721.functionName] : undefined;
}

/** Refuse plans whose worst case is above the budget (or unknown, which only a simulation can size). */
export function assertWithinBudget(plans: TxPlan[]) {
  for (const plan of plans) {
    const gas = gasBound(plan);
    if (gas === undefined) continue;
    if (gas > BATCH_GAS_BUDGET) {
      throw new Error(`"${plan.description}" may need up to ${gas} gas; BSC limits a transaction to ${TX_GAS_CAP} (BEP-652) and planned transactions stay within ${BATCH_GAS_BUDGET}: split it`);
    }
  }
}

/** Split plans, in order, into Safe batches whose summed worst case fits the budget: the Transaction
 *  Builder executes a whole batch file as one MultiSend transaction. Unknown calls go alone. */
export function groupForSafe(plans: TxPlan[]): TxPlan[][] {
  const groups: TxPlan[][] = [];
  let current: TxPlan[] = [];
  let used = 0n;
  for (const plan of plans) {
    const gas = gasBound(plan) ?? BATCH_GAS_BUDGET;
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
