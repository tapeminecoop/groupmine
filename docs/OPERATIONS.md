# Operations

The whole workflow runs through `npm run pool -- <command>` (`cli/pool.ts`). The CLI never signs and
never reads private keys:

- by default a write command prints its plan: calldata, the equivalent `cast send` command (add your
  own signer flags such as `--ledger` or `--account`) and, with `--from`, a simulation of each step;
- `--safe-json FILE` writes Safe Transaction Builder batch files (add `--safe 0xSafe`). The Safe runs
  a whole file as one transaction: a single entry as a call, several as a DELEGATECALL to
  MultiSendCallOnly. Plans are split into `FILE.1.json`, `FILE.2.json`, … so that each file fits the
  budget, Safe overhead included; execute them in order. Each file's `maxGas` is its bound:
  the plans' bounds plus the Safe's own work. Use it as the gas limit when executing the file
  (§ Safes below);
- `--send-local` executes only against a loopback Anvil node, for rehearsals.

**Two custody pools (2.3.0).** A processor has two custody pools, the Optimal Pool and the Regular
Pool, which recognize the same NAND/LATCH receipt pair and bind the same distributor. The receipts are
issued once and the distributor allocates and delivers each receipt once; each pool then activates,
admits miners, holds custody and accounts on its own, and a receipt holder claims each pool's income
for a receipt separately. Commands that act on a pool take `--pool optimal` or `--pool regular`:
`bind-distributor`, `activate`, `renounce --target pool`, `finality`, `composition`, `deposit`,
`register`, `harvest`, `claim`, `release`, `set-recipient`, `inspect` and `reconcile`. Receipt and
distributor commands (`issue`, `fund-distributor`, `import-allocation`, `verify-allocation`,
`finalize-allocation`, `claim-receipts`, `deliver`, …) act on the shared contracts and take no
`--pool`. "Optimal" and "regular" are labels fixed at deployment: the contracts treat both pools
alike, and neither pool checks any Mining property of the miners it admits (§9).

BSC rejects any transaction whose gas limit exceeds 2^24 (16,777,216; BEP-652). Every plan therefore
carries a worst-case gas bound (`maxGas`, from `sdk/gas.ts`) that the printed `cast` command uses as
`--gas-limit` and local sends use as their limit; plans whose bound exceeds 3/4 of the cap are refused,
and so is a `--batch-size` above a command's maximum. Defaults: 222 IDs per issue (maximum 222), 283
per funding transfer (283), allocation batches of up to 400 IDs split further by range count (459),
up to 300 receipts per delivery transaction (fewer when a wallet's IDs are spread over many ranges;
a wallet that needs more gets several planned deliveries), 200 IDs per BEM claim (386), 100 miners
per harvest (124). Admission batches shrink as the registry grows.

Set `RPC_URL` (or pass `--rpc-url`) and, before any mainnet step, confirm the protocol still matches
what was tested:

```bash
npm run pool -- protocol-check
```

`IDENTITY_MATCHES_RECORDED` is required; `REVIEW_REQUIRED` means Mining, the miner collection or BEM
changed since verification. This is an off-chain check you run: the pool itself never checks protocol
implementations, so repeat it before each admission round. As observed at block 128,713,128, the
miner collection's beacon owner can still upgrade the collection, while Mining's owner is renounced.

## Plan binding and deployed identity

The addresses file, together with the system file when you pass `--system`, is the reviewed
deployment manifest ([example](../deployments/examples/addresses.bsc.example.json)). Every write
command is bound to it before it plans anything:
- **Chain.** The planning node must serve the chain the file names, or the CLI refuses.
- **Contracts.** The listed contracts are checked at one block, the same check `verify-deployment`
  prints:
  - deployed code against the SDK's runtime templates, outside their immutable slots;
  - receipt categories, each pool's receipts and protocol addresses (the two pools must agree), the
    distributor's two pools (exactly the addresses file's optimal and regular pool, in those roles)
    and receipts, and each pool's bound distributor;
  - with `--system`, also the protocol addresses, each pool's whitelist and the owners.
- **Printed `cast` commands.** They carry `--chain <id>`, so a signature is valid only on that chain.
  A local fork also answers chain id 56, so plans made on a loopback development node print that
  node's URL instead of `$RPC_URL`. For any other endpoint, `$RPC_URL` must be the node the plans were
  made on. The output (`castRpc`) gives the planning block's number and hash: check them with
  `cast block <n> --rpc-url "$RPC_URL"`. Remote URLs never appear in output, since they can hold
  credentials.
- **Execution context.** Every result names it: a local development node (Anvil or Hardhat,
  including a fork that answers chain id 56) or a remote node.
- **Safe files.** They need `--safe` (the executing Safe; `--from`, if given, must be the same) and an
  RPC to take the chain id from. The result lists each file's chain id, Safe, targets and sha256:
  compare that hash with the file you load at signing time.

```bash
npm run pool -- verify-deployment --addresses deployments/addresses.json --system deployments/system.json
```

A runtime template hash, as printed by the build or the reports, is not a deployed code hash: the
pool and the distributor fill immutable slots at deployment, at the offsets listed under
`immutableReferences` in `sdk/bytecode.json` (generated from the build; for 2.3.0, 65 occurrences in
the pool, 16 in the distributor and none in the receipts; 2.2.0 had 11 in the distributor and 2.1.0 had
59 in the pool). Since 2.2.0 the check also reads the pool's bound distributor; since 2.3.0 it does so
for both pools: a pool bound to any contract other than the addresses file's distributor is a mismatch,
and an unbound one is noted. Neither pool reads the other's binding on chain, so this check is what
keeps both pools on the one distributor. Deployed identity is the masked
comparison plus the bindings read from the contracts. These are operator guards. They cannot stop an
owner from calling a contract directly, and state can change between planning and execution, so
review the exact payload at signing time.

## Safes

Any role can be a Safe: receipt issuer, pool or distributor owner, recipient A or B, whitelisted
depositor, or allocated wallet. Contract creations cannot go through a Safe, and the CLI refuses to
write such a file. Deploy from an EOA and name the Safe in the system file. For each write step:
1. Pass the Safe as `--from`, which is the caller the preflights check, together with `--safe-json`
   and `--safe`.
2. Load each file in the Transaction Builder.
3. Execute the files in order.

- An allocated Safe must be able to receive ERC-1155, which means its fallback handler declares
  `IERC1155Receiver`. Safes created by Safe{Wallet} use the CompatibilityFallbackHandler, which
  does. `import-allocation` refuses any contract wallet that does not.
- `maxGas` covers up to 10 owner signatures. It also covers the SafeL2 event, which logs the whole
  payload. If you set the gas limit by hand, use `maxGas`.

Tested on a BSC fork with real Safe contracts: SafeL2 1.4.1 and GnosisSafeL2 1.3.0, as 2-of-3 and
10-of-10 Safes. The run covers issuance through renunciation, deposits of real miners, receipt and
BEM claims, and recipient moves. Each file runs with its `maxGas` as the gas limit
(`npm run test:fork-safe-e2e`, `reports/fork-safe-e2e.json`). Not tested: the Safe{Wallet}
interface itself (loading files in the Transaction Builder), Safe modules and guards, and more than
10 signatures.

## 1. Prepare the system file

Copy [`deployments/examples/system.bsc.example.json`](../deployments/examples/system.bsc.example.json)
and fill in the receipt issuer and metadata, the distributor owner, and for each pool under
`pools.optimal` and `pools.regular`: its name (the two must differ), owner, recipients A and B (EOA or
multisig) and depositor whitelist (1 to 16 addresses; include the operator only if it should deposit).
Both pools are deployed against the same protocol addresses and the same receipts. Whitelists cannot be
changed after deployment; a recipient can later move only its own role to a new address
(`set-recipient`, §11).

```bash
npm run pool -- check-system --system deployments/system.json
```

The other commands read an addresses file. `--send-local` runs write it; on BSC create it yourself as
contracts get deployed:

```json
{ "chainId": 56, "nandReceipt": "0x…", "latchReceipt": "0x…", "optimalPool": "0x…", "regularPool": "0x…", "distributor": "0x…" }
```

A system or addresses file written for a single-pool system (2.2.0 and earlier, with a `pool` key) is
refused by name. It is never read as one of the two pools: a 2.2.0 distributor serves one pool only.

## 2. Deploy and issue the receipts

```bash
npm run pool -- deploy-receipts --system deployments/system.json
```

Two independent deployments of the same receipt code (NAND and LATCH). Record both addresses.

This is the one command that can plan without an RPC. Its output then takes the chain from the system
file (`chainSource: CONFIGURED_NOT_RPC_VERIFIED`), and both printed `cast` commands carry `--chain`
with it, so a signature is valid only on that chain. No node was queried, so make sure the `$RPC_URL`
you send with serves that chain. With an RPC, a node that serves another chain is refused before
anything is planned.

Then issue each collection's full supply, to the issuer's wallet or straight into the distributor once
it exists:

```bash
npm run pool -- issue --addresses deployments/addresses.json --category NAND --to 0xIssuer --count 1000 --from 0xIssuer
```

IDs are sequential (`1..S`). An over-issue can be undone before finalization while the issuer still
holds the top IDs: `retract --category NAND --count 5`.

## 3. Deploy the two pools and the distributor

```bash
npm run pool -- deploy --system deployments/system.json --addresses deployments/addresses.json
```

This plans both pool deployments against the one receipt pair. Each pool constructor binds the two
receipt addresses and refuses anything that is not this receipt code with the right categories. Add
`"optimalPool"` and `"regularPool"` to the addresses file, then deploy the one distributor that serves
both:

```bash
npm run pool -- deploy-distributor --system deployments/system.json --addresses deployments/addresses.json
```

The distributor's constructor takes `(owner, optimalPool, regularPool)` and fixes both pools forever.
It refuses a zero or code-less pool, the same pool twice (`DuplicatePool`), pools that report other
receipts (`IncompatiblePoolReceipts`) and pools of another processor, i.e. another BEM, Mining or miner
collection (`IncompatiblePoolProtocol`); the CLI preflight checks the same before planning. There is
no setter: a different pair needs a new distributor before anything is funded.

## 4. Fund the distributor

```bash
npm run pool -- fund-distributor --addresses deployments/addresses.json --category NAND --from 0xIssuer --all-held
```

This round distributes every issued receipt: fund the distributor with the whole supply of both
collections. Every receipt the distributor receives before finalization must later be allocated.
`--ids 1-800` moves a subset, but a round that keeps receipts outside the distributor only verifies
in the explicitly selected partial mode (§6).

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

The import rejects:
- bad or mis-checksummed addresses;
- wallets listed twice;
- empty entries;
- totals that differ from the distributor's inventory;
- contract wallets that cannot receive ERC-1155. A contract wallet must declare `IERC1155Receiver`,
  and both receive hooks must accept a transfer simulated from the receipt contract.

It assigns IDs deterministically (file order, lowest IDs first) and is resumable: re-running it plans
only what is still missing. The artifact records the inventory the IDs were assigned from: the block,
its hash, and the count and sha256 of each category's ID list, the sha256 being over the ascending
decimal IDs joined by `,`. To correct a wallet before finalization, run `revoke-wallet --wallet 0x…`
and import again with `--artifact-out`. A revocation clears all of the wallet's IDs in one
transaction, which fits the budget for wallets of up to about 1,550 IDs. Above that the CLI refuses
the plan, so such a wallet cannot be corrected (see `scripts/largest-wallet-check.ts`).

```bash
npm run pool -- verify-allocation --addresses deployments/addresses.json --artifact deployments/allocation.artifact.json --allocation deployments/allocation.json
```

```bash
npm run pool -- finalize-allocation --addresses deployments/addresses.json --artifact deployments/allocation.artifact.json --allocation deployments/allocation.json --from 0xDistributorOwner
```

`verify-allocation` validates the artifact file, then compares it with the chain at one pinned block
(the result names the block number and hash).

**Identity.** The node's chain id, plus the distributor, both pools and the receipt addresses, must
agree across the addresses file, the artifact and the chain. The configured optimal and regular pool
must be `distributor.optimalPool()` and `distributor.regularPool()`, in those roles: another valid pool
sharing the same receipts is rejected in either role, and so are the two pools swapped. The
distributor's receipts must equal each pool's receipts, and each receipt must report its own category.
The artifact itself names the distributor and the receipts only; one artifact covers both pools.

**Artifact against chain, in both directions.** Every allocated wallet and each of its NAND and
LATCH IDs is checked, so an omitted wallet or an extra ID is reported. Totals are checked too. Delivered
IDs must have left the distributor and undelivered ones must still be in it. Wallets that were revoked
stay listed on chain with no ranges and are not counted.

**Coverage, per category.** The result reports:
- the finalized issued supply;
- the cumulative accepted inventory (it never decreases on delivery);
- assigned, delivered and undelivered counts;
- the receipts that never entered the distributor, with their IDs and holders.

**Reviewed JSON (`--allocation`).** The file's sha256 over its exact bytes must equal the artifact's
`sourceSha256`. Every beneficiary's counts and the totals must match. The ID assignment is recomputed
from the inventory the import used: the recorded inventory, when the current accepted inventory
reproduces its digest, or else the distributor's holdings at that block from historical state. It is
never recomputed from today's remaining availability. If neither source is available, the assignment
is reported `UNVERIFIED` and the allocation is `NOT_READY`. Re-running `import-allocation` with
`--artifact-out` writes an artifact with the inventory record. This checks the operator's approved
input; it cannot tell whether off-chain contributions were real.

**Modes.** By default (full round), finalized supply, intended total, accepted inventory and
assigned IDs must all agree. `--partial` accepts receipts kept outside the distributor: it lists
them, and every positive status then says `PARTIAL`. Use it only when retaining them is intended.

| Status | Meaning |
| --- | --- |
| `MISMATCH` | something disagrees (identity, wallets, IDs, totals, holdings, the reviewed JSON); never finalize |
| `NOT_READY` | everything agrees, but finalization would fail or the round is not covered: issuance not finalized, inventory not fully assigned, supply outside the distributor, a wallet that cannot receive, an unverified ID assignment |
| `READY_TO_FINALIZE` | everything agrees and the whole supply is covered |
| `FINALIZED_AND_MATCHES` | finalized and agrees, whole supply covered; also valid after deliveries and transfers |
| `FINALIZED_INCOMPLETE_COVERAGE` | finalized and agrees, but part of the supply never entered the distributor |
| `READY_TO_FINALIZE_PARTIAL`, `FINALIZED_PARTIAL_AND_MATCHES` | the same in `--partial` mode, with the retained receipts listed |

`finalize-allocation` re-runs this verification on the current state with the reviewed inputs. Both
`--artifact` and `--allocation` are required, and an earlier PASS file is not accepted. It plans
nothing unless the status is `READY_TO_FINALIZE`, or `READY_TO_FINALIZE_PARTIAL` with `--partial`, and
the reviewed JSON is `VERIFIED`. It also refuses:
- an empty allocation, incomplete coverage, an identity mismatch or unfinalized issuance;
- a wallet whose receive hooks fail;
- missing review inputs.

These are operator guards only. The distributor owner can still call `finalizeAllocation` directly,
and state can change between the check and the transaction. Afterwards beneficiaries and ranges are
immutable. Publish the artifact so contributors can see their IDs, and re-run verification after
finalization.

## 7. Bind the distributor and activate each pool

Once the allocation is finalized, each pool's owner binds the round's one distributor in that pool,
once and permanently, and activates it:

```bash
npm run pool -- bind-distributor --addresses deployments/addresses.json --pool optimal --from 0xOptimalPoolOwner
```

```bash
npm run pool -- bind-distributor --addresses deployments/addresses.json --pool regular --from 0xRegularPoolOwner
```

The preflight requires the addresses file's distributor (already checked against the reviewed template
by the deployment check) to count this pool among its two pools, in the role `--pool` names
(`isPool`, `optimalPool()` / `regularPool()`), and to report these receipts; the pool must be unbound
and inactive. On chain the pool checks that the distributor counts it (`isPool(address(this))`) and
reports its receipts; it cannot check the distributor's code, and it does not read the other pool's
binding, which is why the deployment check matters. A third pool, even one with the same receipts,
cannot bind the distributor. Then, for each pool:

```bash
npm run pool -- activate --addresses deployments/addresses.json --pool optimal --nand-shares 1000 --latch-shares 400 --from 0xOptimalPoolOwner
```

The counts must equal the finalized supplies; they become that pool's permanent denominators (both
pools have the same, since they share the receipts). Activation also requires the bound distributor's
allocation to be finalized (the CLI and the contract both refuse otherwise), so the order is: finalize
issuance (§5), finalize the allocation (§6), then in each pool bind and activate. The two pools do not
wait for each other: one can be bound, activated and admitting miners while the other is still being
set up. Receipts still in the distributor keep accruing BEM in both pools for their beneficiaries.

## 8. Renounce ownership

Each contract is renounced separately; renouncing one finalizes nothing else. **Before a pool's first
admission, four contracts must be renounced** (SALUS finding #3): that pool refuses it with
`OwnershipNotRenounced(contract)` until both receipts, the distributor and the pool itself have no owner.
The receipts and the distributor are shared, so they are renounced once and count for both pools; each
pool's own ownership counts for that pool only. While the shared receipts or the shared distributor
keep an owner, neither pool can admit a miner. The pool never renounces anything itself.

```bash
npm run pool -- renounce --addresses deployments/addresses.json --target pool --pool optimal --from 0xOptimalPoolOwner
```

| Target | Renounce after | What it removes |
| --- | --- | --- |
| `nand`, `latch` | `finalize-issuance` | the issuer's `setURI` (metadata only); issuance itself is already closed |
| `distributor` | `finalize-allocation` | nothing further (all admin functions are closed); binding stays possible, since each pool's owner binds |
| `pool --pool optimal`, `pool --pool regular` | that pool's `activate` | nothing further; renouncing **before** binding and activation would make that pool unusable |

The CLI refuses to plan a renunciation before the step in the middle column (issuance not finalized,
allocation not finalized, pool not activated). Then check each pool:

```bash
npm run pool -- finality --addresses deployments/addresses.json --pool optimal
```

`READY_FOR_FIRST_ADMISSION` means every condition holds for that pool (both issuances finalized with
supplies equal to the denominators, the bound distributor counting this pool and finalized, the four
owners zero); `NOT_FINAL` lists what is missing; `CUSTODY_OPEN` means the pool's first admission has
happened. Finality does not prove that the
contribution records or the allocation JSON were right: verify those before finalizing (§6). Using a
multisig for the roles during initialization remains a sensible protection, since the setup keys can
still issue and allocate until they finalize. Deposits, harvests, claims, deliveries and recipient
payments never depend on an owner.

## 9. Admit miners (whitelisted depositors)

Any time after the renunciations:

```bash
npm run pool -- composition --addresses deployments/addresses.json --pool optimal --token-ids 4183,1574
```

```bash
npm run pool -- deposit --addresses deployments/addresses.json --pool optimal --token-ids 4183,1574 --from 0xDepositor
```

Choose the pool deliberately: a miner sits in one pool only, and neither pool checks whether a miner is
"optimal" by any Mining measure. Each pool's admissions settle that pool's registered miners only.

**The supported admission path** (SALUS finding #1) is `deposit` (`depositMiners`): the whitelisted wallet
owns the ACTIVE miners, the plan adds `setApprovalForAll` when needed, and the pool validates, transfers,
registers and accounts for the batch in one transaction. Any failure reverts all of it and leaves the
miners with the wallet. The preflight checks the whitelist, custody finality (before the first
admission), ownership, that Mining reports each miner ACTIVE with matching burn data, unsupported
categories, and gas.

Every admission first claims all registered miners under the old composition. If any registered miner's
claim fails (other than a miner Mining reports as REVOKED, which is skipped with `RevokedMinerSkipped`),
the admission reverts with `SettlementFailed(tokenId, reason)` and nothing changes; retry once the cause
is gone. Each incoming miner's carried income (what its own claim pays during the admission) then goes to
the NAND and LATCH receipts by that miner's own burn (`CarriedIncomeAttributed`); its order in the batch,
or splitting the miners over several admissions at the same time, changes nothing. The depositor keeps
none of it.

**Not supported:** a plain ERC-721 transfer into the pool followed later by `register`
(`registerMiners`). The CLI still plans it (same whitelist and boundary) but warns: income anyone claims
for such a miner before registration is booked under the composition current at that moment, and a miner
revoked in between can never be registered. Its revocation payout then stays unrecognized until a valid
admission, which books it under that admission's composition. Unsolicited NFT transfers are not
guaranteed to be recoverable, registered or eligible for BEM, and no role can withdraw, sweep or
redirect them.

`inspect` reports `registryLimitForSingleAdmission`: 401 registered miners under the CLI's planning
model. That is a tooling estimate, not an on-chain limit or a guarantee for every miner. The real
protocol was measured up to 24 registered miners, and about 590 is the extrapolated point where one
admission no longer fits a BSC transaction.

## 10. Harvest

Anyone can collect income into the pool:

```bash
npm run pool -- harvest --addresses deployments/addresses.json --pool optimal --all --from 0xKeeper
```

A failing miner is reported (`MinerHarvestFailed`) without blocking the others; `--isolate-failures`
leaves such miners out of the plan.

## 11. Users and recipients

| Who | Command |
| --- | --- |
| Allocated wallet takes its receipts (any time; once, for both pools) | `claim-receipts --from 0xWallet` |
| Anyone pushes a wallet's receipts to that wallet | `deliver --wallet 0xWallet --from 0xAnyone` |
| Receipt holder claims BEM from one pool | `claim --pool optimal --from 0xWallet --all` (or `--nand 1-20 --latch 3`); again with `--pool regular` |
| Anyone pays a pool's A and B their unpaid 1/84 each, and C its unpaid 2/84 | `release --pool optimal --from 0xAnyone` |
| A recipient moves its role in one pool | `set-recipient --pool optimal --role A --to 0xNew --from 0xCurrentA` |

Each pool pays its own income for a receipt and keeps its own per-ID claim history: a claim in one pool
leaves the other pool's entitlement and history for that receipt unchanged.

`claim-receipts` and `deliver` plan as many deliveries as the wallet needs (`--max-ids` caps each one).
- **Bounds hold wherever others leave the cursor.** `deliver` is permissionless, and its calldata
  names no cursor. So each planned call's gas bound covers every position someone else's deliveries
  can move the cursor to before it executes, not only the position at planning time. A wallet whose
  later ranges are fragmented therefore gets smaller calls from the start: one range of IDs 1–300
  followed by 300 single-ID ranges gets 91 IDs per call, not 300.
- **Replanning.** `--send-local` re-reads the wallet and replans before every send. For printed or
  Safe plans, replan just before signing.
- **Stale calls.** If someone else delivers everything first, a remaining planned call reverts
  cheaply with `NothingToDeliver`. Nothing is lost: receipts only ever go to the recorded beneficiary.
  Without an on-chain expectation in the call, a stale call cannot be made to succeed.
- **Safe files.** Each delivery goes into its own Safe file, so a stale one cannot roll back another
  plan.

`claim` treats its inputs as sets. A repeated ID is claimed once per category; NAND #1 and LATCH #1
are different receipts. Removed repeats are listed under `normalized`, and the preview
(`expectedPayoutRaw`), the simulation and the transaction all use the same IDs. Only the inputs are
normalized: the pool's raw `claimableBatch` view still counts a repeated ID once per occurrence,
while `claimBatch` pays it once. A preview is what the IDs would pay at the stated block. It neither
promises a later payment nor proves ownership then. IDs the holder does not hold are listed under
`notHeld`, and the transaction would revert with `NotHolder`.

Receipts can be transferred like any ERC-1155; unclaimed BEM moves with each ID, in each pool
separately, and the former holder can no longer claim it in either pool.

A wallet that passes the receive check (ERC-165 plus simulated hooks) may still be unable to call the
pool or to transfer later; only its implementation shows that. Tested end to end on a BSC fork:
- EOAs;
- SafeL2 1.4.1 and GnosisSafeL2 1.3.0 proxies with their CompatibilityFallbackHandler, which received
  delivered receipts, claimed BEM, and transferred a receipt that the new holder then claimed
  (`reports/fork-safe-e2e.json`).

Rehearse any other wallet implementation on a fork before finalizing an allocation to it.

Only the current recipient of a role can move it, and the owner cannot. Income accrued to the role but
not yet released is paid to the new address by the next `release`, so release first if the old
address should receive it. A recipient that loses its key cannot be replaced by anyone.

**The sink (C).** `release` plans `releaseA` then `releaseB`. Each call pays its role and, in the same
transaction, transfers C's whole unpaid `⌊2T/84⌋ − sinkPaid` to the fixed address
`0x000000000000000000000000000000000000dEaD`; so the first call of a `release` normally carries C's
backlog and the second finds nothing left for C. Either call alone also settles C. C has no role, no
`set-recipient` and no command of its own, and nothing else (harvest, sync, deposit, claim) pays it.
The payment is an ordinary BEM transfer to that address, not a burn: on the BSC fork BEM's
`totalSupply` did not change. A release is atomic: if either transfer fails, nothing is paid and both
paid counters stay as they were. `inspect` and `reconcile` show C's accrued, paid and outstanding
amounts; the pool's `sinkClaimable()` view and its `SinkPaid` events give the same.
Each release's planned bound is 300,000 gas (`sdk/gas.ts`): two transfers and three balance checks;
the worst case measured is about 207k (test/unit/GasModel.t.sol).

## 12. Monitoring

- `inspect --pool optimal|regular [--holder 0x…] [--miners --pending]`: that pool, the receipts, the
  distributor (with its two pools), finality, composition, carried-income totals (per miner with
  `--miners`), gas outlook.
- `finality --pool optimal|regular`: that pool's first-admission conditions and custody state (§8).
- `verify-deployment [--system FILE]`: deployed code against the templates and every binding, each
  pool's bound distributor included.
- `reconcile --deep --out FILE`: checks the ledger identities, every per-ID history and every miner's
  carried-income record ([ACCOUNTING.md](ACCOUNTING.md#8-reconciliation-identities)), unpaid C included.
- Useful events: `DistributorBound`, `CustodyOpened`, `MinersAdmitted`, `CompositionCheckpoint`,
  `CarriedIncomeAttributed`, `RevokedMinerSkipped`, `MinerHarvestFailed`, `IncomeRecognized`,
  `ReceiptIncomeClaimed`, `RecipientPaid`, `SinkPaid`, `Delivered`.

`inspect`, `reconcile` and `composition` read the pool's `VERSION` first. They decode its accrual,
reconciliation and ledger-state tuples only for `TapeoutMinerPool/2.3.0`. 2.1.0 changed the accrual and
reconciliation layouts without changing their selectors; 2.2.0 keeps those layouts but changes their
values for carried income and replaces `state()` with `ledgerState()` (other fields), so a 2.1.0 decoder
fails on it instead of misreading it. 2.3.0 keeps every 2.2.0 tuple layout, but this SDK pairs with the
2.3.0 distributor (`optimalPool`, `regularPool`, `isPool`; no `pool()`) and the two-pool addresses
files, so a 2.2.0 pool is refused too and is read with the SDK of its own release.
`RecoverableTapeoutMinerPool/canary-4-local` is also read, but only on a loopback development node. Any
other, missing or unreadable version (2.1.0 and 2.2.0 included) is refused with a diagnostic, never
decoded. `VERSION` is self-reported: it keeps this tooling from misreading a layout,
but it does not authenticate code. The deployment check on every write and `verify-deployment` do that.
A dashboard or script built on an older ABI must move to the 2.3.0 ABI; this SDK cannot protect it.
