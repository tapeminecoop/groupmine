# Verification Report — TapeOut Miner Pool V1

Date: 2026-10-20. Baseline: TapeoutMarket/test1 @ `9d86a2673dd3b415e5d8ce35cd818d4e73756116`.
Toolchain: Foundry 1.4.3 (forge/anvil/cast), solc 0.8.24 (Paris, via-IR, optimizer 200),
OpenZeppelin Contracts 5.4.0, Node 20.19.5, viem 2.57.2, TypeScript 5.7.3, Slither 0.11.3.

This report separates **what was executed for this repository** (§1–§6) from **evidence inherited from
the baseline** (§7) and **what remains unverified** (§8). No transaction was sent to BSC mainnet, no
private key was used, and nothing was signed; all chain activity happened on local Anvil chains or
local forks.

## 1. Results (newly executed, final build)

The final pool creation bytecode has sha256
`9c7eee078c297e01daf6c7c62bbba61c0d64715286fadc886b3c53b1b3b7fece` (`sdk/bytecode.json`); the fork tests
deployed exactly this artifact.

| Check | Command | Result | Raw output |
| --- | --- | --- | --- |
| Build, contract size | `forge build --sizes` | PASS — pool 18,741 B runtime (5,835 B under EIP-170), receipt 8,154 B | — |
| Formatting | `forge fmt --check src test script` | PASS | — |
| Unit, fuzz and invariant suites (mock protocol) | `forge test --no-match-path 'test/fork/*'` | **56 / 56 PASS** | `reports/solidity-tests.json` |
| SDK unit tests | `npm run test:sdk` | **11 / 11 PASS** | `reports/sdk-tests.tap` |
| TypeScript | `npm run typecheck` | PASS | `reports/typecheck.txt` |
| CLI end to end, local Anvil, mock protocol | `npm run test:local-e2e` | **PASS — 23 / 23 checks, 23 local transactions** | `reports/local-e2e.json`, `reports/local-e2e-reconcile.json` |
| Foundry deployment script, local Anvil | `forge script script/DeployPool.s.sol --unlocked …` | PASS (pool + both receipts deployed, owner ≠ deployer) | console output only |
| Real BSC protocol, Foundry fork, block 128,611,683 | `npm run test:fork` | **2 / 2 PASS** | `reports/fork-test.json`, `reports/fork-lifecycle.json`, `reports/fork-identity.json` |
| Real BSC protocol, CLI on Anvil fork, same block | `npm run test:fork-e2e` | **PASS — 14 / 14 checks, 23 local-fork receipts** | `reports/fork-e2e.json`, `reports/fork-e2e-reconcile.json` |
| Static analysis | `slither src/TapeoutMinerPool.sol …` | Run; findings triaged in §6, no code change | `reports/slither.txt`, `reports/slither.json` |
| BSC mainnet | — | **NOT RUN** (no deployment, no transactions) | — |

Solidity suite composition: `PoolSetupTest` 15, `PoolAccountingTest` 10 (two fuzz tests × 512 runs),
`PoolClaimsTest` 13, `PoolHarvestTest` 12, `PoolGasTest` 1, `PoolInvariantTest` 5 invariants
(256 runs × depth 64 = 16,384 handler calls each, 0 reverts, `fail_on_revert = true`).

## 2. Required behaviours and where they are tested

| Requirement | Local tests (mock protocol) | Real protocol (fork) |
| --- | --- | --- |
| Specification example (1,020 BEM, 80/20, 900+100 / 80+20) | `testSpecificationExample1020Bem` (all 980 IDs claimed, every bucket exact), SDK `specification example`, CLI `preview` | — |
| 100:2 fee, not 2% | `testFeeIsTwoOver102NotTwoPercent`, fuzz `fee*102 ≤ 2T < (fee+1)*102` | `fee == T*2/102` asserted on real income |
| Different weights and share counts | `testWeightsAndShareCountsVaryIndependently`, `testEightDecimalWeightPrecision`, fuzz | W_N = 0.8, 90/8 shares |
| Zero and non-zero historical shares | `testHistoricalSharesAddToDenominatorAndHaveTheirOwnRecipient`, `testZeroHistoricalReleaseIsANoOp`, `testHistoricalOnlyCategoryIsValid` | H_N = 10, H_L = 2, both released |
| Multiple miners | `testHarvestCollectsSelectedMinersAndAccountsOnlyActualReceipts`, invariants (6 miners) | 3 real miners |
| Pre-deposit accrued income belongs to the pool | `testIncomeAccruedBeforeDepositBelongsToThePool`, `testActivationRecognizesBemReceivedDuringSetup` | collected at deposit ≥ pending before transfer, for every miner |
| Only actual receipts are accounted | `testHarvestCollectsSelected…` (unharvested income stays out), invariant `BemConservation` | balance delta == accounted delta |
| `pending()==0` never skips `claim()` | `testHarvestAlwaysCallsClaimEvenWhenPendingIsZero` | all 3 miners read `pending == 0`, harvest still received 62,867,799 raw |
| Repeated and duplicate claims | `testRepeatedClaimsPayOnlyNewIncome`, `testDuplicateIdsInOneBatchPayOnce` | — |
| Receipt transfers: income follows ID, history preserved, former holder rejected | `testUnclaimedIncomeFollowsTheTransferredReceipt`, `testClaimedHistoryStaysWithTheIdAcrossTransfers` | NAND #46 moved with 377,115,629 raw unclaimed; former holder `NotHolder(0, 46)`; new holder paid |
| Same numeric ID in both collections | `testSameNumberedIdsInBothCollectionsAreIndependent` | NAND #5 / LATCH #5 histories differ |
| Unauthorized claims, operators | `testUnauthorizedInvalidAndEmptyClaimsRevert`, `testApprovedOperatorCannotClaimUntilItHoldsTheId` | — |
| Rounding and conservation | `testRoundingResidueIsBoundedAndNotLost`, `testAllocationIsPathIndependent`, fuzz, 5 invariants | `reconcile --deep` PASS on fork state |
| Zero denominators | `testZeroDenominatorRejectedOnlyWhenTheCategoryHasWeight` | — |
| Valid miner registration | `testRegistrationValidatesCollectionOwnershipAndMiningKey`, `testRegistrationNeedsAWorkingClaimPath` | real `Mining.claim` accepted all three keys |
| Issuance / activation / capacity | `testActivationRequiresCompleteIssuance…`, `testIssuanceStatusSeparatesActiveSharesFromCapacity`, `testRevokeAndReissueOnlyBeforeActivation`, `testShareCountCannotDropBelowAnIssuedId` | issuance + activation via CLI |
| Owner powers end at activation | `testOwnerLosesEconomicPowersAfterActivation`, `testRecipientRolesMoveOnlyByTheirHolder…` | — |
| Harvest failure isolation | `testHarvestReportsFailingMinerWithoutBlockingOthers`, `testMiningOutageFailsHarvestsButNotClaims` | `--isolate-failures` ran (no failures on real miners) |
| Baseline regressions (donations, third-party claims, tax token, balance decrease, payment rollback, holder index) | `testThirdPartyMiningClaimsAndDirectTransfersAreIncome`, `testBalanceDecrease…`, `testBrokenTokenTransferRollsBackClaim`, `testReceiptHolderIndexFollowsTransfersAndPages` | third-party `Mining.claim` paid the pool, not the caller |

## 3. Real-protocol observations (BSC block 128,611,683)

Block hash `0x5a7e2854b81f4c8de85026be37fb691bd53191845741c4ef73716ff759bb20f7`. Archive state from
`bsc-mainnet.public.blastapi.io`; miner discovery from `bsc-dataseed.bnbchain.org` (600 random token
IDs sampled, 524 with positive pending; the three with the highest pending held by distinct EOAs were
used). Protocol identity matched the recorded values: Mining implementation
`0xa3dbe873…f898` (code hash `0x63b1124d…4479`), collection beacon `0xf8d6…8156` →
implementation `0x8E1D…6068`, BEM decimals 8, `minerKey(collection, 3204)` equal to the baseline's.

Foundry fork run (`reports/fork-lifecycle.json`), raw BEM units:

| Miner | Holder at block | `pending` at block | `pending` right before transfer | Collected by the pool at deposit |
| --- | --- | ---: | ---: | ---: |
| #4630 | `0xc4278A9b…D38D` | 19,308,719,172 | 19,308,719,172 | 19,309,115,055 |
| #2458 | `0xb9674A6F…00A0` | 14,504,309,958 | 14,504,705,841 | 14,504,705,841 |
| #6241 | `0x8E723D26…D65C` | 14,204,861,472 | 14,205,169,893 | 14,205,169,893 |

- Moving a miner to a new owner paid nothing to the previous holder and left its income in place;
  the pool collected it at registration (#4630 before activation, recognized at activation).
- After one simulated hour every miner reported `pending() == 0`; harvesting them paid
  **62,867,799** raw, 0 failures, and the per-miner events summed to the received amount.
- One hour later a third party called the real `Mining.claim` for #4630: the pool received
  22,621,885 raw, the caller nothing; `sync` recognized it.
- Ledger at the end: accounted 48,104,480,473 − paid 28,674,043,208 = pool balance 19,430,437,265,
  equal to outstanding entitlements plus residue.

CLI on the Anvil fork (`reports/fork-e2e.json`): same block and miners, fresh code-free actors.
Deployment, configuration, issuance in 6 batches, pre- and post-activation deposits, harvest after
one hour (62,867,797 raw with all `pending` at 0), claims, receipt #46 transfer, former-holder
rejection, releases, and `reconcile --deep` (NAND Σ claimed = paid = 32,054,828,465; LATCH
6,599,523,518) all passed. The 23 receipts exist only on that local fork.

## 4. Gas

| Operation | Gas | Conditions |
| --- | ---: | --- |
| Deploy pool (+ both receipts) | 7,788,283 | fork receipt, incl. base |
| Issue 45 IDs (range) | 2,168,834 | fork receipt |
| Issue 200 IDs (range) | 9,466,404 | local, cold, excl. base |
| Deposit 1 / 2 real miners (incl. registration claim) | 269,071 / 322,589 | fork receipts |
| Activate | 181,990 | fork receipt |
| Harvest 3 real miners | 205,615 | fork receipt (145,723 cold, excl. base, Foundry fork) |
| Harvest 49 miners | 1,553,290 | local mock, cold, excl. base |
| Claim 44 IDs | 1,375,863 | fork receipt |
| Claim 200 IDs | 5,647,190 | local, cold, excl. base |
| Release fee / historical | 102,086 – 104,717 | fork receipts |

The CLI defaults (issue 200 IDs, claim 200 IDs, harvest 25 miners, deposit 20 miners per transaction)
stay far below current BSC block gas limits; check the live limit before choosing larger batches.

## 5. Findings during development

1. **EVM version.** The deployed TapeOut contracts (BEM, Mining implementation, collection
   implementation and proxies) use `PUSH0`, which a Paris EVM cannot execute (`NotActivated`). The
   fork profile runs the EVM at Cancun while deploying the unchanged Paris artifact.
2. **EIP-7702 receivers.** On BSC mainnet the well-known Anvil/Hardhat accounts carry EIP-7702
   delegations (`0xef0100…`) and therefore cannot receive ERC-1155 receipts; issuing to one reverted.
   `issue` now checks every holder with code before sending and names those that would reject receipts.
   Operators must collect holder addresses that are plain EOAs, compatible smart accounts, or contracts
   implementing `IERC1155Receiver`.
3. **`pending()` is stale between global updates.** A `claim` on any miner refreshed Mining's global
   accrual and raised other miners' `pending` (e.g. #2458: 14,504,309,958 → 14,504,705,841) without any
   transfer of value. An NFT transfer itself changed neither `pending` nor balances (traced).
4. **Zero-pending settlement** (baseline finding) reproduced on three miners through the new pool.
5. **Intermittent Anvil-fork revert.** One run of the fork CLI flow reverted the post-activation
   deposit; the identical transaction (same hash) succeeded in later runs. The most likely cause is a
   failed or throttled remote state fetch from the public RPC during execution; this was not proven.
   Local sends now replay a reverted transaction at the previous block to report its reason.
6. **Test-authoring defects fixed:** `vm.prank` consumed by a view call inside the next call's
   arguments (three places, one of which made a "third-party claim" test use the wrong caller), a
   `testFail…` name, and gas measured on warm storage (now `vm.cool` before each measurement).

## 6. Static analysis triage (Slither 0.11.3)

| Finding | Assessment |
| --- | --- |
| `reentrancy-no-eth` ×3 (harvest, harvestRange, depositMiners) | The only cross-function targets listed are view functions. Every state-changing entry point is `nonReentrant`; the external callees are the fixed Mining/collection contracts. A view read during a harvest could see the inflow before `_sync`; no pool logic depends on that. Accepted. |
| `incorrect-equality` (`_pay`) | Intentional: exact sender/recipient balance deltas (baseline rule). |
| `uninitialized-local` (`claimableBatch.perShare`) | Intentionally zero before activation. |
| `reentrancy-benign`, `reentrancy-events` ×6 | Owner-only setup functions and activation calling the pool's own receipt contracts; during setup every permissionless entry point reverts `NotActive`. |
| `calls-loop` ×18 | Inherent to batching; batch size is chosen by the caller; harvest isolates failures per miner. |

Slither is not an audit, and no other analyzer was run.

## 7. Inherited evidence (baseline; not re-run)

Summarized in [BASELINE.md](BASELINE.md) §2: 79 Solidity tests/invariant properties and 78 SDK tests;
the real-state fork at block 128,554,249 (23 scenarios, 25 receipts) where the zero-pending defect was
found and fixed; 11 mainnet test transactions through block 128,591,816 with miner #3204 and 100
receipts, including the 0.00000323 BEM entitlement transfer and the `NotHolder` rejection; and the
840-test offline tooling regression. That evidence concerns the previous GroupBuy implementation and
the real protocol's behaviour; it does not validate this repository's code or its economic model.

## 8. Not verified / remaining work

- **No BSC mainnet deployment or transaction.** That needs explicit authorization, the operator's
  signer or Safe, the real allocation, and the real miner IDs; rehearse first with `test:fork-e2e`.
- **No independent audit.** Tests, fuzzing, invariants, fork runs and Slither do not replace one.
- **Protocol semantics without source.** Mining, BEM and collection sources were not obtained. Unknown:
  every path and permission of `claim`; what `start`/`stop`/`arm`/`kick`/`reclaim` do and whether a
  pooled miner can stop earning without owner action; the collection beacon's upgrade powers; BEM's
  full token semantics. A protocol upgrade could change behaviour; run `protocol-check` regularly.
- **Fork scope.** One pinned block, three miners, two simulated hours. Longer periods, task changes,
  miners in other states, and other blocks were not tested.
- **Signing paths.** Safe Transaction Builder files were validated structurally, not imported into a
  Safe; printed `cast send` commands were executed only with `--unlocked` on Anvil, not with a hardware
  wallet or keystore.
- **Scale on real state.** Spec-size issuance and claims (980 IDs) ran only on the local mock chain;
  on the fork the pool had 98 IDs.
- **Out of scope by specification:** splitting historical income among individual historical
  contributors (V1 pays a recipient address or contract), leftover-material tracking, refunds,
  multi-round allocation, miner withdrawal/redemption, and any UI or indexer.

## 9. Reproduce

```bash
npm ci --ignore-scripts && forge build && forge test --no-match-path 'test/fork/*'
```

```bash
npm run test:sdk && npm run typecheck && npm run test:local-e2e
```

```bash
FORK_RPC_URL=https://bsc-mainnet.public.blastapi.io FORK_BLOCK=128611683 FORK_MINER_IDS=4630,2458,6241 npm run test:fork
```

```bash
FORK_RPC_URL=https://bsc-mainnet.public.blastapi.io npm run test:fork-e2e
```

Without `FORK_BLOCK`/`FORK_MINER_IDS`, `test:fork` pins a recent block and discovers miners itself.
Public RPC endpoints are third-party services and may rate-limit; Foundry caches fork state per pinned
block, so reruns of the same block are fast.
