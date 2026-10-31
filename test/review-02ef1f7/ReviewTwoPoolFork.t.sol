// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {PoolMath} from "../../src/PoolMath.sol";
import {PoolForkBase} from "../fork/PoolForkBase.sol";

/// @notice Review-only (Fable 5.1, target 02ef1f7): the staggered two-pool lifecycle on real BSC state.
///         The optimal pool starts first (shared receipts and distributor renounced, real NAND-only miner
///         admitted, real income harvested) while the regular pool is still unbound and owner-held;
///         receipts are delivered late and keep their accumulated optimal income; the regular pool then
///         binds the ownerless distributor, activates, renounces and admits a real LATCH-burning miner;
///         the same receipt claims each pool's income independently; a receipt is sold after only the
///         optimal claim and the buyer takes the regular entitlement and all later income; both pools
///         release their own A/B/C on real BEM. Protocol code and storage are never modified.
///         Run: FOUNDRY_PROFILE=fork FORK_RPC_URL=<archive> FORK_BLOCK=128713128 forge test \
///              --match-path 'test/review-02ef1f7/ReviewTwoPoolFork.t.sol' --no-storage-caching -vv
contract ReviewTwoPoolForkTest is PoolForkBase {
    uint256 internal constant HOUR = 3600;
    address internal eve = makeAddr("eve");

    function _ledger(TapeoutMinerPool target) internal view {
        TapeoutMinerPool.Reconciliation memory r = target.reconciliation();
        assertEq(r.deficit, 0);
        assertEq(
            r.bemBalance,
            (r.recipientAAccrued - r.recipientAPaid) + (r.recipientBAccrued - r.recipientBPaid)
                + (r.sinkAccrued - r.sinkPaid) + (r.nandReceiptsAccrued - r.nandReceiptsPaid)
                + (r.latchReceiptsAccrued - r.latchReceiptsPaid) + r.residue + r.unrecognized
        );
        assertEq(
            r.totalAccounted,
            r.recipientAAccrued + r.recipientBAccrued + r.sinkAccrued + r.nandReceiptsAccrued
                + r.latchReceiptsAccrued + r.residue
        );
        assertEq(r.recipientAAccrued, r.totalAccounted / 84);
        assertEq(r.sinkAccrued, r.totalAccounted * 2 / 84);
    }

    function _claim(TapeoutMinerPool target, address who, TapeoutMinerPool.Category c, uint256 id)
        internal
        returns (uint256 paid)
    {
        uint256 before = bem.balanceOf(who);
        vm.prank(who);
        target.claim(c, id);
        paid = bem.balanceOf(who) - before;
    }

    function _advance() internal {
        vm.warp(block.timestamp + HOUR);
        vm.roll(block.number + 1200);
    }

    function testForkStaggeredTwoPoolLifecycleWithLateDeliveryTransferAndCrossPoolHistory() public {
        _deploySystemKeepingOwners(); // optimal bound + active; regular deployed, unbound, owner-held
        assertTrue(distributor.isPool(address(regularPool)));
        assertEq(regularPool.distributor(), address(0));

        // 1. The optimal pool starts alone: shared receipts and distributor renounced, its own owner too.
        vm.startPrank(operator);
        _renounceAll();
        vm.stopPrank();
        assertEq(distributor.owner(), address(0));
        assertEq(regularPool.owner(), operator, "the regular pool is still owner-held");
        _moveToDepositor(nandMiner);
        (, uint256 carriedOptimal,) = _admit(_one(nandMiner));
        assertTrue(pool.custodyOpen());
        assertFalse(regularPool.custodyOpen());
        _advance();
        (uint256 receivedOptimal,) = pool.harvest(_one(nandMiner));
        assertGt(receivedOptimal, 0, "real income in the optimal pool");
        assertEq(pool.totalAccounted(), carriedOptimal + receivedOptimal);

        // 2. Late delivery: the receipts have accumulated optimal income while held by the distributor.
        uint256 perNandOptimal = pool.accrual().perNandShare;
        assertGt(perNandOptimal, 0);
        assertEq(pool.claimed(TapeoutMinerPool.Category.NAND, 1), 0);
        vm.prank(alice);
        distributor.claim(100); // NAND 1-12 and LATCH 1-4
        assertEq(nandReceipt.holderOf(1), alice);
        assertEq(pool.claimable(TapeoutMinerPool.Category.NAND, 1), perNandOptimal, "late delivery kept the income");
        assertEq(_claim(pool, alice, TapeoutMinerPool.Category.NAND, 1), perNandOptimal);
        // The inactive regular pool pays nothing. Note for integrators: before activation its share
        // denominators are zero, so `claimable` reverts with ReceiptIdOutOfRange instead of returning 0.
        vm.expectRevert(
            abi.encodeWithSelector(TapeoutMinerPool.ReceiptIdOutOfRange.selector, TapeoutMinerPool.Category.NAND, 1)
        );
        regularPool.claimable(TapeoutMinerPool.Category.NAND, 1);
        vm.prank(alice);
        vm.expectRevert(TapeoutMinerPool.NotActive.selector);
        regularPool.claim(TapeoutMinerPool.Category.NAND, 1);

        // 3. Delayed activation: the regular pool binds the ownerless distributor, activates, renounces,
        //    and admits a real miner that burns LATCH (13948: NAND 2 / LATCH 64).
        vm.startPrank(operator);
        regularPool.bindDistributor(address(distributor));
        regularPool.activate(20, 10);
        regularPool.renounceOwnership();
        vm.stopPrank();
        _moveToDepositor(latchMiner);
        vm.startPrank(depositor);
        collection.setApprovalForAll(address(regularPool), true);
        (, uint256 carriedRegular) = regularPool.depositMiners(_one(latchMiner));
        vm.stopPrank();
        assertTrue(regularPool.custodyOpen());
        assertEq(regularPool.miner(latchMiner).carriedIncome, carriedRegular);
        _advance();
        (uint256 receivedRegular,) = regularPool.harvest(_one(latchMiner));
        assertGt(receivedRegular, 0, "real income in the regular pool");
        assertEq(regularPool.totalAccounted(), carriedRegular + receivedRegular);
        assertEq(pool.totalAccounted(), carriedOptimal + receivedOptimal, "the optimal ledger did not move");

        // 4. Cross-pool history on the same receipt: NAND #1 was paid in the optimal pool only.
        uint256 perNandRegular = regularPool.accrual().perNandShare;
        assertGt(perNandRegular, 0, "NAND earns in the regular pool through the miner's 2 NAND burn");
        assertEq(regularPool.claimed(TapeoutMinerPool.Category.NAND, 1), 0);
        assertEq(_claim(regularPool, alice, TapeoutMinerPool.Category.NAND, 1), perNandRegular);
        assertEq(pool.claimed(TapeoutMinerPool.Category.NAND, 1), perNandOptimal, "optimal history untouched");
        // LATCH earns only where a miner burns LATCH.
        assertEq(pool.claimable(TapeoutMinerPool.Category.LATCH, 1), 0);
        assertGt(regularPool.claimable(TapeoutMinerPool.Category.LATCH, 1), 0);

        // 5. Sale after claiming the optimal pool only: the buyer takes the regular entitlement, cannot
        //    reclaim the optimal payment, and later income in both pools is the buyer's.
        assertEq(_claim(pool, alice, TapeoutMinerPool.Category.NAND, 2), perNandOptimal);
        vm.prank(alice);
        nandReceipt.safeTransferFrom(alice, eve, 2, 1, "");
        assertEq(_claim(regularPool, eve, TapeoutMinerPool.Category.NAND, 2), perNandRegular);
        assertEq(_claim(pool, eve, TapeoutMinerPool.Category.NAND, 2), 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TapeoutMinerPool.NotHolder.selector, TapeoutMinerPool.Category.NAND, 2));
        pool.claim(TapeoutMinerPool.Category.NAND, 2);
        _advance();
        pool.harvest(_one(nandMiner));
        regularPool.harvest(_one(latchMiner));
        uint256 newOptimal = pool.accrual().perNandShare - perNandOptimal;
        uint256 newRegular = regularPool.accrual().perNandShare - perNandRegular;
        assertGt(newOptimal, 0);
        assertGt(newRegular, 0);
        assertEq(_claim(pool, eve, TapeoutMinerPool.Category.NAND, 2), newOptimal);
        assertEq(_claim(regularPool, eve, TapeoutMinerPool.Category.NAND, 2), newRegular);

        // 6. Each pool releases its own A/B/C on real BEM; the shared sink address receives both.
        address sink = pool.SINK();
        uint256 sinkBefore = bem.balanceOf(sink);
        pool.releaseA();
        regularPool.releaseB();
        assertEq(pool.sinkPaid(), pool.totalAccounted() * 2 / 84);
        assertEq(regularPool.sinkPaid(), regularPool.totalAccounted() * 2 / 84);
        assertEq(bem.balanceOf(sink) - sinkBefore, pool.sinkPaid() + regularPool.sinkPaid());
        _ledger(pool);
        _ledger(regularPool);

        string memory key = "reviewTwoPoolFork";
        vm.serializeUint(key, "forkBlock", forkBlock);
        vm.serializeUint(key, "optimalMiner", nandMiner);
        vm.serializeUint(key, "regularMiner", latchMiner);
        vm.serializeUint(key, "carriedOptimal", carriedOptimal);
        vm.serializeUint(key, "receivedOptimalFirstHour", receivedOptimal);
        vm.serializeUint(key, "carriedRegular", carriedRegular);
        vm.serializeUint(key, "receivedRegularFirstHour", receivedRegular);
        vm.serializeUint(key, "perNandOptimalAtLateDelivery", perNandOptimal);
        vm.serializeUint(key, "perNandRegularAfterDelayedStart", perNandRegular);
        vm.serializeUint(key, "optimalSinkPaid", pool.sinkPaid());
        string memory out = vm.serializeUint(key, "regularSinkPaid", regularPool.sinkPaid());
        vm.writeJson(out, "reports/review-02ef1f7-fork.json");
    }
}
