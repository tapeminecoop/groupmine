// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PoolTestBase} from "../helpers/PoolTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {ReceiptHolder} from "../helpers/Mocks.sol";

/// @dev Default pool: S_N=9 (alice 1..5, bob 6..9), S_L=4 (alice 1..2, carol 3..4), H_N=H_L=1, W_N=0.8.
///      102_000 raw of income -> fee 2_000, NAND 80_000 / 10 = 8_000 per share,
///      LATCH 20_000 / 5 = 4_000 per share.
contract PoolClaimsTest is PoolTestBase {
    function setUp() public override {
        super.setUp();
        setupDefault();
    }

    function _income(uint256 amount) internal {
        bem.mint(address(pool), amount);
    }

    function testIndividualAndBatchClaimsPayOnlyTheCallersIds() public {
        _income(102_000);
        vm.prank(alice);
        assertEq(pool.claim(NAND, 1), 8_000);
        vm.prank(alice);
        assertEq(pool.claimBatch(range(2, 5), range(1, 2)), 4 * 8_000 + 2 * 4_000);
        assertEq(bem.balanceOf(alice), 5 * 8_000 + 2 * 4_000);
        // Others' entitlements are untouched.
        assertEq(pool.claimable(NAND, 6), 8_000);
        assertEq(pool.claimable(LATCH, 3), 4_000);
        assertEq(bem.balanceOf(bob), 0);
        assertEq(pool.receiptsPaid(NAND), 40_000);
        assertEq(pool.receiptsPaid(LATCH), 8_000);
        assertReconciled();
    }

    function testRepeatedClaimsPayOnlyNewIncome() public {
        _income(102_000);
        claimAs(alice, one(1), none());
        assertEq(claimAs(alice, one(1), none()), 0);
        assertEq(pool.claimed(NAND, 1), 8_000);
        _income(51_000); // NAND share +4_000
        assertEq(claimAs(alice, one(1), none()), 4_000);
        assertEq(claimAs(alice, one(1), none()), 0);
        assertEq(pool.claimed(NAND, 1), 12_000);
        assertEq(bem.balanceOf(alice), 12_000);
        assertReconciled();
    }

    /// @notice Regression of the baseline's mainnet entitlement-transfer test (receipt #1, NotHolder).
    function testUnclaimedIncomeFollowsTheTransferredReceipt() public {
        _income(102_000);
        claimAs(alice, one(2), none()); // alice keeps claiming another ID; #1 stays unclaimed
        uint256 claimedBefore = pool.claimed(NAND, 1);
        vm.prank(alice);
        nand.safeTransferFrom(alice, bob, 1, 1, "");
        assertEq(pool.claimed(NAND, 1), claimedBefore); // a transfer does not touch the ledger
        assertEq(pool.claimable(NAND, 1), 8_000);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, NAND, 1));
        pool.claim(NAND, 1);
        vm.prank(bob);
        assertEq(pool.claim(NAND, 1), 8_000);
        assertEq(bem.balanceOf(bob), 8_000);
        assertEq(bem.balanceOf(alice), 8_000); // only #2
        // All other IDs keep their entitlements.
        assertEq(pool.claimable(NAND, 3), 8_000);
        assertEq(pool.claimable(NAND, 9), 8_000);
        assertEq(pool.claimable(LATCH, 1), 4_000);
        assertReconciled();
    }

    function testClaimedHistoryStaysWithTheIdAcrossTransfers() public {
        _income(102_000);
        claimAs(alice, one(1), none());
        _income(102_000);
        vm.prank(alice);
        nand.safeTransferFrom(alice, bob, 1, 1, "");
        // Bob receives only what #1 has not been paid yet: the second batch.
        assertEq(claimAs(bob, one(1), none()), 8_000);
        assertEq(pool.claimed(NAND, 1), 16_000);
        vm.prank(bob);
        nand.safeTransferFrom(bob, alice, 1, 1, "");
        assertEq(claimAs(alice, one(1), none()), 0); // no double claim after the round trip
        assertReconciled();
    }

    function testSameNumberedIdsInBothCollectionsAreIndependent() public {
        vm.prank(alice);
        latch.safeTransferFrom(alice, carol, 1, 1, ""); // carol: LATCH #1, alice: NAND #1
        _income(102_000);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, NAND, 1));
        pool.claim(NAND, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, LATCH, 1));
        pool.claim(LATCH, 1);
        vm.prank(alice);
        assertEq(pool.claim(NAND, 1), 8_000);
        assertEq(pool.claimed(NAND, 1), 8_000);
        assertEq(pool.claimed(LATCH, 1), 0);
        assertEq(pool.claimable(LATCH, 1), 4_000);
        vm.prank(carol);
        assertEq(pool.claim(LATCH, 1), 4_000);
        _income(102_000);
        // Moving NAND #1 does not move LATCH #1's entitlement.
        vm.prank(alice);
        nand.safeTransferFrom(alice, carol, 1, 1, "");
        assertEq(claimAs(carol, one(1), one(1)), 8_000 + 4_000);
        assertEq(pool.claimed(NAND, 1), 16_000);
        assertEq(pool.claimed(LATCH, 1), 8_000);
        assertReconciled();
    }

    function testApprovedOperatorCannotClaimUntilItHoldsTheId() public {
        _income(102_000);
        vm.prank(alice);
        nand.setApprovalForAll(bob, true);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, NAND, 1));
        pool.claim(NAND, 1);
        vm.prank(bob);
        nand.safeTransferFrom(alice, bob, 1, 1, "");
        vm.prank(bob);
        assertEq(pool.claim(NAND, 1), 8_000);
    }

    function testUnauthorizedInvalidAndEmptyClaimsRevert() public {
        _income(102_000);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, NAND, 6));
        pool.claim(NAND, 6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.ReceiptIdOutOfRange.selector, NAND, 0));
        pool.claim(NAND, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.ReceiptIdOutOfRange.selector, LATCH, 5));
        pool.claimBatch(none(), one(5));
        vm.prank(alice);
        vm.expectRevert(TapeoutMinerPool.InvalidBatch.selector);
        pool.claimBatch(none(), none());
        // A batch containing one foreign ID reverts as a whole; nothing is paid.
        uint256[] memory mixed = new uint256[](2);
        mixed[0] = 1;
        mixed[1] = 6;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, NAND, 6));
        pool.claimBatch(mixed, none());
        assertEq(pool.claimed(NAND, 1), 0);
        assertEq(bem.balanceOf(alice), 0);
    }

    function testDuplicateIdsInOneBatchPayOnce() public {
        _income(102_000);
        uint256[] memory dup = new uint256[](3);
        dup[0] = 1;
        dup[1] = 1;
        dup[2] = 1;
        assertEq(claimAs(alice, dup, dup), 8_000 + 4_000);
        assertEq(bem.balanceOf(alice), 12_000);
        assertReconciled();
    }

    function testClaimsRecognizeNewBalanceAndDoNotNeedMining() public {
        uint256[] memory miners = newMinersDeposited(1, 2);
        mining.accrue(address(nft), 1, 50_000);
        mining.accrue(address(nft), 2, 1_000);
        pool.harvest(miners);
        mining.accrue(address(nft), 1, 999_999); // still inside Mining: not pool income yet
        mining.setBroken(true);
        _income(51_000); // direct transfer is recognized by the claim's sync
        assertEq(pool.claimable(NAND, 1), 8_000);
        assertEq(claimAs(alice, one(1), none()), 8_000);
        assertEq(pool.totalAccounted(), 102_000);
        assertReconciled();
    }

    function testClaimableViewsPredictPayouts() public {
        _income(102_000);
        pool.sync();
        _income(10_200); // unrecognized until the next sync
        (uint256[] memory amounts, uint256 total) = pool.claimableBatch(NAND, range(1, 5));
        assertEq(amounts.length, 5);
        assertEq(amounts[0], 8_800);
        assertEq(total, 5 * 8_800);
        assertEq(pool.unrecognizedBalance(), 10_200);
        assertEq(pool.previewAccrual().total, 112_200);
        assertEq(pool.accrual().total, 102_000);
        assertEq(pool.feeClaimable(), 2_200);
        assertEq(pool.historicalClaimable(LATCH), 4_400);
        vm.prank(alice);
        assertEq(pool.claimBatch(range(1, 5), none()), total);
    }

    function testFeeAndHistoricalReleasesArePermissionlessPushesToFixedRecipients() public {
        _income(102_000);
        vm.prank(carol);
        assertEq(pool.releaseFee(), 2_000);
        vm.prank(bob);
        assertEq(pool.releaseHistorical(NAND), 8_000);
        vm.prank(bob);
        assertEq(pool.releaseHistorical(LATCH), 4_000);
        assertEq(bem.balanceOf(feeTo), 2_000);
        assertEq(bem.balanceOf(histNandTo), 8_000);
        assertEq(bem.balanceOf(histLatchTo), 4_000);
        assertEq(bem.balanceOf(carol) + bem.balanceOf(bob), 0);
        assertEq(pool.releaseFee(), 0);
        assertEq(pool.feePaid(), 2_000);
        assertReconciled();
    }

    function testRecipientRolesMoveOnlyByTheirHolderAndKeepUnreleasedIncome() public {
        _income(102_000);
        vm.prank(operator);
        vm.expectRevert(TapeoutMinerPool.Unauthorized.selector);
        pool.setRecipient(TapeoutMinerPool.Recipient.FEE, operator);
        vm.prank(feeTo);
        vm.expectRevert(TapeoutMinerPool.InvalidAddress.selector);
        pool.setRecipient(TapeoutMinerPool.Recipient.FEE, address(0));
        address newFeeTo = makeAddr("newFeeRecipient");
        vm.prank(feeTo);
        pool.setRecipient(TapeoutMinerPool.Recipient.FEE, newFeeTo);
        assertEq(pool.recipientOf(TapeoutMinerPool.Recipient.FEE), newFeeTo);
        vm.prank(feeTo);
        vm.expectRevert(TapeoutMinerPool.Unauthorized.selector);
        pool.setRecipient(TapeoutMinerPool.Recipient.FEE, feeTo);
        pool.releaseFee();
        assertEq(bem.balanceOf(newFeeTo), 2_000); // unreleased fee followed the role
        assertEq(bem.balanceOf(feeTo), 0);
        // Historical recipient can hand its role to a distribution contract.
        address distributor = makeAddr("historicalDistributor");
        vm.prank(histNandTo);
        pool.setRecipient(TapeoutMinerPool.Recipient.HISTORICAL_NAND, distributor);
        pool.releaseHistorical(NAND);
        assertEq(bem.balanceOf(distributor), 8_000);
        assertReconciled();
    }

    /// @notice A contract receiving a receipt may claim from its ERC-1155 hook; it is already the
    ///         holder, gets exactly the ID's unclaimed income once, and the sender cannot claim it.
    function testClaimFromReceiveHookPaysTheNewHolderOnce() public {
        ReceiptHolder vaultLike = new ReceiptHolder();
        _income(102_000);
        vaultLike.setHook(address(pool), abi.encodeCall(TapeoutMinerPool.claim, (NAND, 1)));
        vm.prank(alice);
        nand.safeTransferFrom(alice, address(vaultLike), 1, 1, "");
        assertTrue(vaultLike.hookOk());
        assertEq(bem.balanceOf(address(vaultLike)), 8_000);
        assertEq(pool.claimable(NAND, 1), 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, NAND, 1));
        pool.claim(NAND, 1);
        assertReconciled();
    }
}
