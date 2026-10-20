# Verification report

Date: 2026-10-20. Branch `worktree-pooled-mining-v2`, based on groupmine `48a2d74`. Toolchain: solc
0.8.24 (Paris, via-IR, optimizer 200), OpenZeppelin 5.4.0, Foundry 1.4.3, Node 20+, viem 2.57.2.

**Scope.** Local tests against a mock protocol, and real BSC protocol state on local forks. No mainnet
deployment, no live-value transaction and no signature was made. The contracts are not audited.

## 1. Implementation

| Contract | Runtime size | Role |
| --- | ---: | --- |
| `TapeoutEntitlementReceipt` | 8,743 B | unique-ID ERC-1155 entitlement; deployed twice (NAND, LATCH) |
| `TapeoutReceiptDistributor` | 7,560 B | holds receipts, records the allocation, delivers to beneficiaries |
| `TapeoutMinerPool` | 19,074 B | miner custody, admission boundary, BEM ledger, claims, A/B payments |

Design and rules: [ARCHITECTURE.md](ARCHITECTURE.md), [ACCOUNTING.md](ACCOUNTING.md); operator
workflow: [OPERATIONS.md](OPERATIONS.md); what changed from 48a2d74 and what was reused:
[BASELINE.md](BASELINE.md).

Material decisions:

1. **Receipt compatibility** is proven by runtime code hash plus category constant, not by
   interface: only this unique-ID, finalize-once implementation is accepted. `activate` requires
   finalized issuance and the supplies the operator reviewed.
2. **Distribution** uses on-chain range records instead of a Merkle tree (one round, bounded wallet
   count; the contract enforces coverage and immutability itself). The distributor refuses receipts
   with claim history and accepts nothing after finalization, so distributed receipts cannot be
   recycled.
3. **Composition** is `nandBurn`/`latchBurn` from `getMiner`, required to equal `cachedBurn`, for an
   ACTIVE record of exactly that collection and token, with a non-zero total.
4. **Strict settlement** calls `Mining.claim` for every registered miner inside each admission;
   `claimMany` is not used because it skips failures silently. A failure of a miner that Mining still
   reports ACTIVE reverts the admission. Miners Mining reports as no longer ACTIVE are skipped with an
   event, because Mining refuses all claims for them (nothing is collectible).
5. **Edge cases:** BEM held before the first admission is recognized by it; a category with zero
   receipts cannot gain composition (miners burning it are refused); activation refuses two empty
   collections.
6. **Authority:** a fixed whitelist (1 to 16) gates both admission paths; plain transfers are inert;
   the owner's only power is `activate`; recipients rotate only themselves.
7. **Tooling** never signs and refuses allocation wallets that cannot receive ERC-1155. Every plan
   carries a worst-case gas bound that is its gas limit (printed `cast` commands, local sends);
   plans over 3/4 of the BSC per-transaction cap and oversize batch sizes are refused, and Safe
   batch files are split by gas (safeguards ported from `main`'s `6aeb5a9`).

## 2. What was run

| Check | Command | Result | Raw output |
| --- | --- | --- | --- |
| Build, sizes, formatting | `forge build --sizes`, `forge fmt --check` | PASS: runtime sizes under EIP-170 (24,576 B); largest initcode, the pool's 30,857 B, under EIP-3860 (49,152 B) | — |
| Unit, fuzz, gas and invariant suites (mock protocol) | `forge test --no-match-path 'test/fork/*'` | **90 / 90 PASS** | `reports/solidity-tests.json` |
| SDK unit tests | `npm run test:sdk` | **21 / 21 PASS** | `reports/sdk-tests.tap` |
| TypeScript | `npm run typecheck` | PASS | `reports/typecheck.txt` |
| CLI end to end, local Anvil, mock protocol | `npm run test:local-e2e` | **PASS, 29 / 29 checks**, 46 steps, 44 local transactions | `reports/local-e2e.json`, `reports/local-e2e-reconcile.json` |
| Real BSC state, Foundry fork, block 128,713,128 | `npm run test:fork` | **4 / 4 PASS** | `reports/fork-test.json`, `fork-identity.json`, `fork-boundary.json`, `fork-gas.json` |
| Real BSC state, CLI on an Anvil fork, same block | `npm run test:fork-e2e` | **PASS, 17 / 17 checks**, 31 local-fork transactions | `reports/fork-e2e.json`, `reports/fork-e2e-reconcile.json` |
| Foundry deployment script, Anvil fork of BSC, same block | `forge script script/DeployPool.s.sol:DeployReceipts`, then `:DeployPool` | PASS: both receipts, pool and distributor deployed from the example system file; pool bound to the script's receipts; receipt runtime code hash `0x7f59d20c…ec8f` equals the build that the SDK bytecode comes from | console output only |
| Static analysis | Slither 0.11.3 | 42 results, triaged in §6, no code change | `reports/slither.txt`, `reports/slither.json` |
| BSC mainnet | — | **NOT RUN** (out of scope) | — |

Solidity suites: `PoolAdmissionTest` 17, `DistributorTest` 12, `PoolClaimsTest` 11, `PoolSetupTest` 9,
`GasModelTest` 9, `PoolHarvestTest` 8, `PoolAccountingTest` 6 (one fuzz test, 512 runs),
`EntitlementReceiptTest` 5, `AdmissionGasTest` 1, `PoolUnsupportedCategoryTest` 1, and two invariant campaigns
(`PoolInvariantTest` 5 invariants, `PoolInvariantCoverageTest` the same plus one) of 256 runs × depth
64 each, `fail_on_revert = true`, 0 reverts. The invariant handler keeps an independent reference
model of the boundary (expected settled and carried income from the mock's owed balances) and checks
four-account conservation, the model against the ledger, per-ID histories, monotonic entitlements,
custody and composition. Its path counters over 1,542 logged runs: 3,746 successful admissions, 1,505
rolled-back admissions (1,516 runs admitted at least once, 658 saw a rollback), up to 11 registered
miners.

## 3. Coverage of the required scenarios

| Requirement | Tests |
| --- | --- |
| Independently deployed, finalized receipts | `EntitlementReceiptTest` (5); `PoolSetupTest.testReceiptsMustBeThisExactImplementationWithTheRightCategories`, `testActivationRequiresFinalizedSuppliesTheReviewedCountsAndOwner`; local e2e `receiptsDeployedIndependently`, `overIssuanceRetracted`, `supplyFixedAfterFinalization` |
| JSON import, coverage, finalization, user claims | `DistributorTest` (12); SDK allocation tests; local e2e `importRejectsDuplicates`, `importRequiresCoverage`, `importRejectsWalletThatCannotReceive`, `importBatched`, `importResumeHasNothingLeft`, `revokedWalletBlocksFinalization`, `reimportOnlyRestoresTheRevokedWallet`, `allocationVerified`; fork e2e `allocationVerified`, `deliveryWentToBob` |
| Late receipt claims; transfers carry unpaid BEM | `testLateClaimsKeepTheBemAccumulatedWhileHeldByTheDistributor`, `testUnclaimedIncomeFollowsTheReceiptAndTheFormerHolderLosesIt`, `testClaimedHistoryStaysWithTheIdAcrossTransfers`; local e2e `lateReceiptKeptAccumulatedBem`, `formerHolderRejected`, `newHolderGotTransferredEntitlement` |
| Whitelisted deposits after renunciation | `testPoolKeepsWorkingAfterOwnershipIsRenounced`; fork `testForkWhitelistAfterRenounceAndBypassRejection`; both e2e runs renounce before depositing |
| Unauthorized admission and registration bypass | `testOnlyWhitelistedDepositorsAdmitAndOnlyTheirOwnMiners`, `testPlainTransferNeitherRegistersNorBypassesTheWhitelistOrSettlement`, `testSafeTransferIntoThePoolIsRefused`, `testDepositorWhitelistIsValidatedAndRequired`; local e2e `nonDepositorRejected`, `registrationBypassRejected`, `plainTransferDidNotAdmit`; fork e2e `outsiderDepositRevertsOnChain` |
| Authoritative composition, duplicate miners | `testCompositionMustComeFromAValidActiveMinerRecord`, `testDuplicateAndAlreadyRegisteredMinersAreRejected`; fork `testForkProtocolIdentityAndCompositionAbi`; fork e2e `realCompositionsAdmissible`, `nandMinerBurnsNoLatch` |
| Strict old/new settlement with carried income | `testSpecificationAcceptanceExample`, `testOldIncomeHiddenFromPendingIsStillSettledUnderTheOldRatio`, `testCarriedIncomeIsNotPaidBackToTheDepositor`, `testFirstAdmissionRecognizesIncomeHeldBeforeAnyComposition`, `testBatchUsesOnePostBatchCompositionForAllCarriedIncome`; fork `testForkStrictAdmissionBoundaryWithRealMiners`; fork e2e `carriedIncomeCollectedAtFirstAdmission`, `oldIncomeSettledInsideAdmission`, `realBoundaryMatchesOldNewCompositionModel`; local e2e `acceptanceExampleNand140Latch60` |
| Rollback when old-miner settlement fails | `testActiveOldMinerSettlementFailureRollsBackTheWholeAdmission`, `testIncomingMinerClaimFailureRollsBack`, `testInactiveOldMinerIsSkippedExplicitly`; 1,505 invariant rollbacks; local e2e `failedSettlementRolledBack`, `inactiveMinerSkippedExplicitly` |
| Batch-order independence | `testBatchOrderDoesNotChangeTheOutcome` (every order from one snapshot) |
| Conservation, monotonicity, rounding | `PoolAccountingTest` (6, incl. fuzz), the invariants, `testEntitlementsNeverDecreaseAcrossCompositionChanges`; `reconcile --deep` PASS in both e2e runs |
| Revenue access when Mining or admission fails | `testAMiningOutageBlocksAdmissionButNotClaimsOfHeldIncome`, `testClaimsDoNotDependOnMiningOrAdmissions`, `testHarvestIsolatesFailingMiners` |
| Initialization, first miner, zero totals, zero supply | `testAdmissionsRequireActivation`, `testActivationRejectsTwoEmptyCollections`, `testFirstAdmissionRecognizesIncomeHeldBeforeAnyComposition`, `PoolUnsupportedCategoryTest` |
| Distributor custody rules | `testNoAdministrativeRouteToHeldReceiptsOrTheirBem`, `testReceiptsWithConsumedRewardHistoryAreRefused`, `testDistributedReceiptsCanNeverReturnAsInventory`, `testDeliverAlwaysGoesToTheRecordedBeneficiary`, `testABeneficiaryThatCannotReceiveIsNeverRedirected` |
| Admission gas as the registry grows | `AdmissionGasTest` (mock, to 400 miners), fork `testForkAdmissionGasScaling` (24 real miners); every other planned transaction's bound in `GasModelTest` |

## 4. Real-protocol observations (BSC block 128,713,128)

Block hash `0x760f050b7ec66ced2a2745918d7492650150f9d71d3159259412996ebe65081f`; archive state from
`bsc-mainnet.public.blastapi.io`. Protocol state was read, never modified; miners were moved from
their holders with fork-only impersonation, and time advanced only inside the fork.

- **Identity.** Mining implementation `0xa3DBe873…f898` (code hash `0x63b1124d…4479`), collection
  beacon implementation `0x8E1D125D…6068`, BEM 8 decimals: unchanged from the recorded values.
- **Composition ABI.** The `getMiner` layout comes from the official frontend bundle (sha256
  `0f1b12c3…a1e`), which labels `nandBurn`/`latchBurn` as the layer's actual ("local") burn and shows
  it beside a separate recursive count that includes referenced circuits. The reference source
  (`HongH933/tapemarket@2b87e91…/inputs/mining/PodMining.sol`) could not be used: both the file and the
  repository returned HTTP 404 on 2026-10-20. On chain, `getMiner` and `cachedBurn` agreed for every
  miner admitted: #12733 88 NAND / 0 LATCH, #13948 2 / 64, #4183 1 / 9, #1574 4 / 5.
- **Inactive miners.** For token #648 (not ACTIVE) `claim` reverts with `0x5f9bb3be`, while `claimMany`
  including its key does not revert. This is why admissions claim per key.
- **Boundary, Foundry fork.** Admitting #12733 collected 20,061,449,000 raw BEM it carried (all NAND,
  composition 88:0). One hour later `pending()` for #12733 read 0, yet admitting #13948 settled
  27,497,042 raw from it under 88:0, then collected 1,078,419,271 raw carried by #13948 under 90:64.
  Result: NAND 20,312,932,421, LATCH 439,386,512, A and B 207,523,189 each; exactly the `PoolMath`
  values for those inputs (one unit carried at the checkpoint). Admission gas 231,401.
- **CLI fork run.** Pool ownership renounced before any deposit; four real miners admitted in three
  admissions (one batch of two); the outsider's deposit reverted on chain with `NotDepositor`;
  moving miners to the depositor paid nothing to their previous holders; deep reconciliation PASS
  (final run: residue 36 raw against a bound of 53, NAND Σ claimed = paid = 20,333,806,640, LATCH
  456,352,104). Amounts differ slightly between runs because the Anvil fork's block timestamps follow
  the wall clock.

## 5. Gas and scale

Admission on the real protocol (`reports/fork-gas.json`; storage cooled, one hour of accrual between
admissions, so every old-miner claim pays real BEM; the 21,000 base cost excluded):

| Registered miners | 0 | 1 | 2 | 5 | 10 | 15 | 20 | 23 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Gas to admit one miner | 397,971 | 317,401 | 285,430 | 368,497 | 507,262 | 645,907 | 784,432 | 867,619 |

The first admission is dearer (fresh storage). The marginal cost is at most 27,849 gas per registered
miner. Extrapolated, a single-miner admission reaches BSC's 16,777,216 gas cap (BEP-652, active since
the Mendel upgrade on 2026-04-28) at about 593 registered miners, and a 3/4 planning budget at about
442. The CLI uses a rounded-up model (300k + 30k per registered + 250k per incoming miner) and stops
planning at 401. On the mock the cost is about 22k per registered miner (9,001,358 gas at 400).

Every other planned transaction carries a worst-case bound that the CLI uses as its gas limit.
`GasModelTest` runs each call as its own transaction (Foundry isolation, so earlier writes in the
test cannot make it look cheaper) with exactly the bound as its limit, which also covers gas spent
before refunds. At the largest sizes the CLI plans, gas used against the bound:

| Transaction | Gas used | Bound |
| --- | ---: | ---: |
| Issue 231 IDs to a wallet / into the distributor | 10.77M / 11.63M | 12.57M |
| Fund the distributor with 300 IDs | 10.06M | 12.10M |
| Allocate 85 single-ID ranges for new wallets / 400 IDs in one range | 10.54M / 10.39M | 12.56M / 10.98M |
| Revoke a wallet with 1,500 IDs in two ranges | 6.46M | 12.16M |
| Deliver 300 IDs in one range / 60 single-ID ranges | 9.05M / 2.71M | 11.30M / 8.32M |
| Claim BEM for 386 IDs | 10.91M | 12.55M |
| Deploy receipt (long metadata) / pool (16 depositors, 64-byte name) / distributor | 2.29M / 5.30M / 1.75M | 3M / 6M / 2.5M |

All bounds stay under the 12.58M planning budget. The isolated method changed one model: delivery
needs about 37k gas per ID as a limit (it was 32k), because its refunds only arrive after execution.
The local and fork end-to-end runs send every transaction with its bound as the limit and check that
the node's estimate stays below it, which also covers admissions and harvests on the real protocol.
Other costs from those runs: activation 109k, harvest of four real miners 248k, each recipient
release about 116k.

## 6. Static analysis

Slither 0.11.3, `--exclude-informational`, test and library paths filtered; 42 results:

| Detector | Count | Assessment |
| --- | ---: | --- |
| `incorrect-equality` | 1 | `_pay` returns early on `amount == 0`; intended |
| `reentrancy-no-eth` | 6 | `_admit` (×3), `harvest`, `harvestRange` write state after `Mining.claim`/`transferFrom` by design (the boundary's order); `_deliver` updates the category total after an earlier range's transfer. Every entry point is `nonReentrant`; the calls go to the fixed protocol contracts, bound receipts or the beneficiary; the only cross-function exposure is views |
| `uninitialized-local` | 4 | accumulators that start at zero |
| `calls-loop` | 29 | loops over miners and IDs are the design; bounded by batch limits and gas models; harvest isolates failures |
| `reentrancy-benign` | 1 | checkpoint after settlement claims; same as above |
| `immutable-states` | 1 | receipt `category` is storage on purpose so all receipts share one runtime code hash |

No code change resulted.

## 7. Remaining limitations

1. **Registry size.** Strict settlement makes admission cost linear in registered miners; about 590
   miners is the practical ceiling under the BSC cap (401 with the CLI's margin). Inactive miners stay
   registered and keep costing gas. Beyond the ceiling, harvests, claims and payments continue but no
   miner can be admitted; lifting it would need a different boundary design, which this specification
   does not allow silently.
2. **Protocol upgrades.** Mining (ERC-1967) and the collection (beacon) are upgradeable by their
   owners. A change to `claim` statuses, burn fields or payout routing would change what the pool
   observes; admissions fail closed, already recognized BEM stays claimable. Run `protocol-check`
   before operating.
3. **Composition semantics** rest on the frontend ABI labels and on-chain consistency, not on the
   deployed source (unavailable).
4. **Carried income** is only what is unclaimed at admission: anyone can call `Mining.claim` for a
   miner before it is deposited, which pays its owner. With `registerMiners`, income claimed between a
   plain transfer and registration is recognized under the composition current at that moment;
   `depositMiners` has no such window.
5. **Inactive-miner handling** trusts Mining's status flag: an ACTIVE miner whose claim fails blocks
   admissions until Mining recovers.
6. **BEM** must remain a plain ERC-20; a forced balance decrease blocks recognition and claims rather
   than rewriting history.
7. **Wallets that cannot receive ERC-1155** are stopped by the tooling, not by the contract; a contract
   beneficiary added by other means would leave its receipts in the distributor (its BEM stays
   attached but unclaimable).
8. **Per-transaction sizes.** `revokeWallet` clears a whole wallet in one call, so the tooling can only
   correct (before finalization) wallets of up to about 1,550 allocated IDs; one delivery carries up to
   about 330 IDs in a single range (fewer when they span many ranges), so large wallets claim in
   several transactions.
9. **Not covered:** real (non-impersonated) deposits by actual depositors, Safe-batch execution on
   BSC, long-running behaviour over many composition periods on the real protocol, and an audit.

## 8. Reproduce

```bash
npm ci --ignore-scripts
```

```bash
forge build --sizes && forge fmt --check && forge test --no-match-path 'test/fork/*'
```

```bash
npm run test:sdk && npm run typecheck && npm run test:local-e2e
```

```bash
FORK_RPC_URL=https://bsc-mainnet.public.blastapi.io FORK_BLOCK=128713128 FORK_NAND_MINER=12733 FORK_LATCH_MINER=13948 FORK_INACTIVE_TOKEN=648 FORK_SCALE_MINERS=4183,1574,6940,4307,4655,3207,13617,7924,11127,4951,3932,10031,14559,16112,8714,2161,6767,11214,6453,14011,16944,15731,7541,5930 npm run test:fork
```

```bash
FORK_RPC_URL=https://bsc-mainnet.public.blastapi.io npm run test:fork-e2e
```

Without the overrides, `test:fork` pins a block 20 behind the head and discovers suitable miners there.
Slither:
`slither . --foundry-compile-all --filter-paths "node_modules|lib|test|script" --exclude-informational --json <raw>`,
then `node scripts/summarize-slither.mjs <raw> <text> 0.11.3`.
