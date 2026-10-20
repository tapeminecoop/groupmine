// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutReceipt} from "../../src/TapeoutReceipt.sol";
import {PoolMath} from "../../src/PoolMath.sol";
import {IMining} from "../../src/interfaces/IMining.sol";

interface IBeacon {
    function implementation() external view returns (address);
}

/// @notice Real BSC protocol state at a pinned block (run through scripts/fork-test.ts).
///         Uses the deployed miner collection, Mining and BEM without modifying their code or
///         storage. Miners are moved from their current EOA holders with fork-only impersonation.
///         Skipped unless FORK_RPC_URL, FORK_BLOCK and FORK_MINER_IDS are set.
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

    TapeoutMinerPool.Category internal constant NAND = TapeoutMinerPool.Category.NAND;
    TapeoutMinerPool.Category internal constant LATCH = TapeoutMinerPool.Category.LATCH;

    IERC20 internal bem = IERC20(BEM);
    IMining internal mining = IMining(MINING);
    IERC721 internal collection = IERC721(COLLECTION);

    address internal operator = makeAddr("fork.operator");
    address internal feeTo = makeAddr("fork.fee");
    address internal histNandTo = makeAddr("fork.historicalNand");
    address internal histLatchTo = makeAddr("fork.historicalLatch");
    address internal alice = makeAddr("fork.alice");
    address internal bob = makeAddr("fork.bob");
    address internal carol = makeAddr("fork.carol");
    address internal keeper = makeAddr("fork.keeper");

    uint256[] internal minerIds;
    uint256 internal forkBlock;
    bytes32 internal artifactSha256;
    string internal observations = "fork";

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        forkBlock = vm.envUint("FORK_BLOCK");
        vm.createSelectFork(rpc, forkBlock);
        minerIds = vm.envUint("FORK_MINER_IDS", ",");
        require(minerIds.length >= 2, "need at least two miners");
    }

    function testForkProtocolIdentity() public {
        assertEq(block.chainid, 56);
        assertEq(address(uint160(uint256(vm.load(MINING, IMPLEMENTATION_SLOT)))), MINING_IMPLEMENTATION);
        assertEq(address(uint160(uint256(vm.load(COLLECTION, BEACON_SLOT)))), COLLECTION_BEACON);
        assertEq(IERC20Metadata(BEM).decimals(), 8);
        // minerKey is deterministic: same key for #3204 as recorded by the baseline.
        assertEq(mining.minerKey(COLLECTION, 3204), KEY_3204);
        vm.serializeUint(observations, "forkBlock", forkBlock);
        vm.serializeAddress(
            observations, "collectionImplementation", IBeacon(COLLECTION_BEACON).implementation()
        );
        string memory out = vm.serializeAddress(observations, "miningImplementation", MINING_IMPLEMENTATION);
        vm.writeJson(out, "reports/fork-identity.json");
    }

    function testForkPoolLifecycleWithRealMiners() public {
        uint256 n = minerIds.length;
        address[] memory holders = new address[](n);
        uint256[] memory pendingAtFork = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            holders[i] = collection.ownerOf(minerIds[i]);
            assertEq(holders[i].code.length, 0, "miner holder must be an EOA");
            pendingAtFork[i] = mining.pending(mining.minerKey(COLLECTION, minerIds[i]));
        }

        TapeoutMinerPool pool = _deployAndConfigure();

        // Miner 0 is deposited during setup; its carried income is collected at registration.
        uint256[] memory collected = new uint256[](n);
        uint256[] memory pendingAtDeposit = new uint256[](n);
        (collected[0], pendingAtDeposit[0]) = _moveAndDeposit(pool, minerIds[0], holders[0]);
        assertEq(pool.totalAccounted(), 0);
        bytes32 reviewed = pool.currentConfigHash();
        vm.prank(operator);
        pool.activate(reviewed);
        assertEq(pool.totalAccounted(), collected[0], "setup income recognized at activation");

        // The rest are deposited while ACTIVE and recognized immediately.
        for (uint256 i = 1; i < n; ++i) {
            (collected[i], pendingAtDeposit[i]) = _moveAndDeposit(pool, minerIds[i], holders[i]);
        }
        uint256 depositIncome = pool.totalAccounted();
        assertEq(bem.balanceOf(address(pool)), depositIncome);

        // One hour later: pending() may read zero, but claim() still settles. Harvest everything.
        vm.warp(block.timestamp + 3600);
        vm.roll(block.number + 8000);
        uint256[] memory pendingBefore = new uint256[](n);
        uint256 zeroPending;
        for (uint256 i; i < n; ++i) {
            pendingBefore[i] = mining.pending(mining.minerKey(COLLECTION, minerIds[i]));
            if (pendingBefore[i] == 0) zeroPending++;
        }
        uint256 balanceBefore = bem.balanceOf(address(pool));
        // Cold accounts, so the measured gas approximates a stand-alone harvest transaction.
        address[7] memory touched = [
            address(pool),
            BEM,
            MINING,
            MINING_IMPLEMENTATION,
            COLLECTION,
            COLLECTION_BEACON,
            IBeacon(COLLECTION_BEACON).implementation()
        ];
        for (uint256 i; i < touched.length; ++i) {
            vm.cool(touched[i]);
        }
        vm.recordLogs();
        uint256 gasBefore = gasleft();
        vm.prank(keeper);
        (uint256 received, uint256 failed) = pool.harvestRange(0, n);
        uint256 harvestGas = gasBefore - gasleft();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(failed, 0, "no real miner failed");
        assertGt(received, 0, "real Mining paid the pool after one hour");
        assertEq(bem.balanceOf(address(pool)) - balanceBefore, received, "only actual receipts accounted");
        assertEq(pool.totalAccounted(), depositIncome + received);
        uint256 perMinerSum;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(pool)
                    && logs[i].topics[0] == TapeoutMinerPool.MinerHarvested.selector
            ) {
                perMinerSum += abi.decode(logs[i].data, (uint256));
            }
        }
        assertEq(perMinerSum, received, "per-miner events sum to the harvest");

        // A third party calls the real Mining.claim directly: BEM goes to the holder (the pool).
        vm.warp(block.timestamp + 3600);
        vm.roll(block.number + 8000);
        uint256 keeperBefore = bem.balanceOf(keeper);
        balanceBefore = bem.balanceOf(address(pool));
        bytes32 key0 = mining.minerKey(COLLECTION, minerIds[0]);
        vm.prank(keeper);
        mining.claim(key0);
        uint256 thirdParty = bem.balanceOf(address(pool)) - balanceBefore;
        assertEq(bem.balanceOf(keeper), keeperBefore, "claim pays the holder, not the caller");
        assertEq(pool.unrecognizedBalance(), thirdParty);
        assertEq(pool.sync(), thirdParty);

        _claimsTransfersAndReleases(pool);

        // Observations for reports/fork-test.json.
        string memory key = "lifecycle";
        vm.serializeUint(key, "forkBlock", forkBlock);
        vm.serializeUint(key, "minerIds", minerIds);
        vm.serializeAddress(key, "minerHoldersAtFork", holders);
        vm.serializeUint(key, "pendingAtFork", pendingAtFork);
        vm.serializeUint(key, "pendingRightBeforeTransfer", pendingAtDeposit);
        vm.serializeUint(key, "collectedAtDeposit", collected);
        vm.serializeUint(key, "pendingBeforeHarvestAfterOneHour", pendingBefore);
        vm.serializeUint(key, "minersWithZeroPendingBeforeHarvest", zeroPending);
        vm.serializeUint(key, "harvestReceived", received);
        vm.serializeUint(key, "harvestGas", harvestGas);
        vm.serializeUint(key, "thirdPartyClaimReceived", thirdParty);
        vm.serializeBytes32(key, "deployedArtifactSha256", artifactSha256);
        vm.serializeAddress(key, "pool", address(pool));
        vm.serializeUint(key, "totalAccounted", pool.totalAccounted());
        vm.serializeUint(key, "totalPaid", pool.totalPaid());
        string memory out = vm.serializeUint(key, "poolBalanceEnd", bem.balanceOf(address(pool)));
        vm.writeJson(out, "reports/fork-lifecycle.json");
    }

    /// @dev Deploys the exact Paris-compiled deployment artifact from ./out (not this profile's build).
    function _deployArtifact(TapeoutMinerPool.Deployment memory d) internal returns (TapeoutMinerPool pool) {
        bytes memory creation = vm.parseJsonBytes(
            vm.readFile("out/TapeoutMinerPool.sol/TapeoutMinerPool.json"), ".bytecode.object"
        );
        artifactSha256 = sha256(creation);
        bytes memory initCode = abi.encodePacked(creation, abi.encode(d));
        address deployed;
        assembly {
            deployed := create(0, add(initCode, 0x20), mload(initCode))
        }
        require(deployed != address(0), "artifact deployment failed");
        pool = TapeoutMinerPool(deployed);
    }

    function _deployAndConfigure() internal returns (TapeoutMinerPool pool) {
        pool = _deployArtifact(
            TapeoutMinerPool.Deployment({
                owner: operator,
                bem: BEM,
                mining: MINING,
                minerCollection: COLLECTION,
                poolName: "Fork Pool",
                nand: TapeoutMinerPool.ReceiptMetadata("Fork NAND Receipt", "fNAND", ""),
                latch: TapeoutMinerPool.ReceiptMetadata("Fork LATCH Receipt", "fLATCH", "")
            })
        );
        // The specification example scaled by 1/10: S_N=90, H_N=10, S_L=8, H_L=2, W_N=0.8.
        vm.startPrank(operator);
        pool.configure(
            TapeoutMinerPool.Config({
                nandShares: 90,
                latchShares: 8,
                historicalNandShares: 10,
                historicalLatchShares: 2,
                nandWeight: 80_000_000,
                feeRecipient: feeTo,
                historicalNandRecipient: histNandTo,
                historicalLatchRecipient: histLatchTo
            })
        );
        pool.issueReceiptRange(NAND, alice, 1, 45);
        pool.issueReceiptRange(NAND, bob, 46, 45);
        pool.issueReceiptRange(LATCH, alice, 1, 4);
        pool.issueReceiptRange(LATCH, carol, 5, 4);
        collection.setApprovalForAll(address(pool), true);
        vm.stopPrank();
    }

    /// @dev Holder -> operator (fork impersonation), then operator -> pool through depositMiners.
    ///      `pending` is read right before the transfer: a claim on *any* miner refreshes Mining's
    ///      global accrual, so values read earlier in the test can be stale.
    function _moveAndDeposit(TapeoutMinerPool pool, uint256 tokenId, address holder)
        internal
        returns (uint256 collected, uint256 pendingBeforeTransfer)
    {
        bytes32 key = mining.minerKey(COLLECTION, tokenId);
        uint256 holderBem = bem.balanceOf(holder);
        pendingBeforeTransfer = mining.pending(key);
        vm.prank(holder);
        collection.transferFrom(holder, operator, tokenId);
        // The transfer settles nothing to the old holder and leaves the miner's income in place.
        assertEq(bem.balanceOf(holder), holderBem, "no settlement on NFT transfer");
        assertEq(mining.pending(key), pendingBeforeTransfer, "transfer does not touch the miner's income");
        uint256 before = bem.balanceOf(address(pool));
        uint256[] memory one = new uint256[](1);
        one[0] = tokenId;
        vm.prank(operator);
        pool.depositMiners(one);
        collected = bem.balanceOf(address(pool)) - before;
        assertEq(collection.ownerOf(tokenId), address(pool));
        assertTrue(pool.isMiner(tokenId));
        assertEq(pool.minerKeyOf(tokenId), key);
        assertGe(collected, pendingBeforeTransfer, "income accrued before deposit belongs to the pool");
        assertEq(bem.balanceOf(operator), 0, "operator received nothing");
    }

    function _claimsTransfersAndReleases(TapeoutMinerPool pool) internal {
        PoolMath.Accrual memory a = pool.accrual();
        assertGt(a.perNandShare, 0);
        assertEq(a.fee, a.total * 2 / 102);

        uint256[] memory aliceNand = _range(1, 45);
        uint256[] memory aliceLatch = _range(1, 4);
        uint256 before = bem.balanceOf(alice);
        vm.prank(alice);
        uint256 paid = pool.claimBatch(aliceNand, aliceLatch);
        assertEq(paid, 45 * a.perNandShare + 4 * a.perLatchShare);
        assertEq(bem.balanceOf(alice) - before, paid, "exact BEM delta to holder");

        // Unclaimed NAND #46 moves with the receipt from bob to carol.
        uint256 due = pool.claimable(NAND, 46);
        assertEq(due, a.perNandShare);
        TapeoutReceipt nandReceipt = pool.nandReceipt();
        vm.prank(bob);
        nandReceipt.safeTransferFrom(bob, carol, 46, 1, "");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, NAND, 46));
        pool.claim(NAND, 46);
        vm.prank(carol);
        assertEq(pool.claim(NAND, 46), due);
        // Same numeric IDs, separate histories: NAND #5..#8 were claimed by alice, LATCH #5 by carol.
        vm.prank(carol);
        assertEq(pool.claim(LATCH, 5), a.perLatchShare);
        assertEq(pool.claimed(NAND, 5), a.perNandShare);
        assertEq(pool.claimed(LATCH, 5), a.perLatchShare);
        assertEq(pool.claimable(NAND, 6), 0);
        assertEq(pool.claimable(LATCH, 6), a.perLatchShare);

        assertEq(pool.releaseFee(), a.fee);
        assertEq(pool.releaseHistorical(NAND), a.historicalNand);
        assertEq(pool.releaseHistorical(LATCH), a.historicalLatch);
        assertEq(bem.balanceOf(feeTo), a.fee);
        assertEq(bem.balanceOf(histNandTo), a.historicalNand);
        assertEq(bem.balanceOf(histLatchTo), a.historicalLatch);

        TapeoutMinerPool.Reconciliation memory r = pool.reconciliation();
        assertEq(r.deficit, 0);
        uint256 outstanding = (r.feeAccrued - r.feePaid) + (r.nandReceiptsAccrued - r.nandReceiptsPaid)
            + (r.latchReceiptsAccrued - r.latchReceiptsPaid)
            + (r.historicalNandAccrued - r.historicalNandPaid)
            + (r.historicalLatchAccrued - r.historicalLatchPaid);
        assertEq(r.bemBalance, outstanding + r.residue + r.unrecognized);
        assertEq(before, 0);
        assertEq(
            r.totalPaid,
            bem.balanceOf(alice) + bem.balanceOf(carol) + bem.balanceOf(feeTo) + bem.balanceOf(histNandTo)
                + bem.balanceOf(histLatchTo)
        );
        assertLe(r.residue, 1 + 99 + 9);
    }

    function _range(uint256 first, uint256 last) internal pure returns (uint256[] memory r) {
        r = new uint256[](last - first + 1);
        for (uint256 i; i < r.length; ++i) {
            r[i] = first + i;
        }
    }
}
