#!/usr/bin/env python3
"""Independent reference model for the Groupmine 2.2.0 review (target 6345de8), written by Fable 5.1.

Written only from the economic specification in the audit brief (section 3) and docs/ACCOUNTING.md.
It does not import, read or paraphrase src/PoolMath.sol, sdk/math.ts, test/salus-ffi/model.py or
test/audit/model.py. It keeps a list of ledger entries and derives every quantity from scratch on each
query, in two ways at once:

  * POLICY: the finite-precision rule the candidate claims. Ledger unit = 1/(84*10^18) raw BEM. Each
    entry (amount, n, l) gives NAND floor(amount*80*10^18*n/(n+l)) units; LATCH gets the exact
    remainder amount*80*10^18 - that. Category income = floor(units / (84*10^18)); per share =
    floor(income / S). A = B = floor(T/84), C = floor(2T/84).
  * EXACT: the rational economics (fractions.Fraction) with no flooring at all.

The model is driven by a trace (one op per ';'), built by test/review-fable51/ReviewDifferential.t.sol
from the same random actions it applies to the real contracts. Prints an ABI-encoded uint256[] whose
first word is a status (0 = every model invariant held, 1 = a violation, printed on stderr), followed
by the end state (see words()). Standard library only; no file, process or network access.

Ops (ids are miner token ids; actors are indices into ACTORS):
  M:id,n,l,vis,hid    prepare miner id (held by the depositor) with burn (n,l) and owed income vis+hid
  A:id,id,...         depositMiners(ids) by the depositor (any failing precondition => whole op reverts)
  N:id                plain ERC-721 transfer of a depositor-held miner to the pool (registers nothing)
  E:id,id,...         registerMiners(ids) for pool-held miners
  R:id,amt            more income accrues to miner id inside Mining
  H                   harvest every registered miner (failures are isolated)
  P:id                third-party Mining.claim(id): pays the NFT's holder (pool or depositor)
  D:amt               plain BEM transfer (donation) to the pool
  V:id                revocation: pays the holder what a claim would pay, then status REVOKED (terminal)
  K:id / U:id         mock-only: ACTIVE -> COOLING / COOLING -> ACTIVE (no payout)
  C:cat,id,actor      actor claims receipt (cat,id); must be its holder
  X:cat,id,actor      receipt transfer to actor
  L:role              releaseA (0) / releaseB (1); also pays all unpaid C to the sink
"""
import sys
from fractions import Fraction

PARTS = 84
PPARTS = 80
PREC = 10 ** 18
UNIT = PARTS * PREC
SUPPLY = {0: 6, 1: 4}
# alice 0 (NAND 1-3), bob 1 (NAND 4-6), carol 2 (LATCH 1-2), dave 3 (LATCH 3-4), eve 4,
# recipientA 5, recipientB 6, sink 7, depositor 8
ACTORS = 9
SINK = 7
DEP = 8
INITIAL = {0: [None, 0, 0, 0, 1, 1, 1], 1: [None, 2, 2, 3, 3]}


class Violation(Exception):
    pass


class Miner:
    __slots__ = ("n", "l", "owed", "status", "holder", "registered", "carried")

    def __init__(self, n, l, owed):
        self.n, self.l, self.owed = n, l, owed
        self.status = 1
        self.holder = "dep"
        self.registered = False
        self.carried = 0


class Model:
    def __init__(self):
        self.miners = {}
        self.registry = []
        self.T = 0
        self.paid = 0
        self.bal = 0
        self.minted = 0
        self.closed = []          # (amount, n, l) closed entries: periods and carried miners
        self.open_income = 0      # ordinary income of the open period
        self.N = 0
        self.L = 0
        self.periods = 0
        self.carried_total = 0
        self.claimed = {c: [0] * (s + 1) for c, s in SUPPLY.items()}
        self.holder = {c: list(v) for c, v in INITIAL.items()}
        self.rec_paid = [0, 0]
        self.sink_paid = 0
        self.receipts_paid = [0, 0]
        self.actor = [0] * ACTORS
        self.last = None

    # ------------------------------------------------------------ specification arithmetic
    @staticmethod
    def nand_units(amount, n, l):
        return amount * PPARTS * PREC * n // (n + l)

    def entries(self):
        e = list(self.closed)
        if self.open_income and self.N + self.L:
            e.append((self.open_income, self.N, self.L))
        return e

    def units(self):
        nand = sum(self.nand_units(a, n, l) for a, n, l in self.entries())
        return nand, self.T * PPARTS * PREC - nand

    def boundary(self):
        nand = sum(self.nand_units(a, n, l) for a, n, l in self.closed)
        base = sum(a for a, _, _ in self.closed)
        return base, nand, base * PPARTS * PREC - nand

    def incomes(self):
        n, l = self.units()
        return n // UNIT, l // UNIT

    def per_share(self):
        n, l = self.incomes()
        return n // SUPPLY[0], l // SUPPLY[1]

    def exact(self):
        nand = sum(Fraction(a * PPARTS * n, PARTS * (n + l)) for a, n, l in self.entries())
        return nand, Fraction(self.T * PPARTS, PARTS) - nand

    def A(self):
        return self.T // PARTS

    def C(self):
        return 2 * self.T // PARTS

    # ------------------------------------------------------------ pool mechanics
    def recognize(self):
        if self.N + self.L == 0:
            return 0
        received = self.bal - (self.T - self.paid)
        if received < 0:
            raise Violation("pool balance below its ledger")
        self.T += received
        self.open_income += received
        return received

    def pay_holder(self, m):
        amount = m.owed
        m.owed = 0
        if m.holder == "pool":
            self.bal += amount
        else:
            self.actor[DEP] += amount
        self.minted += amount
        return amount

    def _admit(self, ids, pull):
        if not ids or len(ids) > 50 or len(set(ids)) != len(ids):
            return
        for i in ids:
            m = self.miners.get(i)
            if m is None or m.registered or m.status != 1 or m.n + m.l == 0:
                return
            if m.holder != ("dep" if pull else "pool"):
                return
        for r in self.registry:
            if self.miners[r].status == 3:
                return  # strict settlement: a COOLING old miner reverts the admission
        self.recognize()
        for r in self.registry:
            m = self.miners[r]
            if m.status == 1:
                self.pay_holder(m)
        self.recognize()
        # checkpoint: close the ordinary period
        if self.open_income:
            self.closed.append((self.open_income, self.N, self.L))
            self.open_income = 0
        self.periods += 1
        for i in ids:
            m = self.miners[i]
            m.holder = "pool"
            m.registered = True
            self.registry.append(i)
        for i in ids:
            m = self.miners[i]
            r = self.pay_holder(m)
            m.carried = r
            self.carried_total += r
            self.T += r
            if r:
                self.closed.append((r, m.n, m.l))
        for i in ids:
            self.N += self.miners[i].n
            self.L += self.miners[i].l
        self.recognize()

    # ------------------------------------------------------------ ops
    def op_M(self, i, n, l, vis, hid):
        if i in self.miners:
            raise Violation("duplicate miner id in trace")
        self.miners[i] = Miner(n, l, vis + hid)

    def op_A(self, *ids):
        self._admit(list(ids), True)

    def op_N(self, i):
        m = self.miners.get(i)
        if m is not None and m.holder == "dep":
            m.holder = "pool"

    def op_E(self, *ids):
        self._admit(list(ids), False)

    def op_R(self, i, amt):
        self.miners[i].owed += amt

    def op_H(self):
        if self.N + self.L == 0:
            return  # the pool refuses nothing here, but with no registry there is nothing to harvest
        self.recognize()
        for r in self.registry:
            m = self.miners[r]
            if m.status == 1:
                self.pay_holder(m)
        self.recognize()

    def op_P(self, i):
        m = self.miners[i]
        if m.status == 1:
            self.pay_holder(m)

    def op_D(self, amt):
        self.bal += amt
        self.minted += amt

    def op_V(self, i):
        m = self.miners[i]
        if m.status == 1:
            self.pay_holder(m)
            m.status = 2

    def op_K(self, i):
        m = self.miners[i]
        if m.status == 1:
            m.status = 3

    def op_U(self, i):
        m = self.miners[i]
        if m.status == 3:
            m.status = 1

    def op_C(self, c, rid, actor):
        if self.holder[c][rid] != actor:
            raise Violation("trace claims an ID by a non-holder")
        self.recognize()
        per = self.per_share()[c]
        due = per - self.claimed[c][rid]
        if due < 0:
            raise Violation("claimed history above entitlement")
        self.claimed[c][rid] = per
        self.paid += due
        self.bal -= due
        self.actor[actor] += due
        self.receipts_paid[c] += due

    def op_X(self, c, rid, to):
        self.holder[c][rid] = to

    def op_L(self, role):
        self.recognize()
        due = self.A() - self.rec_paid[role]
        sink_due = self.C() - self.sink_paid
        if due < 0 or sink_due < 0:
            raise Violation("paid above accrual")
        self.rec_paid[role] = self.A()
        self.sink_paid = self.C()
        self.paid += due + sink_due
        self.bal -= due + sink_due
        self.actor[5 + role] += due
        self.actor[SINK] += sink_due

    # ------------------------------------------------------------ invariants
    def observe(self):
        n, l = self.incomes()
        pn, pl = self.per_share()
        now = (n, l, pn, pl, self.A(), self.C())
        if self.last is not None and any(a < b for a, b in zip(now, self.last)):
            raise Violation("an entitlement decreased")
        self.last = now
        p = self.T * PPARTS // PARTS
        if not p - 1 <= n + l <= p:
            raise Violation("category incomes not within one unit of the participants' floor")
        if self.paid > self.T or self.bal < 0:
            raise Violation("paid more than recognized / negative balance")
        base, nb, lb = self.boundary()
        if nb + lb != base * PPARTS * PREC:
            raise Violation("boundary ledger identity broken")
        if sum(self.actor) + self.bal != self.minted:
            raise Violation("BEM not conserved")

    def finish(self):
        self.recognize()
        self.observe()
        n, l = self.incomes()
        en, el = self.exact()
        k = len(self.entries())
        slack = Fraction(k, UNIT)
        # NAND: never above exact, below by less than 1 raw unit + k ledger units. LATCH: the mirror.
        if not (en - 1 - slack < n <= en):
            raise Violation("NAND income outside its bound against the exact economics")
        if not (el - 1 < l <= el + slack):
            raise Violation("LATCH income outside its bound against the exact economics")
        pn, pl = self.per_share()
        residue = self.T - 2 * self.A() - self.C() - SUPPLY[0] * pn - SUPPLY[1] * pl
        if residue < 0 or residue > 4 + (SUPPLY[0] - 1) + (SUPPLY[1] - 1):
            raise Violation("residue outside its bound")
        if self.N + self.L and self.bal != self.T - self.paid:
            raise Violation("balance differs from the ledger after recognition")
        if sum(self.miners[i].carried for i in self.registry) != self.carried_total:
            raise Violation("per-miner carried income does not add up")

    def words(self):
        n, l = self.incomes()
        nu, lu = self.units()
        pn, pl = self.per_share()
        base, nb, lb = self.boundary()
        carried_nand = sum(self.nand_units(self.miners[i].carried, self.miners[i].n, self.miners[i].l) for i in self.registry)
        residue = self.T - 2 * self.A() - self.C() - SUPPLY[0] * pn - SUPPLY[1] * pl
        out = [self.T, self.A(), self.C(), n, l, pn, pl, residue, self.paid, self.rec_paid[0], self.rec_paid[1],
               self.sink_paid, self.receipts_paid[0], self.receipts_paid[1], self.carried_total, carried_nand,
               nu, lu, base, nb, lb, self.N, self.L, len(self.registry), self.bal, self.periods]
        out += self.claimed[0][1:] + self.claimed[1][1:] + self.actor
        out += [self.miners[i].carried for i in self.registry]
        return out


FIXED_WORDS = 26 + SUPPLY[0] + SUPPLY[1] + ACTORS


def word(x):
    if x < 0:
        raise Violation("negative word")
    return format(x, "064x")


def main():
    trace = sys.argv[1] if len(sys.argv) > 1 else ""
    model = Model()
    status = 0
    try:
        for op in filter(None, trace.split(";")):
            kind, _, rest = op.partition(":")
            args = [int(x) for x in rest.split(",")] if rest else []
            getattr(model, "op_" + kind)(*args)
            model.observe()
        model.finish()
    except Violation as v:
        status = 1
        print(f"model violation: {v}", file=sys.stderr)
    values = model.words() if status == 0 else [0] * FIXED_WORDS
    out = [status] + values
    print("0x" + word(0x20) + word(len(out)) + "".join(word(x) for x in out))


if __name__ == "__main__":
    main()
