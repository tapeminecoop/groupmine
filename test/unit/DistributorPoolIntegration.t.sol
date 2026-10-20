// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {DistributorTestBase} from "../helpers/DistributorTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {HistoricalDistributor} from "../../src/HistoricalDistributor.sol";

/// @notice HistoricalDistributor as the historical recipient of a real TapeoutMinerPool on the mock
///         protocol: income is harvested through Mining.claim, released by the pool, recognized by
///         the distributor and claimed by individual historical contributors.
contract DistributorPoolIntegrationTest is DistributorTestBase {
    TapeoutMinerPool.Recipient internal constant HIST_NAND = TapeoutMinerPool.Recipient.HISTORICAL_NAND;
    TapeoutMinerPool.Recipient internal constant HIST_LATCH = TapeoutMinerPool.Recipient.HISTORICAL_LATCH;

    address internal n1 = makeAddr("nand-contributor-1");
    address internal n2 = makeAddr("nand-contributor-2");
    address internal n3 = makeAddr("nand-contributor-3");
    address internal l1 = makeAddr("latch-contributor-1");
    address internal l2 = makeAddr("latch-contributor-2");
    address internal keeper = makeAddr("keeper");

    /// @notice Specification example with distributors configured as the historical recipients
    ///         before activation: 1,020 BEM -> historical NAND 80 BEM split 50/30/20 and
    ///         historical LATCH 40 BEM split 3/1.
    function testSpecificationExampleReachesIndividualContributors() public {
        HistoricalDistributor nandDist = newDistributor(NAND, triple(n1, n2, n3), weights3(50, 30, 20));
        HistoricalDistributor latchDist = newDistributor(LATCH, pair(l1, l2), weights2(3, 1));
        TapeoutMinerPool.Config memory c = cfg(900, 80, 100, 20, 80_000_000);
        c.historicalNandRecipient = address(nandDist);
        c.historicalLatchRecipient = address(latchDist);
        configure(c);
        issueRange(NAND, alice, 1, 900);
        issueRange(LATCH, carol, 1, 80);
        activate();
        assertEq(pool.recipientOf(HIST_NAND), address(nandDist));
        assertEq(pool.recipientOf(HIST_LATCH), address(latchDist));

        newMinersDeposited(1, 3);
        mining.accrue(address(nft), 1, 500 * BEM_UNIT);
        mining.accrue(address(nft), 2, 300 * BEM_UNIT);
        mining.accrueUnsettled(address(nft), 3, 220 * BEM_UNIT); // pending() does not show it
        (uint256 received,) = pool.harvestRange(0, 3);
        assertEq(received, 1020 * BEM_UNIT);

        // Nothing has been released yet: the distributors only see the pool's pending amount.
        assertEq(nandDist.pendingFromPool(), 80 * BEM_UNIT);
        assertEq(latchDist.pendingFromPool(), 40 * BEM_UNIT);
        assertEq(nandDist.claimable(n1), 0);

        vm.prank(keeper);
        (uint256 released, uint256 recognized) = nandDist.releaseFromPool();
        assertEq(released, 80 * BEM_UNIT);
        assertEq(recognized, 80 * BEM_UNIT);
        vm.prank(keeper);
        (released, recognized) = latchDist.releaseFromPool();
        assertEq(released, 40 * BEM_UNIT);
        assertEq(nandDist.pendingFromPool(), 0);

        vm.prank(n1);
        assertEq(nandDist.claim(n1), 40 * BEM_UNIT);
        vm.prank(keeper);
        assertEq(nandDist.claimRange(0, 3), 40 * BEM_UNIT); // n2 24 + n3 16
        vm.prank(l2);
        assertEq(latchDist.claim(l2), 10 * BEM_UNIT);
        assertEq(latchDist.claimRange(0, 2), 30 * BEM_UNIT);

        assertEq(bem.balanceOf(n1), 40 * BEM_UNIT);
        assertEq(bem.balanceOf(n2), 24 * BEM_UNIT);
        assertEq(bem.balanceOf(n3), 16 * BEM_UNIT);
        assertEq(bem.balanceOf(l1), 30 * BEM_UNIT);
        assertEq(bem.balanceOf(l2), 10 * BEM_UNIT);
        assertEq(bem.balanceOf(address(nandDist)), 0);
        assertEq(bem.balanceOf(address(latchDist)), 0);
        assertEq(bem.balanceOf(keeper), 0);
        assertEq(pool.historicalPaid(NAND), nandDist.totalAccounted());
        assertEq(pool.historicalPaid(LATCH), latchDist.totalAccounted());
        assertReconciled();
        assertDistributorReconciled(nandDist);
        assertDistributorReconciled(latchDist);
    }

    /// @notice After activation the current recipient hands its role to the distributor; income
    ///         accrued but not released before the handover moves with the role.
    function testHandoverAfterActivationCarriesUnreleasedIncome() public {
        setupDefault(); // H_N = H_L = 1, recipients are plain accounts
        newMinersDeposited(1, 2);
        mining.accrue(address(nft), 1, 102_000); // historical NAND 8_000, LATCH 4_000
        pool.harvestRange(0, 2);

        HistoricalDistributor nandDist = newDistributor(NAND, triple(n1, n2, n3), weights3(5, 3, 2));
        vm.prank(histNandTo);
        pool.setRecipient(HIST_NAND, address(nandDist));

        // The LATCH recipient releases first and keeps what accrued during its tenure.
        HistoricalDistributor latchDist = newDistributor(LATCH, pair(l1, l2), weights2(1, 1));
        pool.releaseHistorical(LATCH);
        assertEq(bem.balanceOf(histLatchTo), 4_000);
        vm.prank(histLatchTo);
        pool.setRecipient(HIST_LATCH, address(latchDist));

        mining.accrue(address(nft), 2, 51_000); // historical NAND +4_000, LATCH +2_000
        pool.harvestRange(0, 2);
        nandDist.releaseFromPool();
        latchDist.releaseFromPool();
        assertEq(nandDist.totalAccounted(), 12_000);
        assertEq(latchDist.totalAccounted(), 2_000);
        assertEq(bem.balanceOf(histNandTo), 0);

        nandDist.claimRange(0, 3);
        latchDist.claimRange(0, 2);
        assertEq(bem.balanceOf(n1), 6_000);
        assertEq(bem.balanceOf(n2), 3_600);
        assertEq(bem.balanceOf(n3), 2_400);
        assertEq(bem.balanceOf(l1), 1_000);
        assertEq(bem.balanceOf(l2), 1_000);
        assertReconciled();
        assertDistributorReconciled(nandDist);
        assertDistributorReconciled(latchDist);
    }

    /// @notice Once the distributor holds the role nobody can move it: the previous recipient and
    ///         the owner are unauthorized and the distributor has no function that calls setRecipient.
    function testRoleIsLockedToTheDistributor() public {
        setupDefault();
        HistoricalDistributor nandDist = newDistributor(NAND, pair(n1, n2), weights2(1, 1));
        vm.prank(histNandTo);
        pool.setRecipient(HIST_NAND, address(nandDist));
        vm.prank(histNandTo);
        vm.expectRevert(TapeoutMinerPool.Unauthorized.selector);
        pool.setRecipient(HIST_NAND, histNandTo);
        vm.prank(operator);
        vm.expectRevert(TapeoutMinerPool.Unauthorized.selector);
        pool.setRecipient(HIST_NAND, operator);
        // A distributor bound to the other category is not the recipient of this one.
        HistoricalDistributor wrongCategory = newDistributor(LATCH, pair(n1, n2), weights2(1, 1));
        vm.expectRevert(abi.encodeWithSelector(HistoricalDistributor.NotPoolRecipient.selector, histLatchTo));
        wrongCategory.releaseFromPool();
    }

    /// @notice The pool's own permissionless release and the convenience path are equivalent, and
    ///         repeated releases pay nothing new.
    function testDirectPoolReleaseIsRecognizedByTheNextSync() public {
        setupDefault();
        HistoricalDistributor nandDist = newDistributor(NAND, triple(n1, n2, n3), weights3(1, 1, 2));
        vm.prank(histNandTo);
        pool.setRecipient(HIST_NAND, address(nandDist));
        bem.mint(address(pool), 102_000); // historical NAND 8_000
        vm.prank(keeper);
        assertEq(pool.releaseHistorical(NAND), 8_000);
        assertEq(nandDist.totalAccounted(), 0);
        assertEq(nandDist.claimable(n3), 4_000); // view already includes the unrecognized balance
        (uint256 released, uint256 recognized) = nandDist.releaseFromPool();
        assertEq(released, 0);
        assertEq(recognized, 8_000);
        (released, recognized) = nandDist.releaseFromPool();
        assertEq(released + recognized, 0);
        assertEq(nandDist.claim(n3), 4_000);
        assertDistributorReconciled(nandDist);
    }

    /// @notice Lists above MAX_CONTRIBUTORS can be split: a contributor may itself be a distributor
    ///         (bound to the same pool and category) whose income arrives through the parent's claims.
    function testNestedDistributorSplitsAShareFurther() public {
        setupDefault();
        address[] memory childAccounts = contributors(4);
        uint96[] memory childWeights = new uint96[](4);
        for (uint256 i; i < 4; ++i) {
            childWeights[i] = 1;
        }
        HistoricalDistributor child = newDistributor(NAND, childAccounts, childWeights);
        HistoricalDistributor parent = newDistributor(NAND, pair(n1, address(child)), weights2(1, 1));
        vm.prank(histNandTo);
        pool.setRecipient(HIST_NAND, address(parent));
        bem.mint(address(pool), 102_000); // historical NAND 8_000
        parent.releaseFromPool();
        vm.expectRevert(
            abi.encodeWithSelector(HistoricalDistributor.NotPoolRecipient.selector, address(parent))
        );
        child.releaseFromPool();
        assertEq(parent.claim(address(child)), 4_000);
        assertEq(child.claimRange(0, 4), 4_000);
        for (uint256 i; i < 4; ++i) {
            assertEq(bem.balanceOf(childAccounts[i]), 1_000);
        }
        assertDistributorReconciled(parent);
        assertDistributorReconciled(child);
    }

    /// @notice Many rounds of harvests, releases at arbitrary times, direct donations and claims:
    ///         every BEM unit the distributor received is either paid to a contributor or retained
    ///         as bounded residue, and each contributor ends with floor(T * w / W).
    function testManyRoundsConserveBemEndToEnd() public {
        TapeoutMinerPool.Config memory c = cfg(13, 7, 3, 2, 61_803_399);
        HistoricalDistributor nandDist = newDistributor(NAND, triple(n1, n2, n3), weights3(7, 11, 13));
        c.historicalNandRecipient = address(nandDist);
        setupAndActivate(c, alice, bob, carol, alice);
        newMinersDeposited(1, 4);
        uint256 donated;
        for (uint256 round = 1; round <= 12; ++round) {
            mining.accrue(address(nft), 1 + round % 4, round * 7_777_777);
            if (round % 2 == 0) pool.harvestRange(0, 4);
            if (round % 3 == 0) nandDist.releaseFromPool();
            if (round % 5 == 0) {
                bem.mint(address(nandDist), round);
                donated += round;
            }
            if (round % 4 == 0) nandDist.claim(n2);
            if (round % 6 == 0) claimAs(alice, range(1, 7), none());
            assertDistributorReconciled(nandDist);
        }
        pool.harvestRange(0, 4);
        nandDist.releaseFromPool();
        nandDist.claimRange(0, 3);
        uint256 total = pool.historicalPaid(NAND) + donated;
        assertEq(nandDist.totalAccounted(), total);
        uint256 paid;
        address[3] memory accounts = [n1, n2, n3];
        for (uint256 i; i < 3; ++i) {
            uint256 expected = Math.mulDiv(total, nandDist.weightOf(accounts[i]), nandDist.totalWeight());
            assertEq(bem.balanceOf(accounts[i]), expected);
            paid += expected;
        }
        assertEq(nandDist.totalPaid(), paid);
        assertEq(bem.balanceOf(address(nandDist)), total - paid);
        assertLe(total - paid, 2);
        assertReconciled();
        assertDistributorReconciled(nandDist);
    }
}
