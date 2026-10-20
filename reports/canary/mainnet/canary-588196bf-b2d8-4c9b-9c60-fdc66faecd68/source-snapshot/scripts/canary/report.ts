import { readFileSync, writeFileSync } from 'node:fs';
import { formatEther } from 'viem';
import { json } from './common.ts';

export async function report(dir: string) {
  const m = JSON.parse(readFileSync(`${dir}/manifest.json`, 'utf8'));
  const r = JSON.parse(readFileSync(`${dir}/results.json`, 'utf8'));
  const rows = readFileSync(`${dir}/journal.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x));
  const txs = rows.filter(x => x.stage === 'CONFIRMED');
  const md = `# TapeOut Recoverable Canary Test Report

Status: **${r.status}**. Evidence scope: **${r.scope}**.

## Objective and actual scope

Exercise designated miners #3204 (2 NAND, 0 LATCH) and #12485 (1 NAND, 1 LATCH), with isolated receipts (4 NAND IDs, 2 LATCH IDs), an EOA plus a controlled contract holder, composition changes 2:0 to 3:1, exact BEM payouts, and mandatory fixed-wallet recovery. This is not a test of two independent EOA signers or a live multisig.

## Source and build

Base revision: c4bc022c76c5de528a98caa58974ee5772f80d4a. Candidate source/artifact digest: \`${m.candidateDigest}\`.
Solidity 0.8.24; Paris; via-IR; optimizer 200 runs. See candidate.json and production-canary.diff for exact source hashes, artifact hashes and exhaustive adaptation.

## Deployed identities and permissions

${json(m.contracts)}

${json(m.identities)}

Production pool and its accounting library are unchanged. The canary has different bytecode and adds an immutable recovery controller (${m.owner}), ID restrictions (3204 and 12485), an irreversible shutdown and independent fixed-destination NFT returns. It retains production authoritative burn reads, strict admission settlement, carried-income treatment, 100:1:1 accounting, receipt history and transfer semantics. The original wallet is the sole depositor. Shutdown works after ordinary owner renunciation. No arbitrary recovery destination, BEM sweep, reopening or arbitrary helper executor exists.

Shutdown and each emergencyReturn make no Mining or BEM calls. The NFT contract must still allow transfer. Already received BEM remains attributed using the frozen final composition and persistent per-ID/role histories; claims, sync and releases continue after shutdown. Unreceived Mining income follows the NFT and is excluded from pool payments.

## Initial ownership, status, composition and approvals

\`results.json:observations.initial\` includes a block-pinned snapshot, protocol identities, BEM decimals, both owners, full Mining records, burn-cache/circuitBurn cross-checks, pending and token approvals. pending is not treated as an exact promise of claim payout.

## Issuance and JSON allocation

The intended issuance is 4 NAND and 2 LATCH receipts to the original wallet, followed by supply finalization, transfer into the production distributor, JSON import, complete bidirectional verification and allocation finalization. The intended allocation is wallet NAND #1-3/LATCH #1 and helper NAND #4/LATCH #2 (delivered late). Only completed journal actions and passing assertions below establish which steps actually occurred; missing phases are not presumed executed. See allocation-artifact.json when present.

## Chronological transaction results

| Action | Hash | Block | Gas used | Fee BNB |
| --- | --- | ---: | ---: | ---: |
${txs.map(t => `| ${t.action} | ${t.hash} | ${t.block} | ${t.gasUsed} | ${formatEther(BigInt(t.feeRaw))} |`).join('\n')}

Every transaction's sender, target, function, calldata, hash, block/hash, timestamp, confirmations, gas/fee, raw event logs, decoded pool events, and balance/ownership changes are in journal.jsonl. Fork transaction hashes are never represented as mainnet hashes.

## Accounting boundaries and independent expected values

\`results.json:observations.boundary\` preserves the mined second admission and checkpoint events. Expected values use independent integer arithmetic, not PoolMath or sdk/math: P=floor(100T/102), A=B=floor(T/102); the all-NAND old base is frozen at the admission checkpoint; new participant delta splits floor(3d/4) and floor(d/4); fixed receipt supplies divide category amounts by 4 and 2. Zero carried income is recorded as zero; both old settlement and later new-period harvest must be positive. All BEM amounts are raw 8-decimal integers, with formatted payout examples in assertions.

## Individual assertions, failures and incomplete checks

| Assertion | Status |
| --- | --- |
${Object.entries(r.assertions).map(([name, v]: [string, any]) => `| ${name} | ${v.status} |`).join('\n')}

Business failure: ${r.error ?? 'none recorded'}. Recovery failure: ${r.recoveryError ?? 'none recorded'}. Finalization failure: ${r.finalizationError ?? 'none recorded'}.

## Final ownership, post-return behavior and BEM reconciliation

${json(r.observations.finalLedger ?? { status: 'NOT_COMPLETED' })}

${json(r.observations.postReturn ?? { status: 'UNVERIFIED' })}

Both final-owner assertions must pass at confirmed blocks; return transaction success alone is insufficient. Post-return personal income is recorded separately. Missing or zero post-return payment is unverified evidence of positive continued payment and is not presented as a positive result. Rounding residue (at most 7 raw BEM units for these supplies) is distinguished from unpaid entitlements. Successful recovery never changes a failed business test into PASS.

## BNB spending and limitations

Total confirmed fees: **${formatEther(BigInt(m.totalFeeRaw))} BNB** (${m.totalFeeRaw} wei). Approved cap: ${formatEther(BigInt(m.maxRunFee))} BNB; recovery reserve: ${formatEther(BigInt(m.recoveryReserve))} BNB. No NFT purchase/sale/list/burn/stop/challenge/reconfiguration, fundraising receipt or contributor allocation is in scope.

This disclosed recoverable variant differs from the non-withdrawable production pool in bytecode and authority. This bounded test is not an independent audit, a production deployment or proof of identical bytecode. Upstream NFT transfer availability and protocol behavior remain dependencies. Mock fault injection, local-fork execution and actual mainnet evidence are separately identified.
`;
  writeFileSync(`${dir}/MAINNET_TEST_REPORT.md`, md);
  if (m.mode === 'mainnet') writeFileSync('MAINNET_TEST_REPORT.md', md);
}
