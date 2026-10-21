# Accounting

All amounts are raw BEM units (8 decimals). Everything is derived from one cumulative counter, `T` =
`totalAccounted`, the BEM the pool has recognized as income since deployment. Nothing is ever computed
as "all income × latest ratio".

This describes `TapeoutMinerPool/2.1.0`. The 2.0.0 candidate split `T` as 100 : 1 : 1 of 102 with no
sink; its reports remain historical (see docs/FEE_SPLIT_CHANGE_REPORT.md).

## 1. Recognition

`_sync` recognizes `received = balance − (totalAccounted − totalPaid)`: whatever reached the pool by any
route (admissions, harvests, third-party `Mining.claim` calls, plain transfers). Only actual balance
increases count; `pending()` is never used as income. A balance below the ledger reverts
(`BalanceDecreased`). While no miner is admitted (`N + L = 0`) nothing is recognized; the first
admission recognizes everything held, under the first composition.

## 2. The outer accounts: 80 + 1 + 1 + 2 = 84

The displayed weights are NAND + LATCH 100 : A 1.25 : B 1.25 : C 2.5 (105 in total). Divided by 1.25
they are the integers used on chain, 80 : 1 : 1 : 2 of 84:

```
A = B = ⌊T / 84⌋          (recipient A, recipient B)
C     = ⌊2 · T / 84⌋      (the sink, 0x000000000000000000000000000000000000dEaD)
P     = ⌊80 · T / 84⌋     (participants: NAND + LATCH receipts)
```

Each account is its own floor of `T`. C is `⌊2T/84⌋`, not `2·⌊T/84⌋`: at `T = 42` C is 1 while A and B
are 0, and at `T = 1,050` C is 25 while A and B are 12 each. The participants receive 100/105 ≈ 95.238%
of `T` (not 95%), A and B 1.25/105 ≈ 1.190% each and C 2.5/105 ≈ 2.381%. The weights are code
constants: no setter, no administrator-controlled fee, and no other fee.

A and B are paid by `releaseA`/`releaseB`, each tracking its own paid amount. The paid amount belongs
to the role, not the address: when a recipient moves its role (`setRecipient`), whatever has accrued
but not been released is paid to the new address by the next release.

## 3. The sink (C)

C is a fixed code constant, `SINK = 0x000000000000000000000000000000000000dEaD`. It is not a role, has
no receipt, cannot be configured or migrated, and neither recipient may be set to it.

- **Settlement with every release.** `releaseA` and `releaseB` stay permissionless. Each one runs
  `_sync`, takes one snapshot of the accrual at the resulting `T`, and pays the selected role
  `A(T) − A_paid` (or B) together with C's whole unpaid amount `C(T) − C_paid`, setting
  `C_paid = C(T)`. The C amount is computed from `T`, never as twice the role's payment. A release
  pays C even when the role is due nothing (`T = 42`: A = B = 0, C = 1), and C's backlog is paid once:
  the next release, whichever role, finds `C(T) − C_paid = 0` until more income is recognized. A
  release never marks the other role paid. The return value is the role's amount; C is reported by a
  separate `SinkPaid(releasedRole, sink, amount)` event and the `sinkPaid` counter.
- **Ordinary transfer, not a burn.** C leaves the pool as a plain ERC-20 `transfer` of BEM to that
  address: no burn call and no transfer to the zero address. On the BSC fork (block 128,713,128) BEM
  has no special handling of the address: the sink already held 2,444.27231190 BEM, its balance grew by
  exactly the pool's recorded payment, and BEM's `totalSupply` was observed unchanged by the transfer
  (reports in docs/FEE_SPLIT_CHANGE_REPORT.md). The BEM stays counted in `totalSupply`; it is out of
  circulation only in the conventional sense that nobody is known to control that address.
- **Atomic.** Both transfers happen in one call under the same guard as every other payout
  (checks-effects-interactions, `nonReentrant`, balance deltas of the pool, the role and the sink
  checked). If either transfer fails, or the token moves amounts other than requested, the whole
  release reverts: neither the role nor C is paid and no counter moves.
- **Independent of claims.** Harvest, sync and admission accrue C (it is part of `T`) but never pay
  it; `claim`/`claimBatch` never transfer to the sink and never depend on a release. A token that
  refused transfers to the sink would block releases (A, B and C together) but not receipt claims.

## 4. Composition periods

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

## 5. Receipts

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

## 6. Rounding model

```
residue = T − A − B − C − S_N·perNandShare − S_L·perLatchShare
        ≤ 3 (outer floors) + 1 (carried category unit) + (S_N − 1) + (S_L − 1)
```

(a zero-supply category contributes 0 instead of `S − 1`). The outer term: with `T = 84q + r`
(`0 ≤ r < 84`), the four floors leave `r − ⌊2r/84⌋ − ⌊80r/84⌋`, which is at most 3, reached for
`r = 64 … 83` (the 102-part rule left at most 2). C receives exactly its own floor and never the
residue. The residue stays in the pool and is not an account; it does not accumulate across harvests
or periods because every quantity is recomputed from `T`. Within one composition period the allocation
depends only on `T`, so receiving income in one harvest or in many gives identical results. Across
periods, the only extra rounding is the at-most-one-unit carry above.

**Bounded residue is not a lifetime category-fairness bound.** A checkpoint freezes each category's
whole-unit income and carries only the single unassigned participant unit, not each category's
fractional remainder. So admissions can shift lifetime category totals by more than one unit, even
when they keep the same NAND:LATCH ratio, while the unassigned residue stays within the bound above.

Example (test/remediation/RoundingPolicy.t.sol, raw units):
- **Setup.** One receipt per category and a 1:2 miner; 3 units are recognized, then one unit in each
  of seven further periods.
- **With checkpoints.** A zero-carry 1:2 miner is admitted between periods. At `T = 10` the result is
  NAND 0, LATCH 8, residue 2.
- **Without checkpoints.** The same 10 units recognized in one period give NAND 3, LATCH 6, residue 1.

Both results conserve every unit and never reverse an accrued amount. Creating such boundaries needs
whitelisted admissions of further eligible miners into permanent custody. This is the documented
policy of this version, pending the owner's explicit economic acceptance. Changing it, for example by
carrying each category's fraction, would be a separate specification and contract change.

## 7. Monotonicity

`T` only grows, so `A`, `B`, `C` and `P` never decrease. Inside a period both category incomes are
non-decreasing in `T`; at a checkpoint the new bases equal the current incomes, so no category,
per-share value, recipient entitlement or sink entitlement ever decreases.

## 8. Reconciliation identities

`reconciliation()` returns every term; `npm run pool -- reconcile [--deep]` checks them:

```
bemBalance + deficit = (totalAccounted − totalPaid) + unrecognized        deficit is always 0
totalPaid            = A_paid + B_paid + C_paid + nandReceiptsPaid + latchReceiptsPaid
totalAccounted       = A + B + C + S_N·perNandShare + S_L·perLatchShare + residue
A = B = ⌊T/84⌋,  C = ⌊2T/84⌋,  nandIncome + latchIncome ≤ ⌊80T/84⌋    each from T on its own
A_paid ≤ A,  B_paid ≤ B,  C_paid ≤ C
Σ_id claimed[NAND][id] = nandReceiptsPaid   (and LATCH)                 --deep
```

The pool's obligations are the five unpaid amounts, unpaid C included; the BEM balance covers them
plus the residue and anything not yet recognized.

## 9. Acceptance example

Old composition `N:L = 9:1`; the registered miners have 105 BEM to collect; a `1:9` miner carrying
105 BEM is admitted.

| Step | T | A | B | C | NAND | LATCH |
| --- | --- | --- | --- | --- | --- | --- |
| 3. settle old miners (9:1) | 105 | 1.25 | 1.25 | 2.5 | 90 | 10 |
| 4. checkpoint, composition becomes 10:10 | 105 | 1.25 | 1.25 | 2.5 | 90 (base) | 10 (base) |
| 5. carried income (10:10) | 210 | 2.5 | 2.5 | 5 | 90 + 50 = 140 | 10 + 50 = 60 |

`testSpecificationAcceptanceExample` and the local end-to-end run (`acceptanceExampleNand140Latch60`)
reproduce exactly these numbers. With 1,050 BEM recognized in one period, A and B receive 12.5 BEM
each, C 25 BEM and the participants 1,000 BEM (test/unit/PoolFeeSplit.t.sol).
