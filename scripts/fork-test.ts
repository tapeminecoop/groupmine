#!/usr/bin/env node
/**
 * Real BSC protocol fork test.
 *  1. Pins a recent BSC block and discovers miners held by EOAs with positive pending income
 *     (read-only eth_call / multicall; nothing is signed or sent to BSC).
 *  2. Runs test/fork/PoolFork.t.sol against that block through an archive-capable RPC.
 *  3. Writes reports/fork-test.json (inputs, discovery, forge results, observations).
 *
 * Env: FORK_RPC_URL (archive RPC), DISCOVERY_RPC_URL (recent-state RPC, defaults to FORK_RPC_URL),
 *      FORK_BLOCK / FORK_MINER_IDS (optional overrides), FORK_MINER_COUNT (default 3).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { BSC_PROTOCOL, erc721Abi, miningAbi } from '../sdk/constants.ts';
import { json } from '../cli/pool.ts';

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const archiveUrl: string = process.env.FORK_RPC_URL ?? '';
if (!archiveUrl) throw new Error('Set FORK_RPC_URL to an archive-capable BSC RPC endpoint');
const discoveryUrl = process.env.DISCOVERY_RPC_URL ?? archiveUrl;
const wanted = Number(process.env.FORK_MINER_COUNT ?? 3);

const discovery = createPublicClient({ transport: http(discoveryUrl, { timeout: 30_000, retryCount: 3, retryDelay: 1500 }) });
const archive = createPublicClient({ transport: http(archiveUrl, { timeout: 30_000, retryCount: 5, retryDelay: 2000 }) });

async function discover(blockNumber: bigint) {
  // Random sample of token IDs; the collection has ~2e4 miners.
  const sample = new Set<bigint>();
  while (sample.size < 600) sample.add(BigInt(1 + Math.floor(Math.random() * 21_000)));
  const ids = [...sample];
  const owners = await discovery.multicall({ multicallAddress: MULTICALL3, blockNumber, allowFailure: true,
    contracts: ids.map(id => ({ address: BSC_PROTOCOL.minerCollection, abi: erc721Abi, functionName: 'ownerOf', args: [id] } as const)) });
  const keys = await discovery.multicall({ multicallAddress: MULTICALL3, blockNumber, allowFailure: true,
    contracts: ids.map(id => ({ address: BSC_PROTOCOL.mining, abi: miningAbi, functionName: 'minerKey', args: [BSC_PROTOCOL.minerCollection, id] } as const)) });
  const pending = await discovery.multicall({ multicallAddress: MULTICALL3, blockNumber, allowFailure: true,
    contracts: keys.map(k => ({ address: BSC_PROTOCOL.mining, abi: miningAbi, functionName: 'pending', args: [(k.result ?? '0x' + '0'.repeat(64)) as Hex] } as const)) });
  const rows = ids.map((id, i) => ({ id, owner: owners[i].result as Address | undefined, pending: pending[i].result as bigint | undefined }))
    .filter(r => r.owner && r.pending !== undefined && r.pending > 0n)
    .sort((a, b) => (b.pending! > a.pending! ? 1 : -1));
  const chosen: typeof rows = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (chosen.length >= wanted) break;
    if (seen.has(r.owner!.toLowerCase())) continue;
    const code = await discovery.getCode({ address: r.owner!, blockNumber });
    if (code && code !== '0x') continue; // contract holders (vaults, Safes) are not impersonated
    seen.add(r.owner!.toLowerCase());
    chosen.push(r);
  }
  return { sampled: ids.length, existingWithPositivePending: rows.length, chosen };
}

async function main() {
  await mkdir('reports', { recursive: true });
  const startedAt = new Date().toISOString();
  const head = await discovery.getBlockNumber();
  const forkBlock = process.env.FORK_BLOCK ? BigInt(process.env.FORK_BLOCK) : head - 20n;
  const block = await archive.getBlock({ blockNumber: forkBlock });
  let minerIds = process.env.FORK_MINER_IDS?.split(',').map(x => BigInt(x));
  let discovered: Awaited<ReturnType<typeof discover>> | undefined;
  if (!minerIds) {
    discovered = await discover(forkBlock);
    if (discovered.chosen.length < 2) throw new Error('Discovery found fewer than two EOA-held miners with positive pending; rerun');
    minerIds = discovered.chosen.map(r => r.id);
  }
  console.error(json({ phase: 'DISCOVERED', forkBlock, blockHash: block.hash, minerIds }));

  const env = { ...process.env, FORK_RPC_URL: archiveUrl, FORK_BLOCK: String(forkBlock), FORK_MINER_IDS: minerIds.join(',') };
  const args = ['test', '--match-path', 'test/fork/PoolFork.t.sol', '-vv', '--json', '--fork-url', archiveUrl, '--fork-block-number', String(forkBlock),
    '--fork-retries', '30', '--fork-retry-backoff', '3000', '--compute-units-per-second', String(process.env.FORK_CUPS ?? 40)];
  // Build the deployment artifact (default profile, Paris) first; the fork profile deploys it as-is.
  const build = spawnSync('forge', ['build'], { encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`forge build failed: ${build.stderr.slice(-2000)}`);
  const run = spawnSync('forge', args, { env: { ...env, FOUNDRY_PROFILE: 'fork' }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 3_600_000 });
  let forge: unknown;
  try { forge = JSON.parse(run.stdout); } catch { forge = { unparsedStdout: run.stdout.slice(-20_000) }; }
  const results = Object.values((forge ?? {}) as Record<string, { test_results?: Record<string, { status: string; reason?: string | null; decoded_logs?: string[] }> }>)
    .flatMap(suite => Object.entries(suite.test_results ?? {}).map(([name, r]) => ({ name, status: r.status, reason: r.reason ?? null })));
  const readJson = async (file: string) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };
  const lifecycle = await readJson('reports/fork-lifecycle.json');
  const bytecode = JSON.parse(await readFile('sdk/bytecode.json', 'utf8'));
  const artifactMatchesSdk = lifecycle?.deployedArtifactSha256 === `0x${bytecode.TapeoutMinerPool.sha256}`;
  const passed = run.status === 0 && results.length > 0 && results.every(r => r.status === 'Success') && artifactMatchesSdk;
  const report = {
    scope: 'REAL_BSC_STATE_LOCAL_FORK_ONLY',
    status: passed ? 'PASS' : 'FAIL',
    startedAt,
    completedAt: new Date().toISOString(),
    source: { chainId: 56, forkBlock, blockHash: block.hash, blockTimestamp: block.timestamp, archiveRpcHost: new URL(archiveUrl).host, discoveryRpcHost: new URL(discoveryUrl).host },
    protocol: BSC_PROTOCOL,
    minerIds,
    discovery: discovered ? { sampled: discovered.sampled, existingWithPositivePending: discovered.existingWithPositivePending, chosen: discovered.chosen } : 'FORK_MINER_IDS provided',
    forgeCommand: `forge ${args.join(' ')}`,
    forgeExitCode: run.status,
    results,
    deployedArtifact: { sha256: lifecycle?.deployedArtifactSha256 ?? null, matchesSdkBytecodeJson: artifactMatchesSdk, evmVersionCompiled: 'paris', forkEvmVersion: 'cancun' },
    observations: { identity: await readJson('reports/fork-identity.json'), lifecycle },
    method: [
      'Fork state is read from BSC at the pinned block; no protocol code or storage is modified (no vm.etch / vm.store / mockCall).',
      'Miner NFTs are moved from their current EOA holders with fork-only impersonation (vm.prank), then deposited through depositMiners.',
      'Time is advanced inside the fork only (vm.warp/vm.roll) to let real Mining accrue income.',
    ],
    mainnetTransactionsSent: 0,
    signaturesCreated: 0,
    ...(passed ? {} : { stderrTail: run.stderr.slice(-8000) }),
  };
  await writeFile('reports/fork-test.json', json(report) + '\n');
  console.log(json({ status: report.status, forkBlock, minerIds, results, report: 'reports/fork-test.json' }));
  if (!passed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
