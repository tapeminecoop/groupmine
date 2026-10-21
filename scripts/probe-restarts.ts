#!/usr/bin/env node
/**
 * Read-only lifecycle history of every miner record (eth_call only; no transactions, no logs).
 *   node --import tsx scripts/probe-restarts.ts <block> [maxTokenId] [outFile]
 * Reads all records 1..maxTokenId at the pinned block and lists the ones whose fields show a past
 * stop (stopBlock != 0) by current status. For every ACTIVE record with a stopBlock (a miner that was
 * stopped and is mining again) it locates the restart by binary search over the status between
 * stopBlock and the pinned block, and reads the record just before and at the restart block, with the
 * Mining transactions of that block that mention the key.
 * Env: RPC_URL (archive; default the public blastapi endpoint).
 */
import { writeFile } from 'node:fs/promises';
import { createPublicClient, decodeEventLog, decodeFunctionData, http, parseAbi, type Hex } from 'viem';

const rpc = createPublicClient({ transport: http(process.env.RPC_URL ?? 'https://bsc-mainnet.public.blastapi.io', { timeout: 90_000, retryCount: 6, retryDelay: 3000 }) });
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const C = '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C';
const M = '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46';
// Official frontend ABI (tapeout.net/pod bundle sha256 0f1b12c3…0a1e).
const abi = parseAbi([
  'function minerKey(address,uint256) view returns (bytes32)',
  'function getMiner(bytes32) view returns ((address circuits,uint64 circuitId,uint32 taskId,uint32 gateCount,uint32 stateCount,uint32 depth,uint64 area,uint32 mult,uint64 since,uint8 status,address registrant,uint32 nandBurn,uint32 latchBurn,uint64 bstar,uint64 bonus,bool optimal,uint64 commitBlock,uint64 firstUnusedId,uint64 stopBlock,uint128 verifWeight,uint128 unverWeight,uint256 debt))',
  'function pending(bytes32) view returns (uint256)',
  'function start(address,uint256,uint32,uint256,bytes[],bytes[],bytes32[][],bytes32) returns (bytes32)',
  'function stop(bytes32)',
  'function reclaim(bytes32)',
  'function claim(bytes32)',
  'function arm(address,uint256)',
  'function challenge(bytes32,uint32,bytes,bytes,bytes32[])',
  'function kick(uint32,address)',
  'event Started(bytes32 indexed key, address indexed circuits, uint256 indexed circuitId, uint32 taskId, address registrant, uint64 bstar, uint64 bonus, bool optimal, uint256 verifWeight, uint256 unverWeight, uint32 samplesChecked)',
  'event Claimed(bytes32 indexed key, address indexed to, uint256 amount)',
  'event Stopped(bytes32 indexed key, address indexed by)',
  'event Revoked(bytes32 indexed key, address indexed challenger, uint32 vectorIndex)',
  'event Reclaimed(bytes32 indexed key, uint32 indexed taskId, uint64 bonus)',
  'event Demoted(bytes32 indexed key, address indexed circuits, uint256 circuitId, uint32 taskId)',
]);
type Miner = { status: number; stopBlock: bigint; since: bigint; debt: bigint; verifWeight: bigint; unverWeight: bigint; taskId: number; registrant: string };
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
const block = BigInt(process.argv[2]);
const maxId = BigInt(process.argv[3] ?? 21_000);
const outFile = process.argv[4];
const mc = <T>(contracts: unknown[]) => rpc.multicall({ multicallAddress: MULTICALL3, blockNumber: block, allowFailure: true, batchSize: 200_000, contracts } as never) as Promise<{ result?: T }[]>;

const rows: { id: bigint; key: Hex; miner: Miner }[] = [];
for (let first = 1n; first <= maxId; first += 1000n) {
  const ids = Array.from({ length: Number(first + 999n <= maxId ? 1000n : maxId - first + 1n) }, (_, i) => first + BigInt(i));
  const keys = await mc<Hex>(ids.map(id => ({ address: M, abi, functionName: 'minerKey', args: [C, id] })));
  const miners = await mc<Miner>(keys.map(k => ({ address: M, abi, functionName: 'getMiner', args: [k.result ?? '0x' + '00'.repeat(32)] })));
  ids.forEach((id, i) => { if (keys[i].result && miners[i].result) rows.push({ id, key: keys[i].result!, miner: miners[i].result! }); });
}
const byStatus = (s: number) => rows.filter(r => r.miner.status === s);
const summary = Object.fromEntries([0, 1, 2, 3].map(s => [s, {
  records: byStatus(s).length,
  withStopBlock: byStatus(s).filter(r => r.miner.stopBlock !== 0n).length,
  withWeight: byStatus(s).filter(r => r.miner.verifWeight + r.miner.unverWeight > 0n).length,
}]));

const statusAt = async (key: Hex, b: bigint) => Number((await rpc.readContract({ address: M, abi, functionName: 'getMiner', args: [key], blockNumber: b })).status);
async function restart(r: { id: bigint; key: Hex; miner: Miner }) {
  let lo = r.miner.stopBlock;
  let hi = block;
  if ((await statusAt(r.key, lo)) !== 3) return { id: r.id, note: 'not COOLING at its stopBlock' };
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await statusAt(r.key, mid)) === 3) lo = mid; else hi = mid;
  }
  const [before, after] = await Promise.all([lo, hi].map(b => rpc.readContract({ address: M, abi, functionName: 'getMiner', args: [r.key], blockNumber: b })));
  const b = await rpc.getBlock({ blockNumber: hi, includeTransactions: true });
  const txs = [];
  for (const tx of b.transactions) {
    if (typeof tx === 'string' || tx.to?.toLowerCase() !== M.toLowerCase()) continue;
    const receipt = await rpc.getTransactionReceipt({ hash: tx.hash });
    const mine = receipt.logs.filter(l => l.address.toLowerCase() === M.toLowerCase());
    if (!mine.some(l => l.topics[1]?.toLowerCase() === r.key.toLowerCase())) continue;
    let fn: string | null = null;
    try { fn = decodeFunctionData({ abi, data: tx.input }).functionName; } catch { /* unknown */ }
    txs.push({ hash: tx.hash, from: tx.from, function: fn, input4: tx.input.slice(0, 10), inputBytes: (tx.input.length - 2) / 2, status: receipt.status,
      events: mine.flatMap((l): unknown[] => { try { const d = decodeEventLog({ abi, data: l.data, topics: l.topics }); return [{ event: d.eventName, args: d.args }]; } catch { return [{ event: 'unknown', topic: l.topics[0] }]; } }) });
  }
  return { id: r.id, key: r.key, stopBlock: r.miner.stopBlock, restartBlock: hi, blockHash: b.hash, timestamp: b.timestamp, before, after, transactions: txs };
}

const restarted = byStatus(1).filter(r => r.miner.stopBlock !== 0n);
const restarts = [];
for (const r of restarted) restarts.push(await restart(r));
const result = {
  readOnly: true, block, scannedTokenIds: `1..${maxId}`, records: rows.length, summary,
  revoked: byStatus(2).map(r => ({ id: r.id, key: r.key, stopBlock: r.miner.stopBlock, verifWeight: r.miner.verifWeight, unverWeight: r.miner.unverWeight, debt: r.miner.debt })),
  cooling: byStatus(3).map(r => ({ id: r.id, key: r.key, stopBlock: r.miner.stopBlock, verifWeight: r.miner.verifWeight, unverWeight: r.miner.unverWeight, debt: r.miner.debt })),
  restarts,
};
if (outFile) await writeFile(outFile, json(result) + '\n');
console.log(json({ ...result, revoked: result.revoked.length, cooling: result.cooling.length }));
