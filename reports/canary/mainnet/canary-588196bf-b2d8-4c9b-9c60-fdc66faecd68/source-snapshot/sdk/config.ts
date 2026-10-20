import { readFile } from 'node:fs/promises';
import { getAddress, keccak256, stringToHex, zeroAddress, type Address } from 'viem';
import { z } from 'zod';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x-prefixed 20-byte address');
const receiptMeta = z.object({ name: z.string().min(1).max(64), symbol: z.string().min(1).max(16), uri: z.string().max(512).default('') }).strict();

export const NAND_CATEGORY = keccak256(stringToHex('TAPEOUT_NAND_ENTITLEMENT'));
export const LATCH_CATEGORY = keccak256(stringToHex('TAPEOUT_LATCH_ENTITLEMENT'));
export const MAX_DEPOSITORS = 16;

/** Operator-maintained system definition (deployments/examples/system.bsc.example.json). */
export const systemFileSchema = z.object({
  chainId: z.number().int().positive(),
  protocol: z.object({ bem: address, mining: address, minerCollection: address }).strict(),
  receipts: z.object({ issuer: address, nand: receiptMeta, latch: receiptMeta }).strict(),
  pool: z.object({
    name: z.string().min(1).max(64),
    owner: address,
    recipientA: address,
    recipientB: address,
    /** Fixed at deployment; the owner is not a depositor unless listed here. */
    depositors: z.array(address).min(1).max(MAX_DEPOSITORS),
  }).strict(),
  distributor: z.object({ owner: address }).strict(),
}).strict();

export type SystemFile = z.infer<typeof systemFileSchema>;

/** Addresses written by the deploy commands and read by every other command. */
export const addressesSchema = z.object({
  chainId: z.number().int().positive(),
  nandReceipt: address,
  latchReceipt: address,
  pool: address.optional(),
  distributor: address.optional(),
}).strict();

export type Addresses = z.infer<typeof addressesSchema>;

export async function loadSystemFile(file: string): Promise<SystemFile> {
  const parsed = systemFileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  const problems = systemProblems(parsed);
  if (problems.length) throw new Error(`Invalid system file: ${problems.join('; ')}`);
  return parsed;
}

export async function loadAddresses(file: string): Promise<Addresses> {
  return addressesSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

/** Off-chain mirror of the pool constructor checks, so problems surface before any transaction. */
export function systemProblems(f: SystemFile): string[] {
  const problems: string[] = [];
  const lower = (a: string) => a.toLowerCase();
  if (lower(f.pool.recipientA) === lower(zeroAddress) || lower(f.pool.recipientB) === lower(zeroAddress)) problems.push('recipients A and B are required');
  const seen = new Set<string>();
  const forbidden = new Set([f.protocol.bem, f.protocol.mining, f.protocol.minerCollection, zeroAddress].map(lower));
  for (const d of f.pool.depositors) {
    if (forbidden.has(lower(d))) problems.push(`depositor ${d} is the zero address or a protocol contract`);
    if (seen.has(lower(d))) problems.push(`depositor ${d} is listed twice`);
    seen.add(lower(d));
  }
  return problems;
}

export function receiptConstructorArgs(f: SystemFile) {
  return {
    nand: [NAND_CATEGORY, f.receipts.nand.name, f.receipts.nand.symbol, f.receipts.nand.uri, getAddress(f.receipts.issuer)] as const,
    latch: [LATCH_CATEGORY, f.receipts.latch.name, f.receipts.latch.symbol, f.receipts.latch.uri, getAddress(f.receipts.issuer)] as const,
  };
}

export function poolDeployment(f: SystemFile, nandReceipt: Address, latchReceipt: Address) {
  return {
    owner: getAddress(f.pool.owner),
    bem: getAddress(f.protocol.bem),
    mining: getAddress(f.protocol.mining),
    minerCollection: getAddress(f.protocol.minerCollection),
    nandReceipt: getAddress(nandReceipt),
    latchReceipt: getAddress(latchReceipt),
    recipientA: getAddress(f.pool.recipientA),
    recipientB: getAddress(f.pool.recipientB),
    depositors: f.pool.depositors.map(d => getAddress(d)),
    poolName: f.pool.name,
  };
}
