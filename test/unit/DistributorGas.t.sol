// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {DistributorTestBase} from "../helpers/DistributorTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {HistoricalDistributor} from "../../src/HistoricalDistributor.sol";

/// @notice Gas measurements written to reports/gas-distributor.json. Touched accounts are cooled
///         before each measurement; the 21_000 base cost and calldata are not included (a deployment
///         transaction adds 53_000 plus calldata, about 0.2M for 400 contributors, on top).
contract DistributorGasTest is DistributorTestBase {
    string internal constant KEY = "distributorGas";

    function _list(uint256 n) internal pure returns (address[] memory a, uint96[] memory w) {
        a = new address[](n);
        w = new uint96[](n);
        for (uint256 i; i < n; ++i) {
            // Random-looking addresses (mostly non-zero bytes, like real calldata).
            a[i] = address(uint160(uint256(keccak256(abi.encode("contributor", i)))));
            w[i] = uint96(1_000 + i);
        }
        // Sort to satisfy the constructor.
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

    function _deploy(uint256 n) internal returns (HistoricalDistributor d, uint256 gasUsed) {
        (address[] memory a, uint96[] memory w) = _list(n);
        vm.cool(address(pool));
        vm.cool(address(bem));
        uint256 g = gasleft();
        d = new HistoricalDistributor(pool, NAND, a, w);
        gasUsed = g - gasleft();
    }

    function _cool(HistoricalDistributor d) internal {
        vm.cool(address(d));
        vm.cool(address(pool));
        vm.cool(address(bem));
    }

    function testGasProfile() public {
        (, uint256 deploy1) = _deploy(1);
        (, uint256 deploy100) = _deploy(100);
        (HistoricalDistributor d, uint256 deploy400) = _deploy(400);

        TapeoutMinerPool.Config memory c = cfg(9, 4, 1, 1, 80_000_000);
        c.historicalNandRecipient = address(d);
        setupAndActivate(c, alice, bob, alice, carol);
        bem.mint(address(pool), 102_000_000_000); // historical NAND 8_000_000_000 raw
        _cool(d);
        uint256 g = gasleft();
        d.releaseFromPool();
        uint256 release = g - gasleft();

        (address first,) = d.contributorAt(0);
        _cool(d);
        g = gasleft();
        d.claim(first);
        uint256 claim1 = g - gasleft();

        address[] memory batch = new address[](50);
        for (uint256 i; i < 50; ++i) {
            (batch[i],) = d.contributorAt(1 + i);
        }
        _cool(d);
        g = gasleft();
        d.claimBatch(batch);
        uint256 claimBatch50 = g - gasleft();

        _cool(d);
        g = gasleft();
        d.claimRange(51, 200);
        uint256 claimRange200 = g - gasleft();

        _cool(d);
        g = gasleft();
        d.reconciliation();
        uint256 reconciliation400 = g - gasleft();

        vm.serializeUint(KEY, "deploy1Contributor", deploy1);
        vm.serializeUint(KEY, "deploy100Contributors", deploy100);
        vm.serializeUint(KEY, "deploy400Contributors", deploy400);
        vm.serializeUint(KEY, "releaseFromPool", release);
        vm.serializeUint(KEY, "claim1FirstClaim", claim1);
        vm.serializeUint(KEY, "claimBatch50FirstClaims", claimBatch50);
        vm.serializeUint(KEY, "claimRange200FirstClaims", claimRange200);
        string memory out = vm.serializeUint(KEY, "reconciliationView400", reconciliation400);
        vm.writeJson(out, "reports/gas-distributor.json");

        // A full list stays within 3/4 of BSC's 2^24 per-transaction gas cap (BEP-652) including the
        // transaction's own cost (about 11.2M gas for the whole transaction, measured on Anvil).
        assertLt(deploy400, 12_000_000);
        assertLt(claimRange200, 15_000_000);
        assertLt(reconciliation400, 5_000_000);
        assertEq(d.totalPaid(), d.claimed(first) + _sum(d, batch) + _rangeSum(d, 51, 200));
    }

    function _sum(HistoricalDistributor d, address[] memory accounts) internal view returns (uint256 s) {
        for (uint256 i; i < accounts.length; ++i) {
            s += d.claimed(accounts[i]);
        }
    }

    function _rangeSum(HistoricalDistributor d, uint256 start, uint256 count)
        internal
        view
        returns (uint256 s)
    {
        for (uint256 i = start; i < start + count; ++i) {
            (address account,) = d.contributorAt(i);
            s += d.claimed(account);
        }
    }
}
