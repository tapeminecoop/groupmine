#!/usr/bin/env node
/**
 * Local-fork rehearsal of the corrected canary workflow (structured expected-revert verification),
 * under a NEW run identity and as a separately fingerprinted LOCAL candidate.
 *
 * - Never loads .env, never reads a private key, never signs: the original wallet's PUBLIC address is
 *   passed explicitly and impersonated on a local Anvil fork; the RPC is used read-only as fork source.
 * - The approved-candidate guard (common.ts `fingerprint()`, pinned to c4bc022) is left as it is; this
 *   candidate is NOT approved for any mainnet use, and nothing is written under reports/canary/
 *   (candidate.json, proposals, approvals and historical runs stay untouched).
 * - Identity checks stay intact: build-source --check, deployed-code checks in the runner, protocol
 *   preflight at the fork block.
 *   node --import tsx scripts/canary/fork-local-candidate.ts --owner 0x… --fork-rpc URL --out DIR [--block N] [--run-id ID]
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createPublicClient, getAddress, http, parseEther, toHex } from 'viem';
import { startAnvil } from '../lib/anvil.ts';
import { artifacts, BASE, hash, json, redact, save, type ContractName } from './common.ts';
import { Runner, type Manifest } from './transactions.ts';
import { workflow } from './workflow.ts';

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

/** Same coverage as the approved-candidate fingerprint, without its pin to c4bc022, labelled LOCAL. */
function localCandidate() {
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'sdk', 'scripts/canary', 'test/unit/CanaryRecovery.t.sol', 'test/sdk/canary.test.ts', 'foundry.toml', 'package.json', 'package-lock.json', '.env.example', 'docs/CANARY_RUNBOOK.md'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
  const files = Object.fromEntries([...new Set(paths)].map(p => [p, hash(readFileSync(p))]));
  const build = Object.fromEntries(Object.keys(artifacts).map(k => [k, hash(readFileSync(`out/${artifacts[k as ContractName]}.sol/${artifacts[k as ContractName]}.json`))]));
  const data = { kind: 'LOCAL_CANDIDATE_NOT_APPROVED', approvedBaseRevision: BASE, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    files, build, settings: { solc: '0.8.24', evm: 'paris', viaIR: true, optimizerRuns: 200 } };
  return { ...data, digest: hash(json(data)) };
}

async function main() {
  if (process.env.OWNER_PRIVATE_KEY) throw Error('OWNER_PRIVATE_KEY is set in the environment: unset it; this rehearsal never uses a key');
  const ownerArg = flag('--owner'), forkRpc = flag('--fork-rpc'), out = flag('--out');
  if (!ownerArg || !forkRpc || !out) throw Error('Usage: fork-local-candidate --owner 0x… --fork-rpc URL --out DIR [--block N] [--run-id ID]');
  const owner = getAddress(ownerArg);
  const runId = flag('--run-id') ?? `local-candidate-${randomUUID()}`;
  const upstream = createPublicClient({ transport: http(forkRpc, { timeout: 30_000, retryCount: 2 }) });
  if (await upstream.getChainId() !== 56) throw Error('The fork source is not BSC (chain 56)');
  const block = flag('--block') ? await upstream.getBlock({ blockNumber: BigInt(flag('--block')!) }) : await upstream.getBlock({ blockTag: 'latest' });
  const forkGasPrice = await upstream.getGasPrice();
  execFileSync(process.execPath, ['scripts/canary/build-source.mjs', '--check'], { stdio: 'inherit' });
  const candidate = localCandidate();
  const work = `.runtime/canary-local/${runId}`;
  const record = {
    scope: 'LOCAL_BSC_FORK_ONLY', runIdentity: runId, candidate, forkSource: { block: block.number, blockHash: block.hash, rpcHost: new URL(forkRpc).host },
    owner, signing: 'NO_PRIVATE_KEY_LOADED_OR_USED', impersonation: 'LOCAL_ANVIL_ONLY', mainnetTransactions: 0, signaturesCreated: 0,
    note: 'Not the historical mainnet run (canary-588196bf…, PARTIAL_AUTOMATION_FAILED_RECOVERY_AND_ACCOUNTING_PASS), and not an approved candidate.',
    runs: [] as unknown[],
  };
  for (const interrupted of [false, true]) {
    const node = await startAnvil(interrupted ? 18576 : 18575, ['--fork-url', forkRpc, '--fork-block-number', String(block.number), '--chain-id', '56', '--gas-price', String(forkGasPrice),
      '--hardfork', 'cancun', '--compute-units-per-second', '40', '--retries', '30', '--timeout', '60000', '--silent'], 600_000);
    try {
      const rpc = createPublicClient({ transport: http(node.url, { timeout: 120_000 }) });
      if (!(await rpc.request({ method: 'web3_clientVersion' })).toLowerCase().includes('anvil')) throw Error('Local node is not Anvil');
      if ((await rpc.getBlock({ blockNumber: block.number! })).hash !== block.hash) throw Error('Fork source block mismatch');
      await rpc.request({ method: 'anvil_impersonateAccount', params: [owner] } as never);
      await rpc.request({ method: 'anvil_setBalance', params: [owner, toHex(parseEther('10'))] } as never);
      const m: Manifest = {
        schema: 'recoverable-canary-run/1', mode: 'fork', runId: `${runId}-${interrupted ? 'interrupted' : 'complete'}`, candidateDigest: candidate.digest, owner, contracts: {}, identities: {}, totalFeeRaw: '0',
        maxRunFee: String(parseEther('0.1')), maxTxFee: String(parseEther('0.02')), recoveryReserve: String(parseEther('0.01')),
        feePriceCeiling: String(forkGasPrice * 2n), forkGasPrice: String(forkGasPrice), minConfirmations: 1, maxWaitSeconds: 300, accrualIntervalSeconds: 60,
        dir: `${work}/${interrupted ? 'interrupted' : 'complete'}`, startedAt: new Date().toISOString(), status: 'IN_PROGRESS',
        forkSource: { block: block.number, blockHash: block.hash },
      };
      const r = new Runner(m, rpc);
      r.persist();
      const result = await workflow(r, interrupted);
      if (interrupted && result.status === 'INTERRUPTED_FOR_STANDALONE_RECOVERY') {
        // A new process reads only the saved manifest and journal (no snapshot rollback).
        await new Promise<void>((resolve, reject) => {
          const p = spawn(process.execPath, ['--import', 'tsx', 'scripts/canary/recover.ts', '--manifest', `${m.dir}/manifest.json`, '--local-rpc', node.url], { stdio: 'inherit' });
          p.once('error', reject);
          p.once('exit', code => (code === 0 ? resolve() : reject(Error(`Standalone recovery exited ${code}`))));
        });
      }
      const recovery = existsSync(`${m.dir}/recovery.json`) ? JSON.parse(readFileSync(`${m.dir}/recovery.json`, 'utf8')) : null;
      const counts: Record<string, number> = {};
      for (const a of Object.values(result.assertions as Record<string, { status: string }>)) counts[a.status] = (counts[a.status] ?? 0) + 1;
      const negative = Object.fromEntries(Object.entries(result.assertions as Record<string, { status: string; evidence?: { kind?: string } }>)
        .filter(([, a]) => a.evidence && 'kind' in a.evidence).map(([k, a]) => [k, { status: a.status, kind: a.evidence!.kind }]));
      record.runs.push({ interrupted, status: result.status, assertions: counts, negativeTests: negative, recovery, error: result.error, finalizationError: result.finalizationError, recoveryError: result.recoveryError });
      // Evidence: everything except the bulky saved ABI/bytecode, which is recorded by hash.
      const dest = `${out}/${interrupted ? 'interrupted' : 'complete'}`;
      mkdirSync(dest, { recursive: true });
      for (const f of readdirSync(m.dir)) {
        if (f === 'artifacts.json') save(`${dest}/artifacts.sha256.json`, { file: 'artifacts.json', sha256: hash(readFileSync(`${m.dir}/${f}`)) });
        else copyFileSync(`${m.dir}/${f}`, `${dest}/${f}`);
      }
    } finally {
      await node.stop();
    }
  }
  if (localCandidate().digest !== candidate.digest) throw Error('Candidate changed during the rehearsal');
  const complete = record.runs[0] as { status: string }, interrupted = record.runs[1] as { status: string; recovery: { errors: object; closed: boolean } | null };
  const status = complete.status === 'PASS' && interrupted.status === 'INTERRUPTED_FOR_STANDALONE_RECOVERY' && interrupted.recovery?.closed === true && Object.keys(interrupted.recovery.errors).length === 0 ? 'PASS' : 'FAIL';
  save(`${out}/summary.json`, { ...record, status, completedAt: new Date().toISOString() });
  console.log(json({ status, runIdentity: runId, candidate: candidate.digest, forkBlock: block.number, runs: record.runs.map(x => ({ status: (x as { status: string }).status, assertions: (x as { assertions: unknown }).assertions })) }));
  if (status !== 'PASS') process.exitCode = 1;
}

main().catch(e => { console.error(redact(e)); process.exitCode = 1; });
