// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IMining} from "../../src/interfaces/IMining.sol";

/// @dev Lifecycle functions of the deployed Mining contract (official frontend ABI), not used by the pool.
interface IMiningLifecycle {
    function stop(bytes32 key) external;
    function reclaim(bytes32 key) external;
    function pendingLive(bytes32 key) external view returns (uint256);
    function STOP_COOLDOWN() external view returns (uint256);
}

/// @notice Observations of the real Mining lifecycle at a pinned BSC block (run through scripts/fork-test.ts).
///         Nothing in the protocol's code or storage is modified; the current NFT holders are
///         impersonated and time is advanced inside the fork only. Writes reports/fork-lifecycle.json.
///         Env: FORK_RPC_URL, FORK_BLOCK, FORK_NAND_MINER, FORK_LATCH_MINER.
contract MiningLifecycleForkTest is Test {
    address internal constant COLLECTION = 0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C;
    address internal constant MINING = 0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46;
    address internal constant BEM = 0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a;
    bytes4 internal constant NOT_ACTIVE = 0x5f9bb3be;
    bytes32 internal constant CLAIMED = keccak256("Claimed(bytes32,address,uint256)");
    bytes32 internal constant STOPPED = keccak256("Stopped(bytes32,address)");
    bytes32 internal constant TRANSFER = keccak256("Transfer(address,address,uint256)");

    IMining internal mining = IMining(MINING);
    IMiningLifecycle internal lifecycle = IMiningLifecycle(MINING);
    IERC20 internal bem = IERC20(BEM);
    IERC721 internal collection = IERC721(COLLECTION);
    uint256 internal forkBlock;
    string internal constant KEY = "lifecycle";

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        forkBlock = vm.envUint("FORK_BLOCK");
        vm.createSelectFork(rpc, forkBlock);
    }

    function _claimReverts(bytes32 key) internal returns (bool reverted, bytes4 selector) {
        try mining.claim(key) {}
        catch (bytes memory reason) {
            reverted = true;
            if (reason.length >= 4) selector = bytes4(reason);
        }
    }

    /// @dev Sum of Claimed amounts for `key` to `to`, and BEM transferred to `to`, in the recorded logs.
    function _paid(Vm.Log[] memory logs, bytes32 key, address to)
        internal
        pure
        returns (uint256 claimed, uint256 transferred, bool stopped)
    {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (
                l.emitter == MINING && l.topics[0] == CLAIMED && l.topics[1] == key
                    && address(uint160(uint256(l.topics[2]))) == to
            ) {
                claimed += abi.decode(l.data, (uint256));
            }
            if (l.emitter == MINING && l.topics[0] == STOPPED && l.topics[1] == key) stopped = true;
            if (l.emitter == BEM && l.topics[0] == TRANSFER && address(uint160(uint256(l.topics[2]))) == to) {
                transferred += abi.decode(l.data, (uint256));
            }
        }
    }

    /// @notice stop() by the current holder pays the miner's accrued income to the holder in the same
    ///         transaction, then the miner is COOLING (3): claim reverts and nothing more is collectible.
    function testStopByHolderSettlesAccruedIncomeThenCools() public {
        uint256 id = vm.envOr("FORK_NAND_MINER", uint256(12733));
        bytes32 key = mining.minerKey(COLLECTION, id);
        address holder = collection.ownerOf(id);
        assertEq(mining.getMiner(key).status, 1);
        // pendingLive is in the frontend ABI but the deployed implementation reverts on it (empty data).
        bool liveImplemented = true;
        try lifecycle.pendingLive(key) {}
        catch {
            liveImplemented = false;
        }
        vm.warp(block.timestamp + 3600);
        vm.roll(block.number + 4800);
        uint256 stalePending = mining.pending(key);
        uint256 before = bem.balanceOf(holder);

        // What a claim would pay at this exact timestamp, observed by balance delta, then undone.
        uint256 snapshot = vm.snapshotState();
        mining.claim(key);
        uint256 claimable = bem.balanceOf(holder) - before;
        vm.revertToState(snapshot);

        vm.recordLogs();
        vm.prank(holder);
        lifecycle.stop(key);
        (uint256 claimed, uint256 transferred, bool stopped) = _paid(vm.getRecordedLogs(), key, holder);
        uint256 paid = bem.balanceOf(holder) - before;
        IMining.MinerRecord memory r = mining.getMiner(key);

        assertTrue(stopped, "Stopped event");
        assertGt(claimable, 0, "income accrued before the stop");
        assertEq(paid, claimable, "stop paid exactly what a claim would have paid, to the holder");
        assertEq(paid, claimed, "Claimed event matches the BEM received");
        assertEq(paid, transferred, "BEM Transfer to the holder matches");
        assertEq(r.status, 3, "COOLING after stop");
        assertEq(uint256(r.stopBlock), block.number, "stopBlock recorded");
        (bool reverted, bytes4 selector) = _claimReverts(key);
        assertTrue(reverted, "claim reverts while cooling");
        assertEq(selector, NOT_ACTIVE);

        // Nothing becomes collectible while stopped, also after the cooldown.
        uint256 cooldown = lifecycle.STOP_COOLDOWN();
        vm.warp(block.timestamp + cooldown + 1 days);
        vm.roll(block.number + 120_000);
        (reverted,) = _claimReverts(key);
        assertTrue(reverted, "claim still reverts after the cooldown");
        assertEq(bem.balanceOf(holder), before + paid, "no further payment to the holder");
        assertEq(mining.getMiner(key).status, 3, "stays COOLING until restarted");

        vm.serializeUint(KEY, "forkBlock", forkBlock);
        vm.serializeUint(KEY, "stopMiner", id);
        vm.serializeAddress(KEY, "stopHolder", holder);
        vm.serializeBool(KEY, "pendingLiveImplemented", liveImplemented);
        vm.serializeUint(KEY, "pendingStaleBeforeStop", stalePending);
        vm.serializeUint(KEY, "claimWouldPayAtStopTime", claimable);
        vm.serializeUint(KEY, "paidByStop", paid);
        vm.serializeUint(KEY, "claimedEventAmount", claimed);
        vm.serializeUint(KEY, "statusAfterStop", r.status);
        vm.serializeUint(KEY, "debtAfterStop", r.debt);
        vm.serializeUint(KEY, "stopCooldownSeconds", cooldown);
        string memory out = vm.serializeBool(KEY, "claimRevertsAfterCooldown", reverted);
        vm.writeJson(out, "reports/fork-lifecycle.json");
    }

    /// @notice Only the miner NFT's current holder can stop it: not the registrant who started it after
    ///         the NFT moved on, and not a stranger. (A pool-held miner can therefore not be stopped, since
    ///         the pool has no function that calls stop.)
    function testOnlyTheCurrentHolderCanStop() public {
        uint256 id = vm.envOr("FORK_LATCH_MINER", uint256(13948));
        bytes32 key = mining.minerKey(COLLECTION, id);
        address holder = collection.ownerOf(id);
        address registrant = mining.getMiner(key).registrant;
        address custodian = makeAddr("lifecycle.custodian");
        vm.prank(holder);
        collection.transferFrom(holder, custodian, id);
        assertEq(mining.getMiner(key).status, 1, "a transfer does not stop mining");

        bool registrantStopped = true;
        vm.prank(registrant);
        try lifecycle.stop(key) {}
        catch {
            registrantStopped = false;
        }
        bool strangerStopped = true;
        vm.prank(makeAddr("lifecycle.stranger"));
        try lifecycle.stop(key) {}
        catch {
            strangerStopped = false;
        }
        assertFalse(registrantStopped, "the registrant cannot stop a miner it no longer holds");
        assertFalse(strangerStopped, "a stranger cannot stop a miner");
        assertEq(mining.getMiner(key).status, 1);
        vm.prank(custodian);
        lifecycle.stop(key);
        assertEq(mining.getMiner(key).status, 3, "the current holder can");

        vm.serializeAddress("holderOnly", "registrant", registrant);
        vm.serializeAddress("holderOnly", "originalHolder", holder);
        vm.serializeUint("holderOnly", "miner", id);
        string memory out = vm.serializeBool("holderOnly", "registrantCouldStop", registrantStopped);
        vm.writeJson(out, "reports/fork-lifecycle-holder.json");
    }
}
