#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createPublicClient, http, parseEther, toHex } from 'viem';
import { startAnvil } from '../lib/anvil.ts';
import { env, fingerprint, ownerFromEnv, preflight, redact, remote, save } from './common.ts';
import { Runner, type Manifest } from './transactions.ts';
import { workflow } from './workflow.ts';

async function main() {
  env();
  const interval = Number(process.env.ACCRUAL_INTERVAL_SECONDS || '60');
  const maxWait = Number(process.env.MAX_WAIT_SECONDS || '300');
  if (!Number.isSafeInteger(interval) || interval < 1 || !Number.isSafeInteger(maxWait) || maxWait < 5 * interval || maxWait > 3600) throw Error('Invalid bounded accrual interval/wait budget');
  const owner = ownerFromEnv();
  const upstream = remote();
  const initial = await preflight(upstream, owner);
  const forkGasPrice = await upstream.getGasPrice();
  execFileSync('node', ['scripts/canary/build-source.mjs', '--check'], { stdio: 'inherit' });
  const candidate = fingerprint();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = `reports/canary/fork/${stamp}`;
  save(`${root}/source.json`, { candidate, source: initial, signing: 'NO_PRIVATE_KEY_USED_FOR_TRANSACTIONS', impersonation: 'LOCAL_ANVIL_ONLY', mainnetTransactions: 0 });
  // Do not expose the real key to Anvil or child recovery processes, even as inherited environment.
  delete process.env.OWNER_PRIVATE_KEY;
  const observations = [];
  for (const interrupted of [false, true]) {
    const node = await startAnvil(interrupted ? 18566 : 18565, ['--fork-url', process.env.BSC_RPC_URL!, '--fork-block-number', String(initial.block), '--chain-id', '56', '--gas-price', String(forkGasPrice), '--hardfork', 'cancun', '--compute-units-per-second', '40', '--silent'], 60_000);
    try {
      const rpc = createPublicClient({ transport: http(node.url, { timeout: 60_000 }) });
      await rpc.request({ method: 'anvil_nodeInfo' } as never);
      if (!(await rpc.request({ method: 'web3_clientVersion' })).toLowerCase().includes('anvil')) throw Error('Local node is not Anvil');
      if ((await rpc.getBlock({ blockNumber: initial.block })).hash !== initial.blockHash) throw Error('Fork source block mismatch');
      await rpc.request({ method: 'anvil_impersonateAccount', params: [owner] } as never);
      await rpc.request({ method: 'anvil_setBalance', params: [owner, toHex(parseEther('10'))] } as never);
      const m: Manifest = {
        schema: 'recoverable-canary-run/1', mode: 'fork', runId: `${stamp}-${interrupted ? 'interrupted' : 'complete'}`,
        candidateDigest: candidate.digest, owner, contracts: {}, identities: {}, totalFeeRaw: '0',
        maxRunFee: String(parseEther('0.1')), maxTxFee: String(parseEther('0.02')), recoveryReserve: String(parseEther('0.01')),
        feePriceCeiling: String(forkGasPrice * 2n), forkGasPrice: String(forkGasPrice), minConfirmations: 1,
        maxWaitSeconds: maxWait, accrualIntervalSeconds: interval,
        dir: `${root}/${interrupted ? 'interrupted' : 'complete'}`, startedAt: new Date().toISOString(), status: 'IN_PROGRESS',
        forkSource: { block: initial.block, blockHash: initial.blockHash },
      };
      const r = new Runner(m, rpc);
      r.persist();
      const result = await workflow(r, interrupted);
      if (!interrupted && result.status !== 'PASS') throw Error(`Full fork rehearsal did not pass: ${redact(result.error ?? result.finalizationError ?? result.recoveryError)}`);
      if (interrupted) {
        if (result.status !== 'INTERRUPTED_FOR_STANDALONE_RECOVERY') throw Error('Interruption checkpoint not reached');
        // A new process reads ONLY the saved manifest/journal. No snapshot rollback used as recovery.
        await new Promise<void>((resolve, reject) => {
          const p = spawn(process.execPath, ['--import', 'tsx', 'scripts/canary/recover.ts', '--manifest', `${m.dir}/manifest.json`, '--local-rpc', node.url], { stdio: 'inherit' });
          p.once('error', reject);
          p.once('exit', code => code === 0 ? resolve() : reject(Error(`Standalone recovery exited ${code}`)));
        });
        const recovery = JSON.parse(readFileSync(`${m.dir}/recovery.json`, 'utf8'));
        if (Object.keys(recovery.errors).length || !recovery.closed || recovery.verified.some((x: any) => x.owner.toLowerCase() !== owner.toLowerCase())) throw Error('Interrupted-run ownership verification failed');
      }
      observations.push({ interrupted, dir: m.dir, result: result.status, recovery: JSON.parse(readFileSync(`${m.dir}/recovery.json`, 'utf8')) });
    } finally { await node.stop(); }
  }
  if (fingerprint().digest !== candidate.digest) throw Error('Candidate changed during rehearsal');
  save('reports/canary/candidate.json', { ...candidate, status: 'FORK_REHEARSED', owner, rehearsal: root, observations, mainnetTransactions: 0 });
  save('reports/canary/fork-latest-attempt.json', { scope: 'LOCAL_BSC_FORK_ONLY', status: 'PASS', sourceDigest: candidate.digest, rehearsal: root, completedAt: new Date().toISOString(), mainnetTransactions: 0, signaturesCreated: 0 });
  console.log(`Exact candidate fork rehearsal PASS: ${candidate.digest}`);
}
main().catch(e => {
  const reason = redact(e);
  save('reports/canary/fork-latest-attempt.json', { scope: 'LOCAL_BSC_FORK_ONLY', status: /Configure/.test(reason) ? 'NOT_RUN_MISSING_CONFIGURATION' : 'FAILED', reason, attemptedAt: new Date().toISOString(), mainnetTransactions: 0 });
  console.error(reason); process.exitCode = 1;
});
