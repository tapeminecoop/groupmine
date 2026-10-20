#!/usr/bin/env node
/**
 * Read-only probe of the deployed Mining composition data (no transactions).
 *   node --import tsx scripts/probe-composition.ts scan [sampleSize]   find active miners, incl. LATCH-consuming ones
 *   node --import tsx scripts/probe-composition.ts ids 4630,2458        decode miner records and cachedBurn
 *   node --import tsx scripts/probe-composition.ts claimMany 4630,2458  eth_call claimMany with and without a bad key
 */
import { createPublicClient, encodeFunctionData, http, parseAbi, type Hex } from 'viem';

const rpc = createPublicClient({ transport: http(process.env.RPC_URL ?? 'https://bsc-dataseed.bnbchain.org', { timeout: 30_000, retryCount: 3 }) });
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const C = '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C';
const M = '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46';
const abi = parseAbi([
  'function minerKey(address,uint256) view returns (bytes32)',
  'function cachedBurn(address,uint256) view returns (bool cached, uint32 nand, uint32 latch)',
  'function getMiner(bytes32) view returns ((address circuits,uint64 circuitId,uint32 taskId,uint32 gateCount,uint32 stateCount,uint32 depth,uint64 area,uint32 mult,uint64 since,uint8 status,address registrant,uint32 nandBurn,uint32 latchBurn,uint64 bstar,uint64 bonus,bool optimal,uint64 commitBlock,uint64 firstUnusedId,uint64 stopBlock,uint128 verifWeight,uint128 unverWeight,uint256 debt))',
  'function claimMany(bytes32[])',
  'function claim(bytes32)',
  'function ownerOf(uint256) view returns (address)',
]);
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
const [mode = 'scan', arg = ''] = process.argv.slice(2);
const block = await rpc.getBlockNumber();

async function records(ids: bigint[]) {
  const keys = await rpc.multicall({ multicallAddress: MULTICALL3, blockNumber: block, allowFailure: true,
    contracts: ids.map(id => ({ address: M, abi, functionName: 'minerKey', args: [C, id] } as const)) });
  const miners = await rpc.multicall({ multicallAddress: MULTICALL3, blockNumber: block, allowFailure: true,
    contracts: keys.map(k => ({ address: M, abi, functionName: 'getMiner', args: [k.result as Hex] } as const)) });
  const burns = await rpc.multicall({ multicallAddress: MULTICALL3, blockNumber: block, allowFailure: true,
    contracts: ids.map(id => ({ address: M, abi, functionName: 'cachedBurn', args: [C, id] } as const)) });
  return ids.map((id, i) => ({ id, key: keys[i].result, miner: miners[i].result, burn: burns[i].result }));
}

if (mode === 'scan') {
  const size = Number(arg || 600);
  const ids = new Set<bigint>();
  while (ids.size < size) ids.add(BigInt(1 + Math.floor(Math.random() * 21_000)));
  const rows = await records([...ids]);
  const active = rows.filter(r => r.miner && Number(r.miner.status) === 1);
  const latch = active.filter(r => r.miner!.latchBurn > 0);
  const mismatch = active.filter(r => !r.burn || r.burn[1] !== r.miner!.nandBurn || r.burn[2] !== r.miner!.latchBurn || !r.burn[0]);
  const statuses: Record<string, number> = {};
  for (const r of rows) if (r.miner) statuses[String(r.miner.status)] = (statuses[String(r.miner.status)] ?? 0) + 1;
  console.log(json({ block, sampled: rows.length, statuses, active: active.length, activeWithLatch: latch.length, recordVsCachedBurnMismatch: mismatch.length,
    gateCountNotEqualNandBurn: active.filter(r => r.miner!.gateCount !== r.miner!.nandBurn).length,
    latchExamples: latch.slice(0, 12).map(r => ({ id: r.id, nandBurn: r.miner!.nandBurn, latchBurn: r.miner!.latchBurn, gateCount: r.miner!.gateCount, stateCount: r.miner!.stateCount, bstar: r.miner!.bstar, cachedBurn: r.burn })),
    mismatchExamples: mismatch.slice(0, 5).map(r => ({ id: r.id, miner: [r.miner!.nandBurn, r.miner!.latchBurn], burn: r.burn })) }));
  // Claim behaviour by miner status (eth_call only).
  const byStatus = new Map<number, typeof rows>();
  for (const r of rows) if (r.miner) byStatus.set(Number(r.miner.status), [...(byStatus.get(Number(r.miner.status)) ?? []), r]);
  for (const [status, list] of byStatus) {
    for (const r of list.slice(0, 3)) {
      let result = 'SUCCESS';
      try { await rpc.call({ to: M, data: encodeFunctionData({ abi, functionName: 'claim', args: [r.key as Hex] }), blockNumber: block }); }
      catch (e) { result = `REVERT ${((e as { shortMessage?: string }).shortMessage ?? '').slice(0, 90)}`; }
      console.log(json({ status, id: r.id, nandBurn: r.miner!.nandBurn, latchBurn: r.miner!.latchBurn, stopBlock: r.miner!.stopBlock, claim: result }));
    }
  }
} else if (mode === 'ids') {
  for (const r of await records(arg.split(',').map(BigInt))) console.log(json(r));
} else if (mode === 'claimMany') {
  const ids = arg.split(',').map(BigInt);
  const keys = await Promise.all(ids.map(id => rpc.readContract({ address: M, abi, functionName: 'minerKey', args: [C, id], blockNumber: block })));
  const bad = await rpc.readContract({ address: M, abi, functionName: 'minerKey', args: [C, 999_999_999n], blockNumber: block });
  const tryCall = async (label: string, data: Hex) => {
    try { await rpc.call({ to: M, data, blockNumber: block, account: '0x000000000000000000000000000000000000dEaD' }); return { label, result: 'SUCCESS' }; }
    catch (e) { return { label, result: 'REVERT', detail: ((e as { shortMessage?: string }).shortMessage ?? '').slice(0, 120) }; }
  };
  console.log(json({ block, results: [
    await tryCall('claimMany(valid keys)', encodeFunctionData({ abi, functionName: 'claimMany', args: [keys] })),
    await tryCall('claimMany(valid + unknown key)', encodeFunctionData({ abi, functionName: 'claimMany', args: [[...keys, bad]] })),
    await tryCall('claimMany(unknown key first)', encodeFunctionData({ abi, functionName: 'claimMany', args: [[bad, ...keys]] })),
    await tryCall('claim(unknown key)', encodeFunctionData({ abi, functionName: 'claim', args: [bad] })),
  ] }));
}
