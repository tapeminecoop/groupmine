# Accounting

All amounts are raw BEM units (8 decimals: `1 BEM = 100_000_000`). The contract never reads prices,
`Mining.pending`, or material quantities; the only economic inputs are the manually configured share
counts and NAND weight, plus the BEM the pool actually receives.

## 1. Income recognition

The pool keeps two running totals: `totalAccounted` (income recognized so far, `T`) and `totalPaid`.
Every state-changing entry point that touches money starts with a sync:

```
received        = bemBalance + totalPaid - totalAccounted      (reverts BalanceDecreased if negative)
totalAccounted += received
```

So *anything* that increases the pool's BEM balance is pool income: harvests, a third party calling
the real `Mining.claim` on a pool miner (it pays the holder), the registration claim made when a miner
is deposited (income the miner carried in, including income accrued before the deposit), and direct
transfers. Income in `Mining` that has not been claimed yet is not income; estimates are never booked.

## 2. Allocation (cumulative floors of T)

Each bucket is a floor function of the single cumulative total `T` (src/PoolMath.sol, mirrored
exactly in sdk/math.ts):

| Bucket | Formula |
| --- | --- |
| fee | `floor(T * 2 / 102)` |
| entitlement (participants + historical) | `T - fee` |
| NAND category | `floor(entitlement * W_N / 1e8)` |
| LATCH category | `floor(entitlement * (1e8 - W_N) / 1e8)` |
| per NAND share | `floor(NAND / (S_N + H_N))`, 0 if the denominator is 0 |
| per LATCH share | `floor(LATCH / (S_L + H_L))` |
| current NAND receipts (all IDs) | `S_N * perNandShare` |
| historical NAND | `H_N * perNandShare` |
| current LATCH receipts | `S_L * perLatchShare` |
| historical LATCH | `H_L * perLatchShare` |
| residue (retained) | `T - fee - receipts - historical` |

Properties (tested in `test/unit/PoolAccounting.t.sol`, `test/invariant/PoolInvariant.t.sol`,
`test/sdk/math.test.ts`):

- **100:2 model.** The fee is 2/102 of gross (about 1.960784%), not 2% of gross: 1,000,000 raw of
  income gives a fee of 19,607, not 20,000. It is applied once, before the category split, so it is
  also taken once from income that ends up as historical income.
- **Weights decide the category split; counts only divide within a category.** One historical share
  is worth exactly one receipt ID of its category (`H * perShare`).
- **Monotonic.** Every bucket is non-decreasing in `T`. Per-ID entitlements never shrink.
- **Path independent.** Entitlements depend only on `T`, not on how many harvests produced it.
  The incremental equations in the specification hold for each increment up to the rounding of the
  cumulative floors; nothing is recomputed per claim and no history is iterated.
- **Bounded residue.** `0 <= residue <= 1 + (S_N + H_N - 1) + (S_L + H_L - 1)` at every `T`.
  Because the floors are recomputed from the cumulative total, residue from one harvest is paid out
  by later income instead of accumulating. At the end of the pool's life at most that bound stays
  in the contract.
- **Rounding direction.** All rounding favours "not paying": no bucket is ever over-allocated, so
  `fee + receipts + historical <= T` always holds.

## 3. Claimed history

| Right | Accrued | Paid tracker | Claimable |
| --- | --- | --- | --- |
| NAND receipt `id` | `perNandShare` | `claimed(NAND, id)` | `perNandShare - claimed(NAND, id)` |
| LATCH receipt `id` | `perLatchShare` | `claimed(LATCH, id)` | `perLatchShare - claimed(LATCH, id)` |
| historical NAND | `historicalNand` | `historicalPaid(NAND)` | difference |
| historical LATCH | `historicalLatch` | `historicalPaid(LATCH)` | difference |
| fee | `fee` | `feePaid` | difference |

A claim sets the ID's history to the current per-share value, so it pays exactly the unpaid part
once. The history is keyed by `(category, id)`, not by holder: when an ID moves, its unpaid income
moves with it, its paid history stays with it, and the previous holder can no longer claim it
(`NotHolder`). NAND #1 and LATCH #1 have independent histories.

## 4. Reconciliation identities

`reconciliation()` returns every bucket; `npm run pool -- reconcile --pool <addr> [--deep]` checks
them off-chain (and recomputes the allocation with sdk/math.ts):

```
totalAccounted = fee + nandReceipts + latchReceipts + historicalNand + historicalLatch + residue
totalPaid      = feePaid + nandReceiptsPaid + latchReceiptsPaid + historicalNandPaid + historicalLatchPaid
bemBalance     = Σ (accrued - paid) over the five buckets + residue + unrecognized
Σ_id claimed(NAND, id)  = nandReceiptsPaid        (--deep)
Σ_id claimed(LATCH, id) = latchReceiptsPaid       (--deep)
```

`unrecognized` is BEM that arrived since the last sync (counted by the next sync). A `deficit`
(balance below the ledger) can only come from abnormal token behaviour; every money path reverts
while it exists.

## 5. Worked example (specification)

Income 1,020 BEM, `W_N = 0.80000000`, `S_N = 900`, `H_N = 100`, `S_L = 80`, `H_L = 20`:

| Bucket | BEM |
| --- | ---: |
| fee (2/102) | 20 |
| NAND category | 800 |
| — 900 NAND receipts at 0.8 each | 720 |
| — historical NAND (100 shares) | 80 |
| LATCH category | 200 |
| — 80 LATCH receipts at 2 each | 160 |
| — historical LATCH (20 shares) | 40 |
| residue | 0 |
| **total** | **1,020** |

Executed end to end (real harvest, claims of all 980 IDs, releases) in
`PoolAccountingTest.testSpecificationExample1020Bem`, and reproduced off-chain with
`npm run pool -- preview --config deployments/examples/pool.bsc.example.json --income 1020`.

## 6. Payments

Payments use `SafeERC20.safeTransfer` and then require the pool's balance to drop by exactly the
amount and the recipient's balance to rise by exactly the amount (the baseline's rule for plain,
non-rebasing, fee-free BEM). A fee-on-transfer or otherwise abnormal token makes the payment revert,
leaving the claimed history untouched.

## 7. Why the configuration is fixed after activation

Income can sit inside `Mining` for an arbitrary time before anyone harvests it. If weights or share
counts could change after activation, income earned under the old terms but harvested later would be
split under the new terms unless every miner were harvested atomically at the change. V1 avoids that
boundary entirely: `configure` is only possible before activation, and activation records the hash of
the configuration the operator reviewed. A different economic arrangement is a new pool.
