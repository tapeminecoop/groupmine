// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SystemTestBase} from "../helpers/SystemTestBase.sol";

/// @notice Review finding P-01 (GPT review of f2c8e50): for repeated IDs the raw `claimableBatch` view
///         counts the same unpaid amount once per occurrence, while `claimBatch` pays it once. The pool is
///         unchanged in this remediation; the SDK/CLI claim inputs are sets per category
///         (sdk/pool.ts canonicalClaimIds). These tests pin the raw behaviour and show that the normalized
///         inputs give a preview equal to the payment in the same state.
///         Fixture from the review, with the income scaled to the 2.1.0 split (105,000 raw units under
///         80:1:1:2 of 84 give the participants the review's 100,000): ten receipts per category,
///         composition 3:1; NAND income 75,000, so NAND #1 has 7,500 due and LATCH #1 2,500.
contract ClaimPreviewTest is SystemTestBase {
    function setUp() public override {
        super.setUp();
        setupStandard(); // NAND 1..5 alice, 6..10 bob; LATCH 1..5 alice, 6..10 carol
        newMiner(1, 3, 1);
        admit(one(1));
        accrue(1, 105_000);
        pool.harvest(one(1));
        assertEq(pool.totalAccounted(), 105_000);
        assertEq(pool.claimable(NAND, 1), 7_500);
        assertEq(pool.claimable(LATCH, 1), 2_500);
    }

    function testRawViewCountsARepeatedIdTwiceButClaimBatchPaysItOnce() public {
        (uint256[] memory amounts, uint256 total) = pool.claimableBatch(NAND, two(1, 1));
        assertEq(amounts[0], 7_500);
        assertEq(amounts[1], 7_500);
        assertEq(total, 15_000, "raw view: the repeated ID is counted per occurrence");
        uint256 before = bem.balanceOf(alice);
        uint256 paid = claimAs(alice, two(1, 1), none());
        assertEq(paid, 7_500, "claimBatch pays the ID once");
        assertEq(bem.balanceOf(alice) - before, 7_500);
        assertEq(pool.claimed(NAND, 1), 7_500);
        assertEq(pool.claimable(NAND, 1), 0, "the second occurrence found nothing left");
        assertReconciled();
    }

    function testNormalizedInputsPreviewExactlyWhatIsPaidInTheSameState() public {
        // The SDK/CLI pass each ID once per category: the preview total equals the payment.
        (, uint256 previewNand) = pool.claimableBatch(NAND, one(1));
        (, uint256 previewLatch) = pool.claimableBatch(LATCH, one(1));
        uint256 before = bem.balanceOf(alice);
        uint256 paid = claimAs(alice, one(1), one(1));
        assertEq(paid, previewNand + previewLatch);
        assertEq(bem.balanceOf(alice) - before, 10_000);
        // NAND #1 and LATCH #1 are different receipts with independent histories.
        assertEq(pool.claimed(NAND, 1), 7_500);
        assertEq(pool.claimed(LATCH, 1), 2_500);
        assertReconciled();
    }

    function testRepeatedClaimLaterPaysNothingAndPreviewSaysSo() public {
        claimAs(alice, one(1), none());
        (, uint256 again) = pool.claimableBatch(NAND, one(1));
        assertEq(again, 0);
        assertEq(claimAs(alice, one(1), none()), 0);
    }
}
