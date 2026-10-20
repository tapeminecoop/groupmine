#!/usr/bin/env node
/**
 * Runs the complete validation in order and writes reports/run-manifest.json: the tested source revision
 * and a fingerprint of any uncommitted changes, tool versions and compiler settings, hashes of the tested
 * build's artifacts, and for every step its command, timestamps, exit code, a result summary and a log
 * (reports/logs/<step>.log, local paths removed).
 *   FORK_RPC_URL=<archive rpc> [SLITHER=<path to slither>] node --import tsx scripts/verify-all.ts
 * Steps whose prerequisites are missing (FORK_RPC_URL, SLITHER) are recorded as SKIPPED. Every
 * transaction runs on a local Anvil chain or a local fork; nothing is sent to a public chain.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, platform, release } from 'node:os';
import { keccak256, type Hex } from 'viem';

const root = process.cwd();
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const slitherBin = process.env.SLITHER;
const slitherHome = slitherBin ? slitherBin.replace(/\/bin\/slither$/, '') : undefined;
/** Remove local paths (the checkout, the home directory, the slither installation) from logged text. */
const clean = (s: string) => {
  let out = s;
  if (slitherBin) out = out.split(slitherBin).join('$SLITHER');
  if (slitherHome) out = out.split(slitherHome).join('$SLITHER_HOME');
  return out.split(root).join('.').split(homedir()).join('~');
};
const tail = (s: string, n = 120_000) => (s.length > n ? `[… ${s.length - n} earlier characters omitted …]\n${s.slice(-n)}` : s);
// Pinned real-protocol inputs (verified miners at this block); override through the environment.
const FORK_ENV = {
  FORK_BLOCK: process.env.FORK_BLOCK ?? '128713128', FORK_NAND_MINER: process.env.FORK_NAND_MINER ?? '12733',
  FORK_LATCH_MINER: process.env.FORK_LATCH_MINER ?? '13948', FORK_INACTIVE_TOKEN: process.env.FORK_INACTIVE_TOKEN ?? '648',
  FORK_SCALE_MINERS: process.env.FORK_SCALE_MINERS ?? '4183,1574,6940,4307,4655,3207,13617,7924,11127,4951,3932,10031,14559,16112,8714,2161,6767,11214,6453,14011,16944,15731,7541,5930',
};

function run(command: string, args: string[], env: Record<string, string> = {}) {
  const started = new Date();
  const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, env: { ...process.env, ...env } });
  return { started, finished: new Date(), status: r.status ?? -1, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? String(r.error) : '') };
}

type Step = { name: string; command: string; startedAt?: string; finishedAt?: string; durationSeconds?: number; exitCode?: number; status: 'PASS' | 'FAIL' | 'SKIPPED'; summary?: unknown; log?: string; reason?: string };
const steps: Step[] = [];

async function step(name: string, command: string, args: string[], summarize: (out: ReturnType<typeof run>) => Promise<{ ok: boolean; summary: unknown }>, env: Record<string, string> = {}) {
  console.error(`▶ ${name}`);
  const out = run(command, args, env);
  const log = `reports/logs/${name}.log`;
  await writeFile(log, clean(`$ ${[command, ...args].join(' ')}\n# exit ${out.status}\n\n## stdout\n${tail(out.stdout)}\n\n## stderr\n${tail(out.stderr)}\n`));
  let verdict: { ok: boolean; summary: unknown };
  try { verdict = await summarize(out); } catch (e) { verdict = { ok: false, summary: `summary failed: ${String(e)}` }; }
  const s: Step = {
    name, command: clean([command, ...args].join(' ')), startedAt: out.started.toISOString(), finishedAt: out.finished.toISOString(),
    durationSeconds: Math.round((out.finished.getTime() - out.started.getTime()) / 100) / 10, exitCode: out.status,
    status: out.status === 0 && verdict.ok ? 'PASS' : 'FAIL', summary: verdict.summary, log,
  };
  steps.push(s);
  console.error(`  ${s.status} (${s.durationSeconds}s)`);
  return s;
}

const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8'));

async function artifactHashes() {
  const out: Record<string, unknown> = {};
  for (const name of ['TapeoutEntitlementReceipt', 'TapeoutReceiptDistributor', 'TapeoutMinerPool']) {
    const a = await readJson(`out/${name}.sol/${name}.json`);
    const creation = a.bytecode.object as Hex;
    const runtime = a.deployedBytecode.object as Hex;
    out[name] = {
      creationSha256: sha256(Buffer.from(creation.slice(2), 'hex')), creationKeccak256: keccak256(creation),
      runtimeCodeHash: keccak256(runtime), runtimeBytes: (runtime.length - 2) / 2, initcodeBytes: (creation.length - 2) / 2,
    };
  }
  return out;
}

/** sha256 over "path sha256(content)" lines of every tracked or untracked (not ignored) file except
 *  reports/, docs/ and Markdown: identifies the tested code and configuration, and can be recomputed
 *  from the commit that contains it. */
async function sourceFingerprint() {
  const files = run('git', ['ls-files', '--cached', '--others', '--exclude-standard']).stdout.split('\n')
    .filter(f => f && !f.startsWith('reports/') && !f.startsWith('docs/') && !f.endsWith('.md')).sort();
  const lines: string[] = [];
  for (const f of [...new Set(files)]) {
    try { lines.push(`${f} ${sha256(await readFile(f))}`); } catch { /* tracked but deleted in the working tree */ }
  }
  return { files: lines.length, sha256: sha256(lines.join('\n')) };
}

async function main() {
  if (process.argv.includes('--fingerprint')) {
    console.log(json(await sourceFingerprint()));
    return;
  }
  await mkdir('reports/logs', { recursive: true });
  await mkdir('.runtime', { recursive: true });
  const startedAt = new Date().toISOString();

  // Source revision, uncommitted changes outside reports/, and the source-tree fingerprint.
  const head = run('git', ['rev-parse', 'HEAD']).stdout.trim();
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const porcelain = run('git', ['status', '--porcelain', '--untracked-files=all']).stdout;
  const changed = porcelain.split('\n').filter(Boolean).filter(l => !l.slice(3).startsWith('reports/'));
  const fingerprint = await sourceFingerprint();

  const forgeVersion = run('forge', ['--version']).stdout.trim().split('\n')[0];
  const config = JSON.parse(run('forge', ['config', '--json']).stdout);
  const pkg = await readJson('package.json');
  const tools = {
    forge: forgeVersion, solc: config.solc ?? config.solc_version, evmVersion: config.evm_version, viaIR: config.via_ir,
    optimizer: config.optimizer, optimizerRuns: config.optimizer_runs, node: process.version, os: `${platform()} ${release()}`,
    npm: { viem: pkg.dependencies.viem, zod: pkg.dependencies.zod, openzeppelin: pkg.dependencies['@openzeppelin/contracts'], typescript: pkg.devDependencies.typescript, tsx: pkg.devDependencies.tsx },
    slither: process.env.SLITHER ? run(process.env.SLITHER, ['--version']).stdout.trim() : 'not provided',
  };

  await step('build-sizes', 'forge', ['build', '--sizes'], async o => {
    const sizes: Record<string, string> = {};
    for (const line of o.stdout.split('\n')) {
      const m = /\|\s*(TapeoutMinerPool|TapeoutEntitlementReceipt|TapeoutReceiptDistributor)\s*\|\s*([\d,]+)\s*\|\s*([\d,]+)\s*\|\s*(-?[\d,]+)\s*\|\s*(-?[\d,]+)/.exec(line);
      if (m) sizes[m[1]] = `runtime ${m[2]} B (margin ${m[4]}), initcode ${m[3]} B (margin ${m[5]})`;
    }
    return { ok: Object.keys(sizes).length === 3, summary: sizes };
  });
  const artifacts = await artifactHashes();
  // The SDK, CLI and end-to-end runs deploy sdk/bytecode.json. Exporting from this build must leave the
  // checked-in SDK files unchanged; a change means they were stale before this run.
  const sdkFiles = ['sdk/abi.ts', 'sdk/bytecode.json'];
  const hashSdk = async () => Object.fromEntries(await Promise.all(sdkFiles.map(async f => [f, sha256(await readFile(f))] as const)));
  const sdkBefore = await hashSdk();
  await step('export-abi', 'node', ['scripts/export-abi.mjs'], async () => {
    const sdkAfter = await hashSdk();
    const unchanged = Object.fromEntries(sdkFiles.map(f => [f, sdkBefore[f] === sdkAfter[f]]));
    const sdk = await readJson('sdk/bytecode.json');
    const same: Record<string, boolean> = {};
    for (const name of ['TapeoutEntitlementReceipt', 'TapeoutReceiptDistributor', 'TapeoutMinerPool']) {
      same[name] = sdk[name].bytecode === (await readJson(`out/${name}.sol/${name}.json`)).bytecode.object;
    }
    return { ok: Object.values(unchanged).every(Boolean) && Object.values(same).every(Boolean), summary: { sdkFilesUnchangedByExport: unchanged, sdkBytecodeMatchesBuild: same } };
  });
  await step('format-check', 'forge', ['fmt', '--check'], async o => ({ ok: o.status === 0, summary: o.status === 0 ? 'formatted' : 'unformatted files' }));

  await rm('reports/invariant-coverage.csv', { force: true });
  await step('solidity-tests', 'forge', ['test', '--no-match-path', 'test/fork/*', '--json'], async o => {
    await writeFile('.runtime/forge-tests.json', o.stdout);
    const s = run('node', ['scripts/summarize-forge.mjs', '.runtime/forge-tests.json', 'reports/invariant-coverage.csv']);
    await rm('reports/invariant-coverage.csv', { force: true });
    const r = await readJson('reports/solidity-tests.json');
    return { ok: s.status === 0 && r.total === r.passed && r.total > 0, summary: { total: r.total, passed: r.passed, invariantAdmissionPaths: r.invariantAdmissionPaths } };
  }, { INVARIANT_COVERAGE_LOG: 'reports/invariant-coverage.csv' });

  // The same gas-model tests again, verbose, so the log keeps gas used next to each planned limit.
  await step('gas-model', 'forge', ['test', '--match-path', 'test/unit/GasModel.t.sol', '-vv'], async o => {
    const lines = o.stdout.split('\n').filter(l => /^\s{2,}\S/.test(l) && /\d/.test(l) && !/^\s*\[/.test(l)).map(l => l.trim());
    const passed = (o.stdout.match(/\[PASS\]/g) ?? []).length;
    return { ok: /Suite result: ok/.test(o.stdout), summary: { passed, gasUsedAndLimits: lines } };
  });

  const sdkTests = (await readdir('test/sdk')).filter(f => f.endsWith('.test.ts')).map(f => `test/sdk/${f}`);
  await step('sdk-tests', 'node', ['--import', 'tsx', '--test', '--test-reporter=tap', ...sdkTests], async o => {
    await writeFile('reports/sdk-tests.tap', o.stdout);
    const num = (k: string) => Number(new RegExp(`^# ${k} (\\d+)$`, 'm').exec(o.stdout)?.[1] ?? -1);
    return { ok: num('fail') === 0 && num('tests') > 0, summary: { tests: num('tests'), pass: num('pass'), fail: num('fail') } };
  });
  await step('typecheck', 'npx', ['tsc', '--noEmit'], async o => {
    await writeFile('reports/typecheck.txt', o.stdout + o.stderr);
    return { ok: o.status === 0, summary: o.status === 0 ? 'no errors' : 'errors (see log)' };
  });
  await step('local-e2e', 'node', ['--import', 'tsx', 'scripts/local-e2e.ts'], async () => {
    const r = await readJson('reports/local-e2e.json');
    const txs = r.steps.reduce((s: number, x: { transactions?: unknown[] }) => s + (x.transactions?.length ?? 0), 0);
    return { ok: r.status === 'PASS', summary: { status: r.status, checks: Object.keys(r.checks).length, failed: Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k), steps: r.steps.length, localTransactions: txs } };
  });

  if (process.env.FORK_RPC_URL) {
    await step('fork-tests', 'node', ['--import', 'tsx', 'scripts/fork-test.ts'], async () => {
      const r = await readJson('reports/fork-test.json');
      return { ok: r.status === 'PASS', summary: { status: r.status, forkBlock: r.source.forkBlock, blockHash: r.source.blockHash, results: r.results } };
    }, FORK_ENV);
    await step('fork-e2e', 'node', ['--import', 'tsx', 'scripts/fork-e2e.ts'], async () => {
      const r = await readJson('reports/fork-e2e.json');
      return { ok: r.status === 'PASS', summary: { status: r.status, checks: Object.keys(r.checks).length, failed: Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k), localForkTransactions: r.localForkTransactions } };
    });
    await step('fork-safe-e2e', 'node', ['--import', 'tsx', 'scripts/fork-safe-e2e.ts'], async () => {
      const r = await readJson('reports/fork-safe-e2e.json');
      return { ok: r.status === 'PASS', summary: { status: r.status, checks: Object.keys(r.checks).length, failed: Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k),
        safeTransactions: r.safeTransactions.length, localForkTransactions: r.localForkTransactions, gas: r.observations.gas } };
    });
  } else {
    for (const name of ['fork-tests', 'fork-e2e', 'fork-safe-e2e']) steps.push({ name, command: '-', status: 'SKIPPED', reason: 'FORK_RPC_URL not set' });
  }

  if (process.env.SLITHER) {
    // Slither never overwrites an existing JSON output: remove the previous run's files first.
    for (const f of ['.runtime/slither-raw.json', 'reports/slither.json', 'reports/slither.txt']) await rm(f, { force: true });
    // --fail-none: the exit code reports analysis errors only, not the number of findings.
    await step('slither', process.env.SLITHER, ['.', '--foundry-compile-all', '--filter-paths', 'node_modules|lib|test|script', '--exclude-informational', '--fail-none', '--json', '.runtime/slither-raw.json'], async o => {
      await writeFile('.runtime/slither.txt', o.stdout + o.stderr);
      const s = run('node', ['scripts/summarize-slither.mjs', '.runtime/slither-raw.json', '.runtime/slither.txt', tools.slither]);
      const r = await readJson('reports/slither.json');
      // The JSON must come from this analysis: its finding count equals the count Slither printed.
      const printed = Number(/(\d+) result\(s\) found/.exec(o.stdout + o.stderr)?.[1] ?? -1);
      return { ok: s.status === 0 && r.success === true && printed === r.results, summary: { results: r.results, printedResults: printed, byCheck: r.byCheck } };
    });
    // Slither runs `forge clean` and rebuilds; the tested artifacts must be byte-identical afterwards.
    const after = await artifactHashes();
    steps.push({ name: 'artifacts-stable-after-rebuild', command: 'compare artifact hashes before and after the rebuild', status: json(after) === json(artifacts) ? 'PASS' : 'FAIL' });
  } else {
    steps.push({ name: 'slither', command: '-', status: 'SKIPPED', reason: 'SLITHER not set' });
  }

  const manifest = {
    schema: 'tapeout-run-manifest/1', startedAt, finishedAt: new Date().toISOString(),
    scope: 'local Anvil chains and local BSC forks only; no public-chain transactions, no signatures',
    source: {
      baseCommit: head, branch, uncommittedChangesOutsideReports: changed.length, changedFiles: changed,
      sourceTreeSha256: fingerprint.sha256, sourceTreeFiles: fingerprint.files,
      note: 'sourceTreeSha256 hashes every non-ignored file except reports/, docs/ and *.md (path and sha256 per line); recompute with `node --import tsx scripts/verify-all.ts --fingerprint` on the commit that contains this run',
    },
    tools, artifacts, forkInputs: process.env.FORK_RPC_URL ? { rpcHost: new URL(process.env.FORK_RPC_URL).host, ...FORK_ENV } : 'not run',
    steps, overall: steps.every(s => s.status === 'PASS') ? 'PASS' : steps.some(s => s.status === 'FAIL') ? 'FAIL' : 'INCOMPLETE',
  };
  await writeFile('reports/run-manifest.json', json(manifest) + '\n');
  console.log(json({ overall: manifest.overall, steps: steps.map(s => `${s.status} ${s.name}`) }));
  if (manifest.overall !== 'PASS') process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
