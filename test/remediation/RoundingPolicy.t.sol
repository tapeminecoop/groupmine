// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {PoolMath} from "../../src/PoolMath.sol";

/// @notice Rounding-policy qualification from the GPT review of f2c8e50 (section 4.5), documented, not
///         changed. Each admission checkpoint freezes whole-unit category totals and carries only the one
///         unassigned participant unit, not each category's fractional remainder. So admissions that keep
///         the same NAND:LATCH ratio can still change lifetime category totals, while the unassigned
///         residue stays within its bound. Example: one receipt per category, a 1:2 miner, 3 raw units,
///         then seven periods of one unit each, a zero-carry 1:2 miner admitted between periods.
contract RoundingPolicyTest is SystemTestBase {
    function setUp() public override {
        super.setUp();
        issue(nandReceipt, alice, 1);
        issue(latchReceipt, bob, 1);
        finalizeIssuance();
        activate(); // S_N = S_L = 1: no per-ID division dust
    }

    function _income(uint256 units) internal {
        accrue(1, units);
        pool.harvest(one(1));
    }

    function testSameRatioCheckpointsChangeLifetimeCategoryTotals() public {
        newMiner(1, 1, 2);
        admit(one(1));
        _income(3); // T = 3: P = 2 -> NAND 0, LATCH 1, one participant unit unassigned
        for (uint256 i; i < 7; ++i) {
            newMiner(10 + i, 1, 2);
            admit(one(10 + i)); // checkpoint; the ratio stays 1:2
            _income(1);
        }
        assertEq(pool.totalAccounted(), 10);
        assertEq(pool.totalNandBurn() * 2, pool.totalLatchBurn(), "ratio 1:2 throughout");
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.nandIncome, 0, "checkpointed NAND total");
        assertEq(a.latchIncome, 8, "checkpointed LATCH total");
        assertEq(pool.reconciliation().residue, 2);
        assertEq(pool.claimable(NAND, 1), 0);
        assertEq(pool.claimable(LATCH, 1), 8);
        assertReconciled(); // conservation and the residue bound hold
    }

    function testTheSameIncomeWithoutCheckpoints() public {
        newMiner(1, 1, 2);
        admit(one(1));
        _income(10); // T = 10 in one period: P = 9 -> NAND 3, LATCH 6
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.nandIncome, 3);
        assertEq(a.latchIncome, 6);
        assertEq(pool.reconciliation().residue, 1);
        assertReconciled();
    }
}
