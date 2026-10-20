#!/usr/bin/env node
/**
 * Read-only: locate the block in which a miner's Mining status changed (binary search with eth_call
 * at historical blocks), then decode the Mining and BEM events of the Mining transactions in that
 * block, to see whether the transition paid the holder.
 *   node --import tsx scripts/probe-revocation.ts <tokenId> <fromBlock> <toBlock>
 * Env: RPC_URL (archive). No transactions are sent.
 */
import { createPublicClient, decodeEventLog, http, parseAbi, type Hex } from 'viem';

const rpc = createPublicClient({ transport: http(process.env.RPC_URL ?? 'https://bsc-mainnet.public.blastapi.io', { timeout: 60_000, retryCount: 5, retryDelay: 2000 }) });
const C = '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C';
const M = '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46';
const BEM = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a';
const abi = parseAbi([
  'function minerKey(address,uint256) view returns (bytes32)',
  'function getMiner(bytes32) view returns ((address circuits,uint64 circuitId,uint32 taskId,uint32 gateCount,uint32 stateCount,uint32 depth,uint64 area,uint32 mult,uint64 since,uint8 status,address registrant,uint32 nandBurn,uint32 latchBurn,uint64 bstar,uint64 bonus,bool optimal,uint64 commitBlock,uint64 firstUnusedId,uint64 stopBlock,uint128 verifWeight,uint128 unverWeight,uint256 debt))',
  'function ownerOf(uint256) view returns (address)',
  'event Claimed(bytes32 indexed key, address indexed to, uint256 amount)',
  'event Stopped(bytes32 indexed key, address indexed by)',
  'event Revoked(bytes32 indexed key, address indexed challenger, uint32 vectorIndex)',
  'event Reclaimed(bytes32 indexed key, uint32 indexed taskId, uint64 bonus)',
  'event Demoted(bytes32 indexed key, address indexed circuits, uint256 circuitId, uint32 taskId)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
const [idArg, fromArg, toArg] = process.argv.slice(2);
const id = BigInt(idArg);
const key = await rpc.readContract({ address: M, abi, functionName: 'minerKey', args: [C, id] });
const statusAt = async (b: bigint) => Number((await rpc.readContract({ address: M, abi, functionName: 'getMiner', args: [key], blockNumber: b })).status);

let lo = BigInt(fromArg);
let hi = BigInt(toArg);
const startStatus = await statusAt(lo);
const endStatus = await statusAt(hi);
if (startStatus === endStatus) throw new Error(`status is ${startStatus} at both ends; widen the range`);
while (hi - lo > 1n) {
  const mid = (lo + hi) / 2n;
  if ((await statusAt(mid)) === startStatus) lo = mid; else hi = mid;
}
const block = await rpc.getBlock({ blockNumber: hi, includeTransactions: true });
const holderBefore = await rpc.readContract({ address: C, abi, functionName: 'ownerOf', args: [id], blockNumber: lo });
const minerBefore = await rpc.readContract({ address: M, abi, functionName: 'getMiner', args: [key], blockNumber: lo });
const minerAfter = await rpc.readContract({ address: M, abi, functionName: 'getMiner', args: [key], blockNumber: hi });
const txs = [];
for (const tx of block.transactions) {
  if (typeof tx === 'string' || tx.to?.toLowerCase() !== M.toLowerCase()) continue;
  const receipt = await rpc.getTransactionReceipt({ hash: tx.hash });
  const events = receipt.logs.flatMap(l => {
    const emitter = l.address.toLowerCase();
    if (emitter !== M.toLowerCase() && emitter !== BEM.toLowerCase()) return [];
    try {
      const d = decodeEventLog({ abi, data: l.data, topics: l.topics });
      return [{ contract: emitter === BEM.toLowerCase() ? 'BEM' : 'Mining', event: d.eventName, args: d.args }];
    } catch { return []; }
  });
  if (events.some(e => (e.args as { key?: Hex }).key?.toLowerCase() === key.toLowerCase())) {
    txs.push({ hash: tx.hash, from: tx.from, input4: tx.input.slice(0, 10), status: receipt.status, events });
  }
}
console.log(json({
  readOnly: true, tokenId: id, key, transitionBlock: hi, blockHash: block.hash, timestamp: block.timestamp,
  statusBefore: startStatus, statusAfter: endStatus, holderBeforeTransition: holderBefore,
  debtBefore: minerBefore.debt, debtAfter: minerAfter.debt, transactions: txs,
}));
