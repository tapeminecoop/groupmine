// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutReceiptDistributor} from "../../src/TapeoutReceiptDistributor.sol";
import {TapeoutEntitlementReceipt} from "../../src/TapeoutEntitlementReceipt.sol";
import {ForeignERC1155} from "../helpers/Mocks.sol";

/// @dev S_N = 30, S_L = 12, all issued to the operator, then moved into the distributor.
contract DistributorTest is SystemTestBase {
    function setUp() public override {
        super.setUp();
        issue(nandReceipt, operator, 30);
        issue(latchReceipt, operator, 12);
        finalizeIssuance();
        activate();
    }

    function _fundAll() internal {
        vm.startPrank(operator);
        nandReceipt.safeTransferFrom(operator, address(distributor), 1, 1, ""); // single transfer
        uint256[] memory ids = range(2, 30);
        nandReceipt.safeBatchTransferFrom(operator, address(distributor), ids, _ones(ids.length), "");
        ids = range(1, 12);
        latchReceipt.safeBatchTransferFrom(operator, address(distributor), ids, _ones(ids.length), "");
        vm.stopPrank();
    }

    function _entry(TapeoutMinerPool.Category c, address wallet, uint64 first, uint64 count)
        internal
        pure
        returns (TapeoutReceiptDistributor.AllocationInput memory)
    {
        return TapeoutReceiptDistributor.AllocationInput({
            category: c, wallet: wallet, firstId: first, count: count
        });
    }

    /// @dev JSON example from the specification, scaled: alice 20 NAND + 5 LATCH, bob 10 NAND, carol 7 LATCH.
    function _allocateExample() internal {
        TapeoutReceiptDistributor.AllocationInput[] memory e =
            new TapeoutReceiptDistributor.AllocationInput[](4);
        e[0] = _entry(NAND, alice, 1, 20);
        e[1] = _entry(LATCH, alice, 1, 5);
        e[2] = _entry(NAND, bob, 21, 10);
        e[3] = _entry(LATCH, carol, 6, 7);
        vm.prank(operator);
        distributor.allocate(e);
    }

    function _ones(uint256 n) internal pure returns (uint256[] memory v) {
        v = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            v[i] = 1;
        }
    }

    function testFundingAcceptsSingleAndBatchTransfersOfTheBoundReceiptsOnly() public {
        _fundAll();
        (uint256[2] memory inventory,,) = distributor.totals();
        assertEq(inventory[0], 30);
        assertEq(inventory[1], 12);
        ForeignERC1155 foreign = new ForeignERC1155(NAND_CATEGORY);
        vm.expectRevert(
            abi.encodeWithSelector(TapeoutReceiptDistributor.UnsupportedToken.selector, address(foreign))
        );
        foreign.mint(address(distributor), 1);
    }

    function testIssuingDirectlyToTheDistributorCountsAsInventory() public {
        // A second, independent system where receipts are minted straight into the distributor.
        nandReceipt = new TapeoutEntitlementReceipt(NAND_CATEGORY, "Second NAND", "S2N", "", operator);
        latchReceipt = new TapeoutEntitlementReceipt(LATCH_CATEGORY, "Second LATCH", "S2L", "", operator);
        pool = deployPool(whitelist());
        distributor = new TapeoutReceiptDistributor(operator, pool);
        vm.prank(operator);
        nandReceipt.issue(address(distributor), 6);
        (uint256[2] memory inventory,,) = distributor.totals();
        assertEq(inventory[0], 6);
        assertEq(nandReceipt.holderOf(6), address(distributor));
    }

    function testImportValidatesInventoryConflictsWalletsAndCaller() public {
        vm.startPrank(operator);
        nandReceipt.safeBatchTransferFrom(operator, address(distributor), range(1, 10), _ones(10), "");
        vm.stopPrank();
        TapeoutReceiptDistributor.AllocationInput[] memory e =
            new TapeoutReceiptDistributor.AllocationInput[](1);
        e[0] = _entry(NAND, alice, 9, 3); // ID 11 is still held by the operator
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TapeoutReceiptDistributor.NotInInventory.selector, NAND, 11));
        distributor.allocate(e);
        e[0] = _entry(NAND, address(0), 1, 1);
        vm.prank(operator);
        vm.expectRevert(TapeoutReceiptDistributor.InvalidAllocation.selector);
        distributor.allocate(e);
        e[0] = _entry(NAND, alice, 1, 0);
        vm.prank(operator);
        vm.expectRevert(TapeoutReceiptDistributor.InvalidAllocation.selector);
        distributor.allocate(e);
        e[0] = _entry(NAND, alice, 1, 5);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        distributor.allocate(e);
        vm.prank(operator);
        distributor.allocate(e);
        e[0] = _entry(NAND, bob, 5, 2); // ID 5 already belongs to alice
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(TapeoutReceiptDistributor.AlreadyAllocated.selector, NAND, 5, alice)
        );
        distributor.allocate(e);
        assertEq(distributor.beneficiaryOf(NAND, 5), alice);
        assertEq(distributor.beneficiaryOf(NAND, 6), address(0));
    }

    function testFinalizationRequiresFullInventoryCoverage() public {
        _fundAll();
        TapeoutReceiptDistributor.AllocationInput[] memory e =
            new TapeoutReceiptDistributor.AllocationInput[](1);
        e[0] = _entry(NAND, alice, 1, 29);
        vm.prank(operator);
        distributor.allocate(e);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(TapeoutReceiptDistributor.InventoryNotCovered.selector, NAND, 29, 30)
        );
        distributor.finalizeAllocation();
        // Corrections before finalization: revoke the wallet and import again.
        vm.prank(operator);
        distributor.revokeWallet(alice);
        assertEq(distributor.beneficiaryOf(NAND, 1), address(0));
        _allocateExample();
        vm.prank(operator);
        distributor.finalizeAllocation(); // NAND 30/30 and LATCH 12/12
        (uint256[2] memory inventory, uint256[2] memory allocated,) = distributor.totals();
        assertEq(allocated[0], inventory[0]);
        assertEq(allocated[1], inventory[1]);
        assertEq(distributor.walletCount(), 3); // alice, bob, carol (alice listed once)
    }

    function testAfterFinalizationAllocationsAndInventoryAreFrozen() public {
        _fundAll();
        _allocateExample();
        vm.prank(operator);
        distributor.finalizeAllocation();
        assertTrue(distributor.allocationFinalized());
        TapeoutReceiptDistributor.AllocationInput[] memory e =
            new TapeoutReceiptDistributor.AllocationInput[](1);
        e[0] = _entry(NAND, dave, 1, 1);
        vm.startPrank(operator);
        vm.expectRevert(TapeoutReceiptDistributor.AllocationClosed.selector);
        distributor.allocate(e);
        vm.expectRevert(TapeoutReceiptDistributor.AllocationClosed.selector);
        distributor.revokeWallet(alice);
        vm.expectRevert(TapeoutReceiptDistributor.AllocationClosed.selector);
        distributor.finalizeAllocation();
        distributor.renounceOwnership();
        vm.stopPrank();
        // Claims do not depend on the owner.
        vm.prank(alice);
        assertEq(distributor.claim(100), 25);
    }

    function testUsersClaimOnlyTheirOwnReceiptsAndOnlyOnce() public {
        _fundAll();
        _allocateExample();
        vm.prank(alice);
        vm.expectRevert(TapeoutReceiptDistributor.AllocationOpen.selector);
        distributor.claim(100);
        vm.prank(operator);
        distributor.finalizeAllocation();
        vm.prank(alice);
        assertEq(distributor.claim(12), 12); // partial: NAND 1..12
        (uint256 n, uint256 l) = distributor.pendingOf(alice);
        assertEq(n, 8);
        assertEq(l, 5);
        vm.prank(alice);
        assertEq(distributor.claim(100), 13);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TapeoutReceiptDistributor.NothingToDeliver.selector, alice));
        distributor.claim(100);
        vm.prank(dave);
        vm.expectRevert(abi.encodeWithSelector(TapeoutReceiptDistributor.NothingToDeliver.selector, dave));
        distributor.claim(100);
        for (uint256 id = 1; id <= 20; ++id) {
            assertEq(nandReceipt.holderOf(id), alice);
        }
        assertEq(latchReceipt.holderOf(5), alice);
        assertEq(nandReceipt.holderOf(21), address(distributor)); // bob's are untouched
    }

    function testDeliverAlwaysGoesToTheRecordedBeneficiary() public {
        _fundAll();
        _allocateExample();
        vm.prank(operator);
        distributor.finalizeAllocation();
        vm.prank(carol);
        assertEq(distributor.deliver(bob, 100), 10);
        assertEq(nandReceipt.holderOf(21), bob);
        assertEq(nandReceipt.balanceOf(carol, 21), 0);
    }

    function testLateClaimsKeepTheBemAccumulatedWhileHeldByTheDistributor() public {
        _fundAll();
        _allocateExample();
        vm.prank(operator);
        distributor.finalizeAllocation();
        admitNew(1, 3, 1);
        accrue(1, 1_020_000);
        pool.harvestRange(0, 1);
        // 1_000_000 for participants: NAND 750_000 / 30 = 25_000 per ID, LATCH 250_000 / 12 = 20_833 per ID.
        assertEq(pool.claimable(NAND, 21), 25_000);
        vm.warp(block.timestamp + 365 days); // no claim deadline
        vm.prank(bob);
        distributor.claim(100);
        assertEq(pool.claimable(NAND, 21), 25_000);
        assertEq(claimAs(bob, range(21, 30), none()), 250_000);
        assertEq(pool.nandShares(), 30); // denominators never moved
        assertEq(pool.latchShares(), 12);
        assertReconciled();
    }

    function testNoAdministrativeRouteToHeldReceiptsOrTheirBem() public {
        _fundAll();
        _allocateExample();
        admitNew(1, 1, 1);
        accrue(1, 1_020_000);
        pool.harvestRange(0, 1);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, NAND, 1));
        pool.claim(NAND, 1);
        assertFalse(nandReceipt.isApprovedForAll(address(distributor), operator));
        assertEq(pool.claimed(NAND, 1), 0);
    }

    function testReceiptsWithConsumedRewardHistoryAreRefused() public {
        admitNew(1, 1, 1);
        accrue(1, 1_020_000);
        pool.harvestRange(0, 1);
        vm.startPrank(operator);
        pool.claim(NAND, 30);
        vm.expectRevert(
            abi.encodeWithSelector(TapeoutReceiptDistributor.ConsumedRewardHistory.selector, NAND, 30)
        );
        nandReceipt.safeTransferFrom(operator, address(distributor), 30, 1, "");
        nandReceipt.safeTransferFrom(operator, address(distributor), 29, 1, ""); // fresh one is fine
        vm.stopPrank();
    }

    function testDistributedReceiptsCanNeverReturnAsInventory() public {
        _fundAll();
        _allocateExample();
        vm.prank(operator);
        distributor.finalizeAllocation();
        vm.prank(alice);
        distributor.claim(100);
        vm.prank(alice);
        vm.expectRevert(TapeoutReceiptDistributor.AllocationClosed.selector);
        nandReceipt.safeTransferFrom(alice, address(distributor), 1, 1, "");
    }

    function testABeneficiaryThatCannotReceiveIsNeverRedirected() public {
        _fundAll();
        TapeoutReceiptDistributor.AllocationInput[] memory e =
            new TapeoutReceiptDistributor.AllocationInput[](3);
        e[0] = _entry(NAND, address(bem), 1, 30); // a contract without ERC-1155 receiver support
        e[1] = _entry(LATCH, alice, 1, 12);
        e[2] = _entry(NAND, alice, 31, 0);
        vm.prank(operator);
        vm.expectRevert(TapeoutReceiptDistributor.InvalidAllocation.selector);
        distributor.allocate(e);
        TapeoutReceiptDistributor.AllocationInput[] memory ok =
            new TapeoutReceiptDistributor.AllocationInput[](2);
        ok[0] = e[0];
        ok[1] = e[1];
        vm.prank(operator);
        distributor.allocate(ok);
        vm.prank(operator);
        distributor.finalizeAllocation();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InvalidReceiver.selector, address(bem)));
        distributor.deliver(address(bem), 100);
        assertEq(nandReceipt.holderOf(1), address(distributor));
        assertEq(distributor.beneficiaryOf(NAND, 1), address(bem));
    }
}

