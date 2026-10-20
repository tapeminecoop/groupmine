// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {console2} from "forge-std/console2.sol";
import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutReceiptDistributor} from "../../src/TapeoutReceiptDistributor.sol";
import {ToggleReceiver} from "../helpers/Mocks.sol";

/// @notice Internal security review (f2c8e50), workstream B: the per-wallet delivery cursor through
///         independent transactions (Foundry isolation: every call below is its own transaction with
///         cold storage and its planned gas bound as the limit, mirrors of sdk/gas.ts DELIVER_GAS).
/// forge-config: default.isolate = true
contract AuditDistributorCursorTest is SystemTestBase {
    uint256 internal constant BATCH_GAS_BUDGET = 16_777_216 * 3 / 4;
    uint256 internal constant DELIVER_BASE = 100_000;
    uint256 internal constant DELIVER_PER_ID = 37_000;
    uint256 internal constant DELIVER_PER_RANGE = 100_000;

    function _calldataGas(bytes memory data) internal pure returns (uint256 gas) {
        for (uint256 i; i < data.length; ++i) {
            gas += data[i] == 0 ? 4 : 16;
        }
    }

    /// @dev Same method as test/unit/GasModel.t.sol: a transaction with exactly the planned limit.
    function _within(address from, address target, bytes memory data, uint256 bound) internal returns (uint256 used) {
        uint256 intrinsic = 21_000 + _calldataGas(data);
        assertLe(bound, BATCH_GAS_BUDGET);
        vm.prank(from);
        uint256 before = gasleft();
        (bool ok, bytes memory result) = target.call{gas: bound - intrinsic}(data);
        used = before - gasleft();
        if (!ok) {
            if (result.length == 0) revert("transaction failed within its planned gas limit (out of gas)");
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    function _entry(TapeoutMinerPool.Category c, address wallet, uint64 first, uint64 count)
        internal
        pure
        returns (TapeoutReceiptDistributor.AllocationInput memory)
    {
        return TapeoutReceiptDistributor.AllocationInput({category: c, wallet: wallet, firstId: first, count: count});
    }

    function _bound(uint256 ranges, uint256 ids) internal pure returns (uint256) {
        return DELIVER_BASE + ranges * DELIVER_PER_RANGE + ids * DELIVER_PER_ID;
    }

    function testPartialRangeRefusalAndRetryEachAtItsPlannedBound() public {
        ToggleReceiver wallet = new ToggleReceiver();
        issue(nandReceipt, address(distributor), 12);
        issue(latchReceipt, address(distributor), 6);
        // Ranges: NAND [1..3], [4], [5], [6..12]; LATCH [1..6].
        TapeoutReceiptDistributor.AllocationInput[] memory e = new TapeoutReceiptDistributor.AllocationInput[](5);
        e[0] = _entry(NAND, address(wallet), 1, 3);
        e[1] = _entry(NAND, address(wallet), 4, 1);
        e[2] = _entry(NAND, address(wallet), 5, 1);
        e[3] = _entry(NAND, address(wallet), 6, 7);
        e[4] = _entry(LATCH, address(wallet), 1, 6);
        vm.startPrank(operator);
        distributor.allocate(e);
        nandReceipt.finalizeIssuance();
        latchReceipt.finalizeIssuance();
        distributor.finalizeAllocation();
        vm.stopPrank();

        // tx 1: four IDs complete ranges 0 and 1 (two ranges touched).
        uint256 g1 = _within(carol, address(distributor), abi.encodeCall(distributor.deliver, (address(wallet), 4)), _bound(2, 4));
        assertEq(distributor.nextRangeOf(address(wallet)), 2);
        // tx 2: the receiver refuses; nothing moves, the cursor and counters are unchanged.
        wallet.setRefuse(true);
        vm.prank(carol);
        vm.expectRevert(ToggleReceiver.Refused.selector);
        distributor.deliver(address(wallet), 5);
        assertEq(distributor.nextRangeOf(address(wallet)), 2);
        TapeoutReceiptDistributor.Range[] memory ranges = distributor.rangesOf(address(wallet));
        assertEq(ranges[2].delivered, 0);
        assertEq(ranges[3].delivered, 0);
        (uint256 pendingNand, uint256 pendingLatch) = distributor.pendingOf(address(wallet));
        assertEq(pendingNand, 8);
        assertEq(pendingLatch, 6);
        // tx 3: retry of the same delivery at its planned bound: range 2 and part of range 3.
        wallet.setRefuse(false);
        uint256 g3 = _within(carol, address(distributor), abi.encodeCall(distributor.deliver, (address(wallet), 5)), _bound(2, 5));
        assertEq(distributor.nextRangeOf(address(wallet)), 3);
        ranges = distributor.rangesOf(address(wallet));
        assertEq(ranges[3].delivered, 4);
        assertEq(nandReceipt.holderOf(9), address(wallet));
        assertEq(nandReceipt.holderOf(10), address(distributor));
        // tx 4: the rest (3 NAND of the partly delivered range and 6 LATCH) in one delivery.
        uint256 g4 = _within(carol, address(distributor), abi.encodeCall(distributor.deliver, (address(wallet), 100)), _bound(2, 9));
        assertEq(distributor.nextRangeOf(address(wallet)), 5);
        (pendingNand, pendingLatch) = distributor.pendingOf(address(wallet));
        assertEq(pendingNand + pendingLatch, 0);
        for (uint256 id = 1; id <= 12; ++id) {
            assertEq(nandReceipt.holderOf(id), address(wallet));
        }
        for (uint256 id = 1; id <= 6; ++id) {
            assertEq(latchReceipt.holderOf(id), address(wallet));
        }
        (,, uint256[2] memory delivered) = distributor.totals();
        assertEq(delivered[0], 12);
        assertEq(delivered[1], 6);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(TapeoutReceiptDistributor.NothingToDeliver.selector, address(wallet)));
        distributor.deliver(address(wallet), 1);
        console2.log("deliver 4 / retry 5 / rest 9 gas used", g1, g3, g4);
    }

    function testLastIdAfterManyCompletedRangesIsDeliveredByAThirdPartyAtTheOneRangeBound() public {
        uint256 ranges = 60;
        issue(nandReceipt, address(distributor), ranges);
        issue(latchReceipt, address(distributor), 1);
        TapeoutReceiptDistributor.AllocationInput[] memory e =
            new TapeoutReceiptDistributor.AllocationInput[](ranges + 1);
        for (uint256 i; i < ranges; ++i) {
            e[i] = _entry(NAND, alice, uint64(i + 1), 1);
        }
        e[ranges] = _entry(LATCH, alice, 1, 1);
        vm.startPrank(operator);
        distributor.allocate(e);
        nandReceipt.finalizeIssuance();
        latchReceipt.finalizeIssuance();
        distributor.finalizeAllocation();
        vm.stopPrank();
        _within(alice, address(distributor), abi.encodeCall(distributor.claim, (ranges)), _bound(ranges, ranges));
        assertEq(distributor.nextRangeOf(alice), ranges);
        // An outsider pushes the last receipt; the completed ranges cost nothing.
        uint256 used = _within(bob, address(distributor), abi.encodeCall(distributor.deliver, (alice, 1)), _bound(1, 1));
        console2.log("last ID after 60 completed ranges, gas used / bound", used, _bound(1, 1));
        assertEq(latchReceipt.holderOf(1), alice);
        assertEq(distributor.nextRangeOf(alice), ranges + 1);
    }
}
