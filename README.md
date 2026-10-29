# TapeOut pooled-mining entitlement system

On-chain side of a pooled TapeOut mining round on BSC. Contributors receive NAND and LATCH
entitlement receipts (ERC-1155); the miners built from the pooled materials are held by a custody
contract that collects their BEM through the real `Mining.claim` path and distributes what it
actually receives:

- **1.25/105** to recipient A, **1.25/105** to recipient B and **2.5/105** to the fixed sink address
  `0x000000000000000000000000000000000000dEaD` (C), which every release of A or B pays by an ordinary
  BEM transfer; on chain these are exactly 1/84, 1/84 and 2/84, each floored on its own;
- **100/105** (80/84) to receipt holders, split between NAND and LATCH: income earned in the pool by
  `N/(N+L)`, the NAND and LATCH actually burned by the admitted miners as reported by Mining, and income
  an incoming miner carries in (earned before its admission) by that miner's own burn;
- within a category, equally per receipt ID; unclaimed BEM follows the receipt when it is transferred.

There is one issuance round and one distribution. Custody begins only after both are final and every
owner (both receipts, the distributor, the pool) has renounced; afterwards miners built from leftover
materials are admitted into the same pool by whitelisted depositors and benefit the existing holders.
Supplies and allocations never change after finalization.

## Contracts

| Contract | Purpose |
| --- | --- |
| [`TapeoutEntitlementReceipt`](src/TapeoutEntitlementReceipt.sol) | Unique-ID ERC-1155 (IDs `1..S`, supply 1 each), deployed separately for NAND and LATCH; batch issuance, then permanent finalization |
| [`TapeoutReceiptDistributor`](src/TapeoutReceiptDistributor.sol) | Holds the receipts, records the imported allocation, lets each wallet claim its own receipts (no deadline) |
| [`TapeoutMinerPool`](src/TapeoutMinerPool.sol) | Miner custody, admission by a fixed depositor whitelist with a strict settlement boundary and per-miner carried-income attribution, a one-time distributor binding and the custody finality gate, BEM ledger, claims, A/B payments that also settle the sink part C |
| [`PoolMath`](src/PoolMath.sol) | Accounting math, mirrored by the SDK |

How it fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Allocation rules and rounding:
[docs/ACCOUNTING.md](docs/ACCOUNTING.md). Operator runbook: [docs/OPERATIONS.md](docs/OPERATIONS.md).
The Mining status lifecycle the pool relies on, established from Mining's deployed bytecode and on
forks: [docs/MINING_LIFECYCLE.md](docs/MINING_LIFECYCLE.md).

The current candidate is `TapeoutMinerPool/2.2.0` (package `2.2.0-rc.1`), the remediation of the SALUS
Security assessment of 2026-10-28 (`Groupmine_audit_report_2026-10-28.pdf`, which covered `c3cb933`):
carried income attributed by each miner's own burn, a fractional category ledger, and custody finality.
What changed, how each finding maps to the current code, how it was verified and what remains open:
[docs/SALUS_AUDIT_REMEDIATION_REPORT.md](docs/SALUS_AUDIT_REMEDIATION_REPORT.md), with the run's evidence in
[reports/salus-remediation-20261029-c78a6d1/](reports/salus-remediation-20261029-c78a6d1/).

Proposed operating constraints, residual risks and pending launch evidence: [Audit assumptions and operational risk acceptance](docs/AUDIT_ASSUMPTIONS.md).

**Historical, for the 2.1.0 candidate (fee split and sink, 2.1.0 accounting).** What changed from 2.0.0,
how it was verified on local chains and BSC forks, and what remained open:
[docs/FEE_SPLIT_CHANGE_REPORT.md](docs/FEE_SPLIT_CHANGE_REPORT.md), with the run's evidence in
[reports/fee-split-20261021-c3cb933/](reports/fee-split-20261021-c3cb933/). The follow-up internal reviews
of that candidate (`8cf31dc`: [Fable](docs/INTERNAL_FEE_SPLIT_REVIEW_8cf31dc_FABLE.md), with its tests in
`test/audit2/` and evidence in `reports/internal-review-8cf31dc/`, plus a separately supplied GPT
report) and their tooling-only remediation, which changes no contract:
[docs/FEE_SPLIT_AUDIT_REMEDIATION_REPORT.md](docs/FEE_SPLIT_AUDIT_REMEDIATION_REPORT.md), with evidence in
[reports/fee-split-remediation-20261021-a74f6d4/](reports/fee-split-remediation-20261021-a74f6d4/).

**Historical, for the 2.0.0 candidate (100 : 1 : 1 of 102, no sink).** These describe the earlier
split and are kept unchanged; none of them validates 2.1.0:
- what was tested and what remained open: [docs/VERIFICATION_REPORT.md](docs/VERIFICATION_REPORT.md),
  with its raw outputs in the top-level `reports/` files;
- relationship to the previous version (`48a2d74`) and reused evidence: [docs/BASELINE.md](docs/BASELINE.md);
- a plan for a future recoverable live test (not executed): [docs/LIVE_TEST_PLAN.md](docs/LIVE_TEST_PLAN.md);
- the bounded mainnet canary that was run, canary-1 built from `c4bc022`:
  [MAINNET_TEST_REPORT.md](MAINNET_TEST_REPORT.md) (recorded outcome
  `PARTIAL_AUTOMATION_FAILED_RECOVERY_AND_ACCOUNTING_PASS`), runbook
  [docs/CANARY_RUNBOOK.md](docs/CANARY_RUNBOOK.md) (which also covers the local-only canary-2 and canary-3);
- the internal security reviews of `f2c8e50` ([Fable](docs/INTERNAL_SECURITY_REVIEW_f2c8e50.md), plus an
  attached GPT review) and their remediation: [docs/AUDIT_REMEDIATION_REPORT.md](docs/AUDIT_REMEDIATION_REPORT.md).

## Repository layout

| Path | Contents |
| --- | --- |
| `src/` | The contracts and the `IMining` protocol interface |
| `test/unit`, `test/invariant` | Foundry unit, fuzz, gas and invariant suites on a mock protocol |
| `test/audit/` | The internal review's suites (as committed with the review, with only their split-dependent parts and the Python reference model adapted to 2.1.0; the originals are at `b846c0c`; the differential test needs `--ffi` for the model) |
| `test/audit2/` | The 2.1.0 follow-up review's suites (Fable, `a74f6d4`), kept as committed |
| `test/remediation/` | Regressions for the review findings: delivery race, duplicate-ID claim preview, rounding policy |
| `test/salus/` | SALUS remediation suites: atomic admission and the unsupported path (#1), per-miner carried income and order independence (#2), custody finality and its invariant campaign (#3) |
| `test/salus-ffi/` | SALUS differential test against an independent Python reference model (needs `--ffi`) |
| `src/canary/` | Recoverable canary contracts (canary only; not part of the production system) |
| `test/fork/` | Real BSC protocol tests on a pinned fork: identity, composition, admission boundary, the sink transfer on real BEM, Mining lifecycle and status transitions, and the SALUS remediation (per-miner carried income and order independence with real miners, the custody gate, an inactive miner refused) (run through `scripts/fork-test.ts`) |
| `sdk/` | TypeScript SDK: ABIs, bytecode, math mirror, config and allocation parsing, transaction plans, readers, gas models |
| `cli/pool.ts` | Operator CLI: plans, simulations, Safe batches, local Anvil execution; never handles keys |
| `script/DeployPool.s.sol` | Optional Foundry deployment path (`DeployReceipts`, `DeployPool`) |
| `scripts/` | Local and fork end-to-end runners (including Safe execution of the CLI's batch files), the `verify` runner, ABI export, report summarizers, read-only protocol probes |
| `scripts/mining-analysis/` | Static analysis of Mining's deployed bytecode for the status lifecycle (Python 3, standard library only) |
| `deployments/examples/` | Example system file, addresses file (the reviewed deployment manifest), allocation file and allocation artifact |
| `reports/` | Raw outputs referenced by the 2.0.0 verification report (top level, historical) and run directories: `fee-split-20261021-c3cb933/` for 2.1.0 |

## Quick start

Requires Node ≥ 20.19 and Foundry 1.4.3.

```bash
npm ci --ignore-scripts
```

```bash
forge build && forge test
```

```bash
npm run test:sdk && npm run typecheck && npm run test:local-e2e
```

Real-protocol checks need an archive-capable BSC endpoint:

```bash
FORK_RPC_URL=https://bsc-mainnet.public.blastapi.io npm run test:fork
```

```bash
FORK_RPC_URL=https://bsc-mainnet.public.blastapi.io npm run test:fork-e2e
```

```bash
FORK_RPC_URL=https://bsc-mainnet.public.blastapi.io npm run test:fork-safe-e2e
```

Everything at once, with a manifest of what ran (`reports/run-manifest.json`; set `SLITHER` to a
slither binary to include static analysis):

```bash
FORK_RPC_URL=https://bsc-mainnet.public.blastapi.io npm run verify
```

Preview how 1,050 BEM would be split for a given composition and receipt supplies:

```bash
npm run pool -- preview --income 1050 --nand-burn 90 --latch-burn 10 --nand-shares 1000 --latch-shares 400
```

## Status

Release candidate. SALUS Security assessed `c3cb933`; 2.1.0 and the 2.2.0 remediation have not been
audited, and SALUS has been asked to confirm the remediation. Not deployed to BSC mainnet; no live-value
transaction was made for 2.1.0 or 2.2.0.
