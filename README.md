# TapeOut pooled-mining entitlement system

On-chain side of a pooled TapeOut mining round on BSC. Contributors receive NAND and LATCH
entitlement receipts (ERC-1155); the miners built from the pooled materials are held by a custody
contract that collects their BEM through the real `Mining.claim` path and distributes what it
actually receives:

- **1/102** to recipient A and **1/102** to recipient B;
- **100/102** to receipt holders, split between NAND and LATCH by `N/(N+L)`, the NAND and LATCH
  actually burned by the admitted miners as reported by Mining;
- within a category, equally per receipt ID; unclaimed BEM follows the receipt when it is transferred.

There is one issuance round. Miners built later from leftover materials are admitted into the same
pool and benefit the existing holders; supplies never change after issuance is finalized.

## Contracts

| Contract | Purpose |
| --- | --- |
| [`TapeoutEntitlementReceipt`](src/TapeoutEntitlementReceipt.sol) | Unique-ID ERC-1155 (IDs `1..S`, supply 1 each), deployed separately for NAND and LATCH; batch issuance, then permanent finalization |
| [`TapeoutReceiptDistributor`](src/TapeoutReceiptDistributor.sol) | Holds the receipts, records the imported allocation, lets each wallet claim its own receipts (no deadline) |
| [`TapeoutMinerPool`](src/TapeoutMinerPool.sol) | Miner custody, admission by a fixed depositor whitelist with a strict settlement boundary, BEM ledger, claims, A/B payments |
| [`PoolMath`](src/PoolMath.sol) | Accounting math, mirrored by the SDK |

How it fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Allocation rules and rounding:
[docs/ACCOUNTING.md](docs/ACCOUNTING.md). Operator runbook: [docs/OPERATIONS.md](docs/OPERATIONS.md).
What was tested and what remains open: [docs/VERIFICATION_REPORT.md](docs/VERIFICATION_REPORT.md).
Relationship to the previous version (`48a2d74`) and reused evidence: [docs/BASELINE.md](docs/BASELINE.md).
A plan for a future recoverable live test (not executed): [docs/LIVE_TEST_PLAN.md](docs/LIVE_TEST_PLAN.md).

## Repository layout

| Path | Contents |
| --- | --- |
| `src/` | The contracts and the `IMining` protocol interface |
| `test/unit`, `test/invariant` | Foundry unit, fuzz, gas and invariant suites on a mock protocol |
| `test/fork/` | Real BSC protocol tests on a pinned fork: identity, composition, admission boundary, Mining lifecycle (run through `scripts/fork-test.ts`) |
| `sdk/` | TypeScript SDK: ABIs, bytecode, math mirror, config and allocation parsing, transaction plans, readers, gas models |
| `cli/pool.ts` | Operator CLI: plans, simulations, Safe batches, local Anvil execution; never handles keys |
| `script/DeployPool.s.sol` | Optional Foundry deployment path (`DeployReceipts`, `DeployPool`) |
| `scripts/` | Local and fork end-to-end runners (including Safe execution of the CLI's batch files), the `verify` runner, ABI export, report summarizers, read-only protocol probes |
| `deployments/examples/` | Example system configuration and allocation files |
| `reports/` | Raw outputs referenced by the verification report |

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

Preview how 1,020 BEM would be split for a given composition and receipt supplies:

```bash
npm run pool -- preview --income 1020 --nand-burn 90 --latch-burn 10 --nand-shares 1000 --latch-shares 400
```

## Status

Release candidate. Not audited, not deployed to BSC mainnet, and no live-value transaction was made.
