// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutReceiptDistributor} from "../../src/TapeoutReceiptDistributor.sol";
import {ReceiptHolder} from "../helpers/Mocks.sol";

/// @notice Internal security review (f2c8e50), workstream B: receipt transfer edge cases that the
///         holder index, the distributor's inventory and the pool's holder-only claims must survive.
contract AuditReceiptEdgesTest is SystemTestBase {
    function setUp() public override {
        super.setUp();
        issue(nandReceipt, alice, 3);
        issue(latchReceipt, alice, 2);
        finalizeIssuance();
        activate();
    }

    function _entry(TapeoutMinerPool.Category c, address wallet, uint64 first, uint64 count)
        internal
        pure
        returns (TapeoutReceiptDistributor.AllocationInput memory)
    {
        return TapeoutReceiptDistributor.AllocationInput({category: c, wallet: wallet, firstId: first, count: count});
    }

    /// @dev OpenZeppelin's ERC-1155 lets anyone move a value of 0 of any ID they do not hold. Such a
    ///      transfer runs the receiver hook but must not count as inventory, move the holder index, or
    ///      give the sender a claim.
    function testZeroValueTransfersCannotForgeInventoryOrMoveTheHolderIndex() public {
        vm.prank(bob);
        nandReceipt.safeTransferFrom(bob, address(distributor), 1, 0, "");
        (uint256[2] memory inventory,,) = distributor.totals();
        assertEq(inventory[0], 0, "zero-value transfer counted as inventory");
        assertEq(nandReceipt.holderOf(1), alice);
        uint256[] memory ids = two(1, 2);
        uint256[] memory zeros = new uint256[](2);
        vm.prank(bob);
        nandReceipt.safeBatchTransferFrom(bob, carol, ids, zeros, "");
        assertEq(nandReceipt.holderOf(1), alice);
        assertEq(nandReceipt.holderOf(2), alice);
        assertEq(nandReceipt.balanceOf(carol, 1), 0);
        // The pool has no receiver hook: even a zero-value transfer into it reverts.
        vm.prank(bob);
        vm.expectRevert();
        nandReceipt.safeTransferFrom(bob, address(pool), 1, 0, "");
        // Only the real holder claims.
        admitNew(1, 1, 1);
        accrue(1, 1_020_000);
        pool.harvestRange(0, 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, NAND, 1));
        pool.claim(NAND, 1);
        vm.prank(alice);
        assertGt(pool.claim(NAND, 1), 0);
        // After finalization the distributor refuses even zero-value transfers.
        vm.startPrank(alice);
        nandReceipt.safeBatchTransferFrom(alice, address(distributor), two(2, 3), two(1, 1), "");
        latchReceipt.safeBatchTransferFrom(alice, address(distributor), two(1, 2), two(1, 1), "");
        vm.stopPrank();
        TapeoutReceiptDistributor.AllocationInput[] memory e = new TapeoutReceiptDistributor.AllocationInput[](2);
        e[0] = _entry(NAND, bob, 2, 2);
        e[1] = _entry(LATCH, carol, 1, 2);
        vm.startPrank(operator);
        distributor.allocate(e);
        distributor.finalizeAllocation();
        vm.stopPrank();
        vm.prank(dave);
        vm.expectRevert(TapeoutReceiptDistributor.AllocationClosed.selector);
        nandReceipt.safeTransferFrom(dave, address(distributor), 1, 0, "");
        assertReconciled();
    }

    function testDuplicateIdRowsWithAZeroValueKeepTheIndexConsistent() public {
        vm.startPrank(alice);
        nandReceipt.safeBatchTransferFrom(alice, bob, two(1, 1), two(1, 0), "");
        assertEq(nandReceipt.holderOf(1), bob);
        assertEq(nandReceipt.balanceOf(bob, 1), 1);
        assertEq(nandReceipt.balanceOf(alice, 1), 0);
        nandReceipt.safeBatchTransferFrom(alice, bob, two(2, 2), two(0, 1), "");
        assertEq(nandReceipt.holderOf(2), bob);
        assertEq(nandReceipt.balanceOf(bob, 2), 1);
        vm.expectRevert(
            abi.encodeWithSelector(IERC1155Errors.ERC1155InsufficientBalance.selector, alice, 0, 1, 3)
        );
        nandReceipt.safeBatchTransferFrom(alice, bob, two(3, 3), two(1, 1), "");
        vm.stopPrank();
        assertEq(nandReceipt.holderOf(3), alice);
        // Self-transfer keeps the index; an operator cannot claim, the holder can.
        vm.prank(alice);
        nandReceipt.setApprovalForAll(carol, true);
        vm.prank(carol);
        nandReceipt.safeTransferFrom(alice, alice, 3, 1, "");
        assertEq(nandReceipt.holderOf(3), alice);
        admitNew(1, 2, 1);
        accrue(1, 3_060_000);
        pool.harvestRange(0, 1);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, NAND, 3));
        pool.claim(NAND, 3);
        vm.prank(alice);
        assertGt(pool.claim(NAND, 3), 0);
    }

    /// @dev A beneficiary contract that claims BEM from inside the delivery hook is paid once; a hook
    ///      that re-enters the distributor is refused by the reentrancy guard while the outer delivery
    ///      completes exactly once.
    function testHookClaimDuringDeliveryPaysOnceAndReentrantDeliveryIsRefused() public {
        ReceiptHolder wallet = new ReceiptHolder();
        vm.prank(alice);
        nandReceipt.safeBatchTransferFrom(alice, address(distributor), range(1, 3), _ones(3), "");
        TapeoutReceiptDistributor.AllocationInput[] memory e = new TapeoutReceiptDistributor.AllocationInput[](1);
        e[0] = _entry(NAND, address(wallet), 1, 3);
        vm.startPrank(operator);
        distributor.allocate(e);
        distributor.finalizeAllocation();
        vm.stopPrank();
        admitNew(1, 4, 0);
        accrue(1, 3_060_000);
        pool.harvestRange(0, 1);
        uint256 perShare = pool.claimable(NAND, 1);
        assertGt(perShare, 0);

        wallet.setHook(address(pool), abi.encodeCall(pool.claim, (NAND, 1)));
        vm.prank(carol);
        assertEq(distributor.deliver(address(wallet), 1), 1);
        assertTrue(wallet.hookOk(), "hook claim failed");
        assertEq(bem.balanceOf(address(wallet)), perShare);
        assertEq(pool.claimed(NAND, 1), perShare);
        assertEq(pool.claimable(NAND, 1), 0);

        wallet.setHook(address(distributor), abi.encodeCall(distributor.deliver, (address(wallet), 1)));
        vm.prank(carol);
        assertEq(distributor.deliver(address(wallet), 1), 1); // ID 2
        assertFalse(wallet.hookOk(), "reentrant delivery was accepted");
        assertEq(bytes4(wallet.hookResult()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(nandReceipt.holderOf(2), address(wallet));
        assertEq(nandReceipt.holderOf(3), address(distributor));
        (uint256 pendingNand,) = distributor.pendingOf(address(wallet));
        assertEq(pendingNand, 1);
        // ID 2 still carries its full income for the new holder.
        assertEq(pool.claimable(NAND, 2), perShare);
        assertReconciled();
    }

    function _ones(uint256 n) internal pure returns (uint256[] memory v) {
        v = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            v[i] = 1;
        }
    }
}
