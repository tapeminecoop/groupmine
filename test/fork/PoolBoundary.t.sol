// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Test.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutEntitlementReceipt} from "../../src/TapeoutEntitlementReceipt.sol";
import {PoolMath} from "../../src/PoolMath.sol";
import {IMining} from "../../src/interfaces/IMining.sol";
import {PoolForkBase} from "./PoolForkBase.sol";

/// @notice The admission boundary with several real miners on a pinned BSC fork. Expected values come
///         from independent observations, not from the pool: what the real Mining.claim pays each
///         miner at the admission timestamp (balance deltas on a snapshot, then undone), compositions
///         read from Mining, and the specification's formula written out below. Protocol code and
///         storage are never modified; holders are impersonated and time advances inside the fork only.
///         Env (defaults are miners verified at block 128,713,128): FORK_OLD_MINERS (12733,4183,1574),
///         FORK_INCOMING_MINERS (13948,6940), FORK_DONOR_MINER (4655).
contract PoolBoundaryForkTest is PoolForkBase {
    bytes32 internal constant INCOME_RECOGNIZED = keccak256("IncomeRecognized(uint256,uint256,uint256)");
    uint256 internal constant HOUR = 3600;

    uint256[] internal oldIds;
    uint256[] internal newIds;

    function setUp() public override {
        super.setUp();
        oldIds = vm.envOr("FORK_OLD_MINERS", ",", _defaults(12733, 4183, 1574));
        newIds = vm.envOr("FORK_INCOMING_MINERS", ",", _defaults(13948, 6940, 0));
    }

    function _defaults(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory r) {
        r = new uint256[](c == 0 ? 2 : 3);
        r[0] = a;
        r[1] = b;
        if (c != 0) r[2] = c;
    }

    // ---------------------------------------------------------------------------------- specification

    /// @dev 100/102 of a cumulative total, as the specification defines the participants' share.
    function _participants(uint256 total) internal pure returns (uint256) {
        return total * 100 / 102;
    }

    function _burns(uint256[] memory ids) internal view returns (uint256 n, uint256 l) {
        for (uint256 i; i < ids.length; ++i) {
            IMining.MinerRecord memory r = mining.getMiner(mining.minerKey(COLLECTION, ids[i]));
            n += r.nandBurn;
            l += r.latchBurn;
        }
    }

    function _concat(uint256[] memory a, uint256[] memory b) internal pure returns (uint256[] memory r) {
        r = new uint256[](a.length + b.length);
        for (uint256 i; i < a.length; ++i) {
            r[i] = a[i];
        }
        for (uint256 i; i < b.length; ++i) {
            r[a.length + i] = b[i];
        }
    }

    /// @dev What Mining.claim would pay for `id` right now, to its current holder: measured, then undone.
    function _claimable(uint256 id) internal returns (uint256 paid) {
        bytes32 key = mining.minerKey(COLLECTION, id);
        address holder = collection.ownerOf(id);
        uint256 snapshot = vm.snapshotState();
        uint256 before = bem.balanceOf(holder);
        mining.claim(key);
        paid = bem.balanceOf(holder) - before;
        vm.revertToState(snapshot);
    }

    /// @dev BEM sent to the pool outside any claim: a real claim pays a spare miner's holder, who
    ///      forwards part of it (fork-only impersonation of that holder).
    function _donate() internal returns (uint256 amount) {
        uint256 spare = vm.envOr("FORK_DONOR_MINER", uint256(4655));
        address donor = collection.ownerOf(spare);
        mining.claim(mining.minerKey(COLLECTION, spare));
        amount = bem.balanceOf(donor) / 3;
        assertGt(amount, 0, "donor has BEM");
        vm.prank(donor);
        bem.transfer(address(pool), amount);
    }

    function _recognized(Vm.Log[] memory logs)
        internal
        view
        returns (uint256[] memory amounts, uint256[] memory periods)
    {
        uint256 count;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(pool) && logs[i].topics[0] == INCOME_RECOGNIZED) ++count;
        }
        amounts = new uint256[](count);
        periods = new uint256[](count);
        uint256 j;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(pool) || logs[i].topics[0] != INCOME_RECOGNIZED) continue;
            (uint256 received,, uint256 period) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            (amounts[j], periods[j]) = (received, period);
            ++j;
        }
    }

    // ---------------------------------------------------------------------------------- tests

    /// @notice Three old miners accrue on the real protocol; a two-miner batch that shifts NAND:LATCH is
    ///         admitted. Old income (and BEM already held) is recognized under the old composition, the
    ///         batch's carried income under the full post-batch composition, and at the same timestamp
    ///         nothing more can be collected from any of the miners.
    function testForkBoundaryWithThreeOldMinersAndAnIncomingBatch() public {
        _deploySystem();
        _moveAllToDepositor(_concat(oldIds, newIds));
        (uint256 settled0, uint256 carried0,) = _admit(oldIds);
        assertEq(settled0, 0);
        (uint256 n1, uint256 l1) = _burns(oldIds);
        assertEq(pool.totalNandBurn(), n1);
        assertEq(pool.totalLatchBurn(), l1);

        vm.warp(block.timestamp + HOUR);
        vm.roll(block.number + 8000);
        uint256 donation = _donate();

        // Independent observations at the admission timestamp.
        uint256[] memory oldPay = new uint256[](oldIds.length);
        uint256 expectSettled;
        for (uint256 i; i < oldIds.length; ++i) {
            oldPay[i] = _claimable(oldIds[i]);
            assertGt(oldPay[i], 0, "every old miner has income to settle");
            expectSettled += oldPay[i];
        }
        uint256 expectCarried;
        for (uint256 i; i < newIds.length; ++i) {
            expectCarried += _claimable(newIds[i]);
        }

        uint256 poolBefore = bem.balanceOf(address(pool));
        vm.recordLogs();
        (uint256 settled, uint256 carried, uint256 gasUsed) = _admit(newIds);
        (uint256[] memory recognized, uint256[] memory periods) = _recognized(vm.getRecordedLogs());

        assertEq(settled, expectSettled, "old miners settled exactly what real claims pay at this timestamp");
        assertEq(carried, expectCarried, "the batch carried exactly what real claims pay at this timestamp");
        assertEq(bem.balanceOf(address(pool)) - poolBefore, settled + carried, "pool balance delta");
        // Recognition order: held BEM and old income in period 1, carried income in period 2.
        assertEq(recognized.length, 3);
        assertEq(recognized[0], donation);
        assertEq(periods[0], 1);
        assertEq(recognized[1], settled);
        assertEq(periods[1], 1);
        assertEq(recognized[2], carried);
        assertEq(periods[2], 2);

        // Same timestamp: no old or incoming miner has anything left to pay.
        uint256[] memory all = _concat(oldIds, newIds);
        for (uint256 i; i < all.length; ++i) {
            uint256 b = bem.balanceOf(address(pool));
            mining.claim(mining.minerKey(COLLECTION, all[i]));
            assertEq(bem.balanceOf(address(pool)), b, "nothing more collectible at the admission timestamp");
        }

        // The specification's allocation, computed here independently of PoolMath.
        (uint256 n2, uint256 l2) = _burns(all);
        uint256 t2 = carried0 + donation + settled; // period 1: everything up to the checkpoint
        uint256 t3 = t2 + carried; // period 2: the batch's carried income
        uint256 nand1 = _participants(t2) * n1 / (n1 + l1);
        uint256 latch1 = _participants(t2) * l1 / (n1 + l1);
        uint256 d = _participants(t3) - nand1 - latch1;
        uint256 expectNand = nand1 + d * n2 / (n2 + l2);
        uint256 expectLatch = latch1 + d * l2 / (n2 + l2);
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.total, t3);
        assertEq(a.nandIncome, expectNand);
        assertEq(a.latchIncome, expectLatch);
        assertEq(a.recipientA, t3 / 102);
        assertEq(a.recipientB, t3 / 102);
        // Splitting everything by the latest ratio would have given LATCH more: the boundary mattered.
        assertGt(_participants(t3) * l2 / (n2 + l2), expectLatch);

        string memory key = "boundaryMulti";
        vm.serializeUint(key, "forkBlock", forkBlock);
        vm.serializeUint(key, "oldMiners", oldIds);
        vm.serializeUint(key, "incomingMiners", newIds);
        vm.serializeUint(key, "oldNandBurn", n1);
        vm.serializeUint(key, "oldLatchBurn", l1);
        vm.serializeUint(key, "postBatchNandBurn", n2);
        vm.serializeUint(key, "postBatchLatchBurn", l2);
        vm.serializeUint(key, "firstAdmissionCarried", carried0);
        vm.serializeUint(key, "heldBeforeAdmission", donation);
        vm.serializeUint(key, "oldMinerClaimable", oldPay);
        vm.serializeUint(key, "settledOldIncome", settled);
        vm.serializeUint(key, "carriedIncome", carried);
        vm.serializeUint(key, "nandIncome", a.nandIncome);
        vm.serializeUint(key, "latchIncome", a.latchIncome);
        vm.serializeUint(key, "recipientAEach", a.recipientA);
        string memory out = vm.serializeUint(key, "admissionGas", gasUsed);
        vm.writeJson(out, "reports/fork-boundary-multi.json");
    }

    /// @notice From the same snapshot and timestamps, admitting the old miners in another order (so they
    ///         are settled in another order) and the incoming batch in another order gives the same ledger.
    function testForkBoundaryIsIndependentOfProcessingOrder() public {
        _deploySystem();
        _moveAllToDepositor(_concat(oldIds, newIds));
        uint256 t0 = block.timestamp;
        uint256 b0 = block.number;
        uint256 snapshot = vm.snapshotState();
        uint256[6] memory forward = _scenario(oldIds, newIds, t0, b0);
        uint256 firstForward = _firstRegistered();
        vm.revertToState(snapshot);
        uint256[6] memory reverse = _scenario(_reversed(oldIds), _reversed(newIds), t0, b0);
        assertTrue(_firstRegistered() != firstForward, "settlement order really differed");
        for (uint256 i; i < 6; ++i) {
            assertEq(forward[i], reverse[i]);
        }
        vm.serializeUint("order", "nandIncome", forward[1]);
        vm.serializeUint("order", "latchIncome", forward[2]);
        string memory out = vm.serializeUint("order", "total", forward[0]);
        vm.writeJson(out, "reports/fork-boundary-order.json");
    }

    function _firstRegistered() internal view returns (uint256 id) {
        (id,) = pool.minerAt(0);
    }

    function _reversed(uint256[] memory a) internal pure returns (uint256[] memory r) {
        r = new uint256[](a.length);
        for (uint256 i; i < a.length; ++i) {
            r[i] = a[a.length - 1 - i];
        }
    }

    function _scenario(uint256[] memory olds, uint256[] memory incoming, uint256 t0, uint256 b0)
        internal
        returns (uint256[6] memory out)
    {
        vm.warp(t0);
        vm.roll(b0);
        _admit(olds);
        vm.warp(t0 + HOUR);
        vm.roll(b0 + 8000);
        (uint256 settled, uint256 carried,) = _admit(incoming);
        PoolMath.Accrual memory a = pool.accrual();
        out = [a.total, a.nandIncome, a.latchIncome, a.recipientA, settled, carried];
    }

    /// @notice The registration window, documented: if anyone claims a miner's income after it reached
    ///         the pool by plain transfer but before registerMiners, that income is recognized under the
    ///         composition current at that moment, not the post-registration one an atomic deposit uses.
    function testForkPlainTransferThenRegisterWindow() public {
        _deploySystem();
        uint256 nandOnly = oldIds[0]; // 88 NAND, no LATCH
        uint256 incoming = newIds[0]; // burns mostly LATCH
        _moveToDepositor(nandOnly);
        _admit(_one(nandOnly));
        vm.warp(block.timestamp + HOUR);
        vm.roll(block.number + 8000);
        address holder = collection.ownerOf(incoming);
        uint256 snapshot = vm.snapshotState();

        vm.prank(holder);
        collection.transferFrom(holder, depositor, incoming);
        (, uint256 carriedAtomic,) = _admit(_one(incoming));
        PoolMath.Accrual memory atomic = pool.accrual();
        vm.revertToState(snapshot);

        vm.prank(holder);
        collection.transferFrom(holder, address(pool), incoming);
        assertEq(pool.minerCount(), 1, "a plain transfer registers nothing");
        assertEq(pool.totalLatchBurn(), 0, "nor changes the composition");
        uint256 before = bem.balanceOf(address(pool));
        vm.prank(makeAddr("fork.thirdParty"));
        mining.claim(mining.minerKey(COLLECTION, incoming));
        uint256 claimedEarly = bem.balanceOf(address(pool)) - before;
        assertEq(claimedEarly, carriedAtomic, "the same carried income, paid to the pool before registration");
        vm.prank(depositor);
        (, uint256 carriedWindow) = pool.registerMiners(_one(incoming));
        assertEq(carriedWindow, 0, "nothing was left to carry");
        PoolMath.Accrual memory window = pool.accrual();
        assertEq(window.total, atomic.total, "same BEM in total");
        assertGt(window.nandIncome, atomic.nandIncome, "but split under the old, all-NAND composition");
        assertLt(window.latchIncome, atomic.latchIncome);

        vm.serializeUint("window", "carriedIncome", carriedAtomic);
        vm.serializeUint("window", "atomicNandIncome", atomic.nandIncome);
        vm.serializeUint("window", "atomicLatchIncome", atomic.latchIncome);
        vm.serializeUint("window", "windowNandIncome", window.nandIncome);
        string memory out = vm.serializeUint("window", "windowLatchIncome", window.latchIncome);
        vm.writeJson(out, "reports/fork-register-window.json");
    }

    /// @notice First admission and a category without receipts, on real miners: BEM held before any
    ///         composition waits for the first admission; a miner that burns the category without
    ///         receipts is refused, and that category's income stays zero.
    function testForkFirstAdmissionAndZeroSupplyCategory() public {
        bytes memory receiptCode = _artifact("TapeoutEntitlementReceipt");
        nandReceipt = TapeoutEntitlementReceipt(
            _create(
                abi.encodePacked(
                    receiptCode, abi.encode(keccak256("TAPEOUT_NAND_ENTITLEMENT"), "N", "N", "", operator)
                )
            )
        );
        latchReceipt = TapeoutEntitlementReceipt(
            _create(
                abi.encodePacked(
                    receiptCode, abi.encode(keccak256("TAPEOUT_LATCH_ENTITLEMENT"), "L", "L", "", operator)
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
            poolName: "Fork NAND-only Pool"
        });
        pool = TapeoutMinerPool(_create(abi.encodePacked(_artifact("TapeoutMinerPool"), abi.encode(d))));
        vm.startPrank(operator);
        nandReceipt.issue(alice, 10);
        nandReceipt.finalizeIssuance();
        latchReceipt.finalizeIssuance(); // S_L = 0
        pool.activate(10, 0);
        vm.stopPrank();

        uint256 held = _donate();
        assertEq(pool.unrecognizedBalance(), 0, "not recognized while there is no composition");
        pool.sync();
        assertEq(pool.totalAccounted(), 0);

        uint256 latchMinerId = newIds[0];
        _moveToDepositor(latchMinerId);
        vm.startPrank(depositor);
        collection.setApprovalForAll(address(pool), true);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.UnsupportedCategory.selector, LATCH));
        pool.depositMiners(_one(latchMinerId));
        vm.stopPrank();

        uint256 nandOnly = oldIds[0];
        _moveToDepositor(nandOnly);
        uint256 claimable = _claimable(nandOnly);
        (uint256 settled, uint256 carried,) = _admit(_one(nandOnly));
        assertEq(settled, 0);
        assertEq(carried, claimable + held, "the first admission recognizes the BEM held before it");
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.latchIncome, 0);
        assertEq(a.nandIncome, _participants(carried));
        assertEq(pool.claimable(NAND, 1), _participants(carried) / 10);
    }
}
