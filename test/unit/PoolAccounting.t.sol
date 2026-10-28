// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {PoolMath} from "../../src/PoolMath.sol";

contract PoolAccountingTest is SystemTestBase {
    function setUp() public override {
        super.setUp();
        setupStandard(); // S_N = 10, S_L = 10
    }

    /// @notice Relative weights NAND + LATCH 100 : A 1.25 : B 1.25 : C 2.5 (105 parts), i.e. 80 : 1 : 1 : 2
    ///         of 84. Not a 95% participant share, and not a 5% fee: 100 / 105 = 95.238...%.
    function testOuterSplitIsEightyOneOneTwoOf84() public {
        admitNew(1, 1, 1);
        bem.mint(address(pool), 1_050_000);
        pool.sync();
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.recipientA, 12_500); // 1.25 of 105
        assertEq(a.recipientB, 12_500);
        assertEq(a.sink, 25_000); // 2.5 of 105
        assertEq(a.participants, 1_000_000); // 95% would be 997_500
        assertEq(a.nandIncome, 500_000);
        assertEq(a.latchIncome, 500_000);
        assertEq(a.recipientA + a.recipientB + a.sink + a.participants, a.total); // no other fee
        assertEq(pool.releaseA(), 12_500);
        assertEq(bem.balanceOf(pool.SINK()), 25_000);
        assertEq(pool.releaseB(), 12_500);
        claimAs(alice, range(1, 5), range(1, 5));
        claimAs(bob, range(6, 10), none());
        claimAs(carol, none(), range(6, 10));
        assertEq(bem.balanceOf(address(pool)), 0);
        assertReconciled();
    }

    function testOuterFloorsAndTheirResidueAtSmallTotals() public pure {
        PoolMath.State memory s = PoolMath.State(0, 0, 0, 1, 1, 10, 10);
        PoolMath.Accrual memory a = PoolMath.accrue(83, s);
        assertEq(a.recipientA, 0);
        assertEq(a.sink, 1);
        assertEq(a.participants, 79);
        assertEq(a.residue, 83 - 1 - 3 * 10 - 3 * 10); // per-share floors: 39 / 10 = 3 each
        a = PoolMath.accrue(84, s);
        assertEq(a.recipientA, 1);
        assertEq(a.recipientB, 1);
        assertEq(a.sink, 2);
        assertEq(a.participants, 80);
        a = PoolMath.accrue(85, s);
        assertEq(a.recipientA + a.recipientB + a.sink + a.participants, 84); // one raw unit retained
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
        PoolMath.Accrual memory once = PoolMath.accrue(total, pool.ledgerState());
        assertEq(keccak256(abi.encode(many)), keccak256(abi.encode(once)));
    }

    /// @notice A checkpoint freezes the category entitlements with their fractions (ledger units of
    ///         1 / (84 * 10^18) raw BEM). 2.2.0 replaces 2.1.0's whole-unit bases and one carried unit.
    function testCheckpointFreezesCategoryTotalsAndCarriesAtMostOneUnit() public {
        admitNew(1, 2, 1);
        accrue(1, 10_500); // participants exactly 10_000: NAND 6_666.67, LATCH 3_333.33
        (uint256 settled,) = admitNew(2, 1, 1);
        assertEq(settled, 10_500);
        PoolMath.State memory s = pool.ledgerState();
        assertEq(s.accountedBase, 10_500);
        assertEq(s.nandBase, 560_000 * 1e18); // 10_500 * 80e18 * 2 / 3, no fraction dropped
        assertEq(s.latchBase, 280_000 * 1e18);
        assertEq(s.nandBase + s.latchBase, s.accountedBase * 80 * 1e18);
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.nandIncome, 6_666); // the frozen entitlements, floored for display and claims
        assertEq(a.latchIncome, 3_333);
        assertEq(a.participants - a.nandIncome - a.latchIncome, 1);
        bem.mint(address(pool), 525); // participants +500 exactly, at 3:2: NAND +300, LATCH +200
        pool.sync();
        a = pool.accrual();
        assertEq(a.nandIncome, 6_966); // floor(6_666.67 + 300)
        assertEq(a.latchIncome, 3_533); // floor(3_333.33 + 200)
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
        (uint256 nand0, uint256 latch0) = PoolMath.categoryUnits(firstTotal, s);
        PoolMath.State memory s1 =
            PoolMath.State(firstTotal, nand0, latch0, uint256(n0) + n1, uint256(l0) + l1, sN, sL);
        uint256 total = uint256(firstTotal) + laterTotal;
        PoolMath.Accrual memory a1 = PoolMath.accrue(total, s1);
        // Conservation and bounds.
        assertEq(
            a1.recipientA + a1.recipientB + a1.sink + a1.nandReceipts + a1.latchReceipts + a1.residue, total
        );
        assertLe(a1.residue, 4 + (uint256(sN) - 1) + (uint256(sL) - 1));
        assertLe(a1.recipientA * 84, total);
        assertGt((a1.recipientA + 1) * 84, total);
        assertLe(a1.sink * 84, total * 2);
        assertGt((a1.sink + 1) * 84, total * 2);
        assertLe(a1.participants * 84, total * 80);
        assertGt((a1.participants + 1) * 84, total * 80);
        assertLe(total - a1.recipientA - a1.recipientB - a1.sink - a1.participants, 3); // outer floors
        assertLe(a1.participants - a1.nandIncome - a1.latchIncome, 1);
        // The old period's split is never recomputed with the new ratio: against the exact rational
        // entitlement firstTotal * 80/84 * n0/w0 + laterTotal * 80/84 * n1'/w1, NAND is at most one raw
        // unit below (ledger floors are below 2 * 10^-18 of a unit) and never above; LATCH the mirror.
        uint256 w0 = uint256(n0) + l0;
        uint256 w1 = s1.totalNandBurn + s1.totalLatchBurn;
        uint256 den = 84 * w0 * w1;
        uint256 exactNand = 80 * (uint256(firstTotal) * n0 * w1 + uint256(laterTotal) * s1.totalNandBurn * w0);
        uint256 exactLatch =
            80 * (uint256(firstTotal) * l0 * w1 + uint256(laterTotal) * s1.totalLatchBurn * w0);
        assertLe(a1.nandIncome * den, exactNand);
        assertGt((a1.nandIncome + 2) * den, exactNand);
        assertLe(a1.latchIncome * den, exactLatch + den);
        assertGt((a1.latchIncome + 1) * den, exactLatch);
        assertGe(a1.nandIncome, a0.nandIncome);
        assertGe(a1.latchIncome, a0.latchIncome);
        // Monotonic in the total within the period.
        PoolMath.Accrual memory a2 = PoolMath.accrue(total + 1_000_003, s1);
        assertGe(a2.perNandShare, a1.perNandShare);
        assertGe(a2.perLatchShare, a1.perLatchShare);
        assertGe(a2.recipientA, a1.recipientA);
        assertGe(a2.sink, a1.sink);
        assertGe(a2.participants, a1.participants);
    }
}
