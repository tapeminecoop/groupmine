# Audit remediation report: internal security reviews of `f2c8e50`

Date: 2026-10-21. Branch `claude/security-review-remediation`, starting from `origin/main` at
`b846c0c7c08eb296e3e73614eefa253d8ca99fc8`. This is pre-release hardening authorized by the owner. Work
ran on local development chains and local BSC forks only. Public RPC access was read-only; nothing
was deployed to a public network, and no public-chain transaction was signed or broadcast. No live
asset moved, no wallet secret or `.env` was loaded, and the live canary and recovery entry points
were never run.

Statuses used: **FIXED** (the defect is gone in the delivered tooling), **MITIGATED_IN_TOOLING** (the
tooling no longer exposes it; the underlying contract behaviour is unchanged), **DOCUMENTED /
PENDING_ACCEPTANCE** (a design boundary, now written down, awaiting the owner's decision) and
**BLOCKED / UNVERIFIED** (could not be established with the available evidence). A follow-up on the
same day added **VERIFIED** for U-01: established from the deployed code and executed on local forks
(§9). Passing tests do not make the system "audited" or "production ready".

## 1. Sources and baseline

| Source | Location | Notes |
| --- | --- | --- |
| Fable review | `docs/INTERNAL_SECURITY_REVIEW_f2c8e50.md`, `test/audit/`, `proposed-patches/` (committed in `b846c0c`, patches not applied) | Kept unchanged, except `test/audit/verify-supply-gap.test.ts`, whose expectations its README said to update once the fix landed; it still records the original behaviour in its header |
| GPT review | `groupmine_internal_security_review_f2c8e50.pdf`, 20 pages, read in full | Its companion proof bundle (E1–E6: `IndependentReceiptReview.t.sol`, `SdkDeliveryRace.t.sol`, `sdk-review-proofs.mts`, traces) was **not provided**. Its reproductions were rebuilt from the report's precise descriptions (§3); no claim is made that the original proof files were run |

Both reviews froze `f2c8e50a21ba7878dbe8680e143db2a80398d38b`. The only newer commit, `b846c0c`, adds
the Fable review and changes no source. Starting source fingerprint (`scripts/verify-all.ts`
convention: every tracked file except `reports/`, `docs/` and `*.md`):
`bb83f8cf0133933ddf7ce950c79079832b8379a95f66eba7c15e1f566cac1f3e` (119 files).

The two reviews number their findings independently: GPT T-01 is not Fable T-1. The matrix in §3 maps
them.

## 2. Contract preservation

No Solidity implementation changed: production, canary, `PoolMath` and `IMining` are untouched. No
dependency, compiler or build setting changed. New Solidity files are test fixtures only
(`test/remediation/`).

Evidence (`scripts/contract-identity.ts`): for every existing contract it records
- the ABI (canonical JSON sha256), creation bytecode and runtime template (keccak256), sizes and
  immutable-slot counts;
- the compiler settings, and the sha256 of every file under `src/`;
- the forge version and the hashes of `foundry.toml` and `package-lock.json`.

The baseline was captured from a forced clean build (`forge build --force`) of `b846c0c` before any
change ([`contract-identity-before.json`](../reports/remediation-20261021-b846c0c/contract-identity-before.json)).
The final run recomputed it after Slither's clean rebuild: **IDENTICAL**, 7 contracts and 7 source
files, no differences ([`run/contract-identity.json`](../reports/remediation-20261021-b846c0c/run/contract-identity.json),
step `contract-identity` of the run manifest).

| Contract | Scope | Runtime template keccak256 | Runtime | Immutable slots |
| --- | --- | --- | ---: | ---: |
| `TapeoutEntitlementReceipt` | production | `0x7f59d20c…ec8f` | 8,743 B | 0 |
| `TapeoutReceiptDistributor` | production | `0xcf370db1…0ada` | 7,680 B | 11 |
| `TapeoutMinerPool` | production | `0x5655ce42…2c26` | 19,113 B | 49 |
| `PoolMath` | production library | `0xc9c8e986…` | 58 B | 0 |
| `IMining` | interface | (ABI only) | – | – |
| `RecoverableTapeoutMinerPool` | canary | `0x9070dcbc…` | 20,404 B | 53 |
| `CanaryParticipant` | canary | `0xd32e89e9…` | 3,410 B | 18 |

`sdk/bytecode.json` additionally carries each production runtime template and its immutable offsets.
Its creation bytecode entries are unchanged, and the run's `export-abi` step confirms the SDK files
equal a fresh export.

No finding required a contract change, so no contract change is proposed for approval. Two possible
future contract or API changes are noted for a separately reviewed version and were **not** made:
- a `claimableBatch` that rejects or zeroes repeated IDs (P-01);
- a delivery call carrying an expected cursor or a range-work limit, so that a stale call fails by
  intent (T-02).

## 3. Findings matrix

| GPT | Fable | Finding | Remediation | Regression evidence | Status | Residual limitation |
| --- | --- | --- | --- | --- | --- | --- |
| T-01 | (related T-5) | Verification never compared the configured pool with `distributor.pool()` | `VerifyTarget.pool` is required and the CLI passes the addresses file's pool. The configured distributor is compared with the one read, and receipt categories are checked. The output gives the compared identities and the pinned block number and hash | `test/sdk/verify.test.ts` "review T-01" (pools P and Q share receipts; D belongs to P; Q configured → `MISMATCH` with that single message); local e2e `verifyRejectsAPoolTheDistributorDoesNotBelongTo` (a real second pool), `writesRefusedForInconsistentDeployment` | **FIXED** | – |
| – | T-3 | Inventory not related to the finalized supply | Per-category coverage: supply, cumulative accepted inventory, assigned, delivered, undelivered, and excluded IDs with holders. Full round is the default: supply = intended = accepted = assigned. Partial mode is explicit and labelled (`*_PARTIAL`). A finalized round that does not cover the supply reports `FINALIZED_INCOMPLETE_COVERAGE` | `verify.test.ts` "review T-3" (100 issued, 90 funded → `NOT_READY`; partial → `READY_TO_FINALIZE_PARTIAL`); `test/audit/verify-supply-gap.test.ts` (updated); local e2e `fullSupplyCovered` | **FIXED** | Partial mode remains an operator choice |
| – | T-4 | `finalize-allocation` had no readiness preflight | Re-runs the shared verification on the current state, with `--artifact` and `--allocation` both required. It refuses empty, uncovered, mismatched or unverified allocations, unfinalized issuance, and wallets whose receive hooks fail. An old PASS file is not accepted | local e2e `finalizeRequiresReviewInputs`, `finalizeRefusedWhileAllocationMismatches`, `finalizeRecordsItsVerification`; the fork and Safe e2e finalize through the gate | **FIXED** (operator guard) | The owner's raw `finalizeAllocation` stays callable; state can change between the check and the transaction |
| – | T-5 | Verification established artifact = chain, not reviewed JSON = chain | `--allocation FILE`: the sha256 of the exact bytes must equal `sourceSha256`; beneficiary counts and totals are compared; the ID assignment is recomputed from the import's inventory (recorded in new artifacts, or historical state at the artifact's block). Never today's availability; otherwise `UNVERIFIED` | `verify.test.ts` "review T-5" (hash, counts, extra and missing wallets, reordered file, duplicates, legacy UNVERIFIED, historical VERIFIED, stale record); local e2e `reviewedJsonVerifiedAgainstArtifact`; canary rehearsal `complete-allocation-verified` (review VERIFIED) | **FIXED** (new artifacts) | An artifact without inventory provenance needs archive state; otherwise it is reported UNVERIFIED and finalization refuses |
| T-02 | (cursor documented in `AuditDistributorCursor`) | A delivery planned for one cursor position could run out of gas after others delivered first | `sdk/gas.ts`: `worstReachableRanges`, `reachableDeliveryGas` and `maxSafeDeliverable` bound every call for any cursor position reachable from the snapshot. Calldata and contract semantics are unchanged. Deliveries go into their own Safe files, and `--send-local` replans before each send | `test/remediation/DeliveryRace.t.sol` (10 tests, each call its own cold transaction with its emitted limit): the old 300-ID / 11,300,000 call **fails** after a keeper delivers the contiguous range and rolls back fully; a replanned 91-ID call succeeds (measured 4,115,338 gas against a 12,567,000 model bound); the plan's 6×91 + 54 calls fit after 0, 150, 299, 300 or 345 IDs of interference; mixed NAND/LATCH ranges; `NothingToDeliver` after full delivery. `test/sdk/gas.test.ts`: the bound equals a brute-force search on 60 random wallets; the 183-range case is still 91/91/1 (`GasModelTest`) | **FIXED** (tooling) | Without an on-chain expected cursor, a call made stale by complete delivery reverts cheaply with `NothingToDeliver`; it cannot be made to succeed |
| P-01 | (Fable lists duplicate claims paying zero as correct) | `claimableBatch` counts a repeated ID once per occurrence; `claimBatch` pays it once | `canonicalClaimIds`: inputs are sets per category, and NAND #1 and LATCH #1 stay separate. The CLI reports the normalization, and preview, simulation and transaction use the same IDs. `claimPlans` rejects duplicates. The preview states its block and is not a payment guarantee | `test/remediation/ClaimPreview.t.sol` (the raw discrepancy is pinned: 7,500 + 7,500 previewed, 7,500 paid; normalized preview = payment); `gas.test.ts` "review P-01"; local e2e `repeatedClaimIdsNormalizedAndPreviewEqualsPayment` | **MITIGATED_IN_TOOLING — RAW_CONTRACT_BEHAVIOR_UNCHANGED** | Other integrations calling the raw view must normalize their own inputs |
| CT-01 | T-1 | Canary negative tests matched message text | `scripts/canary/revert-verifier.ts` takes revert bytes from structured RPC error data at any nesting, requires an exact ABI decode of the expected error and arguments plus canonical re-encoding, and records chain, block and hash, caller, target, calldata, raw data, decoded and expected values. It is integrated in `workflow.ts`. Fable's text fallback and selector-only match were not adopted | `test/sdk/canary-revert.test.ts` (generic message with structured data in 3 nestings; wrong error; wrong arguments; misleading `Error(string)`; bytes in the message only; HTTP 502; timeout; empty, malformed and ambiguous data; unexpected success; retry; real Anvil). Local-fork rehearsal: all four negative tests `EXPECTED_REVERT` | **FIXED** (canary tooling) | The historical mainnet record is unchanged (§6); the corrected runner is an unapproved local candidate |
| – | T-2 | A harness failure was handled as a business failure | PASS, FAIL or UNVERIFIED. UNVERIFIED (no, malformed or ambiguous data, or transport) gets 3 read-only attempts at the same pinned block; FAIL is never retried. Both stop the normal workflow, and recovery stays independent | `canary-revert.test.ts` (retry and attempt records); rehearsal | **FIXED** | An inconclusive negative test still stops live business steps, by design |
| O-05 | – | Plans not bound to chain, targets, sender and manifest; printed commands used `$RPC_URL` | Every write refuses a node on another chain and checks the deployment first (templates outside immutables, receipt categories, pool and distributor bindings, and protocol, whitelist and owners with `--system`). Results name the execution context (local dev node vs remote). `cast` commands carry `--chain`, and plans from a loopback dev node print that node instead of `$RPC_URL`. Safe files need `--safe` and record chain id, Safe, targets and sha256. RPC URLs are never printed | `test/sdk/plans.test.ts` "review O-05"; local e2e `planBoundToLocalNodeAndChain`, `writesRefusedForInconsistentDeployment`; fork Safe e2e | **FIXED** (tooling) | For a remote endpoint the operator must match `$RPC_URL` to the recorded planning block hash |
| §9.2 | P-5 | Template hashes described as runtime code hashes | `sdk/deployment.ts` and `verify-deployment`: masked comparison plus bindings. The verification report's table is corrected with a dated note | local e2e `deploymentMatchesTemplatesAndBindings` | **FIXED** | No production deployment exists to check |
| O-04 | P-3 (part) | ERC-165 is no proof of receive, claim and transfer; correction limits | Receive hooks are simulated from the receipt contract in addition to ERC-165. Real wallet flows were run on a fork: SafeL2 1.4.1 and GnosisSafeL2 1.3.0 receive, claim BEM and transfer, and the new holder claims. The parameterized largest-wallet check covers correction, delivery and claims; a revocation above about 1,550 IDs is refused | fork Safe e2e (244 checks, incl. `memberSafeTransferredAReceipt`, `newHolderClaimsAfterSafeTransfer`, `formerSafeHolderCannotClaimIt`); `largest-wallet` step (1,200 + 300 IDs PASS); trial at 2,000 IDs → correction refused (`FAIL_CORRECTION_NOT_POSSIBLE`) | **MITIGATED_IN_TOOLING**; launch gate **PENDING** | The actual wallet implementations and largest allocation were not supplied |
| §4.5 | – | Same-ratio admissions change lifetime category totals | Documented (`docs/ACCOUNTING.md` §5); policy unchanged | `test/remediation/RoundingPolicy.t.sol` reproduces the example exactly: checkpointed NAND 0 / LATCH 8 / residue 2, against NAND 3 / LATCH 6 / residue 1 | **DOCUMENTED / PENDING_ACCEPTANCE** | – |
| U-01 | E-3, E-4 | REVOKED permanence, uncollectible debt, COOLING restart | Follow-up (§9): established from Mining's deployed bytecode and executed on forks; [MINING_LIFECYCLE.md](MINING_LIFECYCLE.md). REVOKED is terminal; a revoked miner earns and pays nothing after the revocation, which first pays the holder; `debt` is an accumulator checkpoint, not an amount owed. COOLING restarts only by the NFT holder from `stopBlock + 1,201`, with the debt reset to the current accumulator | `scripts/mining-analysis/lifecycle.py` (133 checks on the bytecode) → `reports/mining-lifecycle-analysis.json`; `test/fork/MiningTransitions.t.sol` (5 tests, including a replay of a real revocation) | **VERIFIED** (implementation `0xa3DB…f898`, code hash `0x63b1…2479`) | Holds for this implementation, which can no longer be replaced (owner renounced). New observation: a stopped miner can still be revoked during its 1,200-block cooldown. `protocol-check` must match at the release block |
| U-02 | E-5 | Immutable addresses do not mean immutable upstream behaviour | Documented; `protocol-check` before each round | existing `fork-identity.json` | **DOCUMENTED / PENDING_ACCEPTANCE** | Re-verify owners and implementations at the release block |
| O-01 | P-2 (gas) | Every admission settles all registered miners | Unchanged; measured, mock and extrapolated figures kept apart | `fork-gas.json` (24 real), `gas-admission-local.json` (400 mock), ~590 extrapolated, CLI model 401 | **DOCUMENTED / PENDING_ACCEPTANCE** | Measure the real envelope before admitting |
| O-02 | P-2 | Revoked miners keep their weight and admission cost | Documented | `AuditAdmissionLiveness` (rerun) | **DOCUMENTED / PENDING_ACCEPTANCE** | – |
| – | P-1 | Admission liveness depends on every registered miner staying claimable or REVOKED | Documented | `AuditAdmissionLiveness` (rerun) | **DOCUMENTED / PENDING_ACCEPTANCE** | – |
| O-03 | P-3 | Irreversible owner actions, fixed whitelist, key continuity | Finalize gate, renounce preflights (kept) and deployment binding | local e2e renounce checks | **MITIGATED_IN_TOOLING**; **PENDING_ACCEPTANCE** | Raw owner functions stay callable; a lost depositor key cannot be replaced |
| – | P-4 | Zero-value ERC-1155 transfers run hooks | None needed | `AuditReceiptEdges` (rerun) | not a defect | – |
| – | T-6 | Slither not re-run | Run in this validation | 42 results, same categories | executed | – |

## 4. What changed

Production and canary Solidity: none. Tooling, tests and documents, relative to `b846c0c`:

| Area | Files |
| --- | --- |
| SDK | `sdk/verify.ts` (identity, coverage, review, provenance), `sdk/gas.ts` (reachable-state delivery bound, standalone Safe plans), `sdk/pool.ts` (bounded delivery plans, canonical claim inputs, simulated receive hooks), `sdk/tx.ts` (chain-bound commands, execution context, loopback printing), `sdk/allocation.ts` (artifact inventory record), `sdk/deployment.ts` (new: deployed identity and bindings), `sdk/index.ts`, `sdk/bytecode.json` (runtime templates and immutable offsets added) |
| CLI | `cli/pool.ts`: write binding (chain and deployment check), `verify-deployment`, shared verification for `verify-allocation` and `finalize-allocation`, `--partial`, `--allocation`, delivery replanning, claim normalization, Safe-file binding |
| Canary tooling | `scripts/canary/revert-verifier.ts` (new), `scripts/canary/workflow.ts` (structured negative tests, pool in targets, reviewed JSON), `scripts/canary/fork-local-candidate.ts` (new: key-free local-candidate rehearsal) |
| Runners | `scripts/verify-all.ts` (audit, largest-wallet, canary rehearsal and identity steps; format gate scope), `scripts/contract-identity.ts` (new), `scripts/largest-wallet-check.ts` (new), `scripts/local-e2e.ts`, `scripts/fork-e2e.ts`, `scripts/fork-safe-e2e.ts`, `scripts/export-abi.mjs` |
| Tests | `test/remediation/{DeliveryRace,ClaimPreview,RoundingPolicy}.t.sol` (new), `test/sdk/canary-revert.test.ts` (new), `test/sdk/{verify,gas,plans}.test.ts`, `test/audit/verify-supply-gap.test.ts` (expectations updated as its README anticipated) |
| Examples | `deployments/examples/addresses.bsc.example.json`, `deployments/examples/allocation.artifact.example.json` (new) |
| Documents | `docs/OPERATIONS.md`, `docs/ACCOUNTING.md`, `docs/CANARY_RUNBOOK.md`, `docs/VERIFICATION_REPORT.md` (dated correction), `README.md`, this report |
| Follow-up U-01 (§9) | `test/fork/MiningTransitions.t.sol` (new), `scripts/fork-test.ts` (expects 16 tests), `scripts/mining-analysis/` (new: bytecode analysis), `scripts/fetch-mining-code.ts`, `scripts/probe-start.ts`, `scripts/probe-restarts.ts`, `scripts/probe-implementation-history.ts` (new, read-only), `docs/MINING_LIFECYCLE.md` (new), `docs/VERIFICATION_REPORT.md` §3.2, `docs/ARCHITECTURE.md` §4.5; outputs in `reports/` |

## 5. What ran

The definitive run was `npm run verify` (`scripts/verify-all.ts`) at 2026-10-20 20:38:27–20:51:01 UTC
(2026-10-21 04:38–04:51 Asia/Shanghai): **overall PASS, 18 of 18 steps**. Manifest, logs and outputs:
[`reports/remediation-20261021-b846c0c/run/`](../reports/remediation-20261021-b846c0c/run/).
- **Tested tree.** `b846c0c` plus the remediation's working-tree changes on
  `claude/security-review-remediation`. Final source fingerprint
  `065a969b33ff6b04123b2c396281a2bd1a45c5762646d91f9d3d0a48af2d3d8f` (130 files); recompute it with
  `node --import tsx scripts/verify-all.ts --fingerprint`.
- **Toolchain.** Foundry 1.4.3, solc 0.8.24 (Paris, via-IR, optimizer 200), Node 20.19.5, viem 2.57.2,
  zod 3.24.2, OpenZeppelin 5.4.0, TypeScript 5.7.3, tsx 4.19.3, Slither 0.11.3, Python 3.9.6 (the
  review's reference model, standard library only).
- **Chains.** Local Anvil chains and local BSC forks only. The fork source was
  `bsc-mainnet.public.blastapi.io`, used read-only.

| Step | Result |
| --- | --- |
| Build and sizes | PASS; production runtime sizes unchanged (8,743 / 7,680 / 19,113 B) |
| SDK files equal a fresh export of the build | PASS |
| Formatting (`src`, `script`, `test/{unit,invariant,fork,helpers,remediation}`) | PASS. The review's `test/audit` files are kept byte-for-byte as committed (unformatted) |
| Solidity unit, fuzz, gas and invariant suites, canary and remediation tests (mock protocol) | **122 / 122**: 95 production, 12 canary, 15 remediation. Invariant campaigns: 1,542 logged runs; 3,751 successful and 1,110 rolled-back admissions |
| Gas model: planned limits used as the gas limit | 10 / 10 |
| Internal review suite, with FFI to its reference model | **10 / 10**, including the 400-run differential fuzz |
| Internal review SDK tests | 10 / 10 (9 matcher reproductions, plus the updated supply-gap test) |
| SDK tests | **51 / 51** |
| Typecheck | PASS |
| CLI end to end, local Anvil | **50 / 50 checks**, 63 steps, 45 local transactions |
| Largest-wallet check (1,200 NAND + 300 LATCH; parameters, not launch inputs) | PASS: revocation fits one transaction, then re-import, 5 deliveries and 8 claim transactions, exact payout, reconciliation. Launch gate **PENDING** |
| Foundry tests on real BSC state, block 128,713,128 (hash `0x760f050b…081f`) | 11 / 11 |
| CLI end to end on a BSC fork (same block) | 18 / 18 checks, 31 local-fork transactions |
| CLI Safe batch files through real Safes on a BSC fork (same block) | **244 / 244 checks**, 23 Safe transactions, 43 local-fork transactions. Every estimate within its planned bound; smallest margin 149,015 |
| Corrected canary workflow on a local fork, block 128,812,145 (hash `0x383f1f97…a922`) | **PASS**. Complete run 41 / 41 assertions. Interrupted run: checkpoint reached, then standalone recovery shut the pool and returned both miners to the original wallet. All four negative tests `EXPECTED_REVERT` on the first attempt. Run identity `local-candidate-47ee5b3e-bd11-42ab-b9f9-e40131fe9c97`, local candidate digest `6e5afe8f…88bd0` (not approved) |
| Slither 0.11.3 | Completed, 77 results: the same 42 for the production contracts as at `c4bc022` (same categories), plus 35 in `src/canary/RecoverableTapeoutMinerPool.sol`, the canary copy of the pool |
| Artifacts identical after Slither's clean rebuild | PASS |
| Contract identity against the baseline | **IDENTICAL** (§2) |

Measured and modelled gas are kept apart. The gas-model and Safe figures are measured gas of
transactions that succeeded with their planned bound as the limit. Bounds are model upper bounds:
41,200,000 for 300 IDs walking 300 single-ID ranges is a model bound, not a measurement. Example: the
replanned 91-ID delivery over single-ID ranges measured 4,115,338 gas against its 12,567,000 bound.
No gas figure is taken from a reverted isolated call. The delivery race's out-of-gas failure is the
EVM's low-gas SSTORE guard firing under the old, too-low limit, not a reentrancy.

Not executed:
- anything on a public network (no deployment, transaction or signature; out of scope);
- the GPT review's original proof files (not provided; §1);
- the Safe{Wallet} interface itself;
- Mining's implementation source, which is unavailable (U-01 was later established from the
  deployed bytecode instead; §9);
- the actual launch manifest, largest allocation and wallet implementations, which were not supplied
  (§7).

## 6. The historical mainnet canary

The bounded mainnet canary (`canary-588196bf-b2d8-4c9b-9c60-fdc66faecd68`) used the owner's own
wallet, receipts and test assets. Its recorded outcome remains
**`PARTIAL_AUTOMATION_FAILED_RECOVERY_AND_ACCOUNTING_PASS`**:
- the original automation recorded 24 passes and 2 failures (the matcher's false negatives);
- the orderly pre-shutdown harvest was skipped;
- recovery and accounting reconciled.

Its directory, source snapshot and the approved-candidate guard pinned to `c4bc022` are unchanged.
Neither the corrected tooling nor the local rehearsal re-authenticates the original nested RPC data
or turns that run into an uninterrupted PASS, and this task made no new public-chain query of its
contracts.

## 7. Release gates and assumptions pending owner acceptance

None of these is accepted on the owner's behalf.
1. **Upstream lifecycle (U-01): VERIFIED in the follow-up (§9).** For Mining implementation
   `0xa3DB…f898`, which can no longer be replaced because its owner is renounced:
   - REVOKED is terminal, and a revoked miner earns and pays nothing after the revocation, which
     itself first pays the holder.
   - A COOLING miner restarts only by its holder from `stopBlock + 1,201`, with its debt reset, and
     can still be revoked during the cooldown.
   - A pool-held miner's revocation income reaches the pool in the challenge transaction and is booked
     at the next recognition, in the period it accrued. This part is reasoning from the pool's code;
     it was not executed with a pool-held miner.

   Remaining gate: `protocol-check` must report `IDENTITY_MATCHES_RECORDED` at the release block
   ([MINING_LIFECYCLE.md](MINING_LIFECYCLE.md)).
2. **Upstream authority (U-02).** The miner collection's beacon owner can change the collection;
   Mining's implementation identity is checked off-chain only (`protocol-check`).
3. **Admission envelope (O-01).** Measure the planned maximum registry on the real protocol, with
   failed and revoked settlement cases, and keep a margin.
4. **Composition policy (O-02, P-1, P-2).** Revoked miners keep their weight. Admission stops while
   a registered miner fails with any status other than REVOKED.
5. **Rounding policy (§4.5).** Same-ratio checkpoints can shift lifetime category totals; the
   residue stays bounded.
6. **Permanent custody (P-3).** No withdrawal, sweep, upgrade or administrator recovery, and no
   destination override for a wallet that cannot receive.
7. **Trusted setup (O-03).** Issuance quantities, beneficiaries, A/B roles, the depositor whitelist
   and upstream addresses are fixed inputs; raw owner functions remain callable.
8. **Launch inputs (O-04).** The actual deployment manifest, the largest wallet allocation (correction
   fits one transaction only up to about 1,550 IDs), and the beneficiaries' wallet implementations
   need their own fork rehearsal before finalization.
9. **External audit.** These are internal reviews; an independent audit is still advisable.

## 8. Reproduce

```bash
npm ci --ignore-scripts
```

```bash
FORK_RPC_URL=<read-only archive RPC> SLITHER=$(which slither) IDENTITY_BASELINE=reports/remediation-20261021-b846c0c/contract-identity-before.json npm run verify
```

Without `FORK_RPC_URL` the fork, Safe and canary steps are recorded as SKIPPED. The runner writes into
`reports/`; this run's outputs were then copied into `reports/remediation-20261021-b846c0c/run/` and
the earlier baseline evidence in `reports/` restored. Individual parts:
- `forge test --no-match-path 'test/{fork,audit}/*'`
- `forge test --match-path 'test/audit/*' --ffi`: FFI runs only `python3 -I test/audit/model.py`
- `npm run test:sdk`
- `node --import tsx --test test/audit/*.test.ts`
- `node --import tsx scripts/largest-wallet-check.ts`, with `LARGEST_WALLET_NAND` and `LARGEST_WALLET_LATCH`
- `node --import tsx scripts/canary/fork-local-candidate.ts --owner <public address> --fork-rpc <read-only RPC> --out <dir>`
- Mining lifecycle (§9): `node --import tsx scripts/fetch-mining-code.ts 128713128 reports/mining-code`, then
  `python3 -I scripts/mining-analysis/lifecycle.py reports/mining-code reports/mining-lifecycle-analysis.json`,
  and `npm run test:fork` with `FORK_RPC_URL` (the pinned inputs are in [MINING_LIFECYCLE.md](MINING_LIFECYCLE.md) §9)

## 9. Follow-up: Mining lifecycle evidence (U-01), 2026-10-21

U-01 was taken up after the remediation, under the same constraints:
- local forks only, and read-only public RPC;
- no deployment, signature, broadcast, `.env` or wallet secret;
- no change to Solidity under `src/`;
- no patching of Mining, BEM or collection code or storage.

Mining's source is unpublished, so the deployed bytecode was analysed directly and the transitions
were executed on forks. The full account is [MINING_LIFECYCLE.md](MINING_LIFECYCLE.md).

| Run | Result |
| --- | --- |
| Code fetch (read-only), block 128,713,128 | proxy, implementation `0xa3DB…f898` (code hash `0x63b1…2479`, as `protocol-check` pins) and library `0xFbB6…E6bA` (`0x028f…4737`); owner slot zero; `reports/mining-code/` |
| Bytecode analysis, `scripts/mining-analysis/lifecycle.py` | **PASS, 133 / 133 checks**, 14 s: all 89 implementation write sites classified, the status byte written only by `start` (→ 1), `stop` (→ 3) and `challenge` (→ 2) under the conditions in MINING_LIFECYCLE.md §4, settlement only for status 1, library writes confined to counterexample storage, implementation and owner frozen; `reports/mining-lifecycle-analysis.json` |
| `npm run test:fork`, block 128,713,128 (hash `0x760f050b…081f`), 2026-10-21 03:54:02–03:54:33 UTC | **PASS, 16 / 16**: the previous 11 plus 5 `MiningTransitionsForkTest` tests (two of them on a fork of block 119,597,280, replaying #2247's real revocation). The nine existing observation files are byte-identical to the committed ones; `reports/fork-test.json` now lists 16 results; `reports/fork-transitions-*.json` are new |
| Read-only probes | original starts of #2247 and #672, all 21,000 miner records, Mining's implementation history (`reports/probe-*.json`) |

The two historical-fork tests first failed with HTTP 429 from the public endpoint, before any
assertion; each passed on a rerun, and the suite run above passed with Foundry's local fork cache.
The scenarios were first dry-run on local Anvil forks. `npm run verify` was not re-run for this
follow-up, so §5 remains the record of the definitive run; it predates the new tests.
