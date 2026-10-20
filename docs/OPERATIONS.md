# Operations Runbook

All commands are `npm run pool -- <command> [flags]` (source: [cli/pool.ts](../cli/pool.ts)). Output is
JSON. **The CLI never handles private keys.** Every write command returns a reviewed plan: target,
calldata, a description, the equivalent `cast send` command, and a simulation when `--from` and
`--rpc-url` are given. Execute it with one of:

- `--safe-json FILE` — Safe{Wallet} Transaction Builder batch (Transaction Builder → Load). Use when
  the pool owner is a Safe (recommended). The Safe executes a whole batch file as one transaction, so
  when the plans together could exceed the gas budget below the CLI writes `FILE.1.json`,
  `FILE.2.json`, … instead (`safeBatchFiles`): each is one Safe transaction, execute them in order.
- the printed `cast send … <SIGNER_FLAGS>` commands with `--ledger`, `--account <keystore>`, etc.
- `--send-local --from ADDR` — only for a loopback Anvil node (refused anywhere else). Add
  `--impersonate` on a fork.

Set `RPC_URL` (or pass `--rpc-url`) for anything that reads the chain.

**Gas per transaction.** BSC caps a transaction's gas *limit* at 16,777,216 (2^24; BEP-652, part of
the Mendel hardfork enabled on mainnet 2026-04-28); a transaction above it is rejected whatever the
block gas limit. Every plan carries a worst-case `maxGas` and is sized within 3/4 of the cap
(12,582,912 gas) so that a signer's gas buffer still fits; plans above that are refused. Largest
`--batch-size` per command: `issue` 200, `claim` 400, `deposit`/`register` 40, `harvest` 100,
`distributor-claim` 150 (the defaults are 200, 200, 20, 25 and 100). A simulation (`--from`) marks an
estimate above the budget (`aboveBatchGasBudget`) or the cap (`exceedsTxGasCap`). Anvil does not enforce
the cap, so local rehearsals cannot catch an oversized transaction; see
[VERIFICATION_REPORT.md §4](VERIFICATION_REPORT.md#4-gas). The printed `cast send` commands and
`--send-local` use the plan's `maxGas` as the gas limit instead of an estimate. A transaction that
calls the real Mining contract (`deposit`, `register`, `harvest`) can need more gas when it is
included than when it was estimated (§5 item 5 of the report). Unused gas is not charged, and
`maxGas` is always within the cap. A Safe batch runs as the executing wallet's own transaction: give
it a gas limit of at least `safeBatchMaxGas` (the file's summed bounds) plus about 200,000 for the
Safe and MultiSend.

## 1. Prepare inputs (offline)

1. **Pool definition** — copy `deployments/examples/pool.bsc.example.json`: protocol addresses, owner
   (a Safe is recommended), receipt names/symbols/URIs, `nandShares` (S_N), `latchShares` (S_L),
   `historicalNandShares` (H_N), `historicalLatchShares` (H_L), `nandWeight` (fraction with up to 8
   decimals; LATCH gets the remainder), fee and historical recipients (an account, or a
   `HistoricalDistributor` that splits the category among individual contributors, §8).
2. **Allocation** — from the EOA contribution records (`deployments/examples/allocation.example.json`).
   Entries are `{ "holder", "shares" }` (lowest free IDs, in file order) or `{ "holder", "ids": [...] }`
   (pinned IDs); `reserve` receives every unallocated ID so that `1..S` is complete.
3. Check them:

```bash
npm run pool -- preview --config pool.json --income 1020
```

```bash
npm run pool -- allocate --config pool.json --allocation allocation.json --out issuance.json
```

```bash
npm run pool -- config-hash --config pool.json
```

`preview` shows the exact split of an income amount; `allocate` assigns IDs and fails on duplicates,
out-of-range IDs, over-allocation, zero addresses, or unallocated shares without a reserve;
`config-hash` is the value activation will commit to.

4. **Protocol identity** — compare the live Mining/collection implementations and BEM decimals with
   the recorded values; anything but `IDENTITY_MATCHES_RECORDED` means stop and review:

```bash
npm run pool -- protocol-check --rpc-url "$RPC_URL"
```

## 2. Deploy

```bash
npm run pool -- deploy --config pool.json --rpc-url "$RPC_URL"
```

prints the creation transaction (`cast send --create …`). Alternatively, with Foundry's own signer
support and explorer verification:

```bash
POOL_CONFIG=pool.json forge script script/DeployPool.s.sol:DeployPool --rpc-url "$RPC_URL" --ledger --sender <deployer> --broadcast
```

The owner is a constructor argument, so an EOA can deploy a pool already owned by the Safe. The
pool deploys both receipt collections; read their addresses with `inspect`.

## 3. Setup phase (owner)

```bash
npm run pool -- configure --pool <POOL> --config pool.json --safe-json configure.json
```

```bash
npm run pool -- issue --pool <POOL> --config pool.json --allocation allocation.json --batch-size 200 --safe-json issue.json
```

`issue` is resumable: it skips IDs already issued to the intended holder, refuses to continue if an ID
is held by someone else, and refuses holders that cannot receive ERC-1155 tokens — contracts without
the receiver hook and **EOAs with an incompatible EIP-7702 delegation** (on BSC the well-known test
accounts are delegated, for example). Wrong issuance before activation is corrected with:

```bash
npm run pool -- revoke --pool <POOL> --category NAND --ids 4,5 --safe-json revoke.json
```

Re-run `issue` afterwards. Then check readiness:

```bash
npm run pool -- preflight --pool <POOL> --config pool.json
```

## 4. Deposit miners (owner; before or after activation)

Miners must be fully set up and running, and held by the owner. Do not claim their pending income
first if it is meant for the pool: the pool collects whatever unclaimed income a miner carries when it
is deposited.

```bash
npm run pool -- deposit --pool <POOL> --token-ids 4630,2458,6241 --from <OWNER> --rpc-url "$RPC_URL"
```

adds `setApprovalForAll(pool)` if missing, then `depositMiners` in batches (default 20). Each
registration calls the real `Mining.claim`, so a token Mining does not recognize is rejected. A miner
that reached the pool through a plain `transferFrom` is adopted with `register --token-ids …`.

## 5. Activate (owner, once)

```bash
npm run pool -- activate --pool <POOL> --config pool.json --safe-json activate.json
```

The CLI recomputes the configuration hash from the reviewed file, checks that the on-chain
configuration matches it and that every ID `1..S` is issued, and only then plans
`activate(hash)`. After this the economics, supply and recipients' identities are fixed; the owner
can only deposit more miners and update receipt metadata.

## 6. Running the pool

| Task | Who | Command |
| --- | --- | --- |
| Collect income | anyone (keeper) | `harvest --pool <POOL> --all [--isolate-failures --from <KEEPER>] [--batch-size 25]` |
| Claim | each receipt holder | `claim --pool <POOL> --from <HOLDER> --all` (or `--nand 1,2 --latch 7`) |
| Pay fee and historical income | anyone | `release --pool <POOL>` |
| Hand over a recipient role | current recipient | `set-recipient --pool <POOL> --role FEE --to <NEW>` |
| Status, holdings, miners | anyone | `inspect --pool <POOL> [--holder <ADDR>] [--miners --pending]` |
| Ledger audit | anyone | `reconcile --pool <POOL> --deep --out reconcile.json` |
| Protocol drift | anyone | `protocol-check` |

Notes:

- Harvest whenever convenient; holders can always claim what has already been harvested, and claims
  never call Mining. `pending` values shown by `inspect --pending` are estimates only (the real
  contract reports 0 between global updates while `claim` still pays).
- `--isolate-failures` simulates the harvest, bisects any batch with failures, and leaves failing
  miners out. On chain, a failing miner emits `MinerHarvestFailed` and never blocks the others.
- Claims must be sent by the holder. An approved ERC-1155 operator must transfer the ID to itself
  first. Selling a receipt sells its unclaimed income with it.
- `reconcile --deep` re-derives the allocation off-chain and checks every identity in
  [ACCOUNTING.md](ACCOUNTING.md); run it after releases and before any external reporting.

## 7. Rehearsals

```bash
npm run test:local-e2e
```

runs the whole flow above through the CLI on a local Anvil chain with the mock protocol, and

```bash
FORK_RPC_URL=<archive BSC RPC> npm run test:fork-e2e
```

runs it on a local Anvil fork of real BSC state (real miners moved by impersonation; nothing is sent
to BSC). Use the latter to rehearse a real round with its actual miner IDs.

```bash
npm run test:distributor-e2e
```

rehearses the historical distributor flow of §8 through the CLI on a local Anvil chain. It covers a
pool with the distributor as historical NAND recipient, releases and claims, deep audits, a full
400-contributor list, and the gas guards. Every transaction is planned first, sent with the plan's
`maxGas` as its gas limit, and must use no more than that; one printed `cast send` command is also run
as printed. Results go to `reports/distributor-e2e.json`. Anvil does not enforce BSC's 2^24
per-transaction cap, which is why the plans carry their own bounds.

## 8. Historical distributor (optional)

Use a `HistoricalDistributor` (design in [ARCHITECTURE.md §8](ARCHITECTURE.md#8-historical-distributor-optional-recipient-contract)) when a category's
historical income should reach individual historical contributors instead of one account. Deploy one
per category; nobody owns it and its list can never change, so review the list before it becomes a
recipient.

1. **Weights file** (offline) — copy `deployments/examples/historical-nand.example.json`: `category`
   (`NAND` or `LATCH`), an optional `totalWeight` checksum, and `contributors` as
   `{ "account", "weight", "ref" }`. Weights are positive integers (for example each contributor's
   historical shares); only ratios matter. Any order is fine (the CLI sorts by address), at most 400
   entries, no duplicates; a mixed-case address must carry a valid EIP-55 checksum.

```bash
npm run pool -- distributor-check --weights historical-nand.json --income 80
```

shows the list in contract order with each share, the exact split of an income amount (here 80 BEM)
and its residue, and `contributorsHash`. Once the pool exists, `--pool <POOL> --out args.json` also
writes the constructor arguments, including the ABI-encoded form block explorers ask for.

2. **Deploy** (after the pool; any account, a Safe cannot create contracts):

```bash
npm run pool -- distributor-deploy --weights historical-nand.json --pool <POOL> --from <DEPLOYER> --rpc-url "$RPC_URL"
```

prints the creation transaction (`cast send --create …`) with the same review fields and
`poolChecks` (pool version, BEM, the category's historical share count, current recipient). A
warning that the category has no historical shares means the distributor would receive nothing.
Then check the deployment against the reviewed file; every `fileChecks` entry must be `true`:

```bash
npm run pool -- distributor-inspect --distributor <DISTRIBUTOR> --weights historical-nand.json
```

3. **Make it the recipient**, either before activation (put the distributor address in the pool
   definition's `recipients.historicalNand` or `historicalLatch`, then `configure`, `config-hash` and
   `activate` as in §3–§5) or after activation, sent by the current recipient:

```bash
npm run pool -- set-recipient --pool <POOL> --role HISTORICAL_NAND --to <DISTRIBUTOR> --from <CURRENT_RECIPIENT>
```

Unreleased historical income moves with the role; run `release` first if the current recipient
should keep what accrued so far. This step is final: the distributor cannot hand the role on.

4. **Distribute** (anyone, for example a keeper):

```bash
npm run pool -- distributor-claim --distributor <DISTRIBUTOR> --release --all --from <KEEPER>
```

plans `releaseFromPool` (the pool's release plus a sync) and `claimRange` batches of 100
contributors (`--batch-size` up to 150: 150 first-time payouts cost about 9.5M gas), and prints the
expected payout of every contributor. A contributor can claim for itself with
`--contributor <ADDR> --from <ADDR>`; `--contributor A,B` pays a list. Whoever sends the
transaction, the BEM always goes to the contributors' own accounts. The pool's own `release`
command also delivers historical income; the distributor counts it at its next sync or claim.

5. **Audit** after distributions and before external reporting:

```bash
npm run pool -- distributor-inspect --distributor <DISTRIBUTOR> --deep --out distributor-reconcile.json
```

checks the ledger identities, the residue bound (`≤ n − 1` raw units), that claimed histories sum to
`totalPaid`, that no contributor was paid more than its entitlement, that the off-chain split
matches, and that the stored list hashes to `contributorsHash`. `--contributor <ADDR>` adds one
contributor's weight, entitlement, claimed and claimable amounts.

For more than 400 contributors, name further distributors (deployed for the same pool and category)
as contributors of the recipient distributor, then distribute each level in turn: the parent's
claims pay the child, and the child's own `distributor-claim --all` pays its list (without
`--release`, which only the pool's recipient can use).
