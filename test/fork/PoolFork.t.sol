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

interface IBeacon {
    function implementation() external view returns (address);
}

interface IMiningMany {
    function claimMany(bytes32[] calldata keys) external;
}

/// @notice Real BSC protocol state at a pinned block (run through scripts/fork-test.ts). Uses the
///         deployed miner collection, Mining and BEM without modifying their code or storage; miners
///         are moved from their current holders with fork-only impersonation. Deploys the exact Paris
///         artifacts from ./out. Env: FORK_RPC_URL, FORK_BLOCK, FORK_NAND_MINER, FORK_LATCH_MINER,
///         FORK_SCALE_MINERS (comma separated), FORK_INACTIVE_TOKEN.
contract PoolForkTest is Test {
    address internal constant COLLECTION = 0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C;
    address internal constant MINING = 0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46;
    address internal constant BEM = 0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a;
    address internal constant MINING_IMPLEMENTATION = 0xa3DBe873DA37cD4e4a13c7cEf23a7dB6Ca60f898;
    address internal constant COLLECTION_BEACON = 0xf8D6d8EB894d6971c8976Ad8b4971cbEFE028156;
    bytes32 internal constant IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 internal constant BEACON_SLOT =
        0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;
    bytes32 internal constant KEY_3204 = 0xb0e5b7d325dead6144886258056fb8e27ff5f6192aaa90fd0b45682c297c1c0d;
    uint256 internal constant TX_GAS_CAP = 16_777_216; // BEP-652 / EIP-7825, BSC Mendel (2026-04-28)

    TapeoutMinerPool.Category internal constant NAND = TapeoutMinerPool.Category.NAND;
    TapeoutMinerPool.Category internal constant LATCH = TapeoutMinerPool.Category.LATCH;

    IERC20 internal bem = IERC20(BEM);
    IMining internal mining = IMining(MINING);
    IERC721 internal collection = IERC721(COLLECTION);

    address internal operator = makeAddr("fork.operator");
    address internal depositor = makeAddr("fork.depositor");
    address internal recipientA = makeAddr("fork.recipientA");
    address internal recipientB = makeAddr("fork.recipientB");
    address internal alice = makeAddr("fork.alice");
    address internal bob = makeAddr("fork.bob");
    address internal carol = makeAddr("fork.carol");
    address internal keeper = makeAddr("fork.keeper");

    TapeoutEntitlementReceipt internal nandReceipt;
    TapeoutEntitlementReceipt internal latchReceipt;
    TapeoutMinerPool internal pool;
    TapeoutReceiptDistributor internal distributor;
    uint256 internal forkBlock;
    uint256 internal nandMiner;
    uint256 internal latchMiner;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        forkBlock = vm.envUint("FORK_BLOCK");
        vm.createSelectFork(rpc, forkBlock);
        nandMiner = vm.envUint("FORK_NAND_MINER");
        latchMiner = vm.envUint("FORK_LATCH_MINER");
    }

    // ---------------------------------------------------------------------------------- deployment

    function _artifact(string memory name) internal view returns (bytes memory) {
        return vm.parseJsonBytes(
            vm.readFile(string.concat("out/", name, ".sol/", name, ".json")), ".bytecode.object"
        );
    }

    function _create(bytes memory initCode) internal returns (address deployed) {
        assembly {
            deployed := create(0, add(initCode, 0x20), mload(initCode))
        }
        require(deployed != address(0), "artifact deployment failed");
    }

    /// @dev Receipts S_N = 20 / S_L = 10 -> distributor -> alice 12 + 4, bob 8, carol 6; pool active.
    function _deploySystem() internal {
        bytes memory receiptCode = _artifact("TapeoutEntitlementReceipt");
        nandReceipt = TapeoutEntitlementReceipt(
            _create(
                abi.encodePacked(
                    receiptCode,
                    abi.encode(keccak256("TAPEOUT_NAND_ENTITLEMENT"), "Fork NAND", "fNAND", "", operator)
                )
            )
        );
        latchReceipt = TapeoutEntitlementReceipt(
            _create(
                abi.encodePacked(
                    receiptCode,
                    abi.encode(keccak256("TAPEOUT_LATCH_ENTITLEMENT"), "Fork LATCH", "fLATCH", "", operator)
                )
            )
        );
        address[] memory depositors = new address[](1);
        depositors[0] = depositor;
        TapeoutMinerPool.Deployment memory d = TapeoutMinerPool.Deployment({
            owner: operator,
            bem: BEM,
            mining: MINING,
            minerCollection: COLLECTION,
            nandReceipt: address(nandReceipt),
            latchReceipt: address(latchReceipt),
            recipientA: recipientA,
            recipientB: recipientB,
            depositors: depositors,
            poolName: "Fork Pool"
        });
        pool = TapeoutMinerPool(_create(abi.encodePacked(_artifact("TapeoutMinerPool"), abi.encode(d))));
        distributor = TapeoutReceiptDistributor(
            _create(
                abi.encodePacked(_artifact("TapeoutReceiptDistributor"), abi.encode(operator, address(pool)))
            )
        );
        vm.startPrank(operator);
        nandReceipt.issue(operator, 20);
        latchReceipt.issue(address(distributor), 10); // minted straight into the distributor
        nandReceipt.finalizeIssuance();
        latchReceipt.finalizeIssuance();
        uint256[] memory ids = new uint256[](20);
        uint256[] memory ones = new uint256[](20);
        for (uint256 i; i < 20; ++i) {
            ids[i] = i + 1;
            ones[i] = 1;
        }
        nandReceipt.safeBatchTransferFrom(operator, address(distributor), ids, ones, "");
        TapeoutReceiptDistributor.AllocationInput[] memory e =
            new TapeoutReceiptDistributor.AllocationInput[](4);
        e[0] = TapeoutReceiptDistributor.AllocationInput(NAND, alice, 1, 12);
        e[1] = TapeoutReceiptDistributor.AllocationInput(LATCH, alice, 1, 4);
        e[2] = TapeoutReceiptDistributor.AllocationInput(NAND, bob, 13, 8);
        e[3] = TapeoutReceiptDistributor.AllocationInput(LATCH, carol, 5, 6);
        distributor.allocate(e);
        distributor.finalizeAllocation();
        pool.activate(20, 10);
        vm.stopPrank();
    }

    function _moveToDepositor(uint256 tokenId) internal returns (address holder, uint256 pendingBefore) {
        holder = collection.ownerOf(tokenId);
        bytes32 key = mining.minerKey(COLLECTION, tokenId);
        uint256 holderBem = bem.balanceOf(holder);
        pendingBefore = mining.pending(key);
        vm.prank(holder);
        collection.transferFrom(holder, depositor, tokenId);
        assertEq(bem.balanceOf(holder), holderBem, "transfer pays nothing to the previous holder");
        assertEq(mining.pending(key), pendingBefore, "transfer leaves the miner's income in place");
    }

    function _admit(uint256[] memory tokenIds)
        internal
        returns (uint256 settled, uint256 carried, uint256 gasUsed)
    {
        vm.startPrank(depositor);
        collection.setApprovalForAll(address(pool), true);
        uint256 g = gasleft();
        (settled, carried) = pool.depositMiners(tokenIds);
        gasUsed = g - gasleft();
        vm.stopPrank();
    }

    function _one(uint256 x) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = x;
    }

    function _range(uint256 first, uint256 last) internal pure returns (uint256[] memory r) {
        r = new uint256[](last - first + 1);
        for (uint256 i; i < r.length; ++i) {
            r[i] = first + i;
        }
    }

    function _coolProtocol() internal {
        vm.cool(address(pool));
        vm.cool(BEM);
        vm.cool(MINING);
        vm.cool(MINING_IMPLEMENTATION);
        vm.cool(COLLECTION);
        vm.cool(COLLECTION_BEACON);
        vm.cool(IBeacon(COLLECTION_BEACON).implementation());
    }

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
        vm.serializeUint(key, "forkBlock", forkBlock);
        vm.serializeUint(key, "inactiveToken", inactive);
        vm.serializeAddress(key, "collectionImplementation", IBeacon(COLLECTION_BEACON).implementation());
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
