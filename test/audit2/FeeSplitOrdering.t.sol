// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";

/// @notice Review-only test (candidate 8cf31dc), risk group 1: C's debt and release ordering. Every
///         expected value is the specification's own arithmetic written here (floor(T/84),
///         floor(2T/84), floor(80T/84)); nothing is derived from PoolMath or from the pool's views.
///         Pool: S_N = S_L = 10, one 3:1 miner.
contract FeeSplitOrderingTest is SystemTestBase {
    address internal constant SINK = 0x000000000000000000000000000000000000dEaD;
    TapeoutMinerPool.Recipient internal constant A = TapeoutMinerPool.Recipient.A;
    TapeoutMinerPool.Recipient internal constant B = TapeoutMinerPool.Recipient.B;

    event RecipientPaid(TapeoutMinerPool.Recipient indexed role, address indexed recipient, uint256 amount);
    event SinkPaid(TapeoutMinerPool.Recipient indexed releasedRole, address indexed sink, uint256 amount);

    uint256 internal T; // recognized total as the test tracks it
    uint256 internal paidA;
    uint256 internal paidB;
    uint256 internal paidC;
    uint256 internal callers;

    function setUp() public override {
        super.setUp();
        setupStandard();
        admitNew(1, 3, 1);
    }

    function _a(uint256 t) internal pure returns (uint256) {
        return t / 84;
    }

    function _c(uint256 t) internal pure returns (uint256) {
        return t * 2 / 84;
    }

    function _income(uint256 x) internal {
        bem.mint(address(pool), x);
        T += x;
    }

    /// @dev Releases `role` from a fresh third-party address and checks the return value, both events
    ///      with their exact arguments, the sink balance, every paid history and totalPaid.
    function _release(TapeoutMinerPool.Recipient role) internal returns (uint256 got) {
        bool isA = role == A;
        address recipient = isA ? pool.recipientA() : pool.recipientB();
        uint256 expectRole = _a(T) - (isA ? paidA : paidB);
        uint256 expectC = _c(T) - paidC;
        uint256 otherPaidBefore = isA ? pool.recipientBPaid() : pool.recipientAPaid();
        address caller = makeAddr(string.concat("third-party-", vm.toString(++callers)));
        vm.expectEmit(address(pool));
        emit RecipientPaid(role, recipient, expectRole);
        vm.expectEmit(address(pool));
        emit SinkPaid(role, SINK, expectC);
        vm.prank(caller);
        got = isA ? pool.releaseA() : pool.releaseB();
        assertEq(got, expectRole, "role return value");
        if (isA) paidA = _a(T);
        else paidB = _a(T);
        paidC = _c(T);
        assertEq(pool.recipientAPaid(), paidA, "A paid history");
        assertEq(pool.recipientBPaid(), paidB, "B paid history");
        assertEq(pool.sinkPaid(), paidC, "C paid history");
        assertEq(isA ? pool.recipientBPaid() : pool.recipientAPaid(), otherPaidBefore, "other role untouched");
        assertEq(bem.balanceOf(SINK), paidC, "sink balance is floor(2T/84)");
        assertEq(bem.balanceOf(recipientA), paidA, "A balance");
        assertEq(bem.balanceOf(recipientB), paidB, "B balance");
        assertEq(
            pool.totalPaid(),
            paidA + paidB + paidC + pool.receiptsPaid(NAND) + pool.receiptsPaid(LATCH),
            "totalPaid covers both transfers"
        );
        assertEq(bem.balanceOf(caller), 0, "the caller receives nothing");
        assertEq(pool.sinkClaimable(), 0, "C cleared at this total");
        assertEq(pool.recipientClaimable(role), 0);
        assertReconciled();
    }

    function testAtFortyTwoRawUnitsRolesAreDueZeroAndCIsOne() public {
        _income(42);
        assertEq(_release(A), 0);
        assertEq(bem.balanceOf(SINK), 1);
        assertEq(_release(B), 0);
        assertEq(bem.balanceOf(SINK), 1, "C's unit is not paid twice");
        _income(42); // T = 84
        assertEq(_release(B), 1);
        assertEq(bem.balanceOf(SINK), 2);
        assertEq(_release(A), 1);
    }

    function testABASequenceWithIncomeBetween() public {
        uint256[5] memory inflows = [uint256(84_000), 42, 41, 1_050, 999_983];
        TapeoutMinerPool.Recipient[5] memory seq = [A, B, A, B, A];
        for (uint256 i; i < 5; ++i) {
            _income(inflows[i]);
            _release(seq[i]);
        }
        assertEq(pool.recipientClaimable(B), _a(T) - paidB);
    }

    function testBABSequenceWithIncomeBetween() public {
        uint256[5] memory inflows = [uint256(84_000), 42, 41, 1_050, 999_983];
        TapeoutMinerPool.Recipient[5] memory seq = [B, A, B, A, B];
        for (uint256 i; i < 5; ++i) {
            _income(inflows[i]);
            _release(seq[i]);
        }
        assertEq(pool.recipientClaimable(A), _a(T) - paidA);
    }

    function testRepeatedReleasesWithoutIncomePayNobodyAndStillEmitBothEvents() public {
        _income(84_000);
        assertEq(_release(A), 1_000);
        assertEq(_release(B), 1_000);
        for (uint256 i; i < 3; ++i) {
            assertEq(_release(A), 0);
            assertEq(_release(B), 0);
        }
        assertEq(bem.balanceOf(SINK), 2_000);
    }

    function testLongInactivityOfOneRoleWhileTheOtherSettlesC() public {
        for (uint256 i = 1; i <= 40; ++i) {
            _income(i * 2_003 + (i % 7));
            _release(A);
            assertEq(pool.recipientClaimable(B), _a(T), "B keeps accruing untouched");
            assertEq(bem.balanceOf(recipientB), 0);
        }
        assertEq(_release(B), _a(T), "B's whole accrual at once; C nothing more");
        assertEq(_release(B), 0);
    }

    function testOneRoleFullyPaidWhileCIsStillDue() public {
        _income(84);
        assertEq(_release(A), 1); // A 1, C 2
        _income(42); // T = 126: A due 0, C due 1
        assertEq(_release(A), 0);
        assertEq(bem.balanceOf(SINK), 3);
        _income(42); // T = 168: A due 1, B due 2 (never released), C due 1
        assertEq(_release(B), 2);
        assertEq(bem.balanceOf(SINK), 4);
        assertEq(_release(A), 1);
        assertEq(bem.balanceOf(SINK), 4);
    }

    function testTinyInterleavedInflowsNeverOverpayC() public {
        for (uint256 i = 1; i <= 300; ++i) {
            _income(1);
            if (i % 3 == 0) _release(A);
            else if (i % 5 == 0) _release(B);
            else pool.sync();
            assertLe(bem.balanceOf(SINK), _c(T), "C never above floor(2T/84)");
            assertEq(pool.sinkClaimable(), _c(T) - paidC, "C's outstanding part");
            assertEq(pool.recipientClaimable(A), _a(T) - paidA);
            assertEq(pool.recipientClaimable(B), _a(T) - paidB);
        }
        _release(A);
        _release(B);
        assertEq(bem.balanceOf(SINK) + bem.balanceOf(recipientA) + bem.balanceOf(recipientB), _c(T) + 2 * _a(T));
    }
}
