// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutEntitlementReceipt} from "../../src/TapeoutEntitlementReceipt.sol";
import {TapeoutReceiptDistributor} from "../../src/TapeoutReceiptDistributor.sol";
import {PoolMath} from "../../src/PoolMath.sol";
import {IMining} from "../../src/interfaces/IMining.sol";
import {PoolForkBase, IBeacon, IMiningMany} from "./PoolForkBase.sol";

interface IOwnable {
    function owner() external view returns (address);
}

interface IPausable {
    function paused() external view returns (bool);
}

/// @dev Mining's computed local burn of a circuit (official frontend ABI); not used by the pool.
interface ICircuitBurn {
    function circuitBurn(address circuits, uint256 circuitId)
        external
        view
        returns (uint32 nand, uint32 latch);
}

/// @dev The miner collection's recorded circuit statistics; the last value is the gate count including
///      referenced sub-circuits.
interface ICircuitInfo {
    function circuitInfo(uint256 circuitId) external view returns (uint32, uint32, uint32, uint32);
}

/// @notice Real BSC protocol state at a pinned block (run through scripts/fork-test.ts). Uses the
///         deployed miner collection, Mining and BEM without modifying their code or storage; miners
///         are moved from their current holders with fork-only impersonation. Deploys the exact Paris
///         artifacts from ./out. Env: FORK_RPC_URL, FORK_BLOCK, FORK_NAND_MINER, FORK_LATCH_MINER,
///         FORK_SCALE_MINERS (comma separated), FORK_INACTIVE_TOKEN.
contract PoolForkTest is PoolForkBase {
    // ---------------------------------------------------------------------------------- tests

    function testForkProtocolIdentityAndCompositionAbi() public {
        assertEq(block.chainid, 56);
        assertEq(address(uint160(uint256(vm.load(MINING, IMPLEMENTATION_SLOT)))), MINING_IMPLEMENTATION);
        assertEq(address(uint160(uint256(vm.load(COLLECTION, BEACON_SLOT)))), COLLECTION_BEACON);
        assertEq(IERC20Metadata(BEM).decimals(), 8);
        assertEq(mining.minerKey(COLLECTION, 3204), KEY_3204);
        string memory key = "identity";
        uint256[2] memory ids = [nandMiner, latchMiner];
        for (uint256 i; i < 2; ++i) {
            bytes32 k = mining.minerKey(COLLECTION, ids[i]);
            IMining.MinerRecord memory r = mining.getMiner(k);
            (bool cached, uint32 cn, uint32 cl) = mining.cachedBurn(COLLECTION, ids[i]);
            assertEq(r.status, 1);
            assertEq(r.circuits, COLLECTION);
            assertEq(uint256(r.circuitId), ids[i]);
            assertTrue(cached);
            assertEq(cn, r.nandBurn);
            assertEq(cl, r.latchBurn);
            vm.serializeUint(key, string.concat("miner", vm.toString(ids[i]), "NandBurn"), r.nandBurn);
            vm.serializeUint(key, string.concat("miner", vm.toString(ids[i]), "LatchBurn"), r.latchBurn);
            vm.serializeUint(key, string.concat("miner", vm.toString(ids[i]), "GateCount"), r.gateCount);
            vm.serializeUint(key, string.concat("miner", vm.toString(ids[i]), "Bstar"), r.bstar);
        }
        assertEq(
            mining.getMiner(mining.minerKey(COLLECTION, nandMiner)).latchBurn, 0, "first miner is NAND-only"
        );
        assertGt(
            mining.getMiner(mining.minerKey(COLLECTION, latchMiner)).latchBurn, 0, "second miner burns LATCH"
        );
        // Claims of a miner that is not ACTIVE revert; claimMany skips such a key instead.
        uint256 inactive = vm.envUint("FORK_INACTIVE_TOKEN");
        bytes32 inactiveKey = mining.minerKey(COLLECTION, inactive);
        assertTrue(mining.getMiner(inactiveKey).status != 1);
        vm.expectRevert(bytes4(0x5f9bb3be));
        mining.claim(inactiveKey);
        bytes32[] memory keys = new bytes32[](2);
        keys[0] = mining.minerKey(COLLECTION, nandMiner);
        keys[1] = inactiveKey;
        IMiningMany(MINING).claimMany(keys); // does not revert: why the pool never relies on it

        // Upgrade and pause authority at this block, read rather than assumed.
        address collectionImplementation = IBeacon(COLLECTION_BEACON).implementation();
        address miningOwner = IOwnable(MINING).owner();
        address beaconOwner = IOwnable(COLLECTION_BEACON).owner();
        assertEq(miningOwner, address(0), "Mining ownership is renounced at this block");
        assertFalse(IPausable(MINING).paused());
        assertEq(vm.load(MINING, ADMIN_SLOT), bytes32(0), "UUPS: no ERC-1967 admin");
        vm.startPrank(makeAddr("fork.stranger"));
        (bool upgraded,) =
            MINING.call(abi.encodeWithSignature("upgradeToAndCall(address,bytes)", MINING_IMPLEMENTATION, ""));
        (bool paused,) = MINING.call(abi.encodeWithSignature("pause()"));
        vm.stopPrank();
        assertFalse(upgraded, "a stranger cannot upgrade Mining");
        assertFalse(paused, "a stranger cannot pause Mining");

        vm.serializeUint(key, "forkBlock", forkBlock);
        vm.serializeUint(key, "inactiveToken", inactive);
        vm.serializeUint(key, "inactiveTokenStatus", mining.getMiner(inactiveKey).status);
        vm.serializeAddress(key, "miningOwner", miningOwner);
        vm.serializeBool(key, "miningPaused", IPausable(MINING).paused());
        vm.serializeAddress(key, "collectionBeaconOwner", beaconOwner);
        vm.serializeUint(key, "collectionBeaconOwnerCodeSize", beaconOwner.code.length);
        vm.serializeBytes32(key, "miningProxyCodeHash", MINING.codehash);
        vm.serializeBytes32(key, "miningImplementationCodeHash", MINING_IMPLEMENTATION.codehash);
        vm.serializeBytes32(key, "collectionProxyCodeHash", COLLECTION.codehash);
        vm.serializeBytes32(key, "collectionBeaconCodeHash", COLLECTION_BEACON.codehash);
        vm.serializeBytes32(key, "collectionImplementationCodeHash", collectionImplementation.codehash);
        vm.serializeBytes32(key, "bemCodeHash", BEM.codehash);
        vm.serializeUint(key, "bemCodeSize", BEM.code.length);
        vm.serializeBytes32(key, "bemErc1967ImplementationSlot", vm.load(BEM, IMPLEMENTATION_SLOT));
        vm.serializeUint(key, "bemDecimals", IERC20Metadata(BEM).decimals());
        vm.serializeAddress(key, "collectionImplementation", collectionImplementation);
        string memory out = vm.serializeAddress(key, "miningImplementation", MINING_IMPLEMENTATION);
        vm.writeJson(out, "reports/fork-identity.json");
    }

    /// @notice The admission boundary on real protocol state: the NAND-only miner's income is settled
    ///         under the old (all-NAND) composition inside the admission of the LATCH-burning miner,
    ///         whose carried income is split by the new composition.
    function testForkStrictAdmissionBoundaryWithRealMiners() public {
        _deploySystem();
        IMining.MinerRecord memory rn = mining.getMiner(mining.minerKey(COLLECTION, nandMiner));
        IMining.MinerRecord memory rl = mining.getMiner(mining.minerKey(COLLECTION, latchMiner));

        (address holderN, uint256 pendingN) = _moveToDepositor(nandMiner);
        (uint256 settled0, uint256 carried0,) = _admit(_one(nandMiner));
        assertEq(settled0, 0);
        assertGe(carried0, pendingN, "income accrued before deposit belongs to the pool");
        assertEq(bem.balanceOf(depositor), 0, "carried income is not paid to the depositor");
        PoolMath.Accrual memory a0 = pool.accrual();
        assertEq(a0.latchIncome, 0, "an all-NAND composition gives LATCH nothing");

        vm.warp(block.timestamp + 3600);
        vm.roll(block.number + 8000);
        uint256 pendingOldAfterHour = mining.pending(mining.minerKey(COLLECTION, nandMiner));
        (address holderL, uint256 pendingL) = _moveToDepositor(latchMiner);
        (uint256 settled, uint256 carried, uint256 gasUsed) = _admit(_one(latchMiner));
        assertGt(settled, 0, "old miner's income was collected inside the admission");
        assertGe(carried, pendingL);

        // Expected allocation: settled under (n, 0), checkpoint, carried under (n + n', l').
        PoolMath.State memory s = PoolMath.State(0, 0, 0, rn.nandBurn, 0, 20, 10);
        PoolMath.Accrual memory afterOld = PoolMath.accrue(carried0 + settled, s);
        PoolMath.State memory s1 = PoolMath.State(
            afterOld.nandIncome,
            afterOld.latchIncome,
            afterOld.nandIncome + afterOld.latchIncome,
            uint256(rn.nandBurn) + rl.nandBurn,
            rl.latchBurn,
            20,
            10
        );
        PoolMath.Accrual memory expected = PoolMath.accrue(carried0 + settled + carried, s1);
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.total, expected.total);
        assertEq(a.nandIncome, expected.nandIncome, "NAND = old income at 100% + carried at n/(n+l)");
        assertEq(a.latchIncome, expected.latchIncome, "LATCH only from the carried income");
        assertEq(pool.totalNandBurn(), uint256(rn.nandBurn) + rl.nandBurn);
        assertEq(pool.totalLatchBurn(), rl.latchBurn);

        string memory key = "boundary";
        vm.serializeUint(key, "forkBlock", forkBlock);
        vm.serializeUint(key, "nandMiner", nandMiner);
        vm.serializeAddress(key, "nandMinerHolder", holderN);
        vm.serializeUint(key, "nandMinerBurn", rn.nandBurn);
        vm.serializeUint(key, "latchMiner", latchMiner);
        vm.serializeAddress(key, "latchMinerHolder", holderL);
        vm.serializeUint(key, "latchMinerNandBurn", rl.nandBurn);
        vm.serializeUint(key, "latchMinerLatchBurn", rl.latchBurn);
        vm.serializeUint(key, "firstAdmissionCarried", carried0);
        vm.serializeUint(key, "oldMinerPendingAfterOneHour", pendingOldAfterHour);
        vm.serializeUint(key, "settledOldIncome", settled);
        vm.serializeUint(key, "carriedIncome", carried);
        vm.serializeUint(key, "admissionGas", gasUsed);
        vm.serializeUint(key, "nandIncome", a.nandIncome);
        vm.serializeUint(key, "latchIncome", a.latchIncome);
        string memory out = vm.serializeUint(key, "recipientAEach", a.recipientA);
        vm.writeJson(out, "reports/fork-boundary.json");

        _claimsReleasesAndReconcile();
    }

    function _claimsReleasesAndReconcile() internal {
        // Users claim their receipts late; the BEM accrued while the distributor held them is intact.
        PoolMath.Accrual memory a = pool.accrual();
        vm.prank(alice);
        distributor.claim(100);
        vm.prank(alice);
        uint256 paid = pool.claimBatch(_range(1, 12), _range(1, 4));
        assertEq(paid, 12 * a.perNandShare + 4 * a.perLatchShare);
        // Bob's unclaimed NAND #13 moves with the receipt to carol.
        vm.prank(bob);
        distributor.claim(100);
        uint256 due = pool.claimable(NAND, 13);
        vm.prank(bob);
        nandReceipt.safeTransferFrom(bob, carol, 13, 1, "");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, NAND, 13));
        pool.claim(NAND, 13);
        vm.prank(carol);
        assertEq(pool.claim(NAND, 13), due);
        // Same numeric ID 13 does not exist in LATCH; LATCH #5 (carol) keeps its own history.
        vm.prank(carol);
        distributor.claim(100);
        vm.prank(carol);
        assertEq(pool.claim(LATCH, 5), a.perLatchShare);
        assertEq(pool.releaseA(), a.recipientA);
        assertEq(pool.releaseB(), a.recipientB);
        TapeoutMinerPool.Reconciliation memory r = pool.reconciliation();
        assertEq(r.deficit, 0);
        uint256 outstanding = (r.recipientAAccrued - r.recipientAPaid)
            + (r.recipientBAccrued - r.recipientBPaid) + (r.nandReceiptsAccrued - r.nandReceiptsPaid)
            + (r.latchReceiptsAccrued - r.latchReceiptsPaid);
        assertEq(r.bemBalance, outstanding + r.residue + r.unrecognized);
        assertLe(r.residue, 3 + 19 + 9);
    }

    /// @notice The composition the pool records equals Mining's computed local burn (circuitBurn), an
    ///         independent source from the miner record and burn cache the adapter reads. A circuit that
    ///         references sub-circuits (the collection records 123,264 gates for #109, including the
    ///         referenced ones, while circuitBurn computes a local burn of 0) is refused.
    function testForkCompositionMatchesCircuitBurnAndIgnoresReferences() public {
        _deploySystem();
        uint256[] memory ids = new uint256[](4);
        (ids[0], ids[1], ids[2], ids[3]) = (nandMiner, latchMiner, 4183, 1574);
        string memory key = "composition";
        for (uint256 i; i < ids.length; ++i) {
            (uint32 n, uint32 l) = ICircuitBurn(MINING).circuitBurn(COLLECTION, ids[i]);
            (,,, uint32 recordedGates) = ICircuitInfo(COLLECTION).circuitInfo(ids[i]);
            _moveToDepositor(ids[i]);
            _admit(_one(ids[i]));
            TapeoutMinerPool.Miner memory m = pool.miner(ids[i]);
            assertEq(m.nandBurn, n, "pool NAND = circuitBurn");
            assertEq(m.latchBurn, l, "pool LATCH = circuitBurn");
            assertEq(uint256(recordedGates), uint256(n) + l, "no references in this circuit");
            vm.serializeUint(key, string.concat("miner", vm.toString(ids[i]), "CircuitBurnNand"), n);
            vm.serializeUint(key, string.concat("miner", vm.toString(ids[i]), "CircuitBurnLatch"), l);
        }
        uint256 referencing = vm.envOr("FORK_REFERENCE_CIRCUIT", uint256(109));
        (uint32 rn, uint32 rl) = ICircuitBurn(MINING).circuitBurn(COLLECTION, referencing);
        (,,, uint32 rGates) = ICircuitInfo(COLLECTION).circuitInfo(referencing);
        (bool cached,,) = mining.cachedBurn(COLLECTION, referencing);
        bytes32 rKey = mining.minerKey(COLLECTION, referencing);
        assertGt(uint256(rGates), uint256(rn) + rl, "recorded gates include referenced sub-circuits");
        assertEq(uint256(rn) + rl, 0, "local burn of a circuit made only of references");
        assertEq(mining.getMiner(rKey).status, 0, "it cannot mine");
        _moveToDepositor(referencing);
        vm.startPrank(depositor);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.MinerNotActive.selector, referencing));
        pool.depositMiners(_one(referencing));
        vm.stopPrank();

        vm.serializeUint(key, "forkBlock", forkBlock);
        vm.serializeUint(key, "referenceCircuit", referencing);
        vm.serializeBytes32(key, "referenceCircuitKey", rKey);
        vm.serializeUint(key, "referenceCircuitRecordedGates", rGates);
        vm.serializeUint(key, "referenceCircuitLocalNand", rn);
        vm.serializeUint(key, "referenceCircuitLocalLatch", rl);
        vm.serializeBool(key, "referenceCircuitBurnCached", cached);
        string memory out = vm.serializeUint(key, "referenceCircuitStatus", mining.getMiner(rKey).status);
        vm.writeJson(out, "reports/fork-composition.json");
    }

    function testForkWhitelistAfterRenounceAndBypassRejection() public {
        _deploySystem();
        vm.prank(operator);
        pool.renounceOwnership();
        // The miner's own holder is not whitelisted.
        address holder = collection.ownerOf(nandMiner);
        vm.startPrank(holder);
        collection.setApprovalForAll(address(pool), true);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotDepositor.selector, holder));
        pool.depositMiners(_one(nandMiner));
        // A plain transfer does not admit, and its holder cannot register it.
        collection.transferFrom(holder, address(pool), nandMiner);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotDepositor.selector, holder));
        pool.registerMiners(_one(nandMiner));
        vm.stopPrank();
        assertEq(pool.minerCount(), 0);
        assertEq(pool.totalNandBurn(), 0);
        // The whitelisted depositor still admits after renunciation (here via registration).
        vm.prank(depositor);
        (, uint256 carried) = pool.registerMiners(_one(nandMiner));
        assertGt(carried, 0);
        assertEq(pool.minerCount(), 1);
        _moveToDepositor(latchMiner);
        (uint256 settled,,) = _admit(_one(latchMiner));
        assertEq(pool.minerCount(), 2);
        assertGe(settled, 0);
    }

    /// @notice Admission gas on real Mining as the registry grows; every registered miner has accrued
    ///         income (one hour) and accounts are cold, like a stand-alone transaction.
    function testForkAdmissionGasScaling() public {
        _deploySystem();
        uint256[] memory ids = vm.envUint("FORK_SCALE_MINERS", ",");
        string memory key = "scaling";
        uint256 lastGas;
        uint256 lastCount;
        uint256 maxPerMiner;
        for (uint256 i; i < ids.length; ++i) {
            _moveToDepositor(ids[i]);
            vm.warp(block.timestamp + 3600);
            vm.roll(block.number + 8000);
            _coolProtocol();
            uint256 registered = pool.minerCount();
            (,, uint256 gasUsed) = _admit(_one(ids[i]));
            vm.serializeUint(key, string.concat("admitWith", vm.toString(registered), "Registered"), gasUsed);
            if (registered > 1 && gasUsed > lastGas) {
                uint256 perMiner = (gasUsed - lastGas) / (registered - lastCount);
                if (perMiner > maxPerMiner) maxPerMiner = perMiner;
            }
            (lastGas, lastCount) = (gasUsed, registered);
            assertLt(gasUsed, TX_GAS_CAP);
        }
        vm.serializeUint(key, "registeredAtEnd", pool.minerCount());
        vm.serializeUint(key, "lastAdmissionGas", lastGas);
        vm.serializeUint(key, "maxMarginalGasPerRegisteredMiner", maxPerMiner);
        string memory out = vm.serializeUint(key, "forkBlock", forkBlock);
        vm.writeJson(out, "reports/fork-gas.json");
    }
}
