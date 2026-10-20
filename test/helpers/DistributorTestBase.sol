// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PoolTestBase} from "./PoolTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {HistoricalDistributor} from "../../src/HistoricalDistributor.sol";

abstract contract DistributorTestBase is PoolTestBase {
    /// @dev Returns copies of the two arrays sorted together by account (strictly ascending input
    ///      is what the constructor requires; the CLI produces the same order).
    function sortedList(address[] memory accounts, uint96[] memory weights)
        internal
        pure
        returns (address[] memory a, uint96[] memory w)
    {
        a = new address[](accounts.length);
        w = new uint96[](weights.length);
        for (uint256 i; i < accounts.length; ++i) {
            (address account, uint96 weight) = (accounts[i], weights[i]);
            uint256 j = i;
            while (j > 0 && a[j - 1] > account) {
                a[j] = a[j - 1];
                w[j] = w[j - 1];
                --j;
            }
            a[j] = account;
            w[j] = weight;
        }
    }

    function newDistributor(
        TapeoutMinerPool.Category category,
        address[] memory accounts,
        uint96[] memory weights
    ) internal returns (HistoricalDistributor) {
        (address[] memory a, uint96[] memory w) = sortedList(accounts, weights);
        return new HistoricalDistributor(pool, category, a, w);
    }

    /// @dev `count` labelled contributor accounts ("contributor-0", ...), unsorted.
    function contributors(uint256 count) internal returns (address[] memory accounts) {
        accounts = new address[](count);
        for (uint256 i; i < count; ++i) {
            accounts[i] = makeAddr(string.concat("contributor-", vm.toString(i)));
        }
    }

    function pair(address a, address b) internal pure returns (address[] memory r) {
        r = new address[](2);
        (r[0], r[1]) = (a, b);
    }

    function triple(address a, address b, address c) internal pure returns (address[] memory r) {
        r = new address[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }

    function weights2(uint96 a, uint96 b) internal pure returns (uint96[] memory r) {
        r = new uint96[](2);
        (r[0], r[1]) = (a, b);
    }

    function weights3(uint96 a, uint96 b, uint96 c) internal pure returns (uint96[] memory r) {
        r = new uint96[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }

    /// @dev Ledger identities, the residue bound, and per-contributor histories: no contributor was
    ///      paid more than its cumulative entitlement and the histories sum to exactly totalPaid.
    function assertDistributorReconciled(HistoricalDistributor d) internal view {
        HistoricalDistributor.Reconciliation memory r = d.reconciliation();
        assertEq(r.deficit, 0, "deficit");
        assertEq(r.bemBalance, r.totalAccounted - r.totalPaid + r.unrecognized, "balance identity");
        assertEq(r.entitled + r.residue, r.totalAccounted, "accrued identity");
        uint256 n = d.contributorCount();
        assertLe(r.residue, n - 1, "residue bound");
        uint256 sumClaimed;
        uint256 sumEntitled;
        for (uint256 offset; offset < n; offset += d.MAX_PAGE()) {
            (address[] memory accounts, uint256[] memory w, uint256[] memory c) =
                d.contributorsPage(offset, d.MAX_PAGE());
            for (uint256 i; i < accounts.length; ++i) {
                uint256 entitled = Math.mulDiv(r.totalAccounted, w[i], d.totalWeight());
                assertLe(c[i], entitled, "overpaid contributor");
                assertEq(d.claimed(accounts[i]), c[i], "page claimed");
                sumClaimed += c[i];
                sumEntitled += entitled;
            }
        }
        assertEq(sumClaimed, r.totalPaid, "claimed histories sum to paid");
        assertEq(sumEntitled, r.entitled, "entitled sum");
    }
}
