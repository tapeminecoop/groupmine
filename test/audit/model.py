#!/usr/bin/env python3
"""Independent reference model of the TapeOut pool ledger (internal security review, revision f2c8e50).

Written from the specification in docs/ACCOUNTING.md and the business rules of the review brief, NOT from
src/PoolMath.sol or sdk/math.ts, so that it can disagree with them. Exact integer arithmetic for the
contract-level expectations and exact rational arithmetic (fractions.Fraction) for the ideal split that
the integer rules approximate.

Called by test/audit/AuditDifferential.t.sol through vm.ffi with one argument: a trace of operations
"K:a,b,c;K:...;" (see the Solidity file for the op list). Prints an ABI-encoded uint256[] (hex) whose
first word is a status (0 = all model invariants held, 1 = a model invariant was violated; the message
goes to stderr) followed by the expected end state.
"""
import sys
from fractions import Fraction

TOTAL_PARTS = 102
PARTICIPANT_PARTS = 100
SUPPLY = {0: 7, 1: 5}
# Receipt holders at activation (actor indices): NAND 1-4 alice(0), 5-7 bob(1); LATCH 1-3 carol(2), 4-5 dave(3).
INITIAL_HOLDER = {0: [None, 0, 0, 0, 0, 1, 1, 1], 1: [None, 2, 2, 2, 3, 3]}
ACTORS = 8  # alice, bob, carol, dave, eve, frank, recipientA (initial), recipientB (initial)


class Violation(Exception):
    pass


class Model:
    def __init__(self):
        self.T = 0            # recognized income (totalAccounted)
        self.paid = 0         # total paid out
        self.bal = 0          # BEM actually held by the pool
        self.N = 0
        self.L = 0
        self.nandBase = 0
        self.latchBase = 0
        self.partBase = 0
        self.periods = 0
        self.owed = {}        # miner -> BEM still inside Mining (pending or hidden)
        self.registered = []
        self.claimed = {0: [0] * (SUPPLY[0] + 1), 1: [0] * (SUPPLY[1] + 1)}
        self.holder = {c: list(v) for c, v in INITIAL_HOLDER.items()}
        self.recipient = [6, 7]
        self.recPaid = [0, 0]
        self.receiptsPaid = [0, 0]
        self.actor = [0] * ACTORS
        self.reached = 0      # BEM that ever reached the pool
        self.ideal = [Fraction(0), Fraction(0)]
        self.pStart = 0
        self.last = (0, 0, 0, 0)

    # ---------------------------------------------------------------- specification arithmetic
    def P(self, T):
        return T * PARTICIPANT_PARTS // TOTAL_PARTS

    def A(self, T):
        return T // TOTAL_PARTS

    def incomes(self, T):
        nand, latch = self.nandBase, self.latchBase
        weight = self.N + self.L
        if weight:
            d = self.P(T) - self.partBase
            if d < 0:
                raise Violation("participants below the checkpointed base")
            nand += d * self.N // weight
            latch += d * self.L // weight
        return nand, latch

    def per_share(self, T):
        nand, latch = self.incomes(T)
        return nand // SUPPLY[0], latch // SUPPLY[1]

    def recognize(self):
        if self.N + self.L == 0:
            return 0
        expected = self.T - self.paid
        if self.bal < expected:
            raise Violation("pool balance below its ledger")
        received = self.bal - expected
        self.T += received
        return received

    def settle(self, miner):
        amount = self.owed.get(miner, 0)
        self.owed[miner] = 0
        self.bal += amount
        self.reached += amount

    def close_period(self):
        weight = self.N + self.L
        if weight == 0:
            return
        dP = self.P(self.T) - self.pStart
        self.ideal[0] += Fraction(dP * self.N, weight)
        self.ideal[1] += Fraction(dP * self.L, weight)

    def open_period(self):
        self.pStart = self.P(self.T)

    # ---------------------------------------------------------------- operations (trace letters)
    def op_A(self, miner, n, l, carry):
        """Admission of one miner with composition (n, l) that carries `carry` inside Mining."""
        self.owed[miner] = self.owed.get(miner, 0) + carry
        self.recognize()                                   # step 2: held BEM, old composition
        for m in self.registered:                          # step 3: settle every registered miner
            self.settle(m)
        self.recognize()
        nand, latch = self.incomes(self.T)                 # step 4: checkpoint
        self.close_period()
        self.nandBase, self.latchBase, self.partBase = nand, latch, nand + latch
        self.periods += 1
        self.N += n
        self.L += l
        self.registered.append(miner)
        self.open_period()
        self.settle(miner)                                 # step 5: carried income, new composition
        self.recognize()

    def op_R(self, miner, amount):
        self.owed[miner] = self.owed.get(miner, 0) + amount

    def op_H(self):
        self.recognize()
        for m in self.registered:
            self.settle(m)
        self.recognize()

    def op_T(self, miner):
        self.settle(miner)                                 # third-party Mining.claim: not recognized yet

    def op_D(self, amount):
        self.bal += amount                                 # direct BEM transfer: not recognized yet
        self.reached += amount

    def op_C(self, category, receipt_id, actor):
        if self.holder[category][receipt_id] != actor:
            raise Violation("trace claims an ID by a non-holder")
        self.recognize()
        per = self.per_share(self.T)[category]
        due = per - self.claimed[category][receipt_id]
        if due < 0:
            raise Violation("claimed history above entitlement")
        self.claimed[category][receipt_id] = per
        self.paid += due
        self.bal -= due
        self.actor[actor] += due
        self.receiptsPaid[category] += due

    def op_X(self, category, receipt_id, to):
        self.holder[category][receipt_id] = to

    def op_L(self, role):
        self.recognize()
        accrued = self.A(self.T)
        due = accrued - self.recPaid[role]
        if due < 0:
            raise Violation("role paid above accrual")
        self.recPaid[role] = accrued
        self.paid += due
        self.bal -= due
        self.actor[self.recipient[role]] += due

    def op_G(self, role, to):
        self.recipient[role] = to

    # ---------------------------------------------------------------- invariants
    def observe(self):
        nand, latch = self.incomes(self.T)
        pn, pl = self.per_share(self.T)
        if (nand, latch, pn, pl) < self.last or any(x < y for x, y in zip((nand, latch, pn, pl), self.last)):
            raise Violation("an entitlement decreased")
        self.last = (nand, latch, pn, pl)
        P = self.P(self.T)
        if not (P - 1 <= nand + latch <= P):
            raise Violation("more than one participant unit unallocated")
        if self.bal < 0:
            raise Violation("negative pool balance")

    def finish(self):
        self.recognize()
        self.observe()
        self.close_period()
        nand, latch = self.incomes(self.T)
        for c, value in ((0, nand), (1, latch)):
            if abs(Fraction(value) - self.ideal[c]) > self.periods + 1:
                raise Violation("integer split drifts from the exact rational split by more than one unit per period")
        pn, pl = self.per_share(self.T)
        for c, per in ((0, pn), (1, pl)):
            for i in range(1, SUPPLY[c] + 1):
                if self.claimed[c][i] > per:
                    raise Violation("claimed history above entitlement")
        residue = self.T - 2 * self.A(self.T) - SUPPLY[0] * pn - SUPPLY[1] * pl
        if residue < 0 or residue > 3 + (SUPPLY[0] - 1) + (SUPPLY[1] - 1):
            raise Violation("residue outside its bound")
        if sum(self.actor) + self.bal != self.reached:
            raise Violation("BEM not conserved")
        # Before the first admission there is no composition to split by: the pool deliberately leaves
        # BEM unrecognized (docs/ACCOUNTING.md 1); afterwards balance and ledger must agree.
        if self.N + self.L != 0 and self.bal != self.T - self.paid:
            raise Violation("pool balance differs from ledger after recognition")

    def words(self):
        nand, latch = self.incomes(self.T)
        pn, pl = self.per_share(self.T)
        residue = self.T - 2 * self.A(self.T) - SUPPLY[0] * pn - SUPPLY[1] * pl
        out = [self.T, self.A(self.T), nand, latch, pn, pl, residue, self.paid, self.recPaid[0], self.recPaid[1],
               self.receiptsPaid[0], self.receiptsPaid[1], self.periods, self.bal]
        out += self.claimed[0][1:] + self.claimed[1][1:] + self.actor
        return out


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
    values = model.words() if status == 0 else [0] * (14 + SUPPLY[0] + SUPPLY[1] + ACTORS)
    out = [status] + values
    print("0x" + word(0x20) + word(len(out)) + "".join(word(x) for x in out))


if __name__ == "__main__":
    main()
