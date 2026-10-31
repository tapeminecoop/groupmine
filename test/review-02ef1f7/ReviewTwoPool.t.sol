// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutEntitlementReceipt} from "../../src/TapeoutEntitlementReceipt.sol";
import {TapeoutReceiptDistributor} from "../../src/TapeoutReceiptDistributor.sol";
import {PoolMath} from "../../src/PoolMath.sol";
import {MockBEM, MockMining, MockNFT, ToggleReceiver} from "../helpers/Mocks.sol";

/// @dev A "pool" look-alike with exactly the views the distributor constructor and receive hook read.
///      Mock-only: shows what the constructor's view comparison does and does not establish.
contract MimicPool {
    address public nandReceipt;
    address public latchReceipt;
    address public bem;
    address public mining;
    address public minerCollection;
    uint256 public claimedAnswer;
    bool public revertClaimed;

    constructor(TapeoutMinerPool real) {
        nandReceipt = address(real.nandReceipt());
        latchReceipt = address(real.latchReceipt());
        bem = address(real.bem());
        mining = address(real.mining());
        minerCollection = address(real.minerCollection());
    }

    function set(uint256 answer, bool revert_) external {
        claimedAnswer = answer;
        revertClaimed = revert_;
    }

    function claimed(TapeoutMinerPool.Category, uint256) external view returns (uint256) {
        if (revertClaimed) revert("mimic");
        return claimedAnswer;
    }
}

/// @dev Beneficiary wallet that claims BEM from both pools inside the delivery callback.
contract ClaimingReceiver {
    TapeoutMinerPool internal optimal;
    TapeoutMinerPool internal regular;
    address internal nand;
    uint256 public claimsMade;

    constructor(TapeoutMinerPool o, TapeoutMinerPool r, address nand_) {
        optimal = o;
        regular = r;
        nand = nand_;
    }

    function _claim(uint256 id) internal {
        TapeoutMinerPool.Category c =
            msg.sender == nand ? TapeoutMinerPool.Category.NAND : TapeoutMinerPool.Category.LATCH;
        try optimal.claim(c, id) {
            ++claimsMade;
        } catch {}
        try regular.claim(c, id) {
            ++claimsMade;
        } catch {}
    }

    function onERC1155Received(address, address, uint256 id, uint256, bytes calldata) external returns (bytes4) {
        _claim(id);
        return 0xf23a6e61;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata ids, uint256[] calldata, bytes calldata)
        external
        returns (bytes4)
    {
        for (uint256 i; i < ids.length; ++i) {
            _claim(ids[i]);
        }
        return 0xbc197c81;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x4e2312e0 || id == 0x01ffc9a7;
    }
}

/// @notice Review-only tests for Groupmine 2.3.0 (target 02ef1f7), Fable 5.1: one distributor serving the
///         Optimal Pool (`pool`) and the Regular Pool (`regularPool`) on one receipt pair. Fixtures are
///         asymmetric on purpose: supplies 10 NAND / 5 LATCH; the optimal pool's miner burns 3:1 and
///         earns 1,050 BEM, the regular pool's burns 1:3 and earns 2,100 BEM (the brief's example).
///         Expected values are derived here from the 80:1:1:2-of-84 rule and the per-pool composition.
contract ReviewTwoPoolTest is SystemTestBase {
    uint256 internal constant B = 1e8;
    address internal constant SINK = 0x000000000000000000000000000000000000dEaD;
    address internal eve = makeAddr("eve");

    // ------------------------------------------------------------------------------- fixtures

    function _entry(TapeoutMinerPool.Category c, address wallet, uint64 first, uint64 count)
        internal
        pure
        returns (TapeoutReceiptDistributor.AllocationInput memory)
    {
        return TapeoutReceiptDistributor.AllocationInput({category: c, wallet: wallet, firstId: first, count: count});
    }

    function _ones(uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            a[i] = 1;
        }
    }

    /// @dev Issue the round into the distributor (10 NAND, 5 LATCH), allocate it fully (alice NAND 1-5 and
    ///      LATCH 1-2, bob NAND 6-10, carol LATCH 3-5), finalize issuance. Both pools are still unbound
    ///      and inactive while the distributor reads their claim histories.
    function _importRound() internal {
        assertFalse(pool.active());
        assertFalse(regularPool.active());
        issue(nandReceipt, address(distributor), 10);
        issue(latchReceipt, address(distributor), 5);
        TapeoutReceiptDistributor.AllocationInput[] memory e = new TapeoutReceiptDistributor.AllocationInput[](4);
        e[0] = _entry(NAND, alice, 1, 5);
        e[1] = _entry(LATCH, alice, 1, 2);
        e[2] = _entry(NAND, bob, 6, 5);
        e[3] = _entry(LATCH, carol, 3, 3);
        vm.prank(operator);
        distributor.allocate(e);
        finalizeIssuance();
    }

    function _bindActivate(TapeoutMinerPool p) internal {
        vm.startPrank(operator);
        p.bindDistributor(address(distributor));
        p.activate(10, 5);
        vm.stopPrank();
    }

    function _renounceShared() internal {
        vm.startPrank(operator);
        nandReceipt.renounceOwnership();
        latchReceipt.renounceOwnership();
        distributor.renounceOwnership();
        vm.stopPrank();
    }

    function _initializeBoth() internal {
        _importRound();
        vm.prank(operator);
        distributor.finalizeAllocation();
        _bindActivate(pool);
        _bindActivate(regularPool);
        _renounceShared();
        vm.startPrank(operator);
        pool.renounceOwnership();
        regularPool.renounceOwnership();
        vm.stopPrank();
    }

    function _deliverAll() internal {
        vm.prank(alice);
        distributor.claim(100);
        distributor.deliver(bob, 100);
        distributor.deliver(carol, 100);
    }

    function _admitInto(TapeoutMinerPool p, uint256 id, uint32 n, uint32 l) internal {
        newMiner(id, n, l);
        vm.startPrank(depositor);
        nft.setApprovalForAll(address(p), true);
        p.depositMiners(one(id));
        vm.stopPrank();
    }

    function _earn(TapeoutMinerPool p, uint256 id, uint256 amount) internal {
        accrue(id, amount);
        p.harvest(one(id));
    }

    /// @dev The brief's example: optimal 3:1 with 1,050 BEM, regular 1:3 with 2,100 BEM, zero carry.
    function _runningExample() internal {
        _initializeBoth();
        _deliverAll();
        _admitInto(pool, 1, 3, 1);
        _admitInto(regularPool, 2, 1, 3);
        _earn(pool, 1, 1050 * B);
        _earn(regularPool, 2, 2100 * B);
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

    function _reconciled(TapeoutMinerPool p) internal view {
        TapeoutMinerPool.Reconciliation memory r = p.reconciliation();
        assertEq(r.deficit, 0, "deficit");
        uint256 outstanding = (r.recipientAAccrued - r.recipientAPaid) + (r.recipientBAccrued - r.recipientBPaid)
            + (r.sinkAccrued - r.sinkPaid) + (r.nandReceiptsAccrued - r.nandReceiptsPaid)
            + (r.latchReceiptsAccrued - r.latchReceiptsPaid);
        assertEq(r.bemBalance, outstanding + r.residue + r.unrecognized, "balance identity");
        assertEq(r.totalPaid, r.recipientAPaid + r.recipientBPaid + r.sinkPaid + r.nandReceiptsPaid + r.latchReceiptsPaid);
        assertEq(
            r.totalAccounted,
            r.recipientAAccrued + r.recipientBAccrued + r.sinkAccrued + r.nandReceiptsAccrued + r.latchReceiptsAccrued
                + r.residue
        );
    }

    // ------------------------------------------------------------------- A. exact values and isolation

    function testBriefExampleExactValuesPerPool() public {
        _runningExample();
        PoolMath.Accrual memory o = pool.accrual();
        PoolMath.Accrual memory r = regularPool.accrual();
        // Optimal: T = 1,050 BEM, participants 1,000 at 3:1 -> NAND 750, LATCH 250; A = B = 12.5; C = 25.
        assertEq(o.nandIncome, 750 * B);
        assertEq(o.latchIncome, 250 * B);
        assertEq(o.recipientA, 125 * B / 10);
        assertEq(o.recipientB, 125 * B / 10);
        assertEq(o.sink, 25 * B);
        assertEq(o.perNandShare, 75 * B);
        assertEq(o.perLatchShare, 50 * B);
        // Regular: T = 2,100 BEM, participants 2,000 at 1:3 -> NAND 500, LATCH 1,500; A = B = 25; C = 50.
        assertEq(r.nandIncome, 500 * B);
        assertEq(r.latchIncome, 1500 * B);
        assertEq(r.recipientA, 25 * B);
        assertEq(r.sink, 50 * B);
        assertEq(r.perNandShare, 50 * B);
        assertEq(r.perLatchShare, 300 * B);
        // One NAND plus one LATCH receipt: 125 BEM from the optimal pool, 350 from the regular pool.
        assertEq(pool.claimable(NAND, 1) + pool.claimable(LATCH, 1), 125 * B);
        assertEq(regularPool.claimable(NAND, 1) + regularPool.claimable(LATCH, 1), 350 * B);
        _reconciled(pool);
        _reconciled(regularPool);
        // Neither pool applied the other's composition or a combined ratio.
        assertEq(pool.totalNandBurn(), 3);
        assertEq(regularPool.totalLatchBurn(), 3);
    }

    function testClaimOrderAcrossPoolsDoesNotChangeEitherPayment() public {
        _runningExample();
        uint256 snap = vm.snapshotState();
        uint256 o1 = _claim(pool, alice, NAND, 1);
        uint256 r1 = _claim(regularPool, alice, NAND, 1);
        vm.revertToState(snap);
        uint256 r2 = _claim(regularPool, alice, NAND, 1);
        uint256 o2 = _claim(pool, alice, NAND, 1);
        assertEq(o1, 75 * B);
        assertEq(r1, 50 * B);
        assertEq(o1, o2);
        assertEq(r1, r2);
        assertEq(pool.claimed(NAND, 1), 75 * B);
        assertEq(regularPool.claimed(NAND, 1), 50 * B);
    }

    function testNandOneAndLatchOneAreDistinctInEachPoolAndAcrossPools() public {
        _runningExample();
        assertEq(_claim(pool, alice, NAND, 1), 75 * B);
        assertEq(_claim(pool, alice, LATCH, 1), 50 * B);
        assertEq(_claim(regularPool, alice, LATCH, 1), 300 * B);
        assertEq(pool.claimed(NAND, 1), 75 * B);
        assertEq(pool.claimed(LATCH, 1), 50 * B);
        assertEq(regularPool.claimed(NAND, 1), 0, "regular NAND #1 untouched");
        assertEq(regularPool.claimed(LATCH, 1), 300 * B);
        assertEq(_claim(regularPool, alice, NAND, 1), 50 * B);
    }

    function testUnequalHistoriesSurviveATransferAndNewIncomeGoesToTheBuyer() public {
        _runningExample();
        assertEq(_claim(pool, alice, NAND, 1), 75 * B); // seller claims the optimal pool only
        vm.prank(alice);
        nandReceipt.safeTransferFrom(alice, eve, 1, 1, "");
        // Buyer: the regular pool's unpaid entitlement is intact; the optimal pool's is already paid.
        assertEq(regularPool.claimable(NAND, 1), 50 * B);
        assertEq(pool.claimable(NAND, 1), 0);
        assertEq(_claim(regularPool, eve, NAND, 1), 50 * B);
        assertEq(_claim(pool, eve, NAND, 1), 0, "cannot reclaim what the seller was paid");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, NAND, 1));
        pool.claim(NAND, 1);
        // New income in both pools belongs to the new holder, in each pool.
        _earn(pool, 1, 1050 * B);
        _earn(regularPool, 2, 2100 * B);
        assertEq(pool.claimable(NAND, 1), 75 * B);
        assertEq(regularPool.claimable(NAND, 1), 50 * B);
        assertEq(_claim(pool, eve, NAND, 1), 75 * B);
        assertEq(_claim(regularPool, eve, NAND, 1), 50 * B);
        assertEq(pool.claimed(NAND, 1), 150 * B);
        assertEq(regularPool.claimed(NAND, 1), 100 * B);
        _reconciled(pool);
        _reconciled(regularPool);
    }

    function testTransferApprovalIsNotClaimAuthorizationInEitherPool() public {
        _runningExample();
        vm.prank(alice);
        nandReceipt.setApprovalForAll(eve, true);
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, NAND, 1));
        pool.claim(NAND, 1);
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, NAND, 1));
        regularPool.claim(NAND, 1);
    }

    function testSinkPaymentsAreAttributedPerPoolNotByTheSharedBalance() public {
        _runningExample();
        uint256 sinkBefore = bem.balanceOf(SINK);
        pool.releaseA();
        assertEq(pool.sinkPaid(), 25 * B);
        assertEq(regularPool.sinkPaid(), 0);
        regularPool.releaseB();
        assertEq(regularPool.sinkPaid(), 50 * B);
        assertEq(bem.balanceOf(SINK) - sinkBefore, 75 * B, "shared address, two ledgers");
        assertEq(bem.balanceOf(recipientA), 125 * B / 10, "optimal A only");
        assertEq(bem.balanceOf(recipientB), 25 * B, "regular B only");
        _reconciled(pool);
        _reconciled(regularPool);
    }

    function testZeroAndTinyIncomeAndCarriedIncomeInOnePoolOnly() public {
        _initializeBoth();
        _deliverAll();
        // Carried income only in the regular pool: its miner carries 2,100 BEM at its own 1:3 burn.
        newMiner(1, 3, 1);
        newMiner(2, 1, 3);
        accrue(2, 2100 * B);
        vm.startPrank(depositor);
        nft.setApprovalForAll(address(pool), true);
        nft.setApprovalForAll(address(regularPool), true);
        (, uint256 carriedO) = pool.depositMiners(one(1));
        (, uint256 carriedR) = regularPool.depositMiners(one(2));
        vm.stopPrank();
        assertEq(carriedO, 0);
        assertEq(carriedR, 2100 * B);
        assertEq(pool.totalAccounted(), 0, "zero income: nothing claimable");
        assertEq(_claim(pool, alice, NAND, 1), 0);
        assertEq(regularPool.accrual().nandIncome, 500 * B);
        assertEq(regularPool.accrual().latchIncome, 1500 * B);
        assertEq(regularPool.miner(2).carriedIncome, 2100 * B);
        // Tiny raw-unit income: 84 raw into the optimal pool, 85 raw into the regular pool.
        _earn(pool, 1, 84);
        _earn(regularPool, 2, 85);
        PoolMath.Accrual memory o = pool.accrual();
        assertEq(o.recipientA, 1);
        assertEq(o.sink, 2);
        assertEq(o.participants, 80);
        assertEq(o.nandIncome, 60); // 80 units at 3:1
        assertEq(o.latchIncome, 20);
        assertEq(o.perNandShare, 6);
        assertEq(o.perLatchShare, 4);
        assertEq(o.residue, 84 - 1 - 1 - 2 - 60 - 20);
        _reconciled(pool);
        _reconciled(regularPool);
    }

    function testZeroLatchSupplyIsRefusedForLatchMinersInBothPools() public {
        issue(nandReceipt, address(distributor), 10);
        TapeoutReceiptDistributor.AllocationInput[] memory e = new TapeoutReceiptDistributor.AllocationInput[](1);
        e[0] = _entry(NAND, alice, 1, 10);
        vm.prank(operator);
        distributor.allocate(e);
        finalizeIssuance();
        vm.startPrank(operator);
        distributor.finalizeAllocation();
        pool.bindDistributor(address(distributor));
        regularPool.bindDistributor(address(distributor));
        pool.activate(10, 0);
        regularPool.activate(10, 0);
        pool.renounceOwnership();
        regularPool.renounceOwnership();
        vm.stopPrank();
        _renounceShared();
        newMiner(1, 3, 1);
        vm.startPrank(depositor);
        nft.setApprovalForAll(address(pool), true);
        nft.setApprovalForAll(address(regularPool), true);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.UnsupportedCategory.selector, LATCH));
        pool.depositMiners(one(1));
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.UnsupportedCategory.selector, LATCH));
        regularPool.depositMiners(one(1));
        vm.stopPrank();
        _admitInto(regularPool, 2, 4, 0);
        assertTrue(regularPool.custodyOpen());
    }

    // ------------------------------------------------------------------------ B. lifecycle and gates

    function testFundingReadsBothPoolsWhileBothAreUnboundAndInactive() public {
        _importRound(); // asserts both pools inactive before funding
        (uint256[2] memory inventory,,) = distributor.totals();
        assertEq(inventory[0], 10);
        assertEq(inventory[1], 5);
        assertEq(pool.distributor(), address(0));
        assertEq(regularPool.distributor(), address(0));
    }

    function testStaggeredStartupOptimalFirstThenRegularAfterSharedRenunciation() public {
        _importRound();
        vm.prank(operator);
        distributor.finalizeAllocation();
        _bindActivate(pool);
        _renounceShared();
        vm.prank(operator);
        pool.renounceOwnership();
        _admitInto(pool, 1, 3, 1);
        _earn(pool, 1, 1050 * B);
        _deliverAll(); // delivery and optimal claims work while the regular pool is unbound
        assertEq(_claim(pool, alice, NAND, 1), 75 * B);
        assertFalse(regularPool.active());
        vm.prank(alice);
        vm.expectRevert(TapeoutMinerPool.NotActive.selector);
        regularPool.claim(NAND, 1);
        // The regular pool's owner binds the ownerless distributor, activates, renounces and admits.
        assertEq(distributor.owner(), address(0));
        _bindActivate(regularPool);
        vm.prank(operator);
        regularPool.renounceOwnership();
        _admitInto(regularPool, 2, 1, 3);
        _earn(regularPool, 2, 2100 * B);
        assertTrue(regularPool.custodyOpen());
        assertEq(_claim(regularPool, alice, NAND, 1), 50 * B);
        assertEq(pool.claimed(NAND, 1), 75 * B, "optimal history untouched by the regular start");
    }

    function testStaggeredStartupRegularFirstThenOptimalLater() public {
        _importRound();
        vm.prank(operator);
        distributor.finalizeAllocation();
        _bindActivate(regularPool);
        _renounceShared();
        vm.prank(operator);
        regularPool.renounceOwnership();
        _admitInto(regularPool, 2, 1, 3);
        _earn(regularPool, 2, 2100 * B);
        _deliverAll();
        assertEq(_claim(regularPool, carol, LATCH, 3), 300 * B);
        assertFalse(pool.custodyOpen());
        _bindActivate(pool);
        vm.prank(operator);
        pool.renounceOwnership();
        _admitInto(pool, 1, 3, 1);
        _earn(pool, 1, 1050 * B);
        assertEq(_claim(pool, carol, LATCH, 3), 50 * B);
        assertEq(regularPool.claimed(LATCH, 3), 300 * B);
    }

    function testAFailedFirstAdmissionRollsBackCustodyOpenInEachPool() public {
        _initializeBoth();
        newMiner(1, 3, 1);
        newMiner(2, 1, 3);
        mining.setKeyBroken(address(nft), 1, true); // the incoming miner's own claim fails (mock)
        mining.setKeyBroken(address(nft), 2, true);
        vm.startPrank(depositor);
        nft.setApprovalForAll(address(pool), true);
        nft.setApprovalForAll(address(regularPool), true);
        vm.expectRevert();
        pool.depositMiners(one(1));
        vm.expectRevert();
        regularPool.depositMiners(one(2));
        vm.stopPrank();
        assertFalse(pool.custodyOpen());
        assertFalse(regularPool.custodyOpen());
        assertEq(pool.minerCount() + regularPool.minerCount(), 0);
        assertEq(nft.ownerOf(1), depositor);
        assertEq(nft.ownerOf(2), depositor);
        mining.setKeyBroken(address(nft), 1, false);
        mining.setKeyBroken(address(nft), 2, false);
        vm.startPrank(depositor);
        pool.depositMiners(one(1));
        regularPool.depositMiners(one(2));
        vm.stopPrank();
        assertTrue(pool.custodyOpen() && regularPool.custodyOpen());
    }

    function testAMinerCannotBeInBothPoolsAndThereIsNoMigration() public {
        _initializeBoth();
        _admitInto(pool, 1, 3, 1);
        vm.startPrank(depositor);
        nft.setApprovalForAll(address(regularPool), true);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.MinerNotHeld.selector, 1, address(pool)));
        regularPool.depositMiners(one(1));
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.MinerNotHeld.selector, 1, address(pool)));
        regularPool.registerMiners(one(1));
        vm.stopPrank();
        assertEq(nft.ownerOf(1), address(pool), "custody is permanent; no function moves it out");
    }

    // ------------------------------------------------------------- C. binding, identity and topology

    function testMimicPoolPassesTheConstructorAndCanVetoFunding() public {
        MimicPool mimic = new MimicPool(pool);
        // The constructor compares reported views only: a look-alike with matching views is accepted.
        TapeoutReceiptDistributor d = new TapeoutReceiptDistributor(operator, pool, TapeoutMinerPool(address(mimic)));
        assertTrue(d.isPool(address(mimic)));
        issue(nandReceipt, operator, 3);
        vm.prank(operator);
        nandReceipt.safeTransferFrom(operator, address(d), 1, 1, ""); // mimic reports 0: accepted
        mimic.set(1, false);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TapeoutReceiptDistributor.ConsumedRewardHistory.selector, NAND, 2));
        nandReceipt.safeTransferFrom(operator, address(d), 2, 1, ""); // a lying member vetoes funding
        mimic.set(0, true);
        vm.prank(operator);
        vm.expectRevert();
        nandReceipt.safeTransferFrom(operator, address(d), 3, 1, ""); // a reverting member blocks funding
        // The genuine pool cannot be fooled the other way: it binds only a contract that counts it.
        vm.prank(operator);
        pool.bindDistributor(address(d)); // genuine optimal pool, mimic as "regular": binds
        assertEq(pool.distributor(), address(d));
    }

    function testTopologyMistakesDirectCallsAllowAndWhatTheyLeave() public {
        _importRound();
        vm.prank(operator);
        distributor.finalizeAllocation();
        TapeoutMinerPool decoy = deployRegularPool(whitelist());
        TapeoutReceiptDistributor pair = new TapeoutReceiptDistributor(operator, pool, decoy); // incomplete pair
        vm.startPrank(operator);
        pair.finalizeAllocation(); // empty inventory: 0 == 0
        // The optimal pool binds the wrong (genuine) distributor; the regular pool cannot bind it.
        pool.bindDistributor(address(pair));
        vm.expectRevert(TapeoutMinerPool.InvalidDistributor.selector);
        regularPool.bindDistributor(address(pair));
        // The intended distributor is now unbindable by the optimal pool; the regular pool binds it.
        vm.expectRevert(TapeoutMinerPool.DistributorAlreadyBound.selector);
        pool.bindDistributor(address(distributor));
        regularPool.bindDistributor(address(distributor));
        pool.activate(10, 5);
        regularPool.activate(10, 5);
        pair.renounceOwnership();
        pool.renounceOwnership();
        regularPool.renounceOwnership();
        vm.stopPrank();
        _renounceShared();
        // Nothing on chain notices: both pools open custody on different distributors.
        _admitInto(pool, 1, 3, 1);
        _admitInto(regularPool, 2, 1, 3);
        assertTrue(pool.custodyOpen() && regularPool.custodyOpen());
        assertTrue(pool.distributor() != regularPool.distributor());
        // The receipts still sit in the intended distributor and still earn in both pools.
        _earn(pool, 1, 1050 * B);
        _deliverAll();
        assertEq(_claim(pool, alice, NAND, 1), 75 * B);
    }

    function testThirdPoolWithTheSameReceiptsCannotBindButCanTakeADistributorOfItsOwn() public {
        TapeoutMinerPool third = deployRegularPool(whitelist());
        vm.startPrank(operator);
        vm.expectRevert(TapeoutMinerPool.InvalidDistributor.selector);
        third.bindDistributor(address(distributor));
        TapeoutMinerPool fourth = deployRegularPool(whitelist());
        TapeoutReceiptDistributor other = new TapeoutReceiptDistributor(operator, third, fourth);
        third.bindDistributor(address(other)); // a second pair on the same receipts is a separate system
        vm.stopPrank();
        assertFalse(distributor.isPool(address(third)));
        assertTrue(other.isPool(address(third)));
    }

    // --------------------------------------------------------------- D. delivery callbacks and failures

    function testDeliveryCallbackClaimsInBothPoolsOnceAndRevertingReceiverRollsBack() public {
        // bob's role (NAND 6-10) is taken by a contract that claims inside the delivery hook.
        ClaimingReceiver claimer = new ClaimingReceiver(pool, regularPool, address(nandReceipt));
        ToggleReceiver refuser = new ToggleReceiver();
        issue(nandReceipt, address(distributor), 10);
        issue(latchReceipt, address(distributor), 5);
        TapeoutReceiptDistributor.AllocationInput[] memory e = new TapeoutReceiptDistributor.AllocationInput[](4);
        e[0] = _entry(NAND, alice, 1, 5);
        e[1] = _entry(LATCH, alice, 1, 2);
        e[2] = _entry(NAND, address(claimer), 6, 5);
        e[3] = _entry(LATCH, address(refuser), 3, 3);
        vm.prank(operator);
        distributor.allocate(e);
        finalizeIssuance();
        vm.prank(operator);
        distributor.finalizeAllocation();
        _bindActivate(pool);
        _bindActivate(regularPool);
        _renounceShared();
        vm.startPrank(operator);
        pool.renounceOwnership();
        regularPool.renounceOwnership();
        vm.stopPrank();
        _admitInto(pool, 1, 3, 1);
        _admitInto(regularPool, 2, 1, 3);
        _earn(pool, 1, 1050 * B);
        _earn(regularPool, 2, 2100 * B);
        // Delivery with callback-time claims in both pools: paid once, delivered once, histories set.
        uint256 before = bem.balanceOf(address(claimer));
        distributor.deliver(address(claimer), 100);
        assertEq(bem.balanceOf(address(claimer)) - before, 5 * 75 * B + 5 * 50 * B);
        assertEq(claimer.claimsMade(), 10);
        for (uint256 id = 6; id <= 10; ++id) {
            assertEq(nandReceipt.holderOf(id), address(claimer));
            assertEq(pool.claimed(NAND, id), 75 * B);
            assertEq(regularPool.claimed(NAND, id), 50 * B);
            assertEq(pool.claimable(NAND, id), 0);
        }
        (,, uint256[2] memory delivered) = distributor.totals();
        assertEq(delivered[0], 5);
        vm.expectRevert(abi.encodeWithSelector(TapeoutReceiptDistributor.NothingToDeliver.selector, address(claimer)));
        distributor.deliver(address(claimer), 100);
        // A refusing receiver: the whole delivery, its counters and cursor roll back; histories unchanged.
        refuser.setRefuse(true);
        vm.expectRevert();
        distributor.deliver(address(refuser), 100);
        (,, delivered) = distributor.totals();
        assertEq(delivered[1], 0);
        assertEq(distributor.nextRangeOf(address(refuser)), 0);
        assertEq(latchReceipt.holderOf(3), address(distributor));
        assertEq(pool.claimed(LATCH, 3), 0);
        assertEq(regularPool.claimed(LATCH, 3), 0);
        refuser.setRefuse(false);
        distributor.deliver(address(refuser), 100);
        assertEq(latchReceipt.holderOf(5), address(refuser));
        _reconciled(pool);
        _reconciled(regularPool);
    }

    function testOnePoolsMiningFailureDoesNotBlockTheOtherPoolOrDelivery() public {
        _runningExample();
        mining.setKeyBroken(address(nft), 1, true); // the optimal pool's registered miner fails to claim
        newMiner(3, 1, 1);
        vm.startPrank(depositor);
        nft.setApprovalForAll(address(pool), true);
        nft.setApprovalForAll(address(regularPool), true);
        vm.expectRevert();
        pool.depositMiners(one(3)); // strict settlement blocks optimal admissions
        regularPool.depositMiners(one(3)); // the regular pool admits
        vm.stopPrank();
        assertEq(regularPool.minerCount(), 2);
        (, uint256 failed) = pool.harvest(one(1));
        assertEq(failed, 1, "optimal harvest isolates the failure");
        _earn(regularPool, 2, 2100 * B);
        // Composition after admitting the 1:1 miner into 1:3 is 2:4: 2,000 participant BEM give NAND
        // 666.67 BEM, 66.67 per share, on top of the 50 per share of the first period: 116.67 BEM.
        assertEq(_claim(regularPool, alice, NAND, 1), 11_666_666_666);
        assertEq(_claim(pool, alice, NAND, 1), 75 * B, "optimal claims of recognized income still pay");
        // Shared dependency, labelled: a BEM transfer refusal to the sink stops releases in BOTH pools.
        bem.setBlockedTo(SINK, true);
        vm.expectRevert();
        pool.releaseA();
        vm.expectRevert();
        regularPool.releaseA();
        assertEq(_claim(pool, bob, NAND, 6), 75 * B, "receipt claims do not depend on the sink");
    }

    // ----------------------------------------------------------------------------- E. funding gas

    function testFundingGasPerIdWithBothHistoryReadsStaysUnderTheSdkBound() public {
        uint256 n = 283; // the 2.3.0 CLI default (FUND_GAS 100k + 44k per ID within 3/4 of 2^24)
        issue(nandReceipt, operator, n);
        uint256[] memory ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = i + 1;
        }
        vm.prank(operator);
        uint256 g = gasleft();
        nandReceipt.safeBatchTransferFrom(operator, address(distributor), ids, _ones(n), "");
        g -= gasleft();
        emit log_named_uint("fund 283 IDs into the two-pool distributor: gas", g);
        emit log_named_uint("  per ID", g / n);
        assertLt(g, 100_000 + 44_000 * n, "within the SDK bound");
        (uint256[2] memory inventory,,) = distributor.totals();
        assertEq(inventory[0], n);
    }
}
