// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {PoolMath} from "../../src/PoolMath.sol";

/// @notice SALUS finding #1 ("Rewards locked when all circuits are revoked before registration"): an
///         accepted operational limitation, not a code change. The supported admission path is
///         `depositMiners` by a whitelisted wallet that owns an ACTIVE miner and approved the pool:
///         validation, custody transfer, registration and accounting happen in one transaction, and any
///         failure reverts all of it. A plain ERC-721 transfer into the pool registers nothing, and the
///         direct-transfer-then-revocation scenario SALUS describes stays unsupported: its BEM is not
///         recoverable by any role, and no withdrawal, sweep or privileged registration exists.
contract SalusAdmissionTest is SystemTestBase {
    uint256 internal constant BEM_105 = 105 * BEM_UNIT; // 100 BEM for the participants under 80 : 1 : 1 : 2

    function setUp() public override {
        super.setUp();
        setupStandard(); // S_N = S_L = 10, finalized, active, every owner renounced
    }

    function _state() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                pool.accrual(),
                pool.ledgerState(),
                pool.reconciliation(),
                pool.minerCount(),
                pool.compositionPeriod(),
                pool.carriedIncome(),
                pool.carriedNandUnits(),
                pool.custodyOpen()
            )
        );
    }

    function _deposit(address who, uint256[] memory ids) internal {
        vm.startPrank(who);
        nft.setApprovalForAll(address(pool), true);
        pool.depositMiners(ids);
        vm.stopPrank();
    }

    function _expectDepositRevert(uint256[] memory ids, bytes memory reason) internal {
        vm.startPrank(depositor);
        nft.setApprovalForAll(address(pool), true);
        vm.expectRevert(reason);
        pool.depositMiners(ids);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------- supported path

    function testAtomicAdmissionOfAnActiveMiner() public {
        newMiner(1, 6, 4);
        accrue(1, BEM_105);
        assertEq(nft.ownerOf(1), depositor);
        vm.recordLogs();
        _deposit(depositor, one(1));
        assertEq(nft.ownerOf(1), address(pool), "custody taken");
        TapeoutMinerPool.Miner memory m = pool.miner(1);
        assertTrue(m.registered);
        assertEq(m.nandBurn, 6);
        assertEq(m.latchBurn, 4);
        assertEq(m.carriedIncome, BEM_105, "the miner's own claim, collected in the same transaction");
        assertEq(pool.minerCount(), 1);
        assertEq(pool.totalNandBurn(), 6);
        assertEq(pool.totalLatchBurn(), 4);
        assertTrue(pool.custodyOpen());
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.total, BEM_105);
        assertEq(a.nandIncome, 60 * BEM_UNIT);
        assertEq(a.latchIncome, 40 * BEM_UNIT);
        assertEq(bem.balanceOf(depositor), 0, "the depositor keeps none of the carried income");
        // One transaction: custody opened, the miner registered and its income attributed.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool opened;
        bool registered;
        bool attributed;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == TapeoutMinerPool.CustodyOpened.selector) opened = true;
            if (logs[i].topics[0] == TapeoutMinerPool.MinerRegistered.selector) registered = true;
            if (logs[i].topics[0] == TapeoutMinerPool.CarriedIncomeAttributed.selector) attributed = true;
        }
        assertTrue(opened && registered && attributed);
        assertReconciled();
    }

    function testInitialAdmissionEstablishesTheComposition() public {
        bem.mint(address(pool), BEM_105); // held before any composition exists
        assertEq(pool.sync(), 0, "no composition: nothing can be recognized");
        assertEq(pool.unrecognizedBalance(), 0);
        assertEq(pool.totalNandBurn() + pool.totalLatchBurn(), 0);
        newMiner(1, 3, 1);
        accrue(1, BEM_105);
        _deposit(depositor, one(1));
        assertEq(pool.totalNandBurn(), 3);
        assertEq(pool.totalLatchBurn(), 1);
        // The carried income goes by the miner's burn, the BEM held before by the first composition.
        assertEq(pool.carriedIncome(), BEM_105);
        assertEq(pool.totalAccounted(), 2 * BEM_105);
        assertEq(pool.accrual().nandIncome, 150 * BEM_UNIT);
        assertEq(pool.accrual().latchIncome, 50 * BEM_UNIT);
        assertReconciled();
    }

    // ---------------------------------------------------------------------- failures roll back

    function testRevocationBeforeAdmissionRevertsTheAdmission() public {
        newMiner(1, 6, 4);
        accrue(1, BEM_105);
        mining.setStatus(address(nft), 1, 2); // REVOKED while still held by the wallet
        bytes32 before = _state();
        _expectDepositRevert(one(1), abi.encodeWithSelector(TapeoutMinerPool.MinerNotActive.selector, 1));
        assertEq(nft.ownerOf(1), depositor, "the miner stays with the original wallet");
        assertEq(_state(), before, "nothing changed, not even the custody latch");
        assertFalse(pool.custodyOpen());
        assertFalse(pool.miner(1).registered);
    }

    function testRolledBackAdmissionDoesNotAlterRegisteredTotalsOrAccounting() public {
        newMiner(1, 9, 1);
        accrue(1, BEM_105);
        _deposit(depositor, one(1));
        accrue(1, BEM_105); // old-period income still inside Mining
        bem.mint(address(pool), 7_777); // held, not yet recognized
        newMiner(2, 1, 9);
        accrue(2, BEM_105);
        newMiner(3, 2, 2);
        mining.setStatus(address(nft), 3, 2); // the batch's second miner is revoked
        bytes32 before = _state();
        uint256 poolBalance = bem.balanceOf(address(pool));
        _expectDepositRevert(two(2, 3), abi.encodeWithSelector(TapeoutMinerPool.MinerNotActive.selector, 3));
        assertEq(_state(), before);
        assertEq(bem.balanceOf(address(pool)), poolBalance, "not even the old miner was settled");
        assertEq(mining.rewards(mining.minerKey(address(nft), 1)), BEM_105);
        assertEq(nft.ownerOf(2), depositor);
        assertEq(nft.ownerOf(3), depositor);
        assertEq(pool.totalNandBurn(), 9);
        assertEq(pool.totalLatchBurn(), 1);
        assertEq(pool.minerCount(), 1);
    }

    /// @dev The incoming miner passes validation but its own Mining claim fails after custody was
    ///      taken: the whole admission, the old miners' settlement included, reverts.
    function testIncomingRewardCollectionFailureRollsBackTheWholeAdmission() public {
        newMiner(1, 9, 1);
        _deposit(depositor, one(1));
        accrue(1, BEM_105);
        newMiner(2, 1, 9);
        newMiner(3, 1, 1);
        accrue(2, BEM_105);
        accrue(3, BEM_105);
        mining.setKeyBroken(address(nft), 3, true);
        bytes32 before = _state();
        _expectDepositRevert(two(2, 3), abi.encodeWithSignature("Error(string)", "MINER_BROKEN"));
        assertEq(_state(), before);
        assertEq(nft.ownerOf(2), depositor);
        assertEq(nft.ownerOf(3), depositor);
        assertEq(mining.rewards(mining.minerKey(address(nft), 1)), BEM_105, "old settlement undone");
        assertEq(mining.rewards(mining.minerKey(address(nft), 2)), BEM_105, "carried claim undone");
        assertEq(bem.balanceOf(depositor), 0);
        // Once the claim works the same batch is admitted.
        mining.setKeyBroken(address(nft), 3, false);
        _deposit(depositor, two(2, 3));
        assertEq(pool.minerCount(), 3);
        assertReconciled();
    }

    function testMissingApprovalOrForeignOwnershipRevertsAtomically() public {
        newMiner(1, 1, 1);
        newMinerFor(alice, 2, 1, 1);
        bytes32 before = _state();
        vm.prank(depositor);
        vm.expectRevert(); // no approval: the transfer inside the admission fails
        pool.depositMiners(one(1));
        _expectDepositRevert(one(2), abi.encodeWithSelector(TapeoutMinerPool.MinerNotHeld.selector, 2, alice));
        assertEq(_state(), before);
        assertEq(nft.ownerOf(1), depositor);
        assertEq(nft.ownerOf(2), alice);
    }

    // ---------------------------------------------------------------------- unsupported path

    function testDirectTransferDoesNotRegisterAMiner() public {
        newMiner(1, 4, 4);
        accrue(1, BEM_105);
        vm.prank(depositor);
        nft.transferFrom(depositor, address(pool), 1);
        assertEq(nft.ownerOf(1), address(pool));
        assertFalse(pool.miner(1).registered);
        assertEq(pool.minerCount(), 0);
        assertEq(pool.totalNandBurn() + pool.totalLatchBurn(), 0);
        assertFalse(pool.custodyOpen());
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.UnknownMiner.selector, 1));
        pool.harvest(one(1));
        // Anyone can still make Mining pay the pool for it; with no composition nothing is recognized.
        mining.claim(mining.minerKey(address(nft), 1));
        assertEq(bem.balanceOf(address(pool)), BEM_105);
        assertEq(pool.sync(), 0);
        assertEq(pool.unrecognizedBalance(), 0);
        assertEq(pool.totalAccounted(), 0);
    }

    /// @notice The scenario of SALUS finding #1, kept as a documented, unsupported path. Miners reach the
    ///         pool by plain transfers and are revoked before anyone registers them. The revocation pays
    ///         the holder (the pool) before revoking; the mock models that with a claim followed by the
    ///         status change, as Mining.challenge does in one transaction (docs/MINING_LIFECYCLE.md).
    function testUnsupportedDirectTransferThenRevocationLeavesItsIncomeUnrecognized() public {
        newMiner(1, 10, 0);
        newMiner(2, 0, 10);
        accrue(1, BEM_105);
        accrue(2, BEM_105);
        vm.startPrank(depositor);
        nft.transferFrom(depositor, address(pool), 1);
        nft.transferFrom(depositor, address(pool), 2);
        vm.stopPrank();
        for (uint256 id = 1; id <= 2; ++id) {
            mining.claim(mining.minerKey(address(nft), id)); // revocation's payout to the holder
            mining.setStatus(address(nft), id, 2); // REVOKED: permanent
        }
        assertEq(bem.balanceOf(address(pool)), 2 * BEM_105);
        // A revoked miner can never be registered: the composition stays empty.
        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.MinerNotActive.selector, 1));
        pool.registerMiners(one(1));
        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.MinerNotActive.selector, 2));
        pool.registerMiners(one(2));
        // The BEM is unrecognized and nobody can claim, release or withdraw it: no role, owner or
        // depositor function reaches it (the owner is renounced; there is no sweep or withdrawal).
        assertEq(pool.sync(), 0);
        assertEq(pool.unrecognizedBalance(), 0);
        assertEq(pool.totalAccounted(), 0);
        vm.prank(alice);
        assertEq(pool.claim(NAND, 1), 0);
        assertEq(pool.releaseA(), 0);
        assertEq(bem.balanceOf(pool.SINK()), 0);
        assertEq(pool.owner(), address(0));
        assertEq(bem.balanceOf(address(pool)), 2 * BEM_105, "locked while no valid admission happens");
        // Documented consequence: a later valid admission recognizes it as income of its new period,
        // under that admission's composition (never as carried income of the revoked miners).
        newMiner(3, 1, 1);
        _deposit(depositor, one(3));
        assertEq(pool.carriedIncome(), 0);
        assertEq(pool.totalAccounted(), 2 * BEM_105);
        assertEq(pool.accrual().nandIncome, 100 * BEM_UNIT);
        assertEq(pool.accrual().latchIncome, 100 * BEM_UNIT);
        assertEq(nft.ownerOf(1), address(pool), "the revoked NFTs stay in custody: no withdrawal");
        assertReconciled();
    }

    /// @notice The unsupported registerMiners window: income anyone claims for a plainly transferred
    ///         miner before its registration is booked under the composition current at that moment.
    function testRegisterAfterPlainTransferBooksEarlierClaimsUnderTheCurrentComposition() public {
        newMiner(1, 10, 0);
        _deposit(depositor, one(1)); // composition 10:0
        newMiner(2, 0, 10);
        accrue(2, BEM_105);
        vm.prank(depositor);
        nft.transferFrom(depositor, address(pool), 2);
        mining.claim(mining.minerKey(address(nft), 2)); // a third party settles it to the pool
        vm.prank(depositor);
        (uint256 settled, uint256 carried) = pool.registerMiners(one(2));
        assertEq(settled, 0);
        assertEq(carried, 0, "nothing left to carry: it was claimed before registration");
        assertEq(pool.accrual().nandIncome, 100 * BEM_UNIT, "booked all NAND under the old composition");
        assertEq(pool.accrual().latchIncome, 0);
        // Through depositMiners the same miner's 100 BEM would have gone all to LATCH.
        assertReconciled();
    }
}
