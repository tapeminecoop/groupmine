// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {PoolMath} from "../../src/PoolMath.sol";
import {MockMining} from "../helpers/Mocks.sol";

/// @dev Standard pool: S_N = 10, S_L = 10. Amounts in raw BEM units unless written as X * BEM_UNIT.
contract PoolAdmissionTest is SystemTestBase {
    function setUp() public override {
        super.setUp();
        setupStandard();
    }

    /// @notice The specification's acceptance example: old composition 9:1 with 102 BEM collectible,
    ///         a 1:9 miner carrying 102 BEM is admitted -> NAND 140, LATCH 60, A 2, B 2.
    function testSpecificationAcceptanceExample() public {
        admitNew(1, 9, 1);
        accrue(1, 102 * BEM_UNIT); // earned by the old composition, still inside Mining
        newMiner(2, 1, 9);
        accrue(2, 102 * BEM_UNIT); // carried by the incoming miner (earned before deposit)
        (uint256 settled, uint256 carried) = admit(one(2));
        assertEq(settled, 102 * BEM_UNIT);
        assertEq(carried, 102 * BEM_UNIT);
        assertEq(pool.totalNandBurn(), 10);
        assertEq(pool.totalLatchBurn(), 10);

        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.total, 204 * BEM_UNIT);
        assertEq(a.recipientA, 2 * BEM_UNIT);
        assertEq(a.recipientB, 2 * BEM_UNIT);
        assertEq(a.nandIncome, 140 * BEM_UNIT);
        assertEq(a.latchIncome, 60 * BEM_UNIT);
        assertEq(a.residue, 0);
        // Applying the latest 10:10 ratio to all history would give 100/100 instead.
        assertTrue(a.nandIncome != a.participants / 2);

        assertEq(claimAs(alice, range(1, 5), range(1, 5)), 5 * 14 * BEM_UNIT + 5 * 6 * BEM_UNIT);
        assertEq(claimAs(bob, range(6, 10), none()), 5 * 14 * BEM_UNIT);
        assertEq(claimAs(carol, none(), range(6, 10)), 5 * 6 * BEM_UNIT);
        assertEq(pool.releaseA(), 2 * BEM_UNIT);
        assertEq(pool.releaseB(), 2 * BEM_UNIT);
        assertEq(bem.balanceOf(address(pool)), 0);
        assertEq(bem.balanceOf(recipientA), 2 * BEM_UNIT);
        assertEq(bem.balanceOf(recipientB), 2 * BEM_UNIT);
        assertReconciled();
    }

    function testOldIncomeHiddenFromPendingIsStillSettledUnderTheOldRatio() public {
        admitNew(1, 9, 1);
        mining.accrueUnsettled(address(nft), 1, 102 * BEM_UNIT);
        assertEq(mining.pending(mining.minerKey(address(nft), 1)), 0);
        (uint256 settled,) = admitNew(2, 1, 9);
        assertEq(settled, 102 * BEM_UNIT);
        assertEq(pool.accrual().nandIncome, 90 * BEM_UNIT);
        assertEq(pool.accrual().latchIncome, 10 * BEM_UNIT);
    }

    function testBatchUsesOnePostBatchCompositionForAllCarriedIncome() public {
        admitNew(1, 9, 1);
        accrue(1, 102 * BEM_UNIT);
        newMiner(2, 1, 9);
        newMiner(3, 0, 10);
        accrue(2, 51 * BEM_UNIT);
        accrue(3, 51 * BEM_UNIT);
        (uint256 settled, uint256 carried) = admit(two(2, 3));
        assertEq(settled, 102 * BEM_UNIT);
        assertEq(carried, 102 * BEM_UNIT);
        // Post-batch composition N=10, L=20 for both carried amounts.
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.nandIncome, 90 * BEM_UNIT + (100 * BEM_UNIT * 10) / 30);
        assertEq(a.latchIncome, 10 * BEM_UNIT + (100 * BEM_UNIT * 20) / 30);
        assertEq(a.participants - a.nandIncome - a.latchIncome, 1); // one raw unit carried to the next period
        assertReconciled();
    }

    function testBatchOrderDoesNotChangeTheOutcome() public {
        admitNew(1, 7, 3);
        accrue(1, 977_777);
        newMiner(2, 2, 11);
        newMiner(3, 13, 1);
        accrue(2, 333_331);
        mining.accrueUnsettled(address(nft), 3, 123_457);
        uint256 snapshot = vm.snapshotState();
        admit(two(2, 3));
        bytes memory forward =
            abi.encode(pool.accrual(), pool.reconciliation(), pool.totalNandBurn(), pool.totalLatchBurn());
        vm.revertToState(snapshot);
        admit(two(3, 2));
        bytes memory backward =
            abi.encode(pool.accrual(), pool.reconciliation(), pool.totalNandBurn(), pool.totalLatchBurn());
        assertEq(keccak256(forward), keccak256(backward));
    }

    function testFirstAdmissionRecognizesIncomeHeldBeforeAnyComposition() public {
        bem.mint(address(pool), 51 * BEM_UNIT); // arrives while there is no composition to split it
        assertEq(pool.sync(), 0);
        assertEq(pool.totalAccounted(), 0);
        assertEq(pool.unrecognizedBalance(), 0);
        newMiner(1, 3, 1);
        accrue(1, 51 * BEM_UNIT);
        (uint256 settled, uint256 carried) = admit(one(1));
        assertEq(settled, 0);
        assertEq(carried, 102 * BEM_UNIT);
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.nandIncome, 75 * BEM_UNIT); // 3:1 of the first composition, no invented weights
        assertEq(a.latchIncome, 25 * BEM_UNIT);
        assertReconciled();
    }

    function testCarriedIncomeIsNotPaidBackToTheDepositor() public {
        newMiner(1, 5, 5);
        accrue(1, 1_000_000);
        admit(one(1));
        assertEq(bem.balanceOf(depositor), 0);
        assertEq(bem.balanceOf(address(pool)), 1_000_000);
        assertEq(nft.ownerOf(1), address(pool));
    }

    function testActiveOldMinerSettlementFailureRollsBackTheWholeAdmission() public {
        admitNew(1, 9, 1);
        admitNew(2, 4, 4);
        accrue(1, 5_000);
        accrue(2, 7_000);
        mining.setKeyBroken(address(nft), 2, true);
        newMiner(3, 1, 9);
        accrue(3, 9_000);
        bytes memory before =
            abi.encode(pool.accrual(), pool.totalNandBurn(), pool.totalLatchBurn(), pool.minerCount());
        vm.startPrank(depositor);
        vm.expectRevert(
            abi.encodeWithSelector(
                TapeoutMinerPool.SettlementFailed.selector,
                2,
                abi.encodeWithSignature("Error(string)", "MINER_BROKEN")
            )
        );
        pool.depositMiners(one(3));
        vm.stopPrank();
        assertEq(
            keccak256(
                abi.encode(pool.accrual(), pool.totalNandBurn(), pool.totalLatchBurn(), pool.minerCount())
            ),
            keccak256(before)
        );
        assertEq(nft.ownerOf(3), depositor);
        assertEq(mining.pending(mining.minerKey(address(nft), 1)), 5_000); // miner 1 was not claimed either
        // Once the old miner can be settled again, the same admission goes through.
        mining.setKeyBroken(address(nft), 2, false);
        (uint256 settled,) = admit(one(3));
        assertEq(settled, 12_000);
    }

    function testAMiningOutageBlocksAdmissionButNotClaimsOfHeldIncome() public {
        admitNew(1, 5, 5);
        accrue(1, 102_000);
        pool.harvestRange(0, 1);
        mining.setBroken(true);
        newMiner(2, 1, 1);
        vm.startPrank(depositor);
        vm.expectRevert();
        pool.depositMiners(one(2));
        vm.stopPrank();
        assertEq(claimAs(alice, one(1), one(1)), 5_000 + 5_000);
        assertEq(pool.releaseA(), 1_000);
        assertReconciled();
    }

    function testInactiveOldMinerIsSkippedExplicitly() public {
        admitNew(1, 9, 1);
        admitNew(2, 2, 2);
        accrue(1, 102_000);
        accrue(2, 50_000);
        mining.setStatus(address(nft), 2, 2); // stopped: the protocol refuses to pay it at all
        newMiner(3, 1, 1);
        vm.recordLogs();
        (uint256 settled,) = admit(one(3));
        assertEq(settled, 102_000);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool skipped;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].topics[0] == TapeoutMinerPool.InactiveMinerSkipped.selector
                    && uint256(logs[i].topics[1]) == 2
            ) {
                skipped = true;
            }
        }
        assertTrue(skipped);
        assertEq(pool.totalNandBurn(), 12); // composition is cached at admission and kept
        assertEq(mining.rewards(mining.minerKey(address(nft), 2)), 50_000);
    }

    function testIncomingMinerClaimFailureRollsBack() public {
        admitNew(1, 1, 1);
        newMiner(2, 1, 1);
        mining.setKeyBroken(address(nft), 2, true);
        vm.startPrank(depositor);
        nft.setApprovalForAll(address(pool), true);
        vm.expectRevert("MINER_BROKEN");
        pool.depositMiners(one(2));
        vm.stopPrank();
        assertEq(pool.minerCount(), 1);
        assertEq(nft.ownerOf(2), depositor);
    }

    function testDuplicateAndAlreadyRegisteredMinersAreRejected() public {
        newMiner(1, 1, 1);
        uint256[] memory dup = two(1, 1);
        vm.startPrank(depositor);
        nft.setApprovalForAll(address(pool), true);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.DuplicateMiner.selector, 1));
        pool.depositMiners(dup);
        pool.depositMiners(one(1));
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.MinerAlreadyRegistered.selector, 1));
        pool.registerMiners(one(1));
        vm.expectRevert(TapeoutMinerPool.InvalidBatch.selector);
        pool.depositMiners(none());
        vm.expectRevert(TapeoutMinerPool.InvalidBatch.selector);
        pool.depositMiners(range(100, 150));
        vm.stopPrank();
    }

    function testOnlyWhitelistedDepositorsAdmitAndOnlyTheirOwnMiners() public {
        newMinerFor(alice, 1, 1, 1);
        vm.startPrank(alice);
        nft.setApprovalForAll(address(pool), true);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotDepositor.selector, alice));
        pool.depositMiners(one(1));
        vm.stopPrank();
        // The owner is not implicitly a depositor.
        newMinerFor(operator, 2, 1, 1);
        vm.startPrank(operator);
        nft.setApprovalForAll(address(pool), true);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotDepositor.selector, operator));
        pool.depositMiners(one(2));
        vm.stopPrank();
        // A whitelisted caller cannot use another account's approval to pull its miners in.
        newMiner(3, 1, 1);
        vm.prank(depositor);
        nft.setApprovalForAll(address(pool), true);
        vm.prank(depositor2);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.MinerNotHeld.selector, 3, depositor));
        pool.depositMiners(one(3));
        assertEq(nft.ownerOf(3), depositor);
    }

    function testPlainTransferNeitherRegistersNorBypassesTheWhitelistOrSettlement() public {
        admitNew(1, 9, 1);
        accrue(1, 102 * BEM_UNIT);
        newMiner(2, 1, 9);
        vm.prank(depositor);
        nft.transferFrom(depositor, address(pool), 2);
        assertEq(pool.minerCount(), 1);
        assertEq(pool.totalLatchBurn(), 1);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.UnknownMiner.selector, 2));
        pool.harvest(one(2));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotDepositor.selector, alice));
        pool.registerMiners(one(2));
        accrue(2, 102 * BEM_UNIT);
        vm.prank(depositor);
        (uint256 settled, uint256 carried) = pool.registerMiners(one(2));
        assertEq(settled, 102 * BEM_UNIT);
        assertEq(carried, 102 * BEM_UNIT);
        assertEq(pool.accrual().nandIncome, 140 * BEM_UNIT);
        assertEq(pool.accrual().latchIncome, 60 * BEM_UNIT);
    }

    function testSafeTransferIntoThePoolIsRefused() public {
        newMiner(1, 1, 1);
        vm.prank(depositor);
        vm.expectRevert();
        nft.safeTransferFrom(depositor, address(pool), 1);
    }

    function testCompositionMustComeFromAValidActiveMinerRecord() public {
        newMiner(1, 1, 1);
        mining.setStatus(address(nft), 1, 0);
        _expectAdmissionRevert(1, abi.encodeWithSelector(TapeoutMinerPool.MinerNotActive.selector, 1));
        mining.setStatus(address(nft), 1, 1);
        mining.setCachedBurn(address(nft), 1, true, 2, 1);
        _expectAdmissionRevert(1, abi.encodeWithSelector(TapeoutMinerPool.CompositionMismatch.selector, 1));
        mining.setCachedBurn(address(nft), 1, false, 1, 1);
        _expectAdmissionRevert(1, abi.encodeWithSelector(TapeoutMinerPool.CompositionMismatch.selector, 1));
        mining.setCachedBurn(address(nft), 1, true, 1, 1);
        mining.setRecordCircuitId(address(nft), 1, 77);
        _expectAdmissionRevert(1, abi.encodeWithSelector(TapeoutMinerPool.MinerNotActive.selector, 1));
        newMiner(2, 0, 0);
        _expectAdmissionRevert(2, abi.encodeWithSelector(TapeoutMinerPool.EmptyComposition.selector, 2));
        // The depositor cannot supply counts: the only inputs are token IDs.
        mining.setRecordCircuitId(address(nft), 1, 0);
        admit(one(1));
        assertEq(pool.miner(1).nandBurn, 1);
        assertEq(pool.miner(1).latchBurn, 1);
    }

    function testAdmissionsRequireActivation() public {
        TapeoutMinerPool fresh = deployPool(whitelist());
        newMiner(1, 1, 1);
        vm.startPrank(depositor);
        nft.setApprovalForAll(address(fresh), true);
        vm.expectRevert(TapeoutMinerPool.NotActive.selector);
        fresh.depositMiners(one(1));
        vm.stopPrank();
    }

    function testEntitlementsNeverDecreaseAcrossCompositionChanges() public {
        uint256 lastNand;
        uint256 lastLatch;
        uint256 lastPerNand;
        uint256 lastPerLatch;
        uint32[6] memory nands = [uint32(9), 1, 0, 50, 3, 1];
        uint32[6] memory latches = [uint32(1), 9, 10, 1, 3, 60];
        for (uint256 i; i < 6; ++i) {
            for (uint256 j = 1; j <= i; ++j) {
                accrue(j, 1_000_003 * j + i);
            }
            newMiner(i + 1, nands[i], latches[i]);
            accrue(i + 1, 777_777);
            admit(one(i + 1));
            PoolMath.Accrual memory a = pool.accrual();
            assertGe(a.nandIncome, lastNand);
            assertGe(a.latchIncome, lastLatch);
            assertGe(a.perNandShare, lastPerNand);
            assertGe(a.perLatchShare, lastPerLatch);
            (lastNand, lastLatch, lastPerNand, lastPerLatch) =
                (a.nandIncome, a.latchIncome, a.perNandShare, a.perLatchShare);
            assertEq(pool.compositionPeriod(), i + 1);
            assertReconciled();
        }
    }

    function _expectAdmissionRevert(uint256 tokenId, bytes memory reason) private {
        vm.startPrank(depositor);
        nft.setApprovalForAll(address(pool), true);
        vm.expectRevert(reason);
        pool.depositMiners(one(tokenId));
        vm.stopPrank();
    }
}

/// @dev A pool whose LATCH collection was finalized with zero supply.
contract PoolUnsupportedCategoryTest is SystemTestBase {
    function testCategoryWithoutReceiptsCannotGainCompositionOrIncome() public {
        issue(nandReceipt, alice, 4);
        finalizeIssuance();
        activate();
        assertEq(pool.latchShares(), 0);
        newMiner(1, 3, 2);
        vm.startPrank(depositor);
        nft.setApprovalForAll(address(pool), true);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.UnsupportedCategory.selector, LATCH));
        pool.depositMiners(one(1));
        vm.stopPrank();
        newMiner(2, 5, 0);
        accrue(2, 102_000);
        admit(one(2));
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.nandIncome, 100_000);
        assertEq(a.latchIncome, 0);
        assertEq(claimAs(alice, range(1, 4), none()), 100_000);
        assertReconciled();
    }
}
