import fs from 'node:fs';
import { createRequire } from 'node:module';
import { save, fingerprint } from '/Users/jaychen/Desktop/tapemine/scripts/canary/common.ts';
import { report } from '/Users/jaychen/Desktop/tapemine/scripts/canary/report.ts';
const require = createRequire('/Users/jaychen/Desktop/tapemine/package.json');
const { formatEther, formatUnits } = require('viem');
process.chdir('/Users/jaychen/Desktop/tapemine');
const id = 'canary-588196bf-b2d8-4c9b-9c60-fdc66faecd68';
const dir = `reports/canary/mainnet/${id}`;
const m = JSON.parse(fs.readFileSync(`${dir}/manifest.json`));
const r = JSON.parse(fs.readFileSync(`${dir}/results.json`));
const audit = JSON.parse(fs.readFileSync(`${dir}/final-audit.json`));
const recovery = JSON.parse(fs.readFileSync(`${dir}/recovery.json`));
const cleanup = JSON.parse(fs.readFileSync(`${dir}/cleanup.json`));
const candidate = JSON.parse(fs.readFileSync('reports/canary/candidate.json'));
if (fingerprint().digest !== m.candidateDigest) throw Error('Frozen candidate changed');
const txs = fs.readFileSync(`${dir}/journal.jsonl`, 'utf8').trim().split('\n').map(JSON.parse).filter(x => x.stage === 'CONFIRMED');
const byAction = Object.fromEntries(txs.map(x => [x.action, x]));
const p = name => r.assertions[name]?.status === 'PASS';
const success = {
  designatedMinersDepositedAndUsed: p('both-nfts-in-canary') && !!byAction['phase-A-deposit-3204'] && !!byAction['phase-B-deposit-12485'],
  compositionChangedTwoZeroToThreeOne: p('phase-A-composition-2-0') && p('phase-B-composition-3-1'),
  oldEntitlementsPreservedAndNewIncomeCorrect: p('old-period-and-held-balance-all-nand') && p('carried-income-new-composition-and-fixed-old-entitlements') && p('nonzero-old-period-settlement') && p('positive-new-period-harvest'),
  distributionClaimsPositiveEntitlementTransfer: p('late-delivery-preserves-earlier-entitlement') && p('helper-initial-receipt-claim-exact') && p('transfer-carries-positive-unpaid-income') && cleanup.checks['transferred-receipt-successfully-claimed-by-helper-after-return']?.status === 'PASS',
  bothRolesCorrectlyPaid: audit.checks.rolesFullyPaid && cleanup.checks['cleanup-role-A-cumulative-1-of-102']?.status === 'PASS' && cleanup.checks['cleanup-role-B-cumulative-1-of-102']?.status === 'PASS',
  bothActualFinalOwnersOriginalWallet: audit.checks.bothActualOwnersAreOriginalWallet,
  finalAccountingReconciled: cleanup.checks['final-received-BEM-independent-reconciliation']?.status === 'PASS' && audit.checks.walletBNBReconciles && audit.checks.walletBEMReconciles,
  noUnrelatedOrFundraisingAssetsModified: audit.checks.noUnrelatedNFTsTargetsOrGlobalApprovals,
};
const overall = r.status === 'PASS' && audit.status === 'PASS' && Object.values(success).every(Boolean) ? 'PASS' : audit.assetAndAccountingStatus === 'PASS' ? 'PARTIAL_AUTOMATION_FAILED_RECOVERY_AND_ACCOUNTING_PASS' : 'FAIL_OR_INCOMPLETE';
const BEM = value => `${value} raw (${formatUnits(BigInt(value), 8)} BEM)`;
const b = r.observations.boundary;
const l = audit.ledger;
const detail = `

## Confirmed actual mainnet observations and final independent audit

Run: ${id}. Overall final status: **${overall}**. The original automatic run remains FAIL_OR_INCOMPLETE; successful recovery has not relabeled it PASS. Human approval is saved in reports/canary/approvals/${id}.json. The originally proposed fee caps were retained; no additional fee headroom was used. The frozen candidate is ${m.candidateDigest}; all production source files remain unchanged.

### Automation failure and approved payout continuation

The original runner incorrectly searched only the human-readable RPC error.message for a custom-error selector. The commercial RPC returned the generic text "execution reverted" while placing the exact revert bytes in structured error data. Consequently, the original former-holder and closed-admission assertions failed, the run aborted, and independent emergency returns were prioritized. Both failed assertions and their exact original messages remain unchanged in results.json.

After actual NFT ownership was back in the original wallet, a separate approved payout-continuation script reused the frozen Runner, ABI, fee caps and existing SDK structured-error decoder. It completed only the already-authorized remaining receipt claims, repeat-claim test, A/B releases, helper forwarding and post-return personal claims. No contract, recovery destination, miner admission or fee cap changed. The planned orderly final canary Mining harvest was **SKIPPED** because of the abort; the canary was never harvested after shutdown. Unreceived Mining accrual that followed the returned NFTs is part of the later personal payments, not pool income.

Structured-data simulations separately confirmed:

| Guard | Expected decoded error | Independent result |
| --- | --- | --- |
${Object.entries(cleanup.diagnostics).map(([name, value]) => `| ${name} | ${value.expected} | ${value.status}: ${value.decoded?.errorName ?? 'UNVERIFIED'} |`).join('\n')}

The non-whitelisted simulation used the confirmed pre-shutdown transfer block, so it checked NotDepositor while admissions were still open. Other simulations used post-return state. No intentionally failing transaction was broadcast. This diagnostic evidence explains the harness failure; it does not erase or overwrite the original failed automated assertions.

After all transactions, a separate read-only audit fetched canonical transaction receipts and block hashes from the commercial BSC RPC and checked final state at block **${audit.confirmedBlock}**, hash **${audit.blockHash}**, with the ${audit.minConfirmations}-confirmation policy. The audit head was ${audit.head}. Actual mainnet receipts and final audit are in ${dir}/final-audit.json. The rehearsal evidence remains separately under ${candidate.rehearsal}; no fork transaction is included as mainnet evidence.

| Actual mainnet test contract | Address | Observed runtime code hash |
| --- | --- | --- |
${Object.entries(m.contracts).map(([name, address]) => `| ${name} | ${address} | ${m.identities[name].codeHash} |`).join('\n')}

The original wallet and immutable recovery destination are **${m.owner}**. The canonical NFT collection is 0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C. Ordinary pool ownership is renounced. The recovery controller remains bound to the original wallet; admissions and Mining harvests remain permanently closed. Receipt supplies remain 4 NAND and 2 LATCH, and the retained final accounting composition is 3:1.

| Miner | Final owner at confirmed block | Mining status | Actual NAND / LATCH | Return transaction |
| --- | --- | --- | --- | --- |
${audit.miners.map(x => `| ${x.id} | ${x.owner} | ${x.record.status} (ACTIVE) | ${x.record.nandBurn} / ${x.record.latchBurn} | ${byAction[`return-${x.id}`]?.hash ?? 'NOT_COMPLETED'} |`).join('\n')}

Both NFTs were checked by ownerOf, not inferred from transaction success. Neither NFT remains in the canary; per-token approvals are cleared. Recovery did not depend on payout completion, and received-BEM payouts were completed after the returns. The upstream NFT transfer dependency remains a limitation.

### Exact admission boundary and positive revenue

- #3204 first-admission carried income: ${BEM(b?.firstAdmission.carriedIncome ?? 0)} under 2:0.
- Before the first bounded harvest, pending was ${r.assertions['phase-A-positive-actual-revenue']?.evidence.pendingBeforeHarvestRaw ?? 'UNVERIFIED'} raw; the mined harvest actually received ${BEM(r.assertions['phase-A-positive-actual-revenue']?.evidence.actualReceivedRaw ?? 0)}. Pending was never used to skip collection.
- Real old-period BEM held but not accounted before second admission: ${BEM(r.assertions['old-period-and-held-balance-all-nand']?.evidence.unrecognized ?? 0)}.
- Nonzero #3204 income settled INSIDE second admission: ${BEM(b?.secondAdmission.settledOldIncome ?? 0)}.
- #12485 carried income received under new 3:1 composition: ${BEM(b?.secondAdmission.carriedIncome ?? 0)}.
- Old-period checkpoint gross ${BEM(b?.checkpoint.totalAccounted ?? 0)}, frozen NAND base ${b?.nandBase ?? 'UNVERIFIED'}, LATCH base 0.
- Subsequent positive 3:1 harvest: ${BEM(r.assertions['positive-new-period-harvest']?.evidence.received ?? 0)}.

The held balance came from an actual Mining claim, followed by another full approved interval before second admission. It did not replace settlement. Old bases were frozen, and actual incoming carried income used the new composition. Expected values for each payment were reconstructed independently from BEM Transfer logs through its mined transaction, fixed composition periods, fixed supplies and independently retained per-ID claimed history.

### Late distribution, transfer and separate payouts

Wallet allocation was NAND #1-3 and LATCH #1; helper allocation was NAND #4 and LATCH #2. Helper delivery occurred after accrual and preserved prior entitlement. NAND #1 transferred with claimed history ${r.assertions['transfer-carries-positive-unpaid-income']?.evidence.historyRaw ?? 'UNVERIFIED'} raw and positive unpaid ${BEM(r.assertions['transfer-carries-positive-unpaid-income']?.evidence.unpaidRaw ?? 0)}. The helper claimed that ID's exact expected amount. Claimed history and unpaid rights followed the ID, and a repeat claim paid zero. The former-holder and non-whitelisted admission rejections were simulations matching the expected custom-error selectors. No intentionally failing transaction was broadcast.

| Receipt/role ledger at final confirmed block | Accrued raw | Paid raw | Outstanding raw |
| --- | ---: | ---: | ---: |
| NAND receipts | ${l.nandReceiptsAccrued} | ${l.nandReceiptsPaid} | ${BigInt(l.nandReceiptsAccrued) - BigInt(l.nandReceiptsPaid)} |
| LATCH receipts | ${l.latchReceiptsAccrued} | ${l.latchReceiptsPaid} | ${BigInt(l.latchReceiptsAccrued) - BigInt(l.latchReceiptsPaid)} |
| Recipient A, original wallet | ${l.recipientAAccrued} | ${l.recipientAPaid} | ${BigInt(l.recipientAAccrued) - BigInt(l.recipientAPaid)} |
| Recipient B, helper | ${l.recipientBAccrued} | ${l.recipientBPaid} | ${BigInt(l.recipientBAccrued) - BigInt(l.recipientBPaid)} |

A/B fee-role payments and receipt payouts have separate transactions/events, despite sharing holder addresses. Final A and B each equal floor(${l.totalAccounted}/102). Every per-ID outstanding entitlement is zero. Helper BEM was forwarded only to the original wallet and its final balance is ${audit.helperBEMRaw} raw.

Recognized gross pool income is ${BEM(l.totalAccounted)}; total paid is ${BEM(l.totalPaid)}. The remaining pool balance is ${BEM(audit.poolBEMRaw)}, entirely the bounded rounding residue ${l.residue} raw. Unrecognized income and deficit are ${l.unrecognized} and ${l.deficit} raw. Actual BEM inbound/outbound events reconcile with the ledger; the final original-wallet BEM increase equals pool payouts plus separately recorded post-return personal income.

### Post-return personal mining income

${r.observations.postReturn.map(x => `- Miner #${x.id}: ${BEM(x.paidRaw ?? 0)} to the original current owner, transaction ${x.transaction ?? 'UNVERIFIED'}.`).join('\n')}

Both post-return payments were positive and their recorded statuses ACTIVE. Their total ${BEM(audit.postReturnIncomeRaw)} is excluded from pool gross income. It includes any previously unreceived Mining accrual that followed the NFTs on emergency return and should not be interpreted as income earned exclusively after the return timestamp. These are observations from this bounded run, not a guarantee of future upstream protocol behavior.

### Fees and final balance conservation

${txs.length} mainnet transactions were confirmed. Canonical receipts independently sum to **${formatEther(BigInt(audit.totalFeeRaw))} BNB**, ${audit.totalFeeRaw} wei. This equals the journal's fee counter and the original wallet's initial-to-final BNB decrease. Initial wallet BNB: ${formatEther(BigInt(audit.initialBNBRaw))}; final confirmed wallet BNB: ${formatEther(BigInt(audit.finalBNBRaw))}.

The total cap was ${formatEther(BigInt(m.maxRunFee))} BNB, per-transaction cap ${formatEther(BigInt(m.maxTxFee))} BNB, and the earmarked recovery reserve ${formatEther(BigInt(m.recoveryReserve))} BNB within that total cap. The waiting budget was ${m.maxWaitSeconds} seconds across five ${m.accrualIntervalSeconds}-second reward intervals; transaction confirmation/RPC latency is additional. No fee cap was raised. No asset purchase, sale, listing, burning, stopping, challenging, reconfiguration or fundraising allocation was performed.

### Eight final success conditions

| Condition | Status |
| --- | --- |
${Object.entries(success).map(([name, passed]) => `| ${name} | ${passed ? 'PASS' : 'FAIL_OR_INCOMPLETE'} |`).join('\n')}

Original automation assertions: ${Object.keys(r.assertions).length}, ${Object.values(r.assertions).filter(x => x.status === 'PASS').length} PASS and ${Object.values(r.assertions).filter(x => x.status === 'FAIL').length} FAIL. The rest of its normal sequence was aborted. Payout-continuation assertions: ${Object.keys(cleanup.checks).length}, all ${Object.values(cleanup.checks).every(x => x.status === 'PASS') ? 'PASS' : 'see cleanup.json'}. Final independent asset/accounting audit: ${audit.assetAndAccountingStatus}; original automation status remains ${r.status}. Failure reasons: ${r.error}; ${r.finalizationError}. The normal pre-shutdown helper repeat/A-B releases/final harvest were skipped; the receipt-repeat and A/B payment behaviors were exercised during post-return continuation, while the final canary harvest remained skipped. Earlier local environment/harness failures remain separately preserved in fork evidence and the pre-mainnet review; they are not mainnet transactions or retagged mainnet success.

The canary remains a disclosed recoverable variant with different bytecode and authority from production. This run is not an independent audit, a live multisig test, a production deployment or proof of identical production bytecode.
`;
await report(dir);
const base = fs.readFileSync(`${dir}/MAINNET_TEST_REPORT.md`, 'utf8').replace(/^Status:.*$/m, `Status: **PARTIAL — ORIGINAL AUTOMATION FAILED; BOTH MINERS RETURNED AND ACCOUNTING RECONCILED**. Evidence scope: **ACTUAL_BSC_MAINNET**. The original FAIL_OR_INCOMPLETE result and failed assertions are preserved. Total fees: ${formatEther(BigInt(audit.totalFeeRaw))} BNB. Final confirmed ownership block: ${audit.confirmedBlock}.`);
fs.writeFileSync(`${dir}/MAINNET_TEST_REPORT.md`, base + detail);
fs.writeFileSync('MAINNET_TEST_REPORT.md', base + detail);
const aggregate = JSON.parse(fs.readFileSync('reports/canary/results.json'));
aggregate.scope = 'ACTUAL_BSC_MAINNET_WITH_SEPARATE_LOCAL_AND_FORK_EVIDENCE';
aggregate.overall = overall;
aggregate.mainnet = { status: overall, runId: id, approval: 'APPROVED', directory: dir, transactions: txs.length, bnbSpentRaw: audit.totalFeeRaw, candidateDigest: m.candidateDigest, originalAutomationStatus: r.status, originalAssertions: r.assertions, cleanup: { status: cleanup.status, checks: cleanup.checks, diagnostics: cleanup.diagnostics, evidence: `${dir}/cleanup.json` }, finalSuccessConditions: success, finalConfirmedBlock: audit.confirmedBlock, finalBlockHash: audit.blockHash, finalOwners: audit.miners.map(x => ({ id: x.id, owner: x.owner, miningStatus: x.record.status })), finalLedger: l, postReturnPersonalIncome: r.observations.postReturn, independentAudit: `${dir}/final-audit.json`, approvalRecord: `reports/canary/approvals/${id}.json` };
save('reports/canary/results.json', aggregate);
const recoveryTests = JSON.parse(fs.readFileSync('reports/canary/recovery-test-results.json'));
recoveryTests.mainnet = { status: audit.checks.bothActualOwnersAreOriginalWallet && recovery.closed ? 'PASS' : 'FAIL', runId: id, evidence: `${dir}/recovery.json`, independentConfirmedOwnership: audit.miners.map(x => ({ id: x.id, owner: x.owner })), confirmedBlock: audit.confirmedBlock, closed: recovery.closed };
save('reports/canary/recovery-test-results.json', recoveryTests);
save(`${dir}/final-success-conditions.json`, { scope: 'ACTUAL_BSC_MAINNET', overall, originalAutomationStatus: r.status, originalFailedAssertions: Object.fromEntries(Object.entries(r.assertions).filter(([, value]) => value.status === 'FAIL')), skippedNormalFinalCanaryHarvest: true, conditions: success, independentAudit: `${dir}/final-audit.json` });
console.log(JSON.stringify({ overall, mainnetTransactions: txs.length, totalFeeBNB: formatEther(BigInt(audit.totalFeeRaw)), originalWallet: m.owner, finalConfirmedBlock: audit.confirmedBlock, finalOwners: audit.miners.map(x => ({ id: String(x.id), owner: x.owner })) }, null, 2));
