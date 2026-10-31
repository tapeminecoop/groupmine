# Internal review of Groupmine 2.3.0: one distributor for two custody pools (target 02ef1f7) — Fable 5.1

Date: 2026-10-31. Reviewer: Claude Fable 5.1, owner-authorized internal change-impact review. Frozen
target `02ef1f7da17683b482b97b28464346bc2cb9db61` (`TapeoutMinerPool/2.3.0`, package `2.3.0-rc.1`).
Evidence: `reports/internal-review-02ef1f7-fable51/` (logs, condensed machine-readable results,
identity records, command index in its `README.md`). Review-only tests: `test/review-02ef1f7/`
(`ReviewTwoPool.t.sol`, 19 tests; `ReviewTwoPoolFork.t.sol`, 1 real-state fork test). Nothing under
`src/`, `sdk/`, `cli/`, `script/`, the existing tests, the lockfiles or the historical reports was changed
(hash-checked before and after the runs; the final source-difference record is in the evidence directory).

Labels: **VERIFIED_BY_EXECUTION** (run in this review), **SOURCE_CONFIRMED** (read and reasoned from the
frozen source), **AUTHOR_RECORDED** (the implementer's recorded evidence, inspected but not re-executed),
**UNVERIFIED/NOT_EXECUTED**, **HYPOTHESIS/NOT_REPRODUCED**.

## 1. Executive assessment

**No confirmed High or Medium defect, asset-locking path, or inability to run was introduced or worsened
by this change.** The complete two-pool lifecycle was executed end to end on a local chain through the
contracts and through the actual CLI, and on a pinned real-state BSC fork with two distinct real miners,
different incomes, late receipt delivery, cross-pool claim history, a receipt transfer, delayed
activation of the second pool after the shared distributor was already ownerless, and per-pool releases
on real BEM. Claim histories are keyed per pool, a claim in one pool never reads or changes the other's,
unpaid entitlement follows a transfer in each pool separately, and each pool's ledger reconciles alone.

The change is narrow and I confirmed its stated boundaries: `PoolMath` and the receipt are byte-identical
to the audited 2.2.0 code; the pool changed only its version string and one membership check in
`bindDistributor` (runtime +2 bytes); the distributor gained an immutable pool pair, membership view,
both-pool history check and both-pool beneficiary refusal; Slither's result set is identical to 2.2.0.

What the owner should still decide or verify before deployment consideration:

- **No new blockers.** The items below are inherited limitations, setup assumptions and tooling gaps.
- **Setup trust is unchanged in kind but has more ways to go wrong (N-1, N-3).** The pools do not read
  each other's binding and the distributor authenticates its pools by views only. Direct calls can
  bind the two pools to two different genuine distributors, or build a distributor around a look-alike
  pool, and nothing on chain notices. The CLI detects every case I tried; the on-chain gate does not.
  This is the 2.2.0 "owner-zero does not authenticate the distributor" boundary with a second pool.
- **Tooling (T-1, T-2).** The deployment check still skips the distributor and binding checks when the
  addresses file omits `distributor`, and now also skips a pool whose key is absent; `activate` still
  requires only `allocationFinalized`, not full-round coverage. Both inherited; the second pool widens
  the surface without changing the class.
- **Integration (N-2).** A pool that has not activated yet reverts `claimable` with
  `ReceiptIdOutOfRange` because its share denominators are still zero; a frontend reading a delayed
  pool must treat that as "not active", not as an error.
- **Operational routing (POL-1).** "Optimal" and "regular" are labels; a miner admitted to the wrong
  pool cannot be moved. The CLI has no per-pool miner allowlist; the only control is the operator.

Answers to the six questions of the brief are in §10.

## 2. Target, baseline and changed surface

| Item | Value | Label |
| --- | --- | --- |
| Target HEAD of the review worktree | `02ef1f7da17683b482b97b28464346bc2cb9db61` = `origin/main` at review time (no newer main) | VERIFIED_BY_EXECUTION |
| Immediate baseline | `bdf906f801f59acefc49094361a530b823a73ab8`, an ancestor of the target; the target is one commit on top of it | VERIFIED_BY_EXECUTION |
| Previously audited implementation | `6345de8c488f3a7f2193a0fc8c067067334278ef`, an ancestor of the baseline. `6345de8..bdf906f` changes only `docs/`, `reports/`, `test/review-fable51/`, `README.md` and the Astra PDF: **no change under `src/`, `sdk/`, `cli/`, `script/`, lockfiles**, so the previously audited code equals the baseline code | VERIFIED_BY_EXECUTION (`git diff --name-only`) |
| Source-tree fingerprint of the target | `5beb9b98851030d337374ba0c4723f2a6da4e345868b4dd2fbb66b6a9b2940a0` (170 files): **equal to the fingerprint recorded in the developer's run manifest**, so the developer's evidence was produced on exactly this tree | VERIFIED_BY_EXECUTION |
| Dependencies | `npm ci --ignore-scripts` from the lockfile; OpenZeppelin 5.4.0; no lifecycle scripts; solc 0.8.24 via-IR 200 runs Paris; forge 1.4.3; node 20.19.5 | VERIFIED_BY_EXECUTION |
| Sizes | pool runtime 23,170 B (1,406 under EIP-170), distributor 8,137 B, receipt 8,743 B, `PoolMath` 58 B, canary-4 24,441 B (135 under), `CanaryParticipant` 3,410 B | VERIFIED_BY_EXECUTION |
| Artifacts | `sdk/bytecode.json` creation code sha256 equals the fresh build for all three contracts; a re-export leaves `sdk/abi.ts` and `sdk/bytecode.json` unchanged; `build-source.mjs --check` passes (canary-4 generated from production sha256 `5cb9e6bd…`) | VERIFIED_BY_EXECUTION |

**Changed surface (`bdf906f..02ef1f7`, 101 files).** Contracts: `TapeoutReceiptDistributor.sol`
(constructor `(owner, optimalPool, regularPool)`, immutables, `isPool`, both-pool `claimed` reads in
`_acceptOne`, both pools refused as beneficiaries, three new errors; `pool()` removed),
`TapeoutMinerPool.sol` (`VERSION`, `d.isPool(address(this))` in place of `d.pool() == address(this)`),
`IReceiptDistributor.sol` (`isPool` replaces `pool`), the generated canary. SDK: two-pool manifests
(`pools.optimal/regular`, `optimalPool/regularPool`), refusal of the single-pool `pool` key, role-aware
plans, deployment check of both pools and the distributor's pair, both-pool verification identity,
`readFinality` via `isPool`, `READ_LAYOUT_VERSIONS = ['TapeoutMinerPool/2.3.0']`, `ISSUE_GAS.perId`
54k→56k and `FUND_GAS.perId` 40k→44k. CLI: `--pool optimal|regular` on every pool-scoped command,
`deploy` of both pools then the distributor, role-checked `bind-distributor` preflight. Deploy script,
examples, runners (two-pool adaptations), 17 new unit tests, 1 new fork test, fixtures adapted
(`regularPool` added to the bases; one review-fable51 mimic gained `isPool`; nothing asserted before was
removed, checked line by line in the fixture diffs). SOURCE_CONFIRMED.

**Fee math and per-pool accounting unchanged: confirmed.** `src/PoolMath.sol` is not in the diff and its
runtime (58 B) is identical; the receipt is byte-identical; the pool's diff is exactly the two hunks
above. The 2.2.0 review's accounting suites (independent model, 400 differential traces, 18 PoCs) all
pass unchanged on this tree (20/20 in the FFI step). VERIFIED_BY_EXECUTION.

**Previous-report applicability.** The 2.2.0 Fable review, the Astra review and `AUDIT_ASSUMPTIONS.md`
apply to the pool accounting, the finality gate, the SALUS #1–#8 dispositions and the external
dependencies, which this change did not touch. They do not cover the distributor's pair, the membership
binding, the both-pool history check or the two-pool tooling; those are reviewed here. Historical
reports stay attached to their revisions.

## 3. Threat and authority model for the change

Actors: the setup owners of five contracts (two receipts, one distributor, two pools) until each
renounces; two whitelists (one per pool, fixed at deployment; the fixtures use the same depositor for
both, production may not); anyone (delivery, harvest, sync, release, claims with a held receipt,
third-party `Mining.claim`); the two pools' A/B role holders; upstream authorities (unchanged). New
trust edges introduced by the change: the distributor constructor trusts the two pool addresses it is
given (view comparison only); each pool trusts the distributor it is given (code presence, `isPool`,
receipts); the distributor's receive hook calls both pools' `claimed` views during funding. No new
state-changing cross-contract call exists: after finalization the distributor makes no call to any pool
and a pool makes no call to the distributor (SOURCE_CONFIRMED: `_deliver` calls only the receipt;
`claim`/`claimBatch` call only the receipt and BEM).

## 4. Initialization dependency diagram and the executed lifecycle

```
receipts (NAND, LATCH) deployed ──┐
                                  ├─► Optimal pool deployed (binds receipt addresses, codehash-checked)
                                  ├─► Regular pool deployed (same receipts, same protocol, own name/owner/whitelist/recipients)
                                  │        └─► Distributor deployed (owner, optimalPool, regularPool): pools must exist,
                                  │            be distinct, report the same receipts and the same BEM/Mining/collection
issue 1..S_N, 1..S_L (issuer or distributor) ─► fund distributor (hook reads BOTH pools' claimed(); pools may be
                                                 unbound and inactive) ─► allocate (neither pool may be a beneficiary)
finalizeIssuance (each receipt) ─────────────────────────────┐
                                                             ├─► finalizeAllocation (requires both issuances final,
                                                             │    allocated == inventory per category)  [irreversible]
bindDistributor (per pool, once, before that pool's activation; isPool + receipts) ──┐
activate (per pool: issuance final, supplies == arguments, bound distributor finalized) ─┘ [irreversible]
renounceOwnership: NAND, LATCH, distributor (shared) + each pool (own)  [irreversible, clears pendingOwner]
first admission into a pool: requires the shared three + that pool renounced ─► custodyOpen (that pool)
later: whitelisted admissions per pool; delivery once; claims per (pool, category, id); releases per pool
```

No circular dependency: funding needs only deployed pools (their `claimed` getters are plain mappings
that never revert on a genuine pool), not bound or active ones; binding needs a deployed distributor;
activation needs the finalized allocation; the first admission needs the renunciations. The regular
pool can bind, activate and renounce after the distributor's owner is zero because binding reads only
views and activation reads only `allocationFinalized`. The two pools never wait for each other.

Irreversible steps: `finalizeIssuance` (each receipt), `finalizeAllocation`, `bindDistributor` (each
pool), `activate` (each pool), each `renounceOwnership`, every admission (custody is permanent), every
delivery, every claim (history). A pool that binds the wrong distributor or admits a miner into the wrong
pool cannot be corrected (N-1, POL-1).

**Executed lifecycle (contract level, mock protocol).** `TwoPoolDistributorTest` (17, developer's) and my
`ReviewTwoPoolTest` (19): import, allocate, finalize, bind both, activate both, renounce five owners,
admit asymmetric miners, deliver once, claim per pool, transfer, release per pool, reconcile per pool;
staggered startup in both directions; failed first admissions rolling back `custodyOpen` in each pool.
VERIFIED_BY_EXECUTION.

**Executed lifecycle (actual CLI, loopback Anvil).** `scripts/local-e2e.ts`: 79/79 checks, 90 steps,
59 local transactions, including: single-pool system and addresses files refused by name; the `--pool`
selector required; `deploy` of both pools and one distributor; a third same-receipt pool and swapped
roles fail verification and writes and cannot bind on chain; a second distributor for the same pools
flagged for both pools by `verify-deployment`; each pool bound and activated; the shared distributor's
owner alone blocks both pools' first admission (checked on chain by bypassing the CLI); independent
admissions, harvests, claims, transfers, releases and deep reconciliation of both pools.
VERIFIED_BY_EXECUTION.

**Executed lifecycle (real protocol, local fork of BSC block 128,713,128, hash `0x760f050b…081f`,
read-only host `bsc-mainnet.public.blastapi.io`, chain id confirmed by the pinned block hash, not by the
id alone).** The developer's `TwoPoolForkTest` (two real miners, two pools, independent claims) and my
`ReviewTwoPoolForkTest`, both with `--no-storage-caching`: optimal pool first (real miner 12733, 88:0),
real income harvested, late delivery keeps the optimal income (per NAND receipt 9.566 BEM at delivery),
inactive regular pool pays nothing, regular pool binds the ownerless distributor, activates, renounces
and admits real miner 13948 (2:64) with carried income 10.784 BEM, NAND #1 claims each pool
independently (optimal history untouched by the regular claim), NAND #2 sold after the optimal claim
only (buyer takes the regular entitlement and all later income in both pools; seller refused), both
pools release A/B/C on real BEM to the shared sink with per-pool `sinkPaid` (4.796 BEM and 0.257 BEM)
summing to the sink's balance delta, both ledgers reconcile. Observations in
`results/review-02ef1f7-fork.json`. The CLI fork end-to-end (26 checks) and the Safe end-to-end (294
checks, 28 Safe transactions) initialize both pools through the CLI. VERIFIED_BY_EXECUTION.

## 5. Findings

Severity: High/Medium/Low/Informational; confidence High unless stated. "New" means introduced by
2.3.0; "inherited" means present in 2.2.0 and unchanged; "enlarged" means the same class with a wider
surface.

### 5.1 Production contracts

**N-1. Mismatched topology is accepted on chain (Informational, setup trust; inherited class, enlarged
surface; documented by the developer).** Actor: a setup owner (mistaken or malicious) before binding.
Source: `TapeoutMinerPool.bindDistributor` checks `isPool(address(this))` and the receipts
(`src/TapeoutMinerPool.sol:296-306`); no pool reads the other's `distributor()`. Executed
(`testTopologyMistakesDirectCallsAllowAndWhatTheyLeave`): a genuine distributor built for (optimal,
decoy third pool) and finalized empty is bound by the optimal pool; the regular pool cannot bind it;
the intended distributor is then unbindable by the optimal pool and is bound by the regular pool; both
pools activate (each against "its" finalized distributor), open custody and operate on different
distributors; the receipts in the intended distributor still deliver and earn in both pools. Also
executed: a second genuine distributor for the same pair bound by one pool
(`testThePoolsDoNotReadEachOthersBinding`, developer's), role-swapped binding (on chain, roles are
labels; the CLI refuses it), and a third pool's own distributor on the same receipts. Impact: no loss of
receipts or BEM in any case I constructed; the mis-bound pool's activation gate was satisfied by a
distributor that holds nothing, so for that pool "allocation finalized" no longer refers to the real
distribution (the same vacuity the 2.2.0 review recorded as P-7(b)/(c)). Reachability: trusted setup
only; an unprivileged party cannot cause it. Detection: `verify-deployment` flags every variant I tried
(both pools must be bound to the file's distributor; the distributor's pair must equal the file's pools in
their roles; `isPool` per pool), and `verify-allocation` requires both pools and their roles.
Remediation (optional, not a code change): record in `AUDIT_ASSUMPTIONS.md` that the launch evidence
must include both pools' `distributor()` equal to the one distributor that holds the full round, as the
developer's change report already says. VERIFIED_BY_EXECUTION.

**N-2. `claimable` reverts on a pool that has not activated (Informational, integration).** Source:
`claimable`/`claimableBatch` revert `ReceiptIdOutOfRange` when `id > shareCount(category)`
(`src/TapeoutMinerPool.sol:529, 547`), and `shareCount` is zero until `activate`. Pre-existing behaviour,
newly relevant because one pool may run while the other is still inactive. Executed on the fork
(`ReviewTwoPoolForkTest`). Impact: a frontend that reads both pools' `claimable` for a receipt must treat
the revert of an inactive pool as "not active", or read `active()` first. Remediation: documentation
(frontend follow-up in `TWO_POOL_DISTRIBUTOR_CHANGE.md` §8); no contract change recommended.
VERIFIED_BY_EXECUTION.

**N-3. The distributor authenticates its pools by views only; a member can veto funding (Informational,
setup trust).** Source: the constructor compares `nandReceipt()`, `latchReceipt()`, `bem()`, `mining()`,
`minerCollection()` (`src/TapeoutReceiptDistributor.sol:92-110`); `_acceptOne` calls both members'
`claimed` (`:301-306`). Executed with a mock (`testMimicPoolPassesTheConstructorAndCanVetoFunding`): a
contract with matching views is accepted as the "regular" pool; while it answers 0 funding proceeds;
answering nonzero makes every funding of that ID revert `ConsumedRewardHistory`; reverting blocks funding
entirely; the genuine optimal pool binds that distributor. Impact: with genuine pools, `claimed` is a
mapping getter that cannot revert, so funding cannot deadlock; the veto needs a non-genuine member, which
only the setup owner can introduce. Reachability: trusted setup only. Remediation: none in code (a
pool's runtime has immutables, so a codehash check is impossible, as for the pool→distributor
direction); the deployment check's runtime-template comparison of both pools is the control.
VERIFIED_BY_EXECUTION (mock), reachability SOURCE_CONFIRMED.

**N-4. "Fresh inventory" means no history in these two pools (Informational).** A receipt with claim
history only in a third system on the same receipts (another pool pair with its own distributor,
which the receipts do not prevent) is accepted as fresh. No effect on this system's accounting (the
other system's histories are its own). SOURCE_CONFIRMED; documentation note only.

**Confirmed sound (SOURCE_CONFIRMED and VERIFIED_BY_EXECUTION):** constructor refusals (zero,
code-less, non-pool, duplicate, other receipts, other protocol); one-time binding per pool, third pool
refused even with the same receipts; shared gates (open allocation blocks both activations; an owned
receipt or distributor blocks both first admissions; each pool's owner gates only itself); neither pool
is an allocatable beneficiary; history in either pool refuses inventory (single and batch hooks); one
full-round allocation delivers each receipt once and a second allocation of an allocated ID is refused;
NAND #1 and LATCH #1 distinct per pool and across pools; transfer approval is not claim authorization
in either pool; a delivery callback that claims in both pools pays once per pool, delivers once and sets
both histories, and a refusing receiver rolls back counters, cursor and transfers with both histories
unchanged; one pool's Mining failure blocks only that pool's admissions (its harvests isolate, its
recognized income stays claimable) and leaves the other pool and delivery unaffected; a receipt earns
exactly `(pool, category, id)` history; a miner can be in one pool only and no function moves it; the
brief's exact example reproduces (optimal 3:1 with 1,050 BEM: NAND 750, LATCH 250, A = B = 12.5, C = 25;
regular 1:3 with 2,100 BEM: NAND 500, LATCH 1,500, A = B = 25, C = 50; one NAND + one LATCH receipt:
125 BEM from optimal, 350 from regular; claim order across pools irrelevant); zero income, tiny raw
income (84 and 85 raw) and carried income in one pool only reconcile; a zero LATCH supply refuses LATCH
miners in both pools; mixed-version systems are impossible (a 2.2.0 pool calls `pool()` which a 2.3.0
distributor lacks, and a 2.3.0 pool calls `isPool` which a 2.2.0 distributor lacks; both revert).

**Shared upstream failures (labelled).** A BEM transfer refusal to the sink stops releases in both pools
(executed with the mock's blocked destination); receipt claims do not depend on it. Both pools share
BEM, Mining and the collection: they are independent of each other, not of those dependencies.

### 5.2 SDK, CLI and manifests

**T-1. Deployment check skips what the addresses file omits (Low, inherited Astra TL-01, enlarged).**
Source: `sdk/deployment.ts` `if (!configured) continue;` per pool role and `if (addresses.distributor)`
around the distributor and binding checks; `addressesSchema` keeps `optimalPool`, `regularPool` and
`distributor` optional. A file naming only `optimalPool` (no `regularPool`, no `distributor`) passes
`checkDeployment` with no binding check, and pool-scoped writes against that pool proceed. The first
admission's `readFinality` still needs a bound finalized distributor, but its identity is not compared
with any file. Impact: operator-side only; the chain is unaffected. Remediation (tooling): require all
five addresses for every write command, or at least refuse `MATCHES` when any of the five is absent.
Regression: an SDK test calling `checkDeployment` with a file missing `regularPool`/`distributor` and
expecting `problems`. SOURCE_CONFIRMED (not executed).

**T-2. `activate` preflight checks `allocationFinalized` only (Low, inherited Fable 2.2.0 T-1).** With
two pools, an empty or partial distributor satisfies both activations (executed on chain in N-1 with an
empty one). `verify-allocation` reports `FINALIZED_INCOMPLETE_COVERAGE`, but `activate` and `finality`
do not consult it. Remediation unchanged: require `FINALIZED_AND_MATCHES` (or `_PARTIAL` with
`--partial`) in `activate`. SOURCE_CONFIRMED.

**T-3. Pool selection (confirmed sound).** A missing or invalid `--pool` is an error for every pool-scoped
command (executed in the local end-to-end: `poolScopedCommandsNeedThePoolSelector`); receipt and
distributor commands take none (`claim-receipts`/`deliver` were moved above the selector); old
single-pool system and addresses files are refused by name, even when the two-pool keys are also
present (SDK test and end-to-end executed); `bind-distributor` refuses a role mismatch and a second
distributor; `verify-allocation` requires both pools and refuses a third pool in either role or swapped
roles (executed). VERIFIED_BY_EXECUTION.

**T-4. No wrong-pool guard for admissions (Informational, policy).** `deposit --pool` sends the miners
wherever the operator says; nothing compares a miner to a per-pool list, and admission is irreversible.
`OPERATIONS.md` §9 says so. Remediation (tooling, optional): an optional per-pool miner allowlist in the
system file checked by the `deposit` preflight. SOURCE_CONFIRMED.

**Gas bounds (VERIFIED_BY_EXECUTION).** `GasModelTest` runs every bound as a transaction gas limit:
11/11 pass with `ISSUE_GAS` 56k/ID (222 IDs) and `FUND_GAS` 44k/ID (283 IDs). My warm batch funding of
283 IDs used 31,841 gas per ID; the developer's cold measurement is ~41.3k before refunds, under the 44k
bound. First admission on real state: 514,803 gas (2.2.0: 514,781); maximal marginal per registered miner
27,857 (unchanged), so the per-pool admission ceiling of ~580 registered miners (2.2.0 review P-1) now
applies to each pool separately. Safe end-to-end: 28 Safe transactions, smallest margin 148,815, largest
bound 12,004,688 under the 16,777,216 cap. Capacity beyond the measured 24 registered miners per pool
remains an extrapolation.

### 5.3 Canary-only

**C-1.** Canary-4 is the canary-3 patch list applied to the 2.3.0 pool (the two adaptation diffs differ
only in line numbers and the version string, checked with `diff`); the generator check passes; runtime
24,441 B leaves 135 bytes under EIP-170. The canary workflow adds a second miner-less canary pool and
shuts both down in recovery. No recovery authority exists in the production pool or distributor
(production diff reviewed; `shutdown`/`emergencyReturn`/`recoveryController` appear only under
`src/canary/` and `scripts/canary/`). The canary-4 local rehearsal was **NOT_EXECUTED** by me (it runs
the recovery entry points); the developer records 48/48 and 10/10 (AUTHOR_RECORDED). Prior mainnet
approval (`c4bc022`) does not cover canary-4, and the runbook says so. SALUS #7/#8 remain canary-only.

### 5.4 External dependencies (unchanged by this change)

Both pools share BEM, Mining and the miner collection; their failure or upgrade affects both. The
fork identity observations at block 128,713,128 were re-recorded by my fork run (Mining owner zero and
not paused; collection behind an upgradeable beacon). The current authority over the collection's
beacon was **not re-probed** in this review; the 2.2.0 reviews disagree on which account holds it at
which block (Fable X-1 versus Astra EX-01), and `AUDIT_ASSUMPTIONS.md` §9 already requires release-time
reverification. The BEM supply-cap caveat on carried-income order independence (2.2.0 X-2 / Astra
EX-02) is unchanged. UNVERIFIED for current state; SOURCE_CONFIRMED that the change adds no dependency.

### 5.5 Intentionally accepted policies

- "Optimal" and "regular" are labels; no on-chain classification of miners (POL-1, documented).
- No miner migration between pools; no recovery, sweep or override anywhere in production.
- One issuance, one allocation, one delivery; receipts earn in both pools without being duplicated.
- The sink's aggregate balance is not either pool's ledger; each pool's `sinkPaid` is (executed).
- SALUS #1/#4/#5/#6 owner acceptances (`AUDIT_ASSUMPTIONS.md`) carry over; #6's delay now blocks both
  pools' activation, since finalization is shared.

### 5.6 Inherited 2.2.0 findings, reassessed for the change

| 2.2.0 item | Status in 2.3.0 |
| --- | --- |
| P-1 admission ceiling (~580 registered miners) | Unchanged per pool; two pools double the total but each registry is independent |
| P-2 revoked weight retained; P-3 strict settlement | Unchanged; strict settlement now blocks admissions in the affected pool only (executed) |
| P-4 rounding wording; P-5/P-6 view and NatSpec notes | Unchanged (accounting code identical) |
| P-7 finality does not authenticate the distributor's code, inventory coverage or uniqueness | Unchanged in kind; see N-1/N-3 for the two-pool forms |
| T-1 `activate` coverage; T-2 `finality` views; Astra TL-01/TL-02 | Unchanged; T-1 above enlarged by the optional second pool key |
| X-1 collection beacon; X-2 BEM cap; X-3/X-4 | Unchanged; shared by both pools |
| SALUS #1–#8 | Unchanged; #6 now delays both pools |

## 6. Coverage matrix (both pool roles, critical transitions)

| Transition / property | Optimal | Regular | Evidence |
| --- | --- | --- | --- |
| Deploy against shared receipts | ✓ | ✓ | unit, e2e, fork, Safe (EXEC) |
| Distributor construction with the pair; refusals | ✓ | ✓ | `TwoPoolDistributorTest` 5 tests (EXEC) |
| Fund while unbound and inactive | ✓ | ✓ | review test, developer's `_importRound` (EXEC) |
| Allocate; both pools refused as beneficiaries | ✓ | ✓ | EXEC |
| Finalize allocation before either activation | shared | shared | EXEC |
| Bind: success, twice, after activation, third pool, decoy pair, role swap | ✓ | ✓ | unit, review, e2e (EXEC) |
| Activate: refused unbound / unfinalized; wrong counts | ✓ | ✓ | unit, e2e (EXEC) |
| Renounce; pending owner cleared | ✓ | ✓ | 2.2.0 suite (EXEC); OZ 5.4.0 SOURCE |
| First admission blocked by shared owners; by own owner | ✓ | ✓ | unit, e2e (on-chain bypass), fork (EXEC) |
| Staggered start: this pool first, the other delayed after shared renunciation | ✓ | ✓ | review tests both directions; fork (optimal first) (EXEC) |
| Failed first admission rolls back custodyOpen | ✓ | ✓ | review test (mock) (EXEC) |
| Admission settles only this pool's registry | ✓ | ✓ | unit lifecycle, e2e (EXEC) |
| Harvest, carried income, releases, A/B/C per pool | ✓ | ✓ | unit, review, e2e, fork (EXEC) |
| Delivery once; late delivery keeps both incomes; callback claims; refusing receiver | shared | shared | review tests, fork (EXEC) |
| Claim per (pool, category, id); order across pools; transfer with unequal histories | ✓ | ✓ | review tests, unit, e2e, fork (EXEC) |
| Approval is not claim authority | ✓ | ✓ | review test (EXEC) |
| One pool's Mining failure isolated | ✓ | ✓ | review test (mock) (EXEC) |
| Shared BEM/sink failure stops both releases | both | both | review test (mock, labelled) (EXEC) |
| Miner in one pool only; no migration | ✓ | ✓ | review test (EXEC) |
| Zero LATCH supply refuses LATCH miners | ✓ | ✓ | review test (EXEC) |
| CLI `--pool` required; single-pool files refused; verify both roles | ✓ | ✓ | SDK tests, e2e (EXEC) |
| Canary-4 rehearsal | n/a | n/a | AUTHOR_RECORDED, NOT_EXECUTED |

## 7. Executed evidence versus other evidence

| Evidence | Result | Label |
| --- | --- | --- |
| `forge build --sizes`; SDK bytecode vs build; `export-abi` no-op; canary `--check` | PASS (sizes in §2) | VERIFIED_BY_EXECUTION |
| Frozen Solidity suites (`--no-match-path 'test/{fork,audit,salus-ffi,review-fable51,review-02ef1f7}/*'`) | 244/244, 30 suites, 19 invariant campaigns | VERIFIED_BY_EXECUTION |
| FFI suites: `test/audit` 10/10, `test/salus-ffi` 2/2, `test/review-fable51` 20/20 | PASS | VERIFIED_BY_EXECUTION |
| `GasModelTest` (bounds as gas limits) | 11/11 | VERIFIED_BY_EXECUTION |
| `tsc --noEmit`; SDK tests; audit TypeScript tests | clean; 79/79 (after the build; a first run before `out/` existed failed 9 tests on missing artifacts, environmental); 13/13 | VERIFIED_BY_EXECUTION |
| `scripts/local-e2e.ts` (two-pool CLI lifecycle) | PASS 79/79, 90 steps | VERIFIED_BY_EXECUTION |
| `scripts/largest-wallet-check.ts` | PASS 5/5 | VERIFIED_BY_EXECUTION |
| `scripts/fork-test.ts` (21 tests, block 128,713,128, live endpoint probed by block hash) | PASS 21/21 (local RPC cache may have been read) | VERIFIED_BY_EXECUTION |
| `TwoPoolForkTest` with `--no-storage-caching` | PASS | VERIFIED_BY_EXECUTION |
| `scripts/fork-e2e.ts`; `scripts/fork-safe-e2e.ts` | PASS 26/26; PASS 294/294, 28 Safe tx | VERIFIED_BY_EXECUTION |
| Slither 0.11.3 on an isolated export | 170 results, 98 in `src/`, **0 not already present in the 2.2.0 run** | VERIFIED_BY_EXECUTION |
| `test/review-02ef1f7/ReviewTwoPool.t.sol` | 19/19 | VERIFIED_BY_EXECUTION |
| `test/review-02ef1f7/ReviewTwoPoolFork.t.sol` (`--no-storage-caching`) | 1/1 | VERIFIED_BY_EXECUTION |
| Developer's recorded run (`reports/two-pool-distributor-20261030-bdf906f/`) | inspected: fingerprint equals this tree; every step PASS; Slither SKIPPED so `overall: INCOMPLETE`; the earlier pipeline gap (review-fable51 FFI tests run without `--ffi`) was fixed and the step now runs with `--ffi` (confirmed in `verify-all.ts` and reproduced) | AUTHOR_RECORDED, independently reproduced except the canary rehearsal |
| Canary-4 local rehearsal | NOT_EXECUTED (recovery entry points) | AUTHOR_RECORDED |
| Current beacon/Mining/BEM authority | not re-probed | UNVERIFIED |
| Real (non-impersonated) deposits; Safe{Wallet} UI; long-running behaviour; launch manifests, allocation JSON, wallet set | none exist / not exercised | UNVERIFIED |

Two review-test iterations are recorded for transparency: a test name beginning with `testFail` was
rejected by forge 1.4 (renamed), and one expectation of mine assumed the regular pool's composition stayed
1:3 after a 1:1 miner joined (it is 2:4; the contract's 116.67 BEM per share was correct and the
assertion was corrected). Neither was a contract defect.

## 8. Reproduction

```bash
npm ci --ignore-scripts && forge build --sizes
forge test --no-match-path 'test/{fork,audit,salus-ffi,review-fable51,review-02ef1f7}/*'
forge test --match-path 'test/review-fable51/*' --ffi
forge test --match-path 'test/review-02ef1f7/ReviewTwoPool.t.sol' -vv
npm run typecheck && npm run test:sdk && npm run test:local-e2e
FORK_RPC_URL=<archive> FORK_BLOCK=128713128 FORK_NAND_MINER=12733 FORK_LATCH_MINER=13948 \
  FORK_INACTIVE_TOKEN=648 FORK_SCALE_MINERS=<manifest list> npm run test:fork
FOUNDRY_PROFILE=fork FORK_RPC_URL=<archive> FORK_BLOCK=128713128 forge test \
  --match-path 'test/review-02ef1f7/ReviewTwoPoolFork.t.sol' --no-storage-caching -vv
FORK_RPC_URL=<archive> FORK_BLOCK=128713128 npm run test:fork-e2e && npm run test:fork-safe-e2e
```

Slither: `slither .` in an export of the tree with `slither-analyzer==0.11.3` in a venv. Commands, exit
codes and timestamps of this review: `reports/internal-review-02ef1f7-fable51/logs/*.status` and
`results/summary.json`.

## 9. Prioritized list

Blockers introduced or worsened by this change: **none confirmed.**

Before deployment consideration (owner / tooling, in order):
1. Record the two-pool setup-trust assumptions (N-1, N-3) in `AUDIT_ASSUMPTIONS.md`, with the launch
   evidence requirement that both pools' `distributor()` equal the single distributor holding the full round.
2. Tooling T-1: make the deployment check refuse `MATCHES` when any of the five addresses is absent.
3. Tooling T-2: `activate`/`finality` should require verified full-round coverage, not the finalized flag.
4. Integration N-2: frontends must read `active()` before `claimable` on a possibly delayed pool.
5. Decide POL-1 controls for routing miners to the intended pool (tooling allowlist or procedure only).
6. Carry over every open 2.2.0 item unchanged (admission ceiling per pool, revoked weights, docs,
   external dependencies, SALUS confirmation); reverify the collection's upgrade authority at release.

Unverified inputs: launch manifests, allocation JSON, wallet set, both pools' whitelists and recipients,
real deposits, the canary-4 rehearsal, current upstream authority.

## 10. Direct answers

1. **Can this exact candidate initialize one shared distributor and operate both pools after the
   required renunciations?** Yes. Executed through the contracts, the actual CLI on a loopback chain, and
   a pinned real-state fork, including the order deploy → fund → allocate → finalize → bind each →
   activate each → renounce five → admit, and both staggered orders. Funding does not need custody or
   activation; the delayed pool binds and activates after the distributor's owner is zero.
2. **Can every legitimately allocated receipt be delivered once and earn/claim independently from both
   pools, including after transfer?** Yes. Each ID is allocated and delivered once (second allocation and
   second delivery refused), earns `(pool, category, id)` history, claims from each pool without touching
   the other, keeps income accumulated before a late delivery in both pools, and carries its unpaid
   entitlement per pool to a buyer, who cannot reclaim what the seller was already paid. Executed on
   mocks and on real state.
3. **Does staggered startup or failure in one pool unnecessarily block the other?** No. The only shared
   gates are the shared receipts and distributor (their finalization and renunciation), which is by
   design. One pool's Mining failure, blocked admissions, or inactivity does not block the other pool's
   admissions, harvests, claims or any delivery. Shared upstream failures (BEM, Mining, collection)
   affect both, as expected.
4. **Are the on-chain bindings and identity checks sufficient under the stated setup assumptions? What
   remains trusted?** Sufficient for an honest operator following `OPERATIONS.md` with the CLI's
   deployment and verification checks. Trusted: the operator constructs the distributor around the two
   genuine pools and binds the one distributor that holds the full round in both pools (N-1, N-3); the
   runtime-template identity tooling; the allocation JSON; the upstream contracts. Not trusted but also
   not enforced on chain: the distributor's and the pools' code identity (views only), full-round
   coverage (T-2), and the presence of every address in the manifest (T-1).
5. **Any confirmed High/Medium defects, asset-locking paths, or inability-to-run issues introduced or
   worsened?** No. Every asset-locking path I examined is inherited (unsupported transfers, wrong-pool
   admission by the operator, early renunciation) and unchanged in class.
6. **What must be fixed before further deployment consideration, and what is inherited or unverified?**
   Nothing in the contracts for this change. Tooling T-1/T-2 and the documentation items in §9 should
   be done; everything else is inherited from 2.2.0 or an unverified launch input, as listed in §9.

"No confirmed defect found" is a statement about this change under the stated assumptions, not a safety
guarantee or deployment authorization; SALUS has not assessed 2.3.0.
