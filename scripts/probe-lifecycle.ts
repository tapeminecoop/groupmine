#!/usr/bin/env node
/**
 * Read-only probe of the deployed Mining lifecycle (eth_call and eth_getLogs only; no transactions).
 *   node --import tsx scripts/probe-lifecycle.ts [maxTokenId] > reports/probe-lifecycle.json
 * Pins a recent block, reads every miner record up to maxTokenId, counts statuses, and for revoked
 * (2) and cooling (3) examples reads the Mining and BEM logs of the transaction that changed their
 * status (located through the record's stopBlock), to see whether rewards were paid out in it.
 * Env: RPC_URL (state, default bsc-dataseed), LOGS_RPC_URL (logs, default RPC_URL).
 */
import { createPublicClient, decodeEventLog, http, parseAbi, type Hex } from 'viem';

const rpc = createPublicClient({ transport: http(process.env.RPC_URL ?? 'https://bsc-dataseed.bnbchain.org', { timeout: 60_000, retryCount: 4, retryDelay: 1500 }) });
const logsRpc = createPublicClient({ transport: http(process.env.LOGS_RPC_URL ?? process.env.RPC_URL ?? 'https://bsc-dataseed.bnbchain.org', { timeout: 60_000, retryCount: 4, retryDelay: 1500 }) });
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const C = '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C';
const M = '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46';
const BEM = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a';
const abi = parseAbi([
  'function minerKey(address,uint256) view returns (bytes32)',
  'function getMiner(bytes32) view returns ((address circuits,uint64 circuitId,uint32 taskId,uint32 gateCount,uint32 stateCount,uint32 depth,uint64 area,uint32 mult,uint64 since,uint8 status,address registrant,uint32 nandBurn,uint32 latchBurn,uint64 bstar,uint64 bonus,bool optimal,uint64 commitBlock,uint64 firstUnusedId,uint64 stopBlock,uint128 verifWeight,uint128 unverWeight,uint256 debt))',
  'function ownerOf(uint256) view returns (address)',
  'function pending(bytes32) view returns (uint256)',
  'function pendingLive(bytes32) view returns (uint256)',
  'function STOP_COOLDOWN() view returns (uint256)',
  'event Claimed(bytes32 indexed key, address indexed to, uint256 amount)',
  'event Stopped(bytes32 indexed key, address indexed by)',
  'event Revoked(bytes32 indexed key, address indexed challenger, uint32 vectorIndex)',
  'event Reclaimed(bytes32 indexed key, uint32 indexed taskId, uint64 bonus)',
  'event Started(bytes32 indexed key, address indexed circuits, uint256 indexed circuitId, uint32 taskId, address registrant, uint64 bstar, uint64 bonus, bool optimal, uint256 verifWeight, uint256 unverWeight, uint32 samplesChecked)',
  'event Demoted(bytes32 indexed key, address indexed circuits, uint256 circuitId, uint32 taskId)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
const maxId = BigInt(process.argv[2] ?? 21_000);

const head = await rpc.getBlock({ blockTag: 'latest' });
const block = head.number - 20n;
const pinned = await rpc.getBlock({ blockNumber: block });
const mc = <T>(contracts: unknown[]) => rpc.multicall({ multicallAddress: MULTICALL3, blockNumber: block, allowFailure: true, batchSize: 200_000, contracts } as never) as Promise<{ status: string; result?: T }[]>;

type Miner = { circuits: string; circuitId: bigint; status: number; registrant: string; nandBurn: number; latchBurn: number; stopBlock: bigint; since: bigint; debt: bigint; taskId: number; gateCount: number };
const rows: { id: bigint; key: Hex; miner: Miner }[] = [];
for (let first = 1n; first <= maxId; first += 1000n) {
  const ids = Array.from({ length: Number(first + 999n <= maxId ? 1000n : maxId - first + 1n) }, (_, i) => first + BigInt(i));
  const keys = await mc<Hex>(ids.map(id => ({ address: M, abi, functionName: 'minerKey', args: [C, id] })));
  const miners = await mc<Miner>(keys.map(k => ({ address: M, abi, functionName: 'getMiner', args: [k.result ?? '0x' + '00'.repeat(32)] })));
  ids.forEach((id, i) => { if (keys[i].result && miners[i].result) rows.push({ id, key: keys[i].result!, miner: miners[i].result! }); });
}
const statuses: Record<string, number> = {};
for (const r of rows) statuses[r.miner.status] = (statuses[r.miner.status] ?? 0) + 1;
const cooldown = await rpc.readContract({ address: M, abi, functionName: 'STOP_COOLDOWN', blockNumber: block });

/** The status-changing transaction for a record: Mining logs for the key at stopBlock, plus BEM transfers in the same tx. */
async function transition(r: { id: bigint; key: Hex; miner: Miner }) {
  const at = r.miner.stopBlock;
  if (at === 0n) return { id: r.id, stopBlock: '0', note: 'no stopBlock recorded' };
  try {
    const logs = await logsRpc.getLogs({ address: M, fromBlock: at, toBlock: at });
    const mine = logs.filter(l => l.topics[1]?.toLowerCase() === r.key.toLowerCase());
    const txs = [...new Set(mine.map(l => l.transactionHash))];
    const out = [];
    for (const tx of txs) {
      const receipt = await logsRpc.getTransactionReceipt({ hash: tx! });
      const events = receipt.logs.flatMap(l => {
        if (l.address.toLowerCase() !== M.toLowerCase() && l.address.toLowerCase() !== BEM.toLowerCase()) return [];
        try {
          const d = decodeEventLog({ abi, data: l.data, topics: l.topics });
          if (l.address.toLowerCase() === BEM.toLowerCase() && d.eventName !== 'Transfer') return [];
          return [{ contract: l.address.toLowerCase() === BEM.toLowerCase() ? 'BEM' : 'Mining', event: d.eventName, args: d.args }];
        } catch { return []; }
      });
      out.push({ tx, from: (await logsRpc.getTransaction({ hash: tx! })).from, status: receipt.status, events });
    }
    return { id: r.id, stopBlock: at, transactions: out };
  } catch (e) {
    return { id: r.id, stopBlock: at, error: ((e as { shortMessage?: string }).shortMessage ?? String(e)).slice(0, 160) };
  }
}

const examples: Record<string, unknown[]> = {};
for (const s of [0, 2, 3]) {
  const list = rows.filter(r => r.miner.status === s && (s !== 0 || r.miner.stopBlock !== 0n)).slice(0, s === 0 ? 3 : 4);
  examples[s] = [];
  for (const r of list) {
    const [owner, pendingLive] = await Promise.all([
      rpc.readContract({ address: C, abi, functionName: 'ownerOf', args: [r.id], blockNumber: block }).catch(() => 'n/a'),
      rpc.readContract({ address: M, abi, functionName: 'pendingLive', args: [r.key], blockNumber: block }).catch(e => `revert ${(e as { shortMessage?: string }).shortMessage?.slice(0, 60)}`),
    ]);
    examples[s].push({ id: r.id, key: r.key, status: r.miner.status, registrant: r.miner.registrant, owner, since: r.miner.since, stopBlock: r.miner.stopBlock, debt: r.miner.debt, taskId: r.miner.taskId,
      pendingLive, transition: await transition(r) });
  }
}
const neverStarted = rows.filter(r => r.miner.status === 0 && r.miner.stopBlock === 0n && r.miner.since === 0n).length;
console.log(json({
  readOnly: true, block, blockHash: pinned.hash, timestamp: pinned.timestamp, scannedTokenIds: `1..${maxId}`, records: rows.length,
  statusLabels: { 0: 'none (frontend: Not mining)', 1: 'active (Mining)', 2: 'revoked (Revoked)', 3: 'cooling (Cooling down)' },
  statuses, statusZeroNeverStarted: neverStarted, STOP_COOLDOWN: cooldown, examples,
}));
