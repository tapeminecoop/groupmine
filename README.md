# TapeOut Miner Pool (V1)

A pool contract that holds many TapeOut miner NFTs on BSC, collects their BEM through the real
`Mining.claim` path, and distributes the BEM it actually receives through two ERC-1155 receipt
collections — **NAND** and **LATCH** — plus historical-entitlement recipients and a 2/102 fee.

Built from the engineering baseline [TapeoutMarket/test1](https://github.com/TapeoutMarket/test1) at
commit `9d86a2673dd3b415e5d8ce35cd818d4e73756116` (see [docs/BASELINE.md](docs/BASELINE.md)).

## How it works (one paragraph)

The operator deploys one `TapeoutMinerPool` per round; its constructor deploys the NAND and LATCH
receipt collections. During setup the operator configures the manually decided inputs — receipt share
counts `S_N`/`S_L`, historical shares `H_N`/`H_L`, the NAND weight (8 decimals) and the recipients —
issues every receipt ID `1..S` from the contribution records (unallocated IDs go to an explicit reserve
holder) and deposits completed miners. `activate(configHash)` freezes all of it. From then on anyone
can harvest miners in batches; each receipt holder claims the income attached to the IDs it holds,
and that unclaimed income travels with an ID when it is transferred. For income `R`:
`fee = 2R/102`, `NAND = (100R/102)·W_N`, `LATCH = (100R/102)·W_L`, each split equally over `S + H`
shares, with the historical part paid to its recipient. Accounting is cumulative and exact to the raw
unit; rounding residue is bounded and retained.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/TapeoutMinerPool.sol` | Custody, harvesting, ledger, claims, setup/activation |
| `src/TapeoutReceipt.sol` | Unique-ID ERC-1155 receipt collection (one per category) |
| `src/PoolMath.sol` | Allocation math |
| `src/HistoricalDistributor.sol` | Optional historical recipient that splits one category's historical income among fixed contributor weights ([architecture §8](docs/ARCHITECTURE.md#8-historical-distributor-optional-recipient-contract), CLI `distributor-*` commands) |
| `test/unit`, `test/invariant` | Foundry unit, fuzz and invariant suites (mock protocol) |
| `test/fork/PoolFork.t.sol` | Real BSC protocol fork test (opt-in) |
| `sdk/` | TypeScript SDK: ABIs, exact math mirror, config/allocation parsing, transaction plans, readers |
| `cli/pool.ts` | Operator CLI (plans, Safe batches, local Anvil execution; never handles keys) |
| `script/DeployPool.s.sol` | Optional Foundry deployment script |
| `scripts/` | ABI export, local and fork end-to-end runners |
| `deployments/examples/` | Example pool definition, allocation and historical weights files |
| `docs/` | [Architecture](docs/ARCHITECTURE.md) · [Accounting](docs/ACCOUNTING.md) · [Operations](docs/OPERATIONS.md) · [Baseline](docs/BASELINE.md) · [Verification report](docs/VERIFICATION_REPORT.md) |
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
npm run test:sdk && npm run typecheck
```

```bash
npm run test:local-e2e
```

Real-protocol checks need an archive-capable BSC RPC endpoint:

```bash
FORK_RPC_URL=https://bsc-mainnet.public.blastapi.io npm run test:fork
```

```bash
FORK_RPC_URL=https://bsc-mainnet.public.blastapi.io npm run test:fork-e2e
```

Operator commands (`preview`, `allocate`, `deploy`, `configure`, `issue`, `activate`, `deposit`,
`harvest`, `claim`, `release`, `inspect`, `reconcile`, …) are described in
[docs/OPERATIONS.md](docs/OPERATIONS.md). Example:

```bash
npm run pool -- preview --config deployments/examples/pool.bsc.example.json --income 1020
```

## Status

V1 candidate, not audited and not deployed to BSC mainnet. What was executed, against what, and what
remains unverified is in [docs/VERIFICATION_REPORT.md](docs/VERIFICATION_REPORT.md).
