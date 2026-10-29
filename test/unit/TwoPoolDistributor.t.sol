// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutEntitlementReceipt} from "../../src/TapeoutEntitlementReceipt.sol";
import {TapeoutReceiptDistributor} from "../../src/TapeoutReceiptDistributor.sol";
import {MockBEM, MockMining, MockNFT} from "../helpers/Mocks.sol";

/// @notice 2.3.0 (new code, not covered by the SALUS assessment or the internal reviews): one
///         TapeoutReceiptDistributor serves a processor's two custody pools, the Optimal Pool (`pool`) and
///         the Regular Pool (`regularPool`), which share one NAND/LATCH receipt pair. The distributor
///         allocates and delivers each receipt once; each pool binds it once, activates, holds custody and
///         accounts on its own; a holder claims a receipt's income from each pool independently.
///         The round: NAND 1-6 and LATCH 1-4 issued into the distributor and allocated in one full round to
///         alice (NAND 1-4, LATCH 1-2), bob (NAND 5-6) and carol (LATCH 3-4).
///         Income: the optimal pool's miner 1 burns 3:1 and earns 840,000 raw per period (NAND 100,000 and
///         LATCH 50,000 per receipt); the regular pool's miner 2 burns 1:3 and earns 1,260,000 raw per
///         period (NAND 50,000 and LATCH 225,000 per receipt).
contract TwoPoolDistributorTest is SystemTestBase {
    address internal constant SINK = 0x000000000000000000000000000000000000dEaD;

    // ---------------------------------------------------------------------------------- construction

    function testOneDistributorIsFixedToTwoDistinctPoolsSharingTheReceipts() public view {
        assertEq(address(distributor.optimalPool()), address(pool));
        assertEq(address(distributor.regularPool()), address(regularPool));
        assertTrue(address(pool) != address(regularPool));
        assertEq(address(distributor.nandReceipt()), address(nandReceipt));
        assertEq(address(distributor.latchReceipt()), address(latchReceipt));
        assertEq(address(regularPool.nandReceipt()), address(pool.nandReceipt()));
        assertEq(address(regularPool.latchReceipt()), address(pool.latchReceipt()));
        assertTrue(distributor.isPool(address(pool)));
        assertTrue(distributor.isPool(address(regularPool)));
        assertFalse(distributor.isPool(address(0)));
        assertFalse(distributor.isPool(address(distributor)));
        assertFalse(distributor.isPool(address(nandReceipt)));
        assertFalse(distributor.isPool(operator));
    }

    function testConstructorRejectsZeroAndNonContractPools() public {
        TapeoutMinerPool none_ = TapeoutMinerPool(address(0));
        TapeoutMinerPool eoa = TapeoutMinerPool(alice);
        vm.expectRevert(TapeoutReceiptDistributor.InvalidAddress.selector);
        new TapeoutReceiptDistributor(operator, none_, regularPool);
        vm.expectRevert(TapeoutReceiptDistributor.InvalidAddress.selector);
        new TapeoutReceiptDistributor(operator, pool, none_);
        vm.expectRevert(TapeoutReceiptDistributor.InvalidAddress.selector);
        new TapeoutReceiptDistributor(operator, none_, none_);
        vm.expectRevert(TapeoutReceiptDistributor.InvalidAddress.selector);
        new TapeoutReceiptDistributor(operator, eoa, regularPool);
        vm.expectRevert(TapeoutReceiptDistributor.InvalidAddress.selector);
        new TapeoutReceiptDistributor(operator, pool, eoa);
        // A contract that is not a pool has none of the views the constructor compares.
        vm.expectRevert();
        new TapeoutReceiptDistributor(operator, pool, TapeoutMinerPool(address(nandReceipt)));
    }

    function testConstructorRejectsTheSamePoolTwice() public {
        vm.expectRevert(TapeoutReceiptDistributor.DuplicatePool.selector);
        new TapeoutReceiptDistributor(operator, pool, pool);
        vm.expectRevert(TapeoutReceiptDistributor.DuplicatePool.selector);
        new TapeoutReceiptDistributor(operator, regularPool, regularPool);
    }

    function testConstructorRejectsPoolsWithOtherReceipts() public {
        TapeoutMinerPool.Deployment memory d = deployment(whitelist());
        d.nandReceipt =
            address(new TapeoutEntitlementReceipt(NAND_CATEGORY, "Other NAND", "oN", "", operator));
        TapeoutMinerPool otherNand = new TapeoutMinerPool(d);
        d = deployment(whitelist());
        d.latchReceipt =
            address(new TapeoutEntitlementReceipt(LATCH_CATEGORY, "Other LATCH", "oL", "", operator));
        TapeoutMinerPool otherLatch = new TapeoutMinerPool(d);
        vm.expectRevert(TapeoutReceiptDistributor.IncompatiblePoolReceipts.selector);
        new TapeoutReceiptDistributor(operator, pool, otherNand);
        vm.expectRevert(TapeoutReceiptDistributor.IncompatiblePoolReceipts.selector);
        new TapeoutReceiptDistributor(operator, otherNand, regularPool);
        vm.expectRevert(TapeoutReceiptDistributor.IncompatiblePoolReceipts.selector);
        new TapeoutReceiptDistributor(operator, pool, otherLatch);
        vm.expectRevert(TapeoutReceiptDistributor.IncompatiblePoolReceipts.selector);
        new TapeoutReceiptDistributor(operator, otherLatch, regularPool);
    }

    function testConstructorRejectsPoolsOfAnotherProcessor() public {
        // Same receipts, but another BEM, Mining or miner collection: not the same processor.
        TapeoutMinerPool.Deployment memory d = deployment(whitelist());
        MockBEM otherBem = new MockBEM();
        d.bem = address(otherBem);
        TapeoutMinerPool otherToken = new TapeoutMinerPool(d);
        d = deployment(whitelist());
        d.mining = address(new MockMining(bem));
        TapeoutMinerPool otherMining = new TapeoutMinerPool(d);
        d = deployment(whitelist());
        d.minerCollection = address(new MockNFT());
        TapeoutMinerPool otherCollection = new TapeoutMinerPool(d);
        vm.expectRevert(TapeoutReceiptDistributor.IncompatiblePoolProtocol.selector);
        new TapeoutReceiptDistributor(operator, pool, otherToken);
        vm.expectRevert(TapeoutReceiptDistributor.IncompatiblePoolProtocol.selector);
        new TapeoutReceiptDistributor(operator, otherToken, regularPool);
        vm.expectRevert(TapeoutReceiptDistributor.IncompatiblePoolProtocol.selector);
        new TapeoutReceiptDistributor(operator, pool, otherMining);
        vm.expectRevert(TapeoutReceiptDistributor.IncompatiblePoolProtocol.selector);
        new TapeoutReceiptDistributor(operator, pool, otherCollection);
    }

    // ---------------------------------------------------------------------------------------- binding

    function testBothPoolsBindTheSharedDistributorOnceAndIndependently() public {
        vm.startPrank(operator);
        pool.bindDistributor(address(distributor));
        assertEq(pool.distributor(), address(distributor));
        assertEq(regularPool.distributor(), address(0), "the other pool binds on its own");
        regularPool.bindDistributor(address(distributor));
        assertEq(regularPool.distributor(), address(distributor));
        // One-time and irreversible in each pool, even for another genuine distributor of the same pools.
        TapeoutReceiptDistributor other = new TapeoutReceiptDistributor(operator, pool, regularPool);
        vm.expectRevert(TapeoutMinerPool.DistributorAlreadyBound.selector);
        pool.bindDistributor(address(distributor));
        vm.expectRevert(TapeoutMinerPool.DistributorAlreadyBound.selector);
        regularPool.bindDistributor(address(distributor));
        vm.expectRevert(TapeoutMinerPool.DistributorAlreadyBound.selector);
        pool.bindDistributor(address(other));
        vm.expectRevert(TapeoutMinerPool.DistributorAlreadyBound.selector);
        regularPool.bindDistributor(address(other));
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        regularPool.bindDistributor(address(other));
    }

    function testAThirdPoolCannotBindEvenWithTheSameReceipts() public {
        TapeoutMinerPool third = deployRegularPool(whitelist()); // same receipts, protocol and owner
        assertFalse(distributor.isPool(address(third)));
        vm.startPrank(operator);
        vm.expectRevert(TapeoutMinerPool.InvalidDistributor.selector);
        third.bindDistributor(address(distributor));
        // Not after the two pools have bound it either.
        pool.bindDistributor(address(distributor));
        regularPool.bindDistributor(address(distributor));
        vm.expectRevert(TapeoutMinerPool.InvalidDistributor.selector);
        third.bindDistributor(address(distributor));
        // A distributor of one of the pools and the third: the other pool is not its member.
        TapeoutReceiptDistributor pair = new TapeoutReceiptDistributor(operator, pool, third);
        vm.expectRevert(TapeoutMinerPool.DistributorAlreadyBound.selector);
        regularPool.bindDistributor(address(pair));
        TapeoutMinerPool fourth = deployRegularPool(whitelist());
        vm.expectRevert(TapeoutMinerPool.InvalidDistributor.selector);
        fourth.bindDistributor(address(pair));
        vm.stopPrank();
    }

    /// @dev Accepted limitation (documented, tooling-checked): neither pool reads the other's binding, so
    ///      before binding, a pool can bind any genuine distributor that counts it as a member. A
    ///      distributor that serves the same two pools is still one distributor per pool; the operator's
    ///      deployment check (sdk/deployment.ts) requires both pools bound to the addresses file's
    ///      distributor, and full-round verification requires that distributor to hold the whole supply.
    function testThePoolsDoNotReadEachOthersBinding() public {
        TapeoutReceiptDistributor second = new TapeoutReceiptDistributor(operator, pool, regularPool);
        vm.startPrank(operator);
        pool.bindDistributor(address(distributor));
        regularPool.bindDistributor(address(second));
        vm.stopPrank();
        assertTrue(pool.distributor() != regularPool.distributor());
    }

    // ------------------------------------------------------------------ the shared gates of both pools

    function testTheSharedAllocationMustBeFinalBeforeEitherPoolActivates() public {
        _importRound();
        vm.startPrank(operator);
        pool.bindDistributor(address(distributor));
        regularPool.bindDistributor(address(distributor));
        vm.expectRevert(TapeoutMinerPool.AllocationNotFinalized.selector);
        pool.activate(6, 4);
        vm.expectRevert(TapeoutMinerPool.AllocationNotFinalized.selector);
        regularPool.activate(6, 4);
        distributor.finalizeAllocation();
        pool.activate(6, 4);
        regularPool.activate(6, 4);
        vm.stopPrank();
        assertTrue(pool.active() && regularPool.active());
    }

    function testTheSharedOwnersBlockTheFirstAdmissionInBothPools() public {
        _importRound();
        vm.startPrank(operator);
        distributor.finalizeAllocation();
        pool.bindDistributor(address(distributor));
        regularPool.bindDistributor(address(distributor));
        pool.activate(6, 4);
        regularPool.activate(6, 4);
        pool.renounceOwnership();
        regularPool.renounceOwnership();
        nandReceipt.renounceOwnership();
        vm.stopPrank();
        newMiner(1, 3, 1);
        newMiner(2, 1, 3);
        vm.startPrank(depositor);
        nft.setApprovalForAll(address(pool), true);
        nft.setApprovalForAll(address(regularPool), true);
        // The shared LATCH receipt is not renounced: neither pool opens custody.
        vm.expectRevert(
            abi.encodeWithSelector(TapeoutMinerPool.OwnershipNotRenounced.selector, address(latchReceipt))
        );
        pool.depositMiners(one(1));
        vm.expectRevert(
            abi.encodeWithSelector(TapeoutMinerPool.OwnershipNotRenounced.selector, address(latchReceipt))
        );
        regularPool.depositMiners(one(2));
        vm.stopPrank();
        vm.prank(operator);
        latchReceipt.renounceOwnership();
        // The shared distributor is not renounced: still neither pool.
        vm.startPrank(depositor);
        vm.expectRevert(
            abi.encodeWithSelector(TapeoutMinerPool.OwnershipNotRenounced.selector, address(distributor))
        );
        pool.depositMiners(one(1));
        vm.expectRevert(
            abi.encodeWithSelector(TapeoutMinerPool.OwnershipNotRenounced.selector, address(distributor))
        );
        regularPool.depositMiners(one(2));
        vm.stopPrank();
        vm.prank(operator);
        distributor.renounceOwnership();
        vm.startPrank(depositor);
        pool.depositMiners(one(1));
        regularPool.depositMiners(one(2));
        vm.stopPrank();
        assertTrue(pool.custodyOpen() && regularPool.custodyOpen());
        assertEq(pool.minerCount(), 1);
        assertEq(regularPool.minerCount(), 1);
    }

    function testEachPoolInitializesAndOpensCustodyOnItsOwn() public {
        _importRound();
        vm.startPrank(operator);
        distributor.finalizeAllocation();
        pool.bindDistributor(address(distributor));
        pool.activate(6, 4);
        nandReceipt.renounceOwnership();
        latchReceipt.renounceOwnership();
        distributor.renounceOwnership();
        pool.renounceOwnership();
        vm.stopPrank();
        _admit(pool, 1, 3, 1);
        assertTrue(pool.custodyOpen());
        assertFalse(regularPool.active());
        assertFalse(regularPool.custodyOpen());
        assertEq(regularPool.distributor(), address(0));
        // The regular pool's owner still binds the (now ownerless) shared distributor and activates later.
        vm.startPrank(operator);
        regularPool.bindDistributor(address(distributor));
        regularPool.activate(6, 4);
        vm.stopPrank();
        newMiner(2, 1, 3);
        vm.startPrank(depositor);
        nft.setApprovalForAll(address(regularPool), true);
        vm.expectRevert(
            abi.encodeWithSelector(TapeoutMinerPool.OwnershipNotRenounced.selector, address(regularPool))
        );
        regularPool.depositMiners(one(2));
        vm.stopPrank();
        vm.prank(operator);
        regularPool.renounceOwnership();
        vm.prank(depositor);
        regularPool.depositMiners(one(2));
        assertTrue(regularPool.custodyOpen());
    }

    // ------------------------------------------------------------------- inventory and allocation guards

    function testAllocationToEitherPoolIsRejected() public {
        issue(nandReceipt, address(distributor), 2);
        TapeoutReceiptDistributor.AllocationInput[] memory e =
            new TapeoutReceiptDistributor.AllocationInput[](1);
        vm.startPrank(operator);
        for (uint256 i; i < 3; ++i) {
            address wallet = i == 0 ? address(pool) : i == 1 ? address(regularPool) : address(distributor);
            e[0] = _entry(NAND, wallet, 1, 2);
            vm.expectRevert(TapeoutReceiptDistributor.InvalidAllocation.selector);
            distributor.allocate(e);
        }
        e[0] = _entry(NAND, alice, 1, 2);
        distributor.allocate(e);
        vm.stopPrank();
        assertEq(distributor.beneficiaryOf(NAND, 1), alice);
    }

    /// @dev Receipts carry claim history only after custody began, when the shared distributor is
    ///      finalized and refuses all inventory; the history check guards any other distributor of the
    ///      same pools (here a second, unbound one), and it reads both pools.
    function testInventoryWithClaimHistoryInEitherPoolIsRefused() public {
        _runningSystem();
        // alice: NAND 1 claimed in the optimal pool only, NAND 2 in the regular pool only, NAND 3 in both,
        // NAND 4 never.
        _claim(pool, alice, NAND, 1);
        _claim(regularPool, alice, NAND, 2);
        _claim(pool, alice, NAND, 3);
        _claim(regularPool, alice, NAND, 3);
        assertEq(regularPool.claimed(NAND, 1), 0);
        assertEq(pool.claimed(NAND, 2), 0);
        TapeoutReceiptDistributor second = new TapeoutReceiptDistributor(operator, pool, regularPool);
        vm.startPrank(alice);
        for (uint256 id = 1; id <= 3; ++id) {
            vm.expectRevert(
                abi.encodeWithSelector(TapeoutReceiptDistributor.ConsumedRewardHistory.selector, NAND, id)
            );
            nandReceipt.safeTransferFrom(alice, address(second), id, 1, "");
        }
        // The batch hook applies the same check: the whole batch is refused.
        vm.expectRevert(
            abi.encodeWithSelector(TapeoutReceiptDistributor.ConsumedRewardHistory.selector, NAND, 2)
        );
        nandReceipt.safeBatchTransferFrom(alice, address(second), two(4, 2), _ones(2), "");
        nandReceipt.safeTransferFrom(alice, address(second), 4, 1, ""); // fresh in both pools: accepted
        // The shared distributor is finalized: nothing comes back to it.
        vm.expectRevert(TapeoutReceiptDistributor.AllocationClosed.selector);
        nandReceipt.safeTransferFrom(alice, address(distributor), 1, 1, "");
        vm.stopPrank();
        (uint256[2] memory inventory,,) = second.totals();
        assertEq(inventory[0], 1);
        assertEq(nandReceipt.holderOf(4), address(second));
    }

    function testOneFullRoundAllocationDeliversEachReceiptExactlyOnce() public {
        _importRound();
        // Each ID once: a second allocation of an allocated ID is refused, in either category.
        TapeoutReceiptDistributor.AllocationInput[] memory e =
            new TapeoutReceiptDistributor.AllocationInput[](1);
        e[0] = _entry(NAND, dave, 4, 1);
        vm.startPrank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(TapeoutReceiptDistributor.AlreadyAllocated.selector, NAND, 4, alice)
        );
        distributor.allocate(e);
        e[0] = _entry(LATCH, dave, 3, 1);
        vm.expectRevert(
            abi.encodeWithSelector(TapeoutReceiptDistributor.AlreadyAllocated.selector, LATCH, 3, carol)
        );
        distributor.allocate(e);
        distributor.finalizeAllocation();
        vm.stopPrank();
        (uint256[2] memory inventory, uint256[2] memory allocated,) = distributor.totals();
        // The whole supply went through the one distributor and is allocated.
        assertEq(inventory[0], nandReceipt.totalSupply());
        assertEq(inventory[1], latchReceipt.totalSupply());
        assertEq(allocated[0], inventory[0]);
        assertEq(allocated[1], inventory[1]);
        _deliverAll();
        (,, uint256[2] memory delivered) = distributor.totals();
        assertEq(delivered[0], 6);
        assertEq(delivered[1], 4);
        for (uint256 id = 1; id <= 6; ++id) {
            assertEq(nandReceipt.holderOf(id), id <= 4 ? alice : bob);
            assertEq(distributor.beneficiaryOf(NAND, id), nandReceipt.holderOf(id));
        }
        for (uint256 id = 1; id <= 4; ++id) {
            assertEq(latchReceipt.holderOf(id), id <= 2 ? alice : carol);
        }
        vm.expectRevert(abi.encodeWithSelector(TapeoutReceiptDistributor.NothingToDeliver.selector, alice));
        distributor.deliver(alice, 100);
        vm.expectRevert(abi.encodeWithSelector(TapeoutReceiptDistributor.NothingToDeliver.selector, bob));
        distributor.deliver(bob, 100);
    }

    // ----------------------------------------------------------------------------- independent claims

    function testTheSameReceiptClaimsIndependentlyFromBothPools() public {
        _runningSystem();
        assertEq(pool.claimable(NAND, 1), 100_000);
        assertEq(regularPool.claimable(NAND, 1), 50_000);
        assertEq(_claim(pool, alice, NAND, 1), 100_000);
        // A claim in the optimal pool consumes nothing of the regular pool's entitlement or history.
        assertEq(pool.claimed(NAND, 1), 100_000);
        assertEq(regularPool.claimed(NAND, 1), 0);
        assertEq(regularPool.claimable(NAND, 1), 50_000);
        assertEq(_claim(regularPool, alice, NAND, 1), 50_000);
        assertEq(pool.claimed(NAND, 1), 100_000, "and the other way round");
        assertEq(regularPool.claimed(NAND, 1), 50_000);
        assertEq(pool.claimable(NAND, 1), 0);
        assertEq(regularPool.claimable(NAND, 1), 0);
        // LATCH too, with the regular pool first.
        assertEq(_claim(regularPool, carol, LATCH, 3), 225_000);
        assertEq(pool.claimed(LATCH, 3), 0);
        assertEq(_claim(pool, carol, LATCH, 3), 50_000);
        assertEq(pool.receiptsPaid(NAND), 100_000);
        assertEq(regularPool.receiptsPaid(NAND), 50_000);
        assertEq(pool.receiptsPaid(LATCH), 50_000);
        assertEq(regularPool.receiptsPaid(LATCH), 225_000);
    }

    function testUnclaimedEntitlementFollowsATransferIndependentlyInBothPools() public {
        _runningSystem();
        assertEq(_claim(pool, bob, NAND, 5), 100_000); // claimed in the optimal pool only
        vm.prank(bob);
        nandReceipt.safeTransferFrom(bob, dave, 5, 1, "");
        // A second period in both pools.
        _earn(pool, 1, 840_000);
        _earn(regularPool, 2, 1_260_000);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, NAND, 5));
        pool.claim(NAND, 5);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, NAND, 5));
        regularPool.claim(NAND, 5);
        // dave gets the optimal pool's new period only, and both of the regular pool's periods.
        assertEq(pool.claimable(NAND, 5), 100_000);
        assertEq(regularPool.claimable(NAND, 5), 100_000);
        assertEq(_claim(pool, dave, NAND, 5), 100_000);
        assertEq(_claim(regularPool, dave, NAND, 5), 100_000);
        assertEq(pool.claimed(NAND, 5), 200_000);
        assertEq(regularPool.claimed(NAND, 5), 100_000);
        // bob's other receipt is untouched by all of this.
        assertEq(pool.claimable(NAND, 6), 200_000);
        assertEq(regularPool.claimable(NAND, 6), 100_000);
    }

    // ------------------------------------------------------------------------- complete lifecycle

    /// @notice The complete local two-pool lifecycle: one issuance into the one distributor, one full-round
    ///         allocation, finalization, each pool binds and activates, every owner renounces, both pools
    ///         admit miners and earn, receipts are delivered once, holders claim from each pool, a receipt
    ///         changes hands, both pools release, and each pool's ledger reconciles on its own.
    function testCompleteTwoPoolLifecycle() public {
        _initializeBoth();
        assertEq(nandReceipt.owner(), address(0));
        assertEq(distributor.owner(), address(0));
        assertEq(pool.owner(), address(0));
        assertEq(regularPool.owner(), address(0));
        _admit(pool, 1, 3, 1);
        _admit(regularPool, 2, 1, 3);
        _earn(pool, 1, 840_000);
        _earn(regularPool, 2, 1_260_000);
        // Receipts are delivered once, after which they earn in both pools.
        _deliverAll();
        uint256 aliceBefore = bem.balanceOf(alice);
        vm.startPrank(alice);
        pool.claimBatch(range(1, 4), range(1, 2));
        regularPool.claimBatch(range(1, 4), range(1, 2));
        vm.stopPrank();
        assertEq(bem.balanceOf(alice) - aliceBefore, 4 * 100_000 + 2 * 50_000 + 4 * 50_000 + 2 * 225_000);
        // A later admission into the regular pool settles only the regular pool's miners.
        accrue(2, 1_260_000);
        _admit(regularPool, 3, 2, 2);
        assertEq(pool.minerCount(), 1);
        assertEq(regularPool.minerCount(), 2);
        assertEq(regularPool.totalAccounted(), 2 * 1_260_000);
        assertEq(pool.totalAccounted(), 840_000);
        // carol sells LATCH 4 to dave before claiming anything.
        vm.prank(carol);
        latchReceipt.safeTransferFrom(carol, dave, 4, 1, "");
        uint256 daveBefore = bem.balanceOf(dave);
        vm.startPrank(dave);
        pool.claim(LATCH, 4);
        regularPool.claim(LATCH, 4);
        vm.stopPrank();
        assertEq(bem.balanceOf(dave) - daveBefore, 50_000 + 2 * 225_000);
        // Each pool releases its own A, B and C.
        uint256 sinkBefore = bem.balanceOf(SINK);
        pool.releaseA();
        regularPool.releaseB();
        assertEq(bem.balanceOf(SINK) - sinkBefore, 840_000 * 2 / 84 + 2 * 1_260_000 * 2 / 84);
        _assertReconciled(pool);
        _assertReconciled(regularPool);
        // Per-ID histories add up to each pool's receipt payments, independently.
        for (uint256 p; p < 2; ++p) {
            TapeoutMinerPool target = p == 0 ? pool : regularPool;
            uint256 sum;
            for (uint256 id = 1; id <= 6; ++id) {
                sum += target.claimed(NAND, id);
            }
            assertEq(sum, target.receiptsPaid(NAND));
            sum = 0;
            for (uint256 id = 1; id <= 4; ++id) {
                sum += target.claimed(LATCH, id);
            }
            assertEq(sum, target.receiptsPaid(LATCH));
        }
        // The distributor's pool pair and receipts never changed.
        assertEq(address(distributor.optimalPool()), address(pool));
        assertEq(address(distributor.regularPool()), address(regularPool));
        (uint256[2] memory inventory, uint256[2] memory allocated, uint256[2] memory delivered) =
            distributor.totals();
        assertEq(inventory[0], 6);
        assertEq(inventory[1], 4);
        assertEq(allocated[0] + allocated[1], 10);
        assertEq(delivered[0] + delivered[1], 10);
    }

    // ---------------------------------------------------------------------------------------- helpers

    function _entry(TapeoutMinerPool.Category c, address wallet, uint64 first, uint64 count)
        internal
        pure
        returns (TapeoutReceiptDistributor.AllocationInput memory)
    {
        return TapeoutReceiptDistributor.AllocationInput({
            category: c, wallet: wallet, firstId: first, count: count
        });
    }

    function _ones(uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            a[i] = 1;
        }
    }

    /// @dev Issue the round into the distributor, import the full allocation and finalize issuance; the
    ///      allocation itself is not finalized yet.
    function _importRound() internal {
        issue(nandReceipt, address(distributor), 6);
        issue(latchReceipt, address(distributor), 4);
        TapeoutReceiptDistributor.AllocationInput[] memory e =
            new TapeoutReceiptDistributor.AllocationInput[](4);
        e[0] = _entry(NAND, alice, 1, 4);
        e[1] = _entry(LATCH, alice, 1, 2);
        e[2] = _entry(NAND, bob, 5, 2);
        e[3] = _entry(LATCH, carol, 3, 2);
        vm.prank(operator);
        distributor.allocate(e);
        finalizeIssuance();
    }

    /// @dev The two-pool initialization: the round finalized, each pool binds the shared distributor and
    ///      activates, then the shared receipts, the shared distributor and both pools renounce.
    function _initializeBoth() internal {
        _importRound();
        vm.startPrank(operator);
        distributor.finalizeAllocation();
        pool.bindDistributor(address(distributor));
        regularPool.bindDistributor(address(distributor));
        pool.activate(6, 4);
        regularPool.activate(6, 4);
        nandReceipt.renounceOwnership();
        latchReceipt.renounceOwnership();
        distributor.renounceOwnership();
        pool.renounceOwnership();
        regularPool.renounceOwnership();
        vm.stopPrank();
    }

    /// @dev Initialized, every receipt delivered, one period of income in each pool.
    function _runningSystem() internal {
        _initializeBoth();
        _deliverAll();
        _admit(pool, 1, 3, 1);
        _admit(regularPool, 2, 1, 3);
        _earn(pool, 1, 840_000);
        _earn(regularPool, 2, 1_260_000);
    }

    function _deliverAll() internal {
        vm.prank(alice);
        distributor.claim(100);
        distributor.deliver(bob, 100); // anyone may push a delivery
        distributor.deliver(carol, 100);
    }

    function _admit(TapeoutMinerPool p, uint256 tokenId, uint32 nand, uint32 latch) internal {
        newMiner(tokenId, nand, latch);
        vm.startPrank(depositor);
        nft.setApprovalForAll(address(p), true);
        p.depositMiners(one(tokenId));
        vm.stopPrank();
    }

    function _earn(TapeoutMinerPool p, uint256 tokenId, uint256 amount) internal {
        accrue(tokenId, amount);
        p.harvest(one(tokenId));
    }

    function _claim(TapeoutMinerPool p, address who, TapeoutMinerPool.Category c, uint256 id)
        internal
        returns (uint256 paid)
    {
        uint256 before = bem.balanceOf(who);
        vm.prank(who);
        p.claim(c, id);
        paid = bem.balanceOf(who) - before;
    }

    /// @dev The docs/ACCOUNTING.md identities for one pool (SystemTestBase.assertReconciled reads `pool`).
    function _assertReconciled(TapeoutMinerPool p) internal view {
        TapeoutMinerPool.Reconciliation memory r = p.reconciliation();
        assertEq(r.deficit, 0, "deficit");
        uint256 outstanding = (r.recipientAAccrued - r.recipientAPaid)
            + (r.recipientBAccrued - r.recipientBPaid) + (r.sinkAccrued - r.sinkPaid)
            + (r.nandReceiptsAccrued - r.nandReceiptsPaid) + (r.latchReceiptsAccrued - r.latchReceiptsPaid);
        assertEq(r.bemBalance, outstanding + r.residue + r.unrecognized, "balance identity");
        assertEq(
            r.totalPaid,
            r.recipientAPaid + r.recipientBPaid + r.sinkPaid + r.nandReceiptsPaid + r.latchReceiptsPaid,
            "paid identity"
        );
        assertEq(
            r.totalAccounted,
            r.recipientAAccrued + r.recipientBAccrued + r.sinkAccrued + r.nandReceiptsAccrued
                + r.latchReceiptsAccrued + r.residue,
            "accrued identity"
        );
        assertEq(r.recipientAAccrued, r.totalAccounted / 84, "A accrues floor(T / 84)");
        assertEq(r.sinkAccrued, r.totalAccounted * 2 / 84, "C accrues floor(2T / 84)");
        assertEq(r.sinkPaid, r.sinkAccrued, "every release pays C's whole backlog");
    }
}
