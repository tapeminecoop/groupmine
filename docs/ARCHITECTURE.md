# Architecture

TapeOut miner pool V1: one contract holds many TapeOut miner NFTs, collects their BEM through the real
`Mining.claim` path, and distributes the BEM it actually receives to two ERC-1155 receipt collections
(NAND and LATCH), two historical-entitlement recipients and a fee recipient. Raw materials, their
prices, the EOA contribution history, miner withdrawal and redemption are outside this version.

## 1. Contracts

```
                   TapeoutMinerPool  (one per fundraising round; Ownable2Step, ReentrancyGuard)
                   ├── custody:   miner NFTs of the configured collection (registry, no exit path)
                   ├── income:    Mining.claim(key) per miner -> BEM balance -> ledger
                   ├── ledger:    totalAccounted / totalPaid, per-bucket paid, per-(category,id) claimed
                   ├── payouts:   receipt claims, fee release, historical releases
                   │
       constructor ├── deploys ─> TapeoutReceipt "NAND"   (ERC-1155, IDs 1..S_N, supply 1 each)
                   └── deploys ─> TapeoutReceipt "LATCH"  (ERC-1155, IDs 1..S_L, supply 1 each)

external (BSC):  miner collection 0xb102…a14C (beacon proxy) · Mining 0x7E2E…7b46 (ERC-1967 proxy)
                 · BEM 0x5ce0…695a (8 decimals)
```

| Contract | Responsibility | Holds funds |
| --- | --- | --- |
| `src/TapeoutMinerPool.sol` | Custody, harvesting, accounting, claims, releases, setup/activation | Miners and BEM |
| `src/TapeoutReceipt.sol` | Unique-ID ERC-1155 receipt for one category; pool is its only minter | Nothing |
| `src/PoolMath.sol` | Pure allocation math (see [ACCOUNTING.md](ACCOUNTING.md)) | — |
| `src/interfaces/IMining.sol` | `minerKey`, `pending`, `claim` (adapted from the baseline) | — |
| `src/HistoricalDistributor.sol` | Optional historical recipient: splits one category's historical income among fixed contributor weights (§8) | BEM until claimed |

**Why this composition.** Both receipt collections share one income stream, so one ledger with a
category split is the simplest correct design: there is no cross-contract settlement, no splitting of
miners into custody groups, and a single place to reconcile. The receipts are separate contracts
because the product needs two independent collections, but they carry no accounting: entitlement is
keyed by `(category, id)` inside the pool, which is what makes income follow the NFT on transfer
without any transfer hook. The pool deploys its receipts in its constructor so the binding is atomic
and immutable (no address prediction, no setter). There is no factory, proxy or upgrade path: a new
round is a new deployment (one transaction), and a deployed pool's rules cannot be changed under its
holders. Contract sizes: pool 18,741 bytes runtime (limit 24,576), receipt 8,154 bytes.

## 2. Lifecycle

### SETUP (owner only)

1. **Configure** (`configure(Config)`): `S_N`, `S_L`, `H_N`, `H_L`, `W_N` (8 decimals, LATCH is the
   remainder), fee recipient, historical NAND/LATCH recipients. Replaceable as a whole until
   activation; a share count can never drop below an already-minted ID.
2. **Issue receipts** from the manual allocation (`issueReceiptRange` for contiguous IDs,
   `issueReceipts` for explicit lists). IDs must be in `1..S`; each ID can exist once. Receipts can be
   sent to contracts only if they implement the ERC-1155 receiver interface.
3. **Correct mistakes** with `revokeReceipts` (burn and re-issue). Only possible before activation.
4. **Deposit miners** at any time (`depositMiners` pulls from the owner after ERC-721 approval;
   `registerMiners` adopts miners that arrived by plain `transferFrom`). See §3.
5. **Activate** with `activate(expectedConfigHash)`, the hash of the configuration the operator
   reviewed off-chain (`npm run pool -- config-hash`). Activation requires:
   - a fee recipient, and a historical recipient for every category with `H > 0`;
   - `S + H > 0` for every category with positive weight (no ownerless income);
   - exactly the IDs `1..S_N` and `1..S_L` issued.

   It then freezes the configuration and supply (`finalizeMinting` on both receipt contracts) and
   recognizes all BEM already in the pool as income.

### ACTIVE

| Who | Can |
| --- | --- |
| Anyone | `harvest`, `harvestRange`, `sync`, `releaseFee`, `releaseHistorical` (pushes to the fixed recipient) |
| Receipt holder | `claim(category, id)`, `claimBatch(nandIds, latchIds)` for IDs it holds; transfer IDs (ERC-1155) |
| Fee / historical recipient | `setRecipient(role, newAddress)` for its own role only |
| Owner | `depositMiners`, `registerMiners`, `setReceiptURI`, ownership transfer (two-step) |

The owner cannot change economics, mint, burn, move receipts, withdraw BEM, withdraw miners, pause,
redirect recipients, or execute arbitrary calls after activation; none of those functions exist.

### Shares, capacity and reserved shares

The **active share count** `S` is the configured denominator, and activation proves every one of
those IDs has a holder. **Minting capacity** is `S − issued` during setup and permanently zero after
activation, so there is never latent supply that could dilute holders or capture income. Shares not
yet allocated to participants are issued to an explicit **reserve holder** (the allocation file's
`reserve`), which is their beneficiary. The reserve can later transfer them to participants; as with
any receipt, unclaimed income moves with the ID, so the reserve claims first if its policy is to keep
income earned while it held them.

### Historical entitlements

`H_N` and `H_L` are extra shares that are not NFTs. Denominators are `S + H`; one historical share
earns exactly what one receipt ID earns. Their accrued income has a ledger of its own
(`historicalClaimable`, `historicalPaid`) and is paid by `releaseHistorical(category)` to the
configured recipient, which may be an EOA, a multisig, or a distribution contract that later splits it
among individual historical contributors (`HistoricalDistributor`, §8). Each entitlement is counted
once: historical rights are never also represented by receipt IDs. The recipient role can be handed
over only by its current holder, carrying its unreleased income with it.

## 3. Custody and harvesting

**Registration.** A miner is registered only if it is from the configured collection, owned by the
pool, not yet registered, and the real `Mining.claim(key)` succeeds for it. That claim both validates
the miner against the real claim path (Mining reverts for keys it does not know) and collects the
income the miner carried into the pool, including income accrued before the deposit; under the
protocol's rules unclaimed income stays with the NFT, and it belongs to the pool like any other
income. ERC-721 `safeTransferFrom` into the pool is rejected (no receiver hook), so unsolicited NFTs
cannot be pushed in through that path.

**Harvesting.** `harvest(tokenIds)` and `harvestRange(start, count)` are permissionless and batched,
so collection scales to any number of miners and is independent from claims: holders only ever claim
income that is already in the pool, and claims never touch `Mining`. Each harvest:

- always calls `Mining.claim(key)`; `pending` is never consulted (the baseline found
  `pending() == 0` while `claim()` paid positive BEM, and the fork test here observes it again);
- isolates failures per miner: a reverting claim emits `MinerHarvestFailed(tokenId, reason)` and is
  counted in the returned `failed`, distinct from a successful zero claim (`MinerHarvested(id, 0)`);
- accounts only the BEM balance increase (sync before and after), never an estimate.

`npm run pool -- harvest --all --isolate-failures` simulates first and bisects to name failing
miners before sending.

## 4. Claims and transfers

- Only the current holder (`balanceOf(caller, id) == 1`) can claim an ID; an ERC-1155 operator must
  transfer the ID to itself first. Third parties cannot push a holder's claim, so a buyer of a receipt
  receives its unclaimed income exactly as the baseline's mainnet test demonstrated.
- `claimBatch` takes both collections in one call; a foreign or out-of-range ID reverts the whole
  batch; a duplicated ID pays once.
- Claims sync first, so BEM that arrived by any route is included.

## 5. Material decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Contract layout | 1 pool + 2 receipt contracts, receipts deployed by the pool | One ledger for one income stream; two independent collections as required; atomic binding |
| Upgradeability | None | Holders' terms cannot change; new terms = new pool |
| Admin | `Ownable2Step` owner with setup powers; after activation only miner deposits and metadata | Manual configuration and issuance need an operator; nothing after activation can hurt holders |
| Economic configuration | Fixed at activation (hash-committed) | Avoids the unharvested-income boundary problem of mid-life changes |
| Issuance | All IDs `1..S` before activation; unallocated IDs go to an explicit reserve | No orphaned or diluting shares; reserved shares have a beneficiary |
| Error correction | `revokeReceipts` before activation only | Manual allocation needs a correction path; none once income can accrue |
| Accounting | Cumulative floors of `T` | Exact conservation, monotonic, path-independent, bounded residue; O(1) per claim |
| Fee and historical payout | Permissionless push to a fixed recipient; role transferable only by its holder | Works with any recipient (including contracts); owner cannot redirect |
| Harvest failure handling | Per-miner isolation with explicit failure events | One bad miner must not block collection from the rest |
| Miner validation | Real `Mining.claim` must succeed at registration | Uses the protocol itself as the validity check; captures carried income |
| Payments | Exact sender/recipient balance deltas | Baseline rule; abnormal BEM behaviour reverts instead of corrupting the ledger |
| EVM target | Paris bytecode (deployed as-is in the fork test on a Cancun EVM) | Conservative; BSC contracts already use PUSH0, so newer targets would also work |

## 6. Relationship to the baseline (TapeoutMarket/test1 @ 9d86a26)

Reused and adapted: the `IMining` interface and its usage rules, balance-based income recognition
(`balance + totalPaid − totalAccounted`), exact-delta payments, the per-ID claimed-history model and
holder index (so income follows the receipt and former holders get `NotHolder`), unique-ID ERC-1155
receipts with supply one, the mock protocol contracts, and many regression scenarios. Not carried
over: Seaport/CircuitMarket purchasing, funding/refunds, the factory/timelock/clone template
machinery, and redemption (including "collect all receipts to withdraw the miner"). Deliberate
differences: many miners instead of one; an owner for the setup phase; two receipt collections with a
fee and historical buckets; per-miner failure isolation in harvest (the single-miner vault propagated
the claim revert). See [BASELINE.md](BASELINE.md).

## 7. Limitations and risks

1. **Miners are locked.** There is no withdrawal, redemption or migration. If the protocol ever needs
   owner-only actions to keep a miner productive (`start`, `stop`, `arm` exist on Mining), the pool
   cannot perform them; miners must be fully set up before deposit. The fork test shows deposited
   miners keep accruing after moving into the pool, at the tested block.
2. **External upgradeability.** The miner collection is a beacon proxy and Mining an ERC-1967 proxy
   (owner zero and sealed at the observed blocks). A protocol upgrade could change claim semantics.
   `npm run pool -- protocol-check` compares implementation addresses and code hashes to the recorded
   values; a mismatch requires review.
3. **BEM assumptions.** Plain, non-rebasing, fee-free ERC-20. Violations make payments revert rather
   than misaccount, which also means payouts stop until the token behaves.
4. **Setup trust.** Allocation is manual and decided by the operator; holders should rely on
   receipts only after activation, when the configuration hash, supply and recipients are fixed.
5. **Carried income at deposit.** The pool captures whatever unclaimed income a miner carries when it
   is deposited. If a depositor claims before depositing, that income never reaches the pool; this is
   operational policy, not something the contract can enforce.
6. **Receipt holders must accept ERC-1155.** Issuance and transfers call the ERC-1155 receiver hook on
   any address with code — contracts and EOAs with an EIP-7702 delegation. A wallet whose delegate
   does not implement the hook cannot receive receipts (observed on BSC for the well-known test
   accounts). `issue` checks holders before sending; operators should collect compatible addresses.
   Fee and historical recipients only receive BEM, so any address works for them.
7. **No rescue path.** Other tokens or NFTs sent to the pool stay there. BEM sent to it is income.
8. **Residue and lost keys.** At most `1 + (S_N+H_N−1) + (S_L+H_L−1)` raw units remain after
   everyone claims; income of IDs whose holders lose their keys stays in the pool.
9. **Batch sizes.** BSC rejects any transaction whose gas limit exceeds 16,777,216 (2^24; BEP-652,
   Mendel hardfork, mainnet 2026-04-28), whatever the block gas limit. The CLI sizes every claim,
   issuance, deposit and harvest transaction, and every Safe batch file, within 3/4 of that cap
   (bounds and measured costs in [VERIFICATION_REPORT.md §4](VERIFICATION_REPORT.md#4-gas)).
10. **Not audited.** Tests, fuzzing, invariants and a fork run are not an independent security audit.

## 8. Historical distributor (optional recipient contract)

`src/HistoricalDistributor.sol` splits one category's historical income among individual historical
contributors by a manually decided weight list. It changes nothing in the pool, which still pays one
recipient per category: the distributor is that recipient.

```
TapeoutMinerPool ── releaseHistorical(NAND) ──> HistoricalDistributor(pool, NAND, list) ── claim ──> contributor accounts
                 ── releaseHistorical(LATCH) ─> HistoricalDistributor(pool, LATCH, list) ── claim ──> contributor accounts
```

**Binding.** One distributor per category, deployed after the pool with `(pool, category, accounts,
weights)`. It takes its BEM address from `pool.bem()`, so it cannot be bound to another token. It
becomes the recipient either through the configuration before activation (its address is part of the
activation hash) or after activation through `setRecipient(role, distributor)` sent by the current
recipient; unreleased income moves with the role, so the previous recipient releases first if it
should keep what accrued during its tenure. The distributor never calls `setRecipient`, so once it
holds a role nobody can move it again.

**Contributor list.** Fixed at deployment: 1 to 400 accounts, strictly ascending by address (which
rejects the zero address and duplicates in one comparison), each with a positive `uint96` weight;
only ratios matter, so weights can be historical share counts, basis points or raw contribution
amounts. The distributor itself and the pool cannot be contributors. Each entry is one storage slot
(account and weight packed). `contributorsHash = keccak256(abi.encode(accounts, weights))` is stored
so a deployment can be checked against the reviewed file without enumerating it. There is no owner,
no withdrawal, no upgrade path, and no way to change, add or remove a contributor or its account.

**Why an explicit list and not a Merkle root.** Historical contributor lists are manual and small (the
example pool has 100 historical NAND shares). Stored on chain, the list lets the contract itself
enforce what a Merkle root could only promise: weights are positive, accounts are distinct, and the
total weight is the real sum of the weights, so entitlements can never add up to more than the
income. A Merkle distributor has to trust an off-chain total; a wrong tree lets early claimants take
other contributors' income. The on-chain list is also enumerable (`contributorsPage`), so anyone can
reconcile `Σ claimed = totalPaid` and a keeper can pay every contributor without proofs. The price is
deployment cost linear in the list, under two protocol limits. The constructor arguments are part of
the creation transaction's initcode, which EIP-3860 limits to 49,152 bytes (about 8 KB of creation
code plus 64 bytes per contributor); and BSC rejects any transaction whose gas limit exceeds 16,777,216
(2^24; BEP-652, EIP-7825). `MAX_CONTRIBUTORS = 400` keeps a full list at 33,865 bytes and 11,180,990
gas, within the 3/4 of the cap that every planned transaction respects (§7 item 9), so a signer's gas
buffer still fits. A longer list is split by nesting: a contributor may itself be a
`HistoricalDistributor` for the same pool and category, whose income arrives through the parent's
claims (its own `releaseFromPool` is not used).

Both limits were checked on BSC with read-only `eth_estimateGas` calls. At block 128,691,535 a
49,152-byte creation was accepted and 49,153 bytes were rejected with `max initcode size exceeded`. On
2026-10-20 (block 128,704,035) five public endpoints running two clients stopped estimating at exactly
16,777,216 gas while the block gas limit was 70,000,000.

**Accounting.** It follows the pool's rules (§1–§3 and §6 of [ACCOUNTING.md](ACCOUNTING.md)). Over
the cumulative recognized income `T`, total weight `W = Σ w`, and `n` contributors:

| Quantity | Formula |
| --- | --- |
| recognized on every sync | `balance + totalPaid − totalAccounted` (reverts `BalanceDecreased` if negative) |
| entitlement of contributor `i` | `floor(T · w_i / W)` (`Math.mulDiv`, exact for any `uint96` weights) |
| claimable | `entitlement_i − claimed_i` |
| residue (retained) | `T − Σ entitlement_i`, always `0 ≤ residue ≤ n − 1` |

Entitlements are cumulative floors, so they are monotonic and path independent, and residue from one
payment is paid out by later income instead of accumulating. A claim sets `claimed_i` to the current
entitlement and pays the difference once; payments require exact balance deltas exactly like the
pool's `_pay`, so a fee-on-transfer or otherwise abnormal token reverts the claim and leaves the history
untouched. Anything that raises the distributor's BEM balance is income: pool releases by any caller
and direct transfers. Identities (`reconciliation()`, checked by `distributor-inspect --deep`):

```
bemBalance + deficit = totalAccounted − totalPaid + unrecognized
totalAccounted       = entitled + residue
Σ claimed_i          = totalPaid,   claimed_i ≤ entitlement_i for every contributor
```

**Claims and releases.**

| Function | Who | Effect |
| --- | --- | --- |
| `releaseFromPool()` | anyone | `pool.releaseHistorical(category)` then sync; reverts `NotPoolRecipient` unless the distributor holds the role |
| `sync()` | anyone | Recognizes BEM that arrived by any route |
| `claim(account)` | anyone | Pays `account` its claimable income |
| `claimBatch(accounts)` | anyone | Same for a list; a duplicated account pays once; an unknown account reverts the batch |
| `claimRange(start, count)` | anyone | Pays contributors `start..start+count−1` of the sorted list (clamped) |

Payouts always go to the contributor's own fixed account, so a third party can push a payment but
never redirect one. Unlike receipt IDs these entitlements are not transferable, so a push cannot take
unclaimed income away from a buyer, which is why receipt claims are holder-only and these are not.
Claims never call the pool: problems in the pool cannot block income already received.

**Worked example (specification numbers).** 1,020 BEM of pool income with the example configuration
gives 80 BEM of historical NAND and 40 BEM of historical LATCH. A NAND distributor with weights
50/30/20 pays 40/24/16 BEM; a LATCH distributor with weights 3/1 pays 30/10 BEM; residue 0
(`DistributorPoolIntegrationTest.testSpecificationExampleReachesIndividualContributors`).

**Tests.** `test/unit/DistributorSetup.t.sol` (constructor validation, cap, initcode size, views),
`DistributorAccounting.t.sol` (exact split, residue, repeated/pushed/batch/range claims, token faults,
path independence, two fuzz tests), `DistributorPoolIntegration.t.sol` (real pool on the mock protocol:
configured recipient, handover after activation, locked role, direct pool release, nesting, many
rounds), `test/invariant/DistributorInvariant.t.sol` (two distributors as the pool's recipients:
conservation against `historicalPaid`, no overpayment, ledger identities, monotonic entitlements).

**Measured costs** (`test/unit/DistributorGas.t.sol` and `BatchGasBudget.t.sol`, written to
`reports/gas-distributor.json` and `reports/gas-batch.json`; cold storage, excluding the 21,000 base and
calldata):

| Operation | Gas |
| --- | ---: |
| Deploy, 1 / 100 / 400 contributors | 1,379,040 / 3,739,559 / 10,933,121 |
| Deploy 400, whole transaction on a local Anvil node (Prague rules) | 11,180,990 |
| `releaseFromPool` | 155,205 |
| `claim`, first payment | 113,263 |
| `claimBatch`, 50 / 150 first payments | 3,166,225 / 9,473,031 |
| `claimRange`, 150 / 200 first payments | 8,724,516 / 11,602,992 |
| `reconciliation()` view, 400 contributors | 1,039,537 |

The CLI pays at most 150 contributors per transaction (`distributor-claim --batch-size`, default 100).
Runtime size 6,322 bytes, creation code 8,073 bytes. The Foundry suites run on Paris, which predates
EIP-3860, so the initcode limit is checked by `testFullListCreationFitsTheInitcodeLimit` and was
confirmed on Anvil: with this bytecode 638 contributors (49,097 bytes) are the most a creation
transaction can carry, 639 are rejected before execution.

**Limitations.**

1. **Irreversible.** The list cannot be corrected and the role cannot leave the distributor. Check the
   deployment against the reviewed file (`distributor-inspect --weights`) before making it a
   recipient; a wrong distributor that is not yet the recipient is simply abandoned.
2. **Lost keys and blocked accounts.** Income of a contributor that lost its key stays in the
   distributor. If BEM ever refused transfers to an account, that contributor's claims (and any batch
   including it) would revert; the others are unaffected.
3. **One list per distributor.** If one distributor is made the recipient of both categories, both
   incomes are pooled and split by the same weights; `releaseFromPool` pulls only its bound category
   (the other is still released through the pool's own `releaseHistorical`).
4. **No rescue path.** BEM sent to the distributor is income; other tokens stay there.
5. **Not audited**, like the rest of this repository.
