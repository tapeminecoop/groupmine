// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {PoolMath} from "../../src/PoolMath.sol";

/// @notice SALUS finding #2 ("Admission ordering allows depositors to influence reward allocation"),
///         fixed in 2.2.0: an incoming miner's carried income (what its own Mining.claim pays during the
///         admission) is attributed by that miner's own NAND : LATCH burn; income earned in the pool
///         afterwards is split by the aggregate composition. Expected values are the specification's
///         arithmetic written here (80/84 of each carried amount, split n : l), never PoolMath's output.
///         S_N = S_L = 10 (alice NAND 1-5, bob NAND 6-10, alice LATCH 1-5, carol LATCH 6-10).
contract SalusCarriedIncomeTest is SystemTestBase {
    uint256 internal constant BEM_105 = 105 * BEM_UNIT;
    uint256 internal constant UNITS = 80 * 1e18; // ledger units per raw unit of the participants' share
    uint256 internal constant LEDGER_UNIT = 84 * 1e18; // ledger units per raw BEM unit
    address internal constant SINK = 0x000000000000000000000000000000000000dEaD;

    function setUp() public override {
        super.setUp();
        setupStandard();
    }

    /// @dev The economic state an admission order must not change (the period counter and registry
    ///      order are bookkeeping and may differ).
    function _economics() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                pool.accrual(),
                pool.ledgerState(),
                pool.carriedIncome(),
                pool.carriedNandUnits(),
                pool.totalNandBurn(),
                pool.totalLatchBurn(),
                pool.reconciliation()
            )
        );
    }

    function three(uint256 x, uint256 y, uint256 z) internal pure returns (uint256[] memory r) {
        r = new uint256[](3);
        (r[0], r[1], r[2]) = (x, y, z);
    }

    // ---------------------------------------------------------------------- single miners

    function testSingleNandOnlyMiner() public {
        admitNew(1, 7, 1); // an old miner with nothing to settle
        newMiner(2, 10, 0);
        accrue(2, BEM_105);
        admit(one(2));
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.nandIncome, 100 * BEM_UNIT);
        assertEq(a.latchIncome, 0, "a NAND-only miner carries nothing to LATCH, whatever the pool's 17:1");
        assertEq(pool.carriedNandUnits(), BEM_105 * UNITS);
        assertReconciled();
    }

    function testSingleLatchOnlyMiner() public {
        admitNew(1, 7, 1);
        newMiner(2, 0, 7);
        accrue(2, BEM_105);
        admit(one(2));
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.nandIncome, 0);
        assertEq(a.latchIncome, 100 * BEM_UNIT);
        assertEq(pool.carriedNandUnits(), 0);
        assertReconciled();
    }

    function testSingleMixedMiner() public {
        admitNew(1, 1, 0);
        newMiner(2, 3, 7);
        accrue(2, BEM_105);
        admit(one(2));
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.nandIncome, 30 * BEM_UNIT);
        assertEq(a.latchIncome, 70 * BEM_UNIT);
        assertReconciled();
    }

    // ---------------------------------------------------------------------- the SALUS example

    /// @notice X: 10 NAND / 0 LATCH carrying 105 BEM; Y: 5 / 5 carrying 105 BEM. NAND 150, LATCH 50 in
    ///         every order and batching; afterwards new income goes 15 : 5. (Under 2.1.0: 175 / 25 when X
    ///         came first, 125 / 75 when Y did.)
    function testSalusExampleIsIndependentOfAdmissionOrder() public {
        newMiner(1, 10, 0); // X
        newMiner(2, 5, 5); // Y
        accrue(1, BEM_105);
        accrue(2, BEM_105);
        uint256 snapshot = vm.snapshotState();

        bytes32[4] memory outcomes;
        uint256[4] memory nand;
        uint256[4] memory latch;
        for (uint256 order; order < 4; ++order) {
            vm.revertToState(snapshot);
            if (order == 0) {
                admit(one(1));
                admit(one(2));
            } else if (order == 1) {
                admit(one(2));
                admit(one(1));
            } else if (order == 2) {
                admit(two(1, 2));
            } else {
                admit(two(2, 1));
            }
            outcomes[order] = _economics();
            nand[order] = pool.accrual().nandIncome;
            latch[order] = pool.accrual().latchIncome;
            assertEq(nand[order], 150 * BEM_UNIT, "NAND 100 + 50");
            assertEq(latch[order], 50 * BEM_UNIT, "LATCH 0 + 50");
            assertTrue(nand[order] != 175 * BEM_UNIT && nand[order] != 125 * BEM_UNIT, "no 2.1.0 outcome");
            assertEq(pool.totalNandBurn(), 15);
            assertEq(pool.totalLatchBurn(), 5);
        }
        assertEq(outcomes[0], outcomes[1], "X then Y == Y then X");
        assertEq(outcomes[0], outcomes[2], "sequential == one batch");
        assertEq(outcomes[2], outcomes[3], "batch order");

        // Ordinary income after both admissions follows the aggregate 15 : 5.
        accrue(1, BEM_105);
        pool.harvestRange(0, 2);
        assertEq(pool.accrual().nandIncome, 150 * BEM_UNIT + 75 * BEM_UNIT);
        assertEq(pool.accrual().latchIncome, 50 * BEM_UNIT + 25 * BEM_UNIT);
        assertReconciled();
    }

    // ---------------------------------------------------------------------- order and partition

    function _prepareOddMiners() internal {
        newMiner(1, 11, 2);
        newMiner(2, 3, 17);
        newMiner(3, 1, 1);
        newMiner(4, 0, 9);
        accrue(1, 977_777);
        mining.accrueUnsettled(address(nft), 2, 333_331); // pending() shows 0 for this one
        accrue(3, 123_457);
        accrue(4, 1);
    }

    function testReversedBatchOrderGivesTheSameLedger() public {
        admitNew(10, 7, 3);
        accrue(10, 555_555); // an old miner to settle at the boundary
        _prepareOddMiners();
        uint256 snapshot = vm.snapshotState();
        uint256[] memory forward = new uint256[](4);
        (forward[0], forward[1], forward[2], forward[3]) = (1, 2, 3, 4);
        admit(forward);
        bytes32 a = _economics();
        vm.revertToState(snapshot);
        uint256[] memory backward = new uint256[](4);
        (backward[0], backward[1], backward[2], backward[3]) = (4, 3, 2, 1);
        admit(backward);
        assertEq(_economics(), a, "reversed batch");
        vm.revertToState(snapshot);
        uint256[] memory mixed = new uint256[](4);
        (mixed[0], mixed[1], mixed[2], mixed[3]) = (3, 1, 4, 2);
        admit(mixed);
        assertEq(_economics(), a, "shuffled batch");
    }

    /// @notice Separate sequential admissions of the same miners with no intervening accrual give the
    ///         same ledger as one batch, at raw precision, in either order.
    function testReversedSequentialOrderAndBatchGiveTheSameLedger() public {
        admitNew(10, 7, 3);
        accrue(10, 555_555);
        _prepareOddMiners();
        uint256 snapshot = vm.snapshotState();
        uint256[] memory all = new uint256[](4);
        (all[0], all[1], all[2], all[3]) = (1, 2, 3, 4);
        admit(all);
        bytes32 batch = _economics();
        vm.revertToState(snapshot);
        for (uint256 id = 1; id <= 4; ++id) {
            admit(one(id));
        }
        assertEq(_economics(), batch, "sequential 1, 2, 3, 4");
        vm.revertToState(snapshot);
        for (uint256 id = 4; id >= 1; --id) {
            admit(one(id));
        }
        assertEq(_economics(), batch, "sequential 4, 3, 2, 1");
        vm.revertToState(snapshot);
        admit(two(2, 4));
        admit(two(3, 1));
        assertEq(_economics(), batch, "two batches");
    }

    /// @dev Any set of miners, admitted as one batch, reversed, one by one in a seed-dependent order, or
    ///      split into two batches: the economic state is identical. Expected carried units come from
    ///      the specification (80/84 of each carried amount, NAND floor, LATCH the rest).
    function testFuzzCarriedAttributionIsIndependentOfOrderAndPartition(
        uint32[5] memory nands,
        uint32[5] memory latches,
        uint64[5] memory carried,
        uint8 count,
        uint256 seed
    ) public {
        uint256 k = bound(count, 1, 5);
        admitNew(100, 5, 3);
        accrue(100, uint256(carried[0]) + 1); // something to settle at each first boundary
        uint256[] memory ids = new uint256[](k);
        uint256 expectNandUnits;
        uint256 expectCarried;
        for (uint256 i; i < k; ++i) {
            uint32 n = uint32(bound(nands[i], 0, 1_000_000));
            uint32 l = uint32(bound(latches[i], 0, 1_000_000));
            if (n + l == 0) n = 1;
            ids[i] = i + 1;
            newMiner(ids[i], n, l);
            if (seed & (1 << i) != 0) mining.accrueUnsettled(address(nft), ids[i], carried[i]);
            else accrue(ids[i], carried[i]);
            expectNandUnits += uint256(carried[i]) * UNITS * n / (uint256(n) + l);
            expectCarried += carried[i];
        }
        uint256 snapshot = vm.snapshotState();
        admit(ids);
        bytes32 expected = _economics();
        assertEq(pool.carriedIncome(), expectCarried);
        assertEq(pool.carriedNandUnits(), expectNandUnits, "carried NAND units: the specification's sum");
        assertReconciled();
        // Reversed batch.
        vm.revertToState(snapshot);
        uint256[] memory reversed = new uint256[](k);
        for (uint256 i; i < k; ++i) {
            reversed[i] = ids[k - 1 - i];
        }
        admit(reversed);
        assertEq(_economics(), expected, "reversed batch");
        // One by one, in a seed-dependent permutation.
        vm.revertToState(snapshot);
        uint256[] memory order = new uint256[](k);
        for (uint256 i; i < k; ++i) {
            order[i] = ids[i];
        }
        for (uint256 i = k; i > 1; --i) {
            uint256 j = uint256(keccak256(abi.encode(seed, i))) % i;
            (order[i - 1], order[j]) = (order[j], order[i - 1]);
        }
        for (uint256 i; i < k; ++i) {
            admit(one(order[i]));
        }
        assertEq(_economics(), expected, "sequential permutation");
        // Two batches.
        if (k > 1) {
            vm.revertToState(snapshot);
            uint256 cut = 1 + seed % (k - 1);
            uint256[] memory first = new uint256[](cut);
            uint256[] memory second = new uint256[](k - cut);
            for (uint256 i; i < k; ++i) {
                if (i < cut) first[i] = order[i];
                else second[i - cut] = order[i];
            }
            admit(first);
            admit(second);
            assertEq(_economics(), expected, "two batches");
        }
    }

    // ---------------------------------------------------------------------- amounts

    function testZeroCarriedIncome() public {
        admitNew(1, 2, 2);
        accrue(1, BEM_105);
        newMiner(2, 9, 0);
        vm.recordLogs();
        (uint256 settled, uint256 carried) = admit(one(2));
        assertEq(settled, BEM_105);
        assertEq(carried, 0);
        assertEq(pool.miner(2).carriedIncome, 0);
        assertEq(pool.carriedIncome(), 0);
        assertEq(pool.accrual().nandIncome, 50 * BEM_UNIT, "only the old miner's income, at 2:2");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 attributed;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == TapeoutMinerPool.CarriedIncomeAttributed.selector) {
                (uint256 received, uint256 nandUnits, uint256 latchUnits) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256));
                assertEq(received + nandUnits + latchUnits, 0);
                ++attributed;
            }
        }
        assertEq(attributed, 1, "a zero attribution is still recorded");
        assertReconciled();
    }

    function testPositiveCarriedIncomeIsRecordedPerMinerWithItsUnits() public {
        newMiner(1, 2, 1);
        newMiner(2, 1, 3);
        accrue(1, 2_100);
        accrue(2, 8_400);
        vm.recordLogs();
        admit(two(1, 2));
        assertEq(pool.miner(1).carriedIncome, 2_100);
        assertEq(pool.miner(2).carriedIncome, 8_400);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != TapeoutMinerPool.CarriedIncomeAttributed.selector) continue;
            uint256 id = uint256(logs[i].topics[1]);
            (uint256 received, uint256 nandUnits, uint256 latchUnits) =
                abi.decode(logs[i].data, (uint256, uint256, uint256));
            if (id == 1) {
                assertEq(received, 2_100);
                assertEq(nandUnits, 2_100 * UNITS * 2 / 3); // 1,333.33 raw units of the 2,000 share
                assertEq(latchUnits, 2_100 * UNITS - 2_100 * UNITS * 2 / 3); // 666.67
            } else {
                assertEq(id, 2);
                assertEq(nandUnits, 8_400 * UNITS / 4); // 2,000 raw units
                assertEq(latchUnits, 8_400 * UNITS * 3 / 4); // 6,000 raw units
            }
            ++seen;
        }
        assertEq(seen, 2);
        assertEq(pool.accrual().nandIncome, 3_333); // 1,333.33 + 2,000
        assertEq(pool.accrual().latchIncome, 6_666); // 666.67 + 6,000
    }

    function testPendingZeroButPositiveClaimIsAttributedByTheActualBalanceDelta() public {
        admitNew(1, 1, 1);
        newMiner(2, 0, 4);
        mining.accrueUnsettled(address(nft), 2, BEM_105);
        assertEq(mining.pending(mining.minerKey(address(nft), 2)), 0, "pending() shows nothing");
        (, uint256 carried) = admit(one(2));
        assertEq(carried, BEM_105, "the claim paid it anyway, and the pool counted what it received");
        assertEq(pool.accrual().latchIncome, 100 * BEM_UNIT);
        assertEq(pool.accrual().nandIncome, 0);
    }

    /// @notice 21 miners each carrying a single raw unit at 1:1: each adds 40 * 10^18 units to each
    ///         category (0.476 raw units). Whole units appear only in the sum (10 + 10), identically in one
    ///         batch and one by one; independent per-miner floors would have given 0 / 0.
    function testVerySmallRawAmountsAccumulateExactly() public {
        admitNew(100, 1, 1);
        uint256[] memory ids = new uint256[](21);
        for (uint256 i; i < 21; ++i) {
            ids[i] = i + 1;
            newMiner(ids[i], 1, 1);
            accrue(ids[i], 1);
        }
        uint256 snapshot = vm.snapshotState();
        admit(ids);
        assertEq(pool.accrual().nandIncome, 10);
        assertEq(pool.accrual().latchIncome, 10);
        assertEq(pool.carriedNandUnits(), 21 * 40 * 1e18);
        bytes32 batch = _economics();
        vm.revertToState(snapshot);
        for (uint256 i; i < 21; ++i) {
            admit(one(ids[i]));
        }
        assertEq(_economics(), batch);
        assertEq(pool.accrual().nandIncome, 10);
        assertEq(pool.accrual().latchIncome, 10);
        assertReconciled();
    }

    /// @notice Fractional boundaries: two 1:2 miners carrying 21 raw units each (20 raw units of
    ///         participants' share each). NAND is floor(40/3) = 13 and LATCH floor(80/3) = 26 together,
    ///         not 6 + 6 and 13 + 13 from separate floors; one raw unit stays unassigned (residue).
    function testFractionalAllocationAndRoundingBoundaries() public {
        admitNew(100, 1, 2);
        newMiner(1, 1, 2);
        newMiner(2, 1, 2);
        accrue(1, 21);
        accrue(2, 21);
        admit(one(1));
        assertEq(pool.accrual().nandIncome, 6); // 6.67
        assertEq(pool.accrual().latchIncome, 13); // 13.33
        admit(one(2));
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.participants, 40);
        assertEq(a.nandIncome, 13);
        assertEq(a.latchIncome, 26);
        assertEq(a.participants - a.nandIncome - a.latchIncome, 1);
        PoolMath.State memory s = pool.ledgerState();
        assertEq(s.nandBase, 2 * (21 * UNITS / 3));
        assertEq(s.latchBase, 2 * (21 * UNITS - 21 * UNITS / 3));
        // Each category stays within one raw unit of its exact share (40/3 and 80/3).
        assertLe(a.nandIncome * 3, 40);
        assertGt((a.nandIncome + 1) * 3, 40);
        assertLe(a.latchIncome * 3, 80);
        assertGt((a.latchIncome + 1) * 3, 80);
        assertReconciled();
    }

    // ---------------------------------------------------------------------- boundary inputs

    function testExistingPoolIncomeBeforeAdmissionStaysWithTheOldComposition() public {
        admitNew(1, 10, 0);
        bem.mint(address(pool), BEM_105); // held, not recognized yet
        newMiner(2, 0, 10);
        accrue(2, BEM_105);
        admit(one(2));
        assertEq(pool.accrual().nandIncome, 100 * BEM_UNIT, "held income: old composition, all NAND");
        assertEq(pool.accrual().latchIncome, 100 * BEM_UNIT, "carried income: the miner's own burn");
        assertEq(pool.carriedIncome(), BEM_105);
    }

    /// @notice Three old miners with different burns and income (one hidden from pending()) are all
    ///         settled under the old 6:6 composition before the incoming miner's carried income.
    function testMultipleExistingMinersSettleStrictlyUnderTheOldComposition() public {
        newMiner(1, 1, 0);
        newMiner(2, 0, 1);
        newMiner(3, 5, 5);
        admit(three(1, 2, 3));
        accrue(1, BEM_105);
        mining.accrueUnsettled(address(nft), 2, BEM_105);
        accrue(3, 2 * BEM_105);
        newMiner(4, 3, 1);
        accrue(4, BEM_105);
        (uint256 settled, uint256 carried) = admit(one(4));
        assertEq(settled, 4 * BEM_105, "every registered miner claimed, pending() or not");
        assertEq(carried, BEM_105);
        // Old: 400 participants' BEM at 6:6 -> 200 / 200. Carried: 100 at 3:1 -> 75 / 25.
        assertEq(pool.accrual().nandIncome, 275 * BEM_UNIT);
        assertEq(pool.accrual().latchIncome, 225 * BEM_UNIT);
        assertEq(mining.claimCount(mining.minerKey(address(nft), 1)), 2, "admission claim + this boundary");
        assertReconciled();
    }

    function testIncomingClaimFailureRollsBackTheCarriedAttribution() public {
        admitNew(1, 1, 1);
        accrue(1, BEM_105);
        newMiner(2, 1, 0);
        newMiner(3, 0, 1);
        accrue(2, BEM_105);
        accrue(3, BEM_105);
        mining.setKeyBroken(address(nft), 3, true);
        bytes32 before = _economics();
        vm.startPrank(depositor);
        nft.setApprovalForAll(address(pool), true);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "MINER_BROKEN"));
        pool.depositMiners(two(2, 3));
        vm.stopPrank();
        assertEq(_economics(), before);
        assertEq(pool.miner(2).carriedIncome, 0);
        assertFalse(pool.miner(2).registered);
    }

    // ---------------------------------------------------------------------- receipts and payouts

    function testReceiptTransfersBeforeAndAfterAdmissionAndNoDoublePayment() public {
        vm.prank(alice);
        nandReceipt.safeTransferFrom(alice, dave, 1, 1, ""); // before any income
        newMiner(1, 10, 0);
        accrue(1, BEM_105); // 100 participants' BEM, all NAND: 10 BEM per NAND receipt
        admit(one(1));
        assertEq(pool.claimable(NAND, 1), 10 * BEM_UNIT);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, NAND, 1));
        pool.claim(NAND, 1);
        vm.prank(dave);
        assertEq(pool.claim(NAND, 1), 10 * BEM_UNIT);
        vm.prank(dave);
        assertEq(pool.claim(NAND, 1), 0, "claimed once");
        vm.prank(dave);
        nandReceipt.safeTransferFrom(dave, carol, 1, 1, ""); // after the claim: history stays with the ID
        assertEq(pool.claimable(NAND, 1), 0);
        newMiner(2, 0, 10);
        accrue(2, BEM_105); // carried, all LATCH: NAND receipts gain nothing
        admit(one(2));
        assertEq(pool.claimable(NAND, 1), 0);
        assertEq(pool.claimable(LATCH, 1), 10 * BEM_UNIT);
        accrue(1, BEM_105); // ordinary income at 10:10
        pool.harvestRange(0, 2);
        assertEq(pool.claimable(NAND, 1), 5 * BEM_UNIT);
        vm.prank(carol);
        assertEq(pool.claim(NAND, 1), 5 * BEM_UNIT);
        assertEq(pool.claimed(NAND, 1), 15 * BEM_UNIT, "paid history keyed to category and ID");
        assertEq(bem.balanceOf(dave) + bem.balanceOf(carol), 15 * BEM_UNIT);
        assertReconciled();
    }

    function testABAndSinkAccrueOnCarriedIncomeAndSettleOnRelease() public {
        newMiner(1, 1, 1);
        accrue(1, 1_050);
        admit(one(1));
        newMiner(2, 2, 0);
        accrue(2, 83);
        admit(one(2)); // T = 1,133
        uint256 t = 1_133;
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.recipientA, t / 84);
        assertEq(a.recipientB, t / 84);
        assertEq(a.sink, t * 2 / 84);
        assertEq(a.participants, t * 80 / 84);
        assertEq(bem.balanceOf(SINK), 0, "admissions accrue C, never pay it");
        assertEq(pool.releaseB(), t / 84);
        assertEq(bem.balanceOf(SINK), t * 2 / 84, "C settled with B's release");
        assertEq(pool.releaseA(), t / 84);
        assertEq(bem.balanceOf(SINK), t * 2 / 84, "and only once");
        assertEq(pool.releaseA(), 0);
        assertReconciled();
    }

    /// @notice All five revenue accounts reconciled against independently computed values after a mixed
    ///         sequence of carried and ordinary income, claims, transfers and releases.
    function testFiveRevenueAccountsReconcileIndependently() public {
        newMiner(1, 3, 1);
        accrue(1, 840_000);
        admit(one(1)); // carried 800,000: NAND 600,000, LATCH 200,000
        accrue(1, 84_000); // ordinary, at 3:1: NAND 60,000, LATCH 20,000
        newMiner(2, 1, 4);
        accrue(2, 168_000); // carried 160,000 at 1:4: NAND 32,000, LATCH 128,000
        admit(one(2)); // settles the 84,000 first
        accrue(2, 42_000); // ordinary, at 4:5 -> 40,000 participants: NAND 17,777.8, LATCH 22,222.2
        pool.harvestRange(0, 2);
        uint256 t = 840_000 + 84_000 + 168_000 + 42_000;
        uint256 nand = 600_000 + 60_000 + 32_000 + 17_777; // exact share 709,777.78
        uint256 latch = 200_000 + 20_000 + 128_000 + 22_222; // exact share 370,222.22
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.total, t);
        assertEq(a.nandIncome, nand);
        assertEq(a.latchIncome, latch);
        claimAs(alice, range(1, 5), range(1, 5));
        vm.prank(bob);
        nandReceipt.safeTransferFrom(bob, dave, 6, 1, "");
        claimAs(dave, one(6), none());
        pool.releaseA();
        TapeoutMinerPool.Reconciliation memory r = pool.reconciliation();
        assertEq(r.recipientAAccrued, t / 84);
        assertEq(r.recipientBAccrued, t / 84);
        assertEq(r.sinkAccrued, t * 2 / 84);
        assertEq(r.nandReceiptsAccrued, nand / 10 * 10);
        assertEq(r.latchReceiptsAccrued, latch / 10 * 10);
        assertEq(r.recipientAPaid, t / 84);
        assertEq(r.recipientBPaid, 0);
        assertEq(r.sinkPaid, t * 2 / 84);
        assertEq(r.nandReceiptsPaid, 6 * (nand / 10));
        assertEq(r.latchReceiptsPaid, 5 * (latch / 10));
        assertEq(
            r.totalPaid,
            r.recipientAPaid + r.recipientBPaid + r.sinkPaid + r.nandReceiptsPaid + r.latchReceiptsPaid
        );
        assertEq(
            r.residue,
            t - 2 * (t / 84) - t * 2 / 84 - nand / 10 * 10 - latch / 10 * 10,
            "residue = what no account was allocated"
        );
        assertEq(r.bemBalance, t - r.totalPaid, "balance = recognized - paid");
        assertEq(r.unrecognized, 0);
        assertEq(pool.carriedIncome(), 840_000 + 168_000);
        assertReconciled();
    }
}
