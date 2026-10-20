import { readFile } from 'node:fs/promises';
import { encodeAbiParameters, getAddress, keccak256, zeroAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { parseWeight, WEIGHT_SCALE, type Shares } from './math.js';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x-prefixed 20-byte address');
const count = z.number().int().nonnegative().max(1_000_000_000);
const receiptMeta = z.object({ name: z.string().min(1).max(64), symbol: z.string().min(1).max(16), uri: z.string().max(512) }).strict();

/** Operator-maintained pool definition: protocol binding, metadata, and the manual economics. */
export const poolFileSchema = z.object({
  chainId: z.number().int().positive(),
  protocol: z.object({ bem: address, mining: address, minerCollection: address }).strict(),
  pool: z.object({ name: z.string().min(1).max(64), owner: address, nandReceipt: receiptMeta, latchReceipt: receiptMeta }).strict(),
  economics: z.object({
    nandShares: count,
    latchShares: count,
    historicalNandShares: count.default(0),
    historicalLatchShares: count.default(0),
    /** NAND fraction of participant income with up to 8 decimals; LATCH gets the remainder. */
    nandWeight: z.string(),
  }).strict(),
  recipients: z.object({
    fee: address,
    historicalNand: address.optional(),
    historicalLatch: address.optional(),
  }).strict(),
}).strict();

export type PoolFile = z.infer<typeof poolFileSchema>;

export interface PoolConfig {
  nandShares: bigint;
  latchShares: bigint;
  historicalNandShares: bigint;
  historicalLatchShares: bigint;
  nandWeight: number;
  feeRecipient: Address;
  historicalNandRecipient: Address;
  historicalLatchRecipient: Address;
}

export const configComponents = [
  { name: 'nandShares', type: 'uint64' },
  { name: 'latchShares', type: 'uint64' },
  { name: 'historicalNandShares', type: 'uint64' },
  { name: 'historicalLatchShares', type: 'uint64' },
  { name: 'nandWeight', type: 'uint32' },
  { name: 'feeRecipient', type: 'address' },
  { name: 'historicalNandRecipient', type: 'address' },
  { name: 'historicalLatchRecipient', type: 'address' },
] as const;

export async function loadPoolFile(file: string): Promise<PoolFile> {
  return poolFileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

export function toConfig(file: PoolFile): PoolConfig {
  const e = file.economics;
  return {
    nandShares: BigInt(e.nandShares),
    latchShares: BigInt(e.latchShares),
    historicalNandShares: BigInt(e.historicalNandShares),
    historicalLatchShares: BigInt(e.historicalLatchShares),
    nandWeight: Number(parseWeight(e.nandWeight)),
    feeRecipient: getAddress(file.recipients.fee),
    historicalNandRecipient: file.recipients.historicalNand ? getAddress(file.recipients.historicalNand) : zeroAddress,
    historicalLatchRecipient: file.recipients.historicalLatch ? getAddress(file.recipients.historicalLatch) : zeroAddress,
  };
}

export function toShares(c: PoolConfig): Shares {
  return {
    nandShares: c.nandShares,
    latchShares: c.latchShares,
    historicalNandShares: c.historicalNandShares,
    historicalLatchShares: c.historicalLatchShares,
    nandWeight: BigInt(c.nandWeight),
  };
}

export function toDeployment(file: PoolFile) {
  return {
    owner: getAddress(file.pool.owner),
    bem: getAddress(file.protocol.bem),
    mining: getAddress(file.protocol.mining),
    minerCollection: getAddress(file.protocol.minerCollection),
    poolName: file.pool.name,
    nand: file.pool.nandReceipt,
    latch: file.pool.latchReceipt,
  };
}

/** Same value as TapeoutMinerPool.configHash(c): keccak256(abi.encode(Config)). */
export function configHash(c: PoolConfig): Hex {
  return keccak256(encodeAbiParameters([{ type: 'tuple', components: configComponents }], [c]));
}

/** Off-chain mirror of the activation checks, so problems surface before any transaction. */
export function activationProblems(c: PoolConfig): string[] {
  const problems: string[] = [];
  const weight = BigInt(c.nandWeight);
  if (weight > WEIGHT_SCALE) problems.push('nandWeight exceeds 1.00000000');
  if (c.feeRecipient === zeroAddress) problems.push('fee recipient is required');
  if (c.historicalNandShares > 0n && c.historicalNandRecipient === zeroAddress) problems.push('historical NAND shares need a historical NAND recipient');
  if (c.historicalLatchShares > 0n && c.historicalLatchRecipient === zeroAddress) problems.push('historical LATCH shares need a historical LATCH recipient');
  if (weight !== 0n && c.nandShares + c.historicalNandShares === 0n) problems.push('NAND has weight but no receipt or historical shares');
  if (weight !== WEIGHT_SCALE && c.latchShares + c.historicalLatchShares === 0n) problems.push('LATCH has weight but no receipt or historical shares');
  for (const value of [c.nandShares, c.latchShares, c.historicalNandShares, c.historicalLatchShares]) {
    if (value >= 2n ** 64n) problems.push('share count exceeds uint64');
  }
  return problems;
}
