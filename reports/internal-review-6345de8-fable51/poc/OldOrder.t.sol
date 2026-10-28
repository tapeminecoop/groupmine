// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {PoolMath} from "../../src/PoolMath.sol";

/// @notice Review-only (Fable 5.1): the SALUS #2 counterexample executed on the pre-remediation 2.1.0
///         code (c78a6d1). Equal actual carry inputs (X 10:0 carries 105 BEM, Y 5:5 carries 105 BEM),
///         no intervening accrual. Prints the category incomes for X then Y, Y then X, and one batch.
contract OldOrderTest is SystemTestBase {
    function _run(uint256 variant) internal returns (uint256 nand, uint256 latch) {
        uint256 snap = vm.snapshotState();
        newMiner(1, 10, 0);
        newMiner(2, 5, 5);
        accrue(1, 105 * BEM_UNIT);
        accrue(2, 105 * BEM_UNIT);
        if (variant == 0) { admit(one(1)); admit(one(2)); }
        else if (variant == 1) { admit(one(2)); admit(one(1)); }
        else admit(two(1, 2));
        PoolMath.Accrual memory a = pool.accrual();
        (nand, latch) = (a.nandIncome, a.latchIncome);
        vm.revertToState(snap);
    }

    function testOldRuleIsOrderDependent() public {
        setupStandard();
        (uint256 n0, uint256 l0) = _run(0);
        (uint256 n1, uint256 l1) = _run(1);
        (uint256 n2, uint256 l2) = _run(2);
        emit log_named_uint("2.1.0 X then Y: NAND", n0); emit log_named_uint("2.1.0 X then Y: LATCH", l0);
        emit log_named_uint("2.1.0 Y then X: NAND", n1); emit log_named_uint("2.1.0 Y then X: LATCH", l1);
        emit log_named_uint("2.1.0 batch {X,Y}: NAND", n2); emit log_named_uint("2.1.0 batch {X,Y}: LATCH", l2);
        assertTrue(n0 != n1, "2.1.0 depends on the admission order");
    }
}
