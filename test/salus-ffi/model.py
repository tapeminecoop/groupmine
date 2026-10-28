#!/usr/bin/env python3
"""Independent reference model of the TapeoutMinerPool/2.2.0 ledger (SALUS remediation).

Written from the business rule of the SALUS remediation brief and docs/ACCOUNTING.md, not from
src/PoolMath.sol or sdk/math.ts, and deliberately formulated differently from them: the contract keeps
running boundary bases, while this model keeps a list of ledger entries and derives every category
amount from scratch on each query.

  * An entry is (raw amount, n, l): an ordinary composition period (the income recognized while the
    pool's aggregate composition was (n, l), summed over the period) or one incoming miner's carried
    income (what its own claim paid during its admission, with that miner's own burn (n, l)).
  * NAND ledger units = sum over entries of floor(amount * 80 * 10^18 * n / (n + l)); LATCH units are the
    participants' exact total T * 80 * 10^18 minus that. A ledger unit is 1 / (84 * 10^18) raw BEM.
  * Category income = floor(units / (84 * 10^18)); per share = floor(income / S).
  * Outer parts: A = B = floor(T / 84), C = floor(2T / 84), each from T on its own.

Exact rational arithmetic (fractions.Fraction) gives the ideal split the integer rule approximates;
finish() checks that each category stays within one raw unit of it.

Called by test/salus-ffi/SalusDifferential.t.sol through vm.ffi with one argument, a trace
"K:a,b,c;K:...;" (the op letters are documented on each op_ method). Prints an ABI-encoded uint256[]
whose first word is a status (0 = every model invariant held, 1 = one was violated; the message goes to
stderr) followed by the expected end state (see words()). Standard library only, no file, process or
network access.
"""
import sys
from fractions import Fraction

TOTAL_PARTS = 84
PARTICIPANT_PARTS = 80
PRECISION = 10 ** 18
LEDGER_UNIT = TOTAL_PARTS * PRECISION
SUPPLY = {0: 7, 1: 5}
# Receipt holders at activation (actor indices): NAND 1-4 alice(0), 5-7 bob(1); LATCH 1-3 carol(2), 4-5 dave(3).
INITIAL_HOLDER = {0: [None, 0, 0, 0, 0, 1, 1, 1], 1: [None, 2, 2, 2, 3, 3]}
ACTORS = 9  # alice, bob, carol, dave, eve, frank, recipientA, recipientB, sink C
SINK = 8


class Violation(Exception):
    pass


class Miner:
    def __init__(self, n, l):
        self.n = n
        self.l = l
        self.owed = 0          # BEM still inside Mining for this miner (pending or hidden from pending)
        self.registered = False
        self.revoked = False
        self.carried = 0


class Model:
    def __init__(self):
        self.miners = {}
        self.order = []        # registry order
        self.T = 0             # recognized income
        self.paid = 0
        self.bal = 0           # BEM held by the pool
        self.reached = 0       # BEM that ever reached the pool
        self.entries = []      # closed entries: (amount, n, l)
        self.period_income = 0 # ordinary income of the open period
        self.periods = 0
        self.carried_total = 0
        self.claimed = {0: [0] * (SUPPLY[0] + 1), 1: [0] * (SUPPLY[1] + 1)}
        self.holder = {c: list(v) for c, v in INITIAL_HOLDER.items()}
        self.rec_paid = [0, 0]
        self.sink_paid = 0
        self.receipts_paid = [0, 0]
        self.actor = [0] * ACTORS
        self.last = (0, 0, 0, 0)

    # ------------------------------------------------------------------ specification arithmetic
    def composition(self):
        n = sum(self.miners[m].n for m in self.order)
        l = sum(self.miners[m].l for m in self.order)
        return n, l

    def open_entries(self):
        n, l = self.composition()
        if self.period_income and n + l:
            return self.entries + [(self.period_income, n, l)]
        return list(self.entries)

    @staticmethod
    def nand_part(amount, n, l):
        return amount * PARTICIPANT_PARTS * PRECISION * n // (n + l)

    def units(self):
        nand = sum(self.nand_part(a, n, l) for a, n, l in self.open_entries())
        return nand, self.T * PARTICIPANT_PARTS * PRECISION - nand

    def incomes(self):
        nand, latch = self.units()
        return nand // LEDGER_UNIT, latch // LEDGER_UNIT

    def per_share(self):
        nand, latch = self.incomes()
        return nand // SUPPLY[0], latch // SUPPLY[1]

    def ideal(self):
        nand = sum(Fraction(a * PARTICIPANT_PARTS * n, TOTAL_PARTS * (n + l)) for a, n, l in self.open_entries())
        return nand, Fraction(self.T * PARTICIPANT_PARTS, TOTAL_PARTS) - nand

    def A(self):
        return self.T // TOTAL_PARTS

    def C(self):
        return 2 * self.T // TOTAL_PARTS

    def recognize(self):
        """Ordinary income: whatever the pool holds beyond its ledger, under the current composition."""
        n, l = self.composition()
        if n + l == 0:
            return 0
        received = self.bal - (self.T - self.paid)
        if received < 0:
            raise Violation("pool balance below its ledger")
        self.T += received
        self.period_income += received
        return received

    def close_period(self):
        n, l = self.composition()
        if self.period_income:
            if n + l == 0:
                raise Violation("ordinary income recognized without a composition")
            self.entries.append((self.period_income, n, l))
        self.period_income = 0
        self.periods += 1

    def pay_from_mining(self, m):
        miner = self.miners[m]
        amount = miner.owed
        miner.owed = 0
        self.bal += amount
        self.reached += amount
        return amount

    # ------------------------------------------------------------------ operations (trace letters)
    def op_P(self, m, n, l, carry):
        """P:miner,n,l,carry  a miner outside the pool with burn (n, l) that has `carry` inside Mining."""
        if m in self.miners:
            raise Violation("miner prepared twice")
        self.miners[m] = Miner(n, l)
        self.miners[m].owed = carry

    def op_A(self, *ids):
        """A:m1,m2,...  one admission of these prepared miners, in this order."""
        if len(set(ids)) != len(ids):
            raise Violation("trace admits a miner twice in one batch")
        for m in ids:
            if self.miners[m].registered or self.miners[m].revoked:
                raise Violation("trace admits a registered or revoked miner")
        self.recognize()                               # held BEM: old composition
        for m in self.order:                           # strict settlement of the registered miners
            if not self.miners[m].revoked:
                self.pay_from_mining(m)
        self.recognize()
        self.close_period()                            # freeze the old period
        batch_carried = 0
        for m in ids:                                  # each incoming miner on its own, its own burn
            miner = self.miners[m]
            miner.carried = self.pay_from_mining(m)
            if miner.carried:
                self.entries.append((miner.carried, miner.n, miner.l))
            batch_carried += miner.carried
            miner.registered = True
            self.order.append(m)
        self.T += batch_carried
        self.carried_total += batch_carried
        self.recognize()                               # anything else held: the new composition

    def op_R(self, m, amount):
        """R:miner,amount  income accrues inside Mining (visible to claim, maybe not to pending)."""
        if not self.miners[m].revoked:
            self.miners[m].owed += amount

    def op_H(self):
        """H  harvest every registered miner (a revoked one fails and is skipped)."""
        self.recognize()
        for m in self.order:
            if not self.miners[m].revoked:
                self.pay_from_mining(m)
        self.recognize()

    def op_T(self, m):
        """T:miner  a third party calls Mining.claim for a registered miner: held, not yet recognized."""
        if self.miners[m].registered and not self.miners[m].revoked:
            self.pay_from_mining(m)

    def op_D(self, amount):
        """D:amount  a plain BEM transfer to the pool: held, not yet recognized."""
        self.bal += amount
        self.reached += amount

    def op_V(self, m):
        """V:miner  the miner is revoked: whatever it still owed can never be collected."""
        self.miners[m].revoked = True
        self.miners[m].owed = 0

    def op_C(self, category, receipt_id, actor):
        """C:category,id,actor  the holder claims one receipt ID."""
        if self.holder[category][receipt_id] != actor:
            raise Violation("trace claims an ID by a non-holder")
        self.recognize()
        per = self.per_share()[category]
        due = per - self.claimed[category][receipt_id]
        if due < 0:
            raise Violation("claimed history above entitlement")
        self.claimed[category][receipt_id] = per
        self.paid += due
        self.bal -= due
        self.actor[actor] += due
        self.receipts_paid[category] += due

    def op_X(self, category, receipt_id, to):
        """X:category,id,to  a receipt transfer: unpaid income stays with the ID."""
        self.holder[category][receipt_id] = to

    def op_L(self, role):
        """L:role  release A (0) or B (1), which also pays C's whole unpaid part to the sink."""
        self.recognize()
        due = self.A() - self.rec_paid[role]
        sink_due = self.C() - self.sink_paid
        if due < 0 or sink_due < 0:
            raise Violation("paid above accrual")
        self.rec_paid[role] = self.A()
        self.sink_paid = self.C()
        self.paid += due + sink_due
        self.bal -= due + sink_due
        self.actor[6 + role] += due
        self.actor[SINK] += sink_due

    # ------------------------------------------------------------------ invariants
    def observe(self):
        nand, latch = self.incomes()
        pn, pl = self.per_share()
        if any(x < y for x, y in zip((nand, latch, pn, pl), self.last)):
            raise Violation("an entitlement decreased")
        self.last = (nand, latch, pn, pl)
        participants = self.T * PARTICIPANT_PARTS // TOTAL_PARTS
        if not participants - 1 <= nand + latch <= participants:
            raise Violation("more than one participant unit unallocated")
        if self.paid > self.T:
            raise Violation("paid more than recognized")
        if self.bal < 0:
            raise Violation("negative pool balance")

    def finish(self):
        self.recognize()
        self.observe()
        nand, latch = self.incomes()
        ideal_nand, ideal_latch = self.ideal()
        slack = Fraction(len(self.open_entries()), LEDGER_UNIT)
        if not (ideal_nand - 1 - slack < nand <= ideal_nand):
            raise Violation("NAND income is not within one raw unit below its exact rational entitlement")
        if not (ideal_latch - 1 < latch <= ideal_latch + slack):
            raise Violation("LATCH income is not within one raw unit of its exact rational entitlement")
        pn, pl = self.per_share()
        for c, per in ((0, pn), (1, pl)):
            for i in range(1, SUPPLY[c] + 1):
                if self.claimed[c][i] > per:
                    raise Violation("claimed history above entitlement")
        residue = self.T - 2 * self.A() - self.C() - SUPPLY[0] * pn - SUPPLY[1] * pl
        if residue < 0 or residue > 4 + (SUPPLY[0] - 1) + (SUPPLY[1] - 1):
            raise Violation("residue outside its bound")
        if sum(self.actor) + self.bal != self.reached:
            raise Violation("BEM not conserved")
        n, l = self.composition()
        if n + l and self.bal != self.T - self.paid:
            raise Violation("pool balance differs from the ledger after recognition")
        if sum(self.miners[m].carried for m in self.order) != self.carried_total:
            raise Violation("per-miner carried income does not add up")

    def words(self):
        nand, latch = self.incomes()
        nand_units, latch_units = self.units()
        pn, pl = self.per_share()
        carried_nand = sum(self.nand_part(self.miners[m].carried, self.miners[m].n, self.miners[m].l) for m in self.order)
        residue = self.T - 2 * self.A() - self.C() - SUPPLY[0] * pn - SUPPLY[1] * pl
        n, l = self.composition()
        out = [self.T, self.A(), self.C(), nand, latch, pn, pl, residue, self.paid, self.rec_paid[0], self.rec_paid[1],
               self.sink_paid, self.receipts_paid[0], self.receipts_paid[1], self.carried_total, carried_nand,
               nand_units, latch_units, n, l, len(self.order), self.bal]
        out += self.claimed[0][1:] + self.claimed[1][1:] + self.actor
        return out


WORDS = 22 + SUPPLY[0] + SUPPLY[1] + ACTORS


def word(x):
    return format(x, "064x")


def main():
    trace = sys.argv[1] if len(sys.argv) > 1 else "-"
    model = Model()
    status = 0
    try:
        for op in filter(None, trace.split(";")):
            if op == "-":
                continue
            kind, _, rest = op.partition(":")
            args = [int(x) for x in rest.split(",")] if rest else []
            getattr(model, "op_" + kind)(*args)
            model.observe()
        model.finish()
    except Violation as v:
        status = 1
        print(f"model violation: {v}", file=sys.stderr)
    values = model.words() if status == 0 else [0] * WORDS
    out = [status] + values
    print("0x" + word(0x20) + word(len(out)) + "".join(word(x) for x in out))


if __name__ == "__main__":
    main()
