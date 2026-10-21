# Fee split change report: 80 : 1 : 1 : 2 with automatic sink settlement

Date: 2026-10-21. Candidate `TapeoutMinerPool/2.1.0` (package `2.1.0-rc.1`), branch
`claude/fee-split-c-sink`, starting from `c3cb93375737de7ec63baa9f390edd0c15a5c7a4`. That commit equalled
`origin/main` (nothing ahead or behind), and the working tree was clean, so there was no unrelated work
to preserve.

This is an owner-authorized change to the pre-release system, limited to implementation and
verification on local chains and local BSC forks:
- Nothing was deployed to a public network, and no transaction was signed or broadcast.
- No real asset moved. No private key, wallet or `.env` was read.
- The live canary and recovery entry points were not run.
- The public RPC `bsc-mainnet.public.blastapi.io` served only as the read-only source of local Anvil
  and Foundry forks.

The change is not audited, and passing tests do not make it "audited" or "production ready".

Evidence: [`reports/fee-split-20261021-c3cb933/`](../reports/fee-split-20261021-c3cb933/). It holds the
recorded `npm run verify` run in `run/` (manifest, a log per step, every output) and machine-readable
assertions in `assertions.json`. It also has the source and build identities before and after, and
the fork blocks and hashes.

## 1. The rule: old and new

| | 2.0.0 (historical) | 2.1.0 |
| --- | --- | --- |
| Weights | 100 : 1 : 1 of 102 | displayed NAND + LATCH 100 : A 1.25 : B 1.25 : C 2.5 (105); on chain 80 : 1 : 1 : 2 of 84 |
| Recipient A, B | `⌊T/102⌋` each | `⌊T/84⌋` each (1.190…% of T) |
| Sink C | none | `⌊2T/84⌋` (2.380…%), to the fixed address `0x000000000000000000000000000000000000dEaD` |
| Participants | `⌊100T/102⌋` | `⌊80T/84⌋` (95.238…%; not 95%, and no "5% fee") |
| Outer rounding left in the pool | ≤ 2 raw units | ≤ 3 raw units (`r = T mod 84 ∈ 64…83`) |

Each part is its own floor of the cumulative recognized total `T`; none is derived from another. C is
`⌊2T/84⌋`, never `2·⌊T/84⌋`: they differ at `T = 42, 43, 83, 126, 1,050, …`, e.g. at `T = 42`
A = B = 0 and C = 1. Dividing the displayed weights by 1.25 gives the integers exactly (105 × 80/84 =
100), so all participant amounts of the 102-part examples carry over when 102 is replaced by 105. The
weights are compile-time constants (`PoolMath.TOTAL_PARTS = 84`, `PARTICIPANT_PARTS = 80`,
`RECIPIENT_PARTS = 1`, `SINK_PARTS = 2`). There is no setter, no administrator-controlled fee and no
way to change them in operation.

Unchanged:
- the NAND/LATCH split by the admitted miners' burn composition, composition checkpoints at admissions,
  the at-most-one-unit carry and the category rounding policy;
- fixed receipt denominators `S_N`/`S_L` and per-ID claimed histories.

## 2. The sink C

- **A code constant.** `SINK = 0x000000000000000000000000000000000000dEaD` is not configurable, not a
  role, not a receipt holder, and has no setter.
- **Never a recipient.** The constructor and `setRecipient` refuse it for A or B (`InvalidAddress`).
  A role cannot be stranded at the sink, and everything this pool sends to that address is C's
  payment. A and B migration is unchanged.
- **An ordinary transfer, not a burn.** C is paid with a plain ERC-20 `transfer` of BEM (through
  `SafeERC20`) to that address: no `burn` call and no transfer to the zero address.

BEM on BSC was inspected read-only on a local fork of block 128,713,128
([`bem-probe.json`](../reports/fee-split-20261021-c3cb933/bem-probe.json)):
- Its runtime is 2,205 bytes, keccak `0x982ba795…b344` (the hash the canary preflight pins). The
  ERC-1967 implementation and beacon slots are zero, so it is not such a proxy. The code holds no
  `burn(uint256)`/`burnFrom` selectors and no `0x…dEaD` literal.
- The address already held 2,444.27231190 BEM; `totalSupply` was 394,301.05671950 BEM.

What the fork runs observed (fresh, §8):

| Observation (real BEM) | Result |
| --- | --- |
| Sink balance change on a release | exactly the pool's recorded C payment, one `Transfer(pool → 0x…dEaD)` event, none to the zero address |
| `totalSupply` across the release | unchanged (39,451,273,037,263 raw before and after the first release; unchanged across the later releases) |
| `totalSupply` across a harvest | +28,736,663 raw, exactly the BEM Mining paid: Mining mints BEM when it pays income |

So C's BEM leaves the pool and stays counted in BEM's `totalSupply`. Calling it "burned" would be
inaccurate; it is out of circulation only in the conventional sense that nobody is known to control
`0x…dEaD`. This describes BEM's behaviour at the pinned block. BEM is not a proxy there, but its full
semantics were not analysed beyond what is listed above.

## 3. Automatic settlement

`releaseA()` and `releaseB()` stay permissionless. Each call:
1. requires an active pool and runs `_sync` (recognizing any new balance);
2. takes **one** accrual snapshot at the resulting `T`;
3. pays the selected role `A(T) − A_paid` (or B), and C **all** of `C(T) − C_paid`, setting both
   counters;
4. emits `RecipientPaid(role, recipient, amount)` and `SinkPaid(releasedRole, SINK, amount)`; both
   events are emitted even when an amount is zero.

The return value is the role's amount only; C is reported by `SinkPaid`, the `sinkPaid` counter and
the `sinkClaimable()` view. A release never marks the other role paid. C's backlog is cleared by
whichever release comes first, so the next release, of either role, pays C nothing until more income is
recognized. C is paid even when the role is due zero (`T = 42`). The payment is an internal helper
(`_payWithSink`), not an external self-call.

| Entry point | Accrues C (part of `T`) | Pays C |
| --- | --- | --- |
| `releaseA`, `releaseB` | yes | yes, all unpaid C |
| `harvest`, `harvestRange`, `sync`, `depositMiners`, `registerMiners` | yes | never |
| `claim`, `claimBatch` | no | never |

## 4. Atomic policy

Both payments of a release form one unit:
- All counters (`recipientXPaid`, `sinkPaid`, `totalPaid`, which includes C) are written before
  either transfer (checks-effects-interactions).
- The release runs under the pool's single `nonReentrant` guard.
- Afterwards the pool's, the role's and the sink's BEM balances must each have moved by exactly the
  requested amounts.
- A failing transfer, a `false` return or any other delta reverts the whole release: neither party is
  paid and no counter moves.

There is no partial-payment or skip-on-failure path.

Consequences, each tested (§8):
- **A token that refuses transfers to the sink** blocks every release that owes C at least one unit,
  of A and of B alike. C stays accrued, and receipt claims, harvests, syncs and admissions continue.
- **A recipient that cannot receive** blocks only its own role's release. The other role's release
  still pays C's whole backlog.
- **Reentrancy** from either transfer (into `releaseA`, `releaseB`, `claim` or `sync`) is refused by
  the guard. If the refusal propagates, the whole release rolls back.

## 5. Exact changes

### Solidity (`src/`)

- **`PoolMath.sol`.** The constants 84 / 80 / 1 / 2 (`SINK_PARTS` new). `Accrual` gains `sink`, after
  `recipientB`. `accrue` sets `sink = T·2/84` and subtracts it in the residue. The doc comment gives the
  rule and the outer bound.
- **`TapeoutMinerPool.sol`.** Nothing else in the pool changed:
  - `VERSION = "TapeoutMinerPool/2.1.0"`, `SINK_PARTS`, `SINK`, and storage `sinkPaid` (after
    `recipientBPaid`);
  - `Reconciliation` gains `sinkAccrued` and `sinkPaid`, after `recipientBPaid`;
  - event `SinkPaid`, and the view `sinkClaimable()`;
  - the constructor and `setRecipient` refuse `SINK`;
  - `_release` takes one accrual snapshot and pays the role and C through the new `_payWithSink`;
  - the notice and NatSpec are updated.
- **`canary/RecoverableTapeoutMinerPool.sol`.** Regenerated from the new production source as the
  local-only candidate `RecoverableTapeoutMinerPool/canary-2-local` (§9).

### Artifacts

Identity of every production and canary contract, before (a fresh build of `c3cb933`) and after, from
`scripts/contract-identity.ts`
([`contract-identity-compare.json`](../reports/fee-split-20261021-c3cb933/contract-identity-compare.json)):

| Contract | ABI | Code | Runtime / initcode (bytes) |
| --- | --- | --- | --- |
| `TapeoutEntitlementReceipt` | same | identical | 8,743 / 10,361, unchanged |
| `TapeoutReceiptDistributor` | same | identical except the trailing compiler metadata (it imports the pool, whose source hash is embedded) | 7,680 / 8,289, unchanged |
| `TapeoutMinerPool` | changed (§7) | changed | 19,113 → 20,777 / 30,896 → 32,685 |
| `PoolMath` (library, internal functions inlined into the pool) | — | its small stub carries new metadata | unchanged |
| `IMining` | same | (interface) | — |
| `RecoverableTapeoutMinerPool` | changed | regenerated | 20,404 → 22,074 / 32,279 → 34,074 |
| `CanaryParticipant` | same | identical except metadata | unchanged |

The pool stays under the EIP-170 runtime limit by 3,799 bytes. Compiler, settings and dependencies are
unchanged; `package-lock.json` differs only in the package version. `sdk/abi.ts` and
`sdk/bytecode.json` were regenerated (`npm run export-abi`), and the recorded run confirms that
exporting from the tested build leaves them unchanged.

### Tooling

- **`sdk/math.ts`**: the same constants, the exported `SINK`, `sink` in `accrue`, and
  `residueBound = 4 + …`.
- **`sdk/pool.ts`**:
  - release plan descriptions name the sink;
  - `readPoolSummary` reads `SINK`;
  - `checkReconciliation` adds unpaid C to the obligations, the paid and accrued identities, and the
    overpayment check. A new `outerPartsFromTotal` check recomputes A, C and the participant cap from
    `T` on its own.
- **`sdk/config.ts`**: refuses a system file with A or B at the sink.
- **`sdk/gas.ts`**: release bound 250,000 → 300,000; pool deployment bound 6,000,000 → 7,000,000.
- **CLI**: no code change. `release` and `reconcile` use the SDK, and `preview` shows C.
- **`scripts/local-e2e.ts`, `fork-e2e.ts`, `fork-safe-e2e.ts`**: 105-BEM fixtures and sink checks. On
  real BEM they compare balances, `Transfer` events and `totalSupply`; the Safe runner adds a release
  executed through a Safe.
- **`scripts/fork-test.ts`**: expects 17 fork tests and collects `fork-sink.json`.
- **`scripts/canary/build-source.mjs`, `workflow.ts`**: covered in §9.
- **`scripts/verify-all.ts`**: a comment only.
- **Configuration**: `package.json` and `package-lock.json` `2.1.0-rc.1`; `.gitignore` keeps this
  run directory's logs.

### Tests

- **New: `test/unit/PoolFeeSplit.t.sol`** (19 tests). Expected values are the specification's own
  arithmetic (`T/84`, `2T/84`, `80T/84`, literal tables), not `PoolMath`.
- **New fork test:** `testForkReleaseTransfersCToTheSinkOnRealBem`.
- **New gas test:** `testReleasesFitTheirBoundInEitherOrder`.
- **New SDK tests:** reconciliation with unpaid C, release plans, and the system-file refusal.
- **`test/helpers/Mocks.sol`:** `MockBEM` can block transfers to one destination and run a callback
  after a transfer (failure and reentrancy injection).
- **Updated suites:** unit, invariant (the release handler checks the cumulative formula, the sink is
  a payee, and `assertReconciled` includes C), remediation, SDK, canary and fork.
- **Fixtures:** those that encoded 102 parts moved to 105 (for example 1,020,000 → 1,050,000, so the
  participants keep 1,000,000).
- **Internal review suite (`test/audit/`):** only its split-dependent parts were adapted:
  - `model.py`, the Python reference model: 84 parts, C and the sink as a payee;
  - the differential test's actors and decoding;
  - one cumulative-income assertion that now includes C;
  - two fixtures.

  The review's original 102-part versions are in `b846c0c`.

The invariant `invariantFourAccountConservation` keeps its name, but it now covers five payees,
including the sink.

### Documentation

Updated: `README.md`, `docs/ARCHITECTURE.md`, `docs/ACCOUNTING.md`, `docs/OPERATIONS.md` and
`docs/CANARY_RUNBOOK.md`. This report is new.

### What stayed unchanged

- **Contracts.** The receipt (source and code), the distributor (source; code identical apart from
  its compiler metadata) and `IMining`.
- **Pool behaviour.**
  - the depositor whitelist (fixed, no setter);
  - the owner's only power, `activate`, and operation after renunciation;
  - composition reads and the strict admission boundary;
  - revoked-miner skipping, claims and `_pay`, and deliveries;
  - no withdraw, upgrade, sweep or arbitrary call.
- **Historical evidence**, byte-identical to `c3cb933`
  ([`historical-unchanged.json`](../reports/fee-split-20261021-c3cb933/historical-unchanged.json)):
  - `docs/INTERNAL_SECURITY_REVIEW_f2c8e50.md`, `docs/AUDIT_REMEDIATION_REPORT.md`,
    `docs/VERIFICATION_REPORT.md`, `docs/BASELINE.md` and `docs/LIVE_TEST_PLAN.md`;
  - `MAINNET_TEST_REPORT.md`;
  - `reports/canary/`, `reports/internal-review-f2c8e50/` and `reports/remediation-20261021-b846c0c/`;
  - the top-level `reports/` outputs.

  They describe the 2.0.0 candidate (102 parts, no sink), and the README now labels them historical.
  The recorded run wrote its outputs into `reports/`; they were copied into the run directory, and the
  historical files were then restored, as the remediation run did.

## 6. Conservation and residue

```
T = A + B + C + S_N·perNandShare + S_L·perLatchShare + residue
totalPaid = A_paid + B_paid + C_paid + nandReceiptsPaid + latchReceiptsPaid
bemBalance = (T − totalPaid) + unrecognized          (deficit always 0)
```

- **Outer floors.** With `T = 84q + r`, the floors of A, B, C and P leave
  `r − ⌊2r/84⌋ − ⌊80r/84⌋` units. That is 3 for `r = 64 … 83` and at most 2 otherwise: for those `r`,
  `⌊2r/84⌋ = 1` and `⌊80r/84⌋ = r − ⌈r/21⌉ = r − 4`. The SDK test checks all 84 remainders.
- **Inner floors.** The category split loses at most 1 unit (carried into the next period). Each
  collection's per-share floor loses at most `S − 1`.
- **Bound.** `residue ≤ 4 + (S_N − 1) + (S_L − 1)`, which was 3 + … under 2.0.0. A zero-supply
  category contributes 0.

Checked by:
- the Solidity fuzz tests and invariants (`assertReconciled` asserts the bound);
- the SDK random and exhaustive tests;
- the internal review's differential test against the updated Python model;
- the local, fork and Safe end-to-end `reconcile --deep` runs.

C receives exactly `⌊2T/84⌋` and never the residue: with `T = 84,083` the outer floors leave 3, C
receives 2,001 and the residue stays in the pool. The ledger stays solvent because every payment is
bounded by its own accrual (`noBucketOverpaid`). The invariant suites check the balance identity after
every action: 256 runs of 64 calls per invariant, with releases (and so sink payments) among the
actions.

## 7. ABI, compatibility and why this is a new deployment

- **Added:** `SINK()`, `SINK_PARTS()`, `sinkPaid()`, `sinkClaimable()`, and the event
  `SinkPaid(uint8 indexed releasedRole, address indexed sink, uint256 amount)`.
- **Removed:** nothing.
- **Changed return layouts:** `accrual()` and `previewAccrual()` (`sink` inserted after
  `recipientB`), and `reconciliation()` (`sinkAccrued`, `sinkPaid` inserted after `recipientBPaid`).
  The selectors are unchanged, so a 2.0.0 decoder would misread these tuples without an error.
  Off-chain code must use the 2.1.0 SDK ABI.
- **Changed values and behaviour:**
  - `VERSION`, `TOTAL_PARTS` 102 → 84, `PARTICIPANT_PARTS` 100 → 80;
  - `releaseA`/`releaseB` now also transfer to the sink and emit `SinkPaid`, which costs more gas;
  - `recipientClaimable` keeps its meaning (role only).
- **Storage layout:** `sinkPaid` is a new slot after `recipientBPaid`, shifting the later slots.
  This is irrelevant without an upgrade path.

**A new deployment is required.** The pool has no proxy, upgrade, migration, withdrawal or sweep
function, and its weights are compiled constants. The receipts are bound in the pool's constructor and
the pool in the distributor's, so 2.1.0 is a fresh system deployment following docs/OPERATIONS.md.

Nothing exists to migrate: the production system was never deployed to BSC mainnet. The only mainnet
deployment is the canary-1 test system (100 : 1 : 1 accounting); both of its miners were returned and
its pool was permanently shut down. The receipt and distributor code paths are unchanged, but
deploying them means new instances bound to the new pool. No migration was written or tested.

## 8. Validation

All results below are **fresh**, from the recorded run (`run/run-manifest.json`) on the final source
tree. Each requirement's evidence and its computed status are in
[`assertions.json`](../reports/fee-split-20261021-c3cb933/assertions.json).

| Step of the recorded run | Result | Detail |
| --- | --- | --- |
| Build sizes | PASS | TapeoutEntitlementReceipt: runtime 8,743 B (margin 15,833), initcode 10,361 B (margin 38,791); TapeoutMinerPool: runtime 20,777 B (margin 3,799), initcode 32,685 B (margin 16,467); TapeoutReceiptDistributor: runtime 7,680 B (margin 16,896), initcode 8,289 B (margin 40,863) |
| SDK ABI/bytecode match the tested build | PASS | export leaves `sdk/abi.ts` and `sdk/bytecode.json` unchanged |
| Formatting (`src`, `script`, `test/{unit,invariant,fork,helpers,remediation}`) | PASS |  |
| Solidity unit, fuzz, invariant and remediation suites | PASS | 142/142 passed |
| Gas model (bounds as transaction gas limits) | PASS | 11 tests |
| Internal review suite, with the differential test against the Python model (`--ffi`) | PASS | 10/10 passed |
| Internal review TypeScript tests | PASS | 10/10 passed |
| SDK tests | PASS | 55/55 passed |
| TypeScript typecheck | PASS | no errors |
| Local Anvil end to end (CLI, mock protocol) | PASS | 52 checks, 47 local transactions |
| Largest-wallet check | PASS |  |
| Fork tests on real BSC state | PASS | 17/17 passed, block 128,713,128 |
| Fork end to end (CLI, real Mining and BEM) | PASS | 23 checks |
| Safe end to end (three Safes, real Safe contracts) | PASS | 255 checks, 24 Safe transactions |
| Canary-2 local rehearsal (complete; interrupted with standalone recovery) | PASS | complete run: 43 assertions PASS; interrupted run: 7 PASS, then standalone recovery |
| Slither | PASS | 79 results (§ Static analysis) |
| Artifacts identical after Slither's clean rebuild | PASS |  |
| Contract identity recorded (compared separately with `c3cb933`) | PASS |  |

Overall: **PASS**. Tested tree `sourceTreeSha256` `888ac46aa8053d26eb173bd8716e1b958a5141b3f6dd05f6e72d0d8c51904d29` (141 files, base `c3cb933`). `assertions.json` has 28 requirement entries: 28 PASS.

### Gas

| Measurement (gas used) | 2.0.0 (historical run) | 2.1.0 (this run) | Planned bound (`sdk/gas.ts`) |
| --- | ---: | ---: | ---: |
| Pool deployment, 16 depositors and a 64-byte name (`GasModel`) | 5,311,642 | 5,670,339 | 6,000,000 → 7,000,000 |
| releaseA / releaseB, first payments (`testSingleCallsFitTheirBounds`) | 136,814 / 118,504 | 197,583 / 132,955 | 250,000 → 300,000 |
| Worst release, A first then B / B first then A: inflow to recognize, first payments into empty balances (`testReleasesFitTheirBoundInEitherOrder`) | – | 206,731 then 154,155 / 205,455 then 155,431 | 300,000 |
| releaseA / releaseB sent by the CLI, local Anvil (mock BEM) | 119,275 / 118,065 | 180,044 / 132,516 | 300,000 |
| releaseA / releaseB sent by the CLI on the BSC fork (real BEM; the sink already holds BEM) | 116,538 / 115,328 | 151,276 / 123,919 | 300,000 |
| `release` through a Safe (2-of-3 SafeL2 1.4.1, MultiSend of releaseA + releaseB, BSC fork): estimate / used | – | 233,377 / 221,138 | file `maxGas` 772,848 (plans 600,000) |

`GasModel` runs each call as its own transaction with exactly its bound minus the intrinsic cost as gas, so a pass shows the bound suffices; its logged values are that transaction's gas. The CLI and Safe values are real transaction receipts on the local chains.

### Static analysis

Slither 0.11.3 ran on the final code: `--exclude-informational`, with tests, libraries and scripts
filtered (`run/slither.json`, `run/slither.txt`). It reports 79 results. The previous run, on 2.0.0,
reported 77 (`reports/remediation-20261021-b846c0c/run/slither.json`).

Compared by detector and description:
- **Removed:** none.
- **Added:** two `incorrect-equality` (Medium/High) findings, one in `TapeoutMinerPool._payWithSink` and
  one in its canary copy, both on the early return `outflow == 0`. This is the same pattern already
  triaged for `_pay` (`amount == 0`). The value is a ledger difference, not a balance, and the return
  only skips a release with nothing to pay. The exact balance-delta checks after the two transfers are
  not flagged.
- **Unchanged:** every other result. Their triage is in docs/VERIFICATION_REPORT.md §5 for the
  production contracts; docs/AUDIT_REMEDIATION_REPORT.md covers the same findings in the canary copy.

No finding led to a code change.

### Fresh, reused and unverified evidence

- **Fresh, recorded run:** every row above.
- **Fresh, outside the run:** the contract identity of `c3cb933`, from a fresh build of
  `git archive c3cb933` in a scratch directory. It matches the earlier remediation run's recorded
  identity exactly, which cross-checks the build. The read-only BEM probe at block 128,713,128 is also
  fresh.
- **Reused, not re-run:**
  - the static analysis of Mining's bytecode behind docs/MINING_LIFECYCLE.md. The pool's
    revoked-miner handling did not change, and the Mining fork tests (lifecycle and transitions) ran
    again in this run;
  - the canary-1 mainnet run and every 2.0.0 report. They are historical and are **not** evidence for
    2.1.0; no claim is made that the old mainnet canary validated the new split.
- **Not executed, separate decisions:** deployment to BSC mainnet, a live or real-asset test, a
  mainnet canary of 2.1.0, approval of canary-2, and an independent audit.
- **Not established:** BEM's behaviour at later blocks or under code it does not have at the pinned
  block.

## 9. Canary

The canary generator copies the production pool, so the 2.1.0 source yields a new local-only candidate,
`RecoverableTapeoutMinerPool/canary-2-local`:
- **Generator.** `build-source.mjs` pins the 2.1.0 production source (sha256 `6a2d0c34…5e6d`). It
  writes its adaptation diff to `reports/canary-local/production-canary.diff`; `reports/canary/`
  (canary-1, from `c4bc022`) is untouched.
- **Shared workflow.** Its independent arithmetic uses 84 parts. It checks each release's `SinkPaid`
  amount, the sink's balance change and the final transfers to the sink, and its residue bound is 8
  for the canary's 4 + 2 receipts.
- **The approved path stays closed.** Every approved-candidate entry point (`prepare`, `fork`, `live`,
  `verify-local`) stops at the existing `c4bc022` pin, so the workflow runs only through
  `fork-local-candidate.ts`. `scripts/canary/report.ts`, the approved canary-1 report template, is
  unchanged.
- **Recovery authority** is unchanged and canary-only.

The rehearsal ran on two local forks of block 128,812,145 (hash `0x383f1f97…a922`), as
`LOCAL_CANDIDATE_NOT_APPROVED`: a complete run, and an interrupted run with standalone recovery.
Nothing about canary-2 is approved for mainnet.

## 10. Audit focus

1. **`_release` / `_payWithSink`:** the single snapshot, counters before transfers, the three balance
   checks, and the revert semantics. Confirm no path pays C without updating `sinkPaid` and `totalPaid`
   together, or pays the other role.
2. **C's backlog semantics:** C is settled by whichever release comes first. A and B are released at
   different times and floored independently, so C's amount is computed from `T` and never derived
   from a role payment; any equality with twice a role payment is arithmetic coincidence.
3. **The new residue bound** (`4 + …`) and every reconciliation identity, including the
   `outerPartsFromTotal` check.
4. **The ABI layout changes** (§7) and any consumer that decodes them.
5. **Liveness:** a sink-specific failure blocks releases (by design) but not claims. Releases are
   permissionless; repeated calls pay nothing and cost only the caller's gas.
6. **Release gas on real BEM** against the 300,000 bound, including an empty-balance sink (the real
   one is not empty).
7. **The canary-2 adaptation diff** (local-only).

## 11. Reproduce

```bash
npm ci --ignore-scripts
```

```bash
FORK_RPC_URL=<read-only archive RPC> SLITHER=$(which slither) CANARY_FORK_BLOCK=128812145 npm run verify
```

The runner writes into `reports/`. It passes the pinned fork inputs recorded under `forkInputs` in the
manifest: block 128,713,128 and the miners listed there. Running a fork step on its own needs the same
`FORK_*` variables, or it discovers inputs at a recent block. Individual parts:
- `forge test --no-match-path 'test/{fork,audit}/*'`
- `forge test --match-path 'test/audit/*' --ffi`; FFI runs only `python3 -I test/audit/model.py`
- `npm run test:sdk`
- `FORK_RPC_URL=… FORK_BLOCK=128713128 … npm run test:fork` (17 tests, including the real-BEM sink test)
- `FORK_RPC_URL=… npm run test:fork-e2e` and `npm run test:fork-safe-e2e` (both default to block 128,713,128)
- the baseline identity: export `c3cb933` (`git archive`), build it with the same toolchain, run
  `scripts/contract-identity.ts`'s procedure over it, then
  `node --import tsx scripts/contract-identity.ts --compare BEFORE AFTER`
