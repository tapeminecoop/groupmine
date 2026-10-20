// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PoolTestBase} from "../helpers/PoolTestBase.sol";

/// @notice Gas measurements with the mock protocol, written to reports/gas-local.json. Touched
///         accounts are cooled before each measurement so storage costs match a fresh transaction
///         (the 21_000 base cost is not included). Real Mining.claim costs more than the mock's;
///         see reports/fork-test.json for real harvest gas.
contract PoolGasTest is PoolTestBase {
    string internal constant KEY = "gas";

    function _cool() internal {
        vm.cool(address(pool));
        vm.cool(address(nand));
        vm.cool(address(latch));
        vm.cool(address(bem));
        vm.cool(address(mining));
        vm.cool(address(nft));
    }

    function testGasProfile() public {
        configure(cfg(1000, 200, 10, 5, 80_000_000));
        _cool();
        uint256 g = gasleft();
        issueRange(NAND, alice, 1, 200);
        uint256 issue200 = g - gasleft();
        issueRange(NAND, alice, 201, 300);
        issueRange(NAND, bob, 501, 500);
        issueRange(LATCH, alice, 1, 100);
        issueRange(LATCH, carol, 101, 100);
        activate();

        uint256[] memory ten = range(1, 10);
        for (uint256 i; i < 10; ++i) {
            newMiner(ten[i]);
        }
        _cool();
        g = gasleft();
        depositMiners(ten);
        uint256 deposit10 = g - gasleft();

        uint256[] memory fifty = range(11, 60);
        for (uint256 i; i < 50; ++i) {
            newMiner(fifty[i]);
        }
        depositMiners(fifty);
        for (uint256 id = 1; id <= 60; ++id) {
            mining.accrue(address(nft), id, 1_000_000 + id);
        }

        _cool();
        g = gasleft();
        pool.harvest(one(1));
        uint256 harvest1 = g - gasleft();
        _cool();
        g = gasleft();
        pool.harvestRange(1, 10);
        uint256 harvest10 = g - gasleft();
        _cool();
        g = gasleft();
        pool.harvestRange(11, 49);
        uint256 harvest49 = g - gasleft();

        _cool();
        vm.prank(alice);
        g = gasleft();
        pool.claim(NAND, 1);
        uint256 claim1 = g - gasleft();
        _cool();
        vm.prank(alice);
        g = gasleft();
        pool.claimBatch(range(2, 51), none());
        uint256 claim50 = g - gasleft();
        _cool();
        vm.prank(alice);
        g = gasleft();
        pool.claimBatch(range(52, 251), none());
        uint256 claim200 = g - gasleft();
        _cool();
        g = gasleft();
        pool.releaseFee();
        uint256 release = g - gasleft();

        vm.serializeUint(KEY, "issueRange200Ids", issue200);
        vm.serializeUint(KEY, "depositMiners10Mock", deposit10);
        vm.serializeUint(KEY, "harvest1MinerMock", harvest1);
        vm.serializeUint(KEY, "harvest10MinersMock", harvest10);
        vm.serializeUint(KEY, "harvest49MinersMock", harvest49);
        vm.serializeUint(KEY, "claim1IdFirstClaim", claim1);
        vm.serializeUint(KEY, "claimBatch50IdsFirstClaim", claim50);
        vm.serializeUint(KEY, "claimBatch200IdsFirstClaim", claim200);
        string memory out = vm.serializeUint(KEY, "releaseFee", release);
        vm.writeJson(out, "reports/gas-local.json");

        // Sanity bounds that keep recommended batch sizes far below a BSC block.
        assertLt(issue200, 15_000_000);
        assertLt(claim200, 8_000_000);
        assertLt(harvest49, 10_000_000);
    }
}
