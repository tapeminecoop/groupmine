// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {DistributorTestBase} from "../helpers/DistributorTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {HistoricalDistributor} from "../../src/HistoricalDistributor.sol";

/// @notice Worst-case gas of the batched operations the CLI plans, measured at the CLI's largest
///         allowed batch sizes and checked against the gas model in sdk/gas.ts. BSC caps a
///         transaction's gas limit at 2^24 (BEP-652); the CLI keeps every planned transaction, and
///         every Safe batch file, within 3/4 of that cap. Measurements are cold, exclude the 21_000
///         base cost and calldata, and are written to reports/gas-batch.json. Mining-dependent
///         operations (deposit, register, harvest) are modelled from the real-protocol fork
///         measurements instead; the mock values here are for reference only.
contract BatchGasBudgetTest is DistributorTestBase {
    string internal constant KEY = "batchGas";
    uint256 internal constant TX_GAS_CAP = 16_777_216;
    uint256 internal constant BATCH_GAS_BUDGET = TX_GAS_CAP * 3 / 4;

    // Keep in sync with MAX_BATCH and GAS_MODEL in sdk/gas.ts.
    uint256 internal constant MAX_ISSUE = 200;
    uint256 internal constant MAX_CLAIM = 400;
    uint256 internal constant MAX_DISTRIBUTOR_CLAIM = 150;
    uint256 internal constant ISSUE_RANGE_FIXED = 150_000;
    uint256 internal constant ISSUE_RANGE_PER_ID = 50_000;
    uint256 internal constant ISSUE_LIST_FIXED = 150_000;
    uint256 internal constant ISSUE_LIST_PER_ID = 60_000;
    uint256 internal constant REVOKE_FIXED = 100_000;
    uint256 internal constant REVOKE_PER_ID = 20_000;
    uint256 internal constant CLAIM_FIXED = 200_000;
    uint256 internal constant CLAIM_PER_ID = 30_000;
    uint256 internal constant DIST_CLAIM_RANGE_FIXED = 150_000;
    uint256 internal constant DIST_CLAIM_RANGE_PER_ITEM = 65_000;
    uint256 internal constant DIST_CLAIM_BATCH_FIXED = 150_000;
    uint256 internal constant DIST_CLAIM_BATCH_PER_ITEM = 72_000;
    uint256 internal constant DIST_DEPLOY_FIXED = 1_600_000;
    uint256 internal constant DIST_DEPLOY_PER_CONTRIBUTOR = 25_000;

    function _cool(HistoricalDistributor d) internal {
        vm.cool(address(pool));
        vm.cool(address(nand));
        vm.cool(address(latch));
        vm.cool(address(bem));
        vm.cool(address(mining));
        vm.cool(address(nft));
        if (address(d) != address(0)) vm.cool(address(d));
    }

    function _holders(string memory label, uint256 n) internal returns (address[] memory h) {
        h = new address[](n);
        for (uint256 i; i < n; ++i) {
            h[i] = makeAddr(string.concat(label, vm.toString(i)));
        }
    }

    function _sortedContributors(uint256 n) internal pure returns (address[] memory a, uint96[] memory w) {
        a = new address[](n);
        w = new uint96[](n);
        for (uint256 i; i < n; ++i) {
            a[i] = address(uint160(uint256(keccak256(abi.encode("batch-contributor", i)))));
            w[i] = uint96(1 + i % 97);
        }
        for (uint256 i = 1; i < n; ++i) {
            (address x, uint96 y) = (a[i], w[i]);
            uint256 j = i;
            while (j > 0 && a[j - 1] > x) {
                (a[j], w[j]) = (a[j - 1], w[j - 1]);
                --j;
            }
            (a[j], w[j]) = (x, y);
        }
    }

    function testBatchGasStaysWithinTheModelAndBudget() public {
        uint256 maxContributors = 400; // HistoricalDistributor.MAX_CONTRIBUTORS
        (address[] memory accounts, uint96[] memory weights) = _sortedContributors(maxContributors);
        _cool(HistoricalDistributor(address(0)));
        uint256 g = gasleft();
        HistoricalDistributor d = new HistoricalDistributor(pool, NAND, accounts, weights);
        uint256 deployMax = g - gasleft();
        assertEq(d.MAX_CONTRIBUTORS(), maxContributors);

        TapeoutMinerPool.Config memory c = cfg(1_000, 500, 10, 5, 80_000_000);
        c.historicalNandRecipient = address(d);
        configure(c);

        // Issuance: a range to one holder, and an explicit list to distinct new holders (worst case).
        _cool(d);
        g = gasleft();
        issueRange(NAND, alice, 1, 1);
        uint256 issueRange1 = g - gasleft();
        _cool(d);
        g = gasleft();
        issueRange(NAND, alice, 2, MAX_ISSUE);
        uint256 issueRangeMax = g - gasleft();

        address[] memory fresh = _holders("list-holder-", MAX_ISSUE);
        uint256[] memory listIds = range(MAX_ISSUE + 2, 2 * MAX_ISSUE + 1);
        _cool(d);
        vm.prank(operator);
        g = gasleft();
        pool.issueReceipts(NAND, fresh, listIds);
        uint256 issueListMax = g - gasleft();

        // Revocation of a full list (before activation), then re-issue to complete the collection.
        _cool(d);
        vm.prank(operator);
        g = gasleft();
        pool.revokeReceipts(NAND, listIds);
        uint256 revokeMax = g - gasleft();
        vm.prank(operator);
        pool.issueReceipts(NAND, fresh, listIds);
        issueRange(NAND, bob, 2 * MAX_ISSUE + 2, 1_000 - 2 * MAX_ISSUE - 1);
        issueRange(LATCH, alice, 1, 250);
        issueRange(LATCH, carol, 251, 250);
        activate();

        // Receipt claims: MAX_CLAIM first claims by one holder across both collections.
        bem.mint(address(pool), 1_020_000 * BEM_UNIT);
        _cool(d);
        vm.prank(alice);
        g = gasleft();
        pool.claimBatch(range(1, MAX_CLAIM / 2), range(1, MAX_CLAIM / 2));
        uint256 claimMax = g - gasleft();

        // Distributor: release, then first-time payouts by range and by listed accounts.
        _cool(d);
        g = gasleft();
        d.releaseFromPool();
        uint256 distRelease = g - gasleft();
        _cool(d);
        g = gasleft();
        d.claimRange(0, MAX_DISTRIBUTOR_CLAIM);
        uint256 distClaimRangeMax = g - gasleft();
        address[] memory listed = new address[](MAX_DISTRIBUTOR_CLAIM);
        for (uint256 i; i < MAX_DISTRIBUTOR_CLAIM; ++i) {
            (listed[i],) = d.contributorAt(MAX_DISTRIBUTOR_CLAIM + i);
        }
        _cool(d);
        g = gasleft();
        d.claimBatch(listed);
        uint256 distClaimBatchMax = g - gasleft();

        vm.serializeUint(KEY, "txGasCap", TX_GAS_CAP);
        vm.serializeUint(KEY, "batchGasBudget", BATCH_GAS_BUDGET);
        vm.serializeUint(KEY, "issueReceiptRange1", issueRange1);
        vm.serializeUint(KEY, "issueReceiptRangeMax", issueRangeMax);
        vm.serializeUint(KEY, "issueReceiptsListMax", issueListMax);
        vm.serializeUint(KEY, "revokeReceiptsMax", revokeMax);
        vm.serializeUint(KEY, "claimBatchMax", claimMax);
        vm.serializeUint(KEY, "distributorDeployMax", deployMax);
        vm.serializeUint(KEY, "distributorReleaseFromPool", distRelease);
        vm.serializeUint(KEY, "distributorClaimRangeMax", distClaimRangeMax);
        string memory out = vm.serializeUint(KEY, "distributorClaimBatchMax", distClaimBatchMax);
        vm.writeJson(out, "reports/gas-batch.json");

        // Measured <= model, and model at the CLI maximum <= budget (both checked per kind).
        _check(issueRangeMax, ISSUE_RANGE_FIXED, ISSUE_RANGE_PER_ID, MAX_ISSUE, "issueReceiptRange");
        _check(issueListMax, ISSUE_LIST_FIXED, ISSUE_LIST_PER_ID, MAX_ISSUE, "issueReceipts");
        _check(revokeMax, REVOKE_FIXED, REVOKE_PER_ID, MAX_ISSUE, "revokeReceipts");
        _check(claimMax, CLAIM_FIXED, CLAIM_PER_ID, MAX_CLAIM, "claimBatch");
        _check(
            distClaimRangeMax,
            DIST_CLAIM_RANGE_FIXED,
            DIST_CLAIM_RANGE_PER_ITEM,
            MAX_DISTRIBUTOR_CLAIM,
            "distributor claimRange"
        );
        _check(
            distClaimBatchMax,
            DIST_CLAIM_BATCH_FIXED,
            DIST_CLAIM_BATCH_PER_ITEM,
            MAX_DISTRIBUTOR_CLAIM,
            "distributor claimBatch"
        );
        _check(
            deployMax, DIST_DEPLOY_FIXED, DIST_DEPLOY_PER_CONTRIBUTOR, maxContributors, "distributor deploy"
        );
    }

    function _check(uint256 measured, uint256 fixedGas, uint256 perItem, uint256 items, string memory kind)
        internal
        pure
    {
        uint256 modelled = fixedGas + perItem * items;
        assertLe(measured, modelled, string.concat(kind, ": measured above the model"));
        assertLe(modelled, BATCH_GAS_BUDGET, string.concat(kind, ": model at the maximum above the budget"));
    }
}
