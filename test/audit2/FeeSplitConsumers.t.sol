// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {PoolMath} from "../../src/PoolMath.sol";

/// @notice Review-only test (candidate 8cf31dc), risk group 6: consumers of the changed return layouts.
///         `accrual()`, `previewAccrual()` and `reconciliation()` keep their selectors but gained fields
///         in the middle; a 2.0.0 decoder reads shifted values without any error.
contract FeeSplitConsumersTest is SystemTestBase {
    /// @dev The 2.0.0 layouts (c3cb933), as a stale consumer would declare them.
    struct OldAccrual {
        uint256 total;
        uint256 recipientA;
        uint256 recipientB;
        uint256 participants;
        uint256 nandIncome;
        uint256 latchIncome;
        uint256 perNandShare;
        uint256 perLatchShare;
        uint256 nandReceipts;
        uint256 latchReceipts;
        uint256 residue;
    }

    struct OldReconciliation {
        uint256 bemBalance;
        uint256 unrecognized;
        uint256 deficit;
        uint256 totalAccounted;
        uint256 totalPaid;
        uint256 recipientAAccrued;
        uint256 recipientAPaid;
        uint256 recipientBAccrued;
        uint256 recipientBPaid;
        uint256 nandIncome;
        uint256 nandReceiptsAccrued;
        uint256 nandReceiptsPaid;
        uint256 latchIncome;
        uint256 latchReceiptsAccrued;
        uint256 latchReceiptsPaid;
        uint256 residue;
    }

    function setUp() public override {
        super.setUp();
        setupStandard();
        admitNew(1, 3, 1);
        bem.mint(address(pool), 1_050);
        pool.sync(); // T = 1,050 raw: P = 1,000, A = B = 12, C = 25, NAND 750 (75 per ID), LATCH 250 (25 per ID)
        pool.releaseA(); // A 12 and C 25 paid
    }

    function testStaleAccrualDecoderReadsShiftedValuesSilently() public view {
        (bool ok, bytes memory data) = address(pool).staticcall(abi.encodeWithSignature("accrual()"));
        assertTrue(ok);
        assertEq(data.length, 12 * 32, "2.1.0 returns twelve words");
        OldAccrual memory old = abi.decode(data, (OldAccrual)); // eleven words consumed, no error
        PoolMath.Accrual memory a = abi.decode(data, (PoolMath.Accrual));
        assertEq(a.participants, 1_000);
        assertEq(a.sink, 25);
        // The stale decoder's "participants" is C, its "nandIncome" is the participants' total, and so on.
        assertEq(old.participants, a.sink, "stale participants = sink");
        assertEq(old.nandIncome, a.participants, "stale nandIncome = participants");
        assertEq(old.latchIncome, a.nandIncome);
        assertEq(old.perNandShare, a.latchIncome);
        assertEq(old.perLatchShare, a.perNandShare);
        assertEq(old.nandReceipts, a.perLatchShare);
        assertEq(old.latchReceipts, a.nandReceipts);
        assertEq(old.residue, a.latchReceipts, "stale residue = latch receipts (250, not 1)");
        assertEq(a.residue, 1);
    }

    function testStaleReconciliationDecoderMisreadsPaidAndIncomeFields() public view {
        (bool ok, bytes memory data) = address(pool).staticcall(abi.encodeWithSignature("reconciliation()"));
        assertTrue(ok);
        assertEq(data.length, 18 * 32);
        OldReconciliation memory old = abi.decode(data, (OldReconciliation));
        TapeoutMinerPool.Reconciliation memory r = abi.decode(data, (TapeoutMinerPool.Reconciliation));
        assertEq(r.sinkAccrued, 25);
        assertEq(r.sinkPaid, 25);
        assertEq(r.totalPaid, 37, "A 12 + C 25");
        // Fields 0-8 agree; from field 9 on the stale reader is two positions behind.
        assertEq(old.nandIncome, r.sinkAccrued, "stale nandIncome = sinkAccrued");
        assertEq(old.nandReceiptsAccrued, r.sinkPaid, "stale nandReceiptsAccrued = sinkPaid");
        assertEq(old.nandReceiptsPaid, r.nandIncome, "stale nandReceiptsPaid = nandIncome");
        assertEq(old.latchIncome, r.nandReceiptsAccrued);
        assertEq(old.latchReceiptsAccrued, r.nandReceiptsPaid);
        assertEq(old.latchReceiptsPaid, r.latchIncome);
        assertEq(old.residue, r.latchReceiptsAccrued, "stale residue = latchReceiptsAccrued (250, not 1)");
        // The 2.0.0 paid identity (A + B + NAND + LATCH paid = totalPaid) is false on the misread tuple:
        // 37 against 12 + 0 + 750 + 250. A stale reconciliation tool reports FAIL, a stale dashboard shows
        // wrong numbers; neither sees C.
        assertTrue(
            old.totalPaid != old.recipientAPaid + old.recipientBPaid + old.nandReceiptsPaid + old.latchReceiptsPaid,
            "stale paid identity breaks"
        );
    }

    function testReconciliationCoversEveryPaidAndOutstandingComponent() public {
        // More income, a claim (which syncs), B still unpaid, then unrecognized income: every bucket populated.
        bem.mint(address(pool), 84_083);
        claimAs(alice, range(1, 5), range(1, 5));
        bem.mint(address(pool), 8_400);
        TapeoutMinerPool.Reconciliation memory r = pool.reconciliation();
        assertEq(r.unrecognized, 8_400);
        assertEq(r.totalPaid, r.recipientAPaid + r.recipientBPaid + r.sinkPaid + r.nandReceiptsPaid + r.latchReceiptsPaid);
        uint256 outstanding = (r.recipientAAccrued - r.recipientAPaid) + (r.recipientBAccrued - r.recipientBPaid)
            + (r.sinkAccrued - r.sinkPaid) + (r.nandReceiptsAccrued - r.nandReceiptsPaid)
            + (r.latchReceiptsAccrued - r.latchReceiptsPaid);
        assertEq(r.bemBalance, outstanding + r.residue + r.unrecognized);
        assertGt(r.sinkAccrued - r.sinkPaid, 0, "C outstanding is visible");
        assertEq(pool.sinkClaimable(), pool.previewAccrual().sink - r.sinkPaid, "sinkClaimable includes the unrecognized part");
        assertGt(pool.sinkClaimable(), r.sinkAccrued - r.sinkPaid);
        assertEq(r.recipientAAccrued, r.totalAccounted / 84);
        assertEq(r.sinkAccrued, r.totalAccounted * 2 / 84);
        assertReconciled();
    }
}
