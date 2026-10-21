// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {console2} from "forge-std/console2.sol";
import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutReceiptDistributor} from "../../src/TapeoutReceiptDistributor.sol";

/// @notice Review finding T-02 (GPT review of f2c8e50), against the unchanged distributor. A delivery is
///         `deliver(wallet, maxIds)` / `claim(maxIds)`: calldata names no cursor, so a call planned for one
///         cursor position executes from wherever others have moved it. Every call here is its own
///         transaction (isolation) with exactly its planned gas limit minus the intrinsic cost.
///         Bounds are the SDK's (sdk/gas.ts; test/sdk/gas.test.ts asserts the same numbers): MODEL upper
///         bounds. Logged "used" values are measured gas of successful transactions only; a reverted
///         call's gasleft delta is never reported as measured gas.
abstract contract DeliveryRaceBase is SystemTestBase {
    uint256 internal constant BATCH_GAS_BUDGET = 16_777_216 * 3 / 4;
    uint256 internal constant DELIVER_BASE = 100_000;
    uint256 internal constant DELIVER_PER_ID = 37_000;
    uint256 internal constant DELIVER_PER_RANGE = 100_000;
    /// @dev The current planner's call for these wallets: 91 IDs, bounded for 91 ranges (any reachable cursor).
    uint256 internal constant SAFE_IDS = 91;
    uint256 internal constant SAFE_BOUND = DELIVER_BASE + SAFE_IDS * (DELIVER_PER_ID + DELIVER_PER_RANGE); // 12,567,000

    address internal keeper = makeAddr("keeper");

    function _allocateRun(TapeoutMinerPool.Category category, address wallet, uint256 first, uint256 count)
        internal
    {
        TapeoutReceiptDistributor.AllocationInput[] memory e =
            new TapeoutReceiptDistributor.AllocationInput[](1);
        e[0] = TapeoutReceiptDistributor.AllocationInput({
            category: category, wallet: wallet, firstId: uint64(first), count: uint64(count)
        });
        vm.prank(operator);
        distributor.allocate(e);
    }

    function _allocateSingles(
        TapeoutMinerPool.Category category,
        address wallet,
        uint256 first,
        uint256 count
    ) internal {
        TapeoutReceiptDistributor.AllocationInput[] memory e =
            new TapeoutReceiptDistributor.AllocationInput[](count);
        for (uint256 i; i < count; ++i) {
            e[i] = TapeoutReceiptDistributor.AllocationInput({
                category: category, wallet: wallet, firstId: uint64(first + i), count: 1
            });
        }
        vm.prank(operator);
        distributor.allocate(e);
    }

    function _calldataGas(bytes memory data) internal pure returns (uint256 gas) {
        for (uint256 i; i < data.length; ++i) {
            gas += data[i] == 0 ? 4 : 16;
        }
    }

    /// @dev Sends `data` as a transaction with gas limit `bound`. Returns success and, only when it
    ///      succeeded, the gas it used; a failed attempt's gas is not a meaningful measurement.
    function _send(address from, bytes memory data, uint256 bound) internal returns (bool ok, uint256 used) {
        assertLe(bound, BATCH_GAS_BUDGET, "bound above the planning budget");
        uint256 intrinsic = 21_000 + _calldataGas(data);
        vm.prank(from);
        uint256 before = gasleft();
        (ok,) = address(distributor).call{gas: bound - intrinsic}(data);
        used = ok ? before - gasleft() : 0;
    }

    function _pending() internal view returns (uint256) {
        (uint256 n, uint256 l) = distributor.pendingOf(alice);
        return n + l;
    }
}

/// forge-config: default.isolate = true
contract DeliveryRaceTest is DeliveryRaceBase {
    /// @dev What the previous planner emitted for this wallet's first delivery: 300 IDs in one range.
    uint256 internal constant OLD_BOUND = DELIVER_BASE + 300 * DELIVER_PER_ID + DELIVER_PER_RANGE; // 11,300,000

    function setUp() public override {
        super.setUp();
        // alice: NAND 1..300 in one range, then 300 single-ID ranges 301..600 (the review's case).
        issue(nandReceipt, address(distributor), 600);
        _allocateRun(NAND, alice, 1, 300);
        for (uint256 id = 301; id <= 600; id += 100) {
            _allocateSingles(NAND, alice, id, 100);
        }
        finalizeIssuance();
        vm.prank(operator);
        distributor.finalizeAllocation();
    }

    function testOldPlanRunsOutOfGasAfterAKeeperDeliversFirstAndRollsBack() public {
        // The keeper delivers the contiguous section with the bound planned for exactly that state.
        (bool keeperOk,) = _send(keeper, abi.encodeCall(distributor.deliver, (alice, 300)), OLD_BOUND);
        assertTrue(keeperOk, "keeper delivery of the contiguous range");
        assertEq(_pending(), 300);
        assertEq(distributor.nextRangeOf(alice), 1);
        // Alice's unchanged pending call now walks 300 single-ID ranges with the old limit: it fails.
        (bool staleOk,) = _send(alice, abi.encodeCall(distributor.claim, (300)), OLD_BOUND);
        assertFalse(staleOk, "the previous planner's bound is not enough at the advanced cursor");
        // All-or-nothing: nothing moved, the cursor did not advance, the next ID is still in the distributor.
        assertEq(_pending(), 300);
        assertEq(distributor.nextRangeOf(alice), 1);
        assertEq(nandReceipt.balanceOf(address(distributor), 301), 1);
        assertEq(nandReceipt.balanceOf(alice, 301), 0);
        // A replanned delivery (the current planner's size and bound) succeeds.
        (bool replanned, uint256 used) =
            _send(alice, abi.encodeCall(distributor.claim, (SAFE_IDS)), SAFE_BOUND);
        assertTrue(replanned, "replanned delivery");
        console2.log("replanned delivery, 91 single-ID ranges: measured gas, model bound", used, SAFE_BOUND);
        assertEq(_pending(), 300 - SAFE_IDS);
    }

    /// @dev The current plan for alice's initial state is 6 x 91 IDs then 54 IDs, each with its bound.
    function _plannedCall(uint256 i) internal pure returns (uint256 ids, uint256 bound) {
        ids = i < 6 ? SAFE_IDS : 54;
        bound = DELIVER_BASE + ids * (DELIVER_PER_ID + DELIVER_PER_RANGE);
    }

    function _raceThenPlannedCalls(uint256 keeperIds) internal {
        // Others deliver any number of IDs first (here one call, as large as the keeper wants to pay for).
        if (keeperIds > 0) {
            vm.prank(keeper);
            distributor.deliver(alice, keeperIds);
        }
        // Every call of the plan made from the initial snapshot still fits its limit; once nothing is
        // left, the remaining calls revert cheaply with NothingToDeliver.
        uint256 delivered = keeperIds;
        for (uint256 i; i < 7; ++i) {
            (uint256 ids, uint256 bound) = _plannedCall(i);
            uint256 before = _pending();
            (bool ok, uint256 used) = _send(alice, abi.encodeCall(distributor.claim, (ids)), bound);
            if (before == 0) {
                assertFalse(ok, "nothing left: the call reverts");
                continue;
            }
            assertTrue(ok, "planned delivery fits its limit at the advanced cursor");
            assertLe(used, bound);
            delivered += before < ids ? before : ids;
            assertEq(_pending(), 600 - delivered);
        }
        assertEq(_pending(), 0);
        for (uint256 id = 1; id <= 600; ++id) {
            assertEq(nandReceipt.balanceOf(alice, id), 1);
        }
        (,, uint256[2] memory deliveredTotals) = distributor.totals();
        assertEq(deliveredTotals[0], 600, "every ID delivered exactly once");
    }

    function testPlannedCallsFitWithoutInterference() public {
        _raceThenPlannedCalls(0);
    }

    function testPlannedCallsFitWhenTheContiguousRangeWasDeliveredFirst() public {
        _raceThenPlannedCalls(300);
    }

    function testPlannedCallsFitAfterPartialProgressInsideTheRange() public {
        _raceThenPlannedCalls(150);
    }

    function testPlannedCallsFitAfterProgressEndingOneIdBeforeTheSingletons() public {
        _raceThenPlannedCalls(299);
    }

    function testPlannedCallsFitAfterProgressInsideTheSingletons() public {
        _raceThenPlannedCalls(345);
    }

    function testStaleCallsAfterEverythingWasDeliveredRevertWithNothingToDeliver() public {
        vm.startPrank(keeper);
        distributor.deliver(alice, 300);
        distributor.deliver(alice, 300);
        vm.stopPrank();
        assertEq(_pending(), 0);
        (uint256 ids, uint256 bound) = _plannedCall(0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TapeoutReceiptDistributor.NothingToDeliver.selector, alice));
        distributor.claim(ids);
        (bool ok,) = _send(alice, abi.encodeCall(distributor.claim, (ids)), bound);
        assertFalse(ok);
    }
}

/// @notice Heterogeneous NAND and LATCH ranges: NAND 1..200 in one range, 100 single-ID LATCH ranges,
///         then NAND 201..300 in one range. The SDK bounds a 91-ID call for 91 ranges (any reachable
///         start), so the call fits wherever others leave the cursor.
/// forge-config: default.isolate = true
contract DeliveryRaceMixedCategoriesTest is DeliveryRaceBase {
    function setUp() public override {
        super.setUp();
        issue(nandReceipt, address(distributor), 300);
        issue(latchReceipt, address(distributor), 100);
        _allocateRun(NAND, alice, 1, 200);
        _allocateSingles(LATCH, alice, 1, 100);
        _allocateRun(NAND, alice, 201, 100);
        finalizeIssuance();
        vm.prank(operator);
        distributor.finalizeAllocation();
    }

    function _mixedRace(uint256 keeperIds) internal {
        if (keeperIds > 0) {
            vm.prank(keeper);
            distributor.deliver(alice, keeperIds);
        }
        while (_pending() > 0) {
            (bool ok, uint256 used) = _send(alice, abi.encodeCall(distributor.claim, (SAFE_IDS)), SAFE_BOUND);
            assertTrue(ok, "91-ID delivery fits its bound at every reachable cursor");
            assertLe(used, SAFE_BOUND);
        }
        for (uint256 id = 1; id <= 300; ++id) {
            assertEq(nandReceipt.balanceOf(alice, id), 1);
        }
        for (uint256 id = 1; id <= 100; ++id) {
            assertEq(latchReceipt.balanceOf(alice, id), 1);
        }
    }

    function testMixedFromStart() public {
        _mixedRace(0);
    }

    function testMixedAfterTheFirstNandRange() public {
        _mixedRace(199);
    }

    function testMixedInsideTheLatchSingletons() public {
        _mixedRace(250);
    }
}
