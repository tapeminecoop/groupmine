# SALUS audit remediation report: TapeoutMinerPool/2.2.0

Date: 2026-10-29. Candidate `TapeoutMinerPool/2.2.0` (package `2.2.0-rc.1`), branch
`claude/groupmine-salus-remediation-257c97`, starting from `c78a6d1234441137f8407fd30f904061ba792510`
(= `origin/main`, clean working tree). Subject: the SALUS Security "Code Security Assessment, Groupmine",
dated 2026-10-28, committed in `c78a6d1` as `Groupmine_audit_report_2026-10-28.pdf`
(sha256 `2ecddb8f2b6ebdf3fda56dd6b91dd71e7e68155e389eef03fc3247794c9b8b7a`).

This is an owner-authorized, pre-release remediation, done on local chains and local BSC forks only:
- Nothing was deployed to a public network, and no transaction was signed or broadcast.
- No real asset moved. No private key, wallet or `.env` was read; the canary's live entry points were not run.
- The public RPC `bsc-mainnet.public.blastapi.io` served only as the read-only source of local forks.

The remediated code has not been audited. Passing tests do not make it "audited" or "production
ready"; §10 asks SALUS to confirm the classification of finding #1 and to review the changes for #2
and #3.

Evidence: [`reports/salus-remediation-20261029-c78a6d1/`](../reports/salus-remediation-20261029-c78a6d1/):
the recorded `npm run verify` in `run/` (manifest, a log per step, every output), the generated
`assertions.json` (every requirement of the remediation brief mapped to the tests that cover it, with
its status computed from the run), the contract identity before and after, and the byte-for-byte check
of the historical evidence.

## 1. What SALUS reviewed, and what the code is now

The assessment's appendix lists six files "in commit c3cb933" with SHA-1 hashes. They are the plain SHA-1
of those files at `c3cb933` (not git blob ids), all six verified:

| File | SALUS SHA-1 | At `c3cb933` | At `c78a6d1` (before this change) |
| --- | --- | --- | --- |
| `TapeoutMinerPool.sol` | `0c42cad5…afc0` | match | changed (2.1.0 fee split) |
| `PoolMath.sol` | `41e288d8…9e58` | match | changed (2.1.0 fee split) |
| `TapeoutEntitlementReceipt.sol` | `7a69466d…5fea` | match | unchanged |
| `TapeoutReceiptDistributor.sol` | `7d54d145…3f84` | match | unchanged |
| `canary/RecoverableTapeoutMinerPool.sol` | `68f236c3…0917` | match | changed (canary-2, generated from 2.1.0) |
| `canary/CanaryParticipant.sol` | `a105b64b…94d1` | match | unchanged |

So SALUS reviewed the 2.0.0 accounting (100 : 1 : 1 of 102). Between `c3cb933` and `c78a6d1` came the
2.1.0 fee split (80 : 1 : 1 : 2 of 84 with the sink C, `8cf31dc`), its internal reviews and a
tooling-only remediation (`00e37c7`). The line numbers in SALUS's excerpts do not match the files
because the excerpts carry comments of their own; the code they quote is that of `c3cb933`. Each
finding was therefore mapped to `c78a6d1` before anything was changed (§2).

## 2. Every finding, mapped to the current code

| # | SALUS title (severity) | Where at `c3cb933` | At `c78a6d1` | In 2.2.0 | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | Rewards locked when all circuits are revoked before registration (Medium) | `PoolMath.accrue` / `_sync`: no composition, nothing recognized | unchanged (2.1.0 changed only the outer split) | no Solidity change; atomic admission proven by tests; unsupported path documented | ACCEPTED_OPERATIONAL_LIMITATION (confirmation requested) |
| 2 | Admission ordering allows depositors to influence reward allocation (Medium) | `_admit` step 5: carried income recognized under the post-batch composition | unchanged; with 105-BEM inputs the same 175 / 25 against 125 / 75 split arises under 80 : 1 : 1 : 2 | carried income attributed by each miner's own burn; fractional category ledger | FIXED_IN_CODE |
| 3 | Centralization risk (Medium) | owner powers in the receipts and distributor (`issue`, `allocate`, ...) | unchanged | custody (first admission) requires both issuances and the allocation final and all four contracts renounced; one-time distributor binding | FIXED_IN_CODE (post-initialization powers removed; setup-stage risk remains, §5.5) |
| 4 | Unbounded wallet revocation can prevent allocation corrections (Low) | `TapeoutReceiptDistributor.revokeWallet` | unchanged; the CLI refuses a revocation plan above about 1,550 IDs (largest-wallet gate) | not changed | OPEN_NOT_IN_SCOPE |
| 5 | Ownership transfer can prevent correction of over-issuance (Low) | `TapeoutEntitlementReceipt.retract` (issuer-held top IDs only) | unchanged | not changed; runbook: correct before any ownership move | OPEN_NOT_IN_SCOPE |
| 6 | Unsolicited receipt transfers can delay allocation finalization (Low) | `finalizeAllocation` requires `allocated == inventory` | unchanged | not changed; such a transfer still delays finalization (and with it activation and custody), it cannot alter an allocation | OPEN_NOT_IN_SCOPE |
| 7 | Missing events for functions that change critical state (Info) | `CanaryParticipant.bindPool` (canary only) | unchanged | not changed | OPEN_NOT_IN_SCOPE (canary only) |
| 8 | Magic numbers are used (Info) | `RecoverableTapeoutMinerPool.emergencyReturn` IDs 3204 / 12485 (canary only) | unchanged in the patch list | not changed (the reviewed patch list is kept as is) | OPEN_NOT_IN_SCOPE (canary only) |

The brief asked for the three Medium findings; the Low and Informational ones are mapped here so that
nothing is silently dropped, and were left for a separate decision.

## 3. Finding #1: accepted operational limitation

**SALUS's scenario.** Miners reach the pool by plain ERC-721 transfers, are revoked before anyone
registers them, and Mining's revocation pays their accrued BEM to the holder, the pool. A revoked miner
can never be registered (`MinerNotActive`), so no composition exists and `_sync` recognizes nothing: the
BEM stays unrecognized.

**Decision (owner).** That workflow is not supported, and no Solidity change was requested: no
administrator withdrawal, sweep, arbitrary registration or reward redirection was added. The supported
production procedure is:

1. A whitelisted wallet owns an ACTIVE miner.
2. It grants the ERC-721 approval.
3. It calls `depositMiners`.
4. The pool validates, transfers, registers and accounts for the miner atomically.
5. Any failure reverts the whole admission.

`registerMiners` is kept unchanged (it is the same `_admit` boundary for NFTs already held by the pool),
but documented as outside the production procedure (ARCHITECTURE.md §4.2, OPERATIONS.md §9, its NatSpec,
and a CLI warning on `register`). Unsolicited NFT transfers are not guaranteed to be recoverable,
registered or eligible for BEM.

**What the tests show** (test/salus/SalusAdmission.t.sol unless noted):

| Required | Test |
| --- | --- |
| atomic admission of an ACTIVE miner | `testAtomicAdmissionOfAnActiveMiner` (custody taken, registered, composition, carried income, events in one transaction); fork: `testForkCarriedIncomeIsAttributedPerMinerAndIndependentOfOrder` |
| revocation before admission makes it revert | `testRevocationBeforeAdmissionRevertsTheAdmission`; fork: `testForkInactiveMinerAdmissionRevertsAndStaysWithTheWallet` (a real non-ACTIVE miner) |
| a failed admission leaves the miner with the wallet | the two above, `testRolledBackAdmissionDoesNotAlterRegisteredTotalsOrAccounting`, `testMissingApprovalOrForeignOwnershipRevertsAtomically` |
| a failed admission changes no totals or accounting | `testRolledBackAdmissionDoesNotAlterRegisteredTotalsOrAccounting` (a hash of accrual, ledger, reconciliation, registry, periods, carried totals and the custody latch is identical; the old miner's income is still inside Mining) |
| a failing incoming Mining claim rolls everything back | `testIncomingRewardCollectionFailureRollsBackTheWholeAdmission`; `SalusCarriedIncome.testIncomingClaimFailureRollsBackTheCarriedAttribution`; invariant `rollbacksClean` |
| a first admission establishes the composition | `testInitialAdmissionEstablishesTheComposition` |
| a direct transfer registers nothing | `testDirectTransferDoesNotRegisterAMiner`; fork `testForkWhitelistAfterRenounceAndBypassRejection` |
| the unsupported scenario stays documented | `testUnsupportedDirectTransferThenRevocationLeavesItsIncomeUnrecognized` (no role can claim, release or withdraw it; a later valid admission books it as income of its own new period, never as carried income; the NFTs stay in custody), `testRegisterAfterPlainTransferBooksEarlierClaimsUnderTheCurrentComposition` |

One behaviour of the unsupported path changed with finding #2: BEM held before any composition existed
is now recognized after the first admission's carried income, as ordinary income of the new period,
under the first composition. Under 2.1.0 it was merged into that admission's carried income and split by
the same composition, so the amounts were the same in that case; only the label differs.

## 4. Finding #2: carried income attributed by the miner's own burn

### 4.1 The rule

Incoming miner income has two kinds:

- **Pre-admission carried income.** For an incoming miner that burned `n` NAND and `l` LATCH and whose
  own `Mining.claim` paid `r` BEM during its admission, the participants' part of `r` goes to NAND and
  LATCH as `n : l`, shared by all existing NAND and LATCH receipts. The depositor receives nothing.
- **Post-admission income** is split by the aggregate composition of all registered miners, which keeps
  changing as miners are admitted. There are no fixed lifetime ratios.

The outer split is unchanged: displayed 100 : 1.25 : 1.25 : 2.5, on chain 80 : 1 : 1 : 2 of 84, each part
its own floor of `T` (carried income included), C the fixed sink `0x…dEaD` paid with every release of A
or B. No fee, denominator or C policy changed.

### 4.2 Why a new representation was needed

The 2.1.0 ledger kept whole raw units per category (`nandBase`, `latchBase`) and carried only the one
unassigned participant unit across checkpoints. Splitting each miner's carried income with an
independent floor in that representation would make the result depend on how the same miners are split
into transactions: two 1:2 miners carrying 21 raw units each would give NAND 6 + 6 = 12 one by one and
13 together. The brief rules that out ("avoid repeated independent floors ... implement a persistent
fractional remainder or a different representation"). 2.2.0 therefore keeps the categories in a
**fractional ledger**:

- Unit: 1 / `LEDGER_UNIT` raw BEM, `LEDGER_UNIT = 84 · 10^18`. The participants' share of `x` raw units
  is exactly `u(x) = x · 80 · 10^18` units, so it never needs rounding.
- Every split gives NAND `⌊units · n / (n + l)⌋` and LATCH the rest: nothing is lost, and the asymmetry is
  below one ledger unit (1.2 · 10^-20 BEM) per split.
- Category incomes shown and paid are `⌊units / LEDGER_UNIT⌋`; per-share values as before.

### 4.3 The accounting boundary

`_admit` (TapeoutMinerPool.sol) now runs:

1. validate the batch and read each miner's authoritative burn (record, cache cross-check, ACTIVE);
2. `_sync`: BEM already held, under the old composition;
3. `_settleOld` for every registered miner (strict; REVOKED skipped), then `_sync` under the old composition;
4. `_checkpoint`: freeze the old period's NAND and LATCH ledger units (`accountedBase = T`);
5. transfer (deposit) and register the batch;
6. `_collectCarried`: claim each incoming miner on its own; its carried income is the pool's exact
   balance increase from that claim (never `pending()`), recorded in the miner's entry and split by its
   own burn (`PoolMath.carriedUnits`); the batch total is recognized at the boundary (`T` and
   `accountedBase` move together, the ledger bases take the units);
7. add the batch to the composition;
8. `_sync`: anything else held (only possible at a first admission) as ordinary income of the new period.

No `_sync` runs between a carried claim and its attribution, so the aggregate composition can never
split carried income. The boundary separates, and the contract exposes, each quantity the brief lists:

| Quantity | Where |
| --- | --- |
| old-period recognized income | `CompositionCheckpoint(period, totalAccounted, nandBaseUnits, latchBaseUnits)` and `ledgerState().accountedBase` at the boundary |
| incoming per-miner carried income | `miner(id).carriedIncome`, `CarriedIncomeAttributed(tokenId, received, nandUnits, latchUnits)`, cumulative `carriedIncome` and `carriedNandUnits` |
| new-period ordinary income | `T − accountedBase`, split by `ledgerState()`'s composition (`PoolMath.categoryUnits`) |
| A/B/C cumulative entitlements | `accrual()` (`⌊T/84⌋`, `⌊T/84⌋`, `⌊2T/84⌋`), paid counters, unchanged |
| NAND/LATCH cumulative entitlements | `accrual().nandIncome/latchIncome` from the ledger units |
| per-receipt unpaid balances | `claimable(category, id) = perShare − claimed[category][id]`, unchanged |
| rounding residue | `reconciliation().residue`, bound unchanged (§4.5) |

The cumulative formula is not "re-counted": carried income enters `T` once (with its units), and the
ordinary formula only ever splits `T − accountedBase`, which starts at zero right after the carried
attribution. Conservation (`bemBalance = (T − totalPaid) + unrecognized`, `T = A + B + C + receipts +
residue`), monotonic entitlements and the rule that claimed BEM never becomes claimable again are
unchanged and are checked by the invariants (§7.2).

### 4.4 Order and partition independence

A carried split is a function of the miner's `(r, n, l)` only, and the ledger adds entries. Hence, for
the same miners at the same timestamp:

- **batch order**: any order inside a batch gives the identical ledger (to the ledger unit);
- **sequential admissions** with no intervening accrual: each later admission's checkpoint finds no new
  ordinary income (`T = accountedBase`), so the ledger after X then Y equals Y then X equals {X, Y}, to
  the ledger unit; only the period counter and the registry order differ;
- **partitions**: two batches equal one batch.

This holds at raw-token precision with no documented exception: there is no residual discrepancy to
quantify, because the representation never floors anything that a different partition would floor
differently. (Income a miner earns after its admission is ordinary income of the pool and correctly
goes by the aggregate composition; that is "intervening accrual", which the brief excludes.)

The SALUS example: X (10 : 0, 105 BEM) and Y (5 : 5, 105 BEM) give NAND 150, LATCH 50 in all four orders
(X then Y, Y then X, {X, Y}, {Y, X}), and later income splits 15 : 5. Under 2.1.0 the same inputs gave
175 / 25 or 125 / 75.

### 4.5 Rounding

- Outer floors: unchanged, at most 3 raw units.
- Categories: `nandUnits + latchUnits = u(T)` exactly, so the two raw-unit floors leave at most one
  participant unit (as before).
- Per share: at most `S − 1` per collection (as before). Residue bound `4 + (S_N − 1) + (S_L − 1)`, unchanged.
- Against the exact rational entitlements, each category is within one raw unit (NAND never above, LATCH
  above only by the ledger floors, under 10^-17 raw units in any realistic history).
- **Superseded behaviour.** 2.1.0 froze whole units at checkpoints, so same-ratio admissions could shift
  lifetime category totals (documented in test/remediation/RoundingPolicy.t.sol: NAND 0 / LATCH 8 with
  checkpoints against 3 / 6 without, pending the owner's acceptance). 2.2.0 gives 3 / 6 both ways, and
  that test now asserts it. In a single period, 2.2.0 splits the exact share `80T/84` where 2.1.0 split
  `⌊80T/84⌋`, so a category can receive one raw unit more than under 2.1.0 (T = 45 at 3 : 1: NAND 32,
  LATCH 10 instead of 31, 10).
- Range: the ledger multiplies by `80 · 10^18` and by the composition. Totals stay exact below about
  `2^256 / (8 · 10^19 · (N + L))`, over 10^44 raw units for any registry the pool can hold, against
  BEM's maximum supply of 2.1 · 10^15 raw units; beyond it arithmetic reverts (checked), it never wraps.

### 4.6 Tests for finding #2

Expected values come from the specification's arithmetic written in each test, the independent Python
model, or real-protocol observations, never from `PoolMath`:

| Required | Tests |
| --- | --- |
| NAND-only, LATCH-only, mixed miner | `SalusCarriedIncome.testSingleNandOnlyMiner`, `testSingleLatchOnlyMiner`, `testSingleMixedMiner` |
| several miners in one batch; reversed batch order | `testReversedBatchOrderGivesTheSameLedger`, `testFuzzCarriedAttributionIsIndependentOfOrderAndPartition` (512 runs), fork `testForkCarriedIncomeIsAttributedPerMinerAndIndependentOfOrder` (four real miners) |
| reversed sequential order; sequential equals batch | `testReversedSequentialOrderAndBatchGiveTheSameLedger`, `testSalusExampleIsIndependentOfAdmissionOrder`, the fuzz test, the fork test |
| zero / positive carried income | `testZeroCarriedIncome`, `testPositiveCarriedIncomeIsRecordedPerMinerWithItsUnits` |
| `pending() == 0` followed by a positive claim | `testPendingZeroButPositiveClaimIsAttributedByTheActualBalanceDelta`; fork: every incoming real miner paid more than its `pending()` just before (e.g. #6940: 309,775 raw by `pending()`, 779,328 paid) |
| existing pool income before admission | `testExistingPoolIncomeBeforeAdmissionStaysWithTheOldComposition`; fork `testForkBoundaryWithThreeOldMinersAndAnIncomingBatch` |
| old miners with income; several, strict settlement | `testMultipleExistingMinersSettleStrictlyUnderTheOldComposition`; fork boundary tests |
| new Mining claim failure, complete rollback | `testIncomingClaimFailureRollsBackTheCarriedAttribution` |
| very small raw amounts; fractional boundaries | `testVerySmallRawAmountsAccumulateExactly` (21 one-unit miners: 10 / 10 in one batch and one by one), `testFractionalAllocationAndRoundingBoundaries` |
| receipt transfers before and after; repeated claims | `testReceiptTransfersBeforeAndAfterAdmissionAndNoDoublePayment` |
| A/B/C and sink settlement | `testABAndSinkAccrueOnCarriedIncomeAndSettleOnRelease` |
| independent reconciliation of the five accounts | `testFiveRevenueAccountsReconcileIndependently` |
| independent reference model | test/salus-ffi/model.py with `SalusDifferential.testFuzzLedgerMatchesTheSalusReferenceModel` and `testSalusExampleMatchesTheModelInEveryOrder` |
| actual protocol on an isolated fork | test/fork/SalusFork.t.sol and the updated PoolFork / PoolBoundary tests, at BSC block 128,713,128 |

The reference model (`test/salus-ffi/model.py`) is written from the rule, not from the contract, and is
formulated differently: it keeps a list of ledger entries (each closed composition period, each carried
miner) and recomputes every category amount from scratch, with exact `Fraction` arithmetic for the ideal
split. The differential test replays random traces (preparing miners with visible or pending-hidden
carried income, batch admissions in random order, accruals, harvests, third-party claims, donations,
revocations, claims, receipt transfers, releases) against the contracts and the model and compares
every ledger quantity, per-ID history and account balance.

## 5. Finding #3: custody only after permanent initialization finality

### 5.1 The requirement

Once real miner custody begins, no privileged account may still be able to change receipt supply, alter
the distribution or administer the initialization. The first successful `depositMiners` or
`registerMiners` requires:

| Contract | Required at the first admission |
| --- | --- |
| NAND receipt | `issuanceFinalized()`, `owner() == address(0)`, supply equal to the pool's `S_N` |
| LATCH receipt | `issuanceFinalized()`, `owner() == address(0)`, supply equal to the pool's `S_L` |
| Distributor | `allocationFinalized()`, `owner() == address(0)` |
| Pool | activated (receipts and supplies verified), `owner() == address(0)` |

Ordinary receipt transfers, delivery of finalized allocations, whitelisted admissions, harvests, BEM
claims and A/B releases continue without any owner.

### 5.2 Design: the smallest enforceable binding

The distributor holds an immutable reference to the pool, but the pool had none to the distributor, so
it could not check the distributor's finality. 2.2.0 adds, in the pool only:

- **`bindDistributor(address)`**, owner-only, **once**, before activation. The distributor must be a
  contract reporting this pool and these receipts. There is no setter, replacement or unbinding; after
  binding (and so after activation) it reverts `DistributorAlreadyBound`.
- **`activate`** additionally requires a bound distributor (`DistributorNotBound`) whose allocation is
  finalized (`AllocationNotFinalized`). Activation already required finalized issuance and the reviewed
  supplies, so after it the finalizations and supplies are fixed (each is irreversible).
- **`_openCustody`**, run by the first admission: the pool's own owner, both receipts' owners and the
  distributor's owner must be zero (`OwnershipNotRenounced(contract)`), then `custodyOpen` latches
  (`CustodyOpened`). Renounced ownership cannot return (Ownable2Step clears a pending transfer on
  renouncing), so later admissions do not read those contracts again: renouncing adds no liveness
  dependency (`testLaterAdmissionsAfterRenunciationNeedNoFurtherChecks` makes those reads revert and
  admits anyway).

Not added: no proxy, upgrade, mutable role, arbitrary call, or replaceable distributor. The receipts and
the distributor are unchanged (sources byte-identical; the distributor's bytecode differs only in the
compiler metadata, since it imports the pool). The pool never calls `renounceOwnership` on anything
(`testSuccessfulAdmissionAfterEveryConditionAndNoRenunciationByThePool` asserts zero such calls).

The checks that activation already makes irreversible (issuance finalized, supplies, allocation
finalized) are not repeated by the gate: they cannot change after activation, and the bytes were needed
to keep the pool and the generated canary under the EIP-170 limit (a first draft that re-read them and
exposed the ledger bases as separate getters left 786 bytes for the pool, which would have put canary-3
over the limit; the final pool leaves 1,408 and canary-3 137).

### 5.3 Operator workflow (implemented order)

1. deploy both receipts; 2. issue and verify; 3. deploy the pool and the distributor; 4. fund the
distributor; 5. finalize issuance; 6. import, verify and finalize the allocation; 7. bind the
distributor; 8. activate with the verified supplies; 9–11. renounce the NAND receipt, the LATCH receipt,
the distributor and the pool (any order); 12. `finality` must report `READY_FOR_FIRST_ADMISSION`;
13. the first admission. Finalizing issuance before the allocation is required by the existing
dependency (the distributor's `finalizeAllocation` requires finalized issuance), and binding happens
after allocation finalization so that activation can check it; this is the brief's order with steps 6
and 7 placed as the existing contracts require.

Tooling cannot bypass it: `bind-distributor` and `activate` preflight the same conditions; `deposit` and
`register` refuse to plan before custody is open unless every condition holds (listing what is missing);
`renounce` refuses to renounce a contract before its own finalization; `inspect` and `finality` show the
state; and the contract enforces all of it regardless of tooling (the local run sends a deposit that
bypasses the CLI and observes `OwnershipNotRenounced`).

### 5.4 Tests for finding #3 (test/salus/SalusFinality.t.sol)

| Required | Test |
| --- | --- |
| NAND / LATCH issuance not finalized | `testNandIssuanceNotFinalizedBlocksCustody`, `testLatchIssuanceNotFinalizedBlocksCustody` (allocation and activation impossible, admission `NotActive`) |
| NAND / LATCH owner not zero | `testNandOwnerNotRenouncedBlocksTheFirstAdmission`, `testLatchOwnerNotRenouncedBlocksTheFirstAdmission` |
| distributor allocation not finalized | `testDistributorAllocationNotFinalizedBlocksActivationAndCustody` |
| distributor owner not zero | `testDistributorOwnerNotRenouncedBlocksTheFirstAdmission`, `testCompletedOwnershipTransferKeepsCustodyClosed` |
| pool not activated | `testPoolNotActivatedBlocksAdmission` |
| pool owner not zero (adopted as a mandatory gate) | `testPoolOwnerNotRenouncedBlocksTheFirstAdmission` (deposit and register) |
| incorrect distributor binding | `testIncorrectDistributorBindingIsRefused` (non-contract, another pool's distributor, wrong receipts, non-owner, twice, after activation, activation unbound) |
| incorrect receipt addresses | `testIncorrectReceiptAddressesAreRefused` |
| incorrect finalized supplies | `testIncorrectFinalizedSuppliesAreRefused` |
| success after every condition | `testSuccessfulAdmissionAfterEveryConditionAndNoRenunciationByThePool` |
| later admissions after renunciation | `testLaterAdmissionsAfterRenunciationNeedNoFurtherChecks` |
| receipt transfers; delivery after the distributor's renunciation; BEM claims and A/B/C releases after the pool's | `testReceiptsDeliverTransferAndClaimWithoutAnyOwner` |
| no post-initialization power | `testNoPrivilegedPowerRemainsAfterInitialization` (issue, retract, setURI, allocate, revokeWallet, activate, bindDistributor, transferOwnership all refused) |
| pending / completed ownership transfers | `testPendingOrCompletedOwnershipTransfersAreHandled`, `testCompletedOwnershipTransferKeepsCustodyClosed` |
| the pool cannot authenticate the distributor's code | `testBindingChecksReportedViewsNotCode` (documented limit, §5.5) |
| real protocol | fork `testForkFinalityGateOnRealProtocol` (refused after each of the four renunciations in turn until the last, then admitted) |
| any order of the setup steps | invariant campaign `SalusFinalityInvariantTest` (§7.2) |

### 5.5 Scope of the guarantee

After custody begins nobody can mint, burn or reissue receipts, change the distribution, replace the
distributor, or administer the pool. This does **not** remove setup-stage risk: until they finalize and
renounce, the issuer and distributor keys can issue and allocate, and a compromised or mistaken key
could do so wrongly (a multisig during initialization remains a sensible protection). Finality does not
prove that the off-chain fundraising records or the beneficiary JSON were correct, and a zero owner does
not retroactively authenticate the allocations; `verify-allocation` checks the artifact against the
chain and the reviewed JSON, not the truth of the contributions. The pool checks what the bound
distributor reports, not its code (its immutables differ per deployment); the operator's deployed-code
identity check (`verify-deployment`, run before every write command) is what proves the bound contract
is the reviewed distributor, and it now also checks the pool's binding.

## 6. Exact changes

### 6.1 Solidity (`src/`)

- **`PoolMath.sol`**: `LEDGER_PRECISION`, `LEDGER_UNIT`; `State` becomes `{accountedBase, nandBase,
  latchBase, totalNandBurn, totalLatchBurn, nandShares, latchShares}` with bases in ledger units;
  `accrue` uses `categoryUnits`; new `carriedUnits` and `participantUnits`. The outer split code is
  unchanged.
- **`TapeoutMinerPool.sol`**: `VERSION = "TapeoutMinerPool/2.2.0"`; `bindDistributor`; `activate`'s two new
  checks; `_openCustody` and `custodyOpen`; `_collectCarried`; the reordered `_admit`; `_checkpoint` on
  ledger units; `ledgerState()` (replaces `state()`); `Miner.carriedIncome` (`uint120`, packed into the
  record's second slot; a larger delta reverts); `carriedIncome`, `carriedNandUnits`; events
  `DistributorBound`, `CustodyOpened`, `CarriedIncomeAttributed`, and the new `CompositionCheckpoint` and
  `MinersAdmitted` (adds `newPeriodIncome`) layouts; errors `DistributorAlreadyBound`,
  `InvalidDistributor`, `DistributorNotBound`, `AllocationNotFinalized`, `OwnershipNotRenounced`.
- **`interfaces/IReceiptDistributor.sol`** (new): the five distributor views the pool reads.
- **`TapeoutEntitlementReceipt.sol`, `TapeoutReceiptDistributor.sol`, `IMining.sol`,
  `canary/CanaryParticipant.sol`**: unchanged.
- **`canary/RecoverableTapeoutMinerPool.sol`**: regenerated as the local-only
  `RecoverableTapeoutMinerPool/canary-3-local` (§6.5).

### 6.2 ABI, storage, deployment

| | Change |
| --- | --- |
| Added | `bindDistributor(address)`, `distributor()`, `custodyOpen()`, `ledgerState()`, `carriedIncome()`, `carriedNandUnits()`, `LEDGER_UNIT()`; events `DistributorBound`, `CustodyOpened`, `CarriedIncomeAttributed`; five errors |
| Removed | `state()`, `nandBase()`, `latchBase()`, `participantBase()` (a 2.1.0 consumer calling them now fails instead of misreading) |
| Changed layouts | `miner(uint256)` (adds `carriedIncome`), `CompositionCheckpoint` (ledger units, no `participantBase`), `MinersAdmitted` (adds `newPeriodIncome`) |
| Unchanged layouts | `accrual()`, `previewAccrual()`, `reconciliation()`, `depositMiners`/`registerMiners` returns; their values differ where carried income or a checkpoint fraction is involved |
| Storage | `distributor` and `custodyOpen` share slot 8 with `active`/`activatedAt`; `accountedBase`, `nandBaseUnits`, `latchBaseUnits` (private) replace the three bases; `carriedIncome`, `carriedNandUnits` new; later slots shift (irrelevant without an upgrade path) |
| Distributor, receipts | ABI identical |

**A new deployment is required**, of all four contracts: there is no upgrade path, the receipts are bound
in the pool's constructor and the pool in the distributor's. Nothing exists to migrate (nothing of
2.1.0 or 2.2.0 was deployed to mainnet). No previously reviewed deployment manifest applies to this
bytecode; the example files under `deployments/examples/` are placeholders.

### 6.3 Tooling

- **SDK** (`sdk/`): `math.ts` mirrors the ledger (`categoryUnits`, `carriedUnits`, `checkpoint`, `admit`);
  `pool.ts`: `READ_LAYOUT_VERSIONS = ['TapeoutMinerPool/2.2.0']` (2.1.0 is now refused),
  `LOCAL_CANARY_LAYOUT_VERSIONS = ['…/canary-3-local']`, `readPoolSummary` reads `ledgerState`, the
  binding, custody and carried totals, `checkReconciliation` adds the ledger identities and carried
  checks, new `checkCarriedRecords` (every miner's record re-split and summed), `readFinality`,
  `bindDistributorPlan`; `deployment.ts` checks the pool's bound distributor; `gas.ts` adds the
  `bindDistributor` bound (150,000) and `FIRST_ADMISSION_GAS` (150,000, added to the plan of the admission
  that opens custody, §7.3); `abi.ts`/`bytecode.json` regenerated from the tested build.
- **CLI**: new `bind-distributor` and `finality`; `activate` checks the binding and the finalized
  allocation; `deposit`/`register` refuse to plan before finality, size the first admission's batch and
  gas bound with the custody allowance, and `register` warns that it is not the supported path; `inspect`
  shows finality and carried totals; `reconcile --deep` checks every carried record; `preview` uses the
  new state.
- **Scripts**: `local-e2e.ts`, `fork-e2e.ts`, `fork-safe-e2e.ts`, `largest-wallet-check.ts` follow the new
  initialization (binding, all four renunciations) and the new arithmetic; `fork-test.ts` expects 20 fork
  tests; `verify-all.ts` adds the `salus-differential` FFI step and formats `test/salus*`;
  `contract-identity.ts` lists the new interface; the canary generator and workflow (§6.5).
- **Package**: `2.2.0-rc.1`; dependencies unchanged.

### 6.4 Tests

New: `test/salus/` (SalusAdmission 9, SalusCarriedIncome 18, SalusFinality 18, SalusFinalityInvariant 2
invariants), `test/salus-ffi/` (differential, 2 tests, with `model.py`), `test/fork/SalusFork.t.sol`
(3 fork tests). Updated where the semantics intentionally changed, each marked in place:

| File | What changed and why |
| --- | --- |
| `test/helpers/SystemTestBase.sol` | `activate()` binds, finalizes the (possibly empty) allocation, activates and renounces all four owners; `activateKeepingOwners`, `renounceAll` |
| `test/unit/PoolAdmission.t.sol` | the acceptance example (NAND 100 / LATCH 100 instead of 140 / 60), batch, first-admission and plain-transfer expectations: superseded carried-income rule |
| `test/unit/PoolAccounting.t.sol` | checkpoint test on ledger units (same raw values), fuzz properties against exact rationals |
| `test/unit/PoolFeeSplit.t.sol` | `ledgerState`; the boundary test's carried income goes by the LATCH-only miner's own burn |
| `test/unit/PoolSetup.t.sol`, `Distributor.t.sol`, `GasModel.t.sol`, `CanaryRecovery.t.sol` | the new initialization order (binding, allocation before activation, renunciation before admission); version string; the canary boundary values |
| `test/remediation/RoundingPolicy.t.sol` | the documented 2.1.0 checkpoint drift is gone; it now asserts the equal totals |
| `test/invariant/PoolInvariant.t.sol` | the model recomputes categories from an entry list; shuffled batch order; new invariants (§7.2) |
| `test/fork/*` | initialization; expected values by the new rule, computed from observations; the gas scaling test asserts each admission fits the CLI's planned bound |
| `test/audit/` (review suite) | `model.py`'s category ledger and admission, and setup in `AuditReceiptEdges` |
| `test/audit2/` (review suite) | `FeeSplitLedger`'s reference ledger, `FeeSplitBoundary`'s checkpoint test and range, `FeeSplitCallbacks`'s owner assertion, `fee-split-consumers.test.ts`'s independent `incomes` |
| `test/sdk/` | 2.2.0 state shape, read-layout versions, canary-3, new plan and reconciliation tests |

Expectations whose behaviour is unchanged were kept, including every outer-split, sink, release, claim,
delivery, whitelist, REVOKED-skip and receipt test.

### 6.5 Canary

The canary is generated from the production pool by `scripts/canary/build-source.mjs`, so 2.2.0 yields
the local-only `RecoverableTapeoutMinerPool/canary-3-local`. The patch list is unchanged except one
import path (the new interface), so the test-only recovery restrictions are preserved: immutable
recovery controller, permanent `shutdown`, `emergencyReturn` limited to #3204 and #12485 with no Mining
or BEM call, closed checks on admission and harvest. The adaptation diff is in
`reports/canary-local/canary-3-production-canary.diff`; canary-2's diff and every canary-1 record under
`reports/canary/` are untouched, and the approved path (`prepare`, `fork`, `live`, `verify-local`) still
stops at its `c4bc022` pin. The workflow binds the distributor before activation and attributes #12485's
carried income by its own 1:1 burn in its independent arithmetic. Bytecode, reported separately:
canary-3 runtime 24,439 bytes (canary-2: 22,074), 137 bytes under EIP-170. Nothing about canary-3 is
approved for mainnet.

### 6.6 Contract identity

From `scripts/contract-identity.ts`, `c78a6d1` (a fresh build of `git archive c78a6d1`) against the tested
tree (`contract-identity-compare.json`):

| Contract | ABI | Code | Runtime / initcode (bytes) |
| --- | --- | --- | --- |
| `TapeoutEntitlementReceipt` | same | identical | 8,743 / 10,361, unchanged |
| `TapeoutReceiptDistributor` | same | identical except trailing compiler metadata | 7,680 / 8,289, unchanged |
| `TapeoutMinerPool` | changed | changed | 20,777 → 23,168 / 32,685 → 35,118 |
| `PoolMath` | same | identical except trailing compiler metadata | 58 / 87, unchanged |
| `IMining` | same | identical | interface |
| `IReceiptDistributor` | new | new | interface |
| `RecoverableTapeoutMinerPool` | changed | changed | 22,074 → 24,439 / 34,074 → 36,481 |
| `CanaryParticipant` | same | identical except trailing compiler metadata | 3,410 / 3,838, unchanged |

`contract-identity-compare.json` reports `DIFFERENT`, as intended; `package-lock.json` differs only in the package version.

Compiler, settings and dependencies are unchanged.

## 7. Verification

### 7.1 The recorded run

All results below are **fresh**, from the recorded run (`run/run-manifest.json`) on the final source tree.

| Step of the recorded run | Result | Detail |
| --- | --- | --- |
| Build sizes | PASS | TapeoutEntitlementReceipt: runtime 8,743 B (margin 15,833), initcode 10,361 B (margin 38,791); TapeoutMinerPool: runtime 23,168 B (margin 1,408), initcode 35,118 B (margin 14,034); TapeoutReceiptDistributor: runtime 7,680 B (margin 16,896), initcode 8,289 B (margin 40,863) |
| SDK ABI/bytecode match the tested build | PASS | export leaves `sdk/abi.ts` and `sdk/bytecode.json` unchanged |
| Formatting (`src`, `script`, `test/{unit,invariant,fork,helpers,remediation,salus,salus-ffi}`) | PASS | |
| Solidity unit, fuzz, invariant, remediation, review-2 (`test/audit2`) and SALUS suites | PASS | 226/226 passed |
| Gas model (bounds as transaction gas limits) | PASS | 11 tests |
| Internal review suite with its Python model (`--ffi`) | PASS | 10/10 passed |
| SALUS differential test against the independent model (`--ffi`) | PASS | 2/2 passed (300 fuzz runs + the SALUS example in three orders) |
| Internal review TypeScript tests | PASS | 13/13 passed |
| SDK tests | PASS | 78/78 passed |
| TypeScript typecheck | PASS | no errors |
| Local Anvil end to end (CLI, mock protocol) | PASS | 59 checks, 47 local transactions |
| Largest-wallet check | PASS | revocation FITS_ONE_TRANSACTION |
| Fork tests on real BSC state | PASS | 20/20 passed, block 128,713,128 (`0x760f050b…081f`) |
| Fork end to end (CLI, real Mining and BEM) | PASS | 25 checks, 35 local-fork transactions |
| Safe end to end (real Safe contracts) | PASS | 266 checks, 25 Safe transactions |
| Canary-3 local rehearsal (complete; interrupted with standalone recovery) | PASS | complete run: 46/46 assertions PASS; interrupted run: 9/9 PASS, then standalone recovery; two local forks of block 128,812,145 (`0x383f1f97…a922`) |
| Slither | SKIPPED | SLITHER not set (§7.4) |
| Contract identity recorded (compared separately with `c78a6d1`) | PASS | |

Overall: every executed step **PASS**; the manifest's `overall` is `INCOMPLETE` because the Slither step was skipped. Tested tree `sourceTreeSha256` `c464fe4bc89a9e1fd0de0943577458980b8231d2a33e6594b83373b442d87874` (163 files, base `c78a6d1`, 58 uncommitted changes outside `reports/`, i.e. this change). `assertions.json`: 63 requirement entries, 63 PASS.

### 7.2 Invariants

| Required invariant | Where |
| --- | --- |
| 1. carried-income allocation independent of admission order | `PoolInvariantTest.invariantCarriedIncomeIsIndependentOfAdmissionOrder` (pool's carried units equal the order-free sum of per-miner splits, with batches admitted in shuffled order), the order/partition fuzz test, the fork order test |
| 2. no double recognition of incoming BEM | `invariantModelMatchesTheLedger` (recognized total and ledger units equal the entry model's), `invariantRecognitionPaymentsAndLedgerIdentity` (recognized ≤ arrived, carried ≤ recognized) |
| 3. correct cumulative A/B/C | `assertReconciled` inside `invariantFourAccountConservation` (`A = B = ⌊T/84⌋`, `C = ⌊2T/84⌋`, `C_paid ≤ C`), the release handler's own check |
| 4. total paid never exceeds recognized | `invariantRecognitionPaymentsAndLedgerIdentity` (each bucket and the total) |
| 5. receipt entitlement monotonicity | `invariantEntitlementsNeverDecrease` |
| 6. previous paid histories valid | `invariantPerIdHistories` (each history ≤ its per-share value, sums equal) |
| 7. failed admission rolls back completely | handler `rollbacksClean` (state hash, NFT owners, registration) inside `invariantModelMatchesTheLedger` |
| 8. no first admission before finality and renunciation | `SalusFinalityInvariantTest.invariantNoAdmissionBeforeFinality` and `invariantCustodyOpensOnlyWithItsFirstAdmission` (setup steps in any order, premature renunciations, ownership hand-overs, extra issuance; every success checked against the conditions, and a final pool must admit) |
| 9. continued operation after renunciation | the main campaign runs entirely with every owner renounced (`invariantCustodyOnlyAfterFinality`); `fail_on_revert` makes any unexpected revert fail |
| 10. BEM conservation including residue | `invariantFourAccountConservation` (balance identity and payees' balances) |

Both campaigns of the main suite (`PoolInvariantTest`, `PoolInvariantCoverageTest`) and the finality campaign ran 256 runs of 64 calls per invariant, with `fail_on_revert`. Admission paths exercised in the main campaigns (from the run's coverage log): 5,566 successful admissions in 2,251 of 2,313 runs, 1,606 rolled-back admissions in 821 runs, up to 12 registered miners. The finality campaign's own coverage was measured separately on the same code (outside the recorded run, with `FINALITY_COVERAGE_LOG`): custody opened in 269 of 514 runs (1,762 admissions), 1,914 admission attempts refused, no violation.

### 7.3 Gas

| Measurement (gas used) | 2.1.0 (recorded at `a74f6d4`) | 2.2.0 (this run) | Planned bound (`sdk/gas.ts`) |
| --- | ---: | ---: | ---: |
| First admission of one real miner, cold accounts (`testForkAdmissionGasScaling`) | 398,165 | 514,781 | 550,000 + 150,000 (opens custody) |
| Admission with 1 / 10 / 23 registered real miners | 317,601 / 507,462 / 867,819 | 267,511 / 517,144 / 877,605 | 580,000 / 850,000 / 1,240,000 |
| Largest marginal gas per registered miner (real Mining) | 27,849 | 27,857 | 30,000 |
| First deposit sent by the CLI on the BSC fork (transaction) | – | 538,382 | 700,000 |
| First deposit sent by the CLI, local Anvil (mock protocol) | – | 433,943 | 700,000 |
| `bindDistributor` (`GasModel`) | – | 53,054 | 150,000 |
| `activate` (`GasModel`) | 109,668 | 98,212 | 250,000 |
| Pool deployment, 16 depositors (`GasModel`) | 5,670,339 | 6,186,332 | 7,000,000 |

The fork scaling test now asserts that every measured admission plus 25,000 for the base and calldata fits the CLI's bound. Before the first-admission allowance was added, the bound for a first admission of one miner was 550,000 against 538,382 used by the CLI transaction on the fork: the measurement in the first full run that prompted the change. Every later admission costs about 9.7k more than under 2.1.0 (the per-miner balance read, the attribution event and the ledger writes), within the model.

### 7.4 Static analysis

Slither was **not executed**: it is not installed on this machine (no `slither`, `pipx` or `uv` found)
and installing it would download third-party packages, which was not authorized. The recorded run lists
the step as `SKIPPED`. No static-analysis result is claimed for 2.2.0. To run it:
`SLITHER=<path to slither> npm run verify` (the previous runs used Slither 0.11.3).

### 7.5 Historical evidence

`historical-unchanged.json`: 431 files tracked at `c78a6d1` under the review reports, `MAINNET_TEST_REPORT.md`, the SALUS PDF, `proposed-patches/` and `reports/` (canary-1 records, the 2.0.0 outputs, every earlier run directory, canary-2's diff) are byte-identical after the run (IDENTICAL). The recorded run wrote into `reports/`; its outputs were copied into the evidence directory and the tracked files restored. New under `reports/`: the evidence directory and `reports/canary-local/canary-3-production-canary.diff`.

## 8. Preserved architecture

| Requirement | Status in 2.2.0 |
| --- | --- |
| two independent ERC-1155 receipt collections, unique sequential IDs, supply one per ID | unchanged (receipt source identical) |
| equal entitlement within a category, fixed denominators | unchanged |
| unpaid BEM follows the receipt; paid history keyed to category and ID | unchanged |
| JSON allocation, permissionless delivery to the fixed beneficiary | unchanged (distributor source identical) |
| whitelisted admission, strict old-miner settlement, the REVOKED exception | unchanged |
| 80 : 1 : 1 : 2, C's fixed sink, A/B-triggered atomic C payment | unchanged |
| no miner withdrawal, upgrade or arbitrary call; no further fundraising round | unchanged |

## 9. Open items

- **External review** of 2.2.0 (§10). Not audited.
- **Slither** not executed (§7.4).
- **Low and informational findings 4–8**: not addressed by this change (§2); separate decisions.
- **Deployment and launch inputs**: no mainnet deployment, no reviewed deployment manifest for 2.2.0, no
  real allocation JSON, wallet types or maximum inventory reviewed.
- **Canary-3**: local rehearsal only; no approval for any live run.
- **Owner acceptance**: the classification of finding #1 as an accepted operational limitation, and the
  intentionally changed rounding (one raw unit in a single period, §4.5), are owner decisions recorded
  here, not signed off on the owner's behalf.

## 10. Request to SALUS

We ask SALUS to review the following and confirm:

1. **Finding #1** is classified as an *accepted operational limitation*, not a code fix: only atomic
   `depositMiners` of ACTIVE miners by whitelisted wallets is supported; direct transfers followed by
   `registerMiners` are documented as unsupported, with no recovery or redirection mechanism by design.
   The atomic-admission tests are listed in §3.
2. **Finding #2** is resolved by attributing each incoming miner's carried income by its own burn in a
   fractional ledger (§4), making the outcome independent of admission order and batching at raw-token
   precision.
3. **Finding #3** is resolved for post-initialization powers by the custody finality gate and the
   one-time distributor binding (§5); the setup-stage risk and the off-chain verification of the bound
   distributor's code remain, as stated in §5.5.

Code: `src/TapeoutMinerPool.sol`, `src/PoolMath.sol`, `src/interfaces/IReceiptDistributor.sol` (the receipt
and distributor are unchanged since `c3cb933`). Tests: `test/salus/`, `test/salus-ffi/`,
`test/fork/SalusFork.t.sol`.

## 11. Reproduce

```bash
npm ci --ignore-scripts
```

```bash
FORK_RPC_URL=<read-only archive RPC> CANARY_FORK_BLOCK=128812145 npm run verify
```

Individual parts:
- `forge test --no-match-path 'test/{fork,audit,salus-ffi}/*'`
- `forge test --match-path 'test/{audit,salus-ffi}/*' --ffi` (FFI runs only `python3 -I` on the two models)
- `npm run test:sdk` and `npx tsc --noEmit`
- `FORK_RPC_URL=… FORK_BLOCK=128713128 FORK_NAND_MINER=12733 FORK_LATCH_MINER=13948 FORK_INACTIVE_TOKEN=648 FORK_SCALE_MINERS=… npm run test:fork` (20 tests)
- `node scripts/canary/build-source.mjs --check`
