#!/usr/bin/env node
/**
 * Read-only: find the transaction that first started a miner (status 0 -> non-zero, located by binary
 * search with eth_call at historical blocks) and record its full calldata, decoded with the official
 * frontend's `start` signature, the Mining events it emitted for the key, and the `commitDesign`
 * transaction of the record's commitBlock. Shows how recorded miners were started; the fork test
 * test/fork/MiningTransitions.t.sol restarts with the unverified form #672 was started with. No
 * transaction is sent.
 *   node --import tsx scripts/probe-start.ts <tokenId> <fromBlock> <toBlock> [outFile]
 * Env: RPC_URL (archive; default the public blastapi endpoint).
 */
import { writeFile } from 'node:fs/promises';
import { createPublicClient, decodeEventLog, decodeFunctionData, http, parseAbi, type Hex } from 'viem';

const rpc = createPublicClient({ transport: http(process.env.RPC_URL ?? 'https://bsc-mainnet.public.blastapi.io', { timeout: 60_000, retryCount: 6, retryDelay: 3000 }) });
const C = '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C';
const M = '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46';
// Official frontend ABI (tapeout.net/pod bundle sha256 0f1b12c3…0a1e).
const abi = parseAbi([
  'function minerKey(address,uint256) view returns (bytes32)',
  'function getMiner(bytes32) view returns ((address circuits,uint64 circuitId,uint32 taskId,uint32 gateCount,uint32 stateCount,uint32 depth,uint64 area,uint32 mult,uint64 since,uint8 status,address registrant,uint32 nandBurn,uint32 latchBurn,uint64 bstar,uint64 bonus,bool optimal,uint64 commitBlock,uint64 firstUnusedId,uint64 stopBlock,uint128 verifWeight,uint128 unverWeight,uint256 debt))',
  'function start(address,uint256,uint32,uint256,bytes[],bytes[],bytes32[][],bytes32) returns (bytes32)',
  'function arm(address,uint256)',
  'function commitDesign(address,bytes32)',
  'event Started(bytes32 indexed key, address indexed circuits, uint256 indexed circuitId, uint32 taskId, address registrant, uint64 bstar, uint64 bonus, bool optimal, uint256 verifWeight, uint256 unverWeight, uint32 samplesChecked)',
  'event Claimed(bytes32 indexed key, address indexed to, uint256 amount)',
  'event Reclaimed(bytes32 indexed key, uint32 indexed taskId, uint64 bonus)',
  'event Demoted(bytes32 indexed key, address indexed circuits, uint256 circuitId, uint32 taskId)',
  'event DesignCommitted(bytes32 indexed commitment, address indexed designer, address indexed circuits, uint256 blockNumber, uint64 firstUnusedId)',
]);
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
const [idArg, fromArg, toArg, outFile] = process.argv.slice(2);
const id = BigInt(idArg);
const key = await rpc.readContract({ address: M, abi, functionName: 'minerKey', args: [C, id] });
/** Status at a block; 0 before Mining existed (no code at the proxy). */
async function statusAt(b: bigint) {
  const code = await rpc.getCode({ address: M, blockNumber: b });
  if (!code || code === '0x') return 0;
  return Number((await rpc.readContract({ address: M, abi, functionName: 'getMiner', args: [key], blockNumber: b })).status);
}

/** Mining transactions of a block that pass `keep` (given the tx and its Mining logs), decoded. */
async function miningTxs(blockNumber: bigint, keep: (tx: { from: string; input: Hex }, topics: (Hex | undefined)[]) => boolean) {
  const block = await rpc.getBlock({ blockNumber, includeTransactions: true });
  const txs = [];
  for (const tx of block.transactions) {
    if (typeof tx === 'string' || tx.to?.toLowerCase() !== M.toLowerCase()) continue;
    const receipt = await rpc.getTransactionReceipt({ hash: tx.hash });
    const mine = receipt.logs.filter(l => l.address.toLowerCase() === M.toLowerCase());
    if (!keep(tx, mine.map(l => l.topics[1]))) continue;
    const events = mine.flatMap((l): unknown[] => {
      try { const d = decodeEventLog({ abi, data: l.data, topics: l.topics }); return [{ event: d.eventName, args: d.args }]; } catch { return [{ event: 'unknown', topics: l.topics, data: l.data }]; }
    });
    let decoded: unknown = null;
    try { decoded = decodeFunctionData({ abi, data: tx.input }); } catch { /* not a frontend function */ }
    txs.push({ hash: tx.hash, from: tx.from, nonce: tx.nonce, input4: tx.input.slice(0, 10), input: tx.input, status: receipt.status, gasUsed: receipt.gasUsed, decoded, events });
  }
  return { blockNumber, blockHash: block.hash, timestamp: block.timestamp, txs };
}

let lo = BigInt(fromArg);
let hi = BigInt(toArg);
if ((await statusAt(lo)) !== 0) throw new Error('status is not 0 at fromBlock; start earlier');
if ((await statusAt(hi)) === 0) throw new Error('status is still 0 at toBlock');
while (hi - lo > 1n) {
  const mid = (lo + hi) / 2n;
  if ((await statusAt(mid)) === 0) lo = mid; else hi = mid;
}
const record = await rpc.readContract({ address: M, abi, functionName: 'getMiner', args: [key], blockNumber: hi });
const started = await miningTxs(hi, (_, topics) => topics.some(t => t?.toLowerCase() === key.toLowerCase()));
const starter = started.txs.find(t => t.input4 === '0xa3494614')?.from.toLowerCase();
// The design commitment the start relied on: commitDesign transactions of the same sender at the record's commitBlock.
const committed = record.commitBlock > 0n && starter
  ? await miningTxs(record.commitBlock, tx => tx.from.toLowerCase() === starter && tx.input.startsWith('0xc7b21b6c'))
  : null;
const result = { readOnly: true, tokenId: id, key, startBlock: hi, recordAtStart: record, start: started, commitBlock: record.commitBlock, commit: committed };
if (outFile) await writeFile(outFile, json(result) + '\n');
const short = (t: { input: string }) => ({ ...t, input: `${t.input.slice(0, 74)}… (${(t.input.length - 2) / 2} bytes)` });
console.log(json({ ...result, start: { ...started, txs: started.txs.map(short) }, commit: committed && { ...committed, txs: committed.txs.map(short) } }));
