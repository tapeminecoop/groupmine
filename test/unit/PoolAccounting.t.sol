// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PoolTestBase} from "../helpers/PoolTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {PoolMath} from "../../src/PoolMath.sol";

contract PoolAccountingTest is PoolTestBase {
    /// @notice The worked example from the specification, at full share counts, through real
    ///         harvest and claim paths: 1,020 BEM, W_N = 0.8, S_N = 900, H_N = 100, S_L = 80, H_L = 20.
    function testSpecificationExample1020Bem() public {
        TapeoutMinerPool.Config memory c = cfg(900, 80, 100, 20, 80_000_000);
        configure(c);
        issueRange(NAND, alice, 1, 450);
        issueRange(NAND, bob, 451, 450);
        issueRange(LATCH, alice, 1, 40);
        issueRange(LATCH, carol, 41, 40);
        activate();
        newMinersDeposited(1, 3);
        mining.accrue(address(nft), 1, 500 * BEM_UNIT);
        mining.accrue(address(nft), 2, 300 * BEM_UNIT);
        mining.accrue(address(nft), 3, 220 * BEM_UNIT);
        (uint256 received, uint256 failed) = pool.harvestRange(0, 3);
        assertEq(received, 1020 * BEM_UNIT);
        assertEq(failed, 0);

        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.total, 1020 * BEM_UNIT);
        assertEq(a.fee, 20 * BEM_UNIT);
        assertEq(a.entitlement, 1000 * BEM_UNIT);
        assertEq(a.nandIncome, 800 * BEM_UNIT);
        assertEq(a.latchIncome, 200 * BEM_UNIT);
        assertEq(a.perNandShare, 80_000_000); // 0.8 BEM
        assertEq(a.perLatchShare, 2 * BEM_UNIT);
        assertEq(a.nandReceipts, 720 * BEM_UNIT);
        assertEq(a.historicalNand, 80 * BEM_UNIT);
        assertEq(a.latchReceipts, 160 * BEM_UNIT);
        assertEq(a.historicalLatch, 40 * BEM_UNIT);
        assertEq(a.residue, 0);
        assertEq(pool.claimable(NAND, 900), 80_000_000);
        assertEq(pool.claimable(LATCH, 80), 2 * BEM_UNIT);

        assertEq(claimAs(alice, range(1, 450), range(1, 40)), 440 * BEM_UNIT); // 360 + 80
        assertEq(claimAs(bob, range(451, 900), none()), 360 * BEM_UNIT);
        assertEq(claimAs(carol, none(), range(41, 80)), 80 * BEM_UNIT);
        assertEq(pool.releaseFee(), 20 * BEM_UNIT);
        assertEq(pool.releaseHistorical(NAND), 80 * BEM_UNIT);
        assertEq(pool.releaseHistorical(LATCH), 40 * BEM_UNIT);

        assertEq(bem.balanceOf(alice), 440 * BEM_UNIT);
        assertEq(bem.balanceOf(bob), 360 * BEM_UNIT);
        assertEq(bem.balanceOf(carol), 80 * BEM_UNIT);
        assertEq(bem.balanceOf(feeTo), 20 * BEM_UNIT);
        assertEq(bem.balanceOf(histNandTo), 80 * BEM_UNIT);
        assertEq(bem.balanceOf(histLatchTo), 40 * BEM_UNIT);
        assertEq(bem.balanceOf(address(pool)), 0);
        assertEq(pool.totalPaid(), 1020 * BEM_UNIT);
        assertReconciled();
    }

    /// @notice The fee is 2/102 of gross (about 1.960784%), not 2% of gross.
    function testFeeIsTwoOver102NotTwoPercent() public {
        setupDefault();
        bem.mint(address(pool), 1_000_000);
        pool.sync();
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.fee, 19_607); // floor(1_000_000 * 2 / 102); 2% would be 20_000
        assertEq(a.entitlement, 980_393);
        assertEq(a.fee + a.entitlement, 1_000_000);
        // Applying the fee once more to historical income would have produced a smaller historical share.
        assertEq(a.historicalNand, a.perNandShare); // H_N = 1 share, same weight as one receipt
    }

    function testWeightsAndShareCountsVaryIndependently() public view {
        // Equal weights, equal counts.
        _assertAllocation(cfg(10, 10, 0, 0, 50_000_000), 102_000, 2_000, 5_000, 5_000);
        // Category weight decides the split; share counts only divide within each category.
        _assertAllocation(cfg(10, 1000, 0, 0, 50_000_000), 102_000, 2_000, 5_000, 50);
        _assertAllocation(cfg(10, 10, 0, 0, 90_000_000), 102_000, 2_000, 9_000, 1_000);
        // All income to one category.
        _assertAllocation(cfg(4, 3, 0, 0, W), 102_000, 2_000, 25_000, 0);
        _assertAllocation(cfg(4, 3, 0, 0, 0), 102_000, 2_000, 0, 33_333);
    }

    function testEightDecimalWeightPrecision() public {
        // W_N = 0.33333333 -> NAND gets floor(10_000 * 0.33333333) = 3_333, LATCH floor(6_666.6667).
        TapeoutMinerPool.Config memory c = cfg(3, 7, 0, 0, 33_333_333);
        setupAndActivate(c, alice, bob, alice, carol);
        bem.mint(address(pool), 10_200);
        pool.sync();
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.fee, 200);
        assertEq(a.nandIncome, 3_333);
        assertEq(a.latchIncome, 6_666);
        assertEq(a.perNandShare, 1_111);
        assertEq(a.perLatchShare, 952);
        assertEq(a.residue, 3); // 1 from the category split + 2 from 6_666 / 7
        assertLe(a.residue, residueBound(c));
        assertReconciled();
    }

    function testHistoricalSharesAddToDenominatorAndHaveTheirOwnRecipient() public {
        // Without historical shares.
        TapeoutMinerPool.Config memory c = cfg(8, 4, 0, 0, 80_000_000);
        PoolMath.Accrual memory zero = accrualOf(102_000, c);
        assertEq(zero.perNandShare, 10_000); // 80_000 / 8
        assertEq(zero.perLatchShare, 5_000); // 20_000 / 4
        assertEq(zero.historicalNand + zero.historicalLatch, 0);

        // With H_N = 2, H_L = 1: denominators 10 and 5.
        c = cfg(8, 4, 2, 1, 80_000_000);
        setupAndActivate(c, alice, bob, alice, carol);
        bem.mint(address(pool), 102_000);
        pool.sync();
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.perNandShare, 8_000);
        assertEq(a.perLatchShare, 4_000);
        assertEq(a.historicalNand, 16_000);
        assertEq(a.historicalLatch, 4_000);
        assertEq(a.nandReceipts + a.historicalNand, a.nandIncome);
        assertEq(a.latchReceipts + a.historicalLatch, a.latchIncome);
        assertEq(pool.historicalClaimable(NAND), 16_000);
        assertEq(pool.historicalClaimable(LATCH), 4_000);
        // The historical BEM has an owner and is paid, not silently retained.
        assertEq(pool.releaseHistorical(NAND), 16_000);
        assertEq(pool.releaseHistorical(LATCH), 4_000);
        assertEq(bem.balanceOf(histNandTo), 16_000);
        assertEq(bem.balanceOf(histLatchTo), 4_000);
        assertEq(pool.historicalClaimable(NAND), 0);
        assertEq(pool.releaseHistorical(NAND), 0); // repeated release pays nothing
        assertReconciled();
    }

    function testZeroHistoricalReleaseIsANoOp() public {
        setupAndActivate(cfg(4, 4, 0, 0, 50_000_000), alice, bob, alice, bob);
        bem.mint(address(pool), 10_000);
        assertEq(pool.releaseHistorical(NAND), 0);
        assertEq(pool.releaseHistorical(LATCH), 0);
        assertEq(pool.historicalPaid(NAND), 0);
        assertReconciled();
    }

    /// @notice Small increments with many shares: per-share income is floored, the residue
    ///         stays bounded and is picked up by later income instead of accumulating.
    function testRoundingResidueIsBoundedAndNotLost() public {
        TapeoutMinerPool.Config memory c = cfg(97, 13, 3, 2, 61_803_399);
        setupAndActivate(c, alice, bob, alice, carol);
        uint256 bound = residueBound(c);
        uint256 seed = 7;
        for (uint256 i; i < 60; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            bem.mint(address(pool), seed % 5_000);
            pool.sync();
            PoolMath.Accrual memory a = pool.accrual();
            assertLe(a.residue, bound);
            assertReconciled();
            if (i % 9 == 0) claimAs(alice, range(1, 49), range(1, 7));
        }
        claimAs(alice, range(1, 49), range(1, 7));
        claimAs(bob, range(50, 97), none());
        claimAs(carol, none(), range(8, 13));
        pool.releaseFee();
        pool.releaseHistorical(NAND);
        pool.releaseHistorical(LATCH);
        PoolMath.Accrual memory end = pool.accrual();
        // Everything except the bounded residue has been paid.
        assertEq(bem.balanceOf(address(pool)), end.residue);
        assertEq(pool.totalPaid() + end.residue, pool.totalAccounted());
        assertReconciled();
    }

    /// @notice Entitlements depend only on cumulative income, not on how it was harvested.
    function testAllocationIsPathIndependent() public {
        TapeoutMinerPool.Config memory c = cfg(7, 3, 2, 1, 70_000_000);
        setupAndActivate(c, alice, bob, alice, carol);
        uint256 total;
        for (uint256 i = 1; i <= 25; ++i) {
            uint256 x = i * 37 + 11;
            total += x;
            bem.mint(address(pool), x);
            pool.sync();
        }
        PoolMath.Accrual memory many = pool.accrual();
        PoolMath.Accrual memory once = accrualOf(total, c);
        assertEq(abi.encode(many), abi.encode(once));
    }

    function testFuzzMathProperties(
        uint128 total,
        uint32 weightSeed,
        uint32 sN,
        uint32 sL,
        uint32 hN,
        uint32 hL
    ) public pure {
        uint256 w = uint256(weightSeed) % (uint256(W) + 1);
        sN = uint32(bound(sN, 0, 1_000_000));
        sL = uint32(bound(sL, 0, 1_000_000));
        hN = uint32(bound(hN, 0, 1_000_000));
        hL = uint32(bound(hL, 0, 1_000_000));
        if (w != 0 && uint256(sN) + hN == 0) sN = 1;
        if (w != W && uint256(sL) + hL == 0) sL = 1;
        PoolMath.Shares memory s = PoolMath.Shares(sN, sL, hN, hL, w);
        PoolMath.Accrual memory a = PoolMath.accrue(total, s);
        // Fee is floor(2T/102); entitlement takes the rest.
        assertLe(a.fee * 102, uint256(total) * 2);
        assertGt((a.fee + 1) * 102, uint256(total) * 2);
        assertEq(a.fee + a.entitlement, total);
        // Category split within one raw unit of the exact weights.
        assertLe(a.nandIncome + a.latchIncome, a.entitlement);
        assertLe(a.entitlement - a.nandIncome - a.latchIncome, 1);
        // Every bucket accounted, residue bounded.
        uint256 dN = uint256(sN) + hN;
        uint256 dL = uint256(sL) + hL;
        uint256 bound_ = 1 + (dN == 0 ? 0 : dN - 1) + (dL == 0 ? 0 : dL - 1);
        assertLe(a.residue, bound_);
        assertEq(
            a.fee + a.nandReceipts + a.latchReceipts + a.historicalNand + a.historicalLatch + a.residue, total
        );
        // One historical share is worth exactly one receipt.
        if (hN != 0) assertEq(a.historicalNand, uint256(hN) * a.perNandShare);
        if (hL != 0) assertEq(a.historicalLatch, uint256(hL) * a.perLatchShare);
    }

    function testFuzzBucketsAreMonotonic(uint128 total, uint64 delta, uint32 weightSeed) public pure {
        uint256 w = uint256(weightSeed) % (uint256(W) + 1);
        PoolMath.Shares memory s = PoolMath.Shares(901, 77, 99, 23, w);
        PoolMath.Accrual memory a = PoolMath.accrue(total, s);
        PoolMath.Accrual memory b = PoolMath.accrue(uint256(total) + delta, s);
        assertGe(b.fee, a.fee);
        assertGe(b.perNandShare, a.perNandShare);
        assertGe(b.perLatchShare, a.perLatchShare);
        assertGe(b.historicalNand, a.historicalNand);
        assertGe(b.historicalLatch, a.historicalLatch);
    }

    function _assertAllocation(
        TapeoutMinerPool.Config memory c,
        uint256 income,
        uint256 fee,
        uint256 perNand,
        uint256 perLatch
    ) private pure {
        PoolMath.Accrual memory a = accrualOf(income, c);
        assertEq(a.fee, fee);
        assertEq(a.perNandShare, perNand);
        assertEq(a.perLatchShare, perLatch);
        assertEq(
            a.fee + a.nandReceipts + a.latchReceipts + a.historicalNand + a.historicalLatch + a.residue,
            income
        );
    }
}
