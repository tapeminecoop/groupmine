# Remediation of the follow-up reviews of the 2.1.0 fee split (`8cf31dc`)

Date: 2026-10-21. Branch `claude/fee-split-audit-remediation`, starting from
`a74f6d47577bc4c84a15e6dd244e72c490df901a`. That is `origin/main`: the reviewed candidate `8cf31dc` (PR #4,
merged) plus the commit that adds Fable's review. No newer commit existed, and the working tree was clean.
So no unrelated work needed preserving and no newer fix existed to keep.

This is owner-authorized internal pre-release hardening, limited to tooling, the canary harness,
tests and documents:
- **No contract changed.** No Solidity under `src/` changed: production, canary, `PoolMath` and the
  protocol interface are byte-identical (§4).
- **No public-chain action.** Nothing was deployed to a public network, and no transaction was signed
  or broadcast. No real asset moved, and no `.env`, wallet or private key was read.
- **Read-only RPC.** The public RPC `bsc-mainnet.public.blastapi.io` served only as the read-only source
  of local forks.
- **Canary.** The live canary and recovery entry points were not run.

Passing tests are not an independent audit certificate and not a deployment approval. The application
has not been released as a public production custody service. An earlier recoverable canary did run on
BSC mainnet with the owner's own wallets and test assets; it used the 102-part model and did not
validate the 2.1.0 split.

Evidence: [`reports/fee-split-remediation-20261021-a74f6d4/`](../reports/fee-split-remediation-20261021-a74f6d4/).
It holds the recorded `npm run verify` run in `run/`, machine-readable assertions in `assertions.json`,
before/after identity records, and the before/after reproductions in `reproductions/`.

Statuses: **FIXED** (the defect is gone in the delivered tooling or text), **MITIGATED_IN_TOOLING** (this
project's tooling no longer exposes it; the underlying behaviour or an external consumer's exposure
remains), **DOCUMENTED** (a limit or policy, written down) and **UNVERIFIED / BLOCKED** (could not be
established with what was available).

## 1. Sources

| Source | Location | Notes |
| --- | --- | --- |
| Fable's follow-up review | `docs/INTERNAL_FEE_SPLIT_REVIEW_8cf31dc_FABLE.md`, review-only tests in `test/audit2/`, evidence in `reports/internal-review-8cf31dc/` (all in `a74f6d4`) | Kept unchanged. Its evidence README lists raw `.log` files that are not in the repository: the repository ignores `*.log` outside the run directories that have exceptions. |
| GPT's follow-up review | `INTERNAL_FEE_SPLIT_REVIEW_8cf31dc_GPT6PRO.md`, supplied as an attachment (515 lines, sha256 `2f7c5004…b73d`), read in full | Not added to the repository. Its companion proof archive (`proofs/…`, `workstreams/…`) was **not supplied**. Its cases were reproduced from the report's descriptions; no claim is made that its proof files were run. |
| Proposed patches | `proposed-patches/0003-…`, `0004-…` (`a74f6d4`) | Treated as proposals: 0003 implemented with other wording; 0004 superseded, because it checked `VERSION` after the concurrent reads had already decoded the tuples (§3.2). Statuses are recorded in an appended section of `proposed-patches/README.md`; the patch files are unchanged. |

The two reviews number their findings independently:

| GPT | Fable | Subject |
| --- | --- | --- |
| T-210-01 | – | offline receipt-deployment plans omit the configured chain |
| ABI compatibility requirement | T2-1 | 2.1.0 tuples changed layout under unchanged selectors; read commands did not act on `VERSION` |
| C-210-01 | (T-2 residual) | canary verifier: chain/block metadata failures bypass the structured result |
| D-210-01 | P2-1 | change report said claims do not accrue C |
| D-210-02 | – | stale "49" immutable-reference count |
| P-01 (carried) | – | raw repeated-ID preview overcounts; SDK normalizes |
| – | P2-2 | transient view over-read between a release's two transfers, reachable only with a hooking token |
| Slither not rerun by the reviewers | T2-2 | static-analysis delta |

## 2. Findings and status

| Finding | Status | Change | Regression and evidence |
| --- | --- | --- | --- |
| GPT T-210-01, offline chain binding (Low) | **FIXED** | `cli/pool.ts` `execute()`: the plan's chain is the planning node's, or offline the reviewed file's, used for the output and for `--chain` in every printed command; offline output says `CONFIGURED_NOT_RPC_VERIFIED` | `test/sdk/cli-chain-binding.test.ts` (4 tests: the actual CLI in a scrubbed child process, chain 97 and leak checks, online mismatch refused before any plan or Safe file, loopback node); `reproductions/t-210-01-offline-{before,after}.json` |
| Fable T2-1 / GPT ABI requirement (Low, integration) | **MITIGATED_IN_TOOLING** for this SDK and CLI; **DOCUMENTED** for external consumers | `sdk/pool.ts` `assertReadLayout`, run by `readPoolSummary` before any other read; `cli/pool.ts` read commands pass a node-dependent policy | `test/sdk/read-layout.test.ts` (8 tests: fake nodes that record every request, the actual CLI on Anvil with real 2.1.0 and canary-2 pools and a legacy `VERSION`) |
| GPT C-210-01, canary metadata classification (Informational, harness) | **FIXED** | `scripts/canary/revert-verifier.ts` (metadata stages, `METADATA_UNAVAILABLE`, `CHAIN_MISMATCH`), `scripts/canary/workflow.ts` (`recordNegativeTest`, `stopClassification`) | `test/sdk/canary-metadata.test.ts` (7 tests); existing `test/sdk/canary-revert.test.ts` (6) unchanged in substance; `reproductions/c-210-01-metadata-before-after.json` |
| GPT D-210-01 / Fable P2-1, claim accrual wording (Informational) | **FIXED** (documentation) | `docs/FEE_SPLIT_CHANGE_REPORT.md` §3 row corrected with a dated erratum and a header note; `docs/ACCOUNTING.md` §3 made explicit | `PoolFeeSplitTest.testClaimsRecognizeHeldIncomeAndAccrueCWithoutPayingIt` (new); `FeeSplitBoundaryTest.testClaimsAccrueCByRecognizingHeldIncomeButNeverPayIt` (review, retained) |
| GPT D-210-02, immutable-reference descriptions (Informational) | **FIXED** (comment and documentation) | `sdk/deployment.ts` points at the generated `immutableReferences`; `docs/OPERATIONS.md` names the generated source and the 2.1.0 counts | Counts verified against the build: pool 59 occurrences (5 immutables), distributor 11 (3), receipt 0, each equal to `sdk/bytecode.json`; the masking code is unchanged |
| GPT P-01, raw repeated-ID preview | **MITIGATED_IN_TOOLING** (retained, unchanged) | none: the raw view keeps counting occurrences; the SDK/CLI normalize | `ClaimPreviewTest` (3), local end to end `repeatedClaimIdsNormalizedAndPreviewEqualsPayment` |
| Fable P2-2, transient view with a hooking token | **DOCUMENTED** (dependency qualification retained) | none; no contract redesign | Not reachable with the bound BEM (no calls in its transfer path, per both reviews); `test/audit2/FeeSplitCallbacks.t.sol` retained |
| Fable T2-2 / GPT, static analysis not rerun by the reviewers | executed here | – | Slither in the recorded run (§5) |

### External and policy limits (DOCUMENTED, unchanged)

- Third-party software that keeps the 2.0.0 ABI misreads a 2.1.0 pool silently. This SDK cannot protect
  it; it must move to the 2.1.0 ABI (`docs/OPERATIONS.md` §12; the old-ABI/new-blob proofs in `test/audit2/`
  remain).
- `VERSION` is self-reported. The read gate keeps this tooling from misreading a layout but
  authenticates nothing. Write commands and `verify-deployment` keep the runtime-template,
  immutable-binding and addresses-file checks.
- The canary verifier pins calls by block number and records the hash; that is not EIP-1898 hash
  pinning (`docs/CANARY_RUNBOOK.md`).
- Atomic A/B/C payment, the rounding and checkpoint policy, permanent custody and strict admission
  settlement are unchanged accepted policies.

## 3. The fixes

### 3.1 GPT T-210-01: offline plans keep the configured chain

**Cause.** `deploy-receipts --system FILE` is the one command that can plan without an RPC. `execute()`
returned and printed only `context?.chainId`, so offline the chain the system file names was lost from
the output and from both `cast send … --create` commands.

**Change.** `const chainId = context?.chainId ?? binding.expectedChainId`, used for the output and for
`castCommand`:
- **Labelling.** Offline output adds `chainSource: CONFIGURED_NOT_RPC_VERIFIED` and a note that no
  node was queried; online output says `PLANNING_NODE`.
- **No defaults.** No chain is invented when none was supplied, and no network access was added.
- **Unchanged:** the online mismatch refusal, loopback targeting, Safe binding and RPC redaction.
- **No leaks.** `main` resets the binding on every invocation, and a test shows nothing leaks between
  invocations.

**Before and after** (the actual CLI, environment with only `PATH` and `HOME`, the example system file):

| | `chainId` in output | `--chain` in both creation commands |
| --- | --- | --- |
| `a74f6d4` | absent | absent |
| remediated | `56` (`CONFIGURED_NOT_RPC_VERIFIED`) | `--chain 56` |

A chain in an unsigned plan binds the signature to it; it does not prove which network a later
`$RPC_URL` serves. The operations guide says so.

### 3.2 Fable T2-1 / GPT ABI requirement: version-gated reads

**Cause.** 2.1.0 inserted `sink` into the `accrual()` and `previewAccrual()` tuples, and `sinkAccrued` and
`sinkPaid` into `reconciliation()`, without changing selectors. `readPoolSummary` read `VERSION` in the same
`Promise.all` as those tuples and never acted on it, and `inspect`, `reconcile` and `composition` have no
deployment check. Proposal 0004 put its check after that `Promise.all`, by which time the tuples were
already requested and decoded.

**Change.**
- **`assertReadLayout`** reads `VERSION` alone, at the caller's block. It accepts only
  `TapeoutMinerPool/2.1.0`, plus `RecoverableTapeoutMinerPool/canary-2-local` when the caller opts in.
  Anything else is refused with a diagnostic naming the reported version and the supported ones: a
  missing, empty, malformed or unknown version, or a read failure. The diagnostic never contains an
  RPC URL.
- **`readPoolSummary`** calls it before any other read. Nothing is cached, so each check belongs to its
  own node, pool and block.
- **Read commands.** The CLI's `inspect`, `reconcile` and `composition` opt in to the canary layout only
  on a loopback development node, where canary rehearsals run (`readLayoutPolicyFor`).
- **Write commands** keep `checkDeployment` first. Its runtime templates already refuse a canary or
  2.0.0 pool, and the read gate then applies the production policy.
- Accepting the canary layout grants no approval and bypasses no approved-candidate guard.

**Regressions** (`test/sdk/read-layout.test.ts`):
- **2.1.0:** `VERSION` is the first request, every read uses the same pinned block, and all C fields
  decode correctly. The ledger has P = 1,000, C = 25, NAND receipts 748, LATCH 250, residue 3, and
  `checkReconciliation` PASS.
- **Refused versions:** 2.0.0, 2.2.0, unknown, empty, trailing space and wrong case are refused, and the
  request record shows that only `VERSION` was read.
- **Unreadable versions:** revert, no data, malformed data and transport failure are refused as "could
  not be read", only `VERSION` is requested, and no URL appears in the message.
- **Canary layout:** refused by default and decoded on opt-in. Only `LOCAL_DEV_NODE` opts in.
- **Why it matters:** a layout with one more field decodes without error into the wrong fields, while
  the gated reader refuses it before requesting the tuple.
- **The actual CLI on Anvil:** a real 2.1.0 pool is inspected and reconciled (PASS). A real canary-2
  pool is inspected there, while the SDK default refuses it. `inspect`, `reconcile` and `composition`
  refuse a 2.0.0 `VERSION` and an address without code.

The low-level `readContract` calls in the test harnesses (`scripts/local-e2e.ts`, `scripts/fork-e2e.ts`,
the canary workflow) stay raw. They read pools those runs deploy from the current artifacts.

### 3.3 GPT C-210-01: canary metadata failures are classified

**Cause.** `verifyExpectedRevert` called `getChainId` and `getBlock` before its classified retry loop. A
failure there threw out of the helper with no verdict or attempt record. The workflow's catch then
recorded it as `BUSINESS_TEST_FAILED_RECOVERING`.

**Change.**
- **Metadata first.** Chain id, then block, each with up to the same bounded number of attempts, recorded
  in `metadataAttempts` (stage, attempt, ok, sanitized diagnostic).
- **What counts.** A value counts only if valid:
  - a positive integer chain id, equal to `expectedChainId` when given (the workflow passes 56);
  - a block with a number and a 32-byte hash, the requested number when one is given.
- **Outcomes.** Unobtainable or invalid metadata gives UNVERIFIED `METADATA_UNAVAILABLE`, with the stage
  and only the metadata actually obtained, and no `eth_call`. A different chain gives FAIL
  `CHAIN_MISMATCH`, not retried, with no call.
- **Retries stay pinned.** Once a block is chosen, `eth_call` retries use that block number. Exact
  error/argument matching, the FAIL/UNVERIFIED distinctions and the bounded retries are unchanged.
- **Workflow.** The workflow saves the evidence (`recordNegativeTest`) before stopping. It records an
  UNVERIFIED negative test as `NEGATIVE_TEST_UNVERIFIED_RECOVERING` with stop reason
  `INCONCLUSIVE_NEGATIVE_TEST`, never as a business-test failure; a FAIL stays
  `BUSINESS_TEST_FAILED_RECOVERING`. Recovery runs afterwards exactly as before, and
  `scripts/canary/recover.ts` is untouched.

**Before and after** (the original `a74f6d4` verifier and the current one, same in-memory node):

| Case | `a74f6d4` | remediated |
| --- | --- | --- |
| `getChainId` fails | throws `fetch failed`, no result; 1 chain read, 0 `eth_call` | UNVERIFIED `METADATA_UNAVAILABLE` at `chain-metadata`; 3 recorded attempts, 0 `eth_call` |
| `getBlock` fails | throws, no result; 1 chain + 1 block read, 0 `eth_call` | UNVERIFIED at `block-metadata`, chain 56 kept; 1 + 3 recorded attempts, 0 `eth_call` |
| metadata available | PASS | PASS (2 metadata attempts recorded) |

**Regressions** (`test/sdk/canary-metadata.test.ts`, 7 tests):
- **Unavailable metadata.** A `getChainId` failure gives 3 attempts with zero block reads and zero
  calls, and no chain or block is reported. A `getBlock` failure keeps the chain and makes zero calls.
- **Invalid metadata fails closed.** Chain id 0 or NaN, a missing number or hash, a malformed hash,
  another block than requested, or no block at all: no call is made and no block is invented.
- **Transient failures.** Metadata that fails once and then succeeds: the call runs at block 16 with
  every attempt recorded.
- **Call outcomes unchanged.** `eth_call` transport failures stay at the same block for all 3
  attempts. PASS, wrong error, wrong arguments and unexpected success are each decided on one call.
- **Chain mismatch** is FAIL, not retried.
- **Workflow helpers:** evidence is saved before the stop, the stop is classified, and normal steps do
  not continue.

The workflow-level ordering (catch, then recovery) is unchanged code. It is shown by source and by the
helpers, not by a fault-injected full canary replay.

The historical mainnet canary's `PARTIAL_AUTOMATION_FAILED_RECOVERY_AND_ACCOUNTING_PASS`, its original
failures and its skipped final harvest are untouched. The modified workflow is a new local candidate,
rehearsed under a new run identity (§5).

### 3.4 GPT D-210-01 / Fable P2-1 and GPT D-210-02: documents

- **Claim accrual.** The change report's claim row now reads "yes, when their `_sync` recognizes newly
  held BEM … never". A dated erratum follows the table, and a header note points to it; the rest of
  that report is as published. A new unit test shows a claim recognizing 84,000 held raw units:
  `totalAccounted` goes 0 → 84,000, C's accrual becomes 2,000, `sinkPaid` and the sink's balance stay 0,
  and the claim pays 6,000.
- **Immutable counts.** `sdk/deployment.ts` and `docs/OPERATIONS.md` no longer carry the stale "49". They
  point at the generated `immutableReferences` in `sdk/bytecode.json`, and the guide gives the 2.1.0
  counts, which were checked against the build.

## 4. Contracts preserved

The contract identity of the starting revision was recorded before any change. It covers sources, ABIs,
creation bytecode, runtime templates, immutable-reference counts and the toolchain
(`contract-identity-before.json`, from a fresh `forge build` at `a74f6d4`). It is identical to the
recorded identity of the 2.1.0 run (`reports/fee-split-20261021-c3cb933/run/contract-identity.json`).

After all changes, with the same toolchain (Foundry 1.4.3, solc 0.8.24, Paris, via-IR, 200 runs), and
checked after Slither's clean rebuild:

| Check | Result |
| --- | --- |
| Contract identity against `contract-identity-before.json` (step `contract-identity`, with `IDENTITY_BASELINE` set) | **IDENTICAL**: 7 contracts (production, canary, `PoolMath`, `IMining`) and 7 sources. The comparison covers ABIs, creation bytecode, runtime templates, immutable-reference counts, compiler settings and the `foundry.toml` and `package-lock.json` hashes |
| Build artifacts after Slither's `forge clean` and rebuild | identical to the tested build |
| `preservation-before.json` against `preservation-after.json` | equal: every `src/` file, `sdk/abi.ts`, `sdk/bytecode.json`, `foundry.toml`, `remappings.txt`, `package.json`, `package-lock.json`, OpenZeppelin 5.4.0 |
| Immutable-reference offsets (`immutable-references.json`) | build equals `sdk/bytecode.json`: pool 59, distributor 11, receipt 0 |
| SDK export from the tested build (step `export-abi`) | leaves `sdk/abi.ts` and `sdk/bytecode.json` unchanged |

The sources hash is `69abf1c0…`, the same as in the recorded 2.1.0 run. The only new Solidity is one test
function. The SDK tests deploy existing artifacts and, for the legacy `VERSION`, a hand-assembled
runtime stub, on a local Anvil node only.

## 5. Validation

The recorded `npm run verify` ran on the final tree: fingerprint `1e1a17d1…` over 154 files, base
`a74f6d4` with this change uncommitted. Every step passed:

| Step | Result | Detail |
| --- | --- | --- |
| Build sizes, SDK export, formatting | PASS | pool runtime 20,777 B, unchanged |
| Solidity suites, non-fork | PASS | 173/173: the 142 existing, the 30 `test/audit2` review tests and 1 new |
| Gas model | PASS | 11 tests; bounds unchanged |
| Internal review suite with `--ffi` | PASS | 10/10, including the differential test against the Python model |
| Review TypeScript tests | PASS | 13/13: `test/audit` 10 and `test/audit2` 3 (now part of the runner) |
| SDK tests | PASS | 74/74: 55 existing and 19 new (4 chain binding, 8 read layout, 7 canary metadata) |
| Typecheck | PASS | |
| Local Anvil end to end | PASS | 52 checks, 47 local transactions, `inspect` and `reconcile --deep` through the gated reader |
| Largest-wallet check | PASS | |
| Fork tests (real BSC state) | PASS | 17/17 at block 128,713,128 (`0x760f050b…081f`), including the real-BEM sink test |
| Fork end to end | PASS | 23 checks; `reconcile --deep` PASS through the gated reader |
| Safe end to end | PASS | 255 checks, 24 Safe transactions |
| Canary-2 local rehearsal | PASS | a new local candidate (digest `b276c69f…`, run `local-candidate-5ee3c28b…`) on block 128,812,145. The complete run passed all 43 assertions; its four negative tests were EXPECTED_REVERT, each with chain 56, its pinned block and two metadata attempts recorded. The interrupted run passed 7, followed by standalone recovery (`closed`, no errors) |
| Slither 0.11.3 | PASS | 79 results, the same findings as the 2.1.0 run (none added, none removed) |
| Artifacts stable after Slither's rebuild | PASS | |
| Contract identity against `a74f6d4` | PASS | IDENTICAL |

`assertions.json` maps each finding and preservation requirement to its evidence: 9 entries, all PASS, on
86 evidence items read from the run and the before/after records.

## 6. Changed files

- **Tooling:**
  - `cli/pool.ts`: chain resolution and labelling; read policy for `inspect`, `reconcile` and
    `composition`;
  - `sdk/pool.ts`: `assertReadLayout`, `readLayoutPolicyFor`, and `readPoolSummary` checking first;
  - `sdk/deployment.ts`: comment only.
- **Canary harness (new local candidate):** `scripts/canary/revert-verifier.ts` and
  `scripts/canary/workflow.ts`.
- **Validation runner:** `scripts/verify-all.ts` also runs the `test/audit2` TypeScript tests.
- **Tests:**
  - new: `test/sdk/cli-chain-binding.test.ts`, `test/sdk/read-layout.test.ts`,
    `test/sdk/canary-metadata.test.ts`, and one test in `test/unit/PoolFeeSplit.t.sol`;
  - adjusted: `test/sdk/canary-revert.test.ts` (one optional-chaining token, because `block` is now
    absent from metadata-failure results).
- **Documents:**
  - this report;
  - `docs/FEE_SPLIT_CHANGE_REPORT.md` (dated erratum);
  - `docs/ACCOUNTING.md`, `docs/OPERATIONS.md`, `docs/CANARY_RUNBOOK.md` and `README.md`;
  - `proposed-patches/README.md` (appended status section).
- **Evidence:** `reports/fee-split-remediation-20261021-a74f6d4/`.

Unchanged: everything under `src/`, `foundry.toml`, `remappings.txt`, `package.json`, `package-lock.json`,
`sdk/abi.ts` and `sdk/bytecode.json`. Also unchanged: every review report, every review-only test, the
historical evidence and the patch files (§4 and `historical-unchanged.json`).

## 7. Not executed and remaining release gates

**Not executed here:**
- **GPT's companion proof archive** was not supplied, so its cases were reproduced from the report. In
  particular, its offline-proof script and its 21-assertion metadata proof were not run as files.
- **A fault-injected replay of the full canary workflow** through the metadata path was not run. The
  verifier and the workflow helpers are tested; the catch-then-recover ordering is unchanged and is
  confirmed from source.
- **Live actions:** nothing was deployed and no live, real-asset or mainnet-canary step ran. None is
  authorized in this stage, and canary-2 is not approved.

**UNVERIFIED / BLOCKED (inputs not supplied):** the intended 2.1.0 deployment manifest, the actual wallet
implementations for both receipt categories, the largest allocation, and the maximum planned miner
inventory. This task cannot certify them by assumption.

**Remaining release gates.** These come from both reviews and are unchanged by this tooling work:
1. **Deploy 2.1.0 fresh and record it.** Pin the chain, addresses, constructor bindings and the 2.1.0
   SDK/ABI in a manifest. Run `verify-deployment` with the reviewed system file, so protocol, whitelist
   and ownership checks run.
2. **Retire stale 2.0.0 consumers.** External software that keeps the old ABI misreads silently.
3. **Rehearse the actual launch inputs** above on a fork.
4. **Refresh dependency identity at the release block** (`protocol-check`, the NFT beacon's authority)
   and re-run the real-BEM sink and Safe release flows with the final manifest.
5. **Independent professional audit** of the frozen semantic change and its integration.

## 8. Reproduce

```bash
npm ci --ignore-scripts
```

```bash
FORK_RPC_URL=<read-only archive RPC> SLITHER=$(which slither) CANARY_FORK_BLOCK=128812145 IDENTITY_BASELINE=reports/fee-split-remediation-20261021-a74f6d4/contract-identity-before.json npm run verify
```

The runner writes into `reports/`. This run's outputs were copied into the run directory, and the
historical files in `reports/` were restored, as the earlier runs did. Individual parts:
- `node --import tsx --test test/sdk/cli-chain-binding.test.ts test/sdk/read-layout.test.ts test/sdk/canary-metadata.test.ts`
  (needs `anvil` and a prior `forge build`)
- `forge test --match-path test/unit/PoolFeeSplit.t.sol`
- `node --import tsx --test test/audit/*.test.ts test/audit2/*.test.ts`
