// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutEntitlementReceipt} from "../../src/TapeoutEntitlementReceipt.sol";
import {PoolMath} from "../../src/PoolMath.sol";

/// @notice Internal security review (f2c8e50), workstream A: the timing of one holder's legitimate
///         claims and of A/B releases must not change anybody else's final entitlement, across
///         admissions (composition changes), receipt transfers, donations, third-party Mining claims,
///         harvests and a recipient role migration.
contract AuditClaimOrderTest is SystemTestBase {
    function setUp() public override {
        super.setUp();
        setupStandard(); // S_N = 10 (alice 1-5, bob 6-10), S_L = 10 (alice 1-5, carol 6-10)
    }

    /// @dev One deterministic event script. With `interleave`, alice claims everything she holds and
    ///      recipient A is released after every event.
    function _script(bool interleave) internal {
        admitNew(1, 9, 1);
        accrue(1, 977_777_777);
        _maybe(interleave);
        pool.harvestRange(0, 1);
        _maybe(interleave);
        vm.prank(bob);
        nandReceipt.safeTransferFrom(bob, alice, 6, 1, ""); // unpaid income of NAND 6 follows it to alice
        _maybe(interleave);
        newMiner(2, 1, 9);
        mining.accrueUnsettled(address(nft), 2, 333_333_331); // hidden from pending()
        accrue(1, 123_457);
        admit(one(2)); // composition 9:1 -> 10:10
        _maybe(interleave);
        bem.mint(address(pool), 55_555); // direct transfer
        vm.prank(address(0xD00D));
        mining.claim(mining.minerKey(address(nft), 1)); // third-party claim pays the pool
        accrue(2, 10_000_019);
        _maybe(interleave);
        newMiner(3, 0, 10);
        accrue(3, 7_777_777);
        admit(one(3)); // 10:10 -> 10:20
        _maybe(interleave);
        pool.harvestRange(0, 3);
        _maybe(interleave);
        vm.prank(alice);
        latchReceipt.safeTransferFrom(alice, carol, 2, 1, ""); // alice gives LATCH 2 away
        _maybe(interleave);
        vm.prank(recipientB);
        pool.setRecipient(TapeoutMinerPool.Recipient.B, dave); // role migration
        _maybe(interleave);
        accrue(3, 1_000_003);
        pool.harvestRange(2, 1);
        _maybe(interleave);
    }

    function _maybe(bool interleave) internal {
        if (!interleave) return;
        uint256[] memory n = _held(nandReceipt, alice);
        uint256[] memory l = _held(latchReceipt, alice);
        if (n.length + l.length != 0) claimAs(alice, n, l);
        pool.releaseA();
    }

    function _held(TapeoutEntitlementReceipt receipt, address holder) internal view returns (uint256[] memory ids) {
        uint256 supply = receipt.totalSupply();
        uint256[] memory tmp = new uint256[](supply);
        uint256 k;
        for (uint256 id = 1; id <= supply; ++id) {
            if (receipt.holderOf(id) == holder) tmp[k++] = id;
        }
        ids = new uint256[](k);
        for (uint256 i; i < k; ++i) {
            ids[i] = tmp[i];
        }
    }

    /// @dev Everything that is not alice's or recipient A's: the claimable amount of every ID alice never
    ///      held, B's claimable amount, and the whole accrual. LATCH 2 is excluded: alice holds it first
    ///      and gives it to carol during the script, so by design ("unpaid income follows the ID") what
    ///      carol can claim on it depends on what alice claimed before the transfer; that ID is checked
    ///      by its per-ID conservation below instead.
    function _othersFingerprint() internal view returns (bytes32) {
        bytes memory acc = abi.encode(pool.accrual(), pool.recipientClaimable(TapeoutMinerPool.Recipient.B));
        for (uint256 id = 1; id <= 10; ++id) {
            if (nandReceipt.holderOf(id) != alice) acc = abi.encode(acc, NAND, id, pool.claimable(NAND, id));
            if (latchReceipt.holderOf(id) != alice && id != 2) acc = abi.encode(acc, LATCH, id, pool.claimable(LATCH, id));
        }
        return keccak256(acc);
    }

    function _aliceClaimable() internal view returns (uint256 total) {
        for (uint256 id = 1; id <= 10; ++id) {
            if (nandReceipt.holderOf(id) == alice) total += pool.claimable(NAND, id);
            if (latchReceipt.holderOf(id) == alice) total += pool.claimable(LATCH, id);
        }
    }

    function testClaimAndReleaseTimingDoesNotChangeAnyoneElsesEntitlement() public {
        uint256 snapshot = vm.snapshotState();
        _script(false);
        bytes32 others = _othersFingerprint();
        uint256 aliceTotal = _aliceClaimable();
        uint256 aTotal = pool.recipientClaimable(TapeoutMinerPool.Recipient.A);
        uint256 total = pool.totalAccounted() + pool.unrecognizedBalance();
        uint256 latch2Lifetime = pool.claimed(LATCH, 2) + pool.claimable(LATCH, 2);
        PoolMath.Accrual memory baseline = pool.accrual();
        vm.revertToState(snapshot);

        _script(true);
        PoolMath.Accrual memory interleaved = pool.accrual();
        assertEq(keccak256(abi.encode(interleaved)), keccak256(abi.encode(baseline)), "accrual changed");
        assertEq(_othersFingerprint(), others, "others' entitlements changed with alice's claim timing");
        // The transferred ID: alice's early claims on it plus carol's remaining claimable equal its lifetime income.
        assertEq(pool.claimed(LATCH, 2) + pool.claimable(LATCH, 2), latch2Lifetime, "LATCH 2 lifetime income");
        assertEq(latchReceipt.holderOf(2), carol);
        // Alice's lifetime income from the IDs she still holds is unchanged; what she claimed on LATCH 2
        // before giving it away is hers by design and is subtracted (carol never claims in the script, so
        // the ID's claimed history is exactly alice's share of it).
        assertEq(
            bem.balanceOf(alice) - pool.claimed(LATCH, 2) + _aliceClaimable(), aliceTotal, "alice's lifetime income changed"
        );
        assertEq(
            bem.balanceOf(recipientA) + pool.recipientClaimable(TapeoutMinerPool.Recipient.A),
            aTotal,
            "A's lifetime income changed"
        );
        assertEq(pool.totalAccounted() + pool.unrecognizedBalance(), total, "recognized total changed");
        assertReconciled();
    }

    function testRoleMigrationPaysUnreleasedIncomeToTheNewAddressAndNothingToTheOld() public {
        admitNew(1, 3, 1);
        accrue(1, 102_000_000);
        pool.harvestRange(0, 1);
        uint256 accruedAtMigration = pool.accrual().recipientA;
        assertEq(pool.releaseB(), accruedAtMigration);
        accrue(1, 51_000_000);
        pool.harvestRange(0, 1);
        uint256 unreleased = pool.recipientClaimable(TapeoutMinerPool.Recipient.B);
        assertGt(unreleased, 0);
        vm.prank(recipientB);
        pool.setRecipient(TapeoutMinerPool.Recipient.B, dave);
        // Nobody else can move or claim the role: not the owner, not the old recipient after the move.
        vm.prank(operator);
        vm.expectRevert(TapeoutMinerPool.Unauthorized.selector);
        pool.setRecipient(TapeoutMinerPool.Recipient.B, operator);
        vm.prank(recipientB);
        vm.expectRevert(TapeoutMinerPool.Unauthorized.selector);
        pool.setRecipient(TapeoutMinerPool.Recipient.B, recipientB);
        accrue(1, 1_020_000);
        pool.harvestRange(0, 1);
        uint256 paid = pool.releaseB();
        assertEq(paid, pool.accrual().recipientB - accruedAtMigration);
        assertEq(bem.balanceOf(dave), paid, "new address receives unreleased plus later income");
        assertEq(bem.balanceOf(recipientB), accruedAtMigration, "old address keeps only what was released before");
        assertEq(bem.balanceOf(dave) + bem.balanceOf(recipientB), pool.accrual().recipientB);
        // Role A is untouched by B's migration and A's own release is independent.
        assertEq(pool.recipientA(), recipientA);
        assertEq(pool.releaseA(), pool.accrual().recipientA);
        assertReconciled();
    }
}
