#!/usr/bin/env node
/** Read-only preparation. Generates a concrete proposal; NEVER grants broadcast authorization. */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { formatEther, getContractAddress, parseEther } from 'viem';
import { env, fingerprint, json, ownerFromEnv, preflight, redact, remote, save } from './common.ts';

async function main() {
  env();
  const owner = ownerFromEnv(), rpc = remote();
  const source = await preflight(rpc, owner);
  const candidate = JSON.parse(readFileSync('reports/canary/candidate.json', 'utf8'));
  if (candidate.status !== 'FORK_REHEARSED' || candidate.digest !== fingerprint().digest || candidate.owner.toLowerCase() !== owner.toLowerCase()) throw Error('Exact candidate and wallet must pass fork rehearsal first');
  const full = readFileSync(`${candidate.rehearsal}/complete/journal.jsonl`, 'utf8').trim().split('\n').map(x => JSON.parse(x)).filter(x => x.stage === 'CONFIRMED');
  const price = await rpc.getGasPrice();
  const ceiling = price * 2n;
  const gas = full.reduce((s: bigint, x: any) => s + BigInt(x.gas), 0n);
  const recoveryGas = full.filter((x: any) => /^permanent-shutdown/.test(x.action) || /^return-/.test(x.action)).reduce((s: bigint, x: any) => s + BigInt(x.gas), 0n);
  const reserveEstimate = recoveryGas * ceiling * 2n;
  const reserve = process.env.RECOVERY_RESERVE_BNB ? parseEther(process.env.RECOVERY_RESERVE_BNB) : reserveEstimate;
  const total = process.env.MAX_RUN_FEE_BNB ? parseEther(process.env.MAX_RUN_FEE_BNB) : gas * ceiling * 150n / 100n + reserve;
  const maxGas = full.reduce((s: bigint, x: any) => BigInt(x.gas) > s ? BigInt(x.gas) : s, 0n);
  const perTx = process.env.MAX_TX_FEE_BNB ? parseEther(process.env.MAX_TX_FEE_BNB) : maxGas * ceiling;
  if (reserve < reserveEstimate || total <= reserve || perTx <= 0n) throw Error('Proposed fee settings cannot protect the estimated recovery reserve');
  const nonce = await rpc.getTransactionCount({ address: owner, blockTag: 'latest' });
  if (await rpc.getTransactionCount({ address: owner, blockTag: 'pending' }) !== nonce) throw Error('Pending nonce must be reconciled first');
  const predicted = Object.fromEntries(['nand', 'latch', 'helper', 'pool', 'regularPool', 'distributor'].map((name, i) => [name, getContractAddress({ from: owner, nonce: BigInt(nonce + i) })]));
  const maxWaitSeconds = Number(process.env.MAX_WAIT_SECONDS || '300');
  const accrualIntervalSeconds = Number(process.env.ACCRUAL_INTERVAL_SECONDS || '60');
  const minConfirmations = Number(process.env.MIN_CONFIRMATIONS || '3');
  if (![maxWaitSeconds, accrualIntervalSeconds, minConfirmations].every(Number.isSafeInteger) || accrualIntervalSeconds < 1 || maxWaitSeconds < 5 * accrualIntervalSeconds || maxWaitSeconds > 3600 || minConfirmations < 1 || minConfirmations > 64) throw Error('Invalid bounded wait or confirmation policy');
  const runId = `canary-${randomUUID()}`;
  const proposal = {
    schema: 'recoverable-canary-proposal/1', runId, mode: 'mainnet', candidateDigest: candidate.digest,
    owner, recoveryDestination: owner, miners: [3204, 12485], initialNonce: nonce, predictedContracts: predicted,
    source, maxRunFee: String(total), maxTxFee: String(perTx), recoveryReserve: String(reserve), feePriceCeiling: String(ceiling),
    maxWaitSeconds, accrualIntervalSeconds, minConfirmations,
    estimate: { rehearsedGasLimits: gas, observedGasUsed: full.reduce((s: bigint, x: any) => s + BigInt(x.gasUsed), 0n), currentGasPrice: price, estimatedAtCurrentPriceBNB: formatEther(gas * price), maxRunFeeBNB: formatEther(total), maxTxFeeBNB: formatEther(perTx), recoveryReserveBNB: formatEther(reserve), walletBNB: formatEther(source.bnbRaw), funded: source.bnbRaw >= total },
    operations: full.map((x: any) => ({ action: x.action, function: x.function, rehearsedGasLimit: x.gas, rehearsedGasUsed: x.gasUsed })),
    recovery: 'Permanent shutdown of both canary pools; independent emergencyReturn(3204), emergencyReturn(12485), fixed wallet only. Finish existing BEM entitlements and forward helper BEM. No Mining/BEM call required for NFT return.',
    humanApproval: 'REQUIRED_BEFORE_ANY_MAINNET_TRANSACTION',
  };
  save(`reports/canary/proposals/${runId}.json`, proposal);
  console.log(`Prepared read-only proposal reports/canary/proposals/${runId}.json\n${json(proposal.estimate)}`);
}
main().catch(e => { console.error(redact(e)); process.exitCode = 1; });
