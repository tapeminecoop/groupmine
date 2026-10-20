#!/usr/bin/env node
/** Explicit mainnet broadcaster. Existing local CLI commands retain their original behavior. */
import { existsSync, readFileSync } from 'node:fs';
import { parseEther } from 'viem';
import { env, fingerprint, ownerFromEnv, preflight, redact, remote, save } from './common.ts';
import { Runner, type Manifest } from './transactions.ts';
import { workflow } from './workflow.ts';
import { report } from './report.ts';

async function main() {
  env();
  if (process.env.MODE !== 'mainnet' || process.env.ALLOW_MAINNET_BROADCAST !== 'true' || !process.argv.includes('--broadcast')) throw Error('Live runner requires MODE=mainnet, ALLOW_MAINNET_BROADCAST=true and --broadcast');
  const runId = process.env.APPROVED_RUN_ID;
  if (!runId || !/^canary-[a-f0-9-]{36}$/.test(runId)) throw Error('Explicit APPROVED_RUN_ID required');
  const proposal = JSON.parse(readFileSync(`reports/canary/proposals/${runId}.json`, 'utf8'));
  // This record is written only after the human approves the concrete proposal in chat.
  const approval = JSON.parse(readFileSync(`reports/canary/approvals/${runId}.json`, 'utf8'));
  if (approval.approved !== true || approval.runId !== runId || approval.candidateDigest !== proposal.candidateDigest || approval.proposalDigest !== (await import('./common.ts')).hash(readFileSync(`reports/canary/proposals/${runId}.json`))) throw Error('Missing or mismatched human approval record');
  if (fingerprint().digest !== proposal.candidateDigest) throw Error('Candidate changed after fork rehearsal/approval');
  for (const [name, key] of [['MAX_RUN_FEE_BNB', 'maxRunFee'], ['MAX_TX_FEE_BNB', 'maxTxFee'], ['RECOVERY_RESERVE_BNB', 'recoveryReserve']] as const) if (!process.env[name] || parseEther(process.env[name]!) !== BigInt(proposal[key])) throw Error(`${name} must equal the approved bounded proposal`);
  for (const [name, key] of [['MAX_WAIT_SECONDS', 'maxWaitSeconds'], ['MIN_CONFIRMATIONS', 'minConfirmations']] as const) if (Number(process.env[name]) !== proposal[key]) throw Error(`${name} must equal approved proposal`);
  const owner = ownerFromEnv(), rpc = remote();
  if (['127.0.0.1', 'localhost', '[::1]'].includes(new URL(process.env.BSC_RPC_URL!).hostname)) throw Error('Mainnet broadcaster requires the approved remote BSC RPC');
  if (owner.toLowerCase() !== proposal.owner.toLowerCase()) throw Error('Signer differs from approved wallet');
  if (/anvil|hardhat|ganache/i.test(await rpc.request({ method: 'web3_clientVersion' }))) throw Error('Mainnet runner cannot target a local fork');
  const source = await preflight(rpc, owner);
  if (source.bnbRaw < BigInt(proposal.maxRunFee)) throw Error('Wallet cannot cover approved cap');
  if (await rpc.getTransactionCount({ address: owner, blockTag: 'latest' }) !== proposal.initialNonce) throw Error('Wallet nonce changed; prepare and approve updated deployment addresses');
  const dir = `reports/canary/mainnet/${runId}`;
  if (existsSync(`${dir}/manifest.json`)) throw Error('Run already exists: inspect journal and use standalone recovery; never redeploy blindly');
  const m: Manifest = { ...proposal, schema: 'recoverable-canary-run/1', mode: 'mainnet', dir, owner, contracts: {}, identities: {}, totalFeeRaw: '0', nextNonce: proposal.initialNonce, startedAt: new Date().toISOString(), status: 'IN_PROGRESS' };
  const runner = new Runner(m, rpc);
  runner.persist();
  const result = await workflow(runner);
  save(`${dir}/results.json`, result);
  await report(dir);
  if (result.status !== 'PASS') process.exitCode = 1;
}
main().catch(e => { console.error(redact(e)); process.exitCode = 1; });
