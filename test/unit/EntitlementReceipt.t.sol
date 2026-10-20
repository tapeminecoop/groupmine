// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutEntitlementReceipt} from "../../src/TapeoutEntitlementReceipt.sol";

contract EntitlementReceiptTest is SystemTestBase {
    function testIndependentDeploymentsShareOneVerifiableRuntime() public {
        TapeoutEntitlementReceipt other =
            new TapeoutEntitlementReceipt(LATCH_CATEGORY, "Other name", "OTHER", "ipfs://x/{id}", alice);
        assertEq(address(nandReceipt).codehash, address(latchReceipt).codehash);
        assertEq(address(other).codehash, address(nandReceipt).codehash);
        assertEq(address(nandReceipt).codehash, keccak256(type(TapeoutEntitlementReceipt).runtimeCode));
        assertEq(nandReceipt.category(), NAND_CATEGORY);
        assertEq(latchReceipt.category(), LATCH_CATEGORY);
        assertEq(nandReceipt.owner(), operator);
        assertEq(other.owner(), alice);
        assertEq(other.uri(3), "ipfs://x/{id}");
        assertTrue(nandReceipt.supportsInterface(0xd9b67a26)); // ERC-1155
        vm.expectRevert(TapeoutEntitlementReceipt.InvalidCategory.selector);
        new TapeoutEntitlementReceipt(bytes32("OTHER"), "x", "x", "", operator);
    }

    function testIssuanceIsSequentialBatchedAndIssuerOnly() public {
        vm.startPrank(operator);
        assertEq(nandReceipt.issue(operator, 3), 1);
        assertEq(nandReceipt.issue(alice, 2), 4);
        vm.expectRevert(TapeoutEntitlementReceipt.InvalidCount.selector);
        nandReceipt.issue(alice, 0);
        vm.expectRevert(TapeoutEntitlementReceipt.InvalidCount.selector);
        nandReceipt.issue(alice, 501);
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InvalidReceiver.selector, address(bem)));
        nandReceipt.issue(address(bem), 1);
        vm.stopPrank();
        assertEq(nandReceipt.totalSupply(), 5);
        assertEq(nandReceipt.holderOf(3), operator);
        assertEq(nandReceipt.holderOf(5), alice);
        assertEq(nandReceipt.totalSupply(5), 1);
        assertEq(nandReceipt.totalSupply(6), 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        nandReceipt.issue(alice, 1);
    }

    function testRetractOnlyUndoesTheIssuersOwnTopIdsBeforeFinalization() public {
        issue(nandReceipt, operator, 4);
        issue(nandReceipt, alice, 1); // ID 5 belongs to alice
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(TapeoutEntitlementReceipt.NotIssuerHeld.selector, 5));
        nandReceipt.retract(1);
        vm.stopPrank();
        vm.prank(alice);
        nandReceipt.safeTransferFrom(alice, operator, 5, 1, "");
        vm.prank(operator);
        nandReceipt.retract(2);
        assertEq(nandReceipt.totalSupply(), 3);
        assertEq(nandReceipt.holderOf(4), address(0));
        vm.prank(operator);
        assertEq(nandReceipt.issue(bob, 1), 4); // IDs stay contiguous
        assertEq(nandReceipt.holderOf(4), bob);
    }

    function testFinalizationFixesSupplyForever() public {
        issue(nandReceipt, alice, 10);
        vm.startPrank(operator);
        nandReceipt.finalizeIssuance();
        vm.expectRevert(TapeoutEntitlementReceipt.IssuanceClosed.selector);
        nandReceipt.issue(operator, 1);
        vm.expectRevert(TapeoutEntitlementReceipt.IssuanceClosed.selector);
        nandReceipt.retract(1);
        vm.expectRevert(TapeoutEntitlementReceipt.IssuanceClosed.selector);
        nandReceipt.finalizeIssuance();
        nandReceipt.renounceOwnership();
        vm.stopPrank();
        assertTrue(nandReceipt.issuanceFinalized());
        assertEq(nandReceipt.totalSupply(), 10);
        // Ordinary transfers keep working after finalization and without an owner.
        vm.prank(alice);
        nandReceipt.safeTransferFrom(alice, bob, 7, 1, "");
        assertEq(nandReceipt.holderOf(7), bob);
        assertEq(nandReceipt.totalSupply(), 10);
    }

    function testTransfersKeepUnitSupplyAndTheHolderIndex() public {
        issue(nandReceipt, alice, 3);
        vm.startPrank(alice);
        nandReceipt.safeTransferFrom(alice, bob, 1, 0, "");
        assertEq(nandReceipt.holderOf(1), alice);
        nandReceipt.safeTransferFrom(alice, alice, 1, 1, "");
        assertEq(nandReceipt.holderOf(1), alice);
        vm.expectRevert(abi.encodeWithSelector(TapeoutEntitlementReceipt.InvalidAmount.selector, 1, 2));
        nandReceipt.safeTransferFrom(alice, bob, 1, 2, "");
        uint256[] memory dup = two(2, 2);
        uint256[] memory ones = two(1, 1);
        vm.expectRevert(
            abi.encodeWithSelector(IERC1155Errors.ERC1155InsufficientBalance.selector, alice, 0, 1, 2)
        );
        nandReceipt.safeBatchTransferFrom(alice, bob, dup, ones, "");
        vm.stopPrank();
        address[] memory page = nandReceipt.holdersPage(1, 4);
        assertEq(page[0], alice);
        assertEq(page[3], address(0));
        vm.expectRevert(TapeoutEntitlementReceipt.InvalidPage.selector);
        nandReceipt.holdersPage(0, 1);
    }
}
