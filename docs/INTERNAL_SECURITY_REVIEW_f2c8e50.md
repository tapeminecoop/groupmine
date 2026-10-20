# Internal security review — groupmine `f2c8e50` (TapeOut pooled-mining entitlement system)

Review date: 2026-10-21. Reviewer: internal (Claude Fable 5.1, authorized first-party review).
Frozen revision: `f2c8e50a21ba7878dbe8680e143db2a80398d38b` (branch `main`; `origin/main` was at the same
commit when checked). Previous production baseline `c4bc022c76c5de528a98caa58974ee5772f80d4a`; earlier
findings baseline `6da9a41b654f97115e486dadf9c2c184fe5126e3`. No newer commits exist on `main`, so there is
nothing to report separately as "differences after the freeze".

Nothing in `src/`, `sdk/`, `cli/`, `scripts/` or `test/{unit,invariant,fork,sdk,helpers}` was modified.
Everything this review adds is new and uncommitted: `test/audit/`, `proposed-patches/`,
`reports/internal-review-f2c8e50/` (fresh logs) and this document. No transaction was broadcast, no credential
was read, the project's `.env` was never loaded, and `canary:live` / `canary:recover` were never invoked.

---

## 中文执行摘要

- **范围与方法**：对冻结版本 `f2c8e50` 的四个生产合约、分发器与 SDK/CLI 工具、可恢复金丝雀（canary）合约与其自动化脚本做了实现级审查：源码审阅、独立的账务参考模型（Python，精确整数/有理数）与差分模糊测试（401 轮）、新增 10 个 Foundry 回归测试和 10 个 SDK 回归测试、在固定区块 128,713,128 复跑真实协议 fork 测试、只读核对 BSC 主网上金丝雀合约的字节码与最终状态、逐条核对交易日志。
- **生产合约**：未发现可导致资金损失、重复负债、权限绕过或账务不一致的缺陷。独立模型与合约在全部随机交错场景下逐项一致（总账、分类收入、每份额、每 ID 已领历史、A/B、余额），四账守恒、单调性、路径无关、领取顺序无关均成立。保留的问题全部是**已接受的设计限制**：严格结算使"后续准入"的可用性依赖于每个已登记矿机永远保持可领取或 REVOKED（P-1，中等可用性风险，无资金风险）；被撤销矿机永久保留权重并持续消耗准入 gas（P-2）；永久托管/无管理员通道（P-3）。
- **工具链**：主网金丝雀两条失败断言是**测试框架假阴性**，不是合约缺陷：原脚本只在 `error.message` 文本中查找错误选择子，而商用 RPC 把 revert 字节放在结构化 `data` 中。本审查用 7 种 RPC 错误形态加真实 Anvil 节点在本地复现（T-1）；冻结版本**只诊断、未修复**（源快照与当前文件逐字节相同），已给出补丁与回归测试。另有 3 个低危工具问题（T-2 至 T-4）。
- **金丝雀**：恢复逻辑与生产线仅差 recovery controller、ID 白名单、关闭与固定目的地返还；不含 Mining/BEM 调用；生产产物未受影响（源哈希、`build-source --check`、全新构建哈希与验证报告一致）。链上最终状态（两枚 NFT 已回到原钱包、已关闭、账务 134815/134808/7）与报告完全一致；主网部署字节码与冻结候选构建（掩掉 immutables 后）逐字节一致。
- **结论**：功能完整；本地与 fork 测试证据充分且可复现；安全置信度较高但**未经外部审计**；上线前需处理 T-1/T-2（金丝雀脚本）、T-3/T-4（分发工具预检）并正式记录 P-1 的运营预案。无必须修改生产合约的阻塞项。

---

## 1. Scope, capabilities and limitations

### 1.1 Examined files

| Area | Files |
| --- | --- |
| Production | `src/TapeoutMinerPool.sol`, `src/PoolMath.sol`, `src/TapeoutEntitlementReceipt.sol`, `src/TapeoutReceiptDistributor.sol`, `src/interfaces/IMining.sol` |
| Tooling | `sdk/{verify,allocation,gas,pool,tx,config,constants,math}.ts`, `cli/pool.ts`, `sdk/abi.ts`/`sdk/bytecode.json` (checked against a fresh build), `scripts/{verify-all,fork-test,local-e2e}.ts`, `scripts/lib/anvil.ts` |
| Tests | `test/unit/*`, `test/invariant/*`, `test/fork/*`, `test/sdk/*`, `test/helpers/*` |
| Canary | `src/canary/RecoverableTapeoutMinerPool.sol`, `src/canary/CanaryParticipant.sol`, `scripts/canary/*`, `test/unit/CanaryRecovery.t.sol`, `test/sdk/canary.test.ts`, `docs/CANARY_RUNBOOK.md` |
| Records | `docs/{ARCHITECTURE,ACCOUNTING,OPERATIONS,VERIFICATION_REPORT,BASELINE,LIVE_TEST_PLAN}.md`, `MAINNET_TEST_REPORT.md`, `reports/run-manifest.json`, `reports/logs/`, `reports/canary/**` including the mainnet run directory `canary-588196bf-…` (results, journal, manifest, final audit, cleanup, executed tools, source snapshot) |

### 1.2 Capabilities used

- Source inspection and deterministic reasoning.
- Local execution: Foundry unit/fuzz/invariant tests, the project's SDK tests, typecheck, local Anvil
  end-to-end, and this review's own tests (`test/audit/`), including an `ffi` differential fuzz against an
  independent Python reference model.
- Real-protocol state on a local fork pinned at block 128,713,128 (the author's recorded block), through
  `scripts/fork-test.ts` with the recorded inputs. The fork run impersonates miner holders locally only.
- Read-only public-chain queries (`cast call` / `cast code` against `https://bsc-dataseed.binance.org`) to
  check the live canary's deployed bytecode and final state.
- Local reproduction of JSON-RPC error shapes with a mock HTTP server and a real Anvil node.

### 1.3 Limitations

- **Mining implementation source not available.** BscScan's v1 API has moved, the v2 API needs an API key,
  Sourcify has no match and the explorer web page refuses automated fetches. All lifecycle statements about
  `Mining` (REVOKED permanence, restart semantics, who can set COOLING) therefore rest on the behaviour
  observed in the fork tests and on the author's historical-transaction evidence, not on source. They are
  classified EXTERNAL_DEPENDENCY below.
- **Slither** is not installed on this machine; the author's static-analysis results were not re-run.
- **Fork data provenance.** The fork rerun completed in 31 s. Foundry keeps an RPC cache per pinned block
  (`~/.foundry/cache/rpc/bsc/128713128`, 182 KB, modified by this run); part of the state may have come
  from that cache rather than the archive endpoint. Since the cache is keyed by the pinned block and the
  observation files came out byte-identical to the committed ones, the result is reproducible but is not
  proof of independent fetching.
- **No live transaction of any kind** was executed, so nothing new about the live protocol beyond the
  pinned block and the read-only state at head 128,777,627 was learned.

---

## 2. What was executed (fresh, this review)

Toolchain actually used: Foundry `forge 1.4.3-stable` (commit `fa9f934`), `solc 0.8.24` (Paris, via-IR,
optimizer 200 runs, as `foundry.toml` pins), Node `v20.19.5`, npm `10.8.2`, `viem 2.57.2`,
`@openzeppelin/contracts 5.4.0`, `tsx 4.19.3`, `typescript 5.7.3`, `forge-std` vendored under `lib/`
(no submodule). Dependencies were reinstalled from the lockfile (`npm ci --ignore-scripts`, 0 vulnerabilities).
Package scripts were read before use; none of them broadcasts, and the local end-to-end runner refuses any
non-loopback RPC (`assertLocalAnvil`).

Logs are in `reports/internal-review-f2c8e50/`.

| # | Command | Outcome |
| --- | --- | --- |
| 1 | `npm ci --ignore-scripts && forge build && forge test` | **107 passed, 0 failed, 3 skipped** (the three fork suites skip without `FORK_RPC_URL`). Includes the two invariant campaigns (256 runs × depth 64, `fail_on_revert`). Compilation from scratch (80 files). |
| 2 | `npm run test:sdk`; `npm run typecheck`; `node scripts/canary/build-source.mjs --check`; `npm run test:local-e2e` | SDK **36/36**; typecheck clean; canary source is exactly the generated patch of the unchanged production pool; local end-to-end `status: PASS`, every check true (57 steps on a throwaway Anvil). |
| 3 | `forge test --match-path 'test/audit/*' --ffi -vv` (this review's tests, first run) | 8 passed, **2 failed**: both were defects in my tests, not in the contracts (section 3.3). Preserved in the log. |
| 4 | `FORK_RPC_URL=https://bsc-mainnet.public.blastapi.io FORK_BLOCK=128713128 FORK_NAND_MINER=12733 FORK_LATCH_MINER=13948 FORK_INACTIVE_TOKEN=648 FORK_SCALE_MINERS=… npm run test:fork` | **PASS, 11/11** at block 128,713,128, hash `0x760f050b…081f`. All nine observation files (`reports/fork-*.json`) are **byte-identical** to the committed ones; `fork-test.json` differs only in timestamps. Tracked files were restored afterwards; copies are in the review's log folder. |
| 5 | differential fuzz, corrected model | **PASS, 401 runs** (24 operations each) — see section 3. |
| 6 | final audit suite (`forge test --match-path 'test/audit/*' --ffi` + the two SDK audit tests) | **10/10 Foundry, 9/9 + 1/1 SDK**. |
| 7 | read-only chain checks (`cast`) at head 128,777,627 | Section 5.2. |
| 8 | journal re-computation (`python3 -I` over `journal.jsonl`) | Section 5.1. |

Author-reported historical numbers (95 Solidity tests / 32 SDK tests at `c4bc022`) are consistent with what
`f2c8e50` adds (12 canary Foundry tests, 4 canary SDK tests) and with the fresh counts above.

---

## 3. Independent accounting and state model (workstream A)

### 3.1 The model

`test/audit/model.py` is a reference implementation written from `docs/ACCOUNTING.md` and the brief's
business rules, not from `PoolMath.sol` or `sdk/math.ts`. It keeps the pool balance, the recognized total,
Mining's per-miner owed amounts, composition periods with frozen bases, per-ID claimed histories, receipt
holders, recipient roles and every actor's BEM, with exact integers; in parallel it accumulates the exact
rational split (`fractions.Fraction`) that the integer rules approximate. On every operation it checks its
own invariants and reports a status word if any fails.

`test/audit/AuditDifferential.t.sol` drives the real contracts with a seed-derived interleaving of nine
operation kinds — admission with carried income visible to or hidden from `pending()`, accrual, harvest,
third-party `Mining.claim`, direct BEM transfer, single and batch holder claims, receipt transfer, A/B
release, A/B role migration — records the exact trace, replays it through the model via `vm.ffi`, and
compares 34 quantities: recognized total, A accrual, NAND/LATCH income, per-share values, residue, total
paid, A/B paid, receipts paid per category, period count, pool balance, every per-ID claimed history and
eight account balances; then `assertReconciled()`.

### 3.2 Invariants and the evidence for each

| Invariant | Evidence |
| --- | --- |
| 100:1:1 conservation: `T = A + B + S_N·perN + S_L·perL + residue`, `balance = outstanding + residue + unrecognized`, Σ claimed per category = receipts paid | Differential fuzz (401 runs); `assertReconciled` in every author and review test; invariant campaigns `invariantFourAccountConservation`, `invariantPerIdHistories` (256×64); live canary ledger (section 5) |
| Solvency / no underflow: `participantBase ≤ P(T)` always, `claimed[id] ≤ perShare`, `rolePaid ≤ accrual` | Model raises on any violation; none in 401 runs; `PoolMath` arithmetic reviewed: `d = P − participantBase ≥ 0` because the checkpoint sets `participantBase = nandIncome + latchIncome ≤ P(T_k)` |
| Monotonic accrual: category incomes and per-share values never decrease, including across checkpoints | Model `observe()` on every step; `invariantEntitlementsNeverDecrease`; `testEntitlementsNeverDecreaseAcrossCompositionChanges` |
| Fixed denominators, no cross-collection collision | `claimed` is keyed by `(category, id)`; `shareCount` fixed at activation; `testSameNumberedIdsInBothCollectionsAreIndependent`; fuzz compares histories per category |
| Period checkpoints, zero cases, residue carry, repeated tiny incomes | Model: `P(T) − 1 ≤ nandIncome + latchIncome ≤ P(T)` on every step (at most one participant unit unallocated at any time); rational drift `|nandIncome − ideal| ≤ periods + 1`; residue ≤ `3 + (S_N − 1) + (S_L − 1)`; the author's `testCheckpointFreezesCategoryTotalsAndCarriesAtMostOneUnit` and `testRoundingResidueStaysBoundedOverManyPeriodsAndHarvests` |
| One income versus partitioned harvests within a composition | Inside a period every quantity is a function of `T` only (`PoolMath.accrue`), so the fuzz's harvests/third-party claims/donations recognized in any order give the same ledger; `testPathIndependenceWithinACompositionPeriod` |
| Legitimate claim order irrelevant to others | `AuditClaimOrderTest.testClaimAndReleaseTimingDoesNotChangeAnyoneElsesEntitlement`: the same event script (two composition changes, a hidden carried income, a donation, a third-party claim, two receipt transfers, a role migration) with and without a holder claiming and A being released after every event: identical accrual, identical claimable amounts for every ID that holder never held, identical lifetime income for the holder and for A, and for the ID she gave away mid-script, her claims plus the new holder's remaining claimable equal the ID's lifetime income |
| Transfers, claims, category changes, direct transfers, role migration, releases interleaved | Differential fuzz covers all nine kinds in random order; `testRoleMigrationPaysUnreleasedIncomeToTheNewAddressAndNothingToTheOld` |
| No duplicated liability / no loss of recorded credit | Per-ID histories compared with the model after every run; `_claimOne` sets `history = perShare` before paying; repeated claims pay zero (`cleanup-helper-repeat-claim-1` on mainnet paid 0) |

The distinction the brief asks for: the pool's `totalAccounted` is **recognized income** (actual balance
increases, by any route, only while a composition exists); `Mining.pending` is never read by the contracts
and is not a liability; collectible Mining debt only becomes income when a claim pays; outstanding receipt
income is `perShare − claimed[id]` per ID; A/B income is `⌊T/102⌋ − rolePaid`; residue is what the floors
leave inside the pool and is recomputed from `T`, so it never accumulates. The model tracks each of these
separately, and a conservation identity alone was not treated as proof of fair payment: the per-ID and
per-account comparison is what establishes it.

### 3.3 Failures met while building the model (preserved)

Two review tests failed on their first run (`reports/internal-review-f2c8e50/03-audit-forge-tests.log`).
Both were errors in the review's assumptions, corrected without weakening any contract claim:

1. The model asserted `balance == T − paid` at the end even when no miner had ever been admitted. The pool
   deliberately leaves BEM unrecognized before the first admission (no composition to split by,
   `docs/ACCOUNTING.md` §1); the model now applies the identity only once a composition exists.
2. The claim-order test counted, among "others' entitlements", a LATCH ID that the claiming holder owned
   first, claimed on, and then transferred away. Under the documented rule "unpaid income follows the ID",
   what the new holder can claim on that ID legitimately depends on what the previous holder already took.
   The test now excludes that ID from the fingerprint and checks its per-ID conservation instead.

A third speculative SDK test (a text-matcher false positive via calldata containing the selector) was
disproved by its own run and removed: the frozen matcher searches for the `0x`-prefixed selector, which
argument words never contain.

---

## 4. Findings

Severity is for this system's assets and availability. Labels: CONFIRMED, SUSPECTED,
ACCEPTED_DESIGN_LIMITATION, EXTERNAL_DEPENDENCY, NOT_REPRODUCED.

### 4.1 Production contracts

No Critical or High finding. No concrete counterexample to any claimed invariant was found by source
reasoning, by the author's suites, by the differential fuzz, or by the fork rerun.

#### P-1 · Admission liveness depends on every registered miner staying claimable or REVOKED forever

- **Label / severity:** ACCEPTED_DESIGN_LIMITATION (availability), Medium. No funds at risk.
- **Component / location:** `src/TapeoutMinerPool.sol:633-642` (`_settleOld`), `:572-576` (step 3 loop).
- **Preconditions:** any registered miner whose `Mining.claim` reverts while `getMiner(key).status != 2`.
- **Actor capability:** none required from an attacker; it is a protocol-state condition. On the deployed
  protocol only the NFT holder can `stop` (fork-verified), the pool never calls it, and `challenge` leads
  to REVOKED (skipped). No route into status 0 or 3 for a pool-held miner was observed; the restart and
  revocation-permanence semantics are UNVERIFIED by the author and by this review (no source).
- **Reproduction:** `AuditAdmissionLivenessTest.testPermanentlyNonClaimableOldMinerBlocksEveryLaterAdmissionButNotPayouts`
  (mock-only status injection): with one registered miner reported COOLING, every `depositMiners` and
  `registerMiners` reverts `SettlementFailed` forever; a plain-transferred miner then sits in custody
  unregistered; harvests isolate the failing miner, claims and releases keep paying; only a protocol status
  change unblocks it. There is no eviction, skip or override in the pool.
- **Expected vs actual:** matches the documented "fail closed" policy (`docs/ARCHITECTURE.md` §4.2).
- **Impact:** if the protocol ever puts a pool-held miner into a non-ACTIVE, non-REVOKED state, miners
  built from the remaining materials can never be admitted; income distribution continues.
- **Remediation:** none inside the candidate, consistent with the brief (no incidental recovery
  authority). Record the risk explicitly in `docs/ARCHITECTURE.md` §6/§7 and `OPERATIONS.md` §9 as a
  release-time acceptance; keep `protocol-check` and status monitoring of every registered miner in the
  operations playbook; prefer `depositMiners`. A permissionless, evidence-based skip (e.g. a registered
  miner that Mining reports non-ACTIVE for N blocks) is a design change for a future version with its own
  review, not a patch for this one.
- **Regression test:** the test above (documents the behaviour; it is not a defect claim).

#### P-2 · Revoked miners keep their composition weight and keep costing gas on every admission

- **Label / severity:** ACCEPTED_DESIGN_LIMITATION, Low.
- **Location:** `src/TapeoutMinerPool.sol:597-598` (`totalNandBurn += …`, never decremented), `:633-642`.
- **Reproduction:** `AuditAdmissionLivenessTest.testRevokedMinersKeepTheirWeightAndKeepCostingGasOnEveryAdmission`:
  with ten old miners, admission gas on the mock is 199,346 with them active and 251,102 with all ten
  revoked (a reverting `claim` plus a `getMiner` read each); the composition stays 52:52 and income from
  the only producing miners is still split by the dead miners' weight.
- **Impact:** by design ("materials were consumed"); the registry-size limit (§6 of the architecture, about
  590 miners before the BSC cap) is reached a little earlier when many miners are revoked.
- **Remediation:** none; document that revoked miners count towards the registry limit.

#### P-3 · Permanent custody, no sweep, unreachable beneficiaries

- **Label / severity:** ACCEPTED_DESIGN_LIMITATION, Low.
- **Facts verified:** the pool has no withdrawal, sweep, pause, upgrade or arbitrary call; `Ownable2Step`
  deletes the pending owner on renounce (OpenZeppelin 5.4.0), so no ownership can be resurrected; the
  residue is bounded and recomputed (never accumulates); a distributor beneficiary that cannot receive
  ERC-1155 (`testABeneficiaryThatCannotReceiveIsNeverRedirected`) keeps its receipts in the distributor
  forever, with their income locked in the pool, and the contracts do not prevent such an allocation —
  only the CLI's ERC-165 check does. Lost recipient or depositor keys cannot be replaced.
- **Remediation:** none in-candidate; these are the stated trust assumptions. The CLI check must remain a
  hard gate in operations (it is: `import-allocation` refuses, `verify-allocation` reports `NOT_READY`).

#### P-4 · Zero-value ERC-1155 transfers run receiver hooks (informational, NOT_REPRODUCED as a defect)

OpenZeppelin's ERC-1155 lets anyone transfer a value of 0 of any ID without holding it, which runs the
receiver's hook. `AuditReceiptEdgesTest.testZeroValueTransfersCannotForgeInventoryOrMoveTheHolderIndex`
verifies that the receipt's holder index (`_update` skips `value == 0` before touching `_holders`), the
distributor's inventory (`_acceptOne` returns false), post-finalization refusal (`AllocationClosed`) and
holder-only claims are unaffected, and that the pool (no hook) rejects even zero-value transfers.
Duplicate-ID batch rows with a zero value keep the index consistent
(`testDuplicateIdRowsWithAZeroValueKeepTheIndexConsistent`). A beneficiary contract that claims BEM from
inside the delivery hook is paid once; a hook that re-enters the distributor is refused by the reentrancy
guard while the outer delivery completes once (`testHookClaimDuringDeliveryPaysOnceAndReentrantDeliveryIsRefused`).

#### P-5 · Documentation nit: "runtime code hashes" of pool and distributor are placeholder-immutable hashes

`docs/VERIFICATION_REPORT.md` lists `0x5655ce42…2c26` (pool) and `0xcf370db1…0ada` (distributor) as
runtime code hashes "of the tested artifacts". Both contracts have immutables (49 and 11 reference slots),
so no deployed instance can have these hashes; only the receipt's `0x7f59d20c…ec8f` (no immutables) is a
deployed identity — and it is exactly the code hash of the two receipts the canary deployed on mainnet.
The canary tooling handles this correctly (`verifyRuntime` masks immutables and records the observed hash).
Suggest wording the production table the same way to avoid a future mis-verification.

#### Other entry points reviewed without finding (summary)

Constructor binding by runtime code hash and category (`IncompatibleReceipt`), depositor whitelist
validation (1–16, unique, no protocol/receipt/self), `activate` once with reviewed supplies and
`NoShares`; `depositMiners` requires `ownerOf == msg.sender` (another account's approval cannot be used,
`testOnlyWhitelistedDepositorsAdmitAndOnlyTheirOwnMiners`); `registerMiners` requires custody and the same
whitelist/boundary; `_readComposition` cross-checks record, collection, token id, cache and non-zero burn;
step order (recognize → settle old → checkpoint → custody → claim incoming → recognize) is order-independent
(fork `testForkBoundaryIsIndependentOfProcessingOrder`, unit `testBatchOrderDoesNotChangeTheOutcome`);
`harvest` isolates failures and counts only balance deltas; `claim`/`claimBatch` are holder-only
(operators excluded), reject out-of-range IDs, pay duplicates zero; `_pay` checks exact deltas and
`_sync` refuses balance decreases; `setRecipient` is role-holder-only and `releaseA/B` are independent;
all state-changing entry points are `nonReentrant`; no overflow is reachable (`d·N` ≤ ~1e43). Receipt:
sequential issuance ≤ 500 per batch, `retract` only the issuer's own top IDs before finalization,
`_update` refuses mint/burn after finalization and any value > 1. Distributor: bound receipts only,
inventory counted only through hooks, `allocate` checks custody and uniqueness, `revokeWallet` clears
ranges before finalization, `finalizeAllocation` requires both issuances finalized and
`allocated == inventory`, delivery is cursor-based, exactly-once and all-or-nothing.

### 4.2 Distributor tooling, SDK and CLI

#### T-1 · Canary negative tests decide on the error message text; false negatives on structured RPC data — diagnosed, not corrected

- **Label / severity:** CONFIRMED, Medium (tooling/process; it caused the mainnet automation to abort).
- **Location:** `scripts/canary/workflow.ts:43-48` (`rejected`), `scripts/canary/common.ts:30-34` (`redact`).
  The current file is byte-identical to the executed source snapshot
  (`reports/canary/mainnet/canary-588196bf-…/source-snapshot-manifest.json`, all 36 hashes verified), and
  that manifest states the matcher is intentionally preserved. The repository therefore contains the
  **diagnosis** (supplemental cleanup tool, structured decode) but **not the fix**.
- **Reproduction (local, viem 2.57.2):** `test/audit/revert-matcher.test.ts` runs the frozen decision
  logic against seven JSON-RPC shapes served by a mock HTTP server plus a real Anvil node:

  | RPC shape | Frozen matcher | Proposed `classifyNegative` |
  | --- | --- | --- |
  | `{code:3, message:"execution reverted", data:"0x794e61c9…"}` (the mainnet RPC's shape; viem renders "Execution reverted for an unknown reason") | **FAIL (false negative)** | `EXPECTED_REVERT` |
  | same, data nested as `data.data` | **FAIL (false negative)** | `EXPECTED_REVERT` |
  | bytes only in the message text (Anvil-like) | PASS | `EXPECTED_REVERT` |
  | reverted, no bytes anywhere | FAIL | `REVERT_UNVERIFIABLE` |
  | reverted with another selector | FAIL | `UNEXPECTED_REVERT` |
  | transport failure (HTTP 502) | FAIL | `TRANSPORT_OR_OTHER_ERROR` |
  | call succeeds | FAIL | `DID_NOT_REVERT` |
  | real Anvil, contract reverting `NotHolder(0,1)` | PASS | `EXPECTED_REVERT` (bytes recovered from the node's own message) |

  The frozen matcher never passes an unexpected outcome (fail-closed), which is why the mainnet run
  aborted rather than mis-reporting a bypass; but it cannot distinguish "RPC shape" from "the contract let
  the former holder claim".
- **Impact:** the mainnet run was aborted at the first negative test; the orderly pre-shutdown final
  harvest and nine further planned assertions never ran (section 5.3). Not a security defect of the
  contracts: the supplemental structured diagnostics decoded `NotHolder`, `CanaryClosed` (admission and
  harvest) and `NotDepositor` from the revert bytes.
- **Remediation:** `proposed-patches/0001-canary-structured-revert-matcher.patch` with
  `test/audit/revert-matcher.ts` as the helper: decide on revert bytes found in the structured error data
  (any nesting), fall back to the node's own `details` text (Anvil/Hardhat), and record a classified
  outcome for every other case. Rebuild, fork-rehearse and re-approve before any further live run (the
  candidate fingerprint covers `scripts/canary/`).
- **Regression test:** `test/audit/revert-matcher.test.ts` (9/9).

#### T-2 · The runner treats a harness failure like a business failure

- **Label / severity:** CONFIRMED, Low (design of the automation).
- **Location:** `scripts/canary/workflow.ts:12-16` (`check` throws on any FAIL), the business `try` block
  and the finalization `try` block.
- **Behaviour:** any failed assertion, including an unverifiable negative test, throws into emergency
  recovery and then into the finalization block's own abort. On mainnet this skipped the pre-shutdown final
  harvest and left the rest to a separately approved continuation.
- **Remediation:** with T-1's classification, let `REVERT_UNVERIFIABLE`/`TRANSPORT_OR_OTHER_ERROR` retry
  (alternate decoding or RPC) a bounded number of times before aborting, and keep `DID_NOT_REVERT` and
  `UNEXPECTED_REVERT` as hard aborts. Recovery itself stays independent of this.

#### T-3 · `verify-allocation` does not relate the distributed inventory to the issued supply

- **Label / severity:** CONFIRMED, Low (transparency gap in operator tooling; on-chain rules are as documented).
- **Location:** `sdk/verify.ts:192-215`; `cli/pool.ts:306-320`.
- **Behaviour:** `verifyAllocation` compares the artifact with the distributor and reports readiness only
  for `allocated == inventory`. Receipts that were issued but never moved into the distributor (the runbook
  explicitly allows funding a subset, `--ids 1-800`) keep their full entitlement with whoever holds them and
  appear nowhere in the result. `test/audit/verify-supply-gap.test.ts` shows `READY_TO_FINALIZE` with no
  gap and no supply figure when 10 of 100 issued NAND receipts stayed with the issuer.
- **Impact:** a published artifact can look like "the whole distribution" while part of the supply is
  retained; contributors would have to read the receipt contract to notice.
- **Remediation:** `proposed-patches/0002-…` adds `supply` and `retained` counts and a warning line to the
  result; consider adding the supply to the artifact and, if the business rule is "all receipts go to
  contributors", a readiness gap unless an explicit flag allows retention.

#### T-4 · `finalize-allocation` has no readiness preflight

- **Label / severity:** CONFIRMED, Low (operator-error hazard; irreversible on chain).
- **Location:** `cli/pool.ts:334` (one-line command), `src/TapeoutReceiptDistributor.sol:172-184`.
- **Behaviour:** the contract permits finalizing with zero inventory (`0 == 0`); afterwards nothing can
  ever enter the distributor, so a premature finalization forces a new distributor. `import-allocation`,
  `activate` and `renounce` have preflights; this command does not, and nothing forces `verify-allocation`
  before it.
- **Remediation:** `proposed-patches/0002-…`: refuse unless the same readiness conditions as
  `verify-allocation` hold and something is allocated.

#### T-5 · Verification proves artifact == chain, not reviewed JSON == chain (informational)

`verify-allocation` validates the artifact and compares it with the chain in both directions (the earlier
review fix is in place and its nine SDK tests plus the end-to-end checks re-ran green). The artifact records
`sourceSha256` of the allocation JSON, but no command checks that hash or recomputes the deterministic
assignment from the JSON. A reviewer who trusts the artifact trusts the machine that produced it. Suggest an
optional `--allocation FILE` on `verify-allocation` that recomputes `assignIds` from the JSON and the
inventory at the artifact's block and compares, and checks `sourceSha256`.

#### T-6 · Static analysis not re-run (informational)

Slither is not installed here; the author's `reports/slither.*` were read but not reproduced.

### 4.3 Canary-only code and automation

#### C-1 · Separation and recovery design — verified

- The canary is the production pool plus exactly: an immutable `recoveryController` (= constructor owner,
  which must also be the single depositor), hard-coded token IDs 3204/12485 in admission and return,
  `closed` gating of `activate`, admissions and harvests, `shutdown()` (controller-only, irreversible) and
  `emergencyReturn(id)` (controller-only, only after shutdown, only the two IDs, destination fixed to the
  controller, idempotent, `nonReentrant`, **no Mining or BEM call**). `node scripts/canary/build-source.mjs --check`
  regenerates it from the unchanged production source (hash-pinned) and passes; `git diff` against
  `TapeoutMinerPool.sol` shows only those additions.
- No recovery power leaks into production: production sources and the fresh production artifacts are
  unchanged (hashes in section 5.2), and the canary's `VERSION` string differs.
- No BEM sweep exists; `CanaryParticipant` can only claim through the pool, transfer its receipts to the
  controller, and forward its own BEM to the controller; `bindPool` is one-shot with binding checks.
- Recovery independence from Mining/BEM faults and from owner renunciation, idempotent partial returns,
  unregistered custody return, and scope limits are covered by the 12 `CanaryRecoveryTest` cases (re-run
  green) and by the SDK check that `emergencyReturn` contains no `mining.`/`bem.`/`_sync`/`_pay`/`_harvest`
  call or destination parameter.
- A half-completed return cannot be mistaken for both: `recover()` attempts each ID independently, records
  per-ID `ownerOf` and errors in `recovery.json`, throws if any error remains, and the final audit asserts
  `ownerOf` for both IDs at a confirmed block (`bothActualOwnersAreOriginalWallet`, `neitherNFTInCanary`).

#### C-2 · Runner safety properties — verified by source and fixtures

Budget: `budget()` keeps ordinary steps below `total − reserve` and recovery below `total`
(`test/sdk/canary.test.ts`). Fees: per-transaction cap, price ceiling (2× quote at proposal), 2^24 gas cap.
Nonce: pending must equal latest; ordinary steps pin `nextNonce`; recovery tolerates external nonce changes.
Journal: INTENT → SIGNED_HASH (hash known before broadcast) → CONFIRMED; `reconcileJournal` resolves every
hash and refuses to continue on an unknown or pending one (fail-closed; could delay recovery after a
broadcast that failed before send — the runbook covers manual reconciliation). Identity pinning: every send
re-verifies deployed code (immutables masked) against the saved artifacts, the recorded code hashes, the
fixed controller, protocol bindings, recipients and the one-address whitelist. Gates: `MODE`,
`ALLOW_MAINNET_BROADCAST`, `--broadcast`, approved run id, approval record digest, candidate fingerprint,
proposal caps, non-local RPC, non-Anvil client, wallet nonce equal to the proposal's. Fork rehearsal deletes
the private key from the environment before starting Anvil and uses impersonation only. Helper authority is
narrow (section C-1).

#### C-3 · Minor observations (no action required)

- After `emergencyReturn` the ledger still lists the miner as registered with its weight; harmless because
  admissions and harvests are closed, and claims/releases use the frozen composition as documented.
- The `rejected` simulations run at `latest`; the supplemental non-whitelisted check was correctly pinned
  to a pre-shutdown block, since after shutdown `CanaryClosed` is raised before `NotDepositor`.

### 4.4 External assumptions and dependencies

| ID | Assumption | Status | Evidence |
| --- | --- | --- | --- |
| E-1 | `Mining.claim` is permissionless, pays the NFT's current holder, can pay while `pending()` is 0, reverts `0x5f9bb3be` unless ACTIVE | EXTERNAL_DEPENDENCY, behaviour verified | fork rerun (identity, boundary, lifecycle tests); live canary (`phase-A-bounded-harvest`: pending 187, paid 793) |
| E-2 | Only the holder can `stop`; `stop` pays first, then COOLING; claims then revert, also after cooldown | behaviour verified at block 128,713,128 | `MiningLifecycleForkTest` (rerun) |
| E-3 | REVOKED is permanent and the revoking transaction pays the holder; a revoked circuit cannot restart | UNVERIFIED by source; history-only | author's historical transactions for #2247, #7555; frontend text. Implementation source could not be retrieved (no explorer API key, no Sourcify match). The pool's REVOKED skip is sound **given** this; if a revoked miner could restart, its later income would still reach the pool through `harvest`, and nothing would be lost — only the one-time "skip" would be unnecessary. The dangerous direction (a non-REVOKED permanent failure) is P-1, not this. |
| E-4 | No route puts a pool-held miner into status 0 or 3 | not observed; cannot be proven without source | P-1 |
| E-5 | Miner collection is a beacon proxy whose beacon is owned by a contract that can change the implementation; Mining is UUPS with renounced owner | verified at the pinned block | `fork-identity.json` (identical on rerun) |
| E-6 | BEM is a plain ERC-20 (no fee/rebase/forced debit) | verified on tested paths only | `_pay` delta checks and `BalanceDecreased` make a violation fail closed, not silently |
| E-7 | Public archive RPC availability for fork evidence | operational | section 1.3 |

---

## 5. Mainnet PARTIAL result: source-versus-report reconciliation

Status under review: `PARTIAL_AUTOMATION_FAILED_RECOVERY_AND_ACCOUNTING_PASS` for run
`canary-588196bf-b2d8-4c9b-9c60-fdc66faecd68`, original automation `FAIL_OR_INCOMPLETE`. This review
**confirms** that status and the report's numbers; it does not upgrade it.

### 5.1 Journal and ledger, recomputed independently

From `journal.jsonl` (129 rows: 43 × INTENT, SIGNED_HASH, CONFIRMED; 43 receipts, all `success`; nonces
16–58 contiguous, matching the proposal's `initialNonce` 16; 43 unique hashes, none signed-but-unconfirmed):

| Quantity | Recomputed | Reported |
| --- | --- | --- |
| Total fees | 911,324,260,000,000 wei = 0.00091132426 BNB | same |
| BEM `Transfer` into the pool across journaled transactions | 134,815 raw | `totalAccounted` 134,815 |
| BEM out of the pool | 134,808 raw | `totalPaid` 134,808 |
| Difference | 7 | residue 7 |
| Phase A: carried income of #3204 / first bounded harvest / held old income | 52,409 / 793 / 1,126 | same |
| Phase B (`phase-B-deposit-12485`): recognized 1,126 then 1,075 in period 1; checkpoint at `T = 55,403`, `nandBase 54,316`, `latchBase 0`; carried 77,784 in period 2; `totalNandBurn 3`, `totalLatchBurn 1` | from decoded events | same |
| Phase C harvest | 814 + 814 = 1,628 | same |

Because every BEM inflow is in the journal, no third party paid the pool during the run.

### 5.2 Deployed identities and live final state (read-only, head 128,777,627)

| Contract | Address | Observed code hash / size | Masked comparison with this review's fresh build of the frozen candidate |
| --- | --- | --- | --- |
| Canary pool | `0x5904d00d…591e` | `0xd05dd9b0…63ae`, 20,404 B | identical (53 immutable slots masked) |
| Distributor (production artifact) | `0x47f09bb7…b612` | `0x3e2fa6a9…846f`, 7,680 B | identical (11 slots masked) |
| NAND receipt (production artifact) | `0xa246ab17…6229` | `0x7f59d20c…ec8f`, 8,743 B | identical, and equal to the production receipt artifact hash (no immutables) |
| Helper | `0xa93cb7a0…cf57` | `0x8ca6042e…3607`, 3,410 B | identical (18 slots masked) |

Fresh-build production artifact hashes equal `docs/VERIFICATION_REPORT.md`: receipt `0x7f59d20c…ec8f`,
distributor `0xcf370db1…0ada`, pool `0x5655ce42…2c26`; `sdk/bytecode.json` initcode equals the fresh build
for all three. Live state: `ownerOf(3204)` and `ownerOf(12485)` = `0x7eED…F129`; `closed() == true`;
`owner() == 0x0`; `recoveryController() == 0x7eED…F129`; `reconciliation()` =
(7, 0, 0, 134815, 134808, 1321, 1321, 1321, 1321, 112707, 112704, 112704, 19463, 19462, 19462, 7);
composition 3:1. All equal to `final-audit.json` (block 128,772,561) and `MAINNET_TEST_REPORT.md`.

The source snapshot in the run directory is byte-identical to the current tree for all 36 files, and the
three supplemental tools' hashes match their manifest entries, so the scripts examined are the scripts that
ran. Fork rehearsals: three complete/interrupted pairs PASS / `INTERRUPTED_FOR_STANDALONE_RECOVERY`, and one
earlier attempt `FAIL_OR_INCOMPLETE` ("Gas price above approved ceiling") preserved as such.

### 5.3 Planned assertions versus what actually ran

| Planned in `workflow.ts` | Original mainnet run | Later |
| --- | --- | --- |
| 23 setup/boundary/claim/transfer assertions through `transfer-keeps-history-and-unpaid` | PASS (23) | — |
| `former-holder-claim-rejected` | **FAIL — harness false negative** (T-1); `eth_call` only, nothing broadcast | diagnostic `former-holder-claim-structured-revert` decoded `NotHolder` from the bytes (simulation) |
| `non-whitelisted-admission-rejected` | not reached (aborted) | diagnostic at the pre-shutdown block decoded `NotDepositor` (simulation) |
| `helper-claims-transferred-nand-1-exact`, `helper-repeat-claim-exact`, `repeat-claim-pays-zero` | not reached | continuation transactions: exact payouts, repeat claim paid 0 |
| `role-A/B-separate-cumulative-allocation` | not reached | continuation: `cleanup-release-A/B-separately`, each `⌊T/102⌋` |
| `phase-D-orderly-final-harvest` (pre-shutdown) | **skipped, never executed**; income accrued between phase C and shutdown stayed in Mining, followed the NFTs on return and was paid to the owner personally (part of the 9,683 raw post-return income, excluded from pool income) | correctly left as skipped |
| `permanently-closed` | PASS | — |
| `closed-pool-admission-rejected` | **FAIL — harness false negative** (T-1) | diagnostic decoded `CanaryClosed` |
| `closed-pool-harvest-rejected`, `final-owner-3204/12485`, final receipt claims, `actual-BEM-transfers-match…`, `independent-final-payout-reconciliation`, post-return observations, `no-unrelated-assets-or-collection-wide-approvals` | not reached | continuation (13 checks PASS) and read-only final audit (24 checks, all PASS except `businessAssertionsPassed`, correctly false); `closed-harvest-structured-revert` decoded `CanaryClosed` |
| post-finalization `verifyAllocation` of the artifact after delivery | not reached | **not repeated on mainnet** (pre-finalization `complete-allocation-verified` passed; `allocation-artifact.json` exists). A minor evidence gap; `FINALIZED_AND_MATCHES` after delivery is covered on the local and fork e2e runs only. |

Classification: two **harness false negatives**; **no authorization bypass** (every guard was confirmed
from revert bytes); one **skipped** step (pre-shutdown harvest, honestly recorded); the rest covered by
**later supplementary** transactions and read-only audits that reused the frozen runner, caps and ABI.
Recovery and continuation did not relabel the original automation status.

---

## 6. Release blockers and non-blocking limitations

**Practical blockers before a production launch (none requires changing `src/`):**

1. Apply and rehearse T-1/T-2 (`proposed-patches/0001`) before any further live canary; without it the
   next run on a structured-data RPC aborts the same way.
2. Add the allocation tooling preflights and transparency (T-3/T-4, `proposed-patches/0002`), and decide
   whether retained receipts are allowed; if not, make it a readiness gap.
3. Record P-1 (and P-2) as accepted risks with an operational playbook (status monitoring of registered
   miners, `protocol-check` before each admission round, `depositMiners` only), since the pool offers no
   recovery by design.
4. The repository states "not audited"; this is an internal review, not an independent audit. An external
   audit remains advisable before contributor funds depend on it.

**Non-blocking limitations:** registry-size gas growth (documented, ~590 miners); beacon-upgradeable miner
collection (E-5); `registerMiners` window (documented); mock-only failure injection for non-REVOKED old-miner
faults; UNVERIFIED Mining restart/revocation semantics (E-3/E-4); fork evidence depends on a public archive
endpoint; Slither not re-run; post-delivery allocation verification not repeated on mainnet (5.3).

---

## 7. Conclusion

- **Functional completeness:** complete for the specified business model. All four components, the
  five-step admission boundary, holder-only per-ID claims, independent A/B roles with migration, the
  distributor's immutable allocation and cursor delivery, and the gas-bounded operator tooling are implemented
  and behave as documented.
- **Test evidence:** strong and reproducible. The author's suites were re-run from a clean install
  (107/107, 36/36, local e2e PASS, fork 11/11 at the recorded block with byte-identical observations), and
  this review's independent model agreed with the contracts in 401 random interleavings and all targeted
  scenarios. The live canary's journal and the chain state reconcile exactly with the report.
- **Security confidence:** high for the production contracts within the stated trust model: no defect that
  loses, duplicates or misdirects funds, no authorization bypass, no accounting rewrite path. Confidence is
  bounded by the unverified Mining lifecycle assumptions (E-3/E-4), the beacon-upgradeable collection (E-5),
  and the absence of an external audit.
- **Operational readiness:** not yet. The canary automation is diagnosed but not fixed (T-1/T-2), two
  allocation-tooling gaps remain (T-3/T-4), and the availability limitation P-1 should be an explicit,
  signed-off acceptance with monitoring rather than an implicit one.

---

## Appendix A — Regression tests added by this review (`test/audit/`)

| File | What it covers | Run |
| --- | --- | --- |
| `model.py` | Independent reference model (spec-derived; exact integer + rational) | via ffi |
| `AuditDifferential.t.sol` | Differential fuzz of nine operation kinds vs the model, 400 runs, 34 compared quantities + reconciliation | `forge test --match-path 'test/audit/AuditDifferential.t.sol' --ffi` |
| `AuditClaimOrder.t.sol` | Claim/release timing irrelevance to others; role migration pays unreleased income to the new address only | `forge test --match-path 'test/audit/AuditClaimOrder.t.sol'` |
| `AuditReceiptEdges.t.sol` | Zero-value transfers, duplicate rows, self-transfer, operator exclusion, hook claim during delivery, reentrant delivery refused | same pattern |
| `AuditAdmissionLiveness.t.sol` | P-1 and P-2 behaviour (mock-only status injection), gas figures | same pattern |
| `AuditDistributorCursor.t.sol` | Cursor through independent transactions with planned bounds: partial range, receiver refusal, retry, completion; last ID after 60 completed ranges by a third party (105,847 gas within the 237,000 bound) | `--isolate` via inline config |
| `revert-matcher.ts` / `revert-matcher.test.ts` | T-1 reproduction on seven RPC shapes + real Anvil; proposed classifier | `node --import tsx --test test/audit/revert-matcher.test.ts` |
| `verify-supply-gap.test.ts` | T-3 documentation | `node --import tsx --test test/audit/verify-supply-gap.test.ts` |

Whole suite: `forge test --match-path 'test/audit/*' --ffi -vv` (10/10) plus the two SDK tests (9/9, 1/1).

## Appendix B — Proposed patches (`proposed-patches/`, not applied)

See `proposed-patches/README.md`. 0001: canary structured revert matcher (T-1/T-2). 0002: `verify-allocation`
supply/retained reporting and `finalize-allocation` preflight (T-3/T-4).

## Appendix C — Reproduction

```bash
npm ci --ignore-scripts && forge build && forge test
```

```bash
npm run test:sdk && npm run typecheck && node scripts/canary/build-source.mjs --check && npm run test:local-e2e
```

```bash
FORK_RPC_URL=https://bsc-mainnet.public.blastapi.io FORK_BLOCK=128713128 FORK_NAND_MINER=12733 FORK_LATCH_MINER=13948 FORK_INACTIVE_TOKEN=648 FORK_SCALE_MINERS=4183,1574,6940,4307,4655,3207,13617,7924,11127,4951,3932,10031,14559,16112,8714,2161,6767,11214,6453,14011,16944,15731,7541,5930 npm run test:fork
```

```bash
forge test --match-path 'test/audit/*' --ffi -vv
```

```bash
node --import tsx --test test/audit/revert-matcher.test.ts test/audit/verify-supply-gap.test.ts
```

The fork runner rewrites `reports/fork-*.json`; restore them with `git checkout -- reports/` afterwards if
the committed evidence must stay untouched.
