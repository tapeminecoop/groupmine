// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {ReceiptHolder} from "../helpers/Mocks.sol";

/// @dev Ported receipt-claim regressions (groupmine 48a2d74, TapeoutMarket/test1 9d86a26).
///      Pool: S_N = 10 (alice 1..5, bob 6..10), S_L = 10 (alice 1..5, carol 6..10), one 3:1 miner.
///      105_000 raw of income -> A 1_250, B 1_250, C 2_500, NAND 75_000 (7_500 per ID), LATCH 25_000
///      (2_500 per ID).
contract PoolClaimsTest is SystemTestBase {
    function setUp() public override {
        super.setUp();
        setupStandard();
        admitNew(1, 3, 1);
    }

    function _income(uint256 amount) internal {
        bem.mint(address(pool), amount);
    }

    function testIndividualAndBatchClaimsPayOnlyTheCallersIds() public {
        _income(105_000);
        vm.prank(alice);
        assertEq(pool.claim(NAND, 1), 7_500);
        assertEq(claimAs(alice, range(2, 5), range(1, 2)), 4 * 7_500 + 2 * 2_500);
        assertEq(pool.claimable(NAND, 6), 7_500);
        assertEq(pool.claimable(LATCH, 6), 2_500);
        assertEq(bem.balanceOf(bob), 0);
        assertEq(pool.receiptsPaid(NAND), 37_500);
        assertEq(pool.receiptsPaid(LATCH), 5_000);
        assertReconciled();
    }

    function testRepeatedClaimsPayOnlyNewIncome() public {
        _income(105_000);
        claimAs(alice, one(1), none());
        assertEq(claimAs(alice, one(1), none()), 0);
        _income(52_500);
        assertEq(claimAs(alice, one(1), none()), 3_750);
        assertEq(pool.claimed(NAND, 1), 11_250);
    }

    function testUnclaimedIncomeFollowsTheReceiptAndTheFormerHolderLosesIt() public {
        _income(105_000);
        claimAs(alice, one(2), none());
        vm.prank(alice);
        nandReceipt.safeTransferFrom(alice, bob, 1, 1, "");
        assertEq(pool.claimable(NAND, 1), 7_500);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, NAND, 1));
        pool.claim(NAND, 1);
        vm.prank(bob);
        assertEq(pool.claim(NAND, 1), 7_500);
        assertEq(pool.claimable(NAND, 3), 7_500);
        assertEq(pool.claimable(LATCH, 1), 2_500);
        assertReconciled();
    }

    function testClaimedHistoryStaysWithTheIdAcrossTransfers() public {
        _income(105_000);
        claimAs(alice, one(1), none());
        _income(105_000);
        vm.prank(alice);
        nandReceipt.safeTransferFrom(alice, bob, 1, 1, "");
        assertEq(claimAs(bob, one(1), none()), 7_500);
        vm.prank(bob);
        nandReceipt.safeTransferFrom(bob, alice, 1, 1, "");
        assertEq(claimAs(alice, one(1), none()), 0);
    }

    function testSameNumberedIdsInBothCollectionsAreIndependent() public {
        vm.prank(alice);
        latchReceipt.safeTransferFrom(alice, carol, 1, 1, "");
        _income(105_000);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, NAND, 1));
        pool.claim(NAND, 1);
        vm.prank(alice);
        assertEq(pool.claim(NAND, 1), 7_500);
        assertEq(pool.claimed(LATCH, 1), 0);
        vm.prank(carol);
        assertEq(pool.claim(LATCH, 1), 2_500);
        assertEq(pool.claimed(NAND, 1), 7_500);
        assertEq(pool.claimed(LATCH, 1), 2_500);
    }

    function testApprovedOperatorCannotClaimUntilItHoldsTheId() public {
        _income(105_000);
        vm.prank(alice);
        nandReceipt.setApprovalForAll(bob, true);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, NAND, 1));
        pool.claim(NAND, 1);
        vm.prank(bob);
        nandReceipt.safeTransferFrom(alice, bob, 1, 1, "");
        vm.prank(bob);
        assertEq(pool.claim(NAND, 1), 7_500);
    }

    function testInvalidEmptyForeignAndDuplicateClaims() public {
        _income(105_000);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.ReceiptIdOutOfRange.selector, NAND, 0));
        pool.claim(NAND, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.ReceiptIdOutOfRange.selector, LATCH, 11));
        pool.claimBatch(none(), one(11));
        vm.prank(alice);
        vm.expectRevert(TapeoutMinerPool.InvalidBatch.selector);
        pool.claimBatch(none(), none());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, NAND, 6));
        pool.claimBatch(two(1, 6), none());
        assertEq(pool.claimed(NAND, 1), 0);
        uint256[] memory dup = new uint256[](3);
        (dup[0], dup[1], dup[2]) = (2, 2, 2);
        assertEq(claimAs(alice, dup, dup), 7_500 + 2_500);
    }

    function testClaimsDoNotDependOnMiningOrAdmissions() public {
        accrue(1, 105_000);
        pool.harvestRange(0, 1);
        mining.setBroken(true);
        _income(52_500);
        newMiner(2, 1, 1);
        vm.startPrank(depositor);
        nft.setApprovalForAll(address(pool), true);
        vm.expectRevert();
        pool.depositMiners(one(2)); // admission impossible while Mining fails
        vm.stopPrank();
        assertEq(claimAs(alice, one(1), none()), 11_250); // held income still claimable
        assertReconciled();
    }

    function testClaimableViewsPredictPayouts() public {
        _income(105_000);
        pool.sync();
        _income(10_500);
        (uint256[] memory amounts, uint256 total) = pool.claimableBatch(NAND, range(1, 5));
        assertEq(amounts[0], 8_250);
        assertEq(total, 5 * 8_250);
        assertEq(pool.unrecognizedBalance(), 10_500);
        assertEq(pool.recipientClaimable(TapeoutMinerPool.Recipient.A), 1_375);
        assertEq(pool.sinkClaimable(), 2_750);
        vm.prank(alice);
        assertEq(pool.claimBatch(range(1, 5), none()), total);
    }

    function testRecipientPaymentsAreIndependentOfEachOtherAndOfClaims() public {
        _income(105_000);
        vm.prank(dave);
        assertEq(pool.releaseB(), 1_250);
        assertEq(bem.balanceOf(pool.SINK()), 2_500); // C's whole part with the first release
        assertEq(pool.releaseB(), 0);
        assertEq(pool.recipientClaimable(TapeoutMinerPool.Recipient.A), 1_250);
        claimAs(alice, range(1, 5), range(1, 5));
        assertEq(pool.releaseA(), 1_250);
        assertEq(bem.balanceOf(pool.SINK()), 2_500);
        assertEq(bem.balanceOf(dave), 0);
        assertReconciled();
    }

    function testClaimFromReceiveHookPaysTheNewHolderOnce() public {
        ReceiptHolder holder = new ReceiptHolder();
        _income(105_000);
        holder.setHook(address(pool), abi.encodeCall(TapeoutMinerPool.claim, (NAND, 1)));
        vm.prank(alice);
        nandReceipt.safeTransferFrom(alice, address(holder), 1, 1, "");
        assertTrue(holder.hookOk());
        assertEq(bem.balanceOf(address(holder)), 7_500);
        assertEq(pool.claimable(NAND, 1), 0);
    }
}
