#!/usr/bin/env node
/**
 * Read-only: for every circuit, compare the collection's recorded gate count (circuitInfo) with Mining's
 * computed local burn (circuitBurn) and the cached burn, to find circuits that reference sub-circuits
 * (recorded gates > local burn) and check that the three sources agree everywhere else.
 *   node --import tsx scripts/probe-circuit-burn.ts [maxTokenId] > .runtime/probe-circuit-burn.json
 * Env: RPC_URL (archive). No transactions are sent.
 */
import { createPublicClient, http, parseAbi, type Hex } from 'viem';

const rpc = createPublicClient({ transport: http(process.env.RPC_URL ?? 'https://bsc-mainnet.public.blastapi.io', { timeout: 120_000, retryCount: 4, retryDelay: 2000 }) });
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const C = '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C';
const M = '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46';
const abi = parseAbi([
  'function minerKey(address,uint256) view returns (bytes32)',
  'function getMiner(bytes32) view returns ((address circuits,uint64 circuitId,uint32 taskId,uint32 gateCount,uint32 stateCount,uint32 depth,uint64 area,uint32 mult,uint64 since,uint8 status,address registrant,uint32 nandBurn,uint32 latchBurn,uint64 bstar,uint64 bonus,bool optimal,uint64 commitBlock,uint64 firstUnusedId,uint64 stopBlock,uint128 verifWeight,uint128 unverWeight,uint256 debt))',
  'function cachedBurn(address,uint256) view returns (bool cached,uint32 nand,uint32 latch)',
  'function circuitBurn(address,uint256) view returns (uint32 nand,uint32 latch)',
  'function circuitInfo(uint256) view returns (uint32,uint32,uint32,uint32)',
]);
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
const maxId = BigInt(process.argv[2] ?? 21_000);
const block = (await rpc.getBlockNumber()) - 20n;
const pinned = await rpc.getBlock({ blockNumber: block });
const mc = <T>(contracts: unknown[]) => rpc.multicall({ multicallAddress: MULTICALL3, blockNumber: block, allowFailure: true, batchSize: 50_000, contracts } as never) as Promise<{ status: string; result?: T }[]>;

const references: unknown[] = [];
const disagreements: unknown[] = [];
let scanned = 0;
let burnUnavailable = 0;
let activeChecked = 0;
for (let first = 1n; first <= maxId; first += 250n) {
  const ids = Array.from({ length: Number(first + 249n <= maxId ? 250n : maxId - first + 1n) }, (_, i) => first + BigInt(i));
  const [infos, burns, cached, keys] = await Promise.all([
    mc<readonly [number, number, number, number]>(ids.map(id => ({ address: C, abi, functionName: 'circuitInfo', args: [id] }))),
    mc<readonly [number, number]>(ids.map(id => ({ address: M, abi, functionName: 'circuitBurn', args: [C, id] }))),
    mc<readonly [boolean, number, number]>(ids.map(id => ({ address: M, abi, functionName: 'cachedBurn', args: [C, id] }))),
    mc<Hex>(ids.map(id => ({ address: M, abi, functionName: 'minerKey', args: [C, id] }))),
  ]);
  const miners = await mc<{ status: number; nandBurn: number; latchBurn: number; gateCount: number }>(keys.map(k => ({ address: M, abi, functionName: 'getMiner', args: [k.result ?? '0x' + '00'.repeat(32)] })));
  ids.forEach((id, i) => {
    const info = infos[i].result;
    if (!info) return;
    scanned++;
    const burn = burns[i].result;
    if (!burn) { burnUnavailable++; return; }
    const own = burn[0] + burn[1];
    const m = miners[i].result;
    const c = cached[i].result;
    if (info[3] !== own) references.push({ id, circuitInfo: info, circuitBurn: burn, cachedBurn: c, minerStatus: m?.status, getMinerBurn: m ? [m.nandBurn, m.latchBurn] : undefined, gateCount: m?.gateCount });
    if (m && m.status === 1) {
      activeChecked++;
      if (!c || !c[0] || c[1] !== burn[0] || c[2] !== burn[1] || m.nandBurn !== burn[0] || m.latchBurn !== burn[1]) disagreements.push({ id, circuitBurn: burn, cachedBurn: c, getMinerBurn: [m.nandBurn, m.latchBurn] });
    }
  });
}
references.sort((a, b) => ((b as { circuitInfo: number[] }).circuitInfo[3] - (b as { circuitBurn: number[] }).circuitBurn[0] - (b as { circuitBurn: number[] }).circuitBurn[1])
  - ((a as { circuitInfo: number[] }).circuitInfo[3] - (a as { circuitBurn: number[] }).circuitBurn[0] - (a as { circuitBurn: number[] }).circuitBurn[1]));
console.log(json({ readOnly: true, block, blockHash: pinned.hash, circuitsScanned: scanned, circuitBurnUnavailable: burnUnavailable,
  activeMinersCheckedAgainstCircuitBurn: activeChecked, activeDisagreements: disagreements.length, disagreementExamples: disagreements.slice(0, 10),
  circuitsWithReferences: references.length, referenceExamples: references.slice(0, 25) }));
