#!/usr/bin/env node
/** Standalone, journal-driven recovery. Intentionally performs NO Mining/BEM preflight or harvest. */
import { readFileSync } from 'node:fs';
import { createPublicClient, http } from 'viem';
import { env, ownerFromEnv, redact, remote } from './common.ts';
import { Runner, type Manifest } from './transactions.ts';

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => args[args.indexOf(name) + 1];
  if (!args.includes('--manifest')) throw Error('Usage: recover --manifest reports/canary/{mode}/{run}/manifest.json [--local-rpc LOOPBACK_URL]');
  const m = JSON.parse(readFileSync(flag('--manifest'), 'utf8')) as Manifest;
  let rpc;
  if (m.mode === 'fork') {
    if (!args.includes('--local-rpc')) throw Error('Fork recovery requires explicit --local-rpc');
    const url = new URL(flag('--local-rpc'));
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('Fork recovery must use loopback');
    rpc = createPublicClient({ transport: http(url.href) });
    await rpc.request({ method: 'anvil_nodeInfo' } as never);
    if (!(await rpc.request({ method: 'web3_clientVersion' })).toLowerCase().includes('anvil')) throw Error('Not Anvil');
  } else {
    env();
    if (process.env.MODE !== 'mainnet' || process.env.ALLOW_MAINNET_BROADCAST !== 'true' || process.env.APPROVED_RUN_ID !== m.runId) throw Error('Mainnet recovery requires the previously approved run ID and broadcast gates');
    if (ownerFromEnv().toLowerCase() !== m.owner.toLowerCase()) throw Error('Recovery signer differs from fixed original wallet');
    rpc = remote();
    if (/anvil|hardhat|ganache/i.test(await rpc.request({ method: 'web3_clientVersion' }))) throw Error('Mainnet mode cannot use a local fork');
    // Recovery is already part of the approved bounded run; no new approval or business steps.
  }
  const r = new Runner(m, rpc);
  await r.reconcileJournal();
  await r.recover();
  console.log('Verified both designated NFT owners and irreversible shutdown. Business results are unchanged.');
}
main().catch(e => { console.error(redact(e)); process.exitCode = 1; });
