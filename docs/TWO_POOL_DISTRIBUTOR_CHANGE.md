# One distributor for two custody pools (TapeoutMinerPool/2.3.0)

**Status.** Candidate `TapeoutMinerPool/2.3.0` (package `2.3.0-rc.1`), built on the verified 2.2.0
revision `bdf906f801f59acefc49094361a530b823a73ab8`. Implemented and tested on local chains and local
BSC forks only; not committed, not deployed, no transaction sent to any public network.

**This is new code.** Neither the SALUS Security assessment (which covered `c3cb933`) nor the internal
reviews (`f2c8e50`, `8cf31dc`, and the 2.2.0 review of `6345de8`) cover the changes described here. The
historical reports are unchanged and describe the code they reviewed.

## 1. Target arrangement

Per processor: one NAND receipt contract, one LATCH receipt contract, one `TapeoutReceiptDistributor`,
and two custody pools, the **Optimal Pool** and the **Regular Pool** (two deployments of the unchanged
`TapeoutMinerPool` code).

- Both pools recognize the same receipt pair.
- The receipts are issued once. The distributor holds the round's inventory, allocates each receipt
  once (one full round covering the whole supply) and delivers it once, to its beneficiary.
- Each pool binds the distributor, activates, admits miners, holds custody and keeps its accounts on
  its own. A receipt holder claims that receipt's income from each pool separately; a claim in one pool
  never consumes the other pool's entitlement or history.
- Not used, and not needed: a second distributor, a second issuance, a partitioned distribution,
  duplicate allocations, or an empty distributor to satisfy a pool's initialization checks.

## 2. Design

### 2.1 Distributor: an explicit, immutable pair of pools

`constructor(address owner_, TapeoutMinerPool optimalPool_, TapeoutMinerPool regularPool_)` stores both
pools as immutables. It refuses, in this order:

| Condition | Error |
| --- | --- |
| either pool is the zero address or has no code | `InvalidAddress()` |
| the same pool twice | `DuplicatePool()` |
| the pools report different `nandReceipt()` or `latchReceipt()` | `IncompatiblePoolReceipts()` |
| the pools report different `bem()`, `mining()` or `minerCollection()` (another processor) | `IncompatiblePoolProtocol()` |

A contract that is not a pool has none of these views, so construction reverts. The distributor's
`nandReceipt`/`latchReceipt` are the pools' receipts. There is no setter, replaceable address,
registration or list. Views: `optimalPool()`, `regularPool()` and `isPool(address candidate)`, true for
exactly those two addresses. The ambiguous single-pool getter `pool()` is removed, not kept beside them,
so every consumer had to be updated deliberately (§3, §7).

"Optimal" and "regular" are the deployment's labels. The contracts treat both pools alike; neither
pool checks any Mining property (such as an optimal flag) of the miners it admits.

### 2.2 Pool binding

`TapeoutMinerPool.bindDistributor` replaces `d.pool() == address(this)` with `d.isPool(address(this))`
(through `IReceiptDistributor.isPool`). Everything else is retained: code existence, exact NAND and LATCH
receipt matching, owner-only, one-time and irreversible binding, binding before activation (activation
requires a bound distributor), a finalized allocation before activation, the issuance and supply checks,
and the first-admission renunciation checks (`_openCustody`). Both pools can bind the same distributor,
each with its own call; a third pool cannot, even with the same receipts.

No cross-pool dependency was added: a pool never reads the other pool. The consequence (an accepted,
documented limitation, test `testThePoolsDoNotReadEachOthersBinding`) is that before binding, a pool's
owner could bind another genuine distributor that also counts that pool, for example a second
distributor built for the same two pools. A cross-pool check would not close this either: a distributor
pairing one pool with a decoy third pool passes any such check. The tooling closes it instead: the
deployment check run before every write requires both pools to be bound to the addresses file's
distributor, which must serve exactly the addresses file's two pools in their roles, and full-round
verification requires that distributor to hold and allocate the whole supply. As in 2.2.0, binding does
not prove where receipts sit; finality is not weakened relative to 2.2.0.

### 2.3 The distributor's single-pool assumptions

- `_acceptOne`: a receipt is refused as inventory if its claim history is nonzero in either pool
  (`optimalPool.claimed(c, id) != 0 || regularPool.claimed(c, id) != 0`, `ConsumedRewardHistory`). Token
  identity, amount (exactly 1), finalization (`AllocationClosed`) and receiver behavior are unchanged.
- `allocate`: neither pool can be a beneficiary (`InvalidAllocation`), besides the zero address and the
  distributor itself. Uniqueness (`AlreadyAllocated`), inventory accounting, cursors, the range limit and
  permissionless delivery are unchanged.
- The distributor still never claims BEM, never approves an operator and makes no state-changing call to
  either pool; its only calls to the pools are the `claimed` views while accepting inventory.

### 2.4 What did not change

Issuance and supply, unique IDs with supply 1, the 80 : 1 : 1 : 2 split of 84, the sink behavior,
carried-income attribution, the fractional ledger, per-pool claim histories, unpaid entitlement
following the holder, admission restrictions and custody permanence. `TapeoutMinerPool`'s ABI is
unchanged (only `VERSION` and the binding check differ); `TapeoutEntitlementReceipt` is byte-identical.
Admission gas is unchanged (the local admission model matches the 2.2.0 evidence run within ±12 gas).

### 2.5 Shared gates

The receipts and the distributor appear in both pools' first-admission conditions, so an unfinished
allocation blocks both pools' activation, and an unrenounced receipt or distributor blocks both pools'
first admission. Each pool's own ownership gates only that pool. The two pools do not wait for each
other: one can be bound, activated and holding miners while the other is still being set up.

## 3. Exact changes

### 3.1 Contracts and ABI

`TapeoutReceiptDistributor` (runtime 7,680 → 8,137 bytes; initcode 8,289 → 9,597; immutable references
11 → 16):

| Item | 2.2.0 | 2.3.0 |
| --- | --- | --- |
| constructor | `(address owner_, address pool_)` | `(address owner_, address optimalPool_, address regularPool_)` |
| `pool()` `0x16f0115b` | returns the pool | **removed** |
| `optimalPool()` `0x62271835` | — | returns the Optimal Pool |
| `regularPool()` `0xd0ea32d6` | — | returns the Regular Pool |
| `isPool(address)` `0x5b16ebb7` | — | `true` for the two pools only |
| `DuplicatePool()` `0xb82a4746` | — | new error |
| `IncompatiblePoolReceipts()` `0x5975ff06` | — | new error |
| `IncompatiblePoolProtocol()` `0x1862edc9` | — | new error |

Events are unchanged. `IReceiptDistributor` (the views a pool reads): `pool()` is replaced by
`isPool(address candidate) returns (bool)`.

`TapeoutMinerPool`: `VERSION` is `"TapeoutMinerPool/2.3.0"`; `bindDistributor` checks membership (§2.2).
Runtime 23,168 → 23,170 bytes (1,406 under EIP-170), initcode 35,118 → 35,120. ABI unchanged.

Local canary: regenerated by `scripts/canary/build-source.mjs` (new baseline sha256
`5cb9e6bd8cca84094ad5fa992c498064aa2c1fee96926d0ab62e4f0f19920afd`) as
`RecoverableTapeoutMinerPool/canary-4-local`; the adaptation is canary-3's patch list unchanged (diff in
`reports/canary-local/canary-4-production-canary.diff`). Runtime 24,441 bytes, 135 under EIP-170.
canary-1 (`c4bc022`) and the canary-2/canary-3 records are untouched; no live canary is authorized.

### 3.2 Configuration (deployment manifests)

System file (`deployments/examples/system.bsc.example.json`): the `pool` object is replaced by
`pools.optimal` and `pools.regular`, each `{ name, owner, recipientA, recipientB, depositors }`. Both
pools use the file's `protocol` and the deployed receipts; their names must differ.

Addresses file (`deployments/examples/addresses.bsc.example.json`):

```json
{ "chainId": 56, "nandReceipt": "0x…", "latchReceipt": "0x…", "optimalPool": "0x…", "regularPool": "0x…", "distributor": "0x…" }
```

A file with the single-pool key `pool` (2.2.0 and earlier) is refused by name (`parseSystemFile`,
`parseAddresses`, `script/DeployPool.s.sol`), never read as one of the two pools.

### 3.3 SDK (`sdk/`)

- `config.ts`: `POOL_ROLES`, `PoolRole`, `POOL_ADDRESS_KEY`, `PoolDefinition`, `parseSystemFile`,
  `parseAddresses` (new); `systemFileSchema.pools`, `addressesSchema.optimalPool/regularPool`;
  `poolDeployment(f, role, nandReceipt, latchReceipt)`; `systemProblems` checks each pool.
- `pool.ts`: `deployPoolPlan(f, role, nandReceipt, latchReceipt)`,
  `deployDistributorPlan(owner, optimalPool, regularPool)`; `readDistributorSummary` returns
  `pools: { optimal, regular }` instead of `pool`; `readFinality` checks `isPool(pool)`;
  `READ_LAYOUT_VERSIONS = ['TapeoutMinerPool/2.3.0']`,
  `LOCAL_CANARY_LAYOUT_VERSIONS = ['RecoverableTapeoutMinerPool/canary-4-local']`. The tuple layouts are
  2.2.0's, but this SDK refuses 2.2.0 pools: its distributor ABI and manifests are the two-pool ones.
- `verify.ts`: `VerifyTarget { chainId, distributor, optimalPool, regularPool, nandReceipt, latchReceipt }`;
  `AllocationState.pools` and per-pool `poolReceipts`; identity requires both configured pools to be the
  distributor's, in their roles, and each pool's receipts to be the distributor's. The allocation
  artifact format is unchanged (it names the distributor and receipts).
- `deployment.ts`: `checkDeployment` checks both pools (code, receipts, protocol, and with `--system`
  each pool's whitelist and owner), that they are distinct and of the same processor, the distributor's
  pair against the addresses file, `isPool` for each, and each pool's bound distributor.
- `gas.ts` (re-measured, §4): `ISSUE_GAS.perId` 54,000 → 56,000 and `FUND_GAS.perId` 40,000 → 44,000.
- `abi.ts`, `bytecode.json`: regenerated by `forge build` and `scripts/export-abi.mjs` (no hand edits; a
  second export after the final build is byte-identical).

### 3.4 CLI (`cli/pool.ts`)

- `--pool optimal|regular` selects the pool for `bind-distributor`, `activate`, `renounce --target pool`,
  `finality`, `composition`, `deposit`, `register`, `harvest`, `claim`, `release`, `set-recipient`,
  `inspect` and `reconcile`; a missing selector is an error. Receipt and distributor commands take none.
- `deploy` plans (or, with `--send-local`, sends) both pool deployments and then the distributor;
  `deploy-distributor` mirrors the constructor checks before planning.
- `bind-distributor` preflight: the distributor must count the pool (`isPool`) in the selected role
  (`optimalPool()`/`regularPool()`) and report the addresses file's receipts; the pool must be unbound
  and inactive.
- Outputs of pool-scoped commands name the pool role; `check-system` reports each pool's name, owner,
  whitelist and recipients, and the distributor owner; `inspect` shows the distributor's two pools.

### 3.5 Deployment script

`script/DeployPool.s.sol:DeployPool` deploys both pools from `.pools.optimal` and `.pools.regular`, then
`new TapeoutReceiptDistributor(distributorOwner, optimalPool, regularPool)`; it refuses a system file
with `.pool`.

## 4. Gas and size measurements

The receive hook now reads both pools' claim history for every ID (one more staticcall, about 3.3k gas
per ID), which made two per-ID bounds tight. Measured in `test/unit/GasModel.t.sol` (each call as its own
transaction with exactly its bound as the gas limit; a limit must cover gas before refunds):

| Bound | Measurement | 2.2.0 bound | 2.3.0 bound | CLI default / maximum |
| --- | --- | --- | --- | --- |
| funding, per ID | ~41.3k before refunds (~36.5k after); 300 IDs no longer fit 40k/ID (the hook ran out of gas) | 40,000 | 44,000 | 300 → 283 IDs |
| issuing into the distributor, per ID | 11,874,168 for 222 IDs (bound 12,532,000); 231 IDs used 12,351,807 of 12,574,000 | 54,000 | 56,000 | 231 → 222 IDs |
| distributor deployment | 1,898,513 | 2,500,000 | unchanged | — |

Other bounds are unaffected (allocation, revocation, delivery, claims, releases, single calls and pool
deployment re-ran within their bounds). The Safe fork e2e's batching (issue split 2,2,1; funding 2,2)
still holds with the new bounds.

## 5. Files changed

- Contracts: `src/TapeoutReceiptDistributor.sol`, `src/TapeoutMinerPool.sol`,
  `src/interfaces/IReceiptDistributor.sol`, `src/canary/RecoverableTapeoutMinerPool.sol` (generated).
- SDK and generated artifacts: `sdk/config.ts`, `sdk/pool.ts`, `sdk/verify.ts`, `sdk/deployment.ts`,
  `sdk/gas.ts`, `sdk/abi.ts`, `sdk/bytecode.json`.
- CLI and scripts: `cli/pool.ts`, `script/DeployPool.s.sol`, `scripts/local-e2e.ts`, `scripts/fork-e2e.ts`,
  `scripts/fork-safe-e2e.ts`, `scripts/largest-wallet-check.ts`, `scripts/fork-test.ts` (21 fork tests),
  `scripts/canary/{build-source.mjs, common.ts, transactions.ts, workflow.ts, prepare.ts, fork-local-candidate.ts}`,
  `scripts/verify-all.ts` (pipeline gap, §6).
- Configuration examples and version: `deployments/examples/system.bsc.example.json`,
  `deployments/examples/addresses.bsc.example.json`, `package.json`, `package-lock.json`.
- Tests, new: `test/unit/TwoPoolDistributor.t.sol` (17 tests), `test/fork/TwoPoolFork.t.sol` (1 fork test).
- Tests, updated fixtures (old single-pool assumptions only): `test/helpers/SystemTestBase.sol` (adds
  `regularPool`), `test/unit/Distributor.t.sol`, `test/unit/GasModel.t.sol`, `test/unit/PoolSetup.t.sol`,
  `test/unit/CanaryRecovery.t.sol` (+1 test), `test/salus/SalusFinality.t.sol`,
  `test/review-fable51/ReviewFindings.t.sol`, `test/fork/PoolForkBase.sol`, `test/fork/PoolBoundary.t.sol`,
  `test/sdk/{plans, verify, read-layout, gas}.test.ts`, `test/audit/verify-supply-gap.test.ts`. Every
  existing security regression still runs and passes.
- Documentation: `docs/ARCHITECTURE.md` (§2a and updates), `docs/OPERATIONS.md`, `docs/CANARY_RUNBOOK.md`,
  `README.md`, this file. Historical reports (`docs/SALUS_AUDIT_REMEDIATION_REPORT.md`,
  `docs/AUDIT_ASSUMPTIONS.md`, the internal reviews, `docs/VERIFICATION_REPORT.md`, …) are unchanged.
- New evidence: `reports/canary-local/canary-4-production-canary.diff` and
  `reports/two-pool-distributor-20261030-bdf906f/`.

## 6. Verification

The two-pool behavior is covered at three levels:

- **Contract tests** (`test/unit/TwoPoolDistributor.t.sol`): the fixed pair and `isPool`; constructor
  refusals (zero, non-contract, non-pool contract, duplicate, other NAND or LATCH receipt, other BEM,
  Mining or miner collection); both pools bind once, independently, and cannot rebind; a third pool
  with the same receipts cannot bind; the unfinished shared allocation blocks both activations; an
  unrenounced shared receipt or distributor blocks both first admissions; each pool initializes on its
  own; allocation to either pool is refused; inventory with claim history in pool A, pool B or both is
  refused (single and batch hooks); one full-round allocation delivers each receipt exactly once; the
  same receipt claims independently from both pools; unclaimed entitlement follows a transfer in each
  pool separately; and a complete two-pool lifecycle with per-pool reconciliation. A mutation check
  (acceptance reading one pool, allocation rejecting one pool, `isPool` accepting one pool, no protocol
  comparison, binding without membership) makes the suite fail each time.
- **CLI lifecycle** (`scripts/local-e2e.ts`, 79 checks): single-pool files refused; both pools and one
  distributor deployed; the `--pool` selector required; a third same-receipt pool and swapped roles fail
  verification and writes, and cannot bind on chain; a second distributor for the same pools is flagged
  for both pools; each pool binds and activates; the shared distributor's owner alone blocks both pools'
  first admission; admissions, income, independent claims and transfers in both pools; releases and deep
  reconciliation of both.
- **Real protocol** (local BSC fork of block 128,713,128): `testForkTwoPoolsShareOneDistributorAndClaimIndependently`
  admits the real NAND-only miner 12733 into the optimal pool and miner 13948 (NAND 2, LATCH 64) into
  the regular pool, harvests through the real `Mining.claim`, and claims NAND #1 from each pool
  independently. The CLI fork e2e, the Safe fork e2e and the canary-4 rehearsal initialize both pools.

Results of the recorded pipeline run (`scripts/verify-all.ts`, 2026-10-29 17:14–17:21 UTC, local chains
and local forks only; tested tree fingerprint `5beb9b98851030d337374ba0c4723f2a6da4e345868b4dd2fbb66b6a9b2940a0`,
which is the current tree's; evidence and method in
[reports/two-pool-distributor-20261030-bdf906f/](../reports/two-pool-distributor-20261030-bdf906f/)):

| Check | Result |
| --- | --- |
| `forge build --sizes` | PASS; sizes in §3.1 |
| ABI/bytecode export consistency | PASS: a fresh export is byte-identical to `sdk/abi.ts` and `sdk/bytecode.json` |
| `forge fmt --check` (the pipeline's directories) | PASS |
| Solidity tests (main, audit, SALUS differential, 2.2.0 review; FFI where needed) | PASS: 244 + 10 + 2 + 20 = 276, 0 failed |
| gas model (`test/unit/GasModel.t.sol`) | PASS, 11 of 11 (§4) |
| SDK and audit TypeScript tests | PASS: 79 + 13 = 92, 0 failed |
| `tsc --noEmit` | PASS |
| local e2e (two-pool lifecycle) | PASS, 79 checks, 90 steps |
| largest-wallet check | PASS |
| fork tests (block 128,713,128) | PASS, 21 of 21 |
| CLI fork e2e | PASS, 26 checks |
| Safe fork e2e | PASS, 294 checks |
| canary-4 local fork rehearsal (block 128,812,145, impersonated public address, no key, 0 mainnet transactions) | PASS: complete 48/48, interrupted 10/10, recovery closed both canary pools |
| contract identity | PASS; compared with the recorded 2.2.0 identity: `DIFFERENT` as intended |
| canary `build-source.mjs --check` | PASS (canary-4-local) |
| Slither | NOT_RUN: not installed in this environment (the manifest's overall result is therefore `INCOMPLETE`) |

Bytecode against a fresh build of `bdf906f`: the receipt, `PoolMath` and `IMining` are identical;
`CanaryParticipant` differs only in its trailing compiler metadata; the pool and the canary pool changed
with the same ABI; the distributor and `IReceiptDistributor` changed, ABI included. Every file tracked at
`bdf906f` under the historical locations is byte-identical except the three living guides updated on
purpose (568 of 571).

**Pipeline gap found and closed.** The first recorded run passed every step except `solidity-tests`
(262 of 264): the 2.2.0 internal review added two FFI differential tests in
`test/review-fable51/ReviewDifferential.t.sol`, and `verify-all.ts` ran that directory in its main
Solidity step, which has no `--ffi`, so the step fails the same way at `bdf906f`. The two tests pass with
`--ffi`. `verify-all.ts` now runs `test/review-fable51/` in its own `--ffi` step
(`review-fable51-tests`, executing only `python3 -I test/review-fable51/model_fable.py`); nothing is
skipped. The run was then repeated on the final tree.

## 7. Limitations and verification not run

- Not audited: new code outside every existing review (above). A review should look at least at the
  constructor checks, the membership binding, the two-pool acceptance check and the tooling guards that
  stand in for a cross-pool binding check.
- The pools do not read each other's binding (§2.2); the deployment check and full-round verification
  are what keep both pools on the one distributor holding the whole supply. Frontend and backend should
  apply the same check (§8).
- Pool roles are labels; nothing on chain routes "optimal" miners to the Optimal Pool.
- The distributor's per-ID acceptance cost grew by one external view call; funding and direct issuance
  batches are smaller (§4).
- Slither: NOT_RUN (not installed). No public-network deployment, transaction or live canary.
- No migration path for an existing single-pool deployment (none exists on mainnet): a single-pool
  system keeps the 2.2.0 release and its SDK; 2.3.0 tooling refuses its manifests and its pools.
- The tooling keeps its explicit `--partial` verification mode; the default remains full-round coverage.

## 8. Frontend and backend follow-up (not changed here)

- **Deployment configuration.** A processor now has two pool addresses (`optimalPool`, `regularPool`),
  one distributor and one receipt pair; a single `minerPool`/`pool` entry per deployment must become
  the pair, and an undecided one-or-two-distributor topology setting resolves to one distributor.
- **Distributor ABI.** `pool()` no longer exists: read `optimalPool()`, `regularPool()` and
  `isPool(address)`; decode the new constructor and errors. Accept a configured pool only if the
  distributor names it in that role; reject an unrelated pool even when it reports the same receipts.
- **Binding check.** Verify that both pools' `distributor()` equal the configured distributor (the
  contracts do not check this across pools).
- **Version gate.** Pools report `TapeoutMinerPool/2.3.0`; tuple layouts are 2.2.0's, but 2.3.0 must be
  read with the 2.3.0 ABI and manifests (and 2.2.0 pools with the 2.2.0 ones).
- **Indexing.** Index each pool's events separately (admissions, harvests, receipt claims, releases,
  custody), keyed by pool address; distributor and receipt events once. A receipt's claim history,
  claimable amount and payments are per pool.
- **User views.** Show each receipt's claimable income per pool (and a total), with one claim per pool;
  deposit flows need a pool choice; finality shows each pool's state, noting that the receipts and the
  distributor are shared conditions.
