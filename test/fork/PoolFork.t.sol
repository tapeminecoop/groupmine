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
    ///         whose carried income is split by that miner's own burn (2.2.0, SALUS #2).
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

        // Expected allocation, written from the specification (ledger units of 1 / (84 * 10^18) raw BEM,
        // the participants' exact share of x raw units being x * 80 * 10^18): the first miner's carried
        // income and the old period's income all NAND, the incoming miner's carried income by its own
        // burn n' : l'. Not computed with PoolMath.
        (uint256 expectNand, uint256 expectLatch) =
            _splitAfterBoundary(carried0 + settled, carried, rl.nandBurn, rl.latchBurn);
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.total, carried0 + settled + carried);
        assertEq(a.nandIncome, expectNand, "NAND = old income at 100% + carried at n'/(n'+l')");
        assertEq(a.latchIncome, expectLatch, "LATCH only from the carried income, by its own burn");
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

    /// @dev `allNand` raw units entirely NAND, then `carried` by the burn n : l, in ledger units of
    ///      1 / (84 * 10^18) raw BEM (the participants' share of x raw units is x * 80 * 10^18 units).
    function _splitAfterBoundary(uint256 allNand, uint256 carried, uint256 n, uint256 l)
        internal
        pure
        returns (uint256 nandIncome, uint256 latchIncome)
    {
        uint256 nandUnits = allNand * 80e18 + carried * 80e18 * n / (n + l);
        nandIncome = nandUnits / 84e18;
        latchIncome = ((allNand + carried) * 80e18 - nandUnits) / 84e18;
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
        assertEq(pool.sinkPaid(), a.sink, "C was paid with the first release");
        TapeoutMinerPool.Reconciliation memory r = pool.reconciliation();
        assertEq(r.deficit, 0);
        uint256 outstanding = (r.recipientAAccrued - r.recipientAPaid)
            + (r.recipientBAccrued - r.recipientBPaid) + (r.sinkAccrued - r.sinkPaid)
            + (r.nandReceiptsAccrued - r.nandReceiptsPaid) + (r.latchReceiptsAccrued - r.latchReceiptsPaid);
        assertEq(r.bemBalance, outstanding + r.residue + r.unrecognized);
        assertLe(r.residue, 4 + 19 + 9);
    }

    /// @notice C leaves the pool as an ordinary transfer of real BEM to the fixed address 0x...dEaD,
    ///         which already holds BEM on BSC: its balance grows by exactly the pool's recorded payment,
    ///         the pool's balance falls by the role's and C's amounts together, the only transfers are
    ///         pool -> role and pool -> sink (none to the zero address), and BEM's totalSupply is
    ///         observed unchanged. Releases in either order pay C's backlog once.
    function testForkReleaseTransfersCToTheSinkOnRealBem() public {
        _deploySystem();
        _moveToDepositor(nandMiner);
        _moveToDepositor(latchMiner);
        uint256[] memory both = new uint256[](2);
        both[0] = nandMiner;
        both[1] = latchMiner;
        _admit(both);
        vm.warp(block.timestamp + 3600);
        vm.roll(block.number + 8000);
        vm.prank(keeper);
        pool.harvest(both);

        address sink = pool.SINK();
        assertEq(sink, 0x000000000000000000000000000000000000dEaD);
        PoolMath.Accrual memory a = pool.previewAccrual();
        assertGt(a.sink, 0);
        assertEq(a.sink, a.total * 2 / 84);
        uint256 supplyBefore = bem.totalSupply();
        uint256 sinkBefore = bem.balanceOf(sink);
        uint256 poolBefore = bem.balanceOf(address(pool));

        vm.recordLogs();
        vm.prank(keeper);
        assertEq(pool.releaseA(), a.recipientA);
        (uint256 toRole, uint256 toSink) = _bemTransfersFromPool(vm.getRecordedLogs(), recipientA, sink);
        assertEq(toRole, a.recipientA);
        assertEq(toSink, a.sink, "C's amount in one transfer to the sink");
        assertEq(bem.balanceOf(sink) - sinkBefore, a.sink);
        assertEq(poolBefore - bem.balanceOf(address(pool)), a.recipientA + a.sink);
        assertEq(pool.sinkPaid(), a.sink);
        uint256 supplyAfterFirst = bem.totalSupply();
        assertEq(supplyAfterFirst, supplyBefore, "the transfer to 0x...dEaD left BEM's totalSupply unchanged");

        // B at the same total: B only, C has nothing left.
        vm.recordLogs();
        vm.prank(keeper);
        assertEq(pool.releaseB(), a.recipientB);
        (toRole, toSink) = _bemTransfersFromPool(vm.getRecordedLogs(), recipientB, sink);
        assertEq(toRole, a.recipientB);
        assertEq(toSink, 0, "C is paid once");
        assertEq(pool.sinkClaimable(), 0);

        // More income; this time B releases first and carries C's whole new backlog. Mining pays
        // income by minting BEM, so the supply is compared around the releases only.
        vm.warp(block.timestamp + 3600);
        vm.roll(block.number + 8000);
        vm.prank(keeper);
        (uint256 received,) = pool.harvest(both);
        uint256 supplyAfterHarvest = bem.totalSupply();
        PoolMath.Accrual memory a2 = pool.previewAccrual();
        vm.prank(keeper);
        assertEq(pool.releaseB(), a2.recipientB - a.recipientB);
        assertEq(bem.balanceOf(sink) - sinkBefore, a2.sink);
        vm.prank(keeper);
        assertEq(pool.releaseA(), a2.recipientA - a.recipientA);
        assertEq(bem.balanceOf(sink) - sinkBefore, a2.sink);
        assertEq(bem.totalSupply(), supplyAfterHarvest, "the releases left BEM's totalSupply unchanged");

        TapeoutMinerPool.Reconciliation memory r = pool.reconciliation();
        assertEq(r.deficit, 0);
        assertEq(r.recipientAAccrued, r.totalAccounted / 84);
        assertEq(r.sinkAccrued, r.totalAccounted * 2 / 84);
        assertEq(r.sinkPaid, r.sinkAccrued);
        assertEq(r.totalPaid, r.recipientAPaid + r.recipientBPaid + r.sinkPaid);
        uint256 outstanding =
            (r.nandReceiptsAccrued - r.nandReceiptsPaid) + (r.latchReceiptsAccrued - r.latchReceiptsPaid);
        assertEq(r.bemBalance, outstanding + r.residue + r.unrecognized);
        assertLe(r.residue, 4 + 19 + 9);

        string memory key = "sink";
        vm.serializeUint(key, "forkBlock", forkBlock);
        vm.serializeAddress(key, "bem", BEM);
        vm.serializeBytes32(key, "bemRuntimeCodeHash", BEM.codehash);
        vm.serializeUint(key, "bemRuntimeBytes", BEM.code.length);
        vm.serializeAddress(key, "sink", sink);
        vm.serializeUint(key, "sinkBalanceBefore", sinkBefore);
        vm.serializeUint(key, "firstReleaseRoleA", a.recipientA);
        vm.serializeUint(key, "firstReleaseSink", a.sink);
        vm.serializeUint(key, "totalAccounted", r.totalAccounted);
        vm.serializeUint(key, "sinkPaid", r.sinkPaid);
        vm.serializeUint(key, "sinkBalanceAfter", bem.balanceOf(sink));
        vm.serializeUint(key, "bemTotalSupplyBefore", supplyBefore);
        vm.serializeUint(key, "bemTotalSupplyAfterFirstRelease", supplyAfterFirst);
        vm.serializeUint(key, "secondHarvestReceived", received);
        vm.serializeUint(key, "bemTotalSupplyAfterSecondHarvest", supplyAfterHarvest);
        string memory out = vm.serializeUint(key, "bemTotalSupplyAfterSecondReleases", bem.totalSupply());
        vm.writeJson(out, "reports/fork-sink.json");
    }

    /// @dev Sums the BEM Transfer events in `logs` to `role` and to `sink`; every BEM transfer must come
    ///      from the pool and go to one of them.
    function _bemTransfersFromPool(Vm.Log[] memory logs, address role, address sink)
        internal
        view
        returns (uint256 toRole, uint256 toSink)
    {
        bytes32 transfer = keccak256("Transfer(address,address,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != BEM || logs[i].topics[0] != transfer) continue;
            assertEq(address(uint160(uint256(logs[i].topics[1]))), address(pool));
            address to = address(uint160(uint256(logs[i].topics[2])));
            uint256 value = abi.decode(logs[i].data, (uint256));
            if (to == role) toRole += value;
            else if (to == sink) toSink += value;
            else revert("unexpected BEM transfer");
        }
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
        _deploySystem(); // renounces every owner, the pool's included
        assertEq(pool.owner(), address(0));
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
            // The CLI's planned bound (sdk/gas.ts: 300k + 30k per registered + 250k per incoming miner, plus
            // 150k for the admission that opens custody) must cover it with the 21,000 base and calldata.
            uint256 bound = 300_000 + 30_000 * registered + 250_000 + (registered == 0 ? 150_000 : 0);
            assertLe(gasUsed + 25_000, bound, "planned admission bound");
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
