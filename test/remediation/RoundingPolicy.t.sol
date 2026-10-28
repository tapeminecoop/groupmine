// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {PoolMath} from "../../src/PoolMath.sol";

/// @notice Rounding-policy qualification from the GPT review of f2c8e50 (section 4.5). Under 2.1.0 each
///         admission checkpoint froze whole-unit category totals and carried only the one unassigned
///         participant unit, so same-ratio admissions changed lifetime category totals (this example gave
///         NAND 0, LATCH 8 with checkpoints against NAND 3, LATCH 6 without). 2.2.0 (SALUS remediation)
///         keeps every category's fraction in the ledger across checkpoints, so the two runs agree; this
///         file now asserts that. Example: one receipt per category, a 1:2 miner, 3 raw units, then seven
///         periods of one unit each, a zero-carry 1:2 miner admitted between periods.
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
        _income(3); // T = 3: exact shares of 2.857: NAND 0.95, LATCH 1.90
        for (uint256 i; i < 7; ++i) {
            newMiner(10 + i, 1, 2);
            admit(one(10 + i)); // checkpoint; the ratio stays 1:2
            _income(1);
        }
        assertEq(pool.totalAccounted(), 10);
        assertEq(pool.totalNandBurn() * 2, pool.totalLatchBurn(), "ratio 1:2 throughout");
        assertEq(pool.compositionPeriod(), 8);
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.nandIncome, 3, "checkpointed NAND total equals the one-period total");
        assertEq(a.latchIncome, 6, "checkpointed LATCH total equals the one-period total");
        assertEq(pool.reconciliation().residue, 1);
        assertEq(pool.claimable(NAND, 1), 3);
        assertEq(pool.claimable(LATCH, 1), 6);
        // The ledger keeps the fractions: exactly 10 * 80 * 10^18 units, NAND short of a third only by the
        // eight per-period ledger floors (under 10^-17 raw units in all).
        PoolMath.State memory s = pool.ledgerState();
        assertEq(s.nandBase + s.latchBase, s.accountedBase * 80 * 1e18, "boundary identity");
        (uint256 nandUnits, uint256 latchUnits) = PoolMath.categoryUnits(pool.totalAccounted(), s);
        assertEq(nandUnits + latchUnits, 10 * 80 * 1e18);
        assertLe(nandUnits * 3, 10 * 80 * 1e18);
        assertGe(nandUnits * 3 + 3 * 8, 10 * 80 * 1e18);
        assertReconciled(); // conservation and the residue bound hold
    }

    function testTheSameIncomeWithoutCheckpoints() public {
        newMiner(1, 1, 2);
        admit(one(1));
        _income(10); // T = 10 in one period: exact shares of 9.52: NAND 3.17, LATCH 6.35
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.nandIncome, 3);
        assertEq(a.latchIncome, 6);
        assertEq(pool.reconciliation().residue, 1);
        assertReconciled();
    }
}
