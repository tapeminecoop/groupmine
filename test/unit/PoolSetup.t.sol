// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutEntitlementReceipt} from "../../src/TapeoutEntitlementReceipt.sol";
import {ForeignERC1155} from "../helpers/Mocks.sol";

contract PoolSetupTest is SystemTestBase {
    function testDeploymentBindsProtocolReceiptsRecipientsAndWhitelist() public view {
        assertEq(address(pool.bem()), address(bem));
        assertEq(address(pool.mining()), address(mining));
        assertEq(address(pool.minerCollection()), address(nft));
        assertEq(address(pool.nandReceipt()), address(nandReceipt));
        assertEq(address(pool.latchReceipt()), address(latchReceipt));
        assertEq(pool.recipientA(), recipientA);
        assertEq(pool.recipientB(), recipientB);
        assertTrue(pool.isDepositor(depositor));
        assertTrue(pool.isDepositor(depositor2));
        assertFalse(pool.isDepositor(operator));
        assertEq(pool.depositors().length, 2);
        assertEq(pool.owner(), operator);
        assertFalse(pool.active());
        assertEq(pool.TOTAL_PARTS(), 84);
        assertEq(pool.PARTICIPANT_PARTS(), 80);
        assertEq(pool.RECIPIENT_PARTS(), 1);
        assertEq(pool.SINK_PARTS(), 2);
        assertEq(pool.SINK(), 0x000000000000000000000000000000000000dEaD);
        assertEq(pool.VERSION(), "TapeoutMinerPool/2.3.0");
    }

    function testReceiptsMustBeThisExactImplementationWithTheRightCategories() public {
        TapeoutMinerPool.Deployment memory d = deployment(whitelist());
        ForeignERC1155 foreign = new ForeignERC1155(NAND_CATEGORY);
        d.nandReceipt = address(foreign); // claims the same category and a finalized supply, but is not ours
        vm.expectRevert(TapeoutMinerPool.IncompatibleReceipt.selector);
        new TapeoutMinerPool(d);
        d = deployment(whitelist());
        (d.nandReceipt, d.latchReceipt) = (address(latchReceipt), address(nandReceipt)); // swapped
        vm.expectRevert(TapeoutMinerPool.IncompatibleReceipt.selector);
        new TapeoutMinerPool(d);
        d = deployment(whitelist());
        d.latchReceipt = address(nandReceipt);
        vm.expectRevert(TapeoutMinerPool.IncompatibleReceipt.selector);
        new TapeoutMinerPool(d);
        d = deployment(whitelist());
        d.latchReceipt = makeAddr("noCode");
        vm.expectRevert(TapeoutMinerPool.IncompatibleReceipt.selector);
        new TapeoutMinerPool(d);
        // Two NAND-category deployments of the right code are still rejected for LATCH.
        d = deployment(whitelist());
        d.latchReceipt = address(new TapeoutEntitlementReceipt(NAND_CATEGORY, "x", "x", "", operator));
        vm.expectRevert(TapeoutMinerPool.IncompatibleReceipt.selector);
        new TapeoutMinerPool(d);
    }

    function testDepositorWhitelistIsValidatedAndRequired() public {
        address[] memory list = new address[](0);
        vm.expectRevert(TapeoutMinerPool.InvalidDepositors.selector);
        deployPool(list);
        list = new address[](17);
        for (uint256 i; i < 17; ++i) {
            list[i] = address(uint160(0x1000 + i));
        }
        vm.expectRevert(TapeoutMinerPool.InvalidDepositors.selector);
        deployPool(list);
        list = new address[](2);
        list[0] = depositor;
        list[1] = depositor;
        vm.expectRevert(TapeoutMinerPool.InvalidDepositors.selector);
        deployPool(list);
        list[1] = address(0);
        vm.expectRevert(TapeoutMinerPool.InvalidDepositors.selector);
        deployPool(list);
        list[1] = address(mining);
        vm.expectRevert(TapeoutMinerPool.InvalidDepositors.selector);
        deployPool(list);
        list[1] = address(nandReceipt);
        vm.expectRevert(TapeoutMinerPool.InvalidDepositors.selector);
        deployPool(list);
    }

    function testRecipientsProtocolAndNameAreValidated() public {
        TapeoutMinerPool.Deployment memory d = deployment(whitelist());
        d.recipientA = address(0);
        vm.expectRevert(TapeoutMinerPool.InvalidAddress.selector);
        new TapeoutMinerPool(d);
        d = deployment(whitelist());
        d.mining = makeAddr("noMiningCode");
        vm.expectRevert(TapeoutMinerPool.InvalidAddress.selector);
        new TapeoutMinerPool(d);
        d = deployment(whitelist());
        d.poolName = "";
        vm.expectRevert(TapeoutMinerPool.InvalidName.selector);
        new TapeoutMinerPool(d);
        d = deployment(whitelist());
        d.owner = address(0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new TapeoutMinerPool(d);
        // A and B may be the same multisig; their accounts stay separate.
        d = deployment(whitelist());
        d.recipientB = recipientA;
        TapeoutMinerPool shared = new TapeoutMinerPool(d);
        assertEq(shared.recipientB(), recipientA);
    }

    function testActivationRequiresFinalizedSuppliesTheReviewedCountsAndOwner() public {
        issue(nandReceipt, alice, 10);
        issue(latchReceipt, alice, 3);
        vm.prank(operator);
        vm.expectRevert(TapeoutMinerPool.IssuanceNotFinalized.selector);
        pool.activate(10, 3);
        vm.prank(operator);
        nandReceipt.finalizeIssuance();
        vm.prank(operator);
        vm.expectRevert(TapeoutMinerPool.IssuanceNotFinalized.selector);
        pool.activate(10, 3);
        vm.prank(operator);
        latchReceipt.finalizeIssuance();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.UnexpectedShareCounts.selector, 10, 3));
        pool.activate(10, 4);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pool.activate(10, 3);
        // 2.2.0: the round's distributor must be bound and its allocation finalized first.
        vm.prank(operator);
        vm.expectRevert(TapeoutMinerPool.DistributorNotBound.selector);
        pool.activate(10, 3);
        vm.prank(operator);
        pool.bindDistributor(address(distributor));
        vm.prank(operator);
        vm.expectRevert(TapeoutMinerPool.AllocationNotFinalized.selector);
        pool.activate(10, 3);
        vm.prank(operator);
        distributor.finalizeAllocation();
        vm.prank(operator);
        pool.activate(10, 3);
        assertTrue(pool.active());
        assertEq(pool.nandShares(), 10);
        assertEq(pool.latchShares(), 3);
        vm.prank(operator);
        vm.expectRevert(TapeoutMinerPool.AlreadyActive.selector);
        pool.activate(10, 3);
    }

    function testActivationRejectsTwoEmptyCollections() public {
        finalizeIssuance();
        vm.prank(operator);
        vm.expectRevert(TapeoutMinerPool.NoShares.selector);
        pool.activate(0, 0);
    }

    function testPoolKeepsWorkingAfterOwnershipIsRenounced() public {
        setupStandard(); // 2.2.0: custody needs every owner renounced, and setupStandard renounces them
        assertEq(pool.owner(), address(0));
        assertEq(nandReceipt.owner(), address(0));
        assertEq(latchReceipt.owner(), address(0));
        assertEq(distributor.owner(), address(0));
        admitNew(1, 5, 5);
        accrue(1, 105_000);
        (uint256 received,) = pool.harvestRange(0, 1);
        assertEq(received, 105_000);
        newMinerFor(depositor2, 2, 1, 3);
        accrue(2, 10_500);
        admitAs(depositor2, one(2));
        assertEq(pool.minerCount(), 2);
        assertGt(claimAs(alice, one(1), one(1)), 0);
        assertEq(pool.releaseA(), pool.releaseB());
        assertGt(bem.balanceOf(recipientA), 0);
        assertReconciled();
    }

    function testRecipientsMoveOnlyThemselves() public {
        setupStandard();
        admitNew(1, 1, 1);
        accrue(1, 105_000);
        pool.harvestRange(0, 1);
        vm.prank(operator);
        vm.expectRevert(TapeoutMinerPool.Unauthorized.selector);
        pool.setRecipient(TapeoutMinerPool.Recipient.A, operator);
        address newA = makeAddr("newA");
        vm.prank(recipientA);
        pool.setRecipient(TapeoutMinerPool.Recipient.A, newA);
        pool.releaseA();
        assertEq(bem.balanceOf(newA), 1_250); // unpaid income followed the role
        assertEq(bem.balanceOf(recipientA), 0);
        assertEq(pool.recipientClaimable(TapeoutMinerPool.Recipient.B), 1_250);
        assertEq(bem.balanceOf(pool.SINK()), 2_500); // C is paid with A's release, not moved with the role
    }

    function testPreActivationEntryPointsAreClosed() public {
        vm.expectRevert(TapeoutMinerPool.NotActive.selector);
        pool.sync();
        vm.expectRevert(TapeoutMinerPool.NotActive.selector);
        pool.releaseA();
        vm.expectRevert(TapeoutMinerPool.NotActive.selector);
        pool.harvestRange(0, 1);
        vm.prank(alice);
        vm.expectRevert(TapeoutMinerPool.NotActive.selector);
        pool.claim(NAND, 1);
    }
}
