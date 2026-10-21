#!/usr/bin/env node
/**
 * Read-only: the Mining proxy's ERC-1967 implementation over a block range (eth_getStorageAt only).
 *   node --import tsx scripts/probe-implementation-history.ts <fromBlock> <toBlock> [outFile]
 * Finds every block where the implementation slot changes, by recursive bisection (a change between
 * two probes with equal values is missed only if the implementation changed and changed back).
 * Env: RPC_URL (archive; default the public blastapi endpoint).
 */
import { writeFile } from 'node:fs/promises';
import { createPublicClient, getAddress, http, type Hex } from 'viem';

const rpc = createPublicClient({ transport: http(process.env.RPC_URL ?? 'https://bsc-mainnet.public.blastapi.io', { timeout: 60_000, retryCount: 6, retryDelay: 3000 }) });
const MINING = '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46';
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
const [fromArg, toArg, outFile] = process.argv.slice(2);

const implAt = async (b: bigint) => {
  const v = (await rpc.getStorageAt({ address: MINING, slot: SLOT as Hex, blockNumber: b })) ?? '0x';
  return v === '0x' || BigInt(v) === 0n ? null : getAddress(`0x${v.slice(-40)}`);
};
const changes: { block: bigint; from: string | null; to: string | null }[] = [];
async function bisect(lo: bigint, vLo: string | null, hi: bigint, vHi: string | null): Promise<void> {
  if (vLo === vHi) return;
  if (hi - lo === 1n) {
    changes.push({ block: hi, from: vLo, to: vHi });
    return;
  }
  const mid = (lo + hi) / 2n;
  const vMid = await implAt(mid);
  await bisect(lo, vLo, mid, vMid);
  await bisect(mid, vMid, hi, vHi);
}
const from = BigInt(fromArg);
const to = BigInt(toArg);
// Coarse probes every ~1M blocks so that an upgrade and a later revert to the same address is unlikely to be missed.
const step = 1_000_000n;
const points = [from];
for (let b = from + step; b < to; b += step) points.push(b);
points.push(to);
const values: (string | null)[] = [];
for (const b of points) values.push(await implAt(b));
for (let i = 0; i + 1 < points.length; i++) await bisect(points[i], values[i], points[i + 1], values[i + 1]);
const result = { readOnly: true, proxy: MINING, slot: SLOT, from, to, probes: points.map((b, i) => ({ block: b, implementation: values[i] })), changes };
if (outFile) await writeFile(outFile, json(result) + '\n');
console.log(json(result));
