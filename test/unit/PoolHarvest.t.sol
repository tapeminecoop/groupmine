// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {MockMining} from "../helpers/Mocks.sol";

/// @dev Ported harvest/payment regressions plus multi-miner behaviour. S_N = S_L = 10.
contract PoolHarvestTest is SystemTestBase {
    function setUp() public override {
        super.setUp();
        setupStandard();
    }

    function _key(uint256 tokenId) internal view returns (bytes32) {
        return mining.minerKey(address(nft), tokenId);
    }

    function testHarvestCountsOnlyActualReceiptsOfTheSelectedMiners() public {
        admitNew(1, 1, 1);
        admitNew(2, 1, 1);
        admitNew(3, 1, 1);
        accrue(1, 40_000);
        accrue(2, 30_000);
        accrue(3, 32_000);
        (uint256 received, uint256 failed) = pool.harvest(two(1, 3));
        assertEq(received, 72_000);
        assertEq(failed, 0);
        assertEq(mining.pending(_key(2)), 30_000); // an estimate inside Mining is not income
        assertEq(pool.unrecognizedBalance(), 0);
        (received,) = pool.harvestRange(0, 100);
        assertEq(received, 30_000);
        assertReconciled();
    }

    function testHarvestAlwaysCallsClaimEvenWhenPendingIsZero() public {
        admitNew(1, 1, 1);
        mining.accrueUnsettled(address(nft), 1, 102_000);
        assertEq(mining.pending(_key(1)), 0);
        uint256 before = mining.claims();
        (uint256 received,) = pool.harvest(one(1));
        assertEq(received, 102_000);
        assertEq(mining.claims(), before + 1);
        assertEq(mining.lastCaller(), address(pool));
    }

    function testHarvestIsolatesFailingMiners() public {
        admitNew(1, 1, 1);
        admitNew(2, 1, 1);
        admitNew(3, 1, 1);
        accrue(1, 1_000);
        accrue(2, 5_000);
        accrue(3, 2_000);
        mining.setKeyBroken(address(nft), 2, true);
        vm.expectEmit(true, false, false, true, address(pool));
        emit TapeoutMinerPool.MinerHarvestFailed(2, abi.encodeWithSignature("Error(string)", "MINER_BROKEN"));
        (uint256 received, uint256 failed) = pool.harvestRange(0, 3);
        assertEq(received, 3_000);
        assertEq(failed, 1);
        assertEq(mining.pending(_key(2)), 5_000);
    }

    function testHarvestIncomeBelongsToTheCompositionCurrentWhenItArrives() public {
        admitNew(1, 1, 0); // NAND only
        accrue(1, 105_000);
        pool.harvest(one(1));
        assertEq(pool.accrual().nandIncome, 100_000);
        assertEq(pool.accrual().latchIncome, 0);
    }

    function testThirdPartyMiningClaimsAndDirectTransfersAreIncome() public {
        admitNew(1, 1, 1);
        accrue(1, 51_000);
        bytes32 key = _key(1);
        vm.prank(dave);
        mining.claim(key);
        assertEq(mining.lastCaller(), dave);
        assertEq(bem.balanceOf(dave), 0); // paid to the holder, the pool
        bem.mint(dave, 51_000);
        vm.prank(dave);
        bem.transfer(address(pool), 51_000);
        (uint256 received,) = pool.harvest(one(1));
        assertEq(received, 0);
        assertEq(pool.totalAccounted(), 102_000);
        assertReconciled();
    }

    function testUnknownMinerAndEmptyHarvests() public {
        admitNew(1, 1, 1);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.UnknownMiner.selector, 2));
        pool.harvest(one(2));
        vm.expectRevert(TapeoutMinerPool.InvalidBatch.selector);
        pool.harvest(none());
        vm.expectRevert(TapeoutMinerPool.InvalidBatch.selector);
        pool.harvestRange(1, 1);
    }

    function testBalanceDecreaseAndTransferFeeRevertWithoutRewritingHistory() public {
        admitNew(1, 3, 1);
        bem.mint(address(pool), 105_000);
        claimAs(alice, one(1), none()); // 7_500
        bem.burn(address(pool), 1);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.BalanceDecreased.selector, 97_499, 97_500));
        pool.sync();
        assertEq(pool.reconciliation().deficit, 1);
        bem.mint(address(pool), 1);
        bem.setFaults(false, false, true);
        vm.prank(alice);
        vm.expectRevert(TapeoutMinerPool.UnexpectedTokenBehavior.selector);
        pool.claim(NAND, 2);
        assertEq(pool.claimed(NAND, 2), 0);
        bem.setFaults(false, true, false);
        vm.prank(alice);
        vm.expectRevert("BEM_TRANSFER_BROKEN");
        pool.claim(NAND, 2);
        bem.setFaults(false, false, false);
        vm.prank(alice);
        assertEq(pool.claim(NAND, 2), 7_500);
        assertReconciled();
    }

    function testMinerRegistryViews() public {
        admitNew(11, 2, 3);
        admitNew(12, 4, 0);
        assertEq(pool.minerCount(), 2);
        (uint256 tokenId, bytes32 key) = pool.minerAt(1);
        assertEq(tokenId, 12);
        assertEq(key, _key(12));
        TapeoutMinerPool.Miner memory m = pool.miner(11);
        assertEq(m.nandBurn, 2);
        assertEq(m.latchBurn, 3);
        assertEq(m.admittedInPeriod, 1);
        assertTrue(m.registered);
        (uint256[] memory ids,) = pool.minersPage(0, 10);
        assertEq(ids.length, 2);
        assertEq(pool.totalNandBurn(), 6);
        assertEq(pool.totalLatchBurn(), 3);
        vm.expectRevert(TapeoutMinerPool.InvalidPage.selector);
        pool.minersPage(3, 1);
    }
}
