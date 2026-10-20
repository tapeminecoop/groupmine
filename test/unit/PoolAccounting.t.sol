// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {PoolMath} from "../../src/PoolMath.sol";

contract PoolAccountingTest is SystemTestBase {
    function setUp() public override {
        super.setUp();
        setupStandard(); // S_N = 10, S_L = 10
    }

    /// @notice A and B each get 1/102 of gross; NAND + LATCH get 100/102. Not 98% / 1% / 1%.
    function testOuterSplitIsOneOneAndOneHundredOf102() public {
        admitNew(1, 1, 1);
        bem.mint(address(pool), 1_020_000);
        pool.sync();
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.recipientA, 10_000); // 1% would be 10_200
        assertEq(a.recipientB, 10_000);
        assertEq(a.participants, 1_000_000); // 98% would be 999_600
        assertEq(a.nandIncome, 500_000);
        assertEq(a.latchIncome, 500_000);
        assertEq(a.recipientA + a.recipientB + a.participants, a.total); // no other fee
        assertEq(pool.releaseA(), 10_000);
        assertEq(pool.releaseB(), 10_000);
        claimAs(alice, range(1, 5), range(1, 5));
        claimAs(bob, range(6, 10), none());
        claimAs(carol, none(), range(6, 10));
        assertEq(bem.balanceOf(address(pool)), 0);
        assertReconciled();
    }

    function testOuterFloorsAndTheirResidueAtSmallTotals() public pure {
        PoolMath.State memory s = PoolMath.State(0, 0, 0, 1, 1, 10, 10);
        PoolMath.Accrual memory a = PoolMath.accrue(101, s);
        assertEq(a.recipientA, 0);
        assertEq(a.participants, 99);
        assertEq(a.residue, 101 - 4 * 10 - 4 * 10); // per-share floors: 49 / 10 = 4 each
        a = PoolMath.accrue(102, s);
        assertEq(a.recipientA, 1);
        assertEq(a.recipientB, 1);
        assertEq(a.participants, 100);
        a = PoolMath.accrue(103, s);
        assertEq(a.recipientA + a.recipientB + a.participants, 102); // one raw unit retained
    }

    /// @notice Inside one composition period, many harvests equal one harvest.
    function testPathIndependenceWithinACompositionPeriod() public {
        admitNew(1, 7, 3);
        uint256 total;
        for (uint256 i = 1; i <= 30; ++i) {
            uint256 x = i * 37 + 11;
            total += x;
            accrue(1, x);
            pool.harvestRange(0, 1);
        }
        PoolMath.Accrual memory many = pool.accrual();
        PoolMath.Accrual memory once = PoolMath.accrue(total, pool.state());
        assertEq(keccak256(abi.encode(many)), keccak256(abi.encode(once)));
    }

    /// @notice A checkpoint carries at most one unallocated raw unit into the next period; settled
    ///         category totals are frozen exactly.
    function testCheckpointFreezesCategoryTotalsAndCarriesAtMostOneUnit() public {
        admitNew(1, 2, 1);
        accrue(1, 10_200); // participants 10_000: NAND floor(6666.67) = 6_666, LATCH floor(3333.33) = 3_333
        (uint256 settled,) = admitNew(2, 1, 1);
        assertEq(settled, 10_200);
        assertEq(pool.nandBase(), 6_666);
        assertEq(pool.latchBase(), 3_333);
        assertEq(pool.participantBase(), 9_999);
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.participants - pool.participantBase(), 1); // the one unit carried into period 2
        assertEq(a.nandIncome, 6_666); // floor(1 * 3 / 5) = 0: frozen totals unchanged
        assertEq(a.latchIncome, 3_333);
        bem.mint(address(pool), 510); // participants +500 -> d = 501 at 3:2
        pool.sync();
        a = pool.accrual();
        assertEq(a.nandIncome, 6_666 + uint256(501) * 3 / 5);
        assertEq(a.latchIncome, 3_333 + uint256(501) * 2 / 5);
        assertReconciled();
    }

    function testRoundingResidueStaysBoundedOverManyPeriodsAndHarvests() public {
        uint256 seed = 42;
        for (uint256 i = 1; i <= 12; ++i) {
            seed = uint256(keccak256(abi.encode(seed)));
            admitNew(i, uint32(1 + seed % 50), uint32(seed % 7));
            for (uint256 j = 1; j <= i; ++j) {
                accrue(j, (seed >> j) % 9_973);
            }
            pool.harvestRange(0, 100);
            assertReconciled();
        }
        claimAs(alice, range(1, 5), range(1, 5));
        claimAs(bob, range(6, 10), none());
        claimAs(carol, none(), range(6, 10));
        pool.releaseA();
        pool.releaseB();
        PoolMath.Accrual memory end = pool.accrual();
        assertEq(bem.balanceOf(address(pool)), end.residue);
        assertLe(end.residue, residueBound());
    }

    function testFuzzMathProperties(
        uint96 firstTotal,
        uint96 laterTotal,
        uint32 n0,
        uint32 l0,
        uint32 n1,
        uint32 l1,
        uint16 sN,
        uint16 sL
    ) public pure {
        vm.assume(uint256(n0) + l0 != 0 && uint256(n1) + l1 != 0);
        sN = uint16(bound(sN, 1, 5000));
        sL = uint16(bound(sL, 1, 5000));
        // Period 0 up to firstTotal, then a checkpoint, then period 1 up to firstTotal + laterTotal.
        PoolMath.State memory s = PoolMath.State(0, 0, 0, n0, l0, sN, sL);
        PoolMath.Accrual memory a0 = PoolMath.accrue(firstTotal, s);
        PoolMath.State memory s1 = PoolMath.State(
            a0.nandIncome,
            a0.latchIncome,
            a0.nandIncome + a0.latchIncome,
            uint256(n0) + n1,
            uint256(l0) + l1,
            sN,
            sL
        );
        uint256 total = uint256(firstTotal) + laterTotal;
        PoolMath.Accrual memory a1 = PoolMath.accrue(total, s1);
        // Conservation and bounds.
        assertEq(a1.recipientA + a1.recipientB + a1.nandReceipts + a1.latchReceipts + a1.residue, total);
        assertLe(a1.residue, 3 + (uint256(sN) - 1) + (uint256(sL) - 1));
        assertLe(a1.recipientA * 102, total);
        assertGt((a1.recipientA + 1) * 102, total);
        assertLe(a1.participants * 102, total * 100);
        // The old period's split is never recomputed with the new ratio.
        assertGe(a1.nandIncome, a0.nandIncome);
        assertGe(a1.latchIncome, a0.latchIncome);
        uint256 d = a1.participants - s1.participantBase;
        assertEq(a1.nandIncome, a0.nandIncome + d * s1.totalNandBurn / (s1.totalNandBurn + s1.totalLatchBurn));
        assertEq(
            a1.latchIncome, a0.latchIncome + d * s1.totalLatchBurn / (s1.totalNandBurn + s1.totalLatchBurn)
        );
        // Monotonic in the total within the period.
        PoolMath.Accrual memory a2 = PoolMath.accrue(total + 1_000_003, s1);
        assertGe(a2.perNandShare, a1.perNandShare);
        assertGe(a2.perLatchShare, a1.perLatchShare);
        assertGe(a2.recipientA, a1.recipientA);
    }
}
