// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {PoolForkBase} from "./PoolForkBase.sol";

/// @notice 2.3.0 on real BSC state: one distributor and one receipt pair serve the processor's two custody
///         pools. Each pool binds the shared distributor, activates and opens custody on its own; the
///         NAND-only miner (FORK_NAND_MINER) earns in the optimal pool and the miner with LATCH burn
///         (FORK_LATCH_MINER, which also burns some NAND) in the regular pool, through the real
///         Mining.claim. The same receipts then claim each pool's income independently. Protocol code
///         and storage are never modified; miners are moved with fork-only impersonation.
contract TwoPoolForkTest is PoolForkBase {
    uint256 internal constant HOUR = 3600;

    struct Pools {
        uint256 carriedOptimal;
        uint256 carriedRegular;
        uint256 receivedOptimal;
        uint256 receivedRegular;
    }

    function testForkTwoPoolsShareOneDistributorAndClaimIndependently() public {
        // Receipts, both pools and the one distributor; the round finalized, the optimal pool bound and active.
        _deploySystemKeepingOwners();
        assertEq(address(distributor.optimalPool()), address(pool));
        assertEq(address(distributor.regularPool()), address(regularPool));
        vm.startPrank(operator);
        regularPool.bindDistributor(address(distributor));
        regularPool.activate(20, 10);
        _renounceAll();
        regularPool.renounceOwnership();
        vm.stopPrank();
        assertEq(regularPool.distributor(), pool.distributor());
        vm.prank(alice);
        distributor.claim(100); // NAND 1-12 and LATCH 1-4, delivered once

        Pools memory p;
        _moveToDepositor(nandMiner);
        _moveToDepositor(latchMiner);
        vm.startPrank(depositor);
        collection.setApprovalForAll(address(pool), true);
        collection.setApprovalForAll(address(regularPool), true);
        (, p.carriedOptimal) = pool.depositMiners(_one(nandMiner));
        (, p.carriedRegular) = regularPool.depositMiners(_one(latchMiner));
        vm.stopPrank();
        assertTrue(pool.custodyOpen() && regularPool.custodyOpen());
        vm.warp(block.timestamp + HOUR);
        (p.receivedOptimal,) = pool.harvest(_one(nandMiner));
        (p.receivedRegular,) = regularPool.harvest(_one(latchMiner));
        assertGt(p.receivedOptimal, 0, "real income in the optimal pool");
        assertGt(p.receivedRegular, 0, "real income in the regular pool");
        // Each pool accounts its own miner's income only.
        assertEq(pool.totalAccounted(), p.carriedOptimal + p.receivedOptimal);
        assertEq(regularPool.totalAccounted(), p.carriedRegular + p.receivedRegular);

        // NAND #1 earns in both pools; a claim in one leaves the other's entitlement and history unchanged.
        uint256 dueOptimal = pool.claimable(NAND, 1);
        uint256 dueRegular = regularPool.claimable(NAND, 1);
        assertGt(dueOptimal, 0);
        assertGt(dueRegular, 0);
        uint256 before = bem.balanceOf(alice);
        vm.prank(alice);
        pool.claim(NAND, 1);
        assertEq(bem.balanceOf(alice) - before, dueOptimal);
        assertEq(regularPool.claimed(NAND, 1), 0);
        assertEq(regularPool.claimable(NAND, 1), dueRegular);
        before = bem.balanceOf(alice);
        vm.prank(alice);
        regularPool.claim(NAND, 1);
        assertEq(bem.balanceOf(alice) - before, dueRegular);
        assertEq(pool.claimed(NAND, 1), dueOptimal);
        assertEq(regularPool.claimed(NAND, 1), dueRegular);
        // LATCH earns only where a miner burns LATCH: the regular pool.
        assertEq(pool.claimable(LATCH, 1), 0);
        assertGt(regularPool.claimable(LATCH, 1), 0);
        _assertLedger(pool);
        _assertLedger(regularPool);
    }

    function _assertLedger(TapeoutMinerPool target) internal view {
        TapeoutMinerPool.Reconciliation memory r = target.reconciliation();
        assertEq(r.deficit, 0);
        assertEq(
            r.bemBalance,
            (r.recipientAAccrued - r.recipientAPaid) + (r.recipientBAccrued - r.recipientBPaid)
                + (r.sinkAccrued - r.sinkPaid) + (r.nandReceiptsAccrued - r.nandReceiptsPaid)
                + (r.latchReceiptsAccrued - r.latchReceiptsPaid) + r.residue + r.unrecognized
        );
        assertEq(
            r.totalAccounted,
            r.recipientAAccrued + r.recipientBAccrued + r.sinkAccrued + r.nandReceiptsAccrued
                + r.latchReceiptsAccrued + r.residue
        );
    }
}
