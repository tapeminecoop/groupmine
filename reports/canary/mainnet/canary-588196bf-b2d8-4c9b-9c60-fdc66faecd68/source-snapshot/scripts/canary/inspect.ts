#!/usr/bin/env node
import { env, ownerFromEnv, preflight, redact, remote, save } from './common.ts';
async function main() {
  env();
  const result = await preflight(remote(), ownerFromEnv());
  save('reports/canary/mainnet-read-only-preflight.json', result);
  console.log(`Read-only mainnet preflight passed at block ${result.block}; original wallet ${result.owner}; no transactions signed or broadcast.`);
}
main().catch(e => {
  const reason = redact(e);
  save('reports/canary/preflight-latest-attempt.json', { scope: 'READ_ONLY_BSC', status: /Configure/.test(reason) ? 'NOT_RUN_MISSING_CONFIGURATION' : 'FAILED', reason, attemptedAt: new Date().toISOString(), mainnetTransactions: 0 });
  console.error(reason); process.exitCode = 1;
});
