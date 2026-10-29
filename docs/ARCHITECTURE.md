# Architecture

Four contract types, five deployments per processor, each deployed and finalized on its own. Since
2.3.0 a processor has two custody pools, the **Optimal Pool** and the **Regular Pool**, which share one
NAND/LATCH receipt pair and one distributor (§2a):

| Contract | Holds | Privileged role and what it can do | What remains after finalization |
| --- | --- | --- | --- |
| `TapeoutEntitlementReceipt` (NAND) | — | issuer: `issue`, `retract` (own top IDs only), `finalizeIssuance`, `setURI` | supply fixed forever; until it renounces, the issuer can still change the metadata URI (never balances or supply) |
| `TapeoutEntitlementReceipt` (LATCH) | — | same code, LATCH category | same |
| `TapeoutReceiptDistributor` (one, for both pools) | receipts until delivered | owner: `allocate`, `revokeWallet`, `finalizeAllocation` (all before finalization only) | nothing: its two pools, beneficiaries and ranges are immutable |
| `TapeoutMinerPool` (Optimal and Regular, same code) | miner NFTs, BEM (each pool its own) | owner: `bindDistributor` once (before activation), `activate` once | nothing: distributor, whitelist, protocol addresses, weights and the sink address are fixed; recipient A or B can only move its own role (`setRecipient`) |

Since 2.2.0 (SALUS finding #3) a pool's custody cannot begin while any of these powers remains: its
first admission requires both issuances and the allocation finalized and four contracts renounced, the
two shared receipts, the shared distributor and the pool itself (§4.6).

`PoolMath` is the pure accounting library shared by the pool, the tests and (mirrored in TypeScript) the SDK.
`IMining` is the subset of the deployed Mining ABI the pool uses.

```
receipts:     deploy NAND, deploy LATCH ─► issue in batches ─► move into distributor ─► finalizeIssuance (each)
pools:        deploy Optimal and Regular (same receipt addresses and protocol; own A, B, whitelist, name)
distributor:  deploy(owner, optimalPool, regularPool) ─► import JSON allocation ─► verify ─► finalizeAllocation
each pool:    bindDistributor(distributor) ─► activate(S_N, S_L)
renounce:     NAND receipt, LATCH receipt, distributor (once, shared), each pool ─► that pool's custody may begin
operation:    per pool: whitelisted deposits (the first one checks finality) · anyone harvests · holders claim
              BEM · anyone releases A or B (each also pays C) · shared: beneficiaries take their receipts
              once (no deadline), and the receipts then earn in both pools
```

Activation needs finalized issuance, the reviewed supplies, a bound distributor and that distributor's
allocation finalized. Receipts held by the distributor are part of `S_N`/`S_L` in both pools and accrue
BEM in each pool like any other receipt.

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

`bindDistributor(distributor)` (owner, once, before activation) binds the round's distributor. It must
be a contract that counts this pool among its two pools and reports these receipts
(`isPool(address(this))`, `nandReceipt()`, `latchReceipt()`); afterwards nothing can replace it. Both
pools of a processor bind the same distributor, each with its own call. The pool cannot verify the distributor's code: its immutables differ
per deployment, so its code hash does too. The operator's deployed-code identity check (masked
comparison with the SDK template, `verify-deployment`, run before every write) is what proves the bound
contract is the reviewed `TapeoutReceiptDistributor`; a contract that merely mimics the views could be
bound by a dishonest owner before activation (test `testBindingChecksReportedViewsNotCode`).

`activate(expectedNandShares, expectedLatchShares)` (owner, once) requires both collections to have
finalized issuance and their supplies to equal the counts the operator reviewed, refuses
`S_N + S_L = 0`, and requires the bound distributor's allocation to be finalized. The supplies become the
pool's permanent denominators.

## 2a. Two custody pools, one distributor (2.3.0)

New in 2.3.0 and not covered by the SALUS assessment or the internal reviews
([TWO_POOL_DISTRIBUTOR_CHANGE.md](TWO_POOL_DISTRIBUTOR_CHANGE.md)).

- **Fixed pair.** The distributor's constructor takes `(owner, optimalPool, regularPool)` and stores
  both as immutables (`optimalPool()`, `regularPool()`). It refuses a zero or code-less pool
  (`InvalidAddress`), the same pool twice (`DuplicatePool`), pools whose `nandReceipt()` or
  `latchReceipt()` differ (`IncompatiblePoolReceipts`), and pools whose `bem()`, `mining()` or
  `minerCollection()` differ (`IncompatiblePoolProtocol`), i.e. pools of another processor. Its receipts
  are the pools' receipts. There is no setter, registration or list: membership is
  `isPool(candidate)`, true for exactly these two addresses.
- **Binding.** Each pool binds the distributor once, before its own activation, with the same checks as
  before plus membership (§2). A third pool cannot bind it, even with the same receipts. The pools do
  not read each other: one may be bound, activated and holding miners while the other is still unbound.
  Neither pool checks which distributor the other bound; the operator's deployment check requires both
  bound to the addresses file's distributor (an accepted limitation, §7).
- **One issuance, one allocation.** The receipts are issued once; the distributor holds the round's
  inventory, allocates each ID once and delivers it once, to its beneficiary. A delivered receipt
  earns in both pools at once: each pool pays its own income for it.
- **Shared finality.** The distributor and the receipts are part of both pools' first-admission
  conditions (§4.6): while the allocation is open, neither pool activates; while the distributor or a
  receipt keeps an owner, neither pool admits a miner. Each pool's own ownership gates only that pool.
- **Independent pools.** Each pool keeps its own miners, composition, ledger, per-ID claim history
  (`claimed`), carried-income records, recipients, sink payments and custody state. A claim in one pool
  never reads or changes the other's. Unpaid entitlement follows a receipt's transfer in each pool
  separately.
- **Labels only.** "Optimal" and "regular" are the deployment's names for the two roles. The contracts
  treat both pools alike; neither checks any Mining property (such as an optimal flag) of the miners it
  admits, so which miner goes to which pool is the depositors' choice.

## 3. Receipt distributor

- **Funding.** Accepts single and batch transfers of the two bound receipts only (`UnsupportedToken`
  otherwise). Refuses any receipt that already has BEM claim history in either pool
  (`ConsumedRewardHistory`; both pools' `claimed` are read for every ID) and refuses everything after
  finalization, so a receipt that was delivered can never return as fresh inventory. Anything received before finalization counts as inventory and
  must be allocated.
- **Allocation.** Direct on-chain records. The CLI turns the JSON file
  (`{"allocations":[{"wallet","nandCount","latchCount"}]}`) into ID ranges, deterministically: wallets
  in file order take the lowest available IDs. `allocate(entries)` checks every ID is held by the
  distributor and not yet allocated; the wallet must not be zero, the distributor or either pool; a
  range is at most 1,000 IDs. `revokeWallet` corrects a wallet before finalization. `finalizeAllocation`
  requires both issuances finalized and `allocated == inventory` for each category. After it, no
  function can change a beneficiary or a range.
- **Delivery.** `claim(maxIds)` by the beneficiary, or `deliver(wallet, maxIds)` by anyone, always to
  the recorded wallet: the receiving address cannot be substituted. A delivered counter per range makes
  every ID deliverable once, and a per-wallet cursor (`nextRangeOf`) resumes at the first range with
  undelivered IDs, so a delivery costs only the ranges and IDs it transfers however many were
  delivered before. A receiver hook that reverts reverts the whole delivery. There is no deadline.
- **No administrative route.** The distributor makes no state-changing call to either pool (it only
  reads their claim history while accepting inventory), never claims BEM, never approves an operator,
  and can only move a receipt to its beneficiary. Because only a receipt's holder can claim its BEM, the
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
non-zero and neither the pool nor the sink address; they may be EOAs or multisigs. The sink C
(`SINK = 0x000000000000000000000000000000000000dEaD`) and the weights 80 : 1 : 1 : 2 are code
constants. The depositor whitelist is mandatory: 1 to 16 unique, non-zero addresses that are not the
pool, a protocol contract or a receipt. It has no setter and is independent of ownership; the owner or
deployer is a depositor only if listed.

| Entry point | Who | Notes |
| --- | --- | --- |
| `depositMiners(ids)` | whitelisted depositors | pulls NFTs the caller owns (another account's approval cannot be used); the supported admission path |
| `registerMiners(ids)` | whitelisted depositors | for NFTs that already reached the pool by plain `transferFrom`; same boundary; not a supported production path (§4.2) |
| `sync`, `harvest`, `harvestRange` | anyone | |
| `claim`, `claimBatch` | current holder of each receipt ID | ERC-1155 operators must take the ID first |
| `releaseA`, `releaseB` | anyone | pays the configured recipient its unpaid part and transfers C's whole unpaid part to the sink, atomically (both or neither); independent of each other and of claims |
| `setRecipient(role, to)` | the current recipient of that role | moves the role to a new address; income accrued but not yet released is paid to the new address by the next release |
| `bindDistributor` | owner, once, before activation | binds the round's distributor permanently |
| `activate` | owner, once | with `bindDistributor`, the owner's only powers |

There is no pause, upgrade, miner withdrawal, BEM sweep or arbitrary call. A plain ERC-721
`transferFrom` into the pool registers nothing and changes no totals; `safeTransferFrom` into the pool
reverts (no receiver hook). After activation the owner has no power left, and custody requires the pool's
ownership renounced.

### 4.2 Admission boundary

`depositMiners` and `registerMiners` run one atomic sequence (`_admit`):

1. **Validate** the batch (1 to 50 miners, no duplicates, none registered, held by the caller or the
   pool) and read each miner's composition from Mining (§4.3). A miner that burns a category with no
   receipts is refused (`UnsupportedCategory`). The first admission also checks custody finality (§4.6).
2. **Recognize** BEM already held, under the old composition (`_sync`).
3. **Settle** every registered miner: `Mining.claim(key)` one by one, never skipped because `pending()`
   is zero, then recognize the receipts under the old composition. Any failed claim reverts the whole
   admission (`SettlementFailed`), with one exception: a miner Mining reports as REVOKED (status 2) is
   skipped with `RevokedMinerSkipped`. Revocation is permanent, Mining refuses every claim for it, and
   the revoking transaction already paid the holder (§4.5), so nothing of it can be collected. A
   COOLING (3) or never-started (0) status of a registered miner is unexpected (§4.5) and fails closed.
   `claimMany` is not used because it silently skips failing keys.
4. **Checkpoint** the old period: its NAND and LATCH entitlements are frozen with their fractions. Take
   custody of the batch and register it.
5. **Collect carried income**: `Mining.claim` for each incoming miner on its own (each must succeed). The
   pool's balance increase from that one claim is the miner's carried income; it is recorded in the
   miner's entry, split by **that miner's own** NAND : LATCH burn and recognized at the boundary
   (SALUS finding #2, docs/ACCOUNTING.md §4).
6. **Update the composition** with the whole batch, then recognize anything else held (only possible at a
   first admission: BEM that arrived while no composition existed) as ordinary income of the new period.

Carried income never passes through the aggregate split, so neither the batch order nor splitting the
same miners over several admissions changes the outcome (at the same timestamp, to the ledger unit).
Income still unclaimed when the miner arrives belongs to the pool; nothing is paid to the depositor or
the previous holder by the pool. (Mining's `claim` is permissionless and pays the current holder, so a
third party can still settle a miner to its owner before it is deposited; only income unclaimed at
admission travels with it.)

**Supported and unsupported admission paths (SALUS finding #1).** The supported production path is
`depositMiners` by a whitelisted wallet that owns an ACTIVE miner and approved the pool: validation,
transfer, registration and accounting happen in one transaction, and any failure (a miner revoked or not
ACTIVE, an inconsistent burn record, a failing claim of an old or incoming miner, a missing approval)
reverts all of it, leaving the miner with the wallet. A plain ERC-721 transfer into the pool registers
nothing; `registerMiners` exists for such NFTs, but it is not part of the production procedure:

- between the plain transfer and the registration anyone can call `Mining.claim` for the miner, and that
  income reaches the pool while the miner is not yet part of the composition, so it is booked under the
  composition current at that moment (fork test `testForkPlainTransferThenRegisterWindow`);
- a miner revoked before its registration can never be registered (`MinerNotActive`). Its revocation
  payout reaches the pool as held BEM. If no valid miner is ever admitted it stays unrecognized forever;
  if one is admitted later, it is recognized as ordinary income of that admission's new period, under
  that admission's composition, never as the revoked miners' carried income
  (`testUnsupportedDirectTransferThenRevocationLeavesItsIncomeUnrecognized`). The NFT stays in the pool:
  there is no withdrawal.

No administrator withdrawal, sweep, privileged registration or reward redirection exists for these
cases, by design. Unsolicited NFT transfers are not guaranteed to be recoverable, registered or eligible
for BEM.

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

Statuses (official frontend labels): 0 not mining, 1 active, 2 revoked, 3 cooling. Established for
Mining implementation `0xa3DB…f898`, which can no longer be replaced because its owner is renounced.
The evidence is the deployed bytecode, fork tests and read-only chain history; details are in
[MINING_LIFECYCLE.md](MINING_LIFECYCLE.md) and the verification report §3.2.

- Only three functions write a miner's status: `start` (→ ACTIVE), `stop` (→ COOLING) and
  `challenge` (→ REVOKED). Status 0 is never written back.
- `stop(key)` can be called only by the miner NFT's current holder, and only on an ACTIVE miner. It
  pays the holder exactly what a claim would pay at that moment, removes the miner's weight and sets
  COOLING; claims then revert. The pool never calls `stop`, so a pool-held miner cannot become
  COOLING.
- `challenge` (anyone, with a task vector the circuit fails) revokes an ACTIVE miner. The same
  transaction first pays the holder (`Claimed`), then removes the weight and emits `Revoked`. A
  COOLING miner can also be revoked, without payment, until block `stopBlock + 1,200`.
- REVOKED is terminal. `start` refuses it, every claim reverts, and nothing accrues to it, since its
  weight is gone and settlement runs only for ACTIVE miners. Its `debt` field is a frozen accumulator
  checkpoint, not an amount owed. For a pool-held miner the revocation payment reaches the pool in
  the challenge transaction, and the next recognition books it (admission step 2 or a harvest).
- A COOLING miner can be restarted (`start`) only by its holder and only from block
  `stopBlock + 1,201`. The restart restores the weight and resets the debt to the current
  accumulator, so the cooling period earns nothing and income accrues from the restart. This does
  not arise for pool-held miners.

### 4.4 Harvesting and claims

`harvest(ids)`/`harvestRange(start, count)` call `Mining.claim` per miner inside `try/catch`, emit
`MinerHarvested` or `MinerHarvestFailed`, and recognize only the actual balance increase under the
current composition. Claims only read the ledger and the receipt holder index; they never call Mining
and never depend on admissions, so BEM already recognized stays claimable during a Mining outage or a
failing admission. `_pay` checks the exact sender and recipient balance deltas.

### 4.6 Custody finality (SALUS finding #3)

The production model is one issuance and one distribution. Once real miner custody begins, no privileged
account may still be able to change receipt supply, alter the distribution, or administer the
initialization. The first successful admission (`depositMiners` or `registerMiners`) therefore requires:

| Contract | Required |
| --- | --- |
| NAND receipt | `issuanceFinalized()`, supply equal to the pool's `S_N`, `owner() == address(0)` |
| LATCH receipt | `issuanceFinalized()`, supply equal to the pool's `S_L`, `owner() == address(0)` |
| Distributor (the bound one) | `allocationFinalized()`, `owner() == address(0)` |
| Pool | `active`, `owner() == address(0)` |

With two pools (2.3.0), each pool checks this table for itself at its own first admission. The receipts
and the distributor are the same contracts for both, so an unfinished allocation blocks both pools'
activation and an unrenounced receipt or distributor blocks both pools' first admission; each pool's own
row gates only that pool.

Activation already establishes the finalizations and supplies, and they are irreversible; the first
admission adds the four renunciations (`OwnershipNotRenounced(contract)` otherwise) and then latches
`custodyOpen` (event `CustodyOpened`). A renounced owner cannot come back (Ownable2Step clears a pending
transfer when renouncing), so later admissions do not re-read the other contracts: renunciation adds no
liveness dependency. The pool never renounces anything on another contract's behalf, and no admission
renounces anything; the operator renounces each contract before custody begins (`renounce`, docs/
OPERATIONS.md §8).

What remains: ordinary receipt transfers, permissionless delivery of finalized allocations, whitelisted
admissions, harvests, BEM claims, and A/B releases with C, all without any owner. What finality does not
do: it does not authenticate the off-chain contribution records, the allocation JSON or the receipts
issued before finalization; a compromised or mistaken setup key could still have issued or allocated
wrongly before that point (a multisig during initialization remains a sensible protection). It also
cannot authenticate the bound distributor's code (§2). The zero owner proves only that nobody can change
anything afterwards.

## 5. Accounting summary

See [ACCOUNTING.md](ACCOUNTING.md). In short (displayed weights 100 : 1.25 : 1.25 : 2.5):
`A = B = ⌊T/84⌋`, `C = ⌊2T/84⌋` paid to the fixed sink with every release, receipts share `⌊80T/84⌋`;
each admission closes a composition period by freezing the category entitlements (fractions kept in a
ledger of 1/(84·10^18) BEM units), an incoming miner's carried income is split by its own burn, and income
recognized afterwards is split by the new `N/(N+L)`; per-ID claimed history makes unclaimed income follow
the receipt.

## 6. Scale

Strict settlement claims every registered miner inside each admission, so admission gas grows
linearly with the registry. BSC caps a transaction at 2^24 = 16,777,216 gas (BEP-652, live since the
Mendel upgrade on 2026-04-28).

- **Measured on the real protocol:** up to 24 registered miners (BSC fork, block 128,713,128), at most
  27.9k gas per additional registered miner (2.2.0). The first admission, which also opens custody and
  writes the ledger's first values, used 514,781 gas for one miner (2.1.0: 398,165); later admissions
  cost about 9.7k more than under 2.1.0.
- **Measured on the mock only:** up to 400 registered miners, about 22k each.
- **Extrapolated:** about 590 registered miners before a single-miner admission exceeds the cap.
- **Planning model:** the CLI stops planning admissions at 401 registered miners (300k + 30k per
  registered + 250k per incoming miner, plus 150k for the admission that opens custody, against a 3/4
  budget). The fork scaling test asserts every measured admission fits this bound. It is a tooling bound,
  not an on-chain limit and not a guarantee for every miner: real per-miner claim costs can vary.

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
  revert (a release checks the pool's, the role's and the sink's balances), and a balance below the
  ledger makes recognition revert (`BalanceDecreased`) instead of rewriting history; claims are then
  blocked until the balance is restored.
- **Recipients** control their own role; a lost recipient key leaves that 1/84 unclaimable but affects
  nothing else.
- **Sink.** C's 2/84 is transferred to `0x…dEaD`, which nobody is known to control; BEM keeps counting
  it in `totalSupply` (observed on the fork). If BEM ever refused transfers to that address, releases
  of A and B would revert with it (one atomic payment), while receipt claims would continue.
- **Distributor code.** The pool trusts the distributor it was bound to for `isPool()`,
  `allocationFinalized()` and `owner()`; that it is the reviewed code is established off chain by the
  deployed-code identity check.
- **One distributor for both pools.** Neither pool reads the other's binding (no cross-pool dependency),
  so before binding a pool could bind any genuine distributor that counts it, for example a second one
  built for the same two pools. The deployment check (`verify-deployment`, before every write) requires
  both pools bound to the addresses file's distributor, which must serve exactly the addresses file's
  two pools, and full-round verification requires that distributor to hold and allocate the whole supply.
  Binding still does not prove where receipts sit (as in 2.2.0).
- **Audit scope.** SALUS Security assessed revision `c3cb933` (2.0.0 accounting). 2.1.0 and the 2.2.0
  remediation are not covered by that assessment; docs/SALUS_AUDIT_REMEDIATION_REPORT.md lists what was
  changed in response and asks SALUS to confirm. The 2.3.0 two-pool distributor (§2a) is new code that
  neither SALUS nor the internal reviews covered. Nothing was deployed to BSC mainnet.
