// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {PoolTestBase} from "../helpers/PoolTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutReceipt} from "../../src/TapeoutReceipt.sol";

contract PoolSetupTest is PoolTestBase {
    function testDeploymentBindsTwoReceiptCollectionsAndProtocol() public view {
        assertEq(pool.owner(), operator);
        assertEq(address(pool.bem()), address(bem));
        assertEq(address(pool.mining()), address(mining));
        assertEq(address(pool.minerCollection()), address(nft));
        assertEq(pool.poolName(), "TapeOut Pool Test");
        assertFalse(pool.active());
        assertTrue(address(nand) != address(latch));
        assertEq(nand.pool(), address(pool));
        assertEq(latch.pool(), address(pool));
        assertEq(nand.name(), "TapeOut NAND Receipt");
        assertEq(latch.symbol(), "tLATCH");
        assertEq(nand.uri(7), "ipfs://nand/{id}.json");
        assertEq(address(pool.receiptOf(NAND)), address(nand));
        assertEq(address(pool.receiptOf(LATCH)), address(latch));
        assertTrue(nand.supportsInterface(0xd9b67a26)); // ERC-1155
        assertEq(pool.WEIGHT_SCALE(), 100_000_000);
        assertEq(pool.FEE_PARTS(), 2);
        assertEq(pool.TOTAL_PARTS(), 102);
    }

    function testConstructorRejectsMissingProtocolCodeAndBadName() public {
        TapeoutMinerPool.Deployment memory d = TapeoutMinerPool.Deployment({
            owner: operator,
            bem: address(bem),
            mining: address(0xBEEF),
            minerCollection: address(nft),
            poolName: "x",
            nand: TapeoutMinerPool.ReceiptMetadata("n", "n", ""),
            latch: TapeoutMinerPool.ReceiptMetadata("l", "l", "")
        });
        vm.expectRevert(TapeoutMinerPool.InvalidAddress.selector);
        new TapeoutMinerPool(d);
        d.mining = address(mining);
        d.poolName = "";
        vm.expectRevert(TapeoutMinerPool.InvalidName.selector);
        new TapeoutMinerPool(d);
        d.poolName = "TapeOut pool name that is far too long to be accepted by the constructor check";
        vm.expectRevert(TapeoutMinerPool.InvalidName.selector);
        new TapeoutMinerPool(d);
        d.poolName = "ok";
        d.owner = address(0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new TapeoutMinerPool(d);
    }

    function testConfigureValidationAndOwnerOnly() public {
        TapeoutMinerPool.Config memory c = defaultConfig();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pool.configure(c);

        c.nandWeight = W + 1;
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.InvalidWeight.selector, uint256(W) + 1));
        pool.configure(c);

        c = defaultConfig();
        c.feeRecipient = address(pool);
        vm.prank(operator);
        vm.expectRevert(TapeoutMinerPool.InvalidAddress.selector);
        pool.configure(c);

        configure(defaultConfig());
        assertEq(pool.currentConfigHash(), pool.configHash(defaultConfig()));
        // Reconfiguration during setup is allowed and replaces the whole config.
        configure(cfg(12, 4, 0, 0, 50_000_000));
        assertEq(pool.shareCount(NAND), 12);
        assertEq(pool.historicalShareCount(NAND), 0);
    }

    function testShareCountCannotDropBelowAnIssuedId() public {
        configure(defaultConfig());
        issueRange(NAND, alice, 7, 3); // IDs 7..9
        TapeoutMinerPool.Config memory c = defaultConfig();
        c.nandShares = 8;
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.ShareCountBelowIssued.selector, NAND, 8, 9));
        pool.configure(c);
        c.nandShares = 20; // raising is fine
        configure(c);
        assertEq(pool.shareCount(NAND), 20);
    }

    function testIssuanceChecksRangeDuplicatesRecipientsAndOwner() public {
        configure(defaultConfig());
        address[] memory to = new address[](2);
        to[0] = alice;
        to[1] = bob;
        uint256[] memory ids = new uint256[](2);

        ids[0] = 0;
        ids[1] = 1;
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.ReceiptIdOutOfRange.selector, NAND, 0));
        pool.issueReceipts(NAND, to, ids);

        ids[0] = 1;
        ids[1] = 10;
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.ReceiptIdOutOfRange.selector, NAND, 10));
        pool.issueReceipts(NAND, to, ids);

        ids[1] = 1; // duplicate inside one call
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TapeoutReceipt.AlreadyMinted.selector, 1));
        pool.issueReceipts(NAND, to, ids);

        vm.prank(operator);
        vm.expectRevert(TapeoutMinerPool.InvalidBatch.selector);
        pool.issueReceipts(NAND, to, one(1));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pool.issueReceiptRange(NAND, alice, 1, 1);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InvalidReceiver.selector, address(0)));
        pool.issueReceiptRange(NAND, address(0), 1, 1);

        // A contract without ERC-1155 receiver support cannot be issued receipts.
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InvalidReceiver.selector, address(bem)));
        pool.issueReceiptRange(NAND, address(bem), 1, 1);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.ReceiptIdOutOfRange.selector, LATCH, 5));
        pool.issueReceiptRange(LATCH, alice, 2, 4);

        ids[1] = 2;
        vm.prank(operator);
        pool.issueReceipts(NAND, to, ids);
        assertEq(nand.holderOf(1), alice);
        assertEq(nand.holderOf(2), bob);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TapeoutReceipt.AlreadyMinted.selector, 2));
        pool.issueReceiptRange(NAND, carol, 2, 1);
        // Same numeric ID in the other collection is a separate token.
        issueRange(LATCH, carol, 1, 1);
        assertEq(latch.holderOf(1), carol);
        assertEq(nand.holderOf(1), alice);
    }

    function testRevokeAndReissueOnlyBeforeActivation() public {
        configure(defaultConfig());
        issueRange(NAND, alice, 1, 9);
        vm.prank(operator);
        pool.revokeReceipts(NAND, one(4));
        assertEq(nand.holderOf(4), address(0));
        assertEq(nand.totalSupply(), 8);
        assertEq(nand.balanceOf(alice, 4), 0);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TapeoutReceipt.NotMinted.selector, 4));
        pool.revokeReceipts(NAND, one(4));
        issueRange(NAND, bob, 4, 1);
        assertEq(nand.holderOf(4), bob);
        issueRange(LATCH, alice, 1, 4);
        activate();
        vm.prank(operator);
        vm.expectRevert(TapeoutMinerPool.AlreadyActive.selector);
        pool.revokeReceipts(NAND, one(4));
        // Even the pool itself can no longer mint or burn.
        vm.prank(address(pool));
        vm.expectRevert(TapeoutReceipt.MintingClosed.selector);
        nand.burn(4);
        vm.prank(address(pool));
        vm.expectRevert(TapeoutReceipt.MintingClosed.selector);
        nand.mint(alice, 10);
    }

    function testOnlyPoolCanMintBurnFinalizeOrSetUri() public {
        vm.startPrank(operator);
        vm.expectRevert(TapeoutReceipt.OnlyPool.selector);
        nand.mint(operator, 1);
        vm.expectRevert(TapeoutReceipt.OnlyPool.selector);
        nand.finalizeMinting();
        vm.expectRevert(TapeoutReceipt.OnlyPool.selector);
        nand.setURI("x");
        vm.stopPrank();
        vm.prank(operator);
        pool.setReceiptURI(LATCH, "ipfs://new/{id}");
        assertEq(latch.uri(1), "ipfs://new/{id}");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pool.setReceiptURI(LATCH, "ipfs://evil/{id}");
    }

    function testActivationRequiresCompleteIssuanceRecipientsAndReviewedHash() public {
        TapeoutMinerPool.Config memory c = defaultConfig();
        c.feeRecipient = address(0);
        configure(c);
        issueRange(NAND, alice, 1, 9);
        issueRange(LATCH, alice, 1, 4);
        bytes32 h = pool.currentConfigHash();
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(TapeoutMinerPool.MissingRecipient.selector, TapeoutMinerPool.Recipient.FEE)
        );
        pool.activate(h);

        c = defaultConfig();
        c.historicalLatchRecipient = address(0);
        configure(c);
        h = pool.currentConfigHash();
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                TapeoutMinerPool.MissingRecipient.selector, TapeoutMinerPool.Recipient.HISTORICAL_LATCH
            )
        );
        pool.activate(h);

        c = defaultConfig();
        c.latchShares = 5; // one LATCH ID not issued yet
        configure(c);
        h = pool.currentConfigHash();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.IssuanceIncomplete.selector, LATCH, 4, 5));
        pool.activate(h);

        configure(defaultConfig());
        bytes32 current = pool.currentConfigHash();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.ConfigHashMismatch.selector, h, current));
        pool.activate(h); // stale hash from the reviewed-but-replaced config

        h = pool.currentConfigHash();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pool.activate(h);

        vm.prank(operator);
        pool.activate(h);
        assertTrue(pool.active());
        assertEq(pool.activatedAt(), block.timestamp);
        assertEq(pool.activationConfigHash(), h);
        assertTrue(nand.mintingFinalized());
        assertTrue(latch.mintingFinalized());
        vm.prank(operator);
        vm.expectRevert(TapeoutMinerPool.AlreadyActive.selector);
        pool.activate(h);
    }

    function testZeroDenominatorRejectedOnlyWhenTheCategoryHasWeight() public {
        // LATCH has weight but no shares at all.
        configure(cfg(4, 0, 0, 0, 60_000_000));
        issueRange(NAND, alice, 1, 4);
        bytes32 h = pool.currentConfigHash();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.ZeroDenominator.selector, LATCH));
        pool.activate(h);
        // Same shares with all weight on NAND is a valid pool.
        configure(cfg(4, 0, 0, 0, W));
        activate();
        assertTrue(pool.active());
    }

    function testHistoricalOnlyCategoryIsValid() public {
        // NAND income goes entirely to historical rights; no NAND receipts exist.
        configure(cfg(0, 4, 5, 0, 50_000_000));
        issueRange(LATCH, alice, 1, 4);
        activate();
        bem.mint(address(pool), 102_000);
        pool.sync();
        assertEq(pool.historicalClaimable(NAND), 50_000);
        assertEq(pool.claimable(LATCH, 1), 12_500);
        pool.releaseHistorical(NAND);
        assertEq(bem.balanceOf(histNandTo), 50_000);
        assertReconciled();
    }

    function testIssuanceStatusSeparatesActiveSharesFromCapacity() public {
        configure(defaultConfig());
        issueRange(NAND, alice, 1, 6);
        (uint256 shares, uint256 issued, uint256 remaining, bool finalized) = pool.issuance(NAND);
        assertEq(shares, 9);
        assertEq(issued, 6);
        assertEq(remaining, 3);
        assertFalse(finalized);
        issueRange(NAND, reserve, 7, 3); // unallocated shares parked with an explicit reserve holder
        issueRange(LATCH, alice, 1, 4);
        activate();
        (shares, issued, remaining, finalized) = pool.issuance(NAND);
        assertEq(shares, 9);
        assertEq(issued, 9);
        assertEq(remaining, 0);
        assertTrue(finalized);
        // Nothing beyond 1..S can ever exist.
        vm.prank(address(pool));
        vm.expectRevert(TapeoutReceipt.MintingClosed.selector);
        nand.mint(alice, 10);
    }

    function testActivationRecognizesBemReceivedDuringSetup() public {
        newMiner(1);
        mining.accrue(address(nft), 1, 70_000); // income accrued while the operator held the miner
        depositMiners(one(1)); // registration claim collects it into the pool
        bem.mint(address(pool), 32_000); // a direct transfer during setup
        assertEq(bem.balanceOf(address(pool)), 102_000);
        assertEq(pool.totalAccounted(), 0);
        setupDefault();
        assertEq(pool.totalAccounted(), 102_000);
        assertEq(pool.feeClaimable(), 2_000);
        assertReconciled();
    }

    function testOwnerLosesEconomicPowersAfterActivation() public {
        setupDefault();
        vm.startPrank(operator);
        vm.expectRevert(TapeoutMinerPool.AlreadyActive.selector);
        pool.configure(defaultConfig());
        vm.expectRevert(TapeoutMinerPool.AlreadyActive.selector);
        pool.issueReceiptRange(NAND, operator, 1, 1);
        vm.expectRevert(TapeoutMinerPool.Unauthorized.selector);
        pool.setRecipient(TapeoutMinerPool.Recipient.FEE, operator);
        vm.stopPrank();
        // Ownership itself is two-step.
        vm.prank(operator);
        pool.transferOwnership(alice);
        assertEq(pool.owner(), operator);
        vm.prank(alice);
        pool.acceptOwnership();
        assertEq(pool.owner(), alice);
    }

    function testClaimsAndHarvestRequireActivation() public {
        configure(defaultConfig());
        issueRange(NAND, alice, 1, 9);
        vm.prank(alice);
        vm.expectRevert(TapeoutMinerPool.NotActive.selector);
        pool.claim(NAND, 1);
        vm.expectRevert(TapeoutMinerPool.NotActive.selector);
        pool.harvestRange(0, 1);
        vm.expectRevert(TapeoutMinerPool.NotActive.selector);
        pool.sync();
        vm.expectRevert(TapeoutMinerPool.NotActive.selector);
        pool.releaseFee();
        assertEq(pool.claimable(NAND, 1), 0);
        assertEq(pool.feeClaimable(), 0);
    }

    function testReceiptHolderIndexFollowsTransfersAndPages() public {
        setupDefault();
        address[] memory page = nand.holdersPage(1, 10);
        assertEq(page[0], alice);
        assertEq(page[5], bob);
        assertEq(page[9], address(0)); // ID 10 does not exist
        vm.prank(alice);
        nand.safeTransferFrom(alice, carol, 2, 1, "");
        assertEq(nand.holderOf(2), carol);
        // Zero-value and self transfers leave the index unchanged.
        vm.prank(alice);
        nand.safeTransferFrom(alice, bob, 1, 0, "");
        assertEq(nand.holderOf(1), alice);
        vm.prank(alice);
        nand.safeTransferFrom(alice, alice, 1, 1, "");
        assertEq(nand.holderOf(1), alice);
        // A duplicated ID in a batch cannot move more than one unit.
        uint256[] memory dup = new uint256[](2);
        dup[0] = 3;
        dup[1] = 3;
        uint256[] memory ones = new uint256[](2);
        ones[0] = 1;
        ones[1] = 1;
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC1155Errors.ERC1155InsufficientBalance.selector, alice, 0, 1, 3)
        );
        nand.safeBatchTransferFrom(alice, bob, dup, ones, "");
        assertEq(nand.holderOf(3), alice);
        assertEq(nand.totalSupply(3), 1);
        vm.expectRevert(TapeoutReceipt.InvalidPage.selector);
        nand.holdersPage(0, 1);
    }
}
