// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutReceiptDistributor} from "../../src/TapeoutReceiptDistributor.sol";
import {PoolMath} from "../../src/PoolMath.sol";

/// @notice Review-only test (candidate 8cf31dc), risk group 4: a five-ledger sequence (direct
///         transfer, third-party Mining payout, pending-zero claim, carried income with a settled old
///         period, per-ID transfer and late delivery, role migration, releases at varying frequency)
///         checked after every step against an integer reference written here from docs/ACCOUNTING.md
///         (84 parts, independent floors, frozen bases with the one-unit carry, fixed denominators,
///         per-ID histories, C settled by every release). It does not use PoolMath, sdk/math.ts or
///         test/audit/model.py.
///         Receipts: NAND 1-5 alice, 6-8 bob, 9-10 in the distributor for carol (delivered late);
///         LATCH 1-5 alice, 6-10 carol.
/// @dev Adapted for TapeoutMinerPool/2.2.0 (SALUS remediation, docs/SALUS_AUDIT_REMEDIATION_REPORT.md):
///      only the reference's category ledger changed. Bases are kept in ledger units of 1 / (84 * 10^18)
///      raw BEM with their fractions (`baseT` replaces the one-unit carry `partBase`), each split gives
///      NAND the floor and LATCH the rest, and an incoming miner's carried income is split by that
///      miner's own burn instead of the post-admission composition. Everything else, the sequence and
///      the checks, is as committed at a74f6d4.
contract FeeSplitLedgerTest is SystemTestBase {
    address internal constant SINK = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant S_N = 10;
    uint256 internal constant S_L = 10;

    struct Ref {
        uint256 T;
        uint256 N;
        uint256 L;
        uint256 nandBase; // ledger units (2.2.0)
        uint256 latchBase; // ledger units (2.2.0)
        uint256 baseT; // recognized total at the last boundary (2.2.0)
        uint256 periods;
        uint256 aPaid;
        uint256 bPaid;
        uint256 cPaid;
        uint256 nandPaid;
        uint256 latchPaid;
        uint256 reached; // BEM that ever reached the pool
    }

    Ref internal ref;
    mapping(uint256 => uint256) internal refClaimedN;
    mapping(uint256 => uint256) internal refClaimedL;
    uint256[4] internal last; // nandIncome, latchIncome, perNand, perLatch for monotonicity
    address internal roleB;

    function setUp() public override {
        super.setUp();
        issue(nandReceipt, alice, 5);
        issue(nandReceipt, bob, 3);
        issue(nandReceipt, address(distributor), 2); // IDs 9, 10 straight into the distributor
        issue(latchReceipt, alice, 5);
        issue(latchReceipt, carol, 5);
        finalizeIssuance();
        TapeoutReceiptDistributor.AllocationInput[] memory e = new TapeoutReceiptDistributor.AllocationInput[](1);
        e[0] = TapeoutReceiptDistributor.AllocationInput({category: NAND, wallet: carol, firstId: 9, count: 2});
        vm.startPrank(operator);
        distributor.allocate(e);
        distributor.finalizeAllocation();
        vm.stopPrank();
        activate();
        roleB = recipientB;
    }

    // ---------------------------------------------------------------- reference (specification)

    function _rA(uint256 t) internal pure returns (uint256) {
        return t / 84;
    }

    function _rC(uint256 t) internal pure returns (uint256) {
        return t * 2 / 84;
    }

    function _rP(uint256 t) internal pure returns (uint256) {
        return t * 80 / 84;
    }

    uint256 internal constant UNITS_PER_RAW = 84 * 1e18; // 2.2.0 ledger unit

    function _rUnits() internal view returns (uint256 nand, uint256 latch) {
        nand = ref.nandBase;
        latch = ref.latchBase;
        uint256 w = ref.N + ref.L;
        if (w != 0) {
            uint256 d = (ref.T - ref.baseT) * 80 * 1e18; // the participants' exact share, in units
            uint256 toNand = d * ref.N / w;
            nand += toNand;
            latch += d - toNand;
        }
    }

    function _rIncomes() internal view returns (uint256 nand, uint256 latch) {
        (uint256 nandUnits, uint256 latchUnits) = _rUnits();
        return (nandUnits / UNITS_PER_RAW, latchUnits / UNITS_PER_RAW);
    }

    function _rPerShare() internal view returns (uint256 perN, uint256 perL) {
        (uint256 nand, uint256 latch) = _rIncomes();
        return (nand / S_N, latch / S_L);
    }

    function _refAdmit(uint32 n, uint32 l, uint256 settledOld, uint256 carried) internal {
        ref.T += settledOld; // step 3: old miners settle under the old composition
        ref.reached += settledOld;
        (uint256 nand, uint256 latch) = _rUnits(); // step 4: checkpoint, fractions kept
        ref.nandBase = nand;
        ref.latchBase = latch;
        ref.baseT = ref.T;
        ref.periods += 1;
        uint256 units = carried * 80 * 1e18; // step 5: carried income by the incoming miner's own burn
        uint256 toNand = units * n / (uint256(n) + l);
        ref.nandBase += toNand;
        ref.latchBase += units - toNand;
        ref.T += carried;
        ref.baseT = ref.T;
        ref.reached += carried;
        ref.N += n; // step 6: the new composition prices later income
        ref.L += l;
    }

    function _refRecognize(uint256 amount) internal {
        ref.T += amount;
        ref.reached += amount;
    }

    function _refRelease(bool isA) internal returns (uint256 roleDue, uint256 cDue) {
        roleDue = _rA(ref.T) - (isA ? ref.aPaid : ref.bPaid);
        if (isA) ref.aPaid = _rA(ref.T);
        else ref.bPaid = _rA(ref.T);
        cDue = _rC(ref.T) - ref.cPaid;
        ref.cPaid = _rC(ref.T);
    }

    function _refClaimN(uint256 id) internal returns (uint256 due) {
        (uint256 perN,) = _rPerShare();
        due = perN - refClaimedN[id];
        refClaimedN[id] = perN;
        ref.nandPaid += due;
    }

    function _refClaimL(uint256 id) internal returns (uint256 due) {
        (, uint256 perL) = _rPerShare();
        due = perL - refClaimedL[id];
        refClaimedL[id] = perL;
        ref.latchPaid += due;
    }

    /// @dev Everything the reference predicts, plus conservation, monotonicity, residue and
    ///      non-overpayment; called after every step once the pool has recognized its balance.
    function _check(string memory step) internal {
        PoolMath.Accrual memory a = pool.accrual();
        (uint256 nand, uint256 latch) = _rIncomes();
        (uint256 perN, uint256 perL) = _rPerShare();
        assertEq(pool.totalAccounted(), ref.T, string.concat(step, ": T"));
        assertEq(a.recipientA, _rA(ref.T), string.concat(step, ": A"));
        assertEq(a.recipientB, _rA(ref.T), string.concat(step, ": B"));
        assertEq(a.sink, _rC(ref.T), string.concat(step, ": C"));
        assertEq(a.participants, _rP(ref.T), string.concat(step, ": P"));
        assertEq(a.nandIncome, nand, string.concat(step, ": NAND income"));
        assertEq(a.latchIncome, latch, string.concat(step, ": LATCH income"));
        assertEq(a.perNandShare, perN, string.concat(step, ": per NAND"));
        assertEq(a.perLatchShare, perL, string.concat(step, ": per LATCH"));
        assertEq(pool.compositionPeriod(), ref.periods, string.concat(step, ": periods"));
        assertEq(pool.recipientAPaid(), ref.aPaid, string.concat(step, ": A paid"));
        assertEq(pool.recipientBPaid(), ref.bPaid, string.concat(step, ": B paid"));
        assertEq(pool.sinkPaid(), ref.cPaid, string.concat(step, ": C paid"));
        assertEq(pool.receiptsPaid(NAND), ref.nandPaid, string.concat(step, ": NAND paid"));
        assertEq(pool.receiptsPaid(LATCH), ref.latchPaid, string.concat(step, ": LATCH paid"));
        uint256 totalPaid = ref.aPaid + ref.bPaid + ref.cPaid + ref.nandPaid + ref.latchPaid;
        assertEq(pool.totalPaid(), totalPaid, string.concat(step, ": totalPaid"));
        for (uint256 id = 1; id <= S_N; ++id) {
            assertEq(pool.claimed(NAND, id), refClaimedN[id], string.concat(step, ": claimed NAND"));
            assertEq(pool.claimable(NAND, id), perN - refClaimedN[id], string.concat(step, ": claimable NAND"));
        }
        for (uint256 id = 1; id <= S_L; ++id) {
            assertEq(pool.claimed(LATCH, id), refClaimedL[id], string.concat(step, ": claimed LATCH"));
            assertEq(pool.claimable(LATCH, id), perL - refClaimedL[id], string.concat(step, ": claimable LATCH"));
        }
        // Conservation: the pool holds exactly what was recognized and not paid; every unit that ever
        // reached the pool is in the pool or with a payee.
        assertEq(bem.balanceOf(address(pool)), ref.T - totalPaid, string.concat(step, ": pool balance"));
        uint256 withPayees = bem.balanceOf(alice) + bem.balanceOf(bob) + bem.balanceOf(carol) + bem.balanceOf(dave)
            + bem.balanceOf(recipientA) + bem.balanceOf(recipientB) + bem.balanceOf(SINK);
        assertEq(withPayees + bem.balanceOf(address(pool)), ref.reached, string.concat(step, ": conservation"));
        // Non-overpayment per bucket and solvency: obligations never exceed what is held.
        assertLe(ref.aPaid, _rA(ref.T));
        assertLe(ref.cPaid, _rC(ref.T));
        assertLe(ref.nandPaid, S_N * perN);
        assertLe(ref.latchPaid, S_L * perL);
        uint256 obligations = (_rA(ref.T) - ref.aPaid) + (_rA(ref.T) - ref.bPaid) + (_rC(ref.T) - ref.cPaid)
            + (S_N * perN - ref.nandPaid) + (S_L * perL - ref.latchPaid);
        assertLe(obligations, bem.balanceOf(address(pool)), string.concat(step, ": solvent"));
        // Residue: at most 3 outer + 1 carried + (S - 1) per collection; C never receives it.
        uint256 residue = ref.T - 2 * _rA(ref.T) - _rC(ref.T) - S_N * perN - S_L * perL;
        assertEq(a.residue, residue);
        assertLe(residue, 4 + (S_N - 1) + (S_L - 1), string.concat(step, ": residue bound"));
        assertLe(_rP(ref.T) - nand - latch, 1, string.concat(step, ": at most one participant unit unallocated"));
        // Monotonicity of every entitlement.
        assertGe(nand, last[0]);
        assertGe(latch, last[1]);
        assertGe(perN, last[2]);
        assertGe(perL, last[3]);
        last = [nand, latch, perN, perL];
        assertReconciled();
    }

    function testFiveLedgerSequenceAgainstTheReference() public {
        // 1. First admission with carried income (3:1).
        newMiner(1, 3, 1);
        accrue(1, 84_000);
        admit(one(1));
        _refAdmit(3, 1, 0, 84_000);
        _check("1 admission");

        // 2. Direct transfer and a third-party Mining payout, then anyone syncs.
        bem.mint(address(pool), 8_400);
        accrue(1, 4_200);
        vm.prank(address(0xD00D));
        mining.claim(mining.minerKey(address(nft), 1));
        assertEq(pool.sync(), 12_600);
        _refRecognize(12_600);
        _check("2 donation + third party");

        // 3. Income hidden from pending(); a harvest still collects it.
        mining.accrueUnsettled(address(nft), 1, 2_100);
        assertEq(mining.pending(mining.minerKey(address(nft), 1)), 0);
        (uint256 received,) = pool.harvestRange(0, 1);
        assertEq(received, 2_100);
        _refRecognize(2_100);
        _check("3 pending-zero harvest");

        // 4. A release of A (C settled), then B after more income (C's new backlog only).
        (uint256 roleDue, uint256 cDue) = _refRelease(true);
        assertEq(pool.releaseA(), roleDue);
        assertEq(bem.balanceOf(SINK), cDue);
        _check("4a release A");
        bem.mint(address(pool), 1_234);
        (roleDue, cDue) = (0, 0);
        _refRecognize(1_234);
        (roleDue, cDue) = _refRelease(false);
        uint256 sinkBefore = bem.balanceOf(SINK);
        assertEq(pool.releaseB(), roleDue);
        assertEq(bem.balanceOf(SINK) - sinkBefore, cDue);
        _check("4b release B");

        // 5. Per-ID transfer with history: alice claims NAND 1 then gives it to bob; bob claims the rest later.
        vm.prank(alice);
        assertEq(pool.claim(NAND, 1), _refClaimN(1));
        _check("5a alice claims NAND 1");
        vm.prank(alice);
        nandReceipt.safeTransferFrom(alice, bob, 1, 1, "");
        _check("5b transfer keeps the history");

        // 6. A new miner (1:1) with carried income, old miner settled under the old composition.
        accrue(1, 1_000);
        newMiner(2, 1, 1);
        mining.accrueUnsettled(address(nft), 2, 5_000);
        (uint256 settled, uint256 carried) = admit(one(2));
        assertEq(settled, 1_000);
        assertEq(carried, 5_000);
        _refAdmit(1, 1, 1_000, 5_000);
        _check("6 second admission");

        // 7. Late delivery: carol's NAND 9-10 arrive with everything they accrued, then she claims.
        vm.prank(carol);
        assertEq(distributor.claim(10), 2);
        _check("7a late delivery");
        uint256 due9 = _refClaimN(9);
        uint256 due10 = _refClaimN(10);
        assertEq(claimAs(carol, two(9, 10), none()), due9 + due10);
        _check("7b carol claims delivered receipts");

        // 8. Role migration: B moves to dave; the next release pays dave B's unreleased income.
        vm.prank(roleB);
        pool.setRecipient(TapeoutMinerPool.Recipient.B, dave);
        roleB = dave;
        accrue(2, 7_777);
        pool.harvestRange(1, 1);
        _refRecognize(7_777);
        (roleDue, cDue) = _refRelease(false);
        sinkBefore = bem.balanceOf(SINK);
        assertEq(pool.releaseB(), roleDue);
        assertEq(bem.balanceOf(dave), roleDue);
        assertEq(bem.balanceOf(SINK) - sinkBefore, cDue);
        _check("8 role migration + release");

        // 9. Bob claims the transferred ID (only income since alice's claim) and his own.
        uint256 dueBob = _refClaimN(1) + _refClaimN(6) + _refClaimN(7) + _refClaimN(8);
        assertEq(claimAs(bob, range(1, 1), none()) + claimAs(bob, range(6, 8), none()), dueBob);
        _check("9 bob claims");

        // 10. Alice claims everything she still holds; carol claims LATCH; releases at the end.
        uint256 dueAlice;
        for (uint256 id = 2; id <= 5; ++id) {
            dueAlice += _refClaimN(id);
        }
        for (uint256 id = 1; id <= 5; ++id) {
            dueAlice += _refClaimL(id);
        }
        assertEq(claimAs(alice, range(2, 5), range(1, 5)), dueAlice);
        uint256 dueCarol;
        for (uint256 id = 6; id <= 10; ++id) {
            dueCarol += _refClaimL(id);
        }
        assertEq(claimAs(carol, none(), range(6, 10)), dueCarol);
        _check("10 remaining claims");
        bem.mint(address(pool), 83);
        _refRecognize(83);
        (roleDue, cDue) = _refRelease(true);
        sinkBefore = bem.balanceOf(SINK);
        assertEq(pool.releaseA(), roleDue);
        assertEq(bem.balanceOf(SINK) - sinkBefore, cDue);
        (roleDue, cDue) = _refRelease(false);
        assertEq(pool.releaseB(), roleDue);
        assertEq(cDue, 0, "C was settled by A's release at the same total");
        _check("11 final releases");

        // 12. Every holder claims everything once more: nothing is left but the bounded residue.
        uint256 dueAll;
        for (uint256 id = 2; id <= 5; ++id) {
            dueAll += _refClaimN(id);
        }
        for (uint256 id = 1; id <= 5; ++id) {
            dueAll += _refClaimL(id);
        }
        assertEq(claimAs(alice, range(2, 5), range(1, 5)), dueAll);
        dueAll = _refClaimN(1) + _refClaimN(6) + _refClaimN(7) + _refClaimN(8);
        assertEq(claimAs(bob, range(1, 1), none()) + claimAs(bob, range(6, 8), none()), dueAll);
        dueAll = _refClaimN(9) + _refClaimN(10);
        for (uint256 id = 6; id <= 10; ++id) {
            dueAll += _refClaimL(id);
        }
        assertEq(claimAs(carol, two(9, 10), range(6, 10)), dueAll);
        _check("12 everything claimed");
        assertEq(bem.balanceOf(address(pool)), pool.accrual().residue, "only the bounded residue remains");
        assertLe(pool.accrual().residue, 4 + 9 + 9);
    }
}
