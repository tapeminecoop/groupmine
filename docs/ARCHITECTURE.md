# Architecture

Four contracts, each deployed and finalized on its own:

| Contract | Holds | Privileged role and what it can do | What remains after finalization |
| --- | --- | --- | --- |
| `TapeoutEntitlementReceipt` (NAND) | — | issuer: `issue`, `retract` (own top IDs only), `finalizeIssuance`, `setURI` | supply fixed forever; until it renounces, the issuer can still change the metadata URI (never balances or supply) |
| `TapeoutEntitlementReceipt` (LATCH) | — | same code, LATCH category | same |
| `TapeoutReceiptDistributor` | receipts until delivered | owner: `allocate`, `revokeWallet`, `finalizeAllocation` (all before finalization only) | nothing: beneficiaries and ranges are immutable |
| `TapeoutMinerPool` | miner NFTs, BEM | owner: `activate` once | nothing: whitelist and protocol addresses are fixed; recipient A or B can only move its own role (`setRecipient`) |

`PoolMath` is the pure accounting library shared by the pool, the tests and (mirrored in TypeScript) the SDK.
`IMining` is the subset of the deployed Mining ABI the pool uses.

```
receipts:     deploy NAND, deploy LATCH ─► issue in batches ─► move into distributor ─► finalizeIssuance (each)
pool:         deploy (receipt addresses, A, B, depositor whitelist, protocol) ─► activate(S_N, S_L) ─► renounce
distributor:  deploy(pool) ─► import JSON allocation ─► verify ─► finalizeAllocation ─► users claim (no deadline)
operation:    whitelisted deposits · anyone harvests · holders claim BEM · anyone releases A and B
```

Activation needs finalized issuance only; the allocation can be finalized before or after it. Receipts
held by the distributor are part of `S_N`/`S_L` and accrue BEM like any other receipt.

## 1. Entitlement receipts

- IDs are issued sequentially: NAND `1..S_N`, LATCH `1..S_L`, each with supply exactly 1. Every ID is
  one equal share of its category; NAND #1 and LATCH #1 are unrelated entitlements.
- `issue(to, count)` mints the next `count` IDs in one batch (the operator can issue to its own wallet
  and transfer later, or issue straight into the distributor). `retract(count)` exists only to undo
  over-issuance before finalization: it burns the highest IDs and only if the issuer still holds them,
  so it can never touch a receipt someone else holds.
- `finalizeIssuance()` is irreversible. `_update` then refuses every mint and burn, so no code path can
  add entitlements, burn and reissue, or change the denominator. Transfers stay ordinary ERC-1155
  transfers; amounts other than 0 or 1 revert, and a holder index (`holderOf`, `holdersPage`) is kept.
- The contract has no immutables, so every deployment has identical runtime code. That is what lets
  the pool verify a receipt by code hash.

## 2. Binding the pool to the receipts

The constructor takes the existing receipt addresses and binds them permanently (immutables). It
accepts them only if they are two different contracts whose runtime code hash equals
`keccak256(type(TapeoutEntitlementReceipt).runtimeCode)` and whose `category()` is the NAND and LATCH
constant respectively. An arbitrary ERC-1155, a proxy, or this receipt compiled with other settings is
rejected (`IncompatibleReceipt`), because none of them is guaranteed to keep unique IDs with a fixed
supply. Receipts must therefore be deployed from this repository's artifacts, which the CLI does.

`activate(expectedNandShares, expectedLatchShares)` (owner, once) requires both collections to have
finalized issuance and their supplies to equal the counts the operator reviewed, and refuses
`S_N + S_L = 0`. The supplies become the pool's permanent denominators.

## 3. Receipt distributor

- **Funding.** Accepts single and batch transfers of the two bound receipts only (`UnsupportedToken`
  otherwise). Refuses any receipt that already has BEM claim history in the pool
  (`ConsumedRewardHistory`) and refuses everything after finalization, so a receipt that was delivered
  can never return as fresh inventory. Anything received before finalization counts as inventory and
  must be allocated.
- **Allocation.** Direct on-chain records. The CLI turns the JSON file
  (`{"allocations":[{"wallet","nandCount","latchCount"}]}`) into ID ranges, deterministically: wallets
  in file order take the lowest available IDs. `allocate(entries)` checks every ID is held by the
  distributor and not yet allocated; the wallet must not be zero, the distributor or the pool; a range
  is at most 1,000 IDs. `revokeWallet` corrects a wallet before finalization. `finalizeAllocation`
  requires both issuances finalized and `allocated == inventory` for each category. After it, no
  function can change a beneficiary or a range.
- **Delivery.** `claim(maxIds)` by the beneficiary, or `deliver(wallet, maxIds)` by anyone, always to
  the recorded wallet: the receiving address cannot be substituted. A delivered counter per range makes
  every ID deliverable once, and a per-wallet cursor (`nextRangeOf`) resumes at the first range with
  undelivered IDs, so a delivery costs only the ranges and IDs it transfers however many were
  delivered before. A receiver hook that reverts reverts the whole delivery. There is no deadline.
- **No administrative route.** The distributor never calls the pool, never approves an operator, and
  can only move a receipt to its beneficiary. Because only a receipt's holder can claim its BEM, the
  income of held receipts stays attached to them; a late claimer receives receipts whose full
  accumulated BEM is still claimable.
- **Why not a Merkle tree.** One round with hundreds to low thousands of wallets fits batched
  `allocate` calls (about 27k gas per ID). On-chain records let the contract itself enforce inventory
  coverage and immutability, and leave no proof files that must stay published.
- **Receivers.** Delivery uses `safeBatchTransferFrom`; a contract wallet without an ERC-1155 receiver
  hook (including some EIP-7702 delegated accounts) can never take delivery, and the distributor never
  redirects it. The CLI refuses such wallets at import and at verification (ERC-165 check).

## 4. Custody pool

### 4.1 Configuration fixed at deployment

Protocol addresses (BEM, Mining, miner collection) must be contracts. Recipients A and B must be
non-zero and not the pool; they may be EOAs or multisigs. The depositor whitelist is mandatory: 1 to 16
unique, non-zero addresses that are not the pool, a protocol contract or a receipt. It has no setter and
is independent of ownership; the owner or deployer is a depositor only if listed.

| Entry point | Who | Notes |
| --- | --- | --- |
| `depositMiners(ids)` | whitelisted depositors | pulls NFTs the caller owns (another account's approval cannot be used) |
| `registerMiners(ids)` | whitelisted depositors | for NFTs that already reached the pool by plain `transferFrom`; same boundary |
| `sync`, `harvest`, `harvestRange` | anyone | |
| `claim`, `claimBatch` | current holder of each receipt ID | ERC-1155 operators must take the ID first |
| `releaseA`, `releaseB` | anyone | pays the configured recipient; independent of each other and of claims |
| `setRecipient(role, to)` | the current recipient of that role | moves the role to a new address; income accrued but not yet released is paid to the new address by the next release |
| `activate` | owner, once | the owner's only power |

There is no pause, upgrade, miner withdrawal, BEM sweep or arbitrary call. A plain ERC-721
`transferFrom` into the pool registers nothing and changes no totals; `safeTransferFrom` into the pool
reverts (no receiver hook). Ownership can be renounced after activation without affecting anything.

### 4.2 Admission boundary

`depositMiners` and `registerMiners` run one atomic sequence (`_admit`):

1. **Validate** the batch (1 to 50 miners, no duplicates, none registered, held by the caller or the
   pool) and read each miner's composition from Mining (§4.3). A miner that burns a category with no
   receipts is refused (`UnsupportedCategory`).
2. **Recognize** BEM already held, under the old composition (`_sync`).
3. **Settle** every registered miner: `Mining.claim(key)` one by one, never skipped because `pending()`
   is zero, then recognize the receipts under the old composition. Any failed claim reverts the whole
   admission (`SettlementFailed`), with one exception: a miner Mining reports as REVOKED (status 2) is
   skipped with `RevokedMinerSkipped`. Revocation is permanent, Mining refuses every claim for it, and
   the revoking transaction already paid the holder (§4.5), so nothing of it can be collected. A
   COOLING (3) or never-started (0) status of a registered miner is unexpected (§4.5) and fails closed.
   `claimMany` is not used because it silently skips failing keys.
4. **Checkpoint** the old period (category incomes frozen as bases), take custody, and add the whole
   batch to the aggregate `N`/`L`.
5. **Collect carried income**: `Mining.claim` for each incoming miner (must succeed), recognized under
   the new post-batch composition.

Because the full batch enters the totals in step 4 before any step-5 income is recognized, every
incoming miner's carried income uses the same composition and the outcome does not depend on order.
Income still unclaimed when the miner arrives belongs to the pool; nothing is paid to the previous
holder by the pool. (Mining's `claim` is permissionless and pays the current holder, so a third party
can still settle a miner to its owner before it is deposited; only income unclaimed at admission
travels with it.)

`registerMiners` is not economically identical to `depositMiners`. Between a plain transfer into the
pool and registration, anyone can call `Mining.claim` for the miner; that income reaches the pool
while the miner is not yet part of the composition, so the next recognition books it under the
composition current at that moment (the registration's step 2), not the post-registration one. The
fork test `testForkPlainTransferThenRegisterWindow` shows the same carried BEM split all-NAND through
this window, against NAND/LATCH by the new composition in an atomic deposit. Use `depositMiners`.

BEM that reaches the pool while no miner is admitted (donations, early third-party claims) is not
recognized, since there is no composition to split it by; the first admission recognizes it in step 5.

### 4.3 Composition source

For miner `id`, the pool reads `getMiner(minerKey(collection, id))` and takes `nandBurn` and
`latchBurn`: the materials actually burned for that miner. It requires the record to be ACTIVE and to
point at this collection and token, cross-checks both values against `cachedBurn(collection, id)`
(which must be cached and equal), and refuses a zero total. Depositors supply only token IDs.
`gateCount`, `stateCount`, `area`, `depth`, `bstar`, `mult`, `bonus` and the verified/unverified
weights describe circuit structure or mining power and are not used. The values are cached in the
miner's registry entry and added to `totalNandBurn`/`totalLatchBurn`; claims never iterate miners.
Composition is permanent: a miner that is later revoked still counts, because its materials were consumed.

Mining also computes a circuit's local burn directly (`circuitBurn`). At block 128,745,229 it equals
the record and the cache for every one of the 17,809 ACTIVE miners. The only circuits whose
collection-recorded gate count (which includes referenced sub-circuits) exceeds their local burn are
7 circuits made entirely of references: local burn 0, never started, so they cannot mine and the pool
refuses them. No currently admissible miner therefore distinguishes local from recursive counting;
the pool's reading is the local burn by construction.

### 4.5 Mining lifecycle the pool relies on

Statuses (official frontend labels): 0 not mining, 1 active, 2 revoked, 3 cooling. Observed on the
deployed implementation (fork tests and read-only chain history; details in the verification report):

- `stop(key)` can be called only by the miner NFT's current holder; it pays the holder exactly what a
  claim would pay at that moment, then sets COOLING; claims then revert. The pool never calls `stop`,
  so a pool-held miner cannot become COOLING.
- `challenge` (anyone, with a counterexample) revokes a miner: the same transaction first pays the
  holder (`Claimed`), then emits `Revoked`. Revoked circuits can never mine again (official frontend;
  restart not executable on a fork).
- Status 0 means never started: no stopped or revoked record was seen returning to 0.
- Restarting a COOLING miner after its cooldown, and whether old debt is reset then, was not executed;
  it does not arise for pool-held miners.

### 4.4 Harvesting and claims

`harvest(ids)`/`harvestRange(start, count)` call `Mining.claim` per miner inside `try/catch`, emit
`MinerHarvested` or `MinerHarvestFailed`, and recognize only the actual balance increase under the
current composition. Claims only read the ledger and the receipt holder index; they never call Mining
and never depend on admissions, so BEM already recognized stays claimable during a Mining outage or a
failing admission. `_pay` checks the exact sender and recipient balance deltas.

## 5. Accounting summary

See [ACCOUNTING.md](ACCOUNTING.md). In short: `A = B = ⌊T/102⌋`, receipts share `⌊100T/102⌋`; each
admission closes a composition period by freezing category totals, and income recognized afterwards
is split by the new `N/(N+L)`; per-ID claimed history makes unclaimed income follow the receipt.

## 6. Scale

Strict settlement claims every registered miner inside each admission, so admission gas grows
linearly with the registry. BSC caps a transaction at 2^24 = 16,777,216 gas (BEP-652, live since the
Mendel upgrade on 2026-04-28).

- **Measured on the real protocol:** up to 24 registered miners (BSC fork, block 128,713,128), at most
  27.8k gas per additional registered miner.
- **Measured on the mock only:** up to 400 registered miners, about 22k each.
- **Extrapolated:** about 590 registered miners before a single-miner admission exceeds the cap.
- **Planning model:** the CLI stops planning admissions at 401 registered miners (300k + 30k per
  registered + 250k per incoming miner, against a 3/4 budget). This is a tooling bound, not an
  on-chain limit and not a guarantee for every miner: real per-miner claim costs can vary.

Beyond the limit, harvesting, claims and payments keep working but no further miners can be admitted
under this boundary. Measurements are in [VERIFICATION_REPORT.md](VERIFICATION_REPORT.md).

## 7. Trust assumptions

- **Protocol.** The pool binds to the proxy addresses and checks nothing about their implementations
  at admission time. At block 128,713,128:
  - **Mining** is a UUPS proxy whose `owner()` is the zero address, so the owner-gated upgrade and
    pause functions can no longer be called (a stranger's `upgradeToAndCall` and `pause` revert on the
    fork).
  - **The miner collection** is a beacon proxy whose beacon owner, `0x6822…F7e2` (a contract), can
    still change its implementation.

  `protocol-check` is an off-chain operator check of implementation addresses and code hashes; the pool
  does not enforce it. A semantic change behind an unchanged interface (for example in the collection)
  would not be caught by the pool's field-consistency checks.
- **BEM** must stay a plain ERC-20 (no fee, rebase or forced debit). Payments with unexpected deltas
  revert, and a balance below the ledger makes recognition revert (`BalanceDecreased`) instead of
  rewriting history; claims are then blocked until the balance is restored.
- **Recipients** control their own role; a lost recipient key leaves that 1/102 unclaimable but affects
  nothing else.
- **No audit.** The contracts have not been audited and were not deployed to BSC mainnet.
