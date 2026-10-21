// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {console2} from "forge-std/console2.sol";
import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";

/// @notice Review-only test (candidate 8cf31dc), risk group 6 (gas): releases as stand-alone cold
///         transactions with exactly the planned 300,000 bound (sdk/gas.ts CALL_GAS.releaseA/B), in
///         both orders, with first payments into an empty role and an empty sink, with a large
///         unrecognized inflow to synchronize, with the role due zero while C is due, and with A and B
///         aliased to one address.
/// forge-config: default.isolate = true
contract FeeSplitGasTest is SystemTestBase {
    address internal constant SINK = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant CALL_RELEASE = 300_000;

    function _calldataGas(bytes memory data) internal pure returns (uint256 gas) {
        for (uint256 i; i < data.length; ++i) {
            gas += data[i] == 0 ? 4 : 16;
        }
    }

    function _within(address from, address target, bytes memory data, uint256 bound) internal returns (uint256 used) {
        uint256 intrinsic = 21_000 + _calldataGas(data);
        vm.prank(from);
        uint256 before = gasleft();
        (bool ok, bytes memory result) = target.call{gas: bound - intrinsic}(data);
        used = before - gasleft();
        if (!ok) {
            if (result.length == 0) revert("release did not fit its planned gas limit");
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    function _release(bool a) internal returns (uint256 used) {
        return _within(carol, address(pool), a ? abi.encodeCall(pool.releaseA, ()) : abi.encodeCall(pool.releaseB, ()), CALL_RELEASE);
    }

    function setUp() public override {
        super.setUp();
        setupStandard();
        admitNew(1, 5, 5);
    }

    function testFirstPaymentsIntoEmptySinkAndRolesInBothOrders() public {
        bem.mint(address(pool), 10_000 * BEM_UNIT); // recognized by the release itself
        uint256 snapshot = vm.snapshotState();
        uint256 a1 = _release(true);
        bem.mint(address(pool), 7 * BEM_UNIT);
        uint256 b2 = _release(false);
        vm.revertToState(snapshot);
        uint256 b1 = _release(false);
        bem.mint(address(pool), 7 * BEM_UNIT);
        uint256 a2 = _release(true);
        console2.log("A first / B second", a1, b2);
        console2.log("B first / A second", b1, a2);
        assertLt(a1, CALL_RELEASE);
        assertLt(b1, CALL_RELEASE);
    }

    function testRoleDueZeroWithCDueAndAliasedRoles() public {
        bem.mint(address(pool), 84 * BEM_UNIT);
        _release(true);
        bem.mint(address(pool), 42); // role due 0, C due 1
        uint256 zeroRole = _release(true);
        assertEq(bem.balanceOf(SINK), 2 * BEM_UNIT + 1);
        vm.prank(recipientA);
        pool.setRecipient(TapeoutMinerPool.Recipient.A, recipientB);
        bem.mint(address(pool), 1_000 * BEM_UNIT);
        uint256 aliasedA = _release(true);
        uint256 aliasedB = _release(false);
        console2.log("role due zero, C due 1", zeroRole);
        console2.log("aliased A / B", aliasedA, aliasedB);
        assertReconciled();
    }
}
