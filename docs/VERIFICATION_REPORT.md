# Verification report

Date: 2026-10-20. Branch `worktree-pooled-mining-v2`. Review baseline `6da9a41`; this round's changes are
on top of it. The exact tested tree, tool versions, artifact hashes and every command with its
timestamps, exit code and log are in [`reports/run-manifest.json`](../reports/run-manifest.json) and
[`reports/logs/`](../reports/logs/), produced by `npm run verify` (`scripts/verify-all.ts`).

**Tested build.**
- Run: 2026-10-20 13:22:41–13:29:08 UTC, overall PASS.
- Source fingerprint `43e9b879d42e778d75ff6dbb322888dc2d333e2db1f7df534886072dd2d88eca`: 93 code and
  configuration files (docs, reports and Markdown excluded); recompute with
  `node --import tsx scripts/verify-all.ts --fingerprint`.
- Toolchain: Foundry 1.4.3, solc 0.8.24 (Paris, via-IR, optimizer 200 runs), Node 20.19.5, viem 2.57.2,
  OpenZeppelin 5.4.0, Slither 0.11.3.

Runtime code hashes of the tested artifacts:

| Contract | Runtime code hash | Runtime | Initcode |
| --- | --- | ---: | ---: |
| `TapeoutEntitlementReceipt` | `0x7f59d20c…ec8f` | 8,743 B | 10,361 B |
| `TapeoutReceiptDistributor` | `0xcf370db1…0ada` | 7,680 B | 8,289 B |
| `TapeoutMinerPool` | `0x5655ce42…2c26` | 19,113 B | 30,896 B |

The SDK files in the tree equal a fresh export from this build, and the build is byte-identical after
Slither's clean rebuild.

**Scope.** Local tests against a mock protocol; real BSC protocol state on local forks; read-only
public-chain RPC calls for discovery. No public-chain deployment, no live-value transaction and no
signature with a real key: the Safe test signs with owner keys generated for the fork. The contracts
are not audited.

Status words: **PASS** asserted and passing; **FAIL** asserted and failing; **SKIPPED** not run;
**UNVERIFIED** a claim that could not be established with the available code or chain evidence.

## 1. Review findings

| # | Finding | Change | Evidence | Result | Remaining limitation |
| --- | --- | --- | --- | --- | --- |
| 1 | `verify-allocation` checked only the artifact's own wallets; omitted wallets, an empty list and wrong chain/contract identities passed | `sdk/verify.ts`: runtime schema and semantic checks of the artifact; one-block snapshot of the whole on-chain allocation (every listed wallet's ranges, totals, holders); comparison in both directions of wallets and IDs per category, totals, identities (artifact, addresses file, distributor bindings, pool bindings), holdings vs delivered counts; revoked wallets (listed, no ranges) excluded. Statuses `MISMATCH` / `NOT_READY` / `READY_TO_FINALIZE` / `FINALIZED_AND_MATCHES` | `test/sdk/verify.test.ts` (9 tests: each reproduced case, valid import, revoke/re-import, finalization, partial and complete delivery, readiness gaps); local e2e: `verifyRejectsArtifactOmittingAWallet`, `verifyRejectsEmptyWalletList`, `verifyRejectsUnvalidatedArtifact`, `verifyRejectsWrongChainIdentity`, `revokedWalletBlocksFinalization`, `allocationVerified`, `verifyAfterFinalizationMatches`, `verifyNeverMatchesEmptyArtifactAfterFinalization`, `verifyAfterDeliveryMatches`; fork e2e: `allocationVerified`, `allocationMatchesAfterDelivery` | PASS | Reads grow with supply and wallet count (pages of 1,000 holders, one `rangesOf` per listed wallet) |
| 2 | Each delivery rescanned a wallet's ranges from index 0; the SDK bound ignored completed ranges, so a small final delivery could run out of gas at its planned limit | Distributor keeps a per-wallet cursor (`nextRangeOf`), written before each transfer; `_deliver` starts there. SDK: linear `maxDeliverable`, `deliveryBatches`/`deliveryPlans` sizing every delivery from the state the previous ones leave; CLI `claim-receipts`/`deliver` plan all deliveries; ABI/bytecode re-exported | **Reproduced before the fix** on the EVM ([`reports/delivery-gas-repro-before-fix.txt`](../reports/delivery-gas-repro-before-fix.txt)): 183 single-ID ranges, planned 91 / 91 / 1 IDs at 12,567,000 / 12,567,000 / 237,000 gas, each an isolated transaction; the second used more gas than the first (4,345,124 vs 4,109,565) and the final one ran out of gas. **After:** `GasModelTest.testFragmentedWalletDeliversInPlannedTransactions` passes at the same limits (4,144,902 / 4,113,202 / 88,279 gas used); `DistributorTest`: fragmented allocation over several transactions, partial range, receiver refusal rolls back everything (cursor included), exactly-once delivery with attached BEM; SDK: the review case yields 91/91/1 at those limits, `maxDeliverable` equals a step-by-step search | PASS | A wallet with many small ranges needs several deliveries (about 91 single-ID ranges each) |
| 3 | Admission skipped any non-ACTIVE old miner; the mock let an unpaid miner turn inactive and back, which proved only the skip policy | **Investigated the deployed lifecycle** (§4.2). Pool now skips only REVOKED (status 2: permanent, refused by `claim`, and the revoking transaction pays the holder first); any other failed claim, including COOLING (3) or never started (0), reverts the admission. Event renamed `RevokedMinerSkipped`. Mock: REVOKED is terminal; COOLING is labelled mock-only fault injection | Fork: `MiningLifecycleForkTest` (stop is holder-only; stop pays exactly what a claim would, then claims revert, also after the cooldown). Read-only history: revocations of #2247 and #7555 and the stop of #672 each paid the holder (`Claimed`) in the same transaction. Unit: `testRevokedOldMinerIsSkippedExplicitly`, `testCoolingOrUnstartedOldMinerBlocksAdmission`; invariant handler: revocation terminal, cooling must roll back; local e2e: `revokedMinerSkippedExplicitly`, `coolingOldMinerBlocksAdmission`, `failedSettlementRolledBack` | PASS | UNVERIFIED: restart of a COOLING miner and whether its debt is reset (no valid `start` input could be built); that a revoked circuit can never restart (official frontend text only); a `challenge` executed by us (needs a real counterexample) |
| 4 | Real-protocol boundary covered one old and one new miner; nothing showed complete settlement of several old miners at one timestamp | `test/fork/PoolBoundary.t.sol` (helpers moved to `PoolForkBase.sol`) | Three old miners (#12733, #4183, #1574) and a batch (#13948, #6940) shifting NAND:LATCH from 93:14 to 112:86: settled and carried amounts equal what real claims pay at that timestamp (snapshot balance deltas); recognition order and periods from events; re-claiming every miner at the same timestamp collects nothing more; the ledger equals the specification's formula written out in the test (not `PoolMath`); reversed old and incoming orders give identical results; register window; first admission with BEM held before any composition; zero-supply category | PASS | Real-protocol failure injection is impossible without patching (Mining's owner is renounced, so it cannot be paused); old-miner failure rollback and claims during an outage stay mock-only |
| 5 | Composition evidence did not separate local burn from recursive statistics; identity docs overstated fail-closed behaviour | Read-only scan of all circuits (`scripts/probe-circuit-burn.ts`); fork test `testForkCompositionMatchesCircuitBurnAndIgnoresReferences`; identity test records owners, code hashes and that a stranger can neither upgrade nor pause Mining; docs corrected (ARCHITECTURE §4.3, §4.5, §7; OPERATIONS) | `getMiner` burn = `cachedBurn` = Mining's computed `circuitBurn` for all 17,809 ACTIVE miners (0 disagreements). Only 7 circuits reference sub-circuits; all have local burn 0 and never started. Sample #109: recorded 123,264 gates incl. references, `circuitBurn` (0, 0), refused by the pool (`MinerNotActive`) | PASS | No admissible miner currently distinguishes local from recursive counting; the pool does not check protocol implementations on-chain |
| 6 | Operational gaps: premature renounce, metadata authority, recipient docs, capacity wording, Safe coverage | CLI `renounce` refuses before issuance finalization / allocation finalization / activation and reports what it removes; docs: issuer `setURI` until renounce, recipient role migration, measured vs extrapolated vs model capacity; Safe coverage in row 9 | Local e2e: `renounceRefusedBeforeIssuanceFinalized`, `renounceRefusedBeforeActivationAndAllocation`; `testRecipientsMoveOnlyThemselves` (owner cannot; unreleased income goes to the new address) | PASS | — |
| 7 | Reports not tied to an exact tested build | `scripts/verify-all.ts` runs everything and writes the manifest (source fingerprint, tools, artifact hashes, per-step command/time/exit/log). Each step is judged only on output written in that run: Slither's previous JSON is removed first (Slither never overwrites it) and its finding count must equal the count it printed; fork observation files are reset before the fork tests; the SDK files must be unchanged by a re-export | [`reports/run-manifest.json`](../reports/run-manifest.json) | PASS | Fork results depend on the public archive RPC being reachable |
| 8 | Future live test | [`LIVE_TEST_PLAN.md`](LIVE_TEST_PLAN.md) | Plan only | Not executed (out of scope) | — |
| 9 | Safe batch files were checked only as files. Executing them showed that a file's `maxGas`, the sum of its plans' bounds, left out the Safe's own work | `sdk/gas.ts` `safeBatchGas` adds signature checks for up to 10 owners, the nonce, events, the payload SafeL2 logs, and the 1/64 of gas each nested call keeps (EIP-150). Files are grouped by that bound and `maxGas` reports it. `scripts/fork-safe-e2e.ts` executes the CLI's files through real Safes | [`reports/fork-safe-e2e.json`](../reports/fork-safe-e2e.json): 23 Safe transactions from three Safes, each sent with its `maxGas` as the gas limit (§3.6). 2 of them need more gas than the sum of their plans' bounds, the old `maxGas` (+8,191 and +8,433); the smallest margin under the new bound is 149,015 | PASS | Not exercised: the Safe{Wallet} interface itself, modules and guards, more than 10 signatures |

## 2. What ran

Results of the final `npm run verify` (timestamps, exit codes and logs in the manifest):

| Step | Result |
| --- | --- |
| Build and sizes | PASS: all runtimes under EIP-170 (24,576 B), all initcode under EIP-3860 (49,152 B) |
| SDK files (`sdk/abi.ts`, `sdk/bytecode.json`) unchanged by a re-export from the tested build | PASS |
| Formatting (`forge fmt --check`) | PASS |
| Unit, fuzz, gas and invariant tests (mock protocol) | **PASS, 95 / 95** |
| Gas-model tests, verbose (planned limits against use, §4) | PASS, 10 / 10 |
| SDK tests | **PASS, 32 / 32** |
| Typecheck | PASS |
| CLI end to end, local Anvil | **PASS, 39 / 39 checks**, 57 steps, 44 local transactions |
| Foundry tests on real BSC state (fork, block 128,713,128) | **PASS, 11 / 11** |
| CLI end to end on a BSC fork | **PASS, 18 / 18 checks**, 31 local-fork transactions |
| CLI Safe batch files executed through real Safes on a BSC fork | **PASS, 241 / 241 checks**, 23 Safe transactions, 40 local-fork transactions |
| Slither (`--fail-none`: the exit code reports analysis errors only) | PASS: analysis completed, 42 results (§5); the JSON was written by this run and its count equals the count Slither printed |
| BSC mainnet | NOT RUN (out of scope) |

Suites:

| Suite | Tests |
| --- | ---: |
| `PoolAdmissionTest` | 18 |
| `DistributorTest` | 15 |
| `PoolClaimsTest` | 11 |
| `GasModelTest` | 10 |
| `PoolSetupTest` | 9 |
| `PoolHarvestTest` | 8 |
| `PoolAccountingTest` (one fuzz test, 512 runs) | 6 |
| `EntitlementReceiptTest` | 5 |
| `AdmissionGasTest` | 1 |
| `PoolUnsupportedCategoryTest` | 1 |
| `PoolInvariantTest` / `PoolInvariantCoverageTest` (invariants) | 5 / 6 |

Each invariant campaign runs 256 runs × depth 64 with `fail_on_revert`. The handler's model now
treats revocation as permanent, and a COOLING injection must roll an admission back. Over 1,542
logged runs it made 3,695 successful and 1,055 rolled-back admissions: 1,505 runs admitted at least
once, 516 saw a rollback, and up to 9 miners were registered.

Fork tests:

| Suite | Tests |
| --- | ---: |
| `PoolForkTest` | 5 |
| `PoolBoundaryForkTest` | 4 |
| `MiningLifecycleForkTest` | 2 |

## 3. Real-protocol evidence

Fork block 128,713,128 (hash `0x760f050b7ec66ced2a2745918d7492650150f9d71d3159259412996ebe65081f`),
archive state from `bsc-mainnet.public.blastapi.io`. Protocol code and storage were never modified;
current holders were impersonated and time advanced inside the fork only. Read-only scans ran at the
blocks stated with them.

### 3.1 Identity and upgrade authority (`reports/fork-identity.json`)

| Item | Value |
| --- | --- |
| Mining proxy / implementation | `0x7E2E0DC6…7b46` (UUPS) / `0xa3DBe873…f898`, code hash `0x63b1124d…4479` |
| Mining `owner()` | `0x0000…0000`: renounced; a stranger's `upgradeToAndCall` and `pause` revert; not paused |
| Miner collection | beacon proxy `0xb1024b89…a14C`; beacon `0xf8D6d8EB…8156` owned by `0x68224F66…F7e2`, a contract (130 bytes), which can still change the implementation `0x8E1D125D…6068` |
| BEM | `0x5ce033B2…695a`, 8 decimals, 2,205-byte contract, no ERC-1967 implementation slot |

The pool binds to these addresses and checks none of this on-chain; `protocol-check` is an off-chain
operator check.

### 3.2 Mining lifecycle (`reports/fork-lifecycle*.json`, `reports/probe-lifecycle*.json`)

| Claim | Status | Evidence |
| --- | --- | --- |
| Statuses: 0 not mining, 1 active, 2 revoked, 3 cooling | PASS | official frontend mapping; scan of 21,000 records at block 128,741,865: 17,809 active, 3,157 status 0 (all never started), 11 revoked, 23 cooling |
| `stop` is callable only by the current NFT holder | PASS | fork: the original registrant (after the NFT moved) and a stranger cannot; the holder can |
| `stop` pays the holder all collectible income first | PASS | fork: the holder received exactly what a claim at the same timestamp pays (20,088,946,042 raw), with a `Claimed` event; history: #672's stop at block 118,184,257 paid 3,261,924 raw in the same transaction |
| After `stop`, nothing more is collectible, also after the 1,200 s cooldown | PASS | fork: claims revert (`0x5f9bb3be`) and no further payment after cooldown + 1 day |
| Revocation (`challenge`, by anyone) pays the holder first | PASS (history) | #2247 at block 119,597,281 (tx `0x2234e269…`): `Claimed` 1,454,667 raw to the holder, then `Revoked`; #7555 at block 119,590,644 (tx `0xaf7b1a23…`): `Claimed` 799,121 raw, then `Revoked` |
| A revoked circuit can never mine again | UNVERIFIED | official frontend text ("permanently revoked … can never mine again"); a `start` could not be executed |
| A COOLING miner can restart after the cooldown; its old debt is reset | UNVERIFIED | frontend text says `start` accepts circuits past their cooldown; not executed. Irrelevant to pool-held miners, which cannot be stopped |
| `pendingLive` (frontend ABI) | not implemented | the deployed implementation reverts with empty data, also for ACTIVE miners |

### 3.3 Composition (`reports/fork-composition.json`, `reports/probe-circuit-burn.json`)

- Read-only scan at block 128,745,229: for all 17,809 ACTIVE miners, `getMiner` NAND/LATCH = `cachedBurn`
  = `circuitBurn` (Mining's computation from the circuit); 0 disagreements.
- Circuits whose collection-recorded gate count (`circuitInfo`, documented by the frontend as including
  referenced sub-circuits) exceeds their local burn: 7, all with local burn 0 and status 0.
- Sample: collection `0xb1024b89…a14C`, token #109, key `0x3ceb7484…180e`, status 0, `getMiner` burn
  (0, 0), `cachedBurn` (false, 0, 0), `circuitBurn` (0, 0), `circuitInfo` (0, 6016, 6016, 123264). An
  adapter reading recorded or recursive counts would see 123,264 gates; the local burn is 0, and the
  pool refuses the circuit. This sample separates the two readings, but it is not admissible; no
  ACTIVE miner currently does.
- Fork test: four admitted miners' recorded composition equals `circuitBurn` (#12733 88/0, #13948 2/64,
  #4183 1/9, #1574 4/5).

### 3.4 Admission boundary (`reports/fork-boundary*.json`, `reports/fork-register-window.json`)

Final run (the Foundry fork tests are deterministic at the pinned block):

| Observation | Value |
| --- | --- |
| Old miners (composition) | #12733, #4183, #1574 (NAND 93 : LATCH 14) |
| Incoming batch (post-batch composition) | #13948, #6940 (112 : 86) |
| BEM held before the admission (real claim forwarded by a holder) | 6,539,575,478 raw, recognized in period 1 |
| Old income settled inside the admission | 27,751,255 raw (27,497,042 + 187,821 + 66,392, each equal to what a real claim paid at that timestamp) |
| Carried income of the batch | 1,079,198,599 raw, recognized in period 2 |
| Ledger | NAND 23,297,076,106, LATCH 3,876,543,841, A = B = 271,736,199, equal to the formula in the test |
| Re-claiming all five miners at the admission timestamp | nothing collected |
| Reversed old and incoming orders | identical ledger |
| Register window | the same carried 1,078,419,271 raw: split NAND 20,312,932,421 / LATCH 439,386,512 through an atomic deposit, but NAND 20,752,318,934 / LATCH 0 when claimed between a plain transfer and registration |

### 3.5 CLI end to end on the fork

Pool ownership is renounced before any deposit. Four real miners are admitted in three admissions,
and the outsider's deposit reverts on chain with `NotDepositor`. Receipts are delivered (one push by
an outsider) and verified against the artifact after delivery (`FINALIZED_AND_MATCHES`). A receipt
is transferred and its unpaid BEM claimed by the new holder, and A and B are paid equally.

Deep reconciliation passes (`reports/fork-e2e-reconcile.json`, final run). The residue is 44 raw:
3 from the A/B split, 30 from NAND and 11 from LATCH. Its bound is 53 (3 + 39 + 11 for 40 NAND and 12
LATCH receipt IDs). Per-ID histories: NAND Σ claimed = paid = 20,333,798,640; LATCH 456,352,200.
Amounts vary slightly between runs because the local fork's block timestamps follow the wall clock.

### 3.6 Safe execution (`reports/fork-safe-e2e.json`)

Three Safes were created through the canonical Safe factories on BSC, from the canonical L2 singletons
with their CompatibilityFallbackHandler. Owner keys were generated for the fork only.

| Safe | Version | Signers | Roles |
| --- | --- | --- | --- |
| operator | SafeL2 1.4.1 | 2 of 3 | receipt issuer, pool and distributor owner, recipient A |
| member | GnosisSafeL2 1.3.0 | 2 of 3 | whitelisted depositor, allocated wallet |
| recipient | SafeL2 1.4.1 | 10 of 10 | recipient B |

Every write step ran as the CLI's batch files (`--safe-json`), executed the way Safe{Wallet}
executes a Transaction Builder batch: a single entry as a call, several as a DELEGATECALL to the
version's MultiSendCallOnly. Each file was signed by the threshold of owners (EIP-712, matching the
Safe's own hash) and sent with its `maxGas` as the gas limit.

What the run showed:
- The operator Safe ran issuance through renouncement.
- The member Safe approved and deposited two real miners in one transaction. One hour later it
  deposited two more; that admission settled the first two (28,768,593 raw).
- The member Safe took its 60 receipts. Its BEM claim paid exactly the planned 2,655,126,870 raw.
- Both recipient Safes were paid equally, then moved their roles. Later income went to the new
  addresses.
- Deep reconciliation passes.
- The CLI refuses to write a contract creation as a Safe file.
- One signature of two is refused by the Safe (`GS020`).

Gas:

| Safe transaction | Entries | Payload | Plans' bounds | `maxGas` | Estimate | Used |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Issue 2 × 100 NAND (one of two such files) | 2 | 306 B | 11,000,000 | 11,521,562 | 9,828,900 | 9,454,076 |
| Fund 2 × 125 NAND | 2 | 16,690 B | 10,200,000 | 10,957,040 | 10,197,899 | 8,607,848 |
| Fund 60 LATCH | 1 | 4,185 B | 2,500,000 | 2,800,293 | **2,508,191** | 2,143,725 |
| Import allocation (largest) | 1 | 793 B | 11,460,000 | 12,004,688 | 11,097,220 | 10,756,790 |
| Finalize issuance | 1 | 89 B | 100,000 | 254,757 | 96,570 | 95,578 |
| Approve and deposit two real miners | 2 | 370 B | 950,000 | 1,137,586 | 729,338 | 696,568 |
| Set recipient B (10 signatures) | 1 | 153 B | 150,000 | 307,448 | **158,433** | 156,613 |

Bold estimates exceed the sum of their plans' bounds, the `maxGas` the CLI reported before this
round. Before the change, fund-60-LATCH and the 10-signature call would have failed with that
`maxGas` as their gas limit, and three other files were within 3,430 gas of failing. Under the new bound
every estimate fits; the smallest margin is 149,015 (the 10-signature call). All 23 transactions are
listed in the report. The largest bound, 12,004,688, is under the 16,777,216 cap.

## 4. Gas: planned limits against use

Every planned transaction carries a worst-case bound that is its gas limit. `GasModelTest` runs each
call as its own transaction (Foundry isolation) with exactly that limit, which also covers gas spent
before refunds. Final run (`reports/logs/gas-model.log`):

| Transaction | Gas used | Planned limit |
| --- | ---: | ---: |
| Issue 231 IDs to a wallet / into the distributor | 10,767,507 / 11,626,387 | 12,574,000 |
| Fund the distributor with 300 IDs | 10,060,637 | 12,100,000 |
| Allocate 85 single-ID ranges for new wallets / 400 IDs in one range | 10,537,916 / 10,389,163 | 12,555,000 / 10,980,000 |
| Revoke a wallet with 1,500 IDs in two ranges / 85 single-ID ranges | 6,460,236 / 811,871 | 12,160,000 / 3,330,000 |
| Deliver 300 IDs in one range / 60 single-ID ranges | 9,070,541 / 2,744,335 | 11,300,000 / 8,320,000 |
| Deliver a 183-range wallet: 91, 91, then 1 ID | 4,144,902 / 4,113,202 / 88,279 | 12,567,000 / 12,567,000 / 237,000 |
| Claim BEM for 386 IDs | 10,913,951 | 12,552,000 |
| Deploy receipt / pool (16 depositors, 64-byte name) / distributor | 2,293,918 / 5,311,642 / 1,773,979 | 3,000,000 / 6,000,000 / 2,500,000 |
| Single calls (finalize issuance / allocation, activate, approve, release A / B, set recipient, renounce) | 49,150 / 69,765 / 109,624 / 48,933 / 136,814 / 118,504 / 30,630 / 26,247 | 100k / 150k / 250k / 150k / 250k / 250k / 150k / 100k |

Admission and harvest call the real Mining contract. Their bounds are checked by the end-to-end runs,
which send every transaction with its bound as the limit and fail if the node's estimate exceeds it.

A Safe batch file's bound is the sum of its plans' bounds, plus 150,000, plus 16 per payload byte,
plus 1/30 of the plans' bounds. Several plans share a file only while that bound stays within the
12,582,912 budget. Measured in §3.6.

**Admission capacity.**
- **Measured (real protocol, `reports/fork-gas.json`):** up to 24 registered miners; at most 27,849
  gas per additional registered miner; 867,619 gas to admit one miner with 23 registered.
- **Measured (mock only, `reports/gas-admission-local.json`):** 400 registered miners; 9,001,358 gas.
- **Extrapolated:** about 593 registered miners before one admission exceeds the 16,777,216 cap
  (BEP-652); about 442 within a 3/4 budget.
- **Planning model:** the CLI stops at 401. This is not an on-chain constant and not a guarantee for
  every miner.

## 5. Static analysis

Slither on the final code; counts and every finding in `reports/slither.json`, text in
`reports/slither.txt`. Triage, unchanged in kind from the previous round:
- `incorrect-equality`: `_pay`'s early return on 0.
- `reentrancy-no-eth`: the boundary's ordered writes after `Mining.claim` / `transferFrom`, and the
  distributor's delivery bookkeeping between per-range transfers. All entry points are `nonReentrant`,
  and no state-changing distributor function is callable after finalization.
- `uninitialized-local`: zero-initialized accumulators.
- `calls-loop`: loops over miners and IDs are the design, bounded by batch limits and gas models.
- `reentrancy-benign`.
- `immutable-states`: the receipt's `category` stays in storage so all receipts share one code hash.

No finding led to a code change.

## 6. Remaining limitations

1. **Registry size.** Admission cost grows with registered miners (§4). Beyond the limit, admissions
   stop while harvests, claims and payments continue.
2. **Protocol authority.** The miner collection's beacon owner can still change the collection; the
   pool does not check implementations. Semantic changes behind an unchanged interface would not be
   caught.
3. **Lifecycle claims marked UNVERIFIED in §3.2.** Restart semantics and the permanence of
   revocation rest on the official frontend, not on executed transactions.
4. **Composition.** No ACTIVE miner currently references sub-circuits, so the local-versus-recursive
   distinction is shown only on a non-admissible circuit.
5. **Registration window.** `registerMiners` books income claimed before registration under the then
   current composition; `depositMiners` has no such window.
6. **Mock-only scenarios.** An ACTIVE old miner failing settlement, and claims during a Mining outage,
   cannot be produced on the real protocol without patching it.
7. **Wallets that cannot receive ERC-1155** are stopped by the tooling, not the contract.
8. **Not covered.**
   - The Safe{Wallet} interface itself. The batch files were executed through real Safe contracts
     (§3.6).
   - Real (non-impersonated) deposits.
   - Long-running behaviour on the real protocol.
   - An audit.

## 7. Reproduce

```bash
npm ci --ignore-scripts
```

```bash
FORK_RPC_URL=https://bsc-mainnet.public.blastapi.io SLITHER=$(which slither) npm run verify
```

Individual parts: `forge test --no-match-path 'test/fork/*'`, `npm run test:sdk`, `npm run typecheck`,
`npm run test:local-e2e`, and with `FORK_RPC_URL` set, `npm run test:fork` (pinned inputs as recorded
in the manifest), `npm run test:fork-e2e` and `npm run test:fork-safe-e2e`. Read-only probes: `scripts/probe-lifecycle.ts`,
`scripts/probe-revocation.ts`, `scripts/probe-circuit-burn.ts`, `scripts/probe-references.ts`.
