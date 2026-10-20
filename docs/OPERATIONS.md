# Operations

The whole workflow runs through `npm run pool -- <command>` (`cli/pool.ts`). The CLI never signs and
never reads private keys:

- by default a write command prints its plan: calldata, the equivalent `cast send` command (add your
  own signer flags such as `--ledger` or `--account`) and, with `--from`, a simulation of each step;
- `--safe-json FILE` writes a Safe Transaction Builder batch (one Safe transaction: keep its total gas
  under the BSC cap); contract creations cannot go through a Safe, so deploy from an EOA and put the
  Safe in the system file as owner;
- `--send-local` executes only against a loopback Anvil node, for rehearsals.

Every simulated plan is checked against the BSC per-transaction gas cap (2^24). Default batch sizes
come from measured gas models: 231 IDs per issue, 300 per funding transfer, allocation batches sized
by ranges and IDs, 300 receipts per delivery, 200 IDs per BEM claim.

Set `RPC_URL` (or pass `--rpc-url`) and, before any mainnet step, confirm the protocol still matches
what was tested:

```bash
npm run pool -- protocol-check
```

`IDENTITY_MATCHES_RECORDED` is required; `REVIEW_REQUIRED` means Mining, the miner collection or BEM
changed since verification.

## 1. Prepare the system file

Copy [`deployments/examples/system.bsc.example.json`](../deployments/examples/system.bsc.example.json)
and fill in the receipt issuer and metadata, the pool name and owner, recipients A and B (EOA or
multisig), the depositor whitelist (1 to 16 addresses; include the operator only if it should
deposit), and the distributor owner. The whitelist and recipients cannot be changed after deployment.

```bash
npm run pool -- check-system --system deployments/system.json
```

The other commands read an addresses file. `--send-local` runs write it; on BSC create it yourself as
contracts get deployed:

```json
{ "chainId": 56, "nandReceipt": "0x…", "latchReceipt": "0x…", "pool": "0x…", "distributor": "0x…" }
```

## 2. Deploy and issue the receipts

```bash
npm run pool -- deploy-receipts --system deployments/system.json
```

Two independent deployments of the same receipt code (NAND and LATCH). Record both addresses. Then
issue each collection's full supply, to the issuer's wallet or straight into the distributor once it
exists:

```bash
npm run pool -- issue --addresses deployments/addresses.json --category NAND --to 0xIssuer --count 1000 --from 0xIssuer
```

IDs are sequential (`1..S`). An over-issue can be undone before finalization while the issuer still
holds the top IDs: `retract --category NAND --count 5`.

## 3. Deploy the pool and the distributor

```bash
npm run pool -- deploy --system deployments/system.json --addresses deployments/addresses.json
```

The pool constructor binds the two receipt addresses and refuses anything that is not this receipt
code with the right categories. Add `"pool"` to the addresses file, then:

```bash
npm run pool -- deploy-distributor --system deployments/system.json --addresses deployments/addresses.json
```

## 4. Fund the distributor

```bash
npm run pool -- fund-distributor --addresses deployments/addresses.json --category NAND --from 0xIssuer --all-held
```

Use `--ids 1-800` instead of `--all-held` to move a subset. Every receipt the distributor receives
before finalization must later be allocated.

## 5. Finalize issuance

When each collection has exactly the intended supply (`inspect` shows it):

```bash
npm run pool -- finalize-issuance --addresses deployments/addresses.json --category NAND --from 0xIssuer
```

Irreversible: no further mint or burn is possible. Repeat for LATCH.

## 6. Import, verify and finalize the allocation

The allocation file lists wallets and counts only
([example](../deployments/examples/allocation.example.json)); an optional `ref` per entry is kept in
the artifact.

```bash
npm run pool -- import-allocation --addresses deployments/addresses.json --allocation deployments/allocation.json --artifact-out deployments/allocation.artifact.json --from 0xDistributorOwner
```

The import rejects bad or mis-checksummed addresses, wallets listed twice, empty entries, wallets
that are contracts unable to receive ERC-1155, and totals that differ from the distributor's
inventory. It assigns IDs deterministically (file order, lowest IDs first) and is resumable:
re-running it plans only what is still missing. To correct a wallet before finalization, run
`revoke-wallet --wallet 0x…` and import again.

```bash
npm run pool -- verify-allocation --addresses deployments/addresses.json --artifact deployments/allocation.artifact.json
```

```bash
npm run pool -- finalize-allocation --addresses deployments/addresses.json --from 0xDistributorOwner
```

Finalize only on `READY_TO_FINALIZE`. Afterwards beneficiaries and ranges are immutable. Publish the
artifact so contributors can see their IDs.

## 7. Activate the pool

```bash
npm run pool -- activate --addresses deployments/addresses.json --nand-shares 1000 --latch-shares 400 --from 0xPoolOwner
```

The counts must equal the finalized supplies; they become the permanent denominators. Activation does
not wait for the allocation: receipts still in the distributor accrue BEM for their beneficiaries.

## 8. Renounce ownership

Each contract is renounced separately; renouncing one finalizes nothing else.

```bash
npm run pool -- renounce --addresses deployments/addresses.json --target pool --from 0xPoolOwner
```

| Target | Renounce after | What it removes |
| --- | --- | --- |
| `nand`, `latch` | `finalize-issuance` | the issuer's ability to change the metadata URI |
| `distributor` | `finalize-allocation` | nothing further (all admin functions are closed) |
| `pool` | `activate` | nothing further; renouncing **before** activation makes the pool unusable |

Deposits, harvests, claims and recipient payments do not depend on any owner.

## 9. Admit miners (whitelisted depositors)

Any time after activation, including after renunciation:

```bash
npm run pool -- composition --addresses deployments/addresses.json --token-ids 4183,1574
```

```bash
npm run pool -- deposit --addresses deployments/addresses.json --token-ids 4183,1574 --from 0xDepositor
```

The preflight checks the whitelist, ownership, that Mining reports each miner ACTIVE with matching
burn data, unsupported categories, and gas; the plan adds `setApprovalForAll` when needed. Every
admission first claims all registered miners. If an ACTIVE miner's claim fails the admission reverts
with `SettlementFailed(tokenId, reason)`; nothing changes, so retry once Mining recovers. Use
`register` (same rules) only for miners that already reached the pool by plain transfer.

`inspect` reports `registryLimitForSingleAdmission` (401 with the planning model); beyond it
admissions no longer fit a BSC transaction.

## 10. Harvest

Anyone can collect income into the pool:

```bash
npm run pool -- harvest --addresses deployments/addresses.json --all --from 0xKeeper
```

A failing miner is reported (`MinerHarvestFailed`) without blocking the others; `--isolate-failures`
leaves such miners out of the plan.

## 11. Users and recipients

| Who | Command |
| --- | --- |
| Allocated wallet takes its receipts (any time) | `claim-receipts --from 0xWallet` |
| Anyone pushes a wallet's receipts to that wallet | `deliver --wallet 0xWallet --from 0xAnyone` |
| Receipt holder claims BEM | `claim --from 0xWallet --all` (or `--nand 1-20 --latch 3`) |
| Anyone pays A and B their accrued 1/102 each | `release --from 0xAnyone` |
| A recipient moves its role | `set-recipient --role A --to 0xNew --from 0xCurrentA` |

Receipts can be transferred like any ERC-1155; unclaimed BEM moves with each ID and the former holder
can no longer claim it.

## 12. Monitoring

- `inspect [--holder 0x…] [--miners --pending]`: pool, receipts, distributor, composition, gas outlook.
- `reconcile --deep --out FILE`: checks the ledger identities and every per-ID history
  ([ACCOUNTING.md](ACCOUNTING.md#7-reconciliation-identities)).
- Useful events: `MinersAdmitted`, `CompositionCheckpoint`, `InactiveMinerSkipped`,
  `MinerHarvestFailed`, `IncomeRecognized`, `ReceiptIncomeClaimed`, `RecipientPaid`, `Delivered`.
