#!/usr/bin/env node
/**
 * Read-only: find ACTIVE miners whose circuit statistics differ from their local burn (gateCount !=
 * nandBurn + latchBurn), the signature of a circuit that references other circuits, and read every
 * independent source available for a few of them.
 *   node --import tsx scripts/probe-references.ts [maxTokenId] > .runtime/probe-references.json
 * Env: RPC_URL (archive). No transactions are sent.
 */
import { createPublicClient, http, parseAbi, type Hex } from 'viem';

const rpc = createPublicClient({ transport: http(process.env.RPC_URL ?? 'https://bsc-mainnet.public.blastapi.io', { timeout: 60_000, retryCount: 4, retryDelay: 1500 }) });
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const C = '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C';
const M = '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46';
const abi = parseAbi([
  'function minerKey(address,uint256) view returns (bytes32)',
  'function getMiner(bytes32) view returns ((address circuits,uint64 circuitId,uint32 taskId,uint32 gateCount,uint32 stateCount,uint32 depth,uint64 area,uint32 mult,uint64 since,uint8 status,address registrant,uint32 nandBurn,uint32 latchBurn,uint64 bstar,uint64 bonus,bool optimal,uint64 commitBlock,uint64 firstUnusedId,uint64 stopBlock,uint128 verifWeight,uint128 unverWeight,uint256 debt))',
  'function cachedBurn(address,uint256) view returns (bool cached,uint32 nand,uint32 latch)',
  'function cachedDepth(address,uint256) view returns (bool cached,uint32 depth,uint32 live)',
  'function circuitBurn(address,uint256) view returns (uint32 nand,uint32 latch)',
  'function circuitInfo(uint256) view returns (uint32,uint32,uint32,uint32)',
  'function netlist(uint256) view returns (bytes)',
]);
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
const maxId = BigInt(process.argv[2] ?? 21_000);
const block = (await rpc.getBlockNumber()) - 20n;
const pinned = await rpc.getBlock({ blockNumber: block });
const mc = <T>(contracts: unknown[]) => rpc.multicall({ multicallAddress: MULTICALL3, blockNumber: block, allowFailure: true, batchSize: 200_000, contracts } as never) as Promise<{ result?: T }[]>;

type Miner = { status: number; gateCount: number; stateCount: number; nandBurn: number; latchBurn: number; depth: number; area: bigint; bstar: bigint };
type Candidate = { id: bigint; key: Hex; m: Miner; info: readonly [number, number, number, number]; depth: readonly [boolean, number, number] };
const candidates: Candidate[] = [];
let active = 0;
let gateCountDiffers = 0;
for (let first = 1n; first <= maxId; first += 1000n) {
  const ids = Array.from({ length: Number(first + 999n <= maxId ? 1000n : maxId - first + 1n) }, (_, i) => first + BigInt(i));
  const keys = await mc<Hex>(ids.map(id => ({ address: M, abi, functionName: 'minerKey', args: [C, id] })));
  const miners = await mc<Miner>(keys.map(k => ({ address: M, abi, functionName: 'getMiner', args: [k.result ?? '0x' + '00'.repeat(32)] })));
  const infos = await mc<readonly [number, number, number, number]>(ids.map(id => ({ address: C, abi, functionName: 'circuitInfo', args: [id] })));
  const depths = await mc<readonly [boolean, number, number]>(ids.map(id => ({ address: M, abi, functionName: 'cachedDepth', args: [C, id] })));
  ids.forEach((id, i) => {
    const m = miners[i].result;
    if (!m || m.status !== 1) return;
    active++;
    if (m.gateCount !== m.nandBurn + m.latchBurn) gateCountDiffers++;
    const info = infos[i].result;
    const depth = depths[i].result;
    // A circuit that references others: the collection's recorded gate count (circuitInfo, which the
    // official frontend describes as "including referenced sub-circuits") exceeds its own burn.
    if (info && depth && info[3] !== m.nandBurn + m.latchBurn) candidates.push({ id, key: keys[i].result!, m, info, depth });
  });
}
// Largest difference first: the clearest separation between local burn and recursive statistics.
candidates.sort((a, b) => (b.info[3] - b.m.nandBurn - b.m.latchBurn) - (a.info[3] - a.m.nandBurn - a.m.latchBurn));
const tryRead = async (address: Hex, functionName: string, args: readonly unknown[]) => {
  try { return await rpc.readContract({ address, abi, functionName, args, blockNumber: block } as never); }
  catch (e) { return `unavailable: ${((e as { shortMessage?: string }).shortMessage ?? '').slice(0, 80)}`; }
};
const samples = [];
for (const c of candidates.slice(0, 4)) {
  const netlist = await tryRead(C, 'netlist', [c.id]);
  samples.push({
    id: c.id, key: c.key, getMiner: c.m,
    cachedBurn: await tryRead(M, 'cachedBurn', [C, c.id]),
    circuitBurn: await tryRead(M, 'circuitBurn', [C, c.id]),
    cachedDepth: await tryRead(M, 'cachedDepth', [C, c.id]),
    circuitInfo: await tryRead(C, 'circuitInfo', [c.id]),
    netlistBytes: typeof netlist === 'string' && netlist.startsWith('0x') ? (netlist.length - 2) / 2 : netlist,
    netlist: typeof netlist === 'string' && netlist.startsWith('0x') && netlist.length < 20_000 ? netlist : undefined,
  });
}
console.log(json({ readOnly: true, block, blockHash: pinned.hash, activeMiners: active, gateCountDiffersFromBurn: gateCountDiffers,
  liveDiffersFromBurn: candidates.length,
  firstCandidates: candidates.slice(0, 20).map(c => ({ id: c.id, nandBurn: c.m.nandBurn, latchBurn: c.m.latchBurn, gateCount: c.m.gateCount, stateCount: c.m.stateCount, depth: c.m.depth, cachedDepth: c.depth, circuitInfo: c.info })), samples }));
