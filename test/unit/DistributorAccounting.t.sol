// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {DistributorTestBase} from "../helpers/DistributorTestBase.sol";
import {HistoricalDistributor} from "../../src/HistoricalDistributor.sol";

/// @dev Income reaches the distributor by direct BEM transfers here; the pool path is covered by
///      DistributorPoolIntegration.t.sol. Weights 50/30/20 split 80 BEM into 40/24/16 BEM.
contract DistributorAccountingTest is DistributorTestBase {
    address internal h1 = makeAddr("historical-1");
    address internal h2 = makeAddr("historical-2");
    address internal h3 = makeAddr("historical-3");
    address internal keeper = makeAddr("keeper");
    HistoricalDistributor internal dist;

    function setUp() public override {
        super.setUp();
        dist = newDistributor(NAND, triple(h1, h2, h3), weights3(50, 30, 20));
    }

    function _income(uint256 amount) internal {
        bem.mint(address(dist), amount);
    }

    function testSplitsIncomeExactlyByWeight() public {
        _income(80 * BEM_UNIT);
        assertEq(dist.claimable(h1), 40 * BEM_UNIT);
        assertEq(dist.claimable(h2), 24 * BEM_UNIT);
        assertEq(dist.claimable(h3), 16 * BEM_UNIT);
        vm.prank(h1);
        assertEq(dist.claim(h1), 40 * BEM_UNIT);
        vm.prank(h2);
        assertEq(dist.claim(h2), 24 * BEM_UNIT);
        vm.prank(h3);
        assertEq(dist.claim(h3), 16 * BEM_UNIT);
        assertEq(bem.balanceOf(h1), 40 * BEM_UNIT);
        assertEq(bem.balanceOf(h2), 24 * BEM_UNIT);
        assertEq(bem.balanceOf(h3), 16 * BEM_UNIT);
        assertEq(bem.balanceOf(address(dist)), 0);
        assertEq(dist.totalAccounted(), 80 * BEM_UNIT);
        assertEq(dist.totalPaid(), 80 * BEM_UNIT);
        assertEq(dist.reconciliation().residue, 0);
        assertDistributorReconciled(dist);
    }

    function testRepeatedClaimsPayOnlyNewIncome() public {
        _income(1_000);
        assertEq(dist.claim(h1), 500);
        assertEq(dist.claim(h1), 0);
        assertEq(dist.claimed(h1), 500);
        _income(2_000);
        assertEq(dist.claim(h1), 1_000);
        assertEq(dist.claim(h1), 0);
        assertEq(dist.claimed(h1), 1_500);
        assertEq(dist.entitlementOf(h1), 1_500);
        assertEq(dist.claimable(h2), 900);
        assertDistributorReconciled(dist);
    }

    function testAnyoneCanPushButPaymentsOnlyReachTheContributor() public {
        _income(10_000);
        uint256 index = dist.indexOf(h2);
        vm.expectEmit(true, true, true, true, address(dist));
        emit HistoricalDistributor.ContributorPaid(index, h2, keeper, 3_000);
        vm.prank(keeper);
        assertEq(dist.claim(h2), 3_000);
        assertEq(bem.balanceOf(h2), 3_000);
        assertEq(bem.balanceOf(keeper), 0);
        // A pushed claim leaves the contributor nothing to claim twice.
        vm.prank(h2);
        assertEq(dist.claim(h2), 0);
        assertDistributorReconciled(dist);
    }

    function testBatchAndRangeClaimsPayEachContributorOnce() public {
        _income(10_000);
        address[] memory batch = new address[](4);
        (batch[0], batch[1], batch[2], batch[3]) = (h1, h3, h1, h3);
        vm.prank(keeper);
        assertEq(dist.claimBatch(batch), 5_000 + 2_000);
        assertEq(bem.balanceOf(h1), 5_000);
        assertEq(bem.balanceOf(h3), 2_000);
        // Range over the whole list (clamped) only pays what is still owed.
        assertEq(dist.claimRange(0, 100), 3_000);
        assertEq(bem.balanceOf(h2), 3_000);
        assertEq(dist.claimRange(1, 2), 0);
        _income(1_000);
        (address last, uint256 lastWeight) = dist.contributorAt(2);
        uint256 owed = dist.claimable(last);
        assertEq(owed, Math.mulDiv(11_000, lastWeight, 100) - Math.mulDiv(10_000, lastWeight, 100));
        assertEq(dist.claimRange(2, 1), owed);
        assertEq(dist.claimable(last), 0);
        assertDistributorReconciled(dist);
    }

    function testInvalidClaimsRevert() public {
        _income(10_000);
        address outsider = makeAddr("outsider");
        vm.expectRevert(abi.encodeWithSelector(HistoricalDistributor.NotContributor.selector, outsider));
        dist.claim(outsider);
        // One unknown account reverts the whole batch.
        vm.expectRevert(abi.encodeWithSelector(HistoricalDistributor.NotContributor.selector, outsider));
        dist.claimBatch(pair(h1, outsider));
        assertEq(bem.balanceOf(h1), 0);
        vm.expectRevert(HistoricalDistributor.InvalidBatch.selector);
        dist.claimBatch(new address[](0));
        vm.expectRevert(HistoricalDistributor.InvalidBatch.selector);
        dist.claimRange(0, 0);
        vm.expectRevert(HistoricalDistributor.InvalidBatch.selector);
        dist.claimRange(3, 1);
        assertEq(dist.totalPaid(), 0);
    }

    function testRoundingResidueIsBoundedAndPaidOutByLaterIncome() public {
        HistoricalDistributor d = newDistributor(NAND, triple(h1, h2, h3), weights3(1, 1, 1));
        bem.mint(address(d), 100);
        assertEq(d.claimRange(0, 3), 99); // 33 each
        HistoricalDistributor.Reconciliation memory r = d.reconciliation();
        assertEq(r.residue, 1);
        assertEq(bem.balanceOf(address(d)), 1);
        bem.mint(address(d), 2); // T = 102: 34 each, residue 0
        assertEq(d.claimRange(0, 3), 3);
        assertEq(d.reconciliation().residue, 0);
        assertEq(bem.balanceOf(address(d)), 0);
        assertEq(bem.balanceOf(h1) + bem.balanceOf(h2) + bem.balanceOf(h3), 102);

        // Coprime weights and odd amounts: residue never exceeds n - 1 = 2.
        HistoricalDistributor odd = newDistributor(NAND, triple(h1, h2, h3), weights3(3, 7, 11));
        for (uint256 i = 1; i <= 25; ++i) {
            bem.mint(address(odd), i * 13 + 1);
            if (i % 3 == 0) odd.claim(h2);
            if (i % 4 == 0) odd.claimRange(0, 3);
            odd.sync();
            assertLe(odd.reconciliation().residue, 2);
            assertDistributorReconciled(odd);
        }
    }

    function testDirectTransfersAreIncomeAndClaimsSyncFirst() public {
        _income(5_000);
        assertEq(dist.unrecognizedBalance(), 5_000);
        assertEq(dist.claimable(h1), 2_500); // views include BEM not yet recognized
        assertEq(dist.entitlementOf(h1), 0); // recognized income only
        vm.expectEmit(address(dist));
        emit HistoricalDistributor.IncomeRecognized(5_000, 5_000);
        assertEq(dist.claim(h1), 2_500);
        assertEq(dist.unrecognizedBalance(), 0);
        _income(1_000);
        assertEq(dist.sync(), 1_000);
        assertEq(dist.sync(), 0);
        assertEq(dist.totalAccounted(), 6_000);
        assertDistributorReconciled(dist);
    }

    function testZeroClaimsChangeNothing() public {
        vm.recordLogs();
        assertEq(dist.claim(h1), 0);
        assertEq(dist.claimRange(0, 3), 0);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(dist.claimed(h1), 0);
        assertEq(dist.totalPaid(), 0);
        _income(2); // floor(2*50/100) = 1, floor(2*30/100) = floor(2*20/100) = 0
        assertEq(dist.claim(h2), 0);
        assertEq(dist.claim(h1), 1);
        assertDistributorReconciled(dist);
    }

    function testBalanceDecreaseStopsEveryMoneyPath() public {
        _income(10_000);
        dist.claim(h1);
        bem.burn(address(dist), 1);
        bytes memory err =
            abi.encodeWithSelector(HistoricalDistributor.BalanceDecreased.selector, 4_999, 5_000);
        vm.expectRevert(err);
        dist.claim(h2);
        vm.expectRevert(err);
        dist.claimRange(0, 3);
        vm.expectRevert(err);
        dist.sync();
        vm.expectRevert(err);
        dist.claimable(h2);
        HistoricalDistributor.Reconciliation memory r = dist.reconciliation();
        assertEq(r.deficit, 1);
        assertEq(r.unrecognized, 0);
        // Topping the balance back up resumes payouts without rewriting history.
        bem.mint(address(dist), 1);
        assertEq(dist.claim(h2), 3_000);
        assertDistributorReconciled(dist);
    }

    function testAbnormalTokenTransfersRevertWithoutRewritingHistory() public {
        _income(10_000);
        bem.setFaults(false, false, true); // fee on transfer
        vm.expectRevert(HistoricalDistributor.UnexpectedTokenBehavior.selector);
        dist.claim(h1);
        assertEq(dist.claimed(h1), 0);
        assertEq(dist.totalPaid(), 0);
        bem.setFaults(false, true, false); // transfer reverts
        vm.expectRevert("BEM_TRANSFER_BROKEN");
        dist.claimRange(0, 3);
        assertEq(dist.totalPaid(), 0);
        bem.setFaults(true, false, false); // balance read reverts
        vm.expectRevert("BEM_BALANCE_BROKEN");
        dist.claim(h1);
        bem.setFaults(false, false, false);
        assertEq(dist.claim(h1), 5_000);
        assertDistributorReconciled(dist);
    }

    function testAllocationIsPathIndependent() public {
        HistoricalDistributor a = newDistributor(NAND, triple(h1, h2, h3), weights3(5, 3, 2));
        address[] memory others = contributors(3);
        HistoricalDistributor b = newDistributor(NAND, others, weights3(5, 3, 2));
        // a: one income of 1,234,567 raw, claimed once.
        bem.mint(address(a), 1_234_567);
        a.claimRange(0, 3);
        // b: the same total in uneven pieces with claims in between.
        uint256[5] memory pieces = [uint256(1), 99, 1_000_001, 7, 234_459];
        for (uint256 i; i < pieces.length; ++i) {
            bem.mint(address(b), pieces[i]);
            b.claim(others[i % 3]);
        }
        b.claimRange(0, 3);
        assertEq(bem.balanceOf(h1), bem.balanceOf(others[0]));
        assertEq(bem.balanceOf(h2), bem.balanceOf(others[1]));
        assertEq(bem.balanceOf(h3), bem.balanceOf(others[2]));
        assertEq(bem.balanceOf(address(a)), bem.balanceOf(address(b)));
    }

    /// @notice For any weights and income sequence: payouts equal floor(T * w / W) exactly once
    ///         everyone is paid, nothing is overpaid at any step, and the residue is below n.
    function testFuzzClaimsAreExactAndNeverOverpay(
        uint96[6] memory rawWeights,
        uint64[4] memory incomes,
        uint8 claimMask
    ) public {
        uint256 n = 1 + uint256(rawWeights[0]) % 6;
        address[] memory accounts = contributors(n);
        uint96[] memory w = new uint96[](n);
        for (uint256 i; i < n; ++i) {
            // Mix tiny and huge weights.
            w[i] = i % 2 == 0
                ? uint96(bound(rawWeights[i], 1, 1_000))
                : uint96(bound(rawWeights[i], 1, type(uint96).max));
        }
        HistoricalDistributor d = newDistributor(NAND, accounts, w);
        uint256 total;
        for (uint256 step; step < incomes.length; ++step) {
            bem.mint(address(d), incomes[step]);
            total += incomes[step];
            for (uint256 i; i < n; ++i) {
                if ((claimMask >> ((step + i) % 8)) & 1 == 1) d.claim(accounts[i]);
            }
            assertDistributorReconciled(d);
        }
        d.claimRange(0, n);
        uint256 paid;
        for (uint256 i; i < n; ++i) {
            uint256 expected = Math.mulDiv(total, d.weightOf(accounts[i]), d.totalWeight());
            assertEq(bem.balanceOf(accounts[i]), expected);
            paid += expected;
        }
        assertEq(paid, d.totalPaid());
        assertEq(bem.balanceOf(address(d)), total - paid);
        assertLe(total - paid, n - 1);
        assertEq(d.reconciliation().residue, total - paid);
    }

    /// @notice Entitlements are cumulative floors: monotonic in income and summing to at most T.
    function testFuzzEntitlementsAreMonotonicAndBounded(uint128 total, uint64 delta, uint96 w1, uint96 w2)
        public
    {
        w1 = uint96(bound(w1, 1, type(uint96).max));
        w2 = uint96(bound(w2, 1, type(uint96).max));
        HistoricalDistributor d = newDistributor(NAND, pair(h1, h2), weights2(w1, w2));
        bem.mint(address(d), total);
        d.sync();
        uint256 e1 = d.entitlementOf(h1);
        uint256 e2 = d.entitlementOf(h2);
        assertLe(e1 + e2, total);
        assertGe(e1 + e2 + 1, total);
        bem.mint(address(d), delta);
        d.sync();
        assertGe(d.entitlementOf(h1), e1);
        assertGe(d.entitlementOf(h2), e2);
    }
}
