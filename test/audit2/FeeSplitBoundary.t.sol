// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutEntitlementReceipt} from "../../src/TapeoutEntitlementReceipt.sol";
import {PoolMath} from "../../src/PoolMath.sol";

/// @notice Review-only test (candidate 8cf31dc), risk group 5: boundary and dust behaviour of the
///         84-part split on the live pool. Expected values are the specification's arithmetic written
///         here; the checkpoint policy is checked as documented, not "corrected".
contract FeeSplitBoundaryTest is SystemTestBase {
    address internal constant SINK = 0x000000000000000000000000000000000000dEaD;

    function _a(uint256 t) internal pure returns (uint256) {
        return t / 84;
    }

    function _c(uint256 t) internal pure returns (uint256) {
        return t * 2 / 84;
    }

    function _p(uint256 t) internal pure returns (uint256) {
        return t * 80 / 84;
    }

    /// @dev Every remainder modulo 84 at three magnitudes, on the live pool (S_N = S_L = 10, 1:1).
    function testEveryOuterRemainderOnTheLivePool() public {
        setupStandard();
        admitNew(1, 1, 1);
        uint256[3] memory bases = [uint256(0), 84, 84 * 1_000_000_000_000];
        uint256 total;
        for (uint256 b; b < 3; ++b) {
            for (uint256 r; r < 84; ++r) {
                uint256 target = bases[b] + r;
                if (target < total) continue;
                if (target > total) {
                    bem.mint(address(pool), target - total);
                    assertEq(pool.sync(), target - total);
                    total = target;
                }
                PoolMath.Accrual memory a = pool.accrual();
                assertEq(a.recipientA, _a(total), "A");
                assertEq(a.recipientB, _a(total), "B");
                assertEq(a.sink, _c(total), "C");
                assertEq(a.participants, _p(total), "P");
                uint256 outer = total - 2 * _a(total) - _c(total) - _p(total);
                assertLe(outer, 3, "outer floors leave at most 3");
                assertTrue((outer == 3) == (r >= 64), "exactly 3 for r = 64..83");
                assertLe(_p(total) - a.nandIncome - a.latchIncome, 1, "one participant unit at most");
                assertEq(a.residue, total - 2 * _a(total) - _c(total) - 10 * a.perNandShare - 10 * a.perLatchShare);
                assertLe(a.residue, 4 + 9 + 9);
                assertEq(pool.sinkClaimable(), _c(total), "C is its own floor, never the surplus");
            }
        }
        assertReconciled();
    }

    function testZeroAndMinimumIncomes() public {
        setupStandard();
        admitNew(1, 1, 1);
        assertEq(pool.releaseA(), 0);
        assertEq(bem.balanceOf(SINK), 0);
        bem.mint(address(pool), 1);
        assertEq(pool.releaseB(), 0);
        assertEq(bem.balanceOf(SINK), 0, "one raw unit: nothing is due to anyone");
        assertEq(pool.accrual().residue, 1);
        for (uint256 i = 2; i <= 42; ++i) {
            bem.mint(address(pool), 1);
        }
        assertEq(pool.releaseA(), 0);
        assertEq(bem.balanceOf(SINK), 1, "C's first unit at T = 42");
        assertReconciled();
    }

    function testCategoryWithoutReceiptsStillSplitsCAndTheRoles() public {
        issue(nandReceipt, alice, 4);
        finalizeIssuance(); // S_L = 0
        activate();
        assertEq(pool.latchShares(), 0);
        newMiner(1, 5, 0);
        accrue(1, 1_050);
        admit(one(1));
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.participants, 1_000);
        assertEq(a.nandIncome, 1_000);
        assertEq(a.latchIncome, 0);
        assertEq(a.recipientA, 12);
        assertEq(a.sink, 25);
        assertEq(a.perNandShare, 250);
        assertEq(a.residue, 1_050 - 24 - 25 - 1_000);
        assertLe(a.residue, 4 + 3);
        assertEq(pool.releaseA(), 12);
        assertEq(bem.balanceOf(SINK), 25);
        assertEq(claimAs(alice, range(1, 4), none()), 1_000);
        assertReconciled();
    }

    function testSameRatioCheckpointKeepsTheDocumentedPolicy() public {
        setupStandard();
        admitNew(1, 3, 1);
        bem.mint(address(pool), 45); // P = 42: NAND floor(31.5) = 31, LATCH floor(10.5) = 10, one unit carried
        pool.sync();
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.nandIncome, 31);
        assertEq(a.latchIncome, 10);
        admitNew(2, 3, 1); // the same 3:1 ratio: bases freeze at 31 / 10, participantBase 41
        assertEq(pool.nandBase(), 31);
        assertEq(pool.latchBase(), 10);
        assertEq(pool.participantBase(), 41);
        bem.mint(address(pool), 45); // T = 90, P = 85, d = 85 - 41 = 44 -> NAND 31 + 33, LATCH 10 + 11
        pool.sync();
        a = pool.accrual();
        assertEq(a.nandIncome, 64, "documented checkpoint policy");
        assertEq(a.latchIncome, 21);
        // Without the checkpoint one period would have given floor(85 * 3 / 4) = 63 and 21: the policy
        // shifts the carried unit, and docs/ACCOUNTING.md states it is pending the owner's acceptance.
        assertEq(_p(90) * 3 / 4, 63);
        assertEq(a.sink, _c(90), "C is unaffected by composition or checkpoints");
        assertReconciled();
    }

    function testCDoesNotDependOnTheComposition() public {
        setupStandard();
        uint256 snapshot = vm.snapshotState();
        admitNew(1, 9, 1);
        bem.mint(address(pool), 1_234_567);
        pool.sync();
        uint256 cNine = pool.accrual().sink;
        vm.revertToState(snapshot);
        admitNew(1, 1, 9);
        bem.mint(address(pool), 1_234_567);
        pool.sync();
        assertEq(pool.accrual().sink, cNine);
        assertEq(cNine, _c(1_234_567));
    }

    function testLargeSupportedTotals() public {
        setupStandard();
        admitNew(1, 7, 3);
        uint256 maxBem = 2_100_000_000_000_000; // BEM's MAX_SUPPLY (21,000,000 BEM in raw units), read on chain
        bem.mint(address(pool), maxBem);
        pool.sync();
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.recipientA, maxBem / 84);
        assertEq(a.sink, maxBem * 2 / 84);
        assertEq(a.participants, maxBem * 80 / 84);
        assertEq(a.recipientA + a.recipientB + a.sink + a.nandReceipts + a.latchReceipts + a.residue, maxBem);
        assertEq(pool.releaseA(), maxBem / 84);
        assertEq(bem.balanceOf(SINK), maxBem * 2 / 84);
        // Far beyond any reachable amount the arithmetic still holds (no overflow below 2^256 / 80).
        uint256 huge = 10 ** 60;
        PoolMath.Accrual memory big = PoolMath.accrue(huge, pool.state());
        assertEq(big.sink, huge * 2 / 84);
        assertEq(big.recipientA + big.recipientB + big.sink + big.nandReceipts + big.latchReceipts + big.residue, huge);
        assertReconciled();
    }

    /// @notice Documentation check (docs/FEE_SPLIT_CHANGE_REPORT.md section 3 says claims do not accrue C):
    ///         a claim runs _sync and can recognize held BEM, so it accrues C; it never pays it.
    function testClaimsAccrueCByRecognizingHeldIncomeButNeverPayIt() public {
        setupStandard();
        admitNew(1, 1, 1);
        bem.mint(address(pool), 84_000); // unrecognized until something syncs
        assertEq(pool.sinkPaid(), 0);
        uint256 accruedBefore = pool.accrual().sink;
        assertEq(accruedBefore, 0);
        vm.prank(alice);
        pool.claim(NAND, 1);
        assertEq(pool.totalAccounted(), 84_000, "the claim recognized the held BEM");
        assertEq(pool.accrual().sink, 2_000, "and so C accrued");
        assertEq(bem.balanceOf(SINK), 0, "without being paid");
        assertEq(pool.sinkPaid(), 0);
        assertReconciled();
    }
}
