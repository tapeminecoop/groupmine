# Accounting

All amounts are raw BEM units (8 decimals). Everything is derived from one cumulative counter, `T` =
`totalAccounted`, the BEM the pool has recognized as income since deployment. Nothing is ever computed
as "all income × latest ratio".

## 1. Recognition

`_sync` recognizes `received = balance − (totalAccounted − totalPaid)`: whatever reached the pool by any
route (admissions, harvests, third-party `Mining.claim` calls, plain transfers). Only actual balance
increases count; `pending()` is never used as income. A balance below the ledger reverts
(`BalanceDecreased`). While no miner is admitted (`N + L = 0`) nothing is recognized; the first
admission recognizes everything held, under the first composition.

## 2. The four accounts: 100 + 1 + 1 = 102

```
A = B = ⌊T / 102⌋          (recipient A, recipient B)
P     = ⌊100 · T / 102⌋    (participants: NAND + LATCH receipts)
```

The weights never change, and there is no other fee. A and B are paid by `releaseA`/`releaseB`, each
tracking its own paid amount.

## 3. Composition periods

`N` and `L` are the summed `nandBurn`/`latchBurn` of all admitted miners. Each admission ends a period
(step 4 of the boundary) by storing the category incomes reached so far:

```
nandBase  = nandIncome(T_k)       latchBase = latchIncome(T_k)       participantBase = nandBase + latchBase
```

and income recognized afterwards is split by the new composition:

```
d           = P(T) − participantBase
nandIncome  = nandBase  + ⌊d · N / (N + L)⌋
latchIncome = latchBase + ⌊d · L / (N + L)⌋
```

Earlier periods are frozen inside the bases, so a new miner never re-prices income settled before it.
The two floors lose at most one unit together; that unit stays inside `d` and is distributed in the
next period, not lost.

## 4. Receipts

```
perNandShare  = ⌊nandIncome / S_N⌋            perLatchShare = ⌊latchIncome / S_L⌋
claimable(id) = perShare − claimed[category][id]
```

`S_N` and `S_L` are fixed at activation. A claim sets `claimed[category][id] = perShare`, so an amount
is paid once per ID whoever holds it: unclaimed income moves with the receipt, the former holder can no
longer claim it, and the same numeric ID in the other collection is independent. Receipts held by the
distributor accrue like any other.

**Zero-supply categories.** Activation refuses `S_N = S_L = 0`. If one collection has no receipts, no
miner that burns that category can be admitted (`UnsupportedCategory`), so that category's weight
stays zero and its income is zero; nothing is redirected and no fallback weight exists.

## 5. Rounding model

```
residue = T − A − B − S_N·perNandShare − S_L·perLatchShare
        ≤ 2 (outer floors) + 1 (carried category unit) + (S_N − 1) + (S_L − 1)
```

(a zero-supply category contributes 0 instead of `S − 1`). The residue stays in the pool and is not
an account; it does not accumulate across harvests or periods because every quantity is recomputed
from `T`. Within one composition period the allocation depends only on `T`, so receiving income in
one harvest or in many gives identical results. Across periods, the only extra rounding is the
at-most-one-unit carry above.

## 6. Monotonicity

`T` only grows, so `A`, `B` and `P` never decrease. Inside a period both category incomes are
non-decreasing in `T`; at a checkpoint the new bases equal the current incomes, so no category,
per-share value or recipient entitlement ever decreases.

## 7. Reconciliation identities

`reconciliation()` returns every term; `npm run pool -- reconcile [--deep]` checks them:

```
bemBalance + deficit = (totalAccounted − totalPaid) + unrecognized        deficit is always 0
totalPaid            = A_paid + B_paid + nandReceiptsPaid + latchReceiptsPaid
totalAccounted       = A + B + S_N·perNandShare + S_L·perLatchShare + residue
Σ_id claimed[NAND][id] = nandReceiptsPaid   (and LATCH)                 --deep
```

## 8. Acceptance example

Old composition `N:L = 9:1`; the registered miners have 102 BEM to collect; a `1:9` miner carrying
102 BEM is admitted.

| Step | T | A | B | NAND | LATCH |
| --- | --- | --- | --- | --- | --- |
| 3. settle old miners (9:1) | 102 | 1 | 1 | 90 | 10 |
| 4. checkpoint, composition becomes 10:10 | 102 | 1 | 1 | 90 (base) | 10 (base) |
| 5. carried income (10:10) | 204 | 2 | 2 | 90 + 50 = 140 | 10 + 50 = 60 |

`testSpecificationAcceptanceExample` and the local end-to-end run (`acceptanceExampleNand140Latch60`)
reproduce exactly these numbers.
