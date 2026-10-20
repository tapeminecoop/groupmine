// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PoolInvariantTest} from "./PoolInvariant.t.sol";

/// @dev Same campaign as PoolInvariantTest. With INVARIANT_COVERAGE_LOG set, every run appends its path
///      counters (admissions that succeeded, admissions that rolled back, registered miners) to that
///      file, so the report can show both admission paths were exercised, not only that the handler
///      was called. Without the variable it is just a second campaign of the same invariants.
contract PoolInvariantCoverageTest is PoolInvariantTest {
    function afterInvariant() external {
        string memory file = vm.envOr("INVARIANT_COVERAGE_LOG", string(""));
        if (bytes(file).length == 0) return;
        vm.writeLine(
            file,
            string.concat(
                vm.toString(handler.calls("admit")),
                ",",
                vm.toString(handler.calls("admitReverted")),
                ",",
                vm.toString(handler.registeredCount())
            )
        );
    }

    function invariantRecognizedTotalMatchesModel() public view {
        assertEq(pool.totalAccounted(), handler.gTotal());
    }
}
