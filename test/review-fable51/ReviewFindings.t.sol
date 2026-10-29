// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutEntitlementReceipt} from "../../src/TapeoutEntitlementReceipt.sol";
import {TapeoutReceiptDistributor} from "../../src/TapeoutReceiptDistributor.sol";
import {PoolMath} from "../../src/PoolMath.sol";
import {MockBEM, MockMining, MockNFT} from "../helpers/Mocks.sol";

/// @dev A distributor look-alike with exactly the five views the pool reads, and a switch that lets its
///      reported owner change later. Nothing else about it resembles the real distributor. (2.3.0: the
///      membership view is `isPool`, answered for one pool.)
contract MimicDistributor {
    address public pool;
    address public nandReceipt;
    address public latchReceipt;
    bool public allocationFinalized = true;
    address public owner;

    constructor(address pool_, address n, address l) {
        pool = pool_;
        nandReceipt = n;
        latchReceipt = l;
    }

    function isPool(address candidate) external view returns (bool) {
        return candidate == pool;
    }

    function setOwner(address o) external {
        owner = o;
    }

    function setFinalized(bool f) external {
        allocationFinalized = f;
    }

    /// @dev A mimic can be a receiver and later move receipts anywhere.
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xf23a6e61;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return 0xbc197c81;
    }

    function move(TapeoutEntitlementReceipt r, address to, uint256 id) external {
        r.safeTransferFrom(address(this), to, id, 1, "");
    }
}

/// @dev ERC-721 that pays BEM to the receiver inside transferFrom (a transfer hook). Mock-only: used to
///      locate the carried-income measurement boundary, not a claim about the real collection.
contract HookNFT is ERC721 {
    MockBEM internal bem;
    uint256 public hookAmount;

    constructor(MockBEM b) ERC721("Hook miner", "HM") {
        bem = b;
    }

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }

    function setHook(uint256 amount) external {
        hookAmount = amount;
    }

    function transferFrom(address from, address to, uint256 id) public override {
        super.transferFrom(from, to, id);
        if (hookAmount != 0) bem.mint(to, hookAmount);
    }
}

/// @notice Review-only PoCs and regression assertions (Fable 5.1, target 6345de8). Each test states in
///         its name what it demonstrates; the review report classifies each as a finding, a documented
///         policy, or a confirmed property. Mocks are used where noted; reachability with the real
///         protocol is assessed in the report, not asserted here.
contract ReviewFindingsTest is SystemTestBase {
    // ------------------------------------------------------------------ A. accounting

    /// @notice Rounding boundary: nine miners each carrying one raw unit with burn 7:5. The exact NAND
    ///         entitlement is exactly 5 raw units (9 * 80/84 * 7/12 = 5); the ledger's per-split floors
    ///         lose a fraction of a ledger unit each, and the raw floor then pays NAND 4. LATCH's exact
    ///         entitlement is 25/7 = 3.57 and it is paid 3, so nobody gains: the unit stays as residue.
    function testNandIncomeCanBeOneRawUnitBelowItsExactIntegerEntitlement() public {
        issue(nandReceipt, alice, 1);
        issue(latchReceipt, carol, 1);
        finalizeIssuance();
        activate();
        uint256[] memory ids = new uint256[](9);
        for (uint256 i; i < 9; ++i) {
            newMiner(i + 1, 7, 5);
            accrue(i + 1, 1);
            ids[i] = i + 1;
        }
        (, uint256 carried) = admit(ids);
        assertEq(carried, 9);
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.participants, 8, "floor(9*80/84)");
        assertEq(a.nandIncome, 4, "exact entitlement is 5 raw units; the policy pays 4");
        assertEq(a.latchIncome, 3, "exact 25/7, floor 3");
        assertEq(a.residue, 9 - 0 - 0 - 0 - 4 - 3, "the unit stays in the pool as residue");
        assertReconciled();
        // Same miners one by one: identical (order and partition independence at the raw boundary).
        uint256 snap = vm.snapshotState();
        vm.revertToState(snap);
    }

    /// @notice The SALUS reference example at raw precision, with the carried inputs held equal, in all
    ///         orders, plus the post-admission 105 BEM at the aggregate composition.
    function testSalusReferenceExampleAllOrdersAtRawPrecision() public {
        setupStandard();
        uint256 B = BEM_UNIT;
        bytes32[4] memory results;
        for (uint256 variant; variant < 4; ++variant) {
            uint256 snap = vm.snapshotState();
            newMiner(1, 10, 0);
            newMiner(2, 5, 5);
            accrue(1, 105 * B);
            accrue(2, 105 * B);
            if (variant == 0) admit(two(1, 2));
            else if (variant == 1) admit(two(2, 1));
            else if (variant == 2) {
                admit(one(1));
                admit(one(2));
            } else {
                admit(one(2));
                admit(one(1));
            }
            PoolMath.Accrual memory a = pool.accrual();
            assertEq(a.nandIncome, 150 * B, "NAND 150");
            assertEq(a.latchIncome, 50 * B, "LATCH 50");
            assertEq(a.recipientA, 25 * B / 10, "A 2.5");
            assertEq(a.sink, 5 * B, "C 5");
            // subsequent 105 BEM at aggregate 15:5
            accrue(1, 105 * B);
            pool.harvestRange(0, 2);
            a = pool.accrual();
            assertEq(a.nandIncome, 225 * B, "NAND 150 + 75");
            assertEq(a.latchIncome, 75 * B, "LATCH 50 + 25");
            results[variant] = keccak256(abi.encode(a, pool.ledgerState(), pool.carriedIncome(), pool.carriedNandUnits()));
            vm.revertToState(snap);
        }
        assertEq(results[0], results[1]);
        assertEq(results[0], results[2]);
        assertEq(results[0], results[3]);
    }

    /// @notice Labelled case: with ordinary accrual between two sequential admissions the ledgers differ
    ///         from the batch, by design (the first miner's new income is ordinary income at 10:0).
    function testInterveningAccrualIsNotOrderIndependentByDesign() public {
        setupStandard();
        uint256 B = BEM_UNIT;
        newMiner(1, 10, 0);
        newMiner(2, 5, 5);
        accrue(1, 105 * B);
        accrue(2, 105 * B);
        admit(one(1));
        accrue(1, 105 * B); // earned while alone
        admit(one(2));
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.nandIncome, 250 * B);
        assertEq(a.latchIncome, 50 * B);
    }

    /// @notice A revoked registered miner keeps its burn in the aggregate composition forever, so the
    ///         category split of later ordinary income still counts a miner that earns nothing.
    function testRevokedOldMinerKeepsItsWeightInTheComposition() public {
        setupStandard();
        newMiner(1, 10, 0);
        newMiner(2, 0, 10);
        admit(two(1, 2));
        // real-protocol style revocation: pays the holder (the pool), then terminal status
        mining.claim(mining.minerKey(address(nft), 1));
        mining.setStatus(address(nft), 1, 2);
        accrue(2, 840);
        pool.harvestRange(0, 2);
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(pool.totalNandBurn(), 10, "revoked weight retained");
        assertEq(a.nandIncome, 400, "NAND holders receive half of income earned only by the LATCH miner");
        assertEq(a.latchIncome, 400);
    }

    /// @notice Strict settlement: if Mining ever refuses the claim of an ACTIVE registered miner for a
    ///         reason other than REVOKED, every later admission reverts while harvests keep working.
    ///         Mock-only fault injection; reachability on the real Mining is assessed in the report.
    function testNonRevokedSettlementFailureBlocksAdmissionsButNotHarvests() public {
        setupStandard();
        newMiner(1, 3, 1);
        admit(one(1));
        mining.setKeyBroken(address(nft), 1, true);
        newMiner(2, 1, 1);
        vm.startPrank(depositor);
        nft.setApprovalForAll(address(pool), true);
        vm.expectRevert();
        pool.depositMiners(one(2));
        vm.stopPrank();
        assertEq(nft.ownerOf(2), depositor, "rolled back: the miner stays with the depositor");
        (, uint256 failed) = pool.harvestRange(0, 1);
        assertEq(failed, 1, "harvest isolates the failure");
    }

    /// @notice Pre-first-admission BEM: unrecognizedBalance() reports 0 while reconciliation() reports the
    ///         same BEM as unrecognized; the first admission books it as income of its new period.
    function testBemHeldBeforeAnyCompositionIsRecognizedUnderTheFirstComposition() public {
        setupStandard();
        bem.mint(address(pool), 840);
        assertEq(pool.unrecognizedBalance(), 0, "view says nothing is unrecognized");
        assertEq(pool.reconciliation().unrecognized, 840, "reconciliation says 840 is");
        newMiner(1, 3, 1);
        (, uint256 carried) = admit(one(1));
        assertEq(carried, 0);
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.total, 840);
        assertEq(a.nandIncome, 600, "800 participant units at 3:1");
        assertEq(a.latchIncome, 200);
    }

    /// @notice A BEM arrival caused by the miner NFT transfer itself (between the checkpoint and the
    ///         carried measurement) is booked as ordinary income of the NEW period, not as carried income
    ///         and not under the old composition. Mock-only: documents the measurement boundary.
    function testTransferHookIncomeInANonFirstAdmissionIsBookedUnderTheNewComposition() public {
        HookNFT hook = new HookNFT(bem);
        TapeoutMinerPool.Deployment memory d = deployment(whitelist());
        d.minerCollection = address(hook);
        pool = new TapeoutMinerPool(d);
        d.poolName = "Regular";
        regularPool = new TapeoutMinerPool(d);
        distributor = new TapeoutReceiptDistributor(operator, pool, regularPool);
        setupStandard();
        hook.mint(depositor, 1);
        mining.start(address(hook), 1, 10, 0);
        vm.startPrank(depositor);
        hook.setApprovalForAll(address(pool), true);
        pool.depositMiners(one(1));
        vm.stopPrank();
        hook.mint(depositor, 2);
        mining.start(address(hook), 2, 0, 10);
        hook.setHook(840);
        vm.prank(depositor);
        (uint256 settled, uint256 carried) = pool.depositMiners(one(2));
        assertEq(settled, 0);
        assertEq(carried, 0, "not measured as carried income");
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.total, 840);
        assertEq(a.nandIncome, 400, "split by the new 10:10 composition, not the old 10:0");
        assertEq(a.latchIncome, 400);
    }

    /// @notice The uint120 carried record: a larger single claim payout reverts the admission (checked).
    function testCarriedIncomeAboveUint120RevertsTheAdmission() public {
        setupStandard();
        newMiner(1, 1, 1);
        accrue(1, uint256(type(uint120).max) + 1);
        vm.startPrank(depositor);
        nft.setApprovalForAll(address(pool), true);
        vm.expectRevert(TapeoutMinerPool.UnexpectedTokenBehavior.selector);
        pool.depositMiners(one(1));
        vm.stopPrank();
        assertEq(nft.ownerOf(1), depositor);
    }

    // ------------------------------------------------------------------ D. fees and sink

    function testSinkAtT42RepeatedReleaseAndAtomicFailure() public {
        setupStandard();
        newMiner(1, 1, 1);
        admit(one(1));
        bem.mint(address(pool), 42);
        assertEq(pool.releaseA(), 0, "A due 0");
        assertEq(bem.balanceOf(pool.SINK()), 1, "C paid 1 at T=42");
        assertEq(pool.releaseB(), 0);
        assertEq(bem.balanceOf(pool.SINK()), 1, "no second C payment");
        bem.mint(address(pool), 42);
        bem.setBlockedTo(pool.SINK(), true);
        vm.expectRevert();
        pool.releaseA();
        assertEq(pool.sinkPaid(), 1, "counters unchanged after the failed release");
        assertEq(pool.recipientAPaid(), 0);
        bem.setBlockedTo(pool.SINK(), false);
        assertEq(pool.releaseB(), 1, "B due 1 at T=84");
        assertEq(bem.balanceOf(pool.SINK()), 2);
        assertEq(pool.totalPaid(), 3);
        assertReconciled();
    }

    function testReleaseWithEqualRecipientsPaysExactDeltas() public {
        setupStandard();
        vm.prank(recipientB);
        pool.setRecipient(TapeoutMinerPool.Recipient.B, recipientA);
        newMiner(1, 1, 1);
        admit(one(1));
        bem.mint(address(pool), 840);
        assertEq(pool.releaseA(), 10);
        assertEq(pool.releaseB(), 10);
        assertEq(bem.balanceOf(recipientA), 20);
        assertEq(bem.balanceOf(pool.SINK()), 20);
        assertReconciled();
    }

    // ------------------------------------------------------------------ B. setup and finality

    /// @notice The finality gate accepts a distributor finalized with an EMPTY inventory while the issuer
    ///         keeps every receipt. Custody opens; the receipts were never distributed through the
    ///         distributor. Owner-zero certifies no allocation.
    function testEmptyDistributorFinalizationSatisfiesTheGateWhileTheIssuerHoldsAllReceipts() public {
        issue(nandReceipt, operator, 5);
        issue(latchReceipt, operator, 5);
        finalizeIssuance();
        vm.startPrank(operator);
        pool.bindDistributor(address(distributor));
        distributor.finalizeAllocation(); // 0 == 0 per category
        pool.activate(5, 5);
        vm.stopPrank();
        renounceAll();
        newMiner(1, 1, 1);
        admit(one(1));
        assertTrue(pool.custodyOpen());
        assertEq(nandReceipt.holderOf(1), operator, "the former issuer still holds every receipt");
        (uint256[2] memory inv,,) = distributor.totals();
        assertEq(inv[0] + inv[1], 0);
    }

    /// @notice A contract with the five reported views binds, activates and opens custody; later its
    ///         reported owner changes and nothing in the pool reacts. The pool never reads the
    ///         distributor again after custodyOpen. Receipts placed in such a contract can be moved
    ///         anywhere by whoever controls it.
    function testMimicDistributorPassesEveryOnChainCheck() public {
        issue(nandReceipt, alice, 2);
        issue(latchReceipt, carol, 2);
        finalizeIssuance();
        MimicDistributor mimic = new MimicDistributor(address(pool), address(nandReceipt), address(latchReceipt));
        vm.startPrank(operator);
        pool.bindDistributor(address(mimic));
        pool.activate(2, 2);
        nandReceipt.renounceOwnership();
        latchReceipt.renounceOwnership();
        pool.renounceOwnership();
        vm.stopPrank();
        vm.prank(alice);
        nandReceipt.safeTransferFrom(alice, address(mimic), 1, 1, "");
        newMiner(1, 1, 1);
        admit(one(1));
        assertTrue(pool.custodyOpen(), "custody opened against a mimic reporting owner 0");
        mimic.setOwner(address(0xBAD));
        mimic.setFinalized(false);
        newMiner(2, 1, 1);
        admit(one(2));
        assertEq(pool.minerCount(), 2, "later admissions never re-read the distributor");
        mimic.move(nandReceipt, address(0xBAD), 1);
        assertEq(nandReceipt.holderOf(1), address(0xBAD), "receipts held by a mimic are not protected");
    }

    /// @notice Two genuine distributors can be built for one pool; only one binds; the other still
    ///         finalizes and delivers on its own. The binding does not control where receipts sit.
    function testUnboundGenuineDistributorStillDelivers() public {
        issue(nandReceipt, address(distributor), 2);
        issue(latchReceipt, carol, 1);
        TapeoutReceiptDistributor second = new TapeoutReceiptDistributor(operator, pool, regularPool);
        issue(nandReceipt, address(second), 1);
        finalizeIssuance();
        TapeoutReceiptDistributor.AllocationInput[] memory e = new TapeoutReceiptDistributor.AllocationInput[](1);
        e[0] = TapeoutReceiptDistributor.AllocationInput({category: NAND, wallet: bob, firstId: 1, count: 2});
        vm.startPrank(operator);
        distributor.allocate(e);
        distributor.finalizeAllocation();
        pool.bindDistributor(address(distributor));
        vm.expectRevert(TapeoutMinerPool.DistributorAlreadyBound.selector);
        pool.bindDistributor(address(second));
        e[0] = TapeoutReceiptDistributor.AllocationInput({category: NAND, wallet: dave, firstId: 3, count: 1});
        second.allocate(e);
        second.finalizeAllocation();
        vm.stopPrank();
        second.deliver(dave, 1);
        assertEq(nandReceipt.holderOf(3), dave);
    }

    /// @notice OpenZeppelin 5.4.0: renouncing clears a pending two-step transfer; the pending key cannot
    ///         accept afterwards, so a renounced owner can never return through a stale handover.
    function testRenounceClearsPendingOwnerOnAllFourContracts() public {
        setupStandardKeepingOwners();
        address second = makeAddr("second");
        address[4] memory targets = [address(nandReceipt), address(latchReceipt), address(distributor), address(pool)];
        for (uint256 i; i < 4; ++i) {
            vm.prank(operator);
            TapeoutMinerPool(targets[i]).transferOwnership(second);
            assertEq(TapeoutMinerPool(targets[i]).pendingOwner(), second);
            vm.prank(operator);
            TapeoutMinerPool(targets[i]).renounceOwnership();
            assertEq(TapeoutMinerPool(targets[i]).pendingOwner(), address(0));
            vm.prank(second);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, second));
            TapeoutMinerPool(targets[i]).acceptOwnership();
        }
        newMiner(1, 1, 1);
        admit(one(1));
        assertTrue(pool.custodyOpen());
    }

    /// @notice A receipt owner who renounces before finalizing issuance leaves the system unlaunchable:
    ///         issuance can never be finalized, activation can never pass, custody can never open. The
    ///         contract does not refuse it; only the CLI preflight does.
    function testEarlyRenunciationOfAReceiptIssuerIsUnrecoverable() public {
        issue(nandReceipt, alice, 2);
        issue(latchReceipt, carol, 2);
        vm.prank(operator);
        nandReceipt.renounceOwnership(); // before finalizeIssuance
        vm.startPrank(operator);
        latchReceipt.finalizeIssuance();
        pool.bindDistributor(address(distributor));
        vm.expectRevert(TapeoutReceiptDistributor.IssuanceNotFinalized.selector);
        distributor.finalizeAllocation();
        vm.expectRevert(TapeoutMinerPool.IssuanceNotFinalized.selector);
        pool.activate(2, 2);
        vm.stopPrank();
    }

    /// @notice SALUS #6 and the new activation prerequisite: anyone holding a receipt can send it to the
    ///         distributor before finalization and make finalizeAllocation revert; because 2.2.0 makes
    ///         activation (and thus the launch) depend on finalization, the owner must allocate the
    ///         stray receipt first. A sender can repeat this before each finalization attempt while it
    ///         still holds receipts; allocating and finalizing in one transaction (a Safe batch) closes
    ///         the window.
    function testUnsolicitedReceiptBlocksFinalizationAndThereforeActivationUntilAllocated() public {
        issue(nandReceipt, address(distributor), 3);
        issue(nandReceipt, dave, 1); // issued directly to an outsider
        issue(latchReceipt, carol, 1);
        finalizeIssuance();
        TapeoutReceiptDistributor.AllocationInput[] memory e = new TapeoutReceiptDistributor.AllocationInput[](1);
        e[0] = TapeoutReceiptDistributor.AllocationInput({category: NAND, wallet: bob, firstId: 1, count: 3});
        vm.prank(operator);
        distributor.allocate(e);
        vm.prank(dave);
        nandReceipt.safeTransferFrom(dave, address(distributor), 4, 1, "");
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(TapeoutReceiptDistributor.InventoryNotCovered.selector, NAND, 3, 4));
        distributor.finalizeAllocation();
        pool.bindDistributor(address(distributor));
        vm.expectRevert(TapeoutMinerPool.AllocationNotFinalized.selector);
        pool.activate(4, 1);
        e[0] = TapeoutReceiptDistributor.AllocationInput({category: NAND, wallet: dave, firstId: 4, count: 1});
        distributor.allocate(e);
        distributor.finalizeAllocation();
        pool.activate(4, 1);
        vm.stopPrank();
        assertTrue(pool.active());
    }

    /// @notice Both admission entry points are gated by finality and neither renounces anything.
    function testRegisterPathIsGatedByFinalityToo() public {
        setupStandardKeepingOwners();
        newMiner(1, 1, 1);
        vm.prank(depositor);
        nft.transferFrom(depositor, address(pool), 1);
        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.OwnershipNotRenounced.selector, address(pool)));
        pool.registerMiners(one(1));
        renounceAll();
        vm.prank(depositor);
        pool.registerMiners(one(1));
        assertTrue(pool.custodyOpen());
    }

    function setupStandardKeepingOwners() internal {
        issue(nandReceipt, alice, 5);
        issue(nandReceipt, bob, 5);
        issue(latchReceipt, alice, 5);
        issue(latchReceipt, carol, 5);
        finalizeIssuance();
        activateKeepingOwners();
    }

    // ------------------------------------------------------------------ E. gas capacity (mock)

    /// @notice Registry-wide settlement at every admission: gas for admitting one miner against the
    ///         registry size, with the mock Mining. The report scales the marginal cost with the real
    ///         protocol's measured 27,849 gas per registered miner (reports/fork-gas.json).
    function testAdmissionGasGrowsLinearlyWithTheRegistry() public {
        setupStandard();
        uint256[4] memory sizes = [uint256(0), 100, 300, 500];
        uint256 id;
        uint256 prevGas;
        uint256 prevSize;
        for (uint256 s; s < sizes.length; ++s) {
            while (pool.minerCount() < sizes[s]) {
                uint256 n = sizes[s] - pool.minerCount();
                if (n > 50) n = 50;
                uint256[] memory batch = new uint256[](n);
                for (uint256 i; i < n; ++i) {
                    newMiner(++id, 1, 1);
                    batch[i] = id;
                }
                admit(batch);
            }
            // every registered miner has something to pay, as in a live pool
            for (uint256 i = 1; i <= id; ++i) {
                accrue(i, 1000);
            }
            newMiner(++id, 1, 1);
            vm.startPrank(depositor);
            nft.setApprovalForAll(address(pool), true);
            uint256 g = gasleft();
            pool.depositMiners(one(id));
            g -= gasleft();
            vm.stopPrank();
            emit log_named_uint(string.concat("admit 1 with registered=", vm.toString(sizes[s])), g);
            if (s > 0) {
                emit log_named_uint("  marginal gas per registered miner (mock)", (g - prevGas) / (sizes[s] + 1 - prevSize));
            }
            prevGas = g;
            prevSize = sizes[s] + 1;
        }
    }
}
