// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {RecoverableTapeoutMinerPool as Canary} from "../../src/canary/RecoverableTapeoutMinerPool.sol";
import {CanaryParticipant} from "../../src/canary/CanaryParticipant.sol";
import {TapeoutEntitlementReceipt as Entitlement} from "../../src/TapeoutEntitlementReceipt.sol";
import {MockNFT, MockBEM, MockMining} from "../helpers/Mocks.sol";

contract CanaryRecoveryTest is Test {
    address internal wallet = makeAddr("original-wallet");
    address internal stranger = makeAddr("stranger");
    MockNFT internal nft;
    MockBEM internal bem;
    MockMining internal mining;
    Entitlement internal nand;
    Entitlement internal latch;
    Canary internal pool;
    CanaryParticipant internal helper;

    function setUp() public {
        nft = new MockNFT();
        bem = new MockBEM();
        mining = new MockMining(bem);
        nand = new Entitlement(keccak256("TAPEOUT_NAND_ENTITLEMENT"), "Canary NAND", "cN", "", wallet);
        latch = new Entitlement(keccak256("TAPEOUT_LATCH_ENTITLEMENT"), "Canary LATCH", "cL", "", wallet);
        helper = new CanaryParticipant(wallet, address(bem), address(nand), address(latch));
        address[] memory list = new address[](1);
        list[0] = wallet;
        pool = new Canary(
            Canary.Deployment(
                wallet,
                address(bem),
                address(mining),
                address(nft),
                address(nand),
                address(latch),
                wallet,
                address(helper),
                list,
                "RECOVERABLE CANARY"
            )
        );
        vm.prank(wallet);
        helper.bindPool(pool);
        nft.mint(wallet, 3204);
        nft.mint(wallet, 12485);
        mining.start(address(nft), 3204, 2, 0);
        mining.start(address(nft), 12485, 1, 1);
    }

    function activate() internal {
        vm.startPrank(wallet);
        nand.issue(wallet, 4);
        latch.issue(wallet, 2);
        nand.finalizeIssuance();
        latch.finalizeIssuance();
        pool.activate(4, 2);
        pool.renounceOwnership();
        vm.stopPrank();
    }

    function one(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    function deposit(uint256 id) internal {
        vm.startPrank(wallet);
        nft.approve(address(pool), id);
        pool.depositMiners(one(id));
        vm.stopPrank();
    }

    function closeAndReturn() internal {
        vm.startPrank(wallet);
        pool.shutdown();
        pool.emergencyReturn(3204);
        pool.emergencyReturn(12485);
        vm.stopPrank();
        assertEq(nft.ownerOf(3204), wallet);
        assertEq(nft.ownerOf(12485), wallet);
        assertTrue(pool.closed());
    }

    function testNormalHarvestShutdownBothReturnsAfterRenunciation() public {
        activate();
        deposit(3204);
        deposit(12485);
        mining.accrue(address(nft), 3204, 10200);
        pool.harvest(one(3204));
        closeAndReturn();
        assertEq(pool.owner(), address(0));
        vm.startPrank(wallet);
        assertEq(pool.claimBatch(one(1), one(1)), 1875 + 1250);
        pool.releaseA();
        pool.releaseB();
        vm.stopPrank();
        assertEq(bem.balanceOf(address(helper)), 100);
    }

    function testEmergencyHasNoMiningOrBEMCallsEvenWhenTheyConsumeAllGas() public {
        activate();
        deposit(3204);
        deposit(12485);
        // Invalid opcode would consume forwarded gas on ANY external call to these dependencies.
        vm.etch(address(mining), hex"fe");
        vm.etch(address(bem), hex"fe");
        vm.startPrank(wallet);
        pool.shutdown();
        pool.emergencyReturn{gas: 120000}(3204);
        pool.emergencyReturn{gas: 120000}(12485);
        vm.stopPrank();
        assertEq(nft.ownerOf(3204), wallet);
        assertEq(nft.ownerOf(12485), wallet);
    }

    function testMiningFailureAndBEMBalanceFailureDoNotBlockRecovery() public {
        activate();
        deposit(3204);
        deposit(12485);
        mining.setBroken(true);
        bem.setFaults(true, false, false);
        vm.expectRevert();
        pool.harvest(one(3204));
        closeAndReturn();
    }

    function testTransferFailurePreservesUnpaidLedgerAndRetryAfterReturn() public {
        activate();
        deposit(3204);
        deposit(12485);
        mining.accrue(address(nft), 3204, 10200);
        pool.harvest(one(3204));
        bem.setFaults(false, true, false);
        vm.prank(wallet);
        vm.expectRevert();
        pool.claim(Canary.Category.NAND, 1);
        assertEq(pool.claimed(Canary.Category.NAND, 1), 0);
        closeAndReturn();
        bem.setFaults(false, false, false);
        vm.prank(wallet);
        assertEq(pool.claim(Canary.Category.NAND, 1), 1875);
    }

    function testPartialReturnDoesNotPreventOtherAndRetriesAreIdempotent() public {
        activate();
        deposit(3204);
        deposit(12485);
        vm.mockCallRevert(
            address(nft), abi.encodeCall(nft.transferFrom, (address(pool), wallet, 3204)), "NFT_FAILURE"
        );
        vm.startPrank(wallet);
        pool.shutdown();
        vm.expectRevert();
        pool.emergencyReturn(3204);
        pool.emergencyReturn(12485);
        assertEq(nft.ownerOf(12485), wallet);
        assertEq(nft.ownerOf(3204), address(pool));
        vm.clearMockedCalls();
        pool.emergencyReturn(3204);
        pool.emergencyReturn(3204);
        pool.shutdown();
        vm.stopPrank();
        assertEq(nft.ownerOf(3204), wallet);
    }

    function testUnregisteredNFTBeforeActivationAndBeforeDistributionCanReturn() public {
        vm.startPrank(wallet);
        nft.transferFrom(wallet, address(pool), 3204);
        pool.renounceOwnership();
        pool.shutdown();
        pool.emergencyReturn(3204);
        vm.stopPrank();
        assertFalse(pool.miner(3204).registered);
        assertEq(nft.ownerOf(3204), wallet);
    }

    function testShutdownIsPermanentAndScopeCannotExpand() public {
        activate();
        deposit(3204);
        vm.startPrank(wallet);
        pool.shutdown();
        vm.expectRevert(Canary.CanaryClosed.selector);
        pool.depositMiners(one(12485));
        vm.expectRevert(Canary.CanaryClosed.selector);
        pool.registerMiners(one(12485));
        vm.expectRevert(Canary.CanaryClosed.selector);
        pool.harvest(one(3204));
        vm.expectRevert(Canary.CanaryClosed.selector);
        pool.harvestRange(0, 1);
        vm.expectRevert(abi.encodeWithSelector(Canary.UnauthorizedCanaryMiner.selector, 99));
        pool.emergencyReturn(99);
        vm.stopPrank();
    }

    function testShutdownBeforeActivationCannotReopen() public {
        vm.startPrank(wallet);
        pool.shutdown();
        vm.expectRevert(Canary.CanaryClosed.selector);
        pool.activate(4, 2);
        vm.stopPrank();
    }

    function testUnauthorizedCallerAndDestinationSelectorRejected() public {
        activate();
        deposit(3204);
        vm.prank(stranger);
        vm.expectRevert(Canary.NotRecoveryController.selector);
        pool.shutdown();
        vm.prank(wallet);
        pool.shutdown();
        vm.prank(stranger);
        vm.expectRevert(Canary.NotRecoveryController.selector);
        pool.emergencyReturn(3204);
        vm.prank(wallet);
        (bool ok,) =
            address(pool).call(abi.encodeWithSignature("emergencyReturn(uint256,address)", 3204, stranger));
        assertFalse(ok);
        assertEq(nft.ownerOf(3204), address(pool));
    }

    function testUnexpectedIDAndCompositionMismatchReject() public {
        activate();
        vm.prank(wallet);
        vm.expectRevert(abi.encodeWithSelector(Canary.UnauthorizedCanaryMiner.selector, 99));
        pool.depositMiners(one(99));
        mining.setCachedBurn(address(nft), 3204, true, 3, 0);
        vm.startPrank(wallet);
        nft.approve(address(pool), 3204);
        vm.expectRevert(abi.encodeWithSelector(Canary.CompositionMismatch.selector, 3204));
        pool.depositMiners(one(3204));
        vm.stopPrank();
    }

    function testBoundaryAndUnrecognizedBEMKeepHistoryAndFinalAttribution() public {
        activate();
        mining.accrueUnsettled(address(nft), 3204, 10200);
        deposit(3204);
        vm.prank(wallet);
        assertEq(pool.claim(Canary.Category.NAND, 1), 2500);
        // Already-held income plus pending-invisible income settled INSIDE second admission.
        bem.mint(address(pool), 10200);
        mining.accrueUnsettled(address(nft), 3204, 10200);
        mining.accrueUnsettled(address(nft), 12485, 10200);
        deposit(12485);
        assertEq(pool.nandBase(), 30000);
        assertEq(pool.latchBase(), 0);
        assertEq(pool.claimed(Canary.Category.NAND, 1), 2500);
        assertEq(pool.claimable(Canary.Category.NAND, 1), 6875);
        assertEq(pool.claimable(Canary.Category.LATCH, 1), 1250);
        // Already received, not yet synchronized; shutdown/recovery do not erase it.
        bem.mint(address(pool), 10200);
        closeAndReturn();
        assertEq(pool.claimable(Canary.Category.NAND, 1), 8750);
        vm.startPrank(wallet);
        nand.safeTransferFrom(wallet, address(helper), 1, 1, "");
        assertEq(helper.claim(one(1), new uint256[](0)), 8750);
        assertEq(helper.claim(one(1), new uint256[](0)), 0);
        vm.expectRevert(abi.encodeWithSelector(Canary.NotHolder.selector, Canary.Category.NAND, 1));
        pool.claim(Canary.Category.NAND, 1);
        vm.stopPrank();
    }

    function testHelperControlAndBindingAreNarrow() public {
        vm.prank(stranger);
        vm.expectRevert(CanaryParticipant.Unauthorized.selector);
        helper.forwardBEM();
        vm.prank(wallet);
        vm.expectRevert(CanaryParticipant.InvalidBinding.selector);
        helper.bindPool(pool);
        bem.mint(address(helper), 100);
        vm.prank(wallet);
        helper.forwardBEM();
        assertEq(bem.balanceOf(wallet), 100);
    }
}
