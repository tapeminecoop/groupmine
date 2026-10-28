#!/usr/bin/env python3
"""Pure-arithmetic property search for the 2.2.0 category ledger policy (review PoC, Fable 5.1).

No EVM. Implements the claimed finite-precision policy and the exact rational economics from the
specification only, then:
  1. random traces of admissions (carried entries) and ordinary periods at raw-unit granularity:
     measures the worst observed NAND deficit / LATCH excess against the exact economics;
  2. brute-force search for a trace where NAND's raw income is one unit BELOW floor(exact), i.e. where
     the sub-ledger-unit floors cross a raw-unit boundary (the brief's question);
  3. order / partition independence of carried attribution at raw boundaries, and the labelled
     "intervening accrual" case where sequential admissions legitimately differ;
  4. repeated same-ratio checkpoints and small denominators that do not divide 84*10^18;
  5. residue bound tightness and the arithmetic overflow envelope.
Writes a JSON summary to the path given as argv[1].
"""
import json
import random
import sys
from fractions import Fraction

PARTS, PPARTS, PREC = 84, 80, 10 ** 18
UNIT = PARTS * PREC
U256 = 2 ** 256


def nand_units(amount, n, l):
    return amount * PPARTS * PREC * n // (n + l)


def policy(entries):
    T = sum(a for a, _, _ in entries)
    nu = sum(nand_units(a, n, l) for a, n, l in entries)
    lu = T * PPARTS * PREC - nu
    return T, nu // UNIT, lu // UNIT


def exact(entries):
    T = sum(a for a, _, _ in entries)
    en = sum(Fraction(a * PPARTS * n, PARTS * (n + l)) for a, n, l in entries)
    return en, Fraction(T * PPARTS, PARTS) - en


def floor_f(x):
    return x.numerator // x.denominator


out = {}
rng = random.Random(20261029)

# 1. random traces at raw granularity
worst_nand = Fraction(0)
worst_latch = Fraction(0)
below_floor = 0
runs = 20000
for _ in range(runs):
    k = rng.randint(1, 12)
    entries = []
    for _ in range(k):
        n = rng.randint(0, 13)
        l = rng.randint(0, 13)
        if n + l == 0:
            n = 1
        entries.append((rng.choice([rng.randint(0, 200), rng.randint(0, 10 ** 9)]), n, l))
    T, pn, pl = policy(entries)
    en, el = exact(entries)
    assert pn <= en and pl >= el - 1, entries
    assert pn + pl in (T * PPARTS // PARTS, T * PPARTS // PARTS - 1)
    worst_nand = max(worst_nand, en - pn)
    worst_latch = max(worst_latch, pl - el)
    if pn < floor_f(en):
        below_floor += 1
out["random_traces"] = {"runs": runs, "worst_nand_deficit_raw": float(worst_nand), "worst_latch_excess_raw": float(worst_latch),
                        "nand_one_below_floor_of_exact": below_floor}

# 2. search for NAND one raw unit below floor(exact): need the fractional parts of the exact NAND units of
#    several entries to sum to an integer multiple of UNIT exactly while each individual floor drops a
#    fraction. Entries with denominators dividing PREC*84*80*amount fully never lose anything, so use
#    denominators that do not divide 80*84*10^18: 11, 13, 17 ...
found = None
for d in (11, 13, 17, 19, 23):
    # entry i: amount a_i, n_i : l_i with n_i + l_i = d. exact NAND units = a_i*80e18*n_i/d.
    # choose a_i = 1 and n_i = 1..d-1: units = 80e18 * n_i / d, fractional part (80e18*n_i mod d)/d.
    # Pick entries whose fractional parts sum to an integer: n_i all equal to 1, d copies => sum = 80e18
    # units exactly (an integer), but each floor loses (80e18 mod d)/d.
    entries = [(1, 1, d - 1)] * d
    T, pn, pl = policy(entries)
    en, el = exact(entries)
    if pn < floor_f(en):
        found = {"denominator": d, "entries": f"{d} x (amount 1 raw, burn 1:{d - 1})", "exact_nand_raw": str(en), "policy_nand_raw": pn,
                 "exact_latch_raw": str(el), "policy_latch_raw": pl, "T": T}
        break
# also a realistic-looking variant: larger amounts, same structure
if found is None:
    for d in (11, 13):
        entries = [(84 * d * 1000 + 84, 1, d - 1)] * d
        T, pn, pl = policy(entries)
        en, el = exact(entries)
        if pn < floor_f(en):
            found = {"denominator": d, "entries": entries[:1], "count": d, "exact_nand_raw": str(en), "policy_nand_raw": pn}
            break
out["nand_one_below_floor_example"] = found or "not found in the searched family"
# Minimal example at raw scale: is there a case where the exact NAND is an INTEGER and the policy pays one less?
mini = None
for d in range(2, 40):
    for n in range(1, d):
        for k in range(2, d + 1):
            entries = [(1, n, d - n)] * k
            en, _ = exact(entries)
            if en.denominator == 1:
                _, pn, _ = policy(entries)
                if pn < en:
                    mini = {"entries": f"{k} x (1 raw, burn {n}:{d - n})", "exact_nand_raw": int(en), "policy_nand_raw": pn}
                    break
        if mini:
            break
    if mini:
        break
out["nand_one_below_integer_exact_minimal"] = mini

# 3. order / partition independence of carried attribution (no intervening accrual): the ledger is a
#    multiset sum, so any order gives identical units. Verified on random multisets at raw granularity.
viol = 0
for _ in range(5000):
    k = rng.randint(2, 8)
    ms = [(rng.randint(0, 10 ** 6), rng.randint(0, 9) + 1, rng.randint(0, 9)) for _ in range(k)]
    a = policy(ms)
    b = policy(list(reversed(ms)))
    sh = ms[:]
    rng.shuffle(sh)
    c = policy(sh)
    if not (a == b == c):
        viol += 1
out["order_independence_violations"] = viol
# the labelled different case: X then Y with ordinary accrual between them is NOT the same as {X,Y}
X = (105 * 10 ** 8, 10, 0)
Y = (105 * 10 ** 8, 5, 5)
between = 105 * 10 ** 8  # ordinary income earned by X while alone (split 10:0)
seq = policy([X, (between, 10, 0), Y])
batch = policy([X, Y, (between, 15, 5)])
out["intervening_accrual_labelled_difference"] = {"X_then_accrual_then_Y": seq, "batch_then_accrual": batch,
                                                  "note": "expected to differ: ordinary income earned by X alone goes 10:0, in the batch case 15:5"}

# SALUS reference example (raw = 1e8 per BEM)
BEM = 10 ** 8
ref = policy([(105 * BEM, 10, 0), (105 * BEM, 5, 5)])
T, pn, pl = ref
after = policy([(105 * BEM, 10, 0), (105 * BEM, 5, 5), (105 * BEM, 15, 5)])
out["salus_reference_example"] = {"nand_raw": pn, "latch_raw": pl, "A_raw": T // PARTS, "C_raw": 2 * T // PARTS,
                                  "after_105_more_at_15_5": {"nand_raw": after[1], "latch_raw": after[2]}}

# 4. repeated same-ratio checkpoints: k periods of amount a at ratio 1:2 (denominator 3 divides UNIT) and
#    at ratio 1:10 (11 does not). Loss per checkpoint < 1 ledger unit; raw loss only when it crosses.
def repeated(ratio, a, k):
    n, l = ratio
    T, pn, pl = policy([(a, n, l)] * k)
    en, el = exact([(a, n, l)] * k)
    return {"k": k, "nand_policy": pn, "nand_exact": str(en), "deficit_ledger_units": str((en - pn) * UNIT)}

out["repeated_same_ratio"] = {"1:2": repeated((1, 2), 7, 100), "1:10": repeated((1, 10), 7, 100), "3:8": repeated((3, 8), 5, 1000)}
# maximum cumulative ledger-unit deficit after k entries is < k units; to move a raw unit the exact value
# must be within k/UNIT of an integer from above.
out["cumulative_bound"] = {"max_ledger_unit_deficit_after_k_entries": "< k", "raw_unit_crossing_condition": "frac(exact NAND units / UNIT) < k / UNIT",
                           "k_for_one_raw_unit_without_special_structure": UNIT}

# 5. residue bound tightness: outer floors leave r - floor(2r/84) - floor(80r/84)
outer = max(r - 2 * r // 84 - 80 * r // 84 for r in range(84))
out["outer_residue_max"] = outer
# category floors leave at most 1; per-share floors S-1 each
# 6. overflow envelope: (T - base) * 80e18 * N must stay < 2^256
bem_cap_raw = 21 * 10 ** 6 * 10 ** 8
maxN = U256 // (bem_cap_raw * PPARTS * PREC)
out["overflow"] = {"bem_cap_raw_assumed": bem_cap_raw, "max_total_burn_weight_before_overflow": maxN,
                   "uint32_burn_x_miners_needed": maxN // (2 ** 32),
                   "carried_uint120_max_raw": 2 ** 120 - 1, "carried_units_x_burn_max": (2 ** 120 - 1) * PPARTS * PREC * (2 ** 32) < U256}

json.dump(out, open(sys.argv[1], "w"), indent=2, default=str)
print(json.dumps(out, indent=2, default=str))
