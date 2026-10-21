// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";

/// @notice Review-only test (candidate 8cf31dc), risk group 3: reentry from either transfer of a
///         release into every reachable entry point (not all share the same guard), role aliases,
///         role/holder overlap, and the prohibition on sink redirection. MOCK-ONLY CALLBACKS: the
///         bound BEM makes no calls during a transfer, so no reentry is reachable with it.
contract FeeSplitCallbacksTest is SystemTestBase {
    address internal constant SINK = 0x000000000000000000000000000000000000dEaD;
    TapeoutMinerPool.Recipient internal constant A = TapeoutMinerPool.Recipient.A;
    TapeoutMinerPool.Recipient internal constant B = TapeoutMinerPool.Recipient.B;

    function setUp() public override {
        super.setUp();
        setupStandard();
        admitNew(1, 1, 1);
        newMiner(2, 1, 1);
        bem.mint(address(pool), 84_000); // A = B = 1,000, C = 2,000
    }

    /// @dev Runs `releaseA` with `data` called on the pool from inside the transfer to `trigger`, on a
    ///      snapshot that is undone afterwards; returns the inner call's result.
    function _reenter(address trigger, bytes memory data) internal returns (bool ok, bytes memory result) {
        uint256 snapshot = vm.snapshotState();
        bem.setTransferHook(trigger, address(pool), data, false);
        assertEq(pool.releaseA(), 1_000, "the outer release completes once");
        assertTrue(bem.hookCalled());
        (ok, result) = (bem.hookSucceeded(), bem.hookResult());
        assertEq(bem.balanceOf(SINK), 2_000, "C paid exactly once");
        assertEq(pool.recipientAPaid(), 1_000);
        assertEq(pool.recipientBPaid(), 0, "B untouched by the reentry attempt");
        assertReconciled();
        vm.revertToState(snapshot);
    }

    function testEveryGuardedEntryPointRefusesReentryFromEitherTransfer() public {
        bytes[9] memory guarded = [
            abi.encodeCall(pool.releaseA, ()),
            abi.encodeCall(pool.releaseB, ()),
            abi.encodeCall(pool.claim, (NAND, 1)),
            abi.encodeCall(pool.claimBatch, (one(1), none())),
            abi.encodeCall(pool.sync, ()),
            abi.encodeCall(pool.harvest, (one(1))),
            abi.encodeCall(pool.harvestRange, (0, 1)),
            abi.encodeCall(pool.depositMiners, (one(2))),
            abi.encodeCall(pool.registerMiners, (one(2)))
        ];
        address[2] memory triggers = [recipientA, SINK];
        for (uint256 t; t < 2; ++t) {
            for (uint256 i; i < guarded.length; ++i) {
                (bool ok, bytes memory result) = _reenter(triggers[t], guarded[i]);
                assertFalse(ok);
                assertEq(bytes4(result), ReentrancyGuard.ReentrancyGuardReentrantCall.selector, "guarded entry point");
            }
        }
    }

    function testUnguardedEntryPointsAreRefusedByTheirOwnAuthorization() public {
        // setRecipient has no reentrancy guard: the caller inside the hook is the token, never a recipient.
        (bool ok, bytes memory result) = _reenter(recipientA, abi.encodeCall(pool.setRecipient, (A, bob)));
        assertFalse(ok);
        assertEq(bytes4(result), TapeoutMinerPool.Unauthorized.selector);
        (ok, result) = _reenter(SINK, abi.encodeCall(pool.setRecipient, (B, bob)));
        assertFalse(ok);
        assertEq(bytes4(result), TapeoutMinerPool.Unauthorized.selector);
        // activate / renounceOwnership are owner-only (and activation is already done).
        (ok, result) = _reenter(SINK, abi.encodeCall(pool.activate, (10, 10)));
        assertFalse(ok);
        assertEq(bytes4(result), Ownable.OwnableUnauthorizedAccount.selector);
        (ok, result) = _reenter(recipientA, abi.encodeWithSignature("renounceOwnership()"));
        assertFalse(ok);
        assertEq(bytes4(result), Ownable.OwnableUnauthorizedAccount.selector);
        assertEq(pool.recipientA(), recipientA);
        assertEq(pool.owner(), operator);
    }

    /// @notice INFORMATIONAL: views are not guarded. Between the two transfers of a release (after the
    ///         role was paid, before the sink was), a reentrant read sees the pool's balance minus the
    ///         role amount against a ledger that already counts the sink amount as paid, so
    ///         `unrecognizedBalance` transiently equals the sink amount and preview views over-read by
    ///         that much. Only a token that calls back during `transfer` can observe this; no state can
    ///         be changed on it, and the values are correct again when the release returns.
    function testTransientViewOverReadBetweenTheTwoTransfersIsReadOnly() public {
        (bool ok, bytes memory result) = _reenter(recipientA, abi.encodeCall(pool.unrecognizedBalance, ()));
        assertTrue(ok);
        assertEq(abi.decode(result, (uint256)), 2_000, "the not-yet-transferred sink amount reads as unrecognized");
        (ok, result) = _reenter(recipientA, abi.encodeCall(pool.sinkClaimable, ()));
        assertTrue(ok);
        assertEq(abi.decode(result, (uint256)), uint256(84_000 + 2_000) * 2 / 84 - 2_000, "phantom preview");
        // After the sink transfer (the second leg) the ledger and balance agree again.
        (ok, result) = _reenter(SINK, abi.encodeCall(pool.unrecognizedBalance, ()));
        assertTrue(ok);
        assertEq(abi.decode(result, (uint256)), 0);
        pool.releaseA();
        assertEq(pool.unrecognizedBalance(), 0);
        assertEq(pool.sinkClaimable(), 0);
    }

    function testRoleAliasesHolderOverlapAndSinkRedirectionProhibited() public {
        // A moves to B's address: both roles pay one address, with separate histories (nothing forbids it).
        vm.prank(recipientA);
        pool.setRecipient(A, recipientB);
        assertEq(pool.releaseA(), 1_000);
        assertEq(pool.releaseB(), 1_000);
        assertEq(bem.balanceOf(recipientB), 2_000);
        assertEq(pool.recipientAPaid(), 1_000);
        assertEq(pool.recipientBPaid(), 1_000);
        assertEq(bem.balanceOf(SINK), 2_000);
        // A moves on to a receipt holder: role income and receipt income are separate buckets.
        vm.prank(recipientB);
        pool.setRecipient(A, alice);
        bem.mint(address(pool), 84_000);
        uint256 before = bem.balanceOf(alice);
        assertEq(pool.releaseA(), 1_000);
        assertEq(bem.balanceOf(alice) - before, 1_000);
        assertEq(bem.balanceOf(SINK), 4_000);
        // 2 x 80,000 at 1:1 -> NAND 80,000 (8,000 per ID), LATCH 80,000 (8,000 per ID).
        assertEq(claimAs(alice, range(1, 5), range(1, 5)), 10 * 8_000);
        // The sink is not a role: no role may be pointed at it or at the pool; it cannot act; nobody else
        // (owner included) can move a role.
        vm.prank(alice);
        vm.expectRevert(TapeoutMinerPool.InvalidAddress.selector);
        pool.setRecipient(A, SINK);
        vm.prank(alice);
        vm.expectRevert(TapeoutMinerPool.InvalidAddress.selector);
        pool.setRecipient(A, address(pool));
        vm.prank(operator);
        vm.expectRevert(TapeoutMinerPool.Unauthorized.selector);
        pool.setRecipient(B, operator);
        vm.prank(SINK);
        vm.expectRevert(TapeoutMinerPool.Unauthorized.selector);
        pool.setRecipient(B, SINK);
        (bool ok,) = address(pool).call(abi.encodeWithSignature("setSink(address)", alice));
        assertFalse(ok, "no sink setter exists");
        assertEq(pool.SINK(), SINK);
        assertReconciled();
    }
}
