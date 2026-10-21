// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IMining} from "../../src/interfaces/IMining.sol";

/// @dev Status-changing functions of the deployed Mining contract (official frontend ABI; the frontend
///      gives no argument names, these are descriptive), not used by the pool.
interface IMiningTransitions {
    function start(
        address circuits,
        uint256 circuitId,
        uint32 taskId,
        uint256 anchorBlock,
        bytes[] calldata inputs,
        bytes[] calldata outputs,
        bytes32[][] calldata proofs,
        bytes32 design
    ) external returns (bytes32);
    function stop(bytes32 key) external;
    function reclaim(bytes32 key) external;
    function claimMany(bytes32[] calldata keys) external;
    function STOP_COOLDOWN() external view returns (uint256);
    function totalVerifWeight() external view returns (uint256);
    function totalUnverWeight() external view returns (uint256);
}

/// @notice Executed evidence for the Mining status lifecycle the pool relies on (release gate U-01), on
///         local BSC forks only (run through scripts/fork-test.ts). Two real states are used:
///         - FORK_BLOCK, the suite's pinned block: revoked miner #2247 and cooling miner #672 as they are.
///         - Block 119,597,280, the block before #2247's real revocation, where the real challenge
///           transaction (0x2234e269…bb14) is replayed from its real sender with its exact calldata, at
///           the real block number and timestamp.
///         Mining's implementation is 0xa3DBe873… at both blocks (it became the implementation at block
///         119,565,927). Nothing in the protocol's code or storage is modified (no vm.etch / vm.store /
///         mockCall / deal); current holders and the real challenger are impersonated and block number
///         and time are advanced inside the fork only. The static analysis of the same bytecode is in
///         docs/MINING_LIFECYCLE.md. Each test writes its observations to reports/fork-transitions-*.json.
contract MiningTransitionsForkTest is Test {
    address internal constant COLLECTION = 0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C;
    address internal constant MINING = 0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46;
    address internal constant BEM = 0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a;
    address internal constant IMPLEMENTATION = 0xa3DBe873DA37cD4e4a13c7cEf23a7dB6Ca60f898;
    bytes32 internal constant IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    uint8 internal constant ACTIVE = 1;
    uint8 internal constant REVOKED = 2;
    uint8 internal constant COOLING = 3;
    /// @dev Revert data of the deployed implementation (located in its bytecode; see docs/MINING_LIFECYCLE.md).
    bytes4 internal constant NOT_ACTIVE = 0x5f9bb3be; // claim, stop, challenge: status is not ACTIVE
    bytes4 internal constant NOT_STARTABLE = 0x802cdbc8; // start: not idle and not COOLING past the cooldown
    bytes4 internal constant NOT_RECLAIMABLE = 0xd4c8e0a4; // reclaim: status is not ACTIVE
    bytes4 internal constant NOT_HOLDER = 0xa8ee9629; // start, stop: caller does not hold the miner NFT
    bytes32 internal constant CLAIMED = keccak256("Claimed(bytes32,address,uint256)");
    bytes32 internal constant REVOKED_EVENT = keccak256("Revoked(bytes32,address,uint32)");
    bytes32 internal constant STARTED = keccak256(
        "Started(bytes32,address,uint256,uint32,address,uint64,uint64,bool,uint256,uint256,uint32)"
    );

    uint256 internal constant REVOKED_MINER = 2247;
    uint256 internal constant COOLING_MINER = 672;
    /// @dev #2247's real revocation: BSC block 119,597,281 (timestamp 1,788,380,025), tx 0x2234e269…bb14,
    ///      challenge(key of #2247, vector 109, input, output, proof) from 0x98Ce…7712, which paid the
    ///      holder 1,454,667 raw BEM (`Claimed`) and then emitted `Revoked`.
    uint256 internal constant REVOKE_BLOCK = 119_597_281;
    uint256 internal constant REVOKE_TIMESTAMP = 1_788_380_025;
    uint256 internal constant HISTORICAL_REVOCATION_PAYMENT = 1_454_667;
    address internal constant CHALLENGER = 0x98Ce75463917E5fd1470675c6F133a38F7167712;
    bytes internal constant CHALLENGE_2247 =
        hex"2d33823a79c25f50999c54bafa666732345918052bd25cfbf7d716e48d496e84f5e19550000000000000000000000000000000000000000000000000000000000000006d00000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000010010100000001010100010101000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000838000a20559f74490bdd40bb49f133c6e0de2a6f87e2df8c094b51fb55be5796d8f19e2d7ac5f45ebcdf93dafc9fd5ef1ef5ef3d136237becea3b4f1231d5cd81d6b6e33e3e9883cfefe2dab679d5955e3953f20dde08689d0cc606bf19a929f9632a9d7da3a371dcbdff24b2f06ca7943672c40377cfd638d9e690fa5eb614959eef274eaa32351eb97eff80ef7c3b1474b934645600bb11a79b36730bad6861108430cd352a42877ceff57b128342800ea1286cac74014fa959654ba2de2a1fa44e6028b4165b9698af254045ba801915d5cd62b004da0979e23ed1cc854fda4916a50af910d617437937e4c1748ff03065b27daca2c9d99baae8e76bc3eb7";
    /// @dev 30 days of BSC blocks at 0.45 s.
    uint256 internal constant MONTH_OF_BLOCKS = 5_760_000;

    IMining internal mining = IMining(MINING);
    IMiningTransitions internal transitions = IMiningTransitions(MINING);
    IERC20 internal bem = IERC20(BEM);
    IERC721 internal collection = IERC721(COLLECTION);
    string internal rpc;
    uint256 internal forkBlock;

    function setUp() public {
        rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        forkBlock = vm.envUint("FORK_BLOCK");
        vm.createSelectFork(rpc, forkBlock);
    }

    // ---- helpers ---------------------------------------------------------------------------------

    function _key(uint256 id) internal view returns (bytes32) {
        return mining.minerKey(COLLECTION, id);
    }

    /// @dev The call `start` takes for an unverified miner (no task, no samples), as #672 was first
    ///      started (tx 0xdb8f133b…3922 at block 117,291,096).
    function _startUnverified(address from, uint256 id) internal returns (bool ok, bytes4 err, bytes32 key) {
        vm.prank(from);
        try transitions.start(
            COLLECTION, id, 0, 0, new bytes[](0), new bytes[](0), new bytes32[][](0), bytes32(0)
        ) returns (
            bytes32 k
        ) {
            return (true, bytes4(0), k);
        } catch (bytes memory reason) {
            return (false, _selector(reason), bytes32(0));
        }
    }

    function _selector(bytes memory reason) internal pure returns (bytes4 s) {
        if (reason.length >= 4) s = bytes4(reason);
    }

    function _claimError(bytes32 key) internal returns (bytes4) {
        try mining.claim(key) {
            return bytes4(0);
        } catch (bytes memory reason) {
            return _selector(reason);
        }
    }

    function _stopError(address from, bytes32 key) internal returns (bytes4) {
        vm.prank(from);
        try transitions.stop(key) {
            return bytes4(0);
        } catch (bytes memory reason) {
            return _selector(reason);
        }
    }

    function _reclaimError(address from, bytes32 key) internal returns (bytes4) {
        vm.prank(from);
        try transitions.reclaim(key) {
            return bytes4(0);
        } catch (bytes memory reason) {
            return _selector(reason);
        }
    }

    function _challenge() internal returns (bool ok, bytes4 err) {
        vm.prank(CHALLENGER);
        bytes memory ret;
        (ok, ret) = MINING.call(CHALLENGE_2247);
        if (!ok) err = _selector(ret);
    }

    /// @dev What a claim would pay at this moment, observed by balance delta on a snapshot, then undone.
    function _claimable(bytes32 key, address holder) internal returns (uint256 amount) {
        uint256 snapshot = vm.snapshotState();
        uint256 before = bem.balanceOf(holder);
        mining.claim(key);
        amount = bem.balanceOf(holder) - before;
        vm.revertToState(snapshot);
    }

    /// @dev Claimed amount for `key` to `to`, and whether Revoked / Started was emitted for `key`.
    function _events(Vm.Log[] memory logs, bytes32 key, address to)
        internal
        pure
        returns (uint256 claimed, uint256 claimedEvents, bool revoked, bool started)
    {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != MINING || l.topics.length < 2 || l.topics[1] != key) continue;
            if (l.topics[0] == CLAIMED && address(uint160(uint256(l.topics[2]))) == to) {
                claimed += abi.decode(l.data, (uint256));
                ++claimedEvents;
            }
            if (l.topics[0] == REVOKED_EVENT) revoked = true;
            if (l.topics[0] == STARTED) started = true;
        }
    }

    function _assertUnchanged(IMining.MinerRecord memory a, IMining.MinerRecord memory b, string memory what)
        internal
        pure
    {
        assertEq(a.status, b.status, string.concat(what, ": status"));
        assertEq(a.verifWeight, b.verifWeight, string.concat(what, ": verified weight"));
        assertEq(a.unverWeight, b.unverWeight, string.concat(what, ": unverified weight"));
        assertEq(a.debt, b.debt, string.concat(what, ": debt"));
        assertEq(a.stopBlock, b.stopBlock, string.concat(what, ": stopBlock"));
        assertEq(a.since, b.since, string.concat(what, ": since"));
    }

    /// @dev Positions the fork at #2247's real revocation: state of block 119,597,280, executing in block
    ///      119,597,281 at its real timestamp, with the implementation the pinned block also runs.
    function _atRevocation() internal returns (bytes32 key, address holder) {
        vm.createSelectFork(rpc, REVOKE_BLOCK - 1);
        vm.roll(REVOKE_BLOCK);
        vm.warp(REVOKE_TIMESTAMP);
        assertEq(
            address(uint160(uint256(vm.load(MINING, IMPLEMENTATION_SLOT)))),
            IMPLEMENTATION,
            "same implementation"
        );
        key = _key(REVOKED_MINER);
        holder = collection.ownerOf(REVOKED_MINER);
        IMining.MinerRecord memory r = mining.getMiner(key);
        assertEq(r.status, ACTIVE, "ACTIVE before its revocation");
        assertGt(uint256(r.verifWeight) + r.unverWeight, 0, "has weight before its revocation");
    }

    // ---- REVOKED ---------------------------------------------------------------------------------

    /// @notice At the pinned block, revoked miner #2247 has no weight and nothing pending. Its holder can
    ///         neither restart it (`start`), stop it, reclaim it nor claim it, `claimMany` skips it, and a
    ///         month later nothing has changed: nothing accrues and nothing can be collected.
    function testRevokedMinerStaysRevokedAndEarnsNothing() public {
        assertEq(
            address(uint160(uint256(vm.load(MINING, IMPLEMENTATION_SLOT)))), IMPLEMENTATION, "implementation"
        );
        bytes32 key = _key(REVOKED_MINER);
        address holder = collection.ownerOf(REVOKED_MINER);
        IMining.MinerRecord memory r0 = mining.getMiner(key);
        assertEq(r0.status, REVOKED, "REVOKED at the pinned block");
        assertEq(uint256(r0.verifWeight) + r0.unverWeight, 0, "a revoked miner has no weight");
        assertEq(mining.pending(key), 0, "nothing pending");
        uint256 balance = bem.balanceOf(holder);
        uint256 verifTotal = transitions.totalVerifWeight();
        uint256 unverTotal = transitions.totalUnverWeight();

        (bool started, bytes4 startErr,) = _startUnverified(holder, REVOKED_MINER);
        assertFalse(started, "the holder cannot restart a revoked miner");
        assertEq(startErr, NOT_STARTABLE);
        assertEq(_stopError(holder, key), NOT_ACTIVE, "stop");
        assertEq(_reclaimError(holder, key), NOT_RECLAIMABLE, "reclaim");
        assertEq(_claimError(key), NOT_ACTIVE, "claim");
        bytes32[] memory keys = new bytes32[](1);
        keys[0] = key;
        transitions.claimMany(keys); // skips it
        assertEq(bem.balanceOf(holder), balance, "claimMany paid nothing");
        _assertUnchanged(mining.getMiner(key), r0, "after the attempts");

        vm.warp(block.timestamp + 30 days);
        vm.roll(block.number + MONTH_OF_BLOCKS);
        assertEq(mining.pending(key), 0, "nothing accrues while revoked");
        assertEq(_claimError(key), NOT_ACTIVE, "claim, a month later");
        (started, startErr,) = _startUnverified(holder, REVOKED_MINER);
        assertFalse(started, "no restart a month later either");
        assertEq(startErr, NOT_STARTABLE);
        transitions.claimMany(keys);
        assertEq(bem.balanceOf(holder), balance, "nothing was ever paid");
        _assertUnchanged(mining.getMiner(key), r0, "a month later");
        assertEq(transitions.totalVerifWeight(), verifTotal, "verified total unchanged");
        assertEq(transitions.totalUnverWeight(), unverTotal, "unverified total unchanged");

        string memory obs = "revoked";
        vm.serializeUint(obs, "forkBlock", forkBlock);
        vm.serializeUint(obs, "miner", REVOKED_MINER);
        vm.serializeAddress(obs, "holder", holder);
        vm.serializeUint(obs, "debt", r0.debt);
        vm.serializeBytes32(obs, "startError", bytes32(startErr));
        string memory out =
            vm.serializeBool(obs, "stillRevokedAfterMonth", mining.getMiner(key).status == REVOKED);
        vm.writeJson(out, "reports/fork-transitions-revoked.json");
    }

    /// @notice Replays #2247's real revocation: the challenge first pays the holder exactly what a claim
    ///         pays at that moment (the historical 1,454,667 raw), then sets REVOKED and removes the
    ///         miner's weight from the total. From then on every way back is refused and nothing accrues.
    function testRealRevocationPaysHolderOnceThenNothing() public {
        (bytes32 key, address holder) = _atRevocation();
        IMining.MinerRecord memory r0 = mining.getMiner(key);
        uint256 verifTotal = transitions.totalVerifWeight();
        uint256 claimable = _claimable(key, holder);
        uint256 balance = bem.balanceOf(holder);

        vm.recordLogs();
        (bool ok,) = _challenge();
        assertTrue(ok, "the real challenge succeeds when replayed");
        (uint256 claimed, uint256 claimedEvents, bool revoked,) = _events(vm.getRecordedLogs(), key, holder);
        IMining.MinerRecord memory r1 = mining.getMiner(key);
        uint256 paid = bem.balanceOf(holder) - balance;

        assertTrue(revoked, "Revoked event");
        assertEq(claimedEvents, 1, "one Claimed event");
        assertEq(paid, claimable, "paid exactly what a claim would have paid");
        assertEq(paid, claimed, "Claimed matches the BEM received");
        assertEq(paid, HISTORICAL_REVOCATION_PAYMENT, "same amount as on chain");
        assertEq(r1.status, REVOKED);
        assertEq(uint256(r1.verifWeight) + r1.unverWeight, 0, "weight removed");
        assertEq(transitions.totalVerifWeight(), verifTotal - r0.verifWeight, "total verified weight reduced");
        assertEq(r1.debt, r0.debt + paid, "debt advanced by the payment, then frozen");

        (bool started, bytes4 startErr,) = _startUnverified(holder, REVOKED_MINER);
        assertFalse(started);
        assertEq(startErr, NOT_STARTABLE, "start");
        assertEq(_claimError(key), NOT_ACTIVE, "claim");
        assertEq(_stopError(holder, key), NOT_ACTIVE, "stop");
        assertEq(_reclaimError(holder, key), NOT_RECLAIMABLE, "reclaim");
        (bool again,) = _challenge();
        assertFalse(again, "cannot be revoked twice");

        vm.warp(block.timestamp + 30 days);
        vm.roll(block.number + MONTH_OF_BLOCKS);
        assertEq(mining.pending(key), 0, "nothing accrues after the revocation");
        assertEq(_claimError(key), NOT_ACTIVE, "claim, a month later");
        _assertUnchanged(mining.getMiner(key), r1, "a month after the revocation");
        assertEq(bem.balanceOf(holder), balance + paid, "paid once, at the revocation");

        string memory obs = "revocation";
        vm.serializeUint(obs, "block", REVOKE_BLOCK);
        vm.serializeAddress(obs, "holder", holder);
        vm.serializeUint(obs, "paidToHolder", paid);
        vm.serializeUint(obs, "weightRemoved", r0.verifWeight);
        vm.serializeUint(obs, "debtBefore", r0.debt);
        string memory out = vm.serializeUint(obs, "debtAfter", r1.debt);
        vm.writeJson(out, "reports/fork-transitions-revocation.json");
    }

    /// @notice A stopped (COOLING) miner can still be revoked during the 1,200-block cooldown, through
    ///         block stopBlock + 1,200, without any payment (stop already paid and removed the weight).
    ///         From stopBlock + 1,201 the challenge is refused and the holder can restart instead.
    function testStopCooldownDecidesBetweenRevocationAndRestart() public {
        (bytes32 key, address holder) = _atRevocation();
        uint256 claimable = _claimable(key, holder);
        uint256 balance = bem.balanceOf(holder);
        vm.prank(holder);
        transitions.stop(key);
        uint256 stopPaid = bem.balanceOf(holder) - balance;
        IMining.MinerRecord memory stopped = mining.getMiner(key);
        assertEq(stopPaid, claimable, "stop paid what a claim would have paid");
        assertEq(stopped.status, COOLING);
        assertEq(uint256(stopped.stopBlock), REVOKE_BLOCK);
        assertEq(uint256(stopped.verifWeight) + stopped.unverWeight, 0, "stop removed the weight");
        uint256 cooldown = transitions.STOP_COOLDOWN();
        assertEq(cooldown, 1200);
        uint256 snapshot = vm.snapshotState();

        // Last block of the cooldown: no restart, but the challenge still revokes, paying nothing.
        vm.roll(uint256(stopped.stopBlock) + cooldown);
        vm.warp(block.timestamp + 540);
        (bool started, bytes4 startErr,) = _startUnverified(holder, REVOKED_MINER);
        assertFalse(started, "no restart at stopBlock + cooldown");
        assertEq(startErr, NOT_STARTABLE);
        uint256 beforeChallenge = bem.balanceOf(holder);
        vm.recordLogs();
        (bool ok,) = _challenge();
        assertTrue(ok, "revocable at stopBlock + cooldown");
        (, uint256 claimedEvents, bool revoked,) = _events(vm.getRecordedLogs(), key, holder);
        IMining.MinerRecord memory r = mining.getMiner(key);
        assertTrue(revoked);
        assertEq(claimedEvents, 0, "a cooling miner's revocation pays nothing");
        assertEq(bem.balanceOf(holder), beforeChallenge);
        assertEq(r.status, REVOKED, "COOLING -> REVOKED");
        assertEq(r.debt, stopped.debt, "debt unchanged");
        (started, startErr,) = _startUnverified(holder, REVOKED_MINER);
        assertFalse(started, "and it can then never restart");
        assertEq(startErr, NOT_STARTABLE);

        // First block after the cooldown: the challenge is refused and the holder restarts.
        vm.revertToState(snapshot);
        vm.roll(uint256(stopped.stopBlock) + cooldown + 1);
        vm.warp(block.timestamp + 540);
        (bool challenged, bytes4 challengeErr) = _challenge();
        assertFalse(challenged, "not revocable after the cooldown");
        assertEq(challengeErr, NOT_ACTIVE);
        vm.recordLogs();
        (bool restarted,, bytes32 k) = _startUnverified(holder, REVOKED_MINER);
        assertTrue(restarted, "restart at stopBlock + cooldown + 1");
        assertEq(k, key, "same miner key");
        (,,, bool startedEvent) = _events(vm.getRecordedLogs(), key, holder);
        assertTrue(startedEvent, "Started event");
        IMining.MinerRecord memory again = mining.getMiner(key);
        assertEq(again.status, ACTIVE, "COOLING -> ACTIVE");
        assertEq(uint256(again.stopBlock), 0, "stopBlock cleared");
        assertEq(again.taskId, 0, "restarted unverified (no task)");
        assertGt(again.unverWeight, 0, "weight restored as unverified");

        string memory obs = "cooldown";
        vm.serializeUint(obs, "cooldownBlocks", cooldown);
        vm.serializeUint(obs, "stopBlock", stopped.stopBlock);
        vm.serializeUint(obs, "stopPaid", stopPaid);
        vm.serializeBool(obs, "revocableAtStopBlockPlusCooldown", ok);
        vm.serializeBytes32(obs, "challengeErrorAfterCooldown", bytes32(challengeErr));
        string memory out = vm.serializeBool(obs, "restartedAtStopBlockPlusCooldownPlusOne", restarted);
        vm.writeJson(out, "reports/fork-transitions-cooldown.json");
    }

    // ---- COOLING ---------------------------------------------------------------------------------

    /// @notice At the pinned block, cooling miner #672 (stopped at block 118,184,257) can be restarted by
    ///         its holder only. The restart sets ACTIVE, clears stopBlock, restores the weight and resets
    ///         the debt to the current accumulator: nothing is pending at the restart (the cooling period
    ///         earns nothing), and income then accrues from the restart and is claimable by the holder.
    function testCoolingMinerRestartsWithDebtRebased() public {
        bytes32 key = _key(COOLING_MINER);
        address holder = collection.ownerOf(COOLING_MINER);
        IMining.MinerRecord memory r0 = mining.getMiner(key);
        assertEq(r0.status, COOLING, "COOLING at the pinned block");
        assertEq(uint256(r0.verifWeight) + r0.unverWeight, 0, "a cooling miner has no weight");
        assertGt(block.number, uint256(r0.stopBlock) + transitions.STOP_COOLDOWN(), "cooldown long over");
        assertEq(_claimError(key), NOT_ACTIVE, "claim while cooling");
        uint256 unverTotal = transitions.totalUnverWeight();

        (bool started, bytes4 err,) = _startUnverified(makeAddr("transitions.stranger"), COOLING_MINER);
        assertFalse(started, "only the holder can restart");
        assertEq(err, NOT_HOLDER);

        vm.recordLogs();
        (bool restarted,, bytes32 k) = _startUnverified(holder, COOLING_MINER);
        assertTrue(restarted, "the holder restarts it");
        assertEq(k, key);
        (,,, bool startedEvent) = _events(vm.getRecordedLogs(), key, holder);
        assertTrue(startedEvent, "Started event");
        IMining.MinerRecord memory r1 = mining.getMiner(key);
        assertEq(r1.status, ACTIVE);
        assertEq(uint256(r1.stopBlock), 0, "stopBlock cleared");
        assertEq(r1.registrant, holder, "registrant is the restarting holder");
        assertEq(uint256(r1.since), block.timestamp, "since is the restart time");
        assertGt(r1.unverWeight, 0, "weight restored");
        assertEq(transitions.totalUnverWeight(), unverTotal + r1.unverWeight, "weight back in the total");
        assertTrue(r1.debt != r0.debt, "debt rebased");
        assertEq(mining.pending(key), 0, "nothing pending at the restart");
        uint256 balance = bem.balanceOf(holder);
        mining.claim(key);
        assertEq(bem.balanceOf(holder), balance, "a claim at the restart pays nothing");

        vm.warp(block.timestamp + 1 days);
        vm.roll(block.number + 192_000);
        uint256 claimable = _claimable(key, holder);
        assertGt(claimable, 0, "income accrues after the restart");
        mining.claim(key);
        assertEq(bem.balanceOf(holder), balance + claimable, "and is paid to the holder");

        string memory obs = "restart";
        vm.serializeUint(obs, "forkBlock", forkBlock);
        vm.serializeUint(obs, "miner", COOLING_MINER);
        vm.serializeAddress(obs, "holder", holder);
        vm.serializeUint(obs, "stopBlock", r0.stopBlock);
        vm.serializeUint(obs, "debtWhileCooling", r0.debt);
        vm.serializeUint(obs, "debtAtRestart", r1.debt);
        vm.serializeUint(obs, "unverifiedWeight", r1.unverWeight);
        string memory out = vm.serializeUint(obs, "claimableOneDayAfterRestart", claimable);
        vm.writeJson(out, "reports/fork-transitions-restart.json");
    }

    /// @notice The cooldown boundary on the current state: after a restart and a stop by the holder,
    ///         `start` is refused through block stopBlock + 1,200 and accepted from stopBlock + 1,201.
    function testRestartNeedsMoreThanTheCooldown() public {
        bytes32 key = _key(COOLING_MINER);
        address holder = collection.ownerOf(COOLING_MINER);
        (bool restarted,,) = _startUnverified(holder, COOLING_MINER);
        assertTrue(restarted);
        vm.warp(block.timestamp + 1 hours);
        vm.roll(block.number + 8000);
        vm.prank(holder);
        transitions.stop(key);
        IMining.MinerRecord memory stopped = mining.getMiner(key);
        assertEq(stopped.status, COOLING);
        assertEq(uint256(stopped.stopBlock), block.number);
        uint256 cooldown = transitions.STOP_COOLDOWN();

        vm.roll(uint256(stopped.stopBlock) + cooldown);
        vm.warp(block.timestamp + 540);
        (bool early, bytes4 err,) = _startUnverified(holder, COOLING_MINER);
        assertFalse(early, "refused at stopBlock + cooldown");
        assertEq(err, NOT_STARTABLE);
        vm.roll(uint256(stopped.stopBlock) + cooldown + 1);
        (bool onTime,,) = _startUnverified(holder, COOLING_MINER);
        assertTrue(onTime, "accepted at stopBlock + cooldown + 1");
        assertEq(mining.getMiner(key).status, ACTIVE);

        string memory obs = "boundary";
        vm.serializeUint(obs, "stopBlock", stopped.stopBlock);
        vm.serializeBool(obs, "refusedAtStopBlockPlusCooldown", !early);
        string memory out = vm.serializeBool(obs, "acceptedAtStopBlockPlusCooldownPlusOne", onTime);
        vm.writeJson(out, "reports/fork-transitions-boundary.json");
    }
}
