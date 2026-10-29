// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutReceiptDistributor} from "../../src/TapeoutReceiptDistributor.sol";
import {TapeoutEntitlementReceipt} from "../../src/TapeoutEntitlementReceipt.sol";
import {ForeignERC1155} from "../helpers/Mocks.sol";

/// @dev Answers the distributor views the pool reads, with configurable values. Stands in for a wrong
///      or non-genuine distributor; the pool can check its answers but not its code. 2.3.0: membership
///      is `isPool`, here true for one configured pool.
contract FakeDistributor {
    address public member;
    address public nandReceipt;
    address public latchReceipt;
    bool public allocationFinalized;
    address public owner;

    constructor(address member_, address nand_, address latch_, bool finalized_, address owner_) {
        (member, nandReceipt, latchReceipt, allocationFinalized, owner) =
            (member_, nand_, latch_, finalized_, owner_);
    }

    function isPool(address candidate) external view returns (bool) {
        return candidate == member;
    }
}

/// @notice SALUS finding #3 ("Centralization risk"), 2.2.0: custody begins only after the one-time
///         issuance and allocation are final and every privileged owner is gone. The first admission
///         requires both receipt collections finalized with owner zero and supplies equal to the pool's
///         denominators, the bound distributor finalized with owner zero, and the pool active with owner
///         zero. Nothing in the pool renounces anything; afterwards everything runs without an owner.
///         Receipts: NAND 1-6 and LATCH 1-4 issued into the distributor, allocated to alice (NAND 1-4,
///         LATCH 1-2), bob (NAND 5-6) and carol (LATCH 3-4).
contract SalusFinalityTest is SystemTestBase {
    address internal constant SINK = 0x000000000000000000000000000000000000dEaD;

    function setUp() public override {
        super.setUp();
        issue(nandReceipt, address(distributor), 6);
        issue(latchReceipt, address(distributor), 4);
        TapeoutReceiptDistributor.AllocationInput[] memory e =
            new TapeoutReceiptDistributor.AllocationInput[](4);
        e[0] =
            TapeoutReceiptDistributor.AllocationInput({category: NAND, wallet: alice, firstId: 1, count: 4});
        e[1] =
            TapeoutReceiptDistributor.AllocationInput({category: LATCH, wallet: alice, firstId: 1, count: 2});
        e[2] = TapeoutReceiptDistributor.AllocationInput({category: NAND, wallet: bob, firstId: 5, count: 2});
        e[3] =
            TapeoutReceiptDistributor.AllocationInput({category: LATCH, wallet: carol, firstId: 3, count: 2});
        vm.prank(operator);
        distributor.allocate(e);
        newMiner(1, 3, 1);
        accrue(1, 105 * BEM_UNIT);
        newMiner(2, 1, 1);
        accrue(2, 21 * BEM_UNIT);
        vm.prank(depositor);
        nft.setApprovalForAll(address(pool), true);
    }

    // ---------------------------------------------------------------------- steps

    function _finalizeIssuance(bool nand, bool latch) internal {
        vm.startPrank(operator);
        if (nand) nandReceipt.finalizeIssuance();
        if (latch) latchReceipt.finalizeIssuance();
        vm.stopPrank();
    }

    function _bindFinalizeActivate() internal {
        vm.startPrank(operator);
        pool.bindDistributor(address(distributor));
        distributor.finalizeAllocation();
        pool.activate(6, 4);
        vm.stopPrank();
    }

    function _renounce(Ownable target) internal {
        vm.prank(operator);
        target.renounceOwnership();
    }

    function _renounceAllBut(address keep) internal {
        if (keep != address(nandReceipt)) _renounce(nandReceipt);
        if (keep != address(latchReceipt)) _renounce(latchReceipt);
        if (keep != address(distributor)) _renounce(distributor);
        if (keep != address(pool)) _renounce(pool);
    }

    function _admitExpecting(uint256 id, bytes memory reason) internal {
        vm.prank(depositor);
        vm.expectRevert(reason);
        pool.depositMiners(one(id));
        assertEq(nft.ownerOf(id), depositor);
        assertFalse(pool.custodyOpen());
        assertEq(pool.minerCount(), 0);
    }

    function _admitOk(uint256 id) internal {
        vm.prank(depositor);
        pool.depositMiners(one(id));
        assertEq(nft.ownerOf(id), address(pool));
    }

    function _notRenounced(address target) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(TapeoutMinerPool.OwnershipNotRenounced.selector, target);
    }

    // ---------------------------------------------------------------------- each condition

    function testNandIssuanceNotFinalizedBlocksCustody() public {
        _finalizeIssuance(false, true);
        vm.startPrank(operator);
        pool.bindDistributor(address(distributor));
        vm.expectRevert(TapeoutReceiptDistributor.IssuanceNotFinalized.selector);
        distributor.finalizeAllocation();
        vm.expectRevert(TapeoutMinerPool.IssuanceNotFinalized.selector);
        pool.activate(6, 4);
        vm.stopPrank();
        _renounce(latchReceipt);
        _admitExpecting(1, abi.encodeWithSelector(TapeoutMinerPool.NotActive.selector));
        // NAND can still be issued: its supply is not fixed yet, so custody must not start.
        vm.prank(operator);
        nandReceipt.issue(operator, 1);
        assertEq(nandReceipt.totalSupply(), 7);
    }

    function testLatchIssuanceNotFinalizedBlocksCustody() public {
        _finalizeIssuance(true, false);
        vm.startPrank(operator);
        pool.bindDistributor(address(distributor));
        vm.expectRevert(TapeoutReceiptDistributor.IssuanceNotFinalized.selector);
        distributor.finalizeAllocation();
        vm.expectRevert(TapeoutMinerPool.IssuanceNotFinalized.selector);
        pool.activate(6, 4);
        vm.stopPrank();
        _renounce(nandReceipt);
        _admitExpecting(1, abi.encodeWithSelector(TapeoutMinerPool.NotActive.selector));
    }

    function testNandOwnerNotRenouncedBlocksTheFirstAdmission() public {
        _finalizeIssuance(true, true);
        _bindFinalizeActivate();
        _renounceAllBut(address(nandReceipt));
        _admitExpecting(1, _notRenounced(address(nandReceipt)));
        _renounce(nandReceipt);
        _admitOk(1);
    }

    function testLatchOwnerNotRenouncedBlocksTheFirstAdmission() public {
        _finalizeIssuance(true, true);
        _bindFinalizeActivate();
        _renounceAllBut(address(latchReceipt));
        _admitExpecting(1, _notRenounced(address(latchReceipt)));
        _renounce(latchReceipt);
        _admitOk(1);
    }

    function testDistributorAllocationNotFinalizedBlocksActivationAndCustody() public {
        _finalizeIssuance(true, true);
        vm.startPrank(operator);
        pool.bindDistributor(address(distributor));
        vm.expectRevert(TapeoutMinerPool.AllocationNotFinalized.selector);
        pool.activate(6, 4);
        vm.stopPrank();
        _renounce(nandReceipt);
        _renounce(latchReceipt);
        _renounce(pool); // a pool renounced before activation can never activate
        _admitExpecting(1, abi.encodeWithSelector(TapeoutMinerPool.NotActive.selector));
        // While open, the owner can still change the allocation: exactly what custody must not follow.
        vm.prank(operator);
        distributor.revokeWallet(bob);
    }

    function testDistributorOwnerNotRenouncedBlocksTheFirstAdmission() public {
        _finalizeIssuance(true, true);
        _bindFinalizeActivate();
        _renounceAllBut(address(distributor));
        _admitExpecting(1, _notRenounced(address(distributor)));
        _renounce(distributor);
        _admitOk(1);
    }

    function testPoolNotActivatedBlocksAdmission() public {
        _finalizeIssuance(true, true);
        vm.startPrank(operator);
        pool.bindDistributor(address(distributor));
        distributor.finalizeAllocation();
        vm.stopPrank();
        _renounce(nandReceipt);
        _renounce(latchReceipt);
        _renounce(distributor);
        _admitExpecting(1, abi.encodeWithSelector(TapeoutMinerPool.NotActive.selector));
        vm.prank(operator);
        pool.activate(6, 4);
        _admitExpecting(1, _notRenounced(address(pool)));
    }

    function testPoolOwnerNotRenouncedBlocksTheFirstAdmission() public {
        _finalizeIssuance(true, true);
        _bindFinalizeActivate();
        _renounceAllBut(address(pool));
        _admitExpecting(1, _notRenounced(address(pool)));
        // registerMiners is the same gate.
        vm.prank(depositor);
        nft.transferFrom(depositor, address(pool), 2);
        vm.prank(depositor);
        vm.expectRevert(_notRenounced(address(pool)));
        pool.registerMiners(one(2));
        _renounce(pool);
        _admitOk(1);
    }

    // ---------------------------------------------------------------------- binding, receipts, supplies

    function testIncorrectDistributorBindingIsRefused() public {
        _finalizeIssuance(true, true);
        vm.startPrank(operator);
        vm.expectRevert(TapeoutMinerPool.InvalidDistributor.selector);
        pool.bindDistributor(alice); // not a contract
        TapeoutMinerPool other = deployPool(whitelist());
        TapeoutMinerPool other2 = deployRegularPool(whitelist());
        TapeoutReceiptDistributor foreign = new TapeoutReceiptDistributor(operator, other, other2);
        vm.expectRevert(TapeoutMinerPool.InvalidDistributor.selector);
        pool.bindDistributor(address(foreign)); // serves two other pools on the same receipts
        FakeDistributor wrongReceipts =
            new FakeDistributor(address(pool), address(latchReceipt), address(nandReceipt), true, address(0));
        vm.expectRevert(TapeoutMinerPool.InvalidDistributor.selector);
        pool.bindDistributor(address(wrongReceipts));
        vm.expectRevert(TapeoutMinerPool.DistributorNotBound.selector);
        pool.activate(6, 4);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pool.bindDistributor(address(distributor));
        vm.startPrank(operator);
        pool.bindDistributor(address(distributor));
        assertEq(pool.distributor(), address(distributor));
        vm.expectRevert(TapeoutMinerPool.DistributorAlreadyBound.selector);
        pool.bindDistributor(address(distributor));
        distributor.finalizeAllocation();
        pool.activate(6, 4);
        vm.expectRevert(TapeoutMinerPool.DistributorAlreadyBound.selector);
        pool.bindDistributor(address(foreign)); // no replacement after activation either
        vm.stopPrank();
        assertEq(pool.distributor(), address(distributor));
    }

    /// @notice The pool checks what a distributor reports, not its code: a contract mimicking the views
    ///         can be bound by the owner before activation. The operator's deployed-code identity check
    ///         (`verify-deployment`, and every write command) is what proves the bound distributor is the
    ///         reviewed TapeoutReceiptDistributor. Documented, not a gap the contract can close (its
    ///         immutables differ per deployment).
    function testBindingChecksReportedViewsNotCode() public {
        FakeDistributor mimic =
            new FakeDistributor(address(pool), address(nandReceipt), address(latchReceipt), true, address(0));
        vm.prank(operator);
        pool.bindDistributor(address(mimic));
        assertEq(pool.distributor(), address(mimic));
        assertTrue(address(mimic).codehash != address(distributor).codehash);
    }

    function testIncorrectReceiptAddressesAreRefused() public {
        ForeignERC1155 foreign = new ForeignERC1155(NAND_CATEGORY);
        TapeoutMinerPool.Deployment memory d = deployment(whitelist());
        d.nandReceipt = address(foreign);
        vm.expectRevert(TapeoutMinerPool.IncompatibleReceipt.selector);
        new TapeoutMinerPool(d);
        d = deployment(whitelist());
        (d.nandReceipt, d.latchReceipt) = (d.latchReceipt, d.nandReceipt); // categories swapped
        vm.expectRevert(TapeoutMinerPool.IncompatibleReceipt.selector);
        new TapeoutMinerPool(d);
        // A distributor reporting other receipts cannot be bound.
        TapeoutEntitlementReceipt otherNand =
            new TapeoutEntitlementReceipt(NAND_CATEGORY, "Other NAND", "oN", "", operator);
        FakeDistributor mismatch =
            new FakeDistributor(address(pool), address(otherNand), address(latchReceipt), true, address(0));
        vm.prank(operator);
        vm.expectRevert(TapeoutMinerPool.InvalidDistributor.selector);
        pool.bindDistributor(address(mismatch));
    }

    function testIncorrectFinalizedSuppliesAreRefused() public {
        _finalizeIssuance(true, true);
        vm.startPrank(operator);
        pool.bindDistributor(address(distributor));
        distributor.finalizeAllocation();
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.UnexpectedShareCounts.selector, 6, 4));
        pool.activate(7, 4);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.UnexpectedShareCounts.selector, 6, 4));
        pool.activate(6, 3);
        pool.activate(6, 4);
        vm.stopPrank();
        assertEq(pool.nandShares(), 6);
        assertEq(pool.latchShares(), 4);
    }

    // ---------------------------------------------------------------------- after finality

    function _openCustody() internal {
        _finalizeIssuance(true, true);
        _bindFinalizeActivate();
        _renounceAllBut(address(0));
        vm.expectEmit(address(pool));
        emit TapeoutMinerPool.CustodyOpened(address(distributor), 6, 4);
        _admitOk(1);
        assertTrue(pool.custodyOpen());
    }

    function testSuccessfulAdmissionAfterEveryConditionAndNoRenunciationByThePool() public {
        _finalizeIssuance(true, true);
        _bindFinalizeActivate();
        _renounceAllBut(address(0));
        vm.expectCall(address(nandReceipt), abi.encodeWithSignature("renounceOwnership()"), 0);
        vm.expectCall(address(latchReceipt), abi.encodeWithSignature("renounceOwnership()"), 0);
        vm.expectCall(address(distributor), abi.encodeWithSignature("renounceOwnership()"), 0);
        _admitOk(1);
        assertTrue(pool.custodyOpen());
        assertEq(pool.accrual().nandIncome, 75 * BEM_UNIT);
        assertEq(pool.accrual().latchIncome, 25 * BEM_UNIT);
        assertReconciled();
    }

    /// @notice Once open, later admissions do not read the receipts' or distributor's owners again:
    ///         renunciation adds no liveness dependency on those contracts.
    function testLaterAdmissionsAfterRenunciationNeedNoFurtherChecks() public {
        _openCustody();
        vm.mockCallRevert(address(nandReceipt), abi.encodeWithSignature("owner()"), "NO_OWNER_READ");
        vm.mockCallRevert(address(latchReceipt), abi.encodeWithSignature("owner()"), "NO_OWNER_READ");
        vm.mockCallRevert(address(distributor), abi.encodeWithSignature("owner()"), "NO_OWNER_READ");
        vm.mockCallRevert(address(distributor), abi.encodeWithSignature("allocationFinalized()"), "NO_READ");
        _admitOk(2);
        assertEq(pool.minerCount(), 2);
        vm.clearMockedCalls();
        newMinerFor(depositor2, 3, 2, 5);
        accrue(3, 7 * BEM_UNIT);
        admitAs(depositor2, one(3)); // the other whitelisted depositor, still no owner anywhere
        assertEq(pool.minerCount(), 3);
        assertReconciled();
    }

    function testReceiptsDeliverTransferAndClaimWithoutAnyOwner() public {
        _openCustody();
        // Delivery after the distributor's renunciation: claim by the beneficiary, push by anyone.
        vm.prank(alice);
        assertEq(distributor.claim(100), 6);
        vm.prank(dave);
        assertEq(distributor.deliver(bob, 100), 2);
        vm.prank(dave);
        assertEq(distributor.deliver(carol, 100), 2);
        assertEq(nandReceipt.holderOf(5), bob);
        // Ordinary receipt transfers; unpaid BEM follows the ID.
        uint256 due = pool.claimable(NAND, 1);
        assertGt(due, 0);
        vm.prank(alice);
        nandReceipt.safeTransferFrom(alice, dave, 1, 1, "");
        vm.prank(dave);
        assertEq(pool.claim(NAND, 1), due);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, NAND, 1));
        pool.claim(NAND, 1);
        // BEM claims and A/B releases (with C) after the pool's renunciation.
        assertGt(claimAs(bob, two(5, 6), none()), 0);
        assertGt(claimAs(carol, none(), two(3, 4)), 0);
        uint256 t = pool.totalAccounted();
        assertEq(pool.releaseA(), t / 84);
        assertEq(pool.releaseB(), t / 84);
        assertEq(bem.balanceOf(SINK), t * 2 / 84);
        assertReconciled();
    }

    function testNoPrivilegedPowerRemainsAfterInitialization() public {
        _openCustody();
        bytes memory unauthorized =
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator);
        vm.startPrank(operator);
        vm.expectRevert(unauthorized);
        nandReceipt.issue(operator, 1);
        vm.expectRevert(unauthorized);
        latchReceipt.retract(1);
        vm.expectRevert(unauthorized);
        nandReceipt.setURI("ipfs://changed");
        vm.expectRevert(unauthorized);
        distributor.revokeWallet(alice);
        vm.expectRevert(unauthorized);
        distributor.allocate(new TapeoutReceiptDistributor.AllocationInput[](1));
        vm.expectRevert(unauthorized);
        pool.activate(6, 4);
        vm.expectRevert(unauthorized);
        pool.bindDistributor(address(distributor));
        vm.expectRevert(unauthorized);
        pool.transferOwnership(operator);
        vm.stopPrank();
        assertEq(nandReceipt.totalSupply(), 6);
        assertEq(latchReceipt.totalSupply(), 4);
        assertEq(distributor.beneficiaryOf(NAND, 1), alice);
    }

    /// @notice Ownable2Step: a pending transfer is cleared by renouncing, so it cannot revive ownership;
    ///         a completed transfer to someone else keeps custody closed until that owner renounces.
    function testPendingOrCompletedOwnershipTransfersAreHandled() public {
        _finalizeIssuance(true, true);
        _bindFinalizeActivate();
        address eve = makeAddr("eve");
        vm.prank(operator);
        nandReceipt.transferOwnership(eve); // pending
        _renounceAllBut(address(0));
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        nandReceipt.acceptOwnership();
        assertEq(nandReceipt.owner(), address(0));
        assertEq(nandReceipt.pendingOwner(), address(0));
        _admitOk(1);
    }

    function testCompletedOwnershipTransferKeepsCustodyClosed() public {
        _finalizeIssuance(true, true);
        _bindFinalizeActivate();
        address eve = makeAddr("eve");
        vm.prank(operator);
        distributor.transferOwnership(eve);
        vm.prank(eve);
        distributor.acceptOwnership();
        _renounce(nandReceipt);
        _renounce(latchReceipt);
        _renounce(pool);
        _admitExpecting(1, _notRenounced(address(distributor)));
        vm.prank(eve);
        distributor.renounceOwnership();
        _admitOk(1);
    }
}
