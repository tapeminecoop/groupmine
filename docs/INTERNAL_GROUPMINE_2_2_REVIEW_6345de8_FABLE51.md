# Internal security review of Groupmine 2.2.0 (target 6345de8) — Fable 5.1

Date: 2026-10-29. Reviewer: Claude Fable 5.1, owner-authorized internal review. Target commit
`6345de8c488f3a7f2193a0fc8c067067334278ef` (`TapeoutMinerPool/2.2.0`, package `2.2.0-rc.1`).
Evidence directory: `reports/internal-review-6345de8-fable51/` (logs, machine-readable results, identity
records, `README.md` with the command index). Review-only tests and the independent model:
`test/review-fable51/`. Nothing under `src/`, the existing tests, the lockfiles, the historical reports or
the approved manifests was changed; the final source-difference record is in the evidence directory.

Labels used throughout: **VERIFIED_BY_EXECUTION** (I ran it in this review), **SOURCE_CONFIRMED** (read
and reasoned from the frozen source), **AUTHOR_RECORDED** (taken from the implementer's recorded
evidence, not re-executed), **UNVERIFIED/NOT_EXECUTED**, **HYPOTHESIS/NOT_REPRODUCED**.

## 1. Executive conclusion

**No confirmed Medium or High production-contract defect was found.** The two code changes the SALUS
remediation claims (carried income attributed by each miner's own burn in a fractional ledger; custody
finality at the first admission) do what they claim, and I established that independently: an
independent model written from the economic specification agrees with the contracts on every ledger
word over 400 random action traces, the 2.1.0 order-dependence counterexample was executed on the
pre-remediation code and its absence executed on 2.2.0, and the finality gate was exercised with
pending and completed ownership handovers, mimic and empty distributors, and on real BSC state.

What remains are design limits, trust boundaries and documentation gaps that the owner should
accept or address explicitly before release:

- **P-1 (Low).** Every admission settles the whole registry in one transaction, and the registry is
  append-only. With the real Mining claim cost measured at 27,857 gas per registered miner, a single
  admission stops fitting BSC's 16,777,216 gas cap at about 590 registered miners, after which no miner
  can ever be admitted again. Harvests and claims are unaffected. Documented as a tooling estimate; it
  is in fact a permanent on-chain ceiling.
- **P-2 (Low, policy).** A revoked registered miner keeps its burn in the aggregate composition forever,
  so later ordinary income is still split as if it earned.
- **P-3 (Low, external).** Any non-REVOKED claim failure of one registered miner blocks every future
  admission. On the deployed, non-upgradeable Mining this is reachable only through the upgradeable miner
  collection (X-1), not through Mining itself.
- **P-4 (Informational, documentation).** The ledger's sub-unit floors do cross raw-unit boundaries:
  NAND can be paid exactly one raw unit (10^-8 BEM) below the floor of its exact entitlement whenever that
  entitlement is an integer (or within a few ledger units above one) and the per-split floors lost a
  fraction. Lifetime error is bounded by one raw unit, nobody gains it, and it is reachable with
  ordinary inputs (2 of 20,000 random traces; nine miners each carrying one raw unit at burn 7:5). The
  "under 10^-17 raw units" wording in docs/ACCOUNTING.md and the remediation report describes ledger
  units, not raw outcomes, and should be corrected.
- **X-1 (Medium, external dependency, not new).** The miner collection is a beacon proxy whose beacon
  owner is a 130-byte proxy administered by `0xB3D85b42A045c1A88D800CAD0F55d2566a4D3138`. An upgrade can
  change `ownerOf` (where Mining pays), add transfer hooks, or refuse transfers. The pool cannot detect or
  mitigate it; only off-chain `protocol-check` does.
- **T-1 (Low, tooling).** `activate`'s preflight checks only that the bound distributor reports
  `allocationFinalized`, not that the allocation covers the issued supply; an empty or partial
  distributor passes the on-chain gate and the CLI.

SALUS #2 and #3 are, on my independent result, fixed in code with the boundaries stated in §5. #1 is a
risk acceptance, not a fix. #4–#8 remain open and visible; #6 now also delays activation and custody.

The targeted changes need no additional contract work before external review, provided the owner
records the acceptances in §5 and §8 and fixes the documentation and tooling items. Scope and
assumptions of this conclusion are in §8.

## 2. Target, baseline, coverage, threat model, and what ran

### 2.1 Freeze

| Item | Value | Label |
| --- | --- | --- |
| Target HEAD | `6345de8c488f3a7f2193a0fc8c067067334278ef` | VERIFIED_BY_EXECUTION (`git rev-parse`) |
| `origin/main` at review time | `6345de8c…` (no newer main) | VERIFIED_BY_EXECUTION (`git ls-remote`) |
| Source-tree fingerprint (`verify-all.ts --fingerprint`) | `c464fe4bc89a9e1fd0de0943577458980b8231d2a33e6594b83373b442d87874`, 163 files: **equal to the fingerprint of the implementer's recorded run**, so the committed tree is the tree that run tested | VERIFIED_BY_EXECUTION |
| SALUS PDF sha256 | `2ecddb8f…7b7a`, matches the remediation report | VERIFIED_BY_EXECUTION |
| Baseline (merge first parent) | `c78a6d1234441137f8407fd30f904061ba792510`; used for the diff review and for executing the 2.1.0 counterexample in an isolated export | VERIFIED_BY_EXECUTION |
| Dependencies | `npm ci --ignore-scripts` from the lockfile; `@openzeppelin/contracts` 5.4.0 (integrity `sha512-eCYgWnLg…`), no lifecycle scripts in the lockfile; solc 0.8.24, via-IR, 200 runs, Paris; forge 1.4.3-stable; node 20.19.5 | VERIFIED_BY_EXECUTION |
| Build sizes | pool 23,168 B runtime (1,408 under EIP-170), initcode 35,118; receipt 8,743; distributor 7,680; canary 24,439 B (137 under); `CanaryParticipant` 3,410 | VERIFIED_BY_EXECUTION (`forge build --sizes`) |
| SDK bytecode | `sdk/bytecode.json` creation-code sha256 equals the fresh build for all three contracts; `export-abi` leaves `sdk/abi.ts` and `sdk/bytecode.json` unchanged | VERIFIED_BY_EXECUTION |
| Canary generator | `build-source.mjs --check`: generated canary-3 equals the exhaustive patch list applied to production source sha256 `f8b8d4d0…`, which is the current `src/TapeoutMinerPool.sol` | VERIFIED_BY_EXECUTION |

### 2.2 Source coverage

Read in full: `src/TapeoutMinerPool.sol`, `src/PoolMath.sol`, `src/TapeoutEntitlementReceipt.sol`,
`src/TapeoutReceiptDistributor.sol`, both interfaces, the canary diff and generator, OpenZeppelin 5.4.0
`Ownable`/`Ownable2Step` (renunciation path), `sdk/math.ts`, the relevant parts of `sdk/pool.ts`,
`sdk/gas.ts`, `sdk/verify.ts`, `cli/pool.ts` (finalize/bind/activate/renounce/finality/deposit), the runner
scripts I executed, `test/helpers/*`, the SALUS suites and FFI model, the fork fixtures, the implementer's
edits to `test/audit`, `test/audit2`, `test/remediation` and `test/invariant`, docs ACCOUNTING,
ARCHITECTURE §4.6/§7, OPERATIONS §9, MINING_LIFECYCLE, the SALUS remediation report, the SALUS PDF text
(extracted with pypdf), and the recorded run manifest.

### 2.3 Threat and authority model

Actors: a whitelisted depositor (16 at most, fixed at deployment); any address (harvest, sync, release,
claim with a held receipt, delivery, third-party `Mining.claim`, revocation via `challenge`); the A and B
role holders (self-migration only); the setup owner of each of the four contracts until renunciation; the
upstream authorities (BEM minter = Mining proxy; Mining owner renounced; miner-collection beacon admin
`0xB3D8…3138`). Assets at risk: miner NFTs in permanent custody, BEM held by the pool, receipts in the
distributor, and the entitlement ledger. Not in scope of on-chain enforcement: truth of the contribution
JSON, the identity of the bound distributor's code, and the operator's correct ordering of setup steps.

### 2.4 Executed versus read

| Evidence | Result | Label |
| --- | --- | --- |
| `forge test` unit/fuzz/invariant/remediation/audit2/SALUS (`--no-match-path test/{fork,audit,salus-ffi}/*`) | 226/226 pass, 29 suites, 19 invariant campaigns (256 runs × depth 64, fail-on-revert) | VERIFIED_BY_EXECUTION |
| `test/salus-ffi` differential (`--ffi`, implementer's model) | 2/2 pass | VERIFIED_BY_EXECUTION |
| `test/audit` with its Python model (`--ffi`) | 10/10 pass | VERIFIED_BY_EXECUTION |
| Gas model (bounds as transaction gas limits) | 11/11 pass | VERIFIED_BY_EXECUTION |
| `tsc --noEmit`; SDK tests; audit TypeScript tests | clean; 78/78; 13/13 | VERIFIED_BY_EXECUTION |
| Local Anvil CLI end-to-end (`local-e2e.ts`, mock protocol) | PASS, 59/59 checks, 69 steps | VERIFIED_BY_EXECUTION |
| Largest-wallet check | PASS | VERIFIED_BY_EXECUTION |
| Real-BSC fork tests (`fork-test.ts`, 20 tests, block 128,713,128, hash `0x760f050b…081f`, RPC host `bsc-mainnet.public.blastapi.io`, pinned miners from the manifest) | PASS 20/20 | VERIFIED_BY_EXECUTION; the local foundry RPC cache for that block pre-existed on this machine, so the run may have read cached storage |
| The same SALUS and boundary fork tests with `--no-storage-caching` | 7/7 pass from the live endpoint; the endpoint was also probed directly (block hash and Mining `owner()==0` at the pinned block) | VERIFIED_BY_EXECUTION, cache excluded |
| CLI fork end-to-end (`fork-e2e.ts`, Anvil fork, real Mining/BEM) | PASS 25/25 | VERIFIED_BY_EXECUTION |
| Safe end-to-end (`fork-safe-e2e.ts`, real Safe contracts) | PASS 266/266, 25 Safe transactions | VERIFIED_BY_EXECUTION |
| Slither 0.11.3 on an isolated export of the tree | 170 results, triaged in §3.2; nothing new of Medium or above in `src/` | VERIFIED_BY_EXECUTION (the recorded run had skipped it) |
| Review PoC suite `test/review-fable51/ReviewFindings.t.sol` | 18/18 pass | VERIFIED_BY_EXECUTION |
| Review differential `ReviewDifferential.t.sol` against `model_fable.py` (`--ffi`) | 300 random traces + 100 small-amount traces, every word equal, model invariants held | VERIFIED_BY_EXECUTION |
| Rounding property search `search_rounding.py` (no EVM) | results in `results/rounding-search.json` | VERIFIED_BY_EXECUTION |
| 2.1.0 counterexample on an export of `c78a6d1` | executed, order-dependent as claimed | VERIFIED_BY_EXECUTION |
| Canary-3 local rehearsal (`fork-local-candidate.ts`) | **NOT_EXECUTED** by choice: it runs the shutdown and `emergencyReturn` recovery entry points, which the brief lists among the canary commands not to run; the implementer's 46/46 and 9/9 results are AUTHOR_RECORDED. `CanaryRecoveryTest` ran inside the 226 | AUTHOR_RECORDED |
| Mining bytecode lifecycle analysis (`scripts/mining-analysis`) | not re-run; its conclusions were used only where my own fork executions or probes agree | AUTHOR_RECORDED |
| Read-only chain probes (`cast`, pinned block and head) | Mining `owner()==0`; BEM `MAX_SUPPLY()` 2.1·10^15 raw, `minter()` = Mining proxy, `totalSupply` 3.943·10^13 at the pinned block and 4.436·10^13 at head 130,351,381; beacon-owner proxy `0x6822…F7e2` reports `owner()` `0xB3D8…3138` | VERIFIED_BY_EXECUTION (read-only) |

No transaction was signed or broadcast; no `.env` or key was read; fork impersonation (`vm.prank`,
Anvil impersonation) happened only on in-process forks and loopback Anvil nodes.

## 3. Findings

Severity is the usual High/Medium/Low/Informational; confidence is High unless stated.

### 3.1 Production contracts

**P-1. Admission capacity is a permanent on-chain ceiling (Low, confidence High).**
Actor: none needed; the registry grows with ordinary use. Source: `_admit` step 3 loops `_settleOld`
over every registered miner (`src/TapeoutMinerPool.sol:659-663`), and `_minerIds` only grows.
Expected invariant: a correctly initialized pool can always admit an ACTIVE miner from the whitelist.
Actual: the cost of one admission is linear in the registry. Measured on the real protocol in my fork
run (`results/fork/fork-gas.json`): 514,781 gas with 0 registered, 877,605 with 23, maximal marginal
27,857 per registered miner. With the mock Mining the marginal is 7.2–8.0k (my
`testAdmissionGasGrowsLinearlyWithTheRegistry`: 369k → 4.17M gas from 0 to 500 registered), so the mock
underestimates the real slope by ~3.5×. Under BEP-652 (gas limit ≤ 16,777,216) an admission of one
miner fits while `300k + 250k + 27,857·R ≤ 16.78M`, i.e. R ≤ ~582 (the docs say ~590; the CLI stops at
401 under its 3/4 budget). Beyond that, `depositMiners` and `registerMiners` always run out of gas and
there is no paging path for settlement. Impact: liveness of admissions only; custody, harvests, claims,
releases and delivery are unaffected. Reachability: certain if the registry ever reaches that size;
the whole protocol has 17,809 ACTIVE miners. Minimal remediation (optional, contract change): a
paged "settle registered miners" step that an admission may require to have been completed within the
same block, or an explicit `MAX_REGISTRY` constant that refuses admissions beyond a planned size, so the
limit is declared rather than discovered. If no change: record it as an accepted design ceiling in
ARCHITECTURE/OPERATIONS ("about 590" becomes "at most ~580, permanent"). Regression: the gas test above
plus the fork scaling test. Label: VERIFIED_BY_EXECUTION.

**P-2. A revoked registered miner keeps its weight in the composition (Low, policy).**
Source: `_settleOld` skips REVOKED (`:780-789`) but `totalNandBurn/totalLatchBurn` are never reduced.
Demonstrated by `testRevokedOldMinerKeepsItsWeightInTheComposition`: after miner A (10:0) is revoked and
only miner B (0:10) earns 840 raw, NAND holders still receive 400 of the 800 participant units. No loss,
no double payment; a persistent fairness distortion between the two categories proportional to the
revoked burn share. This is the implementer's "O-02, pending acceptance". Remediation options: accept
(document in ACCOUNTING §4 that revoked burn stays), or at the next admission boundary drop the revoked
miner's burn from the totals (it is a boundary, so no period is re-split). Regression: the test above.
VERIFIED_BY_EXECUTION.

**P-3. Strict settlement couples every future admission to every registered miner's claim (Low,
external reachability).** Source `:780-789`. Demonstrated with mock fault injection
(`testNonRevokedSettlementFailureBlocksAdmissionsButNotHarvests`): one registered miner whose claim
reverts for a non-REVOKED reason makes every admission revert while `harvestRange` isolates it.
Reachability with the configured dependencies: Mining's `claim` reverts only for status ≠ 1 (selector
`0x5f9bb3be`, MINING_LIFECYCLE §4, AUTHOR_RECORDED code analysis consistent with my fork executions); a
pool-held miner can only move 1 → 2 (REVOKED, skipped) since `stop` is holder-only; near BEM's cap
settlement pays 0 rather than reverting; Mining is non-upgradeable (owner 0, probed). The remaining
revert path is the collection's `ownerOf` call inside settlement, which the beacon admin could change
(X-1), and out-of-gas (P-1). So on today's protocol this is not reachable without X-1. Recommendation:
keep strict settlement (it is the correct fail-closed choice) and record the dependency. SOURCE_CONFIRMED
+ VERIFIED_BY_EXECUTION (mock).

**P-4. Raw-unit rounding of the fractional ledger (Informational, documentation).**
Expected invariant (docs): "each category is within one raw unit; NAND never above"; claimed
practical error "under 10^-17 raw units". Actual: `PoolMath.carriedUnits`/`categoryUnits` floor each
split to a ledger unit (1/(84·10^18) raw); the losses add across entries, and `accrue` floors the sum to
raw units. When the exact NAND entitlement is an integer number of raw units, any positive accumulated
loss drops NAND by a full raw unit. Minimal reproduction (`testNandIncomeCanBeOneRawUnitBelowItsExactIntegerEntitlement`):
nine miners each carrying 1 raw unit with burn 7:5; exact NAND = 9·80/84·7/12 = 5 raw, paid 4; LATCH exact
25/7, paid 3; the unit stays as residue. A larger instance: 11 miners carrying 924,084 raw at 1:10 (exact
880,080, paid 880,079). Frequency in 20,000 random traces with amounts up to 10^9: 2. Bounds I verified
(model + 400 differential traces): NAND_policy ∈ {⌊exact⌋, ⌊exact⌋−1}; LATCH_policy ≤ exact + k ledger
units and ≥ exact − 1; nandIncome + latchIncome ∈ {P, P−1}. Lifetime loss ≤ 1 raw unit per category, not
accumulating. Impact: 10^-8 BEM. Remediation: correct the sentence in ACCOUNTING §6 and the remediation
report §4.5 to state the raw-unit outcome ("NAND is ⌊exact⌋ or ⌊exact⌋−1, the latter whenever the exact
entitlement is within the accumulated ledger loss above an integer; at most one raw unit, kept as
residue"). VERIFIED_BY_EXECUTION.

**P-5. Pre-first-admission views disagree (Informational).** `unrecognizedBalance()` returns 0 while
`N + L == 0`, so `previewAccrual`/`claimable` show nothing, but `reconciliation().unrecognized` reports the
held BEM (`testBemHeldBeforeAnyCompositionIsRecognizedUnderTheFirstComposition`). Consistent with the
documented rule (nothing is recognized before a composition exists) but worth one sentence in the
`reconciliation` NatSpec. VERIFIED_BY_EXECUTION.

**P-6. `MinersAdmitted.newPeriodIncome` NatSpec is narrower than the code (Informational).**
The event comment says new-period income is "only possible at the first admission". Any BEM that
reaches the pool between the checkpoint (step 4) and `_collectCarried`'s first balance read is booked
there in any admission, under the new composition. With the real collection at block 128,713,128 an NFT
transfer pays nothing and leaves `pending` in place (fork fixture assertion, executed), so today only a
donation inside the same transaction could do it; a transfer hook added by a collection upgrade (X-1)
would too (`testTransferHookIncomeInANonFirstAdmissionIsBookedUnderTheNewComposition`, mock-only).
Remediation: adjust the comment. SOURCE_CONFIRMED + VERIFIED_BY_EXECUTION (mock).

**P-7. What the finality gate establishes on chain, and what it does not (trust boundary, no code
defect).** Established by code: receipts are the exact reviewed implementation (constructor codehash
check), supplies fixed and equal to the activation arguments, the bound address reports this pool and
these receipts at binding, `allocationFinalized()` true at activation, and all four `owner()` views zero
at the first admission; renounced ownership cannot return (OZ 5.4.0 `_transferOwnership` deletes the
pending owner; `testRenounceClearsPendingOwnerOnAllFourContracts` on all four contracts). Not
established, each demonstrated: (a) the distributor's code — a contract with the five views binds,
activates, opens custody, can later flip its reported owner and move receipts anywhere, and the pool
never reads it again (`testMimicDistributorPassesEveryOnChainCheck`); (b) that the receipt supply sits
in the distributor — a distributor finalized with an empty inventory satisfies the gate while the
former issuer keeps every receipt as an ordinary holder (`testEmptyDistributorFinalizationSatisfiesTheGateWhileTheIssuerHoldsAllReceipts`);
(c) that only one distributor exists — a second genuine distributor for the same pool finalizes and
delivers on its own (`testUnboundGenuineDistributorStillDelivers`); (d) the allocation JSON. The
documentation (ARCHITECTURE §4.6, remediation report §5.5) states (a) and (d) correctly and does not
over-advertise; (b) and (c) are implied but not spelled out. Recommendation: add (b) and (c) to §5.5 and
make the tooling gate in T-1 explicit. VERIFIED_BY_EXECUTION.

**P-8. Early renunciation is unrecoverable and only the CLI refuses it (Informational, operator
error).** A receipt issuer who renounces before `finalizeIssuance` leaves activation impossible forever
(`testEarlyRenunciationOfAReceiptIssuerIsUnrecoverable`); the same holds for the pool owner before
`bindDistributor`/`activate` and the distributor owner before `finalizeAllocation`. Nothing is in custody
at that point, so the cost is a redeploy. The CLI `renounce` preflight refuses these; a direct call does
not. Acceptable; record in OPERATIONS §8. VERIFIED_BY_EXECUTION.

Checked and found sound (SOURCE_CONFIRMED, and covered by the differential unless noted): no `_sync`
runs between an incoming claim and its attribution and the carried total enters `T` once (steps 4–6;
`accountedBase` moves with `T`); the first admission's pre-existing BEM is not counted as carried
(measured as per-claim deltas only) and is recognized once afterwards; the `uint120` carried record
reverts (`UnexpectedTokenBehavior`) above 2^120−1 raw with full rollback (executed); zero denominators
are impossible (`EmptyComposition` before `carriedUnits`; `weight != 0` guard in `categoryUnits`);
arithmetic range: `(T − base)·80·10^18·N` overflows only for a total burn weight above 6.9·10^41 at
BEM's cap, i.e. never; every state-changing entry point is `nonReentrant`, `setRecipient` makes no
external call, and views are unguarded by design; `_payWithSink` writes every counter before either
transfer and checks all three deltas (T = 42 pays C 1 and A 0, a second release pays nothing, a blocked
sink reverts the whole release with counters unchanged: `testSinkAtT42RepeatedReleaseAndAtomicFailure`);
equal A/B addresses pay exact deltas; both admission entry points are gated by finality and neither
renounces anything (`testRegisterPathIsGatedByFinalityToo`); the receipt's `_update` keeps the holder
index exact for zero-value and self transfers; the distributor refuses receipts with claim history and
anything after finalization.

### 3.2 Tooling

**T-1. `activate` preflight does not require allocation coverage (Low).** `cli/pool.ts` `activate`
checks finalized issuance, supplies, the binding and `allocationFinalized` only. `verify-allocation`
knows the state `FINALIZED_INCOMPLETE_COVERAGE`, and `finalize-allocation` re-verifies, but an operator
who finalized an empty or partial distributor (deliberately or by a direct call) can still activate and
launch. Remediation: `activate` (and `finality`) should run `runVerification` and require
`FINALIZED_AND_MATCHES` (or `_PARTIAL` with `--partial`). Regression: a local-e2e step that finalizes an
empty distributor and expects `activate` to refuse. SOURCE_CONFIRMED.

**T-2. The `finality` status reads the five views only (Informational).** Same limit as P-7(a); the
documented defence is `verify-deployment`'s code-identity check, which I did not execute against a
mimic. AUTHOR_RECORDED that it checks the pool's binding.

**T-3. Static analysis (Informational).** Slither 0.11.3 on an isolated export: 170 results, of which in
`src/`: 58 `calls-loop` (Low: the settlement/harvest/delivery loops, by design), 13 `reentrancy-no-eth`
and 5 `reentrancy-benign` (all inside `nonReentrant` functions, writes after calls to Mining/NFT/receipts
by the checks-effects pattern the design documents), 10 `uninitialized-local` (zero-initialized
accumulators), 6 `incorrect-equality` (`== 0` early returns), 2 `reentrancy-events` (OZ receiver hooks
in `issue`/`retract`), 2 cyclomatic-complexity, 1 pragma, 1 `immutable-states` (`category` is
deliberately not immutable so every receipt deployment shares one runtime code). The one High
(`incorrect-exp`) is outside `src/`. No new real issue. VERIFIED_BY_EXECUTION. Recommendation: add
Slither to the recorded run so the manifest is no longer `INCOMPLETE`.

Preserved protections I exercised (VERIFIED_BY_EXECUTION through the local and fork end-to-end runs and the
SDK tests): JSON-to-chain allocation identity and full-supply coverage in `verify-allocation`, pool
binding checks, `VERSION` read before tuple decoding (2.1.0 layouts refused; canary-3 layout only on a
loopback node), progress-safe delivery gas, duplicate-ID normalization, structured revert
classification, Safe batch gas bounds (smallest margin unchanged from the recorded run).

### 3.3 Canary-only

**C-1. Canary-3 has 137 bytes of EIP-170 headroom (Informational, canary).** Reproduced. Any further
production change will push the generated canary over the limit; production keeps 1,408 bytes. Not a
production risk; it constrains future canaries, which are local-only candidates anyway.

**C-2. No production recovery authority.** The production/canary diff adds only the canary's
`recoveryController`, `closed`, `returned`, `shutdown`, `emergencyReturn` (IDs 3204/12485, no Mining or
BEM call) and the closed-checks; `build-source.mjs --check` passes against the production source hash;
`grep` finds no recovery symbol in `src/TapeoutMinerPool.sol` or the SDK's production paths. SALUS #7
(missing event in `CanaryParticipant.bindPool`) and #8 (literal IDs) remain in the canary as recorded.
VERIFIED_BY_EXECUTION (generator check) + SOURCE_CONFIRMED.

### 3.4 External dependencies

**X-1. Miner-collection upgrade authority (Medium impact, external, not new).** The collection proxy's
beacon is owned by `0x68224F668083c29e9800Be2a646d42d18cedF7e2`, a 130-byte ERC-1967 delegating proxy
whose `owner()` is `0xB3D85b42A045c1A88D800CAD0F55d2566a4D3138` (probed read-only at the pinned block).
A new implementation could redirect `ownerOf` (Mining pays the holder it reports, so pool income would
stop or go elsewhere), add transfer hooks (P-6), make `ownerOf` revert (P-3) or refuse transfers to the
pool (admissions). Pool-side mitigation is impossible without an on-chain code check the design
rejects; the off-chain `protocol-check` pins the implementation hash. Recommendation: explicit owner
acceptance (the implementer's "U-02 pending acceptance") and monitoring of the beacon's implementation
slot as an operational control. VERIFIED_BY_EXECUTION (identity), HYPOTHESIS for the consequences.

**X-2. BEM supply cap (Low, external).** `MAX_SUPPLY()` is 2.1·10^15 raw; `totalSupply` is 2.1% of it at
head. Mining's settlement mints `min(accrued, MAX_SUPPLY − totalSupply)` (MINING_LIFECYCLE §5,
AUTHOR_RECORDED). At the cap the premise "each incoming miner's payment is fixed" fails: in one admission
batch the first claims receive the remainder and later ones nothing, so carried attribution becomes
order-dependent at that boundary, and the forgone remainder is lost upstream. Far from reachable today;
record it as the one documented exception to order independence.

**X-3. Mining is immutable (confirmed).** `owner()==0` at the pinned block (probed) and `miningPaused`
false (my fork identity run); the implementer's bytecode analysis of the upgrade and pause paths is
AUTHOR_RECORDED and consistent with the executed fork facts (a stranger's `upgradeToAndCall`/`pause`
revert).

**X-4. BEM is a plain token with the Mining proxy as `minter()`** (probed); the sink transfer leaves
`totalSupply` unchanged (my fork sink observation: supply equal before and after both releases). The
pool's exact-delta checks make any future fee/rebase behaviour fail closed (releases and claims would
revert), which would be a liveness, not a loss, event.

### 3.5 Intentionally accepted policies (not defects, recorded so nothing is silently closed)

- Unsolicited NFT transfers and the `registerMiners` window (SALUS #1): see §5.
- No recovery, withdrawal, sweep, upgrade or administrator override anywhere in production.
- A category with zero receipts refuses miners that burn it (`UnsupportedCategory`); no redirection.
- C is paid to `0x…dEaD` by plain transfer with every A/B release; not a burn.
- Residue (≤ 3 + 1 + (S_N−1) + (S_L−1) raw units) stays in the pool and is never an account.

## 4. Independent accounting result

**Model.** `test/review-fable51/model_fable.py` keeps a list of ledger entries (closed ordinary
periods and carried miners) and recomputes every quantity from scratch, in the claimed finite-precision
policy and in exact rationals, with its own conservation, monotonicity and bound checks. It imports none
of PoolMath, sdk/math or the implementer's models. The driver `ReviewDifferential.t.sol` applies random
traces (prepare miners with visible and `pending`-hidden income; batch and single admissions including
ones that must revert; plain transfers and `registerMiners`; accruals; harvests; third-party claims;
donations; real-style revocations that pay first; mock-only cooling that must block admissions; receipt
claims and transfers; A/B releases) to the contracts and to the model, syncs, and compares 26 ledger
words plus every per-ID history, nine actor balances and every registered miner's carried record.
Result: 400/400 traces equal, model invariants held. VERIFIED_BY_EXECUTION.

**Properties supported** (model, differential, PoCs, fork): conservation
`bemBalance = (T − totalPaid) + unrecognized` with zero deficit; `T = A + B + C + S_N·perN + S_L·perL +
residue`; `totalPaid = A_paid + B_paid + C_paid + receipt histories`; `nandBase + latchBase =
accountedBase·80·10^18` at every boundary; `nandIncome + latchIncome ∈ {P, P−1}`; monotone A, B, C,
category incomes and per-share values; claimed history never above entitlement; carried income
recognized once; order, batch and partition independence of carried attribution with fixed inputs
(executed also on four real miners in four orders, with and without the RPC cache); path independence
within a period; the SALUS example (NAND 150 / LATCH 50, A = B = 2.5, C = 5 BEM; then 225/75 after 105
BEM at 15:5) in all four orders at raw precision.

**Refuted or corrected claims:** the "under 10^-17 raw units" characterization (P-4): the raw-unit
outcome is ⌊exact⌋ or ⌊exact⌋−1 for NAND; "newPeriodIncome only at the first admission" (P-6) is a
property of the real collection's transfer behaviour, not of the pool.

**Labelled differences from exact economics:** (1) the four outer floors (≤ 3 raw units); (2) the two
category floors (≤ 1); (3) per-share floors (≤ S−1 each); (4) the ledger-floor crossing in P-4 (≤ 1 raw
unit, inside bound 2). Intervening accrual between sequential admissions legitimately changes the
split (executed: X then accrual then Y gives NAND 250 / LATCH 50 BEM versus 225 / 75 for the batch);
upstream time advance changes what a claim pays, so "fixed inputs" means the same block and timestamp.

**Rounding and overflow limits:** NAND deficit per entry < 1 ledger unit, cumulative < k units after k
entries, raw crossing iff the exact NAND units are within k units above a multiple of 84·10^18;
LATCH excess ≤ k ledger units and never a raw unit (0 in 20,000 traces); residue bound tight (3 is
reached for `T mod 84 ∈ [64, 83]`); `(T − base)·80·10^18·N < 2^256` for any burn weight below
6.9·10^41 at BEM's cap; `participantUnits(received)·n` with `received < 2^120` and `n < 2^32` fits.

**Fake-distributor and finality trust boundary:** see P-7 and T-1.

## 5. SALUS #1–#8 closure recommendations (my view, not SALUS's)

| # | Recommendation | Basis |
| --- | --- | --- |
| 1 | **Risk acceptance, not a fix.** Executed: a plain transfer registers nothing; a revoked transferred miner is unadmittable; its payout stays unrecognized until a valid admission books it as ordinary income of that admission's new period (a windfall to all holders under the then composition, no harm to others; the sender bears the loss). Wording to record: "unsolicited assets are unrecoverable by design; no production role can withdraw, sweep or redirect them." | VERIFIED_BY_EXECUTION (SalusAdmission suite in the 226, fork register-window observation, differential `N`/`E`/`V` ops) |
| 2 | **Fixed in code, independently confirmed.** Old rule executed on `c78a6d1`: X then Y 175/25, Y then X 125/75, batch 150/50 BEM. New rule: 150/50 in all orders, per-miner records equal to each miner's own claim payment on real state. Heterogeneous incomes and burns are attributed per miner, not as a weighted average (model and fork). Remaining caveats: P-4 wording; X-2 at BEM's cap. | VERIFIED_BY_EXECUTION |
| 3 | **Fixed for post-initialization powers; setup and code-identity trust remain and are documented.** Post-custody, no `onlyOwner` function on any of the four contracts can ever execute (owners zero, pending cleared, no path back). Retained trust: setup keys until renunciation; the bound distributor's code and inventory coverage (P-7, T-1); the allocation JSON; the off-chain identity tooling. Recommend adding P-7(b)/(c) to §5.5 and T-1 before asking SALUS to confirm. | VERIFIED_BY_EXECUTION |
| 4 | Open. `revokeWallet` is unbounded; the CLI's largest-wallet gate (executed, PASS) is the only control. Keep visible. | VERIFIED_BY_EXECUTION (tooling), SOURCE_CONFIRMED |
| 5 | Open. `retract` needs issuer-held top IDs; correct over-issuance before any handover. Runbook item. | SOURCE_CONFIRMED |
| 6 | Open and **slightly magnified**: finalization now gates activation and custody, so an outsider who holds receipts before finalization can delay the launch by front-running `finalizeAllocation` (executed: a stray receipt makes `finalizeAllocation` revert `InventoryNotCovered` and `activate` revert `AllocationNotFinalized` until the owner allocates it). Mitigations without code: issue every receipt into the distributor so no outsider holds any before finalization, or allocate-and-finalize atomically in one Safe batch. | VERIFIED_BY_EXECUTION |
| 7, 8 | Open, canary-only; no production impact. | SOURCE_CONFIRMED |

## 6. Evidence status

Passed: everything in §2.4 marked VERIFIED_BY_EXECUTION. Failed: none. Skipped by choice: the canary-3
local rehearsal (§2.4). Unavailable: none of the planned steps was unavailable; the public archive
endpoint served the pinned block. Historical-only: the mainnet canary-1 run and its approvals (untouched,
not evidence for 2.2.0). Unexecuted: the Mining bytecode analysis, `verify-deployment` against a mimic,
real (non-impersonated) deposits, the Safe{Wallet} interface, long-running behaviour, any launch
allocation JSON or wallet set (none supplied), and admission gas beyond 24 registered miners on real
state (the ~580 ceiling is an extrapolation from a measured linear slope).

## 7. Deployment-input limitations

No deployment manifest, allocation JSON, launch wallets or maximum inventory for 2.2.0 exist in the
tree (`deployments/examples/` are placeholders). Gas figures that depend on them (largest wallet,
first-admission batch) were exercised with the fixtures' sizes only. `FIRST_ADMISSION_GAS` and the
admission model fit the fork measurements (538,382 CLI first deposit against 700,000 planned, recorded
and re-measured at 514,781 in-test).

## 8. Prioritized issues and remaining gates

1. Owner decisions to record in writing: SALUS #1 acceptance; P-2 (revoked weight); P-1 (admission
   ceiling, or a paging/`MAX_REGISTRY` change); X-1 acceptance with monitoring; X-2 as the documented
   exception.
2. Documentation fixes: P-4 wording in ACCOUNTING §6 and the remediation report §4.5; P-6 NatSpec; P-7(b)/(c)
   in §5.5; P-8 in OPERATIONS §8; #6's enlarged effect.
3. Tooling: T-1 (`activate`/`finality` require verified coverage); add Slither to the recorded run.
4. External review gates: SALUS confirmation of #1–#3 as framed in §5; a reviewed deployment manifest
   and allocation JSON; a decision on canary-3 (local-only, 137-byte margin).
5. Scope of "no Medium/High found": production contracts as frozen, with OpenZeppelin 5.4.0, the
   deployed Mining implementation `0xa3DB…f898`, BEM `0x5ce0…695a` and the collection implementation at
   block 128,713,128; an honest setup operator following OPERATIONS; and no upgrade of the collection.
   It is not a statement about the off-chain allocation, the Safe UI, or future upstream changes.

## 9. Reproduction

```bash
npm ci --ignore-scripts && forge build --sizes
forge test --no-match-path 'test/{fork,audit,salus-ffi}/*'
forge test --match-path 'test/salus-ffi/*' --ffi && forge test --match-path 'test/audit/*' --ffi
forge test --match-path 'test/review-fable51/ReviewFindings.t.sol' -vv
forge test --match-path 'test/review-fable51/ReviewDifferential.t.sol' --ffi
python3 -I test/review-fable51/search_rounding.py /tmp/rounding.json
npm run typecheck && npm run test:sdk && npm run test:local-e2e
FORK_RPC_URL=<archive> FORK_BLOCK=128713128 FORK_NAND_MINER=12733 FORK_LATCH_MINER=13948 \
  FORK_INACTIVE_TOKEN=648 FORK_SCALE_MINERS=<from the manifest> npm run test:fork
FOUNDRY_PROFILE=fork FORK_RPC_URL=<archive> FORK_BLOCK=128713128 forge test \
  --match-contract 'SalusForkTest|PoolBoundaryForkTest' --no-storage-caching
```

The 2.1.0 counterexample: export `c78a6d1` (`git archive`), link `node_modules` and `lib`, add
`reports/internal-review-6345de8-fable51/poc/OldOrder.t.sol` under `test/review-old/`, run
`forge test --match-path 'test/review-old/*' -vv`. Slither: `slither .` in an export of the tree
(a venv with `slither-analyzer==0.11.3`). Commands, exit codes and timestamps for every step of this
review are in the evidence directory's `README.md` and `*.status` files.
