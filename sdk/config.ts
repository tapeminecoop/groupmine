import { readFile } from 'node:fs/promises';
import { getAddress, keccak256, stringToHex, zeroAddress, type Address } from 'viem';
import { z } from 'zod';
import { SINK } from './math.js';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x-prefixed 20-byte address');
const receiptMeta = z.object({ name: z.string().min(1).max(64), symbol: z.string().min(1).max(16), uri: z.string().max(512).default('') }).strict();

export const NAND_CATEGORY = keccak256(stringToHex('TAPEOUT_NAND_ENTITLEMENT'));
export const LATCH_CATEGORY = keccak256(stringToHex('TAPEOUT_LATCH_ENTITLEMENT'));
export const MAX_DEPOSITORS = 16;

/**
 * A processor's two custody pools (2.3.0): both recognize the same NAND/LATCH receipt pair and bind the
 * one distributor that serves them. The names are the deployment's labels; the contracts treat both
 * pools alike and neither enforces any Mining property of the miners it admits.
 */
export const POOL_ROLES = ['optimal', 'regular'] as const;
export type PoolRole = (typeof POOL_ROLES)[number];
/** The addresses-file key of each role's pool. */
export const POOL_ADDRESS_KEY = { optimal: 'optimalPool', regular: 'regularPool' } as const satisfies Record<PoolRole, string>;

const poolDefinition = z.object({
  name: z.string().min(1).max(64),
  owner: address,
  recipientA: address,
  recipientB: address,
  /** Fixed at deployment; the owner is not a depositor unless listed here. */
  depositors: z.array(address).min(1).max(MAX_DEPOSITORS),
}).strict();

/** Operator-maintained system definition (deployments/examples/system.bsc.example.json). */
export const systemFileSchema = z.object({
  chainId: z.number().int().positive(),
  protocol: z.object({ bem: address, mining: address, minerCollection: address }).strict(),
  receipts: z.object({ issuer: address, nand: receiptMeta, latch: receiptMeta }).strict(),
  /** Both pools are deployed against `protocol` and `receipts`; one distributor serves both. */
  pools: z.object({ optimal: poolDefinition, regular: poolDefinition }).strict(),
  distributor: z.object({ owner: address }).strict(),
}).strict();

export type SystemFile = z.infer<typeof systemFileSchema>;
export type PoolDefinition = SystemFile['pools'][PoolRole];

/** Addresses written by the deploy commands and read by every other command. */
export const addressesSchema = z.object({
  chainId: z.number().int().positive(),
  nandReceipt: address,
  latchReceipt: address,
  optimalPool: address.optional(),
  regularPool: address.optional(),
  distributor: address.optional(),
}).strict();

export type Addresses = z.infer<typeof addressesSchema>;

/**
 * Files written for a single-pool system (2.2.0 and earlier: `pool` beside `distributor`) are refused by
 * name, never read as one of the two pools: their distributor serves only that pool and cannot be bound
 * by a second one.
 */
function refuseSinglePoolFormat(json: unknown, kind: 'system' | 'addresses') {
  if (json && typeof json === 'object' && 'pool' in json) {
    const expected = kind === 'system' ? '"pools": { "optimal": {...}, "regular": {...} }' : '"optimalPool" and "regularPool"';
    throw new Error(`Invalid ${kind} file: it has the single-pool key "pool" (2.2.0 and earlier). A 2.3.0 system has two custody pools sharing one distributor and names them as ${expected}; a single-pool file is not reinterpreted (docs/TWO_POOL_DISTRIBUTOR_CHANGE.md)`);
  }
}

export function parseSystemFile(json: unknown): SystemFile {
  refuseSinglePoolFormat(json, 'system');
  return systemFileSchema.parse(json);
}

export function parseAddresses(json: unknown): Addresses {
  refuseSinglePoolFormat(json, 'addresses');
  return addressesSchema.parse(json);
}

export async function loadSystemFile(file: string): Promise<SystemFile> {
  const parsed = parseSystemFile(JSON.parse(await readFile(file, 'utf8')));
  const problems = systemProblems(parsed);
  if (problems.length) throw new Error(`Invalid system file: ${problems.join('; ')}`);
  return parsed;
}

export async function loadAddresses(file: string): Promise<Addresses> {
  return parseAddresses(JSON.parse(await readFile(file, 'utf8')));
}

/** Off-chain mirror of each pool's constructor checks, so problems surface before any transaction. */
export function systemProblems(f: SystemFile): string[] {
  const problems: string[] = [];
  const lower = (a: string) => a.toLowerCase();
  const forbidden = new Set([f.protocol.bem, f.protocol.mining, f.protocol.minerCollection, zeroAddress].map(lower));
  for (const role of POOL_ROLES) {
    const p = f.pools[role];
    if (lower(p.recipientA) === lower(zeroAddress) || lower(p.recipientB) === lower(zeroAddress)) problems.push(`${role} pool: recipients A and B are required`);
    if (lower(p.recipientA) === lower(SINK) || lower(p.recipientB) === lower(SINK)) problems.push(`${role} pool: recipients A and B cannot be C's fixed sink address ${SINK}`);
    const seen = new Set<string>();
    for (const d of p.depositors) {
      if (forbidden.has(lower(d))) problems.push(`${role} pool: depositor ${d} is the zero address or a protocol contract`);
      if (seen.has(lower(d))) problems.push(`${role} pool: depositor ${d} is listed twice`);
      seen.add(lower(d));
    }
  }
  if (f.pools.optimal.name === f.pools.regular.name) problems.push(`both pools are named "${f.pools.optimal.name}"; give each pool its own name`);
  return problems;
}

export function receiptConstructorArgs(f: SystemFile) {
  return {
    nand: [NAND_CATEGORY, f.receipts.nand.name, f.receipts.nand.symbol, f.receipts.nand.uri, getAddress(f.receipts.issuer)] as const,
    latch: [LATCH_CATEGORY, f.receipts.latch.name, f.receipts.latch.symbol, f.receipts.latch.uri, getAddress(f.receipts.issuer)] as const,
  };
}

/** Constructor input of the `role` pool: both pools take the same protocol and receipts. */
export function poolDeployment(f: SystemFile, role: PoolRole, nandReceipt: Address, latchReceipt: Address) {
  const p = f.pools[role];
  return {
    owner: getAddress(p.owner),
    bem: getAddress(f.protocol.bem),
    mining: getAddress(f.protocol.mining),
    minerCollection: getAddress(f.protocol.minerCollection),
    nandReceipt: getAddress(nandReceipt),
    latchReceipt: getAddress(latchReceipt),
    recipientA: getAddress(p.recipientA),
    recipientB: getAddress(p.recipientB),
    depositors: p.depositors.map(d => getAddress(d)),
    poolName: p.name,
  };
}
