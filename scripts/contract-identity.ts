#!/usr/bin/env node
/**
 * Identity of the existing Solidity implementations: every source under src/, and for each production
 * and canary contract its ABI, creation bytecode and runtime template (the compiled runtime with
 * immutable slots unfilled) from a `forge build` with the repository's pinned settings. Test fixtures
 * are not part of it.
 *   node --import tsx scripts/contract-identity.ts --out FILE          (after `forge build`)
 *   node --import tsx scripts/contract-identity.ts --compare BEFORE AFTER
 * A runtime template hash is not a deployed code hash: pool and distributor have immutables that each
 * deployment fills (see sdk/deployment.ts for deployed-identity checks).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { keccak256, type Hex } from 'viem';

const CONTRACTS = [
  { file: 'TapeoutEntitlementReceipt.sol', name: 'TapeoutEntitlementReceipt', scope: 'production' },
  { file: 'TapeoutReceiptDistributor.sol', name: 'TapeoutReceiptDistributor', scope: 'production' },
  { file: 'TapeoutMinerPool.sol', name: 'TapeoutMinerPool', scope: 'production' },
  { file: 'PoolMath.sol', name: 'PoolMath', scope: 'production' },
  { file: 'IMining.sol', name: 'IMining', scope: 'production' },
  { file: 'IReceiptDistributor.sol', name: 'IReceiptDistributor', scope: 'production' },
  { file: 'RecoverableTapeoutMinerPool.sol', name: 'RecoverableTapeoutMinerPool', scope: 'canary' },
  { file: 'CanaryParticipant.sol', name: 'CanaryParticipant', scope: 'canary' },
] as const;

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
/** Canonical JSON: object keys sorted, so the hash does not depend on key order. */
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  : JSON.stringify(v);

async function identity() {
  const sources = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort();
  const sourceHashes: Record<string, string> = {};
  for (const f of sources) sourceHashes[f] = sha256(await readFile(f));
  const contracts: Record<string, unknown> = {};
  for (const c of CONTRACTS) {
    const a = JSON.parse(await readFile(`out/${c.file}/${c.name}.json`, 'utf8'));
    const creation = a.bytecode.object as Hex;
    const runtime = a.deployedBytecode.object as Hex;
    const immutables = Object.values(a.deployedBytecode.immutableReferences ?? {}).reduce((s: number, r) => s + (r as unknown[]).length, 0);
    const settings = a.metadata?.settings ?? {};
    contracts[c.name] = {
      scope: c.scope, source: `src/${c.scope === 'canary' ? 'canary/' : c.file === 'IMining.sol' || c.file === 'IReceiptDistributor.sol' ? 'interfaces/' : ''}${c.file}`,
      abiSha256: sha256(canonical(a.abi)), creationKeccak256: creation === '0x' ? null : keccak256(creation),
      runtimeTemplateKeccak256: runtime === '0x' ? null : keccak256(runtime), creationBytes: (creation.length - 2) / 2, runtimeBytes: (runtime.length - 2) / 2,
      immutableReferences: immutables,
      compiler: { solc: a.metadata?.compiler?.version, evmVersion: settings.evmVersion, viaIR: settings.viaIR, optimizer: settings.optimizer },
    };
  }
  const forge = spawnSync('forge', ['--version'], { encoding: 'utf8' }).stdout.trim().split('\n')[0];
  return {
    schema: 'tapeout-contract-identity/1', head: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    toolchain: { forge, foundryTomlSha256: sha256(await readFile('foundry.toml')), packageLockSha256: sha256(await readFile('package-lock.json')) },
    sources: sourceHashes, sourcesSha256: sha256(canonical(sourceHashes)), contracts,
    note: 'runtimeTemplateKeccak256 is the compiled runtime with immutable slots unfilled; deployed pool and distributor code differs by their constructor-filled immutables',
  };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n: string) => args[args.indexOf(n) + 1];
  if (args.includes('--compare')) {
    const [before, after] = [flag('--compare'), args[args.indexOf('--compare') + 2]];
    const a = JSON.parse(await readFile(before, 'utf8')), b = JSON.parse(await readFile(after, 'utf8'));
    const diffs: string[] = [];
    for (const k of new Set([...Object.keys(a.sources), ...Object.keys(b.sources)])) if (a.sources[k] !== b.sources[k]) diffs.push(`source ${k}`);
    for (const k of new Set([...Object.keys(a.contracts), ...Object.keys(b.contracts)])) {
      if (canonical(a.contracts[k]) !== canonical(b.contracts[k])) diffs.push(`contract ${k}`);
    }
    for (const k of ['forge', 'foundryTomlSha256', 'packageLockSha256']) if (a.toolchain[k] !== b.toolchain[k]) diffs.push(`toolchain ${k}`);
    const result = { status: diffs.length ? 'DIFFERENT' : 'IDENTICAL', before: { file: before, head: a.head }, after: { file: after, head: b.head }, differences: diffs, contracts: Object.keys(b.contracts).length, sources: Object.keys(b.sources).length };
    console.log(JSON.stringify(result, null, 2));
    if (diffs.length) process.exitCode = 1;
    return;
  }
  if (!args.includes('--out')) throw new Error('Usage: contract-identity --out FILE | --compare BEFORE AFTER');
  const out = flag('--out');
  const result = await identity();
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ out, head: result.head, sources: Object.keys(result.sources).length, sourcesSha256: result.sourcesSha256 }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
