// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PoolTestBase} from "../helpers/PoolTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {MockMining, MockNFT} from "../helpers/Mocks.sol";

contract PoolHarvestTest is PoolTestBase {
    address internal dave = makeAddr("dave");

    function setUp() public override {
        super.setUp();
        setupDefault();
    }

    function _key(uint256 tokenId) internal view returns (bytes32) {
        return mining.minerKey(address(nft), tokenId);
    }

    function testHarvestCollectsSelectedMinersAndAccountsOnlyActualReceipts() public {
        newMinersDeposited(1, 3);
        mining.accrue(address(nft), 1, 40_000);
        mining.accrue(address(nft), 2, 30_000);
        mining.accrue(address(nft), 3, 32_000);
        uint256[] memory some = new uint256[](2);
        some[0] = 1;
        some[1] = 3;
        (uint256 received, uint256 failed) = pool.harvest(some);
        assertEq(received, 72_000);
        assertEq(failed, 0);
        assertEq(pool.totalAccounted(), 72_000);
        // Miner 2's income is still inside Mining: estimated but not received, so not accounted.
        assertEq(mining.pending(_key(2)), 30_000);
        assertEq(pool.unrecognizedBalance(), 0);
        (received, failed) = pool.harvestRange(0, 100); // clamped to the registry
        assertEq(received, 30_000);
        assertEq(pool.totalAccounted(), 102_000);
        assertEq(pool.claimable(NAND, 1), 8_000);
        assertReconciled();
    }

    function testIncomeAccruedBeforeDepositBelongsToThePool() public {
        newMiner(7);
        mining.accrue(address(nft), 7, 60_000); // earned while the operator held it
        mining.accrueUnsettled(address(nft), 7, 42_000); // and some that pending() does not show
        assertEq(mining.pending(_key(7)), 60_000);
        depositMiners(one(7));
        assertEq(bem.balanceOf(operator), 0);
        assertEq(bem.balanceOf(address(pool)), 102_000);
        // Deposit after activation syncs immediately; the income follows the normal rules.
        assertEq(pool.totalAccounted(), 102_000);
        assertEq(pool.feeClaimable(), 2_000);
        assertEq(pool.claimable(NAND, 9), 8_000);
        assertEq(pool.historicalClaimable(LATCH), 4_000);
        assertReconciled();
    }

    /// @notice Regression of the baseline fork finding: pending()==0 while claim() pays.
    function testHarvestAlwaysCallsClaimEvenWhenPendingIsZero() public {
        uint256[] memory miners = newMinersDeposited(1, 2);
        mining.accrueUnsettled(address(nft), 1, 51_000);
        mining.accrueUnsettled(address(nft), 2, 51_000);
        assertEq(mining.pending(_key(1)), 0);
        assertEq(mining.pending(_key(2)), 0);
        uint256 claimsBefore = mining.claims();
        (uint256 received,) = pool.harvest(miners);
        assertEq(mining.claims(), claimsBefore + 2);
        assertEq(received, 102_000);
        assertEq(mining.lastCaller(), address(pool));
        // A second harvest with nothing new still calls claim and accounts zero.
        (received,) = pool.harvest(miners);
        assertEq(mining.claims(), claimsBefore + 4);
        assertEq(received, 0);
        assertReconciled();
    }

    function testHarvestReportsFailingMinerWithoutBlockingOthers() public {
        uint256[] memory miners = newMinersDeposited(1, 3);
        mining.accrue(address(nft), 1, 1_000);
        mining.accrue(address(nft), 2, 5_000);
        mining.accrue(address(nft), 3, 2_000);
        mining.setKeyBroken(address(nft), 2, true);
        vm.expectEmit(true, false, false, true, address(pool));
        emit TapeoutMinerPool.MinerHarvested(1, 1_000);
        vm.expectEmit(true, false, false, true, address(pool));
        emit TapeoutMinerPool.MinerHarvestFailed(2, abi.encodeWithSignature("Error(string)", "MINER_BROKEN"));
        vm.expectEmit(true, false, false, true, address(pool));
        emit TapeoutMinerPool.MinerHarvested(3, 2_000);
        vm.expectEmit(true, false, false, true, address(pool));
        emit TapeoutMinerPool.Harvested(address(this), 3, 1, 3_000);
        (uint256 received, uint256 failed) = pool.harvest(miners);
        assertEq(received, 3_000);
        assertEq(failed, 1);
        // The failed miner's income is untouched and is collected once it works again.
        assertEq(mining.pending(_key(2)), 5_000);
        mining.setKeyBroken(address(nft), 2, false);
        (received, failed) = pool.harvest(one(2));
        assertEq(received, 5_000);
        assertEq(failed, 0);
        assertReconciled();
    }

    function testMiningOutageFailsHarvestsButNotClaims() public {
        uint256[] memory miners = newMinersDeposited(1, 2);
        mining.accrue(address(nft), 1, 102_000);
        pool.harvest(miners);
        mining.setBroken(true);
        (uint256 received, uint256 failed) = pool.harvestRange(0, 2);
        assertEq(received, 0);
        assertEq(failed, 2);
        assertEq(claimAs(bob, range(6, 9), none()), 32_000);
        assertReconciled();
    }

    function testUnknownMinerAndEmptyHarvestRevert() public {
        newMinersDeposited(1, 1);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.UnknownMiner.selector, 2));
        pool.harvest(one(2));
        vm.expectRevert(TapeoutMinerPool.InvalidBatch.selector);
        pool.harvest(none());
        vm.expectRevert(TapeoutMinerPool.InvalidBatch.selector);
        pool.harvestRange(1, 1);
        vm.expectRevert(TapeoutMinerPool.InvalidBatch.selector);
        pool.harvestRange(0, 0);
    }

    function testThirdPartyMiningClaimsAndDirectTransfersAreIncome() public {
        newMinersDeposited(1, 1);
        mining.accrue(address(nft), 1, 51_000);
        bytes32 key = _key(1);
        vm.prank(dave);
        mining.claim(key); // permissionless claim pays the holder: the pool
        assertEq(mining.lastCaller(), dave);
        assertEq(bem.balanceOf(dave), 0);
        bem.mint(dave, 51_000);
        vm.prank(dave);
        bem.transfer(address(pool), 51_000);
        (uint256 received,) = pool.harvest(one(1));
        assertEq(received, 0); // harvest reports only what its own claims brought in
        assertEq(pool.totalAccounted(), 102_000); // the earlier inflow was recognized first
        assertReconciled();
    }

    function testRegistrationValidatesCollectionOwnershipAndMiningKey() public {
        // Not started in Mining: the real claim path rejects it, so registration fails.
        nft.mint(operator, 50);
        vm.startPrank(operator);
        nft.setApprovalForAll(address(pool), true);
        vm.expectRevert(abi.encodeWithSelector(MockMining.UnknownMinerKey.selector, _key(50)));
        pool.depositMiners(one(50));
        vm.stopPrank();
        assertEq(nft.ownerOf(50), operator);

        newMinersDeposited(1, 1);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.MinerAlreadyRegistered.selector, 1));
        pool.registerMiners(one(1));

        newMiner(2);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.MinerNotHeld.selector, 2));
        pool.registerMiners(one(2));

        // ERC-721 safe transfers are refused; the pool has no receiver hook.
        vm.prank(operator);
        vm.expectRevert();
        nft.safeTransferFrom(operator, address(pool), 2);
        // A plain transfer lands unregistered and can then be registered by the owner.
        vm.prank(operator);
        nft.transferFrom(operator, address(pool), 2);
        assertFalse(pool.isMiner(2));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pool.registerMiners(one(2));
        vm.prank(operator);
        pool.registerMiners(one(2));
        assertTrue(pool.isMiner(2));

        // Another collection's NFT cannot be deposited: the pool only pulls from its collection.
        MockNFT other = new MockNFT();
        other.mint(operator, 3);
        vm.prank(operator);
        vm.expectRevert();
        pool.depositMiners(one(3)); // operator does not own token 3 of the configured collection

        newMiner(4);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pool.depositMiners(one(4));
    }

    function testRegistrationNeedsAWorkingClaimPath() public {
        newMiner(1);
        mining.setBroken(true);
        vm.startPrank(operator);
        nft.setApprovalForAll(address(pool), true);
        vm.expectRevert("MINING_BROKEN");
        pool.depositMiners(one(1));
        vm.stopPrank();
        assertEq(pool.minerCount(), 0);
        assertEq(nft.ownerOf(1), operator);
    }

    function testMinerRegistryViews() public {
        uint256[] memory miners = newMinersDeposited(11, 5);
        assertEq(pool.minerCount(), 5);
        (uint256 tokenId, bytes32 key) = pool.minerAt(3);
        assertEq(tokenId, 14);
        assertEq(key, _key(14));
        assertEq(pool.minerKeyOf(15), _key(15));
        (uint256[] memory page, bytes32[] memory keys) = pool.minersPage(2, 10);
        assertEq(page.length, 3);
        assertEq(page[0], miners[2]);
        assertEq(keys[2], _key(15));
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.UnknownMiner.selector, 99));
        pool.minerKeyOf(99);
        vm.expectRevert(TapeoutMinerPool.InvalidPage.selector);
        pool.minersPage(6, 1);
    }

    /// @notice Regressions from the baseline: abnormal decreases and transfer fees are never
    ///         absorbed silently, and a failed payment leaves the history untouched.
    function testBalanceDecreaseAndTransferFeeRevertWithoutRewritingHistory() public {
        bem.mint(address(pool), 102_000);
        claimAs(alice, one(1), none());
        bem.burn(address(pool), 1);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.BalanceDecreased.selector, 93_999, 94_000));
        pool.sync();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.BalanceDecreased.selector, 93_999, 94_000));
        pool.claim(NAND, 2);
        TapeoutMinerPool.Reconciliation memory r = pool.reconciliation();
        assertEq(r.deficit, 1);
        bem.mint(address(pool), 1);
        bem.setFaults(false, false, true);
        vm.prank(alice);
        vm.expectRevert(TapeoutMinerPool.UnexpectedTokenBehavior.selector);
        pool.claim(NAND, 2);
        assertEq(pool.claimed(NAND, 2), 0);
        bem.setFaults(false, false, false);
        vm.prank(alice);
        assertEq(pool.claim(NAND, 2), 8_000);
        assertReconciled();
    }

    function testBrokenTokenTransferRollsBackClaim() public {
        bem.mint(address(pool), 102_000);
        bem.setFaults(false, true, false);
        vm.prank(alice);
        vm.expectRevert("BEM_TRANSFER_BROKEN");
        pool.claim(NAND, 1);
        assertEq(pool.claimed(NAND, 1), 0);
        assertEq(pool.totalPaid(), 0);
    }
}
