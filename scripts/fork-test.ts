#!/usr/bin/env node
/**
 * Real BSC protocol fork test.
 *  1. Pins a recent BSC block and discovers (read-only multicall): a NAND-only active miner, an active
 *     miner that burns LATCH, an inactive token, and further active miners for the gas-scaling run —
 *     all held by plain EOAs (impersonated on the fork only).
 *  2. Runs every test in test/fork/ (PoolFork, PoolBoundary, MiningLifecycle; fork profile: Cancun EVM,
 *     Paris artifacts from ./out) and requires all 11 to pass.
 *  3. Writes reports/fork-test.json with the observations each test wrote.
 *
 * Env: FORK_RPC_URL (archive), DISCOVERY_RPC_URL (recent state; defaults to FORK_RPC_URL), FORK_BLOCK,
 *      FORK_NAND_MINER / FORK_LATCH_MINER / FORK_INACTIVE_TOKEN / FORK_SCALE_MINERS (overrides),
 *      FORK_SCALE_COUNT (default 24), FORK_CUPS (default 40). The boundary and composition tests use
 *      miners verified at block 128,713,128 (FORK_OLD_MINERS, FORK_INCOMING_MINERS, FORK_DONOR_MINER,
 *      FORK_REFERENCE_CIRCUIT); set them when pinning another block.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { BSC_PROTOCOL, erc721Abi, miningAbi } from '../sdk/constants.ts';

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const json = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
const archiveUrl: string = process.env.FORK_RPC_URL ?? '';
if (!archiveUrl) throw new Error('Set FORK_RPC_URL to an archive-capable BSC RPC endpoint');
const discoveryUrl = process.env.DISCOVERY_RPC_URL ?? archiveUrl;
const scaleCount = Number(process.env.FORK_SCALE_COUNT ?? 24);
const discovery = createPublicClient({ transport: http(discoveryUrl, { timeout: 30_000, retryCount: 3, retryDelay: 1500 }) });
const archive = createPublicClient({ transport: http(archiveUrl, { timeout: 30_000, retryCount: 5, retryDelay: 2000 }) });

interface Candidate { id: bigint; owner: Address; status: number; nand: number; latch: number; pending: bigint; cacheOk: boolean }

async function discover(blockNumber: bigint) {
  const ids = new Set<bigint>();
  while (ids.size < 1500) ids.add(BigInt(1 + Math.floor(Math.random() * 21_000)));
  const list = [...ids];
  const mc = <T>(contracts: unknown[]) => discovery.multicall({ multicallAddress: MULTICALL3, blockNumber, allowFailure: true, batchSize: 60_000, contracts } as never) as Promise<{ result?: T }[]>;
  const owners = await mc<Address>(list.map(id => ({ address: BSC_PROTOCOL.minerCollection, abi: erc721Abi, functionName: 'ownerOf', args: [id] })));
  const keys = await mc<Hex>(list.map(id => ({ address: BSC_PROTOCOL.mining, abi: miningAbi, functionName: 'minerKey', args: [BSC_PROTOCOL.minerCollection, id] })));
  const records = await mc<{ status: number; nandBurn: number; latchBurn: number }>(keys.map(k => ({ address: BSC_PROTOCOL.mining, abi: miningAbi, functionName: 'getMiner', args: [k.result] })));
  const caches = await mc<readonly [boolean, number, number]>(list.map(id => ({ address: BSC_PROTOCOL.mining, abi: miningAbi, functionName: 'cachedBurn', args: [BSC_PROTOCOL.minerCollection, id] })));
  const pendings = await mc<bigint>(keys.map(k => ({ address: BSC_PROTOCOL.mining, abi: miningAbi, functionName: 'pending', args: [k.result] })));
  const all: Candidate[] = [];
  list.forEach((id, i) => {
    const r = records[i].result, c = caches[i].result, owner = owners[i].result;
    if (!r || !owner) return;
    all.push({ id, owner, status: Number(r.status), nand: Number(r.nandBurn), latch: Number(r.latchBurn), pending: pendings[i].result ?? 0n,
      cacheOk: !!c && c[0] && Number(c[1]) === Number(r.nandBurn) && Number(c[2]) === Number(r.latchBurn) });
  });
  const isEoa = async (a: Address) => { const code = await discovery.getCode({ address: a, blockNumber }); return !code || code === '0x'; };
  const usedOwners = new Set<string>();
  const pick = async (filter: (c: Candidate) => boolean) => {
    for (const c of all.filter(filter).sort((a, b) => (b.pending > a.pending ? 1 : -1))) {
      if (usedOwners.has(c.owner.toLowerCase()) || !(await isEoa(c.owner))) continue;
      usedOwners.add(c.owner.toLowerCase());
      return c;
    }
    throw new Error('Discovery found no suitable miner; rerun');
  };
  const activeOk = (c: Candidate) => c.status === 1 && c.cacheOk && c.pending > 0n;
  const nandMiner = await pick(c => activeOk(c) && c.latch === 0 && c.nand > 0);
  const latchMiner = await pick(c => activeOk(c) && c.latch > c.nand);
  const inactive = all.find(c => c.status !== 1);
  if (!inactive) throw new Error('Discovery found no inactive token; rerun');
  const scale: Candidate[] = [];
  for (const c of all.filter(c => activeOk(c) && c.id !== nandMiner.id && c.id !== latchMiner.id)) {
    if (scale.length >= scaleCount) break;
    if (usedOwners.has(c.owner.toLowerCase()) || !(await isEoa(c.owner))) continue;
    usedOwners.add(c.owner.toLowerCase());
    scale.push(c);
  }
  const statuses: Record<string, number> = {};
  for (const c of all) statuses[c.status] = (statuses[c.status] ?? 0) + 1;
  return { sampled: list.length, statuses, activeWithLatch: all.filter(c => c.status === 1 && c.latch > 0).length,
    recordCacheMismatches: all.filter(c => c.status === 1 && !c.cacheOk).length, nandMiner, latchMiner, inactive, scale };
}

async function main() {
  await mkdir('reports', { recursive: true });
  const startedAt = new Date().toISOString();
  const head = await discovery.getBlockNumber();
  const forkBlock = process.env.FORK_BLOCK ? BigInt(process.env.FORK_BLOCK) : head - 20n;
  const block = await archive.getBlock({ blockNumber: forkBlock });
  let env: Record<string, string>;
  let found: Awaited<ReturnType<typeof discover>> | undefined;
  if (process.env.FORK_NAND_MINER && process.env.FORK_LATCH_MINER && process.env.FORK_INACTIVE_TOKEN && process.env.FORK_SCALE_MINERS) {
    env = { FORK_NAND_MINER: process.env.FORK_NAND_MINER, FORK_LATCH_MINER: process.env.FORK_LATCH_MINER, FORK_INACTIVE_TOKEN: process.env.FORK_INACTIVE_TOKEN, FORK_SCALE_MINERS: process.env.FORK_SCALE_MINERS };
  } else {
    found = await discover(forkBlock);
    env = { FORK_NAND_MINER: String(found.nandMiner.id), FORK_LATCH_MINER: String(found.latchMiner.id), FORK_INACTIVE_TOKEN: String(found.inactive.id), FORK_SCALE_MINERS: found.scale.map(c => String(c.id)).join(',') };
  }
  console.error(json({ phase: 'DISCOVERED', forkBlock, blockHash: block.hash, ...env }));
  const build = spawnSync('forge', ['build'], { encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`forge build failed: ${build.stderr.slice(-2000)}`);
  const args = ['test', '--match-path', 'test/fork/*', '-vv', '--json', '--fork-url', archiveUrl, '--fork-block-number', String(forkBlock),
    '--fork-retries', '30', '--fork-retry-backoff', '3000', '--compute-units-per-second', String(process.env.FORK_CUPS ?? 40)];
  const observationFiles = {
    identity: 'reports/fork-identity.json', composition: 'reports/fork-composition.json', boundary: 'reports/fork-boundary.json',
    boundaryMulti: 'reports/fork-boundary-multi.json', boundaryOrder: 'reports/fork-boundary-order.json', registerWindow: 'reports/fork-register-window.json',
    lifecycle: 'reports/fork-lifecycle.json', lifecycleHolderOnly: 'reports/fork-lifecycle-holder.json', gas: 'reports/fork-gas.json',
  };
  for (const f of Object.values(observationFiles)) await writeFile(f, '{}\n');
  const run = spawnSync('forge', args, { env: { ...process.env, ...env, FORK_RPC_URL: archiveUrl, FORK_BLOCK: String(forkBlock), FOUNDRY_PROFILE: 'fork' }, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 7_200_000 });
  let forge: unknown;
  try { forge = JSON.parse(run.stdout); } catch { forge = {}; }
  const results = Object.values(forge as Record<string, { test_results?: Record<string, { status: string; reason?: string | null }> }>)
    .flatMap(suite => Object.entries(suite.test_results ?? {}).map(([name, r]) => ({ name, status: r.status, reason: r.reason ?? null })));
  const readJson = async (file: string) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };
  const bytecode = JSON.parse(await readFile('sdk/bytecode.json', 'utf8'));
  // Every fork test must have run and passed: PoolForkTest (5), PoolBoundaryForkTest (4), MiningLifecycleForkTest (2).
  const passed = run.status === 0 && results.length === 11 && results.every(r => r.status === 'Success');
  const report = {
    scope: 'REAL_BSC_STATE_LOCAL_FORK_ONLY', status: passed ? 'PASS' : 'FAIL', startedAt, completedAt: new Date().toISOString(),
    source: { chainId: 56, forkBlock, blockHash: block.hash, blockTimestamp: block.timestamp, archiveRpcHost: new URL(archiveUrl).host, discoveryRpcHost: new URL(discoveryUrl).host },
    protocol: BSC_PROTOCOL, inputs: env,
    discovery: found ? { sampled: found.sampled, statuses: found.statuses, activeWithLatch: found.activeWithLatch, recordCacheMismatches: found.recordCacheMismatches,
      nandMiner: found.nandMiner, latchMiner: found.latchMiner, inactive: found.inactive, scaleMiners: found.scale.length } : 'overrides provided',
    deployedArtifacts: { compiled: 'paris (./out)', forkEvm: 'cancun', sdkBytecodeSha256: Object.fromEntries(Object.entries(bytecode).map(([k, v]) => [k, (v as { sha256: string }).sha256])) },
    forgeCommand: `forge ${args.join(' ')}`, forgeExitCode: run.status, results,
    observations: Object.fromEntries(await Promise.all(Object.entries(observationFiles).map(async ([k, f]) => [k, await readJson(f)] as const))),
    method: [
      'Fork state is read from BSC at the pinned block; no protocol code or storage is modified (no vm.etch / vm.store / mockCall / deal).',
      'Miner NFTs are moved from their current holders with fork-only impersonation (vm.prank), then admitted through depositMiners / registerMiners.',
      'Time is advanced inside the fork only (vm.warp / vm.roll) so real Mining accrues income between admissions.',
      'Expected settlement amounts are observed independently: what a real Mining.claim pays at the same timestamp, measured on a snapshot and undone (vm.snapshotState / vm.revertToState).',
      'Lifecycle experiments impersonate the current NFT holder to call Mining.stop; BEM donations are real claims forwarded by an impersonated holder.',
      'Gas is measured with protocol and pool accounts cooled (vm.cool), approximating stand-alone transactions; the 21,000 base cost is excluded.',
    ],
    mainnetTransactionsSent: 0, signaturesCreated: 0,
    ...(passed ? {} : { stderrTail: run.stderr.slice(-8000), stdoutTail: run.stdout.slice(-8000) }),
  };
  await writeFile('reports/fork-test.json', json(report) + '\n');
  console.log(json({ status: report.status, forkBlock, results, report: 'reports/fork-test.json' }));
  if (!passed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
