// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";

/// @notice Review-only test (candidate 8cf31dc), risk group 2: the two payments of a release are one
///         unit. MOCK-ONLY FAULT INJECTION: the bound BEM (a 2,205-byte non-proxy ERC-20, code hash
///         0x982ba795…b344 at blocks 128,713,128 and 128,926,659) has no destination block list, no
///         callback, no fee and no false-return path, so none of these failures is reachable with it;
///         the tests establish fail-closed behaviour under hypothetical token faults.
///         Pool: S_N = S_L = 10, one 3:1 miner, 84,000 raw recognized: A = B = 1,000, C = 2,000.
contract FeeSplitAtomicTest is SystemTestBase {
    address internal constant SINK = 0x000000000000000000000000000000000000dEaD;

    struct Snap {
        uint256 total;
        uint256 paid;
        uint256 aPaid;
        uint256 bPaid;
        uint256 cPaid;
        uint256 poolBal;
        uint256 aBal;
        uint256 bBal;
        uint256 sinkBal;
        uint256 unrecognized;
        bytes32 accrual;
        bytes32 reconciliation;
    }

    function setUp() public override {
        super.setUp();
        setupStandard();
        admitNew(1, 3, 1);
        bem.mint(address(pool), 84_000);
        pool.sync();
    }

    function _snap() internal view returns (Snap memory s) {
        s.total = pool.totalAccounted();
        s.paid = pool.totalPaid();
        s.aPaid = pool.recipientAPaid();
        s.bPaid = pool.recipientBPaid();
        s.cPaid = pool.sinkPaid();
        s.poolBal = bem.balanceOf(address(pool));
        s.aBal = bem.balanceOf(recipientA);
        s.bBal = bem.balanceOf(recipientB);
        s.sinkBal = bem.balanceOf(SINK);
        s.unrecognized = pool.unrecognizedBalance();
        s.accrual = keccak256(abi.encode(pool.accrual()));
        s.reconciliation = keccak256(abi.encode(pool.reconciliation()));
    }

    function _unchanged(Snap memory before) internal view {
        assertEq(keccak256(abi.encode(_snap())), keccak256(abi.encode(before)), "state changed by a failed release");
        assertEq(pool.unrecognizedBalance(), 0, "no phantom income after the rollback");
    }

    function testRoleTransferRevertRollsBackBothPayments() public {
        bem.setBlockedTo(recipientA, true);
        Snap memory before = _snap();
        vm.expectRevert(bytes("BEM_DESTINATION_BLOCKED"));
        pool.releaseA();
        _unchanged(before);
        assertEq(pool.sync(), 0);
        // The other role is independent and carries C's whole backlog.
        assertEq(pool.releaseB(), 1_000);
        assertEq(bem.balanceOf(SINK), 2_000);
        assertEq(pool.recipientClaimable(TapeoutMinerPool.Recipient.A), 1_000, "A still owed");
        assertReconciled();
    }

    function testSinkTransferRevertAfterTheRoleTransferRollsBackTheRolePaymentToo() public {
        bem.setBlockedTo(SINK, true);
        Snap memory before = _snap();
        vm.expectRevert(bytes("BEM_DESTINATION_BLOCKED"));
        pool.releaseA();
        _unchanged(before);
        assertEq(bem.balanceOf(recipientA), 0, "the first (role) transfer was rolled back with the second");
        vm.expectRevert(bytes("BEM_DESTINATION_BLOCKED"));
        pool.releaseB();
        _unchanged(before);
        assertEq(pool.sinkClaimable(), 2_000, "C stays accrued");
    }

    function testFalseReturnFromEitherTransferRollsBack() public {
        bytes memory failed = abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(bem));
        Snap memory before = _snap();
        // The sink transfer (second leg) returns false: the role transfer already made is undone.
        vm.mockCall(address(bem), abi.encodeCall(bem.transfer, (SINK, 2_000)), abi.encode(false));
        vm.expectRevert(failed);
        pool.releaseA();
        _unchanged(before);
        vm.clearMockedCalls();
        // The role transfer (first leg) returns false.
        vm.mockCall(address(bem), abi.encodeCall(bem.transfer, (recipientA, 1_000)), abi.encode(false));
        vm.expectRevert(failed);
        pool.releaseA();
        _unchanged(before);
        vm.clearMockedCalls();
        assertEq(pool.releaseA(), 1_000);
        assertEq(bem.balanceOf(SINK), 2_000);
        assertReconciled();
    }

    function testSilentNoOpTransfersAreCaughtByTheThreeBalanceChecks() public {
        Snap memory before = _snap();
        // A transfer that returns true but moves nothing (mocked): the sink's delta is wrong.
        vm.mockCall(address(bem), abi.encodeCall(bem.transfer, (SINK, 2_000)), abi.encode(true));
        vm.expectRevert(TapeoutMinerPool.UnexpectedTokenBehavior.selector);
        pool.releaseA();
        _unchanged(before);
        vm.clearMockedCalls();
        // Same for the role's leg.
        vm.mockCall(address(bem), abi.encodeCall(bem.transfer, (recipientA, 1_000)), abi.encode(true));
        vm.expectRevert(TapeoutMinerPool.UnexpectedTokenBehavior.selector);
        pool.releaseA();
        _unchanged(before);
        vm.clearMockedCalls();
    }

    function testFeeOnTransferIsRefusedForTheWholeRelease() public {
        bem.setFaults(false, false, true); // every transfer loses one unit
        Snap memory before = _snap();
        vm.expectRevert(TapeoutMinerPool.UnexpectedTokenBehavior.selector);
        pool.releaseA();
        _unchanged(before);
        vm.expectRevert(TapeoutMinerPool.UnexpectedTokenBehavior.selector);
        pool.releaseB();
        _unchanged(before);
    }

    function testSinkOnlyRejectionLeavesClaimsHarvestAdmissionSyncAndAccrualUntouched() public {
        bem.setBlockedTo(SINK, true);
        // Receipt claims: 3:1 of 80,000 -> NAND 60,000 (6,000 per ID), LATCH 20,000 (2,000 per ID).
        assertEq(claimAs(alice, range(1, 5), range(1, 5)), 5 * 6_000 + 5 * 2_000);
        accrue(1, 8_400);
        (uint256 received,) = pool.harvestRange(0, 1);
        assertEq(received, 8_400);
        admitNew(2, 1, 1);
        bem.mint(address(pool), 84);
        assertEq(pool.sync(), 84);
        uint256 total = 84_000 + 8_400 + 84;
        assertEq(pool.totalAccounted(), total);
        assertEq(pool.sinkClaimable(), total * 2 / 84, "C accrues through every path");
        assertEq(bem.balanceOf(SINK), 0, "but only a release pays it");
        vm.expectRevert(bytes("BEM_DESTINATION_BLOCKED"));
        pool.releaseB();
        bem.setBlockedTo(SINK, false);
        assertEq(pool.releaseB(), total / 84);
        assertEq(bem.balanceOf(SINK), total * 2 / 84, "the backlog is paid once");
        assertReconciled();
    }
}
