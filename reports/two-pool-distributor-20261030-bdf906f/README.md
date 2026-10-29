# Evidence: one distributor for two custody pools, `TapeoutMinerPool/2.3.0`

Produced for [docs/TWO_POOL_DISTRIBUTOR_CHANGE.md](../../docs/TWO_POOL_DISTRIBUTOR_CHANGE.md). Starting revision
`bdf906f801f59acefc49094361a530b823a73ab8` (`TapeoutMinerPool/2.2.0`); the tested tree is that revision with
the uncommitted 2.3.0 changes. Every transaction here belongs to a local Anvil chain or a local BSC fork.
None was sent to a public network, no real key signed anything, and no `.env` or wallet was read.

| Path | Contents |
| --- | --- |
| `run/run-manifest.json` | The recorded `scripts/verify-all.ts` run: tested tree fingerprint `5beb9b98851030d337374ba0c4723f2a6da4e345868b4dd2fbb66b6a9b2940a0` (170 files), tools, artifact hashes, fork inputs, and every step's command, timestamps, exit code and summary |
| `run/logs/` | One log per step (local paths removed) |
| `run/*.json`, `run/*.tap`, `run/*.txt` | Step outputs: Solidity and SDK results, the two-pool local end-to-end report (`local-e2e.json`, 79 checks) and its reconciliation, fork observations and the 21 fork test results (`fork-test.json`, including `testForkTwoPoolsShareOneDistributorAndClaimIndependently`), the fork end-to-end and Safe reports, the largest-wallet check, the admission gas model, the post-run contract identity |
| `run/canary-fork/` | The canary-4 local candidate on two local BSC forks of block 128,812,145: summary, complete run, interrupted run with standalone recovery (both canary pools closed) |
| `contract-identity-compare.json` | `scripts/contract-identity.ts --compare` of the recorded 2.2.0 identity (`reports/salus-remediation-20261029-c78a6d1/run/contract-identity.json`) with this run's: `DIFFERENT`, as intended. That identity's `head` field reads `c78a6d1` because its run tested the then-uncommitted 2.2.0 remediation; all eight of its source hashes equal the files at `bdf906f` |
| `bytecode-comparison.json` | Per contract, ABI and code of a fresh build of `git archive bdf906f` (scratch directory, same toolchain; it reproduces `bdf906f`'s committed `sdk/bytecode.json` byte for byte) against this build, made with `reports/salus-remediation-20261029-c78a6d1/bytecode-comparison.py` |
| `historical-unchanged.json` | Every file tracked at `bdf906f` under `reports/`, `docs/`, `proposed-patches/`, the PDFs and `MAINNET_TEST_REPORT.md`, compared byte for byte after the run: 568 of 571 unchanged; the 3 others are the living guides updated on purpose (`docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `docs/CANARY_RUNBOOK.md`); plus the list of new files |

Fork sources (read-only RPC host `bsc-mainnet.public.blastapi.io`):
- BSC block 128,713,128 (`0x760f050b…081f`) for the fork tests, the fork end-to-end run and the Safe test;
- block 128,812,145 (`0x383f1f97…a922`) for the canary rehearsal;
- the block before the replayed revocation (119,597,280) for the Mining transition test.

## Results of the recorded run

Every executed step passed: build and sizes, ABI export consistency, format check, Solidity tests
(244 in the main step, 10 audit, 2 SALUS differential, 20 in the 2.2.0 review's suites: 276), the gas
model, 13 audit and 79 SDK TypeScript tests, typecheck, the local end-to-end run, the largest-wallet
check, 21 of 21 fork tests, the fork end-to-end run (26 checks), the Safe test (294 checks), the canary-4
rehearsal (complete 48/48, interrupted 10/10) and the contract identity. `SLITHER` was not set: Slither
is not installed on this machine, so that step is `SKIPPED` and the manifest's overall result is
`INCOMPLETE`, as in the 2.2.0 run.

Bytecode against `bdf906f`: `TapeoutEntitlementReceipt`, `PoolMath` and `IMining` identical;
`CanaryParticipant` identical except its trailing compiler metadata (it imports the regenerated canary
pool); `TapeoutMinerPool` and `RecoverableTapeoutMinerPool` changed with the same ABI (runtime +2 bytes
each); `TapeoutReceiptDistributor` and `IReceiptDistributor` changed, ABI included (§3.1 of the report).

## How this directory was made

1. **After all code changes,** the recorded run:
   ```bash
   FORK_RPC_URL=https://bsc-mainnet.public.blastapi.io CANARY_FORK_BLOCK=128812145 node --import tsx scripts/verify-all.ts
   ```
   `IDENTITY_BASELINE` was not set, because the contracts differ from `bdf906f` by design; the identities
   are compared separately (step 3).
2. **Copy and restore.** The runner writes into `reports/`. Its outputs were copied into `run/`
   (`reports/canary-local-rehearsal/` became `run/canary-fork/`). The tracked files in `reports/` were then
   restored to `bdf906f` and the run's new top-level files removed, as the earlier runs did. The
   manifest's `reports/…` paths refer to run-time locations.
3. **After the run:** `contract-identity-compare.json`, `bytecode-comparison.json` (against the scratch
   build of `bdf906f`) and `historical-unchanged.json`.

An earlier recorded run on the tree before the last change passed every step except `solidity-tests`
(262 of 264): `verify-all.ts` ran the 2.2.0 review's FFI differential tests (`test/review-fable51/`)
without `--ffi`, which fails the same way at `bdf906f`. `verify-all.ts` now runs that directory in its
own `--ffi` step (`review-fable51-tests`); the run was repeated on the final tree, which is the one
recorded here.
