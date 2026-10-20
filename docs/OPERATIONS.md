# Operations Runbook

All commands are `npm run pool -- <command> [flags]` (source: [cli/pool.ts](../cli/pool.ts)). Output is
JSON. **The CLI never handles private keys.** Every write command returns a reviewed plan: target,
calldata, a description, the equivalent `cast send` command, and a simulation when `--from` and
`--rpc-url` are given. Execute it with one of:

- `--safe-json FILE` — Safe{Wallet} Transaction Builder batch (Transaction Builder → Load). Use when
  the pool owner is a Safe (recommended).
- the printed `cast send … <SIGNER_FLAGS>` commands with `--ledger`, `--account <keystore>`, etc.
- `--send-local --from ADDR` — only for a loopback Anvil node (refused anywhere else). Add
  `--impersonate` on a fork.

Set `RPC_URL` (or pass `--rpc-url`) for anything that reads the chain.

## 1. Prepare inputs (offline)

1. **Pool definition** — copy `deployments/examples/pool.bsc.example.json`: protocol addresses, owner
   (a Safe is recommended), receipt names/symbols/URIs, `nandShares` (S_N), `latchShares` (S_L),
   `historicalNandShares` (H_N), `historicalLatchShares` (H_L), `nandWeight` (fraction with up to 8
   decimals; LATCH gets the remainder), fee and historical recipients.
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
