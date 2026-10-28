// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {PoolMath} from "../../src/PoolMath.sol";
import {IMining} from "../../src/interfaces/IMining.sol";
import {PoolForkBase} from "./PoolForkBase.sol";

/// @notice The SALUS remediation (2.2.0) on real BSC state: carried income attributed by each real
///         miner's own burn and independent of admission order, the custody finality gate, and an
///         inactive real miner refused without leaving its wallet. Expected values are independent
///         observations (what the real Mining.claim pays each miner at the admission timestamp, measured
///         on a snapshot and undone; burns read from Mining) and the specification's arithmetic written
///         here. Protocol code and storage are never modified.
///         Env (defaults verified at block 128,713,128): FORK_NAND_MINER, FORK_LATCH_MINER,
///         FORK_SALUS_INCOMING (4183,1574,6940), FORK_INACTIVE_TOKEN.
contract SalusForkTest is PoolForkBase {
    uint256 internal constant HOUR = 3600;

    function _incoming() internal view returns (uint256[] memory ids) {
        uint256[] memory defaults = new uint256[](3);
        (defaults[0], defaults[1], defaults[2]) = (4183, 1574, 6940);
        uint256[] memory extra = vm.envOr("FORK_SALUS_INCOMING", ",", defaults);
        ids = new uint256[](extra.length + 1);
        ids[0] = latchMiner;
        for (uint256 i; i < extra.length; ++i) {
            ids[i + 1] = extra[i];
        }
    }

    function _claimable(uint256 id) internal returns (uint256 paid) {
        bytes32 key = mining.minerKey(COLLECTION, id);
        address holder = collection.ownerOf(id);
        uint256 snapshot = vm.snapshotState();
        uint256 before = bem.balanceOf(holder);
        mining.claim(key);
        paid = bem.balanceOf(holder) - before;
        vm.revertToState(snapshot);
    }

    function _economics() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                pool.accrual(),
                pool.ledgerState(),
                pool.carriedIncome(),
                pool.carriedNandUnits(),
                pool.totalNandBurn(),
                pool.totalLatchBurn(),
                pool.reconciliation()
            )
        );
    }

    function _reverse(uint256[] memory a) internal pure returns (uint256[] memory r) {
        r = new uint256[](a.length);
        for (uint256 i; i < a.length; ++i) {
            r[i] = a[a.length - 1 - i];
        }
    }

    struct Observed {
        uint256[] incoming;
        uint256[] carried;
        uint256[] pendingBefore;
        uint256[] nands;
        uint256[] latches;
        uint256 settled;
        uint256 total;
        uint256 nandUnits;
    }

    /// @dev Independent observations at the admission timestamp and the specification's ledger units.
    function _observe(uint256[] memory incoming, uint256 firstCarried) internal returns (Observed memory o) {
        o.incoming = incoming;
        o.carried = new uint256[](incoming.length);
        o.pendingBefore = new uint256[](incoming.length);
        o.nands = new uint256[](incoming.length);
        o.latches = new uint256[](incoming.length);
        o.settled = _claimable(nandMiner);
        // The first miner is NAND only, and the old period runs at its all-NAND composition.
        o.total = firstCarried + o.settled;
        o.nandUnits = o.total * 80e18;
        for (uint256 i; i < incoming.length; ++i) {
            bytes32 key = mining.minerKey(COLLECTION, incoming[i]);
            IMining.MinerRecord memory r = mining.getMiner(key);
            (o.nands[i], o.latches[i]) = (r.nandBurn, r.latchBurn);
            o.pendingBefore[i] = mining.pending(key);
            o.carried[i] = _claimable(incoming[i]);
            o.nandUnits += o.carried[i] * 80e18 * o.nands[i] / (o.nands[i] + o.latches[i]);
            o.total += o.carried[i];
        }
    }

    /// @notice An old NAND-only miner settles under the old composition; four real incoming miners with
    ///         different burns carry what their own claims pay, attributed by their own burns. One batch,
    ///         the reversed batch, one-by-one admissions and two batches give the same ledger.
    function testForkCarriedIncomeIsAttributedPerMinerAndIndependentOfOrder() public {
        _deploySystem();
        uint256[] memory incoming = _incoming();
        _moveToDepositor(nandMiner);
        _moveAllToDepositor(incoming);
        (, uint256 firstCarried,) = _admit(_one(nandMiner));
        vm.warp(block.timestamp + HOUR);
        vm.roll(block.number + 8000);
        Observed memory o = _observe(incoming, firstCarried);

        uint256 snapshot = vm.snapshotState();
        (uint256 settled,,) = _admit(incoming);
        assertEq(settled, o.settled, "old miner settled what its real claim pays");
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.total, o.total);
        assertEq(a.nandIncome, o.nandUnits / 84e18, "NAND: each miner by its own burn");
        assertEq(a.latchIncome, (o.total * 80e18 - o.nandUnits) / 84e18, "LATCH: each miner by its own burn");
        for (uint256 i; i < incoming.length; ++i) {
            assertEq(pool.miner(incoming[i]).carriedIncome, o.carried[i], "per-miner carried income");
        }
        bytes32 batch = _economics();
        _record(o, a);

        vm.revertToState(snapshot);
        _admit(_reverse(incoming));
        assertEq(_economics(), batch, "reversed batch");

        vm.revertToState(snapshot);
        for (uint256 i; i < incoming.length; ++i) {
            _admit(_one(incoming[i]));
        }
        assertEq(_economics(), batch, "one by one, same timestamp");

        vm.revertToState(snapshot);
        uint256[] memory firstHalf = new uint256[](2);
        uint256[] memory secondHalf = new uint256[](incoming.length - 2);
        (firstHalf[0], firstHalf[1]) = (incoming[incoming.length - 1], incoming[0]);
        for (uint256 i = 1; i < incoming.length - 1; ++i) {
            secondHalf[i - 1] = incoming[i];
        }
        _admit(firstHalf);
        _admit(secondHalf);
        assertEq(_economics(), batch, "two batches");
    }

    function _record(Observed memory o, PoolMath.Accrual memory a) internal {
        string memory key = "salusCarried";
        vm.serializeUint(key, "forkBlock", forkBlock);
        vm.serializeUint(key, "oldMiner", nandMiner);
        vm.serializeUint(key, "incomingMiners", o.incoming);
        vm.serializeUint(key, "incomingNandBurn", o.nands);
        vm.serializeUint(key, "incomingLatchBurn", o.latches);
        vm.serializeUint(key, "incomingPendingBeforeAdmission", o.pendingBefore);
        vm.serializeUint(key, "incomingCarriedActual", o.carried);
        vm.serializeUint(key, "settledOldIncome", o.settled);
        vm.serializeUint(key, "nandIncome", a.nandIncome);
        vm.serializeUint(key, "latchIncome", a.latchIncome);
        vm.serializeString(key, "ordersCompared", "batch, reversed batch, one by one, two batches: identical");
        string memory out = vm.serializeUint(key, "total", a.total);
        vm.writeJson(out, "reports/fork-salus-carried.json");
    }

    /// @notice The custody finality gate with real miners: every owner must be renounced before the first
    ///         admission; the refusal leaves the miner with the wallet and nothing changed.
    function testForkFinalityGateOnRealProtocol() public {
        _deploySystemKeepingOwners();
        _moveToDepositor(nandMiner);
        vm.prank(depositor);
        collection.setApprovalForAll(address(pool), true);
        address[4] memory order =
            [address(pool), address(nandReceipt), address(latchReceipt), address(distributor)];
        for (uint256 i; i < 4; ++i) {
            vm.prank(depositor);
            vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.OwnershipNotRenounced.selector, order[i]));
            pool.depositMiners(_one(nandMiner));
            assertEq(collection.ownerOf(nandMiner), depositor);
            assertEq(pool.minerCount(), 0);
            vm.prank(operator);
            TapeoutMinerPool(order[i]).renounceOwnership(); // Ownable's renounceOwnership on each
        }
        vm.prank(depositor);
        (, uint256 carried) = pool.depositMiners(_one(nandMiner));
        assertTrue(pool.custodyOpen());
        assertEq(collection.ownerOf(nandMiner), address(pool));
        assertGt(carried, 0);
        vm.serializeUint("salusFinality", "forkBlock", forkBlock);
        vm.serializeUint("salusFinality", "miner", nandMiner);
        string memory out = vm.serializeUint("salusFinality", "carriedAfterGateOpened", carried);
        vm.writeJson(out, "reports/fork-salus-finality.json");
    }

    /// @notice A real miner that Mining does not report ACTIVE cannot be admitted; it stays with the
    ///         wallet and the pool is unchanged (SALUS #1: only atomic admission of ACTIVE miners).
    function testForkInactiveMinerAdmissionRevertsAndStaysWithTheWallet() public {
        _deploySystem();
        uint256 inactive = vm.envUint("FORK_INACTIVE_TOKEN");
        uint8 status = mining.getMiner(mining.minerKey(COLLECTION, inactive)).status;
        assertTrue(status != 1, "the pinned token is not ACTIVE");
        _moveToDepositor(inactive);
        vm.startPrank(depositor);
        collection.setApprovalForAll(address(pool), true);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.MinerNotActive.selector, inactive));
        pool.depositMiners(_one(inactive));
        vm.stopPrank();
        assertEq(collection.ownerOf(inactive), depositor);
        assertEq(pool.minerCount(), 0);
        assertFalse(pool.custodyOpen());
        assertEq(pool.totalAccounted(), 0);
        vm.serializeUint("salusInactive", "token", inactive);
        string memory out = vm.serializeUint("salusInactive", "status", status);
        vm.writeJson(out, "reports/fork-salus-inactive.json");
    }
}
