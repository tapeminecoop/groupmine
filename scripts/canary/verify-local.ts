#!/usr/bin/env node
/** Reproducible local-only evidence; does not read .env or contact a chain. */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { artifact, fingerprint, save } from './common.ts';
import { keccak256 } from 'viem';

const dir = 'reports/canary/local';
mkdirSync(dir, { recursive: true });
const sdk = execFileSync('rg', ['--files', 'test/sdk'], { encoding: 'utf8' }).trim().split('\n').filter(p => p.endsWith('.test.ts'));
const commands: [string, string, string[]][] = [
  ['source-adaptation', process.execPath, ['scripts/canary/build-source.mjs', '--check']],
  ['format', 'forge', ['fmt', '--check']],
  ['solidity', 'forge', ['test', '--offline', '--no-match-path', 'test/fork/*']],
  ['sdk', process.execPath, ['--import', 'tsx', '--test', ...sdk]],
  ['typecheck', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']],
];
const results = [];
for (const [name, command, args] of commands) {
  console.log(`Local verification: ${name}`);
  const start = Date.now();
  const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 20_000_000 });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  writeFileSync(`${dir}/${name}.txt`, output);
  results.push({ name, command: [command, ...args], durationMs: Date.now() - start, exitCode: r.status, status: r.status === 0 ? 'PASS' : 'FAIL', log: `${dir}/${name}.txt`, soliditySummary: name === 'solidity' ? output.match(/\d+ tests passed, \d+ failed, \d+ skipped/)?.[0] : undefined, sdkSummary: name === 'sdk' ? output.match(/# tests \d+[\s\S]*# duration_ms [\d.]+/)?.[0] : undefined });
  if (r.status !== 0) break;
}
const builds = Object.fromEntries((['nand', 'latch', 'helper', 'pool', 'distributor'] as const).map(name => {
  const a = artifact(name);
  return [name, { creationCodeHash: keccak256(a.bytecode.object), runtimeTemplateHash: keccak256(a.deployedBytecode.object), creationBytes: (a.bytecode.object.length - 2) / 2, runtimeBytes: (a.deployedBytecode.object.length - 2) / 2, immutables: a.deployedBytecode.immutableReferences }];
}));
const pass = results.length === commands.length && results.every(x => x.status === 'PASS');
const source = fingerprint();
const candidate = existsSync('reports/canary/candidate.json') ? JSON.parse(readFileSync('reports/canary/candidate.json', 'utf8')) : null;
save('reports/canary/local-verification.json', { scope: 'LOCAL_MOCKS_AND_STATIC_CHECKS_ONLY', completedAt: new Date().toISOString(), status: pass ? 'PASS' : 'FAIL', source, results, builds, freshBscFork: candidate?.digest === source.digest ? 'PASS_SEE_SEPARATE_FORK_EVIDENCE' : 'NOT_REHEARSED_CURRENT_CANDIDATE', mainnet: 'NOT_RUN_REQUIRES_APPROVAL', mainnetTransactions: 0 });
console.log(`Local verification ${pass ? 'PASS' : 'FAIL'}; fork and mainnet are separate, unverified scopes.`);
if (!pass) process.exitCode = 1;
