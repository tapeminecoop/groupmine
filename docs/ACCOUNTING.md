# Accounting

All amounts are raw BEM units (8 decimals). Everything is derived from one cumulative counter, `T` =
`totalAccounted`, the BEM the pool has recognized as income since deployment. Nothing is ever computed
as "all income × latest ratio".

This describes `TapeoutMinerPool/2.2.0`. What changed from 2.1.0 (carried income attributed by each
incoming miner's own burn, the fractional category ledger, and the custody finality gate) and why is in
[SALUS_AUDIT_REMEDIATION_REPORT.md](SALUS_AUDIT_REMEDIATION_REPORT.md). The outer split (§2, §3) is
unchanged from 2.1.0. The 2.0.0 candidate split `T` as 100 : 1 : 1 of 102 with no sink; its reports
remain historical (see docs/FEE_SPLIT_CHANGE_REPORT.md).

## 1. Recognition

Income enters the ledger in two ways.

- **Ordinary income.** `_sync` recognizes `received = balance − (totalAccounted − totalPaid)`: whatever
  reached the pool by any route (harvests, settlement of registered miners at an admission, third-party
  `Mining.claim` calls, plain transfers). It belongs to the current composition period (§4).
- **Carried income.** During an admission, each incoming miner is claimed on its own, and the exact
  balance increase of that claim is that miner's carried income: what it earned before it entered the
  pool. It is attributed by that miner's own burn (§4) and recognized at the admission boundary, before
  the incoming batch joins the composition. No `_sync` runs between the claim and the attribution, so the
  pool's composition never splits carried income.

Only actual balance increases count; `pending()` is never used as income (it can be 0 while a claim pays;
on the BSC fork every incoming miner's claim paid more than its `pending()` just before). A balance below
the ledger reverts (`BalanceDecreased`). While no miner is admitted (`N + L = 0`) nothing is recognized;
the first admission attributes its incoming miners' carried income and then recognizes everything else
held (donations, payouts for unregistered or revoked miners) as ordinary income of its new period, under
the first composition.

## 2. The outer accounts: 80 + 1 + 1 + 2 = 84

The displayed weights are NAND + LATCH 100 : A 1.25 : B 1.25 : C 2.5 (105 in total). Divided by 1.25
they are the integers used on chain, 80 : 1 : 1 : 2 of 84:

```
A = B = ⌊T / 84⌋          (recipient A, recipient B)
C     = ⌊2 · T / 84⌋      (the sink, 0x000000000000000000000000000000000000dEaD)
P     = ⌊80 · T / 84⌋     (participants: NAND + LATCH receipts)
```

Each account is its own floor of `T`, carried income included. C is `⌊2T/84⌋`, not `2·⌊T/84⌋`: at
`T = 42` C is 1 while A and B are 0, and at `T = 1,050` C is 25 while A and B are 12 each. The
participants receive 100/105 ≈ 95.238% of `T` (not 95%), A and B 1.25/105 ≈ 1.190% each and C
2.5/105 ≈ 2.381%. The weights are code constants: no setter, no administrator-controlled fee, and no
other fee.

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
  it. `claim`/`claimBatch` accrue C too when their `_sync` recognizes newly held BEM, but they never
  transfer to the sink and never depend on a release. A token that
  refused transfers to the sink would block releases (A, B and C together) but not receipt claims.

## 4. The category ledger

The participants' entitlement is split between NAND and LATCH in a ledger kept in units of
1 / `LEDGER_UNIT` raw BEM, `LEDGER_UNIT = 84 · 10^18`. In those units the participants' share of `x` raw
units is exact: `u(x) = x · 80 · 10^18`. Every split gives NAND the floor and LATCH the rest, so a split
never loses anything and favours LATCH by less than one ledger unit (under 1.2 · 10^-20 raw BEM).

**Ordinary income** recognized while the pool's aggregate composition is `(N, L)` (the summed
`nandBurn`/`latchBurn` of all admitted miners) is split by `N : L`.

**Carried income** `r` of an incoming miner with burn `(n, l)` is split by that miner's own `n : l`:

```
toNand  = ⌊u(r) · n / (n + l)⌋           toLatch = u(r) − toNand
```

whatever the pool's composition is. The depositor receives nothing; the income belongs to all existing
receipts of each category.

**Admissions are boundaries.** Each admission (1) recognizes held BEM and settles every registered miner
under the old composition, (2) freezes the old period's entitlements, fractions included, (3) attributes
each incoming miner's carried income, and (4) adds the batch to the composition. The boundary state is
`accountedBase` (`T` at the boundary) and `nandBase`, `latchBase` (ledger units), always with
`nandBase + latchBase = u(accountedBase)`. Inside a period:

```
d          = u(T − accountedBase)
nandUnits  = nandBase  + ⌊d · N / (N + L)⌋
latchUnits = latchBase + d − ⌊d · N / (N + L)⌋
nandIncome = ⌊nandUnits / LEDGER_UNIT⌋          latchIncome = ⌊latchUnits / LEDGER_UNIT⌋
```

`ledgerState()` returns the boundary state; `carriedIncome` and `carriedNandUnits` are the cumulative
carried income and its NAND part (its LATCH part is `u(carriedIncome) − carriedNandUnits`); every
miner's record (`miner(id).carriedIncome`) holds what its own claim paid at its admission, and the event
`CarriedIncomeAttributed(tokenId, received, nandUnits, latchUnits)` reports each attribution.

**Order independence.** A carried split depends only on the miner's `(r, n, l)`, and ledger entries add.
Admitting the same miners in any order, in one batch, one by one with no intervening accrual, or in
several batches, gives the same ledger to the ledger unit, hence the same raw-unit incomes. Only the
period counter and the registry order differ. Income a miner earns *after* its admission is ordinary
income of the pool: if time passes between two sequential admissions, the first miner's new income is
split by the aggregate composition, as it should be.

**Path independence.** Within one period every quantity depends only on `T`: receiving income in one
harvest or in many gives identical results.

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
miner that burns that category can be admitted (`UnsupportedCategory`), so that category's weight and
carried share stay zero and its income is zero; nothing is redirected and no fallback weight exists.

## 6. Rounding model

```
residue = T − A − B − C − S_N·perNandShare − S_L·perLatchShare
        ≤ 3 (outer floors) + 1 (category floors) + (S_N − 1) + (S_L − 1)
```

(a zero-supply category contributes 0 instead of `S − 1`). The outer term: with `T = 84q + r`
(`0 ≤ r < 84`), the four floors leave `r − ⌊2r/84⌋ − ⌊80r/84⌋`, which is at most 3, reached for
`r = 64 … 83`. The category term: `nandUnits + latchUnits = u(T)` exactly, so the two raw-unit floors
leave `P − nandIncome − latchIncome ∈ {0, 1}`. C receives exactly its own floor and never the residue.
The residue stays in the pool and is not an account; it does not accumulate, because every quantity is
recomputed from the ledger.

**Category fairness.** Against the exact rational entitlements (ordinary income at `N/(N+L)`, carried
income at each miner's `n/(n+l)`), each category's income is within one raw unit: NAND is at most one
unit below and never above, LATCH at most one unit below or a fraction of a unit above it. The ledger
floors add at most one ledger unit per period and per carried miner, under 10^-17 raw units over any
realistic history. 2.1.0 froze whole raw units at each checkpoint, so same-ratio admissions could shift
lifetime category totals by more than a unit (test/remediation/RoundingPolicy.t.sol kept that example:
NAND 0 / LATCH 8 with checkpoints, 3 / 6 without); 2.2.0 gives 3 / 6 both ways.

**Single-period difference from 2.1.0.** 2.1.0 split the floored total `P = ⌊80T/84⌋`; 2.2.0 splits the
exact share `80T/84`. In one period a category can therefore receive one raw unit more than under 2.1.0
(T = 45 at 3:1: NAND 32, LATCH 10 instead of 31, 10), and the sum stays within one unit of `P`.

**Arithmetic range.** The ledger multiplies by `80 · 10^18` and then by the composition, so totals must
stay below about `2^256 / (8 · 10^19 · (N + L))`: over 10^44 raw units even for a registry of 600 miners
with the largest burns Mining can record, against BEM's maximum supply of 2.1 · 10^15 raw units.

## 7. Monotonicity

`T` only grows, so `A`, `B`, `C` and `P` never decrease. Inside a period both category ledgers are
non-decreasing in `T` (`⌊d·N/W⌋` and `d − ⌊d·N/W⌋` both are); at a checkpoint the bases equal the
current values, and a carried attribution only adds. So no category, per-share value, recipient
entitlement or sink entitlement ever decreases, and a claimed amount can never become claimable again.

## 8. Reconciliation identities

`reconciliation()` returns every term; `npm run pool -- reconcile [--deep]` checks them:

```
bemBalance + deficit = (totalAccounted − totalPaid) + unrecognized        deficit is always 0
totalPaid            = A_paid + B_paid + C_paid + nandReceiptsPaid + latchReceiptsPaid
totalAccounted       = A + B + C + S_N·perNandShare + S_L·perLatchShare + residue
A = B = ⌊T/84⌋,  C = ⌊2T/84⌋,  nandIncome + latchIncome ≤ ⌊80T/84⌋    each from T on its own
A_paid ≤ A,  B_paid ≤ B,  C_paid ≤ C
nandBase + latchBase = u(accountedBase),  nandUnits + latchUnits = u(T)   ledger identities
carriedIncome ≤ accountedBase ≤ T,  carriedNandUnits ≤ u(carriedIncome)
Σ_id claimed[NAND][id] = nandReceiptsPaid   (and LATCH)                 --deep
Σ_miner carriedIncome = carriedIncome,  Σ_miner toNand(miner) = carriedNandUnits   --deep
```

The pool's obligations are the five unpaid amounts, unpaid C included; the BEM balance covers them
plus the residue and anything not yet recognized. `T − carriedIncome` is the ordinary income.

## 9. Acceptance examples

**Old and carried income.** Old composition `N:L = 9:1`; the registered miners have 105 BEM to collect; a
`1:9` miner carrying 105 BEM is admitted.

| Step | T | A | B | C | NAND | LATCH |
| --- | --- | --- | --- | --- | --- | --- |
| settle old miners (9:1) | 105 | 1.25 | 1.25 | 2.5 | 90 | 10 |
| checkpoint | 105 | 1.25 | 1.25 | 2.5 | 90 (frozen) | 10 (frozen) |
| carried income (the miner's own 1:9) | 210 | 2.5 | 2.5 | 5 | 90 + 10 = 100 | 10 + 90 = 100 |

Later income is split 10:10. (2.1.0 split the carried income by the post-admission 10:10 composition:
NAND 140, LATCH 60.) `testSpecificationAcceptanceExample` and the local end-to-end run
(`acceptanceExampleCarriedByOwnBurnNand100Latch100`) reproduce these numbers.

**SALUS example (finding #2).** Miner X burned 10 NAND / 0 LATCH and carries 105 BEM; miner Y burned 5 / 5
and carries 105 BEM. Each contributes 100 BEM to the participants. X gives NAND 100, Y gives NAND 50 and
LATCH 50: NAND 150, LATCH 50, whether X comes first, Y comes first, or both come in one batch (in either
order); future income is split 15 : 5. (2.1.0 gave 175 / 25 or 125 / 75 depending on the order.)
`testSalusExampleIsIndependentOfAdmissionOrder` checks all four orders, and the differential test checks
them against the independent model.

With 1,050 BEM recognized in one period, A and B receive 12.5 BEM each, C 25 BEM and the participants
1,000 BEM (test/unit/PoolFeeSplit.t.sol).
