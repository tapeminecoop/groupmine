# Internal fee-split review — Groupmine 2.1.0 candidate `8cf31dc` (Fable 5.1 follow-up)

Review date: 2026-10-21. Owner-authorized, first-party, pre-release implementation review of
`TapeoutMinerPool/2.1.0` (package `2.1.0-rc.1`). The previous review of `f2c8e50`
(`docs/INTERNAL_SECURITY_REVIEW_f2c8e50.md`) is **not** carried forward as proof: the candidate was re-read
from source and re-executed; the earlier findings are revalidated separately in section 8.

- **Primary target:** `8cf31dc97e8f6c88bfdf9a983089bceda8baadcb` (= `origin/main` at review time; nothing newer
  exists on `main`, so there is no later SHA to report separately).
- **Immediate baseline:** `c3cb93375737de7ec63baa9f390edd0c15a5c7a4` (remediated 2.0.0, 102-part accounting).
- **Earlier revisions:** `f2c8e50` (first reviewed candidate), `b846c0c` (previous Fable review commit).
- **Review-only additions (uncommitted, in the worktree branch `claude/fee-split-review-8cf31dc`):**
  `test/audit2/` (7 Foundry files, 1 TypeScript test), `docs/INTERNAL_FEE_SPLIT_REVIEW_8cf31dc_FABLE.md`
  (this file), `reports/internal-review-8cf31dc/` (fresh logs, `results.json`),
  `proposed-patches/0003-*`, `0004-*` and a README addition. Nothing under `src/`, `sdk/`, `cli/`,
  `scripts/`, `test/{unit,invariant,fork,sdk,remediation,helpers,audit}` or any historical report was
  modified. The candidate's `test/audit/` (the previous review's suite as the implementer adapted it) was
  left untouched and re-run as is.
- **Boundaries kept:** nothing signed or broadcast; no `.env` or key read; `canary:live`, `canary:recover`,
  `canary:prepare`, `canary:fork` and `canary:verify-local` never run; public RPC used read-only (fork source
  and two `cast` reads); all transactions on local Anvil/Foundry forks with ephemeral identities.

Evidence statuses used below: **VERIFIED_BY_EXECUTION** (run here, fresh), **SOURCE_CONFIRMED** (established
by reading the code), **HISTORICAL** (author-recorded, not re-run), **NOT_EXECUTED**, **NOT_REPRODUCED**,
**EXTERNAL_DEPENDENCY**, **ACCEPTED_POLICY** (documented as pending the owner's acceptance).

---

## 中文执行摘要

- **范围**：对 2.1.0 候选 `8cf31dc`（主网 `main` 当前提交）相对于基线 `c3cb933` 的变更做了独立实现级复审：逐行阅读生产 diff、变更报告、实现者对上一轮审计参考模型的修改；以独立算术重新推导 84 份额拆分、残差上界与守恒关系；新增 `test/audit2/` 共 30 个 Foundry 测试和 1 个 SDK 测试覆盖六组风险；在干净安装、干净构建上重跑作者全部本地套件；在记录区块 128,713,128 复跑 17 个真实协议 fork 测试（含真实 BEM 的 sink 测试，观测文件与记录逐字节一致）；在 scratch 目录重建基线 `c3cb933` 做字节码对比；只读核对 BEM 在最新区块的代码与状态。
- **生产合约结论**：**未发现可确认的账务、授权或可用性缺陷**。`_release` 单次快照、`_payWithSink` 先改计数后转账、三方余额精确校验、任一转账失败整体回滚、C 由 `floor(2T/84)` 独立计算且只在 release 时支付、A/B 不可指向 sink、sink 无 setter——均经执行证实。仅有两项信息级事项：变更报告的入口表写 `claim/claimBatch` "不累计 C"，但它们调用 `_sync` 可识别已持有的 BEM，因而会累计 C（不支付）——纯文档不一致（P2-1，已附补丁）；以及只有在代币于转账时回调的情况下才可观察到的只读视图瞬时高估（P2-2，真实 BEM 不可达）。
- **工具链**：`accrual()/reconciliation()` 选择子不变但中间插入字段，旧 2.0.0 解码器会静默错位读取（已用测试演示）；CLI 的写命令与 `verify-deployment` 做运行时模板校验，但 `inspect/reconcile` 等读命令不校验 `VERSION`（T2-1，低危，附补丁建议）。Slither 本机未安装，79 条记录条目按源码分诊，两条新增 `outflow == 0` 为无影响的提前返回（NOT_EXECUTED）。
- **金丝雀**：canary-2 为本地候选；已批准的 canary-1 路径（`fingerprint()` 钉住 `c4bc022`）对 2.1.0 源码树抛错，因此历史主网批准不构成 2.1.0 的部署授权；历史主网结果保持 `PARTIAL_AUTOMATION_FAILED_RECOVERY_AND_ACCOUNTING_PASS` 不变；结构化 revert 校验器满足"错误选择子/错误参数/缺数据/传输错误不得判为通过"。
- **外部依赖**：BEM 为 2,205 字节非代理 ERC-20，无 burn/owner/pause 入口，`MAX_SUPPLY` 2,100 万 BEM；向 `0x…dEaD` 的转账为普通转账，`totalSupply` 不变（fork 观测），无人已知控制该地址；sink 不释放铸造上限空间。
- **结论**：本次复审未发现应阻止专业审计或后续部署的已证实问题；2.1.0 仅有本地/fork 证据，未经主网验证，也未经外部审计。不构成部署授权。

---

## 1. Candidate, baselines and fingerprints

### 1.1 Change boundary (parent `c3cb933` → candidate `8cf31dc`), SOURCE_CONFIRMED

One commit, 115 files, 16,428 insertions / 396 deletions. Outside `reports/` and `docs/` the change is:

| Area | Files | What changed |
| --- | --- | --- |
| Production | `src/PoolMath.sol`, `src/TapeoutMinerPool.sol` | constants 84/80/1/2 and `SINK_PARTS`; `Accrual.sink` (inserted after `recipientB`); residue subtracts C; `SINK` constant, `sinkPaid` storage (after `recipientBPaid`), `SinkPaid` event, `sinkClaimable()`, `Reconciliation.sinkAccrued/sinkPaid` (after `recipientBPaid`); constructor and `setRecipient` refuse `SINK`; `_release` takes one accrual snapshot and calls the new private `_payWithSink`; `VERSION` 2.1.0 |
| Unchanged production | `src/TapeoutEntitlementReceipt.sol`, `src/TapeoutReceiptDistributor.sol`, `src/interfaces/IMining.sol` | source sha256 unchanged since `f2c8e50` (`f5657c28…`, `67f0b24f…`, `c8d8c41b…`) |
| Canary | `src/canary/RecoverableTapeoutMinerPool.sol` (regenerated, `canary-2-local`), `scripts/canary/build-source.mjs` (pins the 2.1.0 production hash, writes to `reports/canary-local/`), `scripts/canary/workflow.ts` (84-part arithmetic, `SinkPaid` checks) | `CanaryParticipant.sol` unchanged |
| SDK / scripts | `sdk/math.ts`, `sdk/pool.ts`, `sdk/config.ts`, `sdk/gas.ts`, `sdk/abi.ts`, `sdk/bytecode.json`, `scripts/{local-e2e,fork-e2e,fork-safe-e2e,fork-test,verify-all}.ts` | mirror constants and `SINK`; reconciliation with C and `outerPartsFromTotal`; system file refuses the sink as A/B; release bound 300k, pool deploy 7M; regenerated ABI/bytecode; 105-BEM fixtures and sink checks |
| Tests | `test/unit/PoolFeeSplit.t.sol` (new, 19), fixtures in 10 suites, `test/helpers/Mocks.sol` (blocked destinations, transfer hook), `test/invariant` (sink payee, release model), `test/fork/PoolFork.t.sol` (real-BEM sink test), `test/audit/*` (the previous review's model and tests adapted) | – |
| Config | `package.json`/`package-lock.json` version only; `.gitignore` keeps the run logs | – |

Source hashes of the candidate's `src/` (sha256): pool `6a2d0c34…5e6d`, PoolMath `c7ab82e4…19e7`, receipt
`f5657c28…4910`, distributor `67f0b24f…8659`, IMining `c8d8c41b…bf12`, canary pool `ec75b303…d960`,
helper `5a7bcd82…7aa`.

### 1.2 Build identity, VERIFIED_BY_EXECUTION

Fresh clean build (forge 1.4.3-stable `fa9f934`, solc 0.8.24, Paris, via-IR, 200 runs; node v20.19.5; viem
2.57.2; OpenZeppelin 5.4.0; `npm ci --ignore-scripts`, 0 vulnerabilities; the only dependency with an install
hook, `esbuild`, was skipped by `--ignore-scripts`):

| Contract | Runtime / initcode (bytes) | Runtime template keccak (immutables unfilled) | `sdk/bytecode.json` |
| --- | ---: | --- | --- |
| `TapeoutEntitlementReceipt` | 8,743 / 10,361 | `0x7f59d20c…ec8f` (unchanged since 2.0.0; no immutables, so this is also the deployed hash) | initcode, template and refs equal |
| `TapeoutReceiptDistributor` | 7,680 / 8,289 | `0x67fa9b8c…60c9` (2.0.0: `0xcf370db1…0ada`) | equal (11 immutable slots) |
| `TapeoutMinerPool` | 20,777 / 32,685 | `0x9bb8f411…0468` (2.0.0: `0x5655ce42…2c26`) | equal (59 immutable slots) |
| `RecoverableTapeoutMinerPool` | 22,074 / 34,074 | `0x17114aac…6dd1` | (not in the SDK bundle) |
| `CanaryParticipant` | 3,410 / 3,838 | `0x6a6c989d…b94b` | – |

These equal the recorded post-change identity (`reports/fee-split-20261021-c3cb933/run/contract-identity.json`).
A scratch build of `git archive c3cb933` with the same toolchain reproduced the recorded **before** identity
exactly (receipt `0x7f59…`, distributor `0xcf37…`, pool `0x5655…`, helper `0xd32e…`). Comparing runtimes with
the trailing CBOR metadata stripped: receipt identical; distributor and helper identical in code (7,627 B and
3,357 B) and different only in metadata; pool changed (19,060 → 20,724 B of code). This independently confirms
the change report's claim that the distributor and helper differ only because they embed the pool's source
hash. The pool stays 3,799 B under EIP-170.

### 1.3 The implementer's edits to the previous review's model, SOURCE_CONFIRMED

`test/audit/model.py` (my reference model at `b846c0c`) was edited for 2.1.0: `TOTAL_PARTS = 84`,
`PARTICIPANT_PARTS = 80`, `SINK_PARTS = 2`, `C(T) = T*2//84`, `op_L` pays `C(T) − sinkPaid` to a ninth actor
(the sink) at the same total as the role, the residue subtracts `C(T)` and its bound became `4 + …`, and the
output layout gained C's accrual and paid words. I re-derived these equations from the specification (section
3) and they are the intended semantics, so the adapted model is a faithful oracle for 2.1.0. Because it was
no longer written independently of the implementer, this review added a **second** oracle written from
scratch in Solidity (`test/audit2/FeeSplitLedger.t.sol`) and an exhaustive boundary check on the live pool;
the adapted differential fuzz was also re-run (401 runs, PASS).

---

## 2. What was executed (fresh), with outcomes

Logs: `reports/internal-review-8cf31dc/`; summary: `results.json` there.

| # | Command | Result |
| --- | --- | --- |
| 1 | `npm ci --ignore-scripts && forge clean && forge build && forge test` | **151 passed, 0 failed** of the non-ffi tests (156 total: 4 fork tests skipped without RPC; the `--ffi` differential test fails without the flag and passed in run 7). The author's "142 Solidity tests" = 156 − 4 fork − 10 `test/audit`. Invariant campaigns 256 × 64 with the sink as a payee ran green. |
| 2 | `npm run test:sdk` | **55/55** |
| 3 | `npm run typecheck` | clean |
| 4 | `node --import tsx --test test/sdk/canary-revert.test.ts test/audit/revert-matcher.test.ts test/audit/verify-supply-gap.test.ts` | **16/16** |
| 5 | `forge test --match-path 'test/audit2/*' -vv` (this review) | **30/30** (after three corrections to the review's own tests, section 2.1) |
| 6 | `FORK_RPC_URL=https://bsc-mainnet.public.blastapi.io FORK_BLOCK=128713128 FORK_NAND_MINER=12733 FORK_LATCH_MINER=13948 FORK_INACTIVE_TOKEN=648 FORK_SCALE_MINERS=… npm run test:fork` | **17/17 PASS**, block `128,713,128`, hash `0x760f050b7ec66ced2a2745918d7492650150f9d71d3159259412996ebe65081f`. Every observation file this run wrote is **byte-identical** to the recorded run's, including `fork-sink.json`. The tracked historical files were restored afterwards. |
| 7 | `forge test --match-path 'test/audit/*' --ffi` | **10/10**, differential fuzz **401 runs** against the adapted `model.py` |
| 8 | `forge test --match-contract GasModelTest -vv` | **11/11**; `releaseA`/`releaseB` first payments 197,583 / 132,955; either order 206,731 → 154,155 and 205,455 → 155,431 (bound 300,000); pool deployment 5,670,339 (bound 7,000,000) |
| 9 | `npm run test:local-e2e` | **PASS**, 64 steps, every check true (incl. `releasePaidRolesAndSinkTheirCumulativeWeights`, `repeatedReleasePaysNothingMore`) |
| 10 | `node --import tsx --test test/audit2/fee-split-consumers.test.ts` | **3/3** |
| 11 | scratch build of `c3cb933` + metadata-stripped comparison | section 1.2 |
| 12 | `node scripts/canary/build-source.mjs --check`; `fingerprint()` from `scripts/canary/common.ts` | generator check PASS against production sha256 `6a2d0c34…5e6d`; recorded `reports/canary-local/production-canary.diff` equals a regenerated diff apart from the two timestamp header lines; `fingerprint()` **throws** `Source HEAD differs from reviewed baseline` on the 2.1.0 tree (no env, key or RPC involved) |
| 13 | `cast` reads at head `128,926,659` | BEM code 2,205 B, keccak `0x982ba795…b344`, unchanged since the pinned block; ERC-1967 slots zero; `totalSupply` 40,125,958,035,713 raw; `balanceOf(0x…dEaD)` 244,793,334,435 raw; `MAX_SUPPLY()` 2,100,000,000,000,000 raw; `owner()` and `paused()` do not exist; PUSH4 scan: `transfer`, `transferFrom`, `approve`, `balanceOf`, `totalSupply`, `mint`, `allowance`, `name/symbol/decimals`, `MAX_SUPPLY`, no `burn`/`burnFrom`, nine unidentified selectors |

**NOT_EXECUTED by this review (author-recorded only):** `npm run test:fork-e2e` (23 checks), `npm run
test:fork-safe-e2e` (255 checks, 24 Safe transactions), the canary-2 local rehearsal
(`fork-local-candidate.ts`: 43 assertions complete, interrupted + standalone recovery), the largest-wallet
check, and Slither (not installed here).

### 2.1 Aborted and failed attempts (preserved in `03-audit2-fork-audit-gas-e2e.log` and in the conversation)

Three of this review's own tests failed on their first run, none because of the contracts:
1. `FeeSplitConsumers`: my stale-layout mapping was off by one field (the 2.0.0 `residue` position holds
   `latchReceiptsAccrued`, not `latchReceiptsPaid`), and a second assertion was an arithmetic underflow of my
   own. Corrected to the exact mapping and to "the 2.0.0 paid identity is false on the misread tuple".
2. `FeeSplitConsumers`: I asserted a strict inequality for `sinkClaimable` against reconciliation while the
   preceding claim had already synchronized the income; corrected by adding unrecognized income after the claim.
3. `FeeSplitLedger`: the final "only the residue remains" check assumed every receipt had been claimed after the
   last income; two receipts (carol's late-delivered NAND 9–10) had unclaimed income. Added a final claim round;
   all eleven intermediate reference checks had already passed.

Two compile errors (rational literals in assertions) were fixed as well. No assertion was weakened.

---

## 3. Independent derivation of the 2.1.0 accounting

Written from the specification in the brief and `docs/ACCOUNTING.md`, checked in Python (`fractions`,
exhaustive and random), in Solidity (`test/audit2/*`) and against `sdk/math.ts`
(`test/audit2/fee-split-consumers.test.ts`).

- **Parts.** `P(T) = ⌊80T/84⌋`, `A(T) = B(T) = ⌊T/84⌋`, `C(T) = ⌊2T/84⌋ = ⌊T/42⌋`. Each is a floor of `T`
  alone; `C − 2A ∈ {0, 1}` (1 exactly when `T mod 84 ≥ 42`), so `C ≠ 2·⌊T/84⌋` at `T = 42, 43, 83, 126, 1,050, …`.
  Participants are not a residual, and no quantity is `0.95·T` or a "5 % fee" (100/105 = 95.238…%).
- **Outer loss.** With `T = 84q + r`, `T − 2A − C − P = r − ⌊r/42⌋ − ⌊80r/84⌋`, a function of `r` only
  (checked for 100,000 random `T ≤ 10³⁰`). Exhaustively over `r = 0…83`: loss 0 once, 1 for 22 remainders, 2
  for 41, **3 for the 20 remainders 64…83**. Maximum 3, as the implementation states.
- **Residue bound.** Inner split: `P(T) − 1 ≤ nandIncome + latchIncome ≤ P(T)` at every `T` (the checkpoint
  sets `participantBase = nandIncome + latchIncome`, so the carried unit is at most one and is consumed in the
  next period); per-share floors lose at most `S − 1` per collection. Hence
  `residue ≤ 3 + 1 + max(S_N − 1, 0) + max(S_L − 1, 0)` = the implementation's `4 + …`. The bound is tight in
  its outer term (`T = 84,083` leaves 3 and C receives 2,001, verified on the live pool).
- **Conservation / solvency.** `T = A + B + C + S_N·perN + S_L·perL + residue` with `residue ≥ 0`
  (because `A + B + C + P ≤ T` and `S·per ≤ categoryIncome ≤ P`). Obligations `(A − A_paid) + (B − B_paid) +
  (C − C_paid) + (S_N·perN − nandPaid) + (S_L·perL − latchPaid) ≤ T − totalPaid = balance` once recognized.
  Each paid counter is set to the accrual it pays, so `X_paid ≤ X(T)` always and no bucket can overpay.
- **Monotonicity.** All four outer floors and both category incomes are non-decreasing in `T`; a checkpoint
  freezes the current incomes as bases, so nothing decreases at a boundary; `C` depends on `T` only, never on
  the composition (verified: 9:1 and 1:9 give the same C at the same `T`).
- **Path independence within a period.** Every quantity is a function of `T` and the frozen bases, so many
  tiny inflows with releases interleaved equal one inflow (verified with 120 and 300 inflows).
- **Release semantics.** `A_due = A(T) − A_paid` for the selected role only; `C_due = C(T) − C_paid` whichever
  role releases; after a release `C_paid = C(T)`, so a second release at the same `T` pays C nothing; A/B due
  zero does not suppress C (`T = 42`: `A = B = 0, C = 1`).
- **Lifetime fairness is not implied by the bounded residue.** Same-ratio checkpoints shift the carried unit
  (verified: `T = 45` then `T = 90` with two 3:1 miners gives NAND 64 / LATCH 21 instead of the single-period
  63 / 21). This is the documented policy (`docs/ACCOUNTING.md` §6, `RoundingPolicy.t.sol`), ACCEPTED_POLICY
  pending the owner, unchanged by 2.1.0.
- **Acceptance examples** (Python and Solidity): 1,050 BEM → 1,000 / 12.5 / 12.5 / 25; raw `T = 1,050` →
  `P 1,000, A = B = 12, C = 25`, outer residue 1; the table `T = 0, 1, 41, 42, 43, 63, 64, 83, 84, 85, 125,
  126` and `10¹⁸ + 7`; 1,050 BEM at 2:0 then a settled admission to 3:1 and another 1,050 BEM → NAND 1,750,
  LATCH 250, A = B = 25, C = 50.

---

## 4. Findings — production candidate (`src/PoolMath.sol`, `src/TapeoutMinerPool.sol`)

**No confirmed defect.** Nothing found that loses, duplicates, redirects or misorders BEM, bypasses an
authorization, or blocks receipt holders. The specific properties the brief lists were each exercised on the
real contracts (section 6). What follows are the only candidate-level items, both informational.

#### P2-1 · The change report's entry-point table says claims do not accrue C

- **Status / severity:** SOURCE_CONFIRMED and VERIFIED_BY_EXECUTION; Informational (documentation only).
- **Location:** `docs/FEE_SPLIT_CHANGE_REPORT.md` §3 table, row `claim, claimBatch | no | never`; code
  `src/TapeoutMinerPool.sol` `claim()`/`claimBatch()` call `_sync()` before pricing the claim.
- **Reproduction:** `FeeSplitBoundaryTest.testClaimsAccrueCByRecognizingHeldIncomeButNeverPayIt`: 84,000 raw
  reach the pool unrecognized; a holder's `claim` recognizes them (`totalAccounted` 0 → 84,000), so
  `accrual().sink` becomes 2,000 while `sinkPaid` and the sink's balance stay 0.
- **Impact:** none on funds: C's accrual is a function of `T`, and which entry point recognizes income first
  does not change any amount (path independence). "Does not transfer C" is correct; "does not accrue C" is
  not. `docs/ACCOUNTING.md` §3 is worded correctly.
- **Remediation:** `proposed-patches/0003-fee-split-change-report-claims-accrue-c.patch` (one table row).

#### P2-2 · Unguarded views over-read between the two transfers of a release (hooking token only)

- **Status / severity:** VERIFIED_BY_EXECUTION with the mock only; Informational.
- **Location:** `_payWithSink` writes `totalPaid += amount + sinkAmount` before the two transfers;
  `unrecognizedBalance()`, `previewAccrual()`, `claimable()`, `sinkClaimable()`, `recipientClaimable()` are
  `view` and not guarded.
- **Reproduction:** `FeeSplitCallbacksTest.testTransientViewOverReadBetweenTheTwoTransfersIsReadOnly`: a
  token that calls back during the role's transfer reads `unrecognizedBalance() = 2,000` (the sink amount not
  yet transferred) and `sinkClaimable() = 47` for a pool whose real outstanding C is 0; after the sink
  transfer both read 0, and after the release returns they read 0.
- **Reachability:** the bound BEM makes no calls during `transfer` (plain ERC-20, section 2 item 13), so no
  caller can observe this on BSC; every state-changing entry point is `nonReentrant` (verified for all nine,
  from both transfer legs) and the unguarded `setRecipient`/`activate`/`renounceOwnership` fail their own
  authorization when entered from a token hook (`msg.sender` is the token). No remediation proposed.

#### Accepted policy, confirmed as implemented (ACCEPTED_POLICY, documented)

- **Atomic coupling.** A sink-specific transfer failure blocks every release that owes C at least one unit, of
  A and B alike, and rolls back the role's transfer already made; claims, harvests, syncs and admissions
  continue and C keeps accruing (`FeeSplitAtomicTest`, six fault shapes incl. false return and silent no-op).
  The brief requests exactly this policy; `docs/ACCOUNTING.md` §3 and `ARCHITECTURE.md` §7 state it.
- **C is paid to an address nobody is known to control** by an ordinary transfer (E2-1).
- **Rounding / checkpoint policy** and **revoked-miner weight / admission liveness** (previous review P-1,
  P-2) are unchanged by 2.1.0 and remain DOCUMENTED / PENDING_ACCEPTANCE in `AUDIT_REMEDIATION_REPORT.md` §7.

#### Properties verified on the real contracts (NOT_REPRODUCED as defects)

Single snapshot per release; `recipientXPaid`, `sinkPaid` and `totalPaid` written before either transfer;
all three balance deltas exact or the whole release reverts (`UnexpectedTokenBehavior`, `SafeERC20FailedOperation`);
no external self-call (`_payWithSink` is private); `releaseA`/`releaseB` by any third party pay only the fixed
beneficiaries; the other role's history is never touched; C computed from `T`, not from the role amount;
C paid once per total; `T = 42` pays C 1 with roles 0; repeated releases pay nobody and still emit both
events with zero amounts; long inactivity of one role accumulates exactly `⌊T/84⌋` for it; A/B aliased to one
address and A moved to a receipt holder keep separate histories; no role can be set to the sink or the pool;
no sink setter exists; the owner cannot move a role; `sinkClaimable` includes unrecognized income; the
reconciliation covers all five paid and outstanding components and `outerPartsFromTotal` recomputes A, C and
the participant cap from `T`; zero-supply LATCH still splits C and A/B; `MAX_SUPPLY`-sized totals and
`10⁶⁰` keep conservation; C never receives the rounding surplus.

---

## 5. Findings — SDK, CLI and deployment integration

#### T2-1 · Changed tuple layouts with unchanged selectors; read commands do not check `VERSION`

- **Status / severity:** VERIFIED_BY_EXECUTION; Low (integration hazard, no on-chain effect).
- **Facts:** `accrual()`/`previewAccrual()` gained `sink` at index 3, `reconciliation()` gained
  `sinkAccrued`/`sinkPaid` at indices 9–10; selectors unchanged. `sdk/abi.ts` and `sdk/bytecode.json` equal
  the fresh build. `FeeSplitConsumersTest` shows a 2.0.0 decoder reading the 2.1.0 blob without error: its
  `participants` is C (25), its `nandIncome` is the participants' total, its `residue` is
  `latchReceiptsAccrued` (250 instead of 1); on the reconciliation the stale paid identity is false
  (37 ≠ 12 + 0 + 750 + 250). `fee-split-consumers.test.ts` shows the same with viem.
- **Mitigations present:** every CLI write and `verify-deployment` run `checkDeployment`, which compares
  deployed runtime with the 2.1.0 templates outside immutable slots, so a 2.0.0 pool is refused for writes.
  The canary runner pins saved artifacts per run and `assertIdentity` fails on a different pool runtime.
- **Gap:** the read commands (`inspect`, `reconcile`) and `readPoolSummary` read `VERSION` but do not act on
  it; pointed at a pool of the other version they would print misread numbers (and `reconcile` would FAIL on
  `outerPartsFromTotal`, which is a weak signal). Third-party dashboards built on the 2.0.0 ABI would misread
  silently. 2.1.0 requires a fresh deployment (no migration), so the only realistic exposure is a stale ABI in
  an external consumer or a mis-filled addresses file.
- **Remediation:** `proposed-patches/0004-sdk-version-guard-for-tuple-layout.patch` (`readPoolSummary`
  refuses a `VERSION` outside the 2.1.0-layout set); document the layout change for any external consumer.
  Not applied.

#### T2-2 · Static analysis NOT_EXECUTED here; recorded entries triaged by source

Slither 0.11.3 is not installed on this machine. The recorded `run/slither.json` holds 79 entries: 54
`calls-loop`, 11 `reentrancy-no-eth`, 6 `uninitialized-local`, 4 `incorrect-equality`, 3 `reentrancy-benign`,
1 `immutable-states`. The two entries added by 2.1.0 are `incorrect-equality` on `_payWithSink`'s
`outflow == 0` (production and its canary copy). `outflow` is the sum of two ledger differences, not a token
balance; equality only skips a release with nothing to pay (both events are still emitted with zero). No
impact; the canary copy is a mirror, not a second production finding.

#### Deployment and configuration (SOURCE_CONFIRMED, exercised by the author's e2e runs)

`sdk/config.ts` refuses a system file with A or B at the sink (constructor refuses it too);
`sdk/gas.ts` bounds release at 300,000 and pool deployment at 7,000,000 (measured 206,731 and 5,670,339 here);
release plans name the sink; `sdk/deployment.ts` compares runtime templates with immutables masked and reads
bindings; `script/DeployPool.s.sol`'s constructor arguments are unchanged.

---

## 6. Requirement coverage matrix

| Requirement (brief) | Candidate evidence (author) | This review's test | Execution status | Gap |
| --- | --- | --- | --- | --- |
| 80:1:1:2 of 84, each part its own floor; not 95/5, not residual, not `2·⌊T/84⌋` | R1, WC, `PoolFeeSplit` table, SDK math | `FeeSplitBoundary.testEveryOuterRemainderOnTheLivePool` (252 totals), Python exhaustive, SDK test 2,252 totals | VERIFIED_BY_EXECUTION | – |
| NAND/LATCH by composition periods, earlier rights not repriced | R2, WB | `FeeSplitLedger` (two periods), `FeeSplitBoundary.testSameRatioCheckpointKeepsTheDocumentedPolicy`, `testCDoesNotDependOnTheComposition` | VERIFIED_BY_EXECUTION | lifetime fairness remains ACCEPTED_POLICY |
| Residue bound `4 + max(S_N−1,0) + max(S_L−1,0)`, derived independently | R8 | section 3; bound asserted on every step of `FeeSplitLedger` and in all 30 tests via `assertReconciled` | VERIFIED | – |
| Pre-composition BEM unrecognized | existing tests | reused `test/audit` model (unchanged rule) | VERIFIED_BY_EXECUTION (401 runs) | – |
| C constant `0x…dEaD`, no setter/receipt/migration/admin; A/B never initialized or migrated to it; A = B allowed | R3, V4 | `FeeSplitCallbacks.testRoleAliasesHolderOverlapAndSinkRedirectionProhibited` | VERIFIED_BY_EXECUTION | – |
| Releases permissionless, fixed beneficiaries, one snapshot, role due + all of C, other role untouched, return value = role, `SinkPaid`/`sinkPaid`/`sinkClaimable` | R5, V2, V3 | `FeeSplitOrdering` (A/B/A, B/A/B, third-party callers, events with exact args) | VERIFIED_BY_EXECUTION | – |
| Both transfers atomic; counters reflect the whole outflow; exact deltas; any failure rolls back; no self-calls | R7, V5 | `FeeSplitAtomic` (6 fault shapes) | VERIFIED_BY_EXECUTION (mock faults; unreachable with the bound BEM) | – |
| `T = 42` pays C 1 with A = B = 0; no double pay; C from `T` | R6 | `testAtFortyTwoRawUnitsRolesAreDueZeroAndCIsOne`, `testOneRoleFullyPaidWhileCIsStillDue` | VERIFIED_BY_EXECUTION | – |
| Claims/harvest/sync/admission never transfer C; may accrue it; sink failure blocks releases only | R9, V6 | `FeeSplitAtomic.testSinkOnlyRejection…`, `FeeSplitBoundary.testClaimsAccrueC…` | VERIFIED_BY_EXECUTION | P2-1 wording |
| Ordinary transfer, not a burn; actual BEM behaviour at the recorded block | R4, V10, `fork-sink.json` | fork rerun 17/17 with identical `fork-sink.json`; `cast` at head | VERIFIED_BY_EXECUTION | E2-1 trust assumptions |
| Worked examples A, B, raw-unit boundaries, large values | WA, WB, WC | section 3; `testLargeSupportedTotals` (`MAX_SUPPLY`, `10⁶⁰`) | VERIFIED | – |
| Old/new tuple decoding, ABI, SDK readers, reconciliation components, release plans/gas, Safe | V8, V11, SDK tests | `FeeSplitConsumers`, `fee-split-consumers.test.ts`, `FeeSplitGas` (isolated: 223,807/151,631 and 222,531/152,907 with a 10,000-BEM sync; 106,538 with role due 0; 135,807/115,831 aliased) | VERIFIED_BY_EXECUTION except Safe (HISTORICAL: 255 checks) | T2-1; fork-e2e/Safe NOT_EXECUTED here |
| Cross-entry-point reentry and permissions | V5 | `FeeSplitCallbacks` (9 guarded + 3 unguarded entry points from both legs) | VERIFIED_BY_EXECUTION | P2-2 (informational) |
| Five-ledger sequences with an independent reference | V1, V8, V9, `test/audit` model | `FeeSplitLedger` (12 checkpoints, reference written here) + adapted differential fuzz | VERIFIED_BY_EXECUTION | – |

---

## 7. Findings — canary-only behaviour and harness

#### C2-1 · Isolation and the approved path (VERIFIED_BY_EXECUTION)

- `src/canary/RecoverableTapeoutMinerPool.sol` is the exhaustive adaptation of the 2.1.0 production source
  (`build-source.mjs --check` passes against sha256 `6a2d0c34…`); its `_release`/`_payWithSink` are the
  production code verbatim; the recovery additions (`recoveryController`, `closed`, `returned`, `shutdown`,
  `emergencyReturn`, ID allow-list 3204/12485) are unchanged from canary-1 and still make no Mining or BEM
  call (`test/sdk/canary.test.ts`, `CanaryRecoveryTest` 12/12 re-run). `VERSION` is
  `RecoverableTapeoutMinerPool/canary-2-local`.
- The approved-candidate guard `fingerprint()` (pinned to `c4bc022`) **throws on the 2.1.0 tree**; it is called
  by `prepare.ts`, `fork.ts`, `live-runner.ts`, `verify-local.ts` and `fork-local-candidate.ts`. The approval
  record `reports/canary/approvals/canary-588196bf-….json` names candidate digest `a4003a06…` (canary-1).
  Therefore the historical approval cannot authorize a 2.1.0 broadcast. `reports/canary/` (canary-1, incl.
  `production-canary.diff`) is byte-identical to `c3cb933` (`historical-unchanged.json`), and the mainnet
  outcome stays `PARTIAL_AUTOMATION_FAILED_RECOVERY_AND_ACCOUNTING_PASS`.
- The canary-2 rehearsal evidence (`run/canary-fork/summary.json`: block `128,812,145`, complete run 43 PASS
  with four negative tests `EXPECTED_REVERT`, interrupted run + standalone recovery, `closed: true`, no
  errors) is HISTORICAL for this review; the generator and the workflow arithmetic (84 parts, `SinkPaid`
  checks, residue ≤ 8 for 4 + 2 receipts) were read and are consistent with the production rule.

#### C2-2 · Structured revert verifier (previous T-1/T-2), revalidated

`scripts/canary/revert-verifier.ts` passes a negative test only when structured JSON-RPC error data (at any of
the documented nestings, along the cause chain) ABI-decodes to the expected error **and** arguments and
re-encodes canonically; wrong error, wrong arguments, a misleading `Error(string)` and an unexpected success
are FAIL and never retried; missing, empty, malformed, ambiguous data and transport failures are UNVERIFIED
with bounded retries; message text and request bodies are never evidence. `test/sdk/canary-revert.test.ts`
(re-run, 16/16 with my earlier shape test) covers each of these, including a real Anvil node. This is stricter
than the matcher I had proposed (which kept a text fallback); the remediation note that my fallback was not
adopted is correct and the stricter choice is the right one.

---

## 8. Prior-review findings revalidated against the current tools

| Prior ID | Current status (from `AUDIT_REMEDIATION_REPORT.md`) | Kind | Re-checked here |
| --- | --- | --- | --- |
| T-1 (text-matched negative tests) | FIXED | source fix in canary tooling | C2-2; 16/16 tests re-run |
| T-2 (harness failure = business failure) | FIXED | tooling | verdict classification read; rehearsal HISTORICAL |
| T-3 (inventory vs supply) | FIXED | tooling | `verify-supply-gap.test.ts` (updated by the remediation) passes |
| T-4 (`finalize-allocation` preflight) | FIXED (operator guard) | tooling | source read; local e2e PASS |
| T-5 (artifact vs reviewed JSON) | FIXED (new artifacts) | tooling | source read; `verify.test.ts` in 55/55 |
| T-6 (Slither not re-run) | executed by the remediation | – | NOT_EXECUTED here (T2-2) |
| P-1 (admission liveness) | DOCUMENTED / PENDING_ACCEPTANCE | accepted policy | `AuditAdmissionLiveness` re-run green on 2.1.0 (fixtures scaled) |
| P-2 (revoked weight and gas) | DOCUMENTED / PENDING_ACCEPTANCE | accepted policy | same |
| P-3 (permanent custody, unreachable beneficiaries) | MITIGATED_IN_TOOLING; PENDING_ACCEPTANCE | tooling mitigation | source read |
| P-4 (zero-value ERC-1155 transfers) | not a defect | – | `AuditReceiptEdges` re-run green |
| P-5 (template hashes described as deployed hashes) | FIXED | source fix (`sdk/deployment.ts`) + docs | `verify-deployment` reads; 2.1.0 identity recorded with templates |
| E-3/E-4 (Mining lifecycle) | VERIFIED from deployed bytecode + fork transitions | external dependency | `MiningTransitions` 5/5 in the fork rerun; `MINING_LIFECYCLE.md` read; not re-derived |
| E-5 (collection beacon) | DOCUMENTED / PENDING_ACCEPTANCE | external dependency | `fork-identity.json` identical |

None of these changed character in 2.1.0; the fee split does not touch admissions, receipts or the distributor.

---

## 9. External dependencies and trust assumptions

- **E2-1 · BEM (EXTERNAL_DEPENDENCY).** At blocks 128,713,128 and 128,926,659 BEM is a 2,205-byte non-proxy
  contract (`0x982ba795…b344`) with `mint` (used by Mining), no `burn`, no `owner`, no `paused`, and a hard
  `MAX_SUPPLY` of 21,000,000 BEM. On the fork a release transferred C to `0x…dEaD` with one `Transfer(pool →
  sink)` and `totalSupply` unchanged (39,451,273,037,263 before and after); the sink's balance grew by exactly
  504,669,094 raw across the run's releases; a harvest raised `totalSupply` by the 28,736,663 raw Mining minted.
  Trust assumptions the design relies on: BEM stays a plain ERC-20 (no fee, rebase, forced debit, block list
  or callback); nobody controls `0x…dEaD` (conventional, not provable); BEM keeps counting sink balances in
  `totalSupply`, so the sink neither burns nor frees cap space, and when `totalSupply` reaches `MAX_SUPPLY`
  Mining pays nothing more (per `MINING_LIFECYCLE.md` §5) regardless of what sits at the sink. The address's
  balance rose by about 366 million raw between the two blocks from other senders. Nine BEM selectors were not
  identified; the token's full semantics were not analysed beyond the listed behaviour.
- **E2-2 · Mining** — unchanged dependency; lifecycle VERIFIED by the remediation from the deployed bytecode
  (implementation `0xa3DB…f898`, owner renounced); the fee split does not change how the pool calls it.
- **E2-3 · Miner collection beacon** — upgradeable by its owner contract; `protocol-check` at the release block.
- **E2-4 · Archive RPC** — fork evidence depends on `bsc-mainnet.public.blastapi.io`; Foundry's RPC cache for
  the pinned block existed from earlier runs, so part of the state may have been served locally (results are
  keyed by block and matched the recorded run byte for byte).

---

## 10. Conclusion

- **Demonstrated issues that should block a professional audit or later deployment:** none. The two
  production-level observations are documentation (P2-1) and a read-only transient unreachable with the bound
  token (P2-2); the tooling item (T2-1) is a Low integration hazard with a one-line guard proposed.
- **What this review establishes:** the 80:1:1:2-of-84 rule is implemented exactly as specified, with
  independent floors, bounded residue (`4 + …`, derived here), conservation, monotonicity, path independence
  and non-overpayment holding under random interleavings, exhaustive remainders, fault injection, reentry
  attempts and real-BEM fork execution; C is settled atomically with every release and only there; the sink is
  fixed and unreachable as a role; the receipt and distributor code is unchanged (byte-level, metadata aside);
  the canary-2 candidate is local-only and the historical mainnet approval cannot authorize it.
- **What it does not establish:** mainnet behaviour of 2.1.0 (local and fork evidence only; the only mainnet
  deployment ever made was canary-1 under 102-part accounting), the Safe and fork-e2e flows (author-recorded
  here), Slither on the final tree, BEM's behaviour under code it does not have at the pinned block, and
  absolute safety. Audit success is not a deployment authorization; the owner-acceptance gates of
  `AUDIT_REMEDIATION_REPORT.md` §7 and an independent external audit remain open.

---

## Appendix A — Review-only tests (`test/audit2/`)

| File | Risk group | Tests |
| --- | --- | --- |
| `FeeSplitOrdering.t.sol` | 1 | T = 42; A/B/A; B/A/B; repeated releases without income; 40-round inactivity of B; role fully paid while C due; 300 unit inflows interleaved |
| `FeeSplitAtomic.t.sol` | 2 | role transfer revert; sink revert after the role leg; false return on either leg (`vm.mockCall`); silent no-op on either leg; fee-on-transfer; sink-only rejection vs claims/harvest/admission/sync (full-state snapshots) |
| `FeeSplitCallbacks.t.sol` | 3 | reentry into 9 guarded entry points from both legs; unguarded `setRecipient`/`activate`/`renounceOwnership`; view transient; A = B alias, A → receipt holder, sink redirection prohibited |
| `FeeSplitLedger.t.sol` | 4 | twelve-step five-ledger sequence against a reference written from the spec |
| `FeeSplitBoundary.t.sol` | 5 | every `T mod 84` at three magnitudes on the live pool; zero/minimum income; zero-supply LATCH; same-ratio checkpoint policy; C independent of composition; `MAX_SUPPLY` and `10⁶⁰`; claims accrue C |
| `FeeSplitConsumers.t.sol` | 6 | stale 2.0.0 decoding of `accrual()` and `reconciliation()`; reconciliation components |
| `FeeSplitGas.t.sol` (isolated) | 6 | first payments into empty sink/roles in both orders; role due 0 with C due; aliased roles |
| `fee-split-consumers.test.ts` | 6 | SDK math vs independent bigint spec (2,252 totals + 2,000 random with checkpoints); viem stale decoding; reconciliation negative cases; release plan bound |

Run: `forge test --match-path 'test/audit2/*' -vv` and `node --import tsx --test test/audit2/fee-split-consumers.test.ts`.
Fuzz settings in force: `fuzz.runs = 512`, `invariant.runs = 256`, `invariant.depth = 64` (`foundry.toml`);
the adapted differential test runs 400 seeds (`forge-config` inline).

## Appendix B — Proposed patches (not applied)

`proposed-patches/0003-fee-split-change-report-claims-accrue-c.patch` (P2-1) and
`proposed-patches/0004-sdk-version-guard-for-tuple-layout.patch` (T2-1); see `proposed-patches/README.md`.
