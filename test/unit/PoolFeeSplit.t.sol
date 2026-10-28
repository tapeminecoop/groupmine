// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {PoolMath} from "../../src/PoolMath.sol";

/// @notice The 2.1.0 outer split: NAND + LATCH 100 : A 1.25 : B 1.25 : C 2.5 (= 80 : 1 : 1 : 2 of 84), with
///         C paid to the fixed sink whenever A or B is released. Expected values come from the
///         specification's arithmetic (floor(T * parts / 84), literal tables), not from PoolMath.
///         Pool: S_N = 10 (alice 1..5, bob 6..10), S_L = 10 (alice 1..5, carol 6..10).
contract PoolFeeSplitTest is SystemTestBase {
    address internal constant SINK = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant BEM_1050 = 1_050 * BEM_UNIT;
    uint256 internal constant HALF_BEM = BEM_UNIT / 2;

    TapeoutMinerPool.Recipient internal constant A = TapeoutMinerPool.Recipient.A;
    TapeoutMinerPool.Recipient internal constant B = TapeoutMinerPool.Recipient.B;

    event RecipientPaid(TapeoutMinerPool.Recipient indexed role, address indexed recipient, uint256 amount);
    event SinkPaid(TapeoutMinerPool.Recipient indexed releasedRole, address indexed sink, uint256 amount);

    function setUp() public override {
        super.setUp();
        setupStandard();
    }

    // ---- specification arithmetic (independent of PoolMath) ------------------------------------

    function _a(uint256 t) internal pure returns (uint256) {
        return t / 84;
    }

    function _c(uint256 t) internal pure returns (uint256) {
        return t * 2 / 84;
    }

    function _p(uint256 t) internal pure returns (uint256) {
        return t * 80 / 84;
    }

    function _income(uint256 amount) internal {
        bem.mint(address(pool), amount);
    }

    // ---- worked example A: 1,050 BEM ------------------------------------------------------------

    function testWorkedExampleSplitsOneThousandFiftyBem() public view {
        assertEq(pool.SINK(), SINK);
        assertEq(pool.TOTAL_PARTS(), 84);
        assertEq(pool.PARTICIPANT_PARTS(), 80);
        assertEq(pool.RECIPIENT_PARTS(), 1);
        assertEq(pool.SINK_PARTS(), 2);
        PoolMath.Accrual memory a = PoolMath.accrue(BEM_1050, pool.ledgerState());
        assertEq(a.participants, 1_000 * BEM_UNIT, "NAND + LATCH 1,000 BEM");
        assertEq(a.recipientA, 12 * BEM_UNIT + HALF_BEM, "A 12.5 BEM");
        assertEq(a.recipientB, 12 * BEM_UNIT + HALF_BEM, "B 12.5 BEM");
        assertEq(a.sink, 25 * BEM_UNIT, "C 25 BEM");
        assertEq(
            a.participants + a.recipientA + a.recipientB + a.sink, BEM_1050, "a 105-part split, no other fee"
        );
    }

    function testReleaseAThenBPaysEachOnceAndTheSinkOnce() public {
        admitNew(1, 3, 1);
        _income(BEM_1050);
        vm.prank(dave); // anyone pays the gas; funds go only to A and the sink
        assertEq(pool.releaseA(), 12 * BEM_UNIT + HALF_BEM);
        assertEq(bem.balanceOf(recipientA), 12 * BEM_UNIT + HALF_BEM);
        assertEq(bem.balanceOf(SINK), 25 * BEM_UNIT, "C's whole part on the first release");
        assertEq(bem.balanceOf(dave), 0);
        assertEq(pool.recipientClaimable(B), 12 * BEM_UNIT + HALF_BEM, "B still entitled to 12.5");
        assertEq(pool.recipientBPaid(), 0, "A's release does not mark B paid");
        assertEq(pool.sinkClaimable(), 0);
        assertEq(pool.releaseB(), 12 * BEM_UNIT + HALF_BEM);
        assertEq(bem.balanceOf(recipientB), 12 * BEM_UNIT + HALF_BEM);
        assertEq(bem.balanceOf(SINK), 25 * BEM_UNIT, "C receives nothing more without new income");
        assertEq(pool.releaseA(), 0);
        assertEq(pool.releaseB(), 0);
        assertEq(bem.balanceOf(SINK), 25 * BEM_UNIT);
        assertEq(pool.sinkPaid(), 25 * BEM_UNIT);
        assertEq(pool.totalPaid(), 50 * BEM_UNIT);
        claimAs(alice, range(1, 5), range(1, 5));
        claimAs(bob, range(6, 10), none());
        claimAs(carol, none(), range(6, 10));
        assertEq(bem.balanceOf(address(pool)), 0, "1,050 BEM fully distributed");
        assertReconciled();
    }

    function testReleaseBThenAEndsWithTheSameBalances() public {
        admitNew(1, 3, 1);
        _income(BEM_1050);
        assertEq(pool.releaseB(), 12 * BEM_UNIT + HALF_BEM);
        assertEq(bem.balanceOf(SINK), 25 * BEM_UNIT);
        assertEq(pool.recipientAPaid(), 0, "B's release does not mark A paid");
        assertEq(pool.releaseA(), 12 * BEM_UNIT + HALF_BEM);
        assertEq(pool.releaseB(), 0);
        assertEq(bem.balanceOf(recipientA), 12 * BEM_UNIT + HALF_BEM);
        assertEq(bem.balanceOf(recipientB), 12 * BEM_UNIT + HALF_BEM);
        assertEq(bem.balanceOf(SINK), 25 * BEM_UNIT);
        assertReconciled();
    }

    function testInterleavedIncomeAndRepeatedReleasesFollowTheCumulativeFormula() public {
        admitNew(1, 3, 1);
        uint256[6] memory inflows = [uint256(84_050), 1, 41, 9_973, 83, 1_000_003];
        uint256 total;
        uint256 paidA;
        uint256 paidB;
        uint256 paidC;
        for (uint256 i; i < inflows.length; ++i) {
            _income(inflows[i]);
            total += inflows[i];
            bool releaseA = i % 3 != 1;
            vm.prank(makeAddr(string.concat("caller", vm.toString(i))));
            uint256 got = releaseA ? pool.releaseA() : pool.releaseB();
            uint256 expectRole = _a(total) - (releaseA ? paidA : paidB);
            assertEq(got, expectRole, "the selected role's unpaid part");
            if (releaseA) paidA = _a(total);
            else paidB = _a(total);
            paidC = _c(total);
            assertEq(bem.balanceOf(recipientA), paidA);
            assertEq(bem.balanceOf(recipientB), paidB);
            assertEq(bem.balanceOf(SINK), paidC, "C cleared to floor(2T/84) at every release");
            // A repeated release without new income pays nobody.
            assertEq(releaseA ? pool.releaseA() : pool.releaseB(), 0);
            assertEq(bem.balanceOf(SINK), paidC);
            assertReconciled();
        }
    }

    // ---- worked example B: composition changes, earlier rights are not repriced ----------------

    function testWorkedExampleCompositionChangeKeepsEarlierCategoryTotals() public {
        admitNew(1, 2, 0); // old composition 2:0
        accrue(1, BEM_1050);
        pool.harvestRange(0, 1);
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.nandIncome, 1_000 * BEM_UNIT);
        assertEq(a.latchIncome, 0);
        assertEq(a.recipientA, 12 * BEM_UNIT + HALF_BEM);
        assertEq(a.recipientB, 12 * BEM_UNIT + HALF_BEM);
        assertEq(a.sink, 25 * BEM_UNIT);
        (uint256 settled,) = admitNew(2, 1, 1); // aggregate 3:1 after a settled admission
        assertEq(settled, 0, "the old miner was harvested already");
        assertEq(pool.ledgerState().nandBase, 1_000 * BEM_UNIT * pool.LEDGER_UNIT(), "old period frozen");
        accrue(2, BEM_1050);
        pool.harvestRange(0, 2);
        a = pool.accrual();
        assertEq(a.nandIncome, 1_750 * BEM_UNIT, "NAND 1,000 + 750");
        assertEq(a.latchIncome, 250 * BEM_UNIT, "LATCH 0 + 250");
        assertEq(a.recipientA, 25 * BEM_UNIT);
        assertEq(a.recipientB, 25 * BEM_UNIT);
        assertEq(a.sink, 50 * BEM_UNIT);
        assertReconciled();
    }

    /// @notice The old miner's income (also when Mining's pending() shows zero) is settled at the
    ///         boundary under the old composition, and the incoming miner's carried income goes by that
    ///         miner's own burn (SALUS remediation, 2.2.0; under 2.1.0 it was split by the new 1:1
    ///         composition, NAND 84,000 / LATCH 4,000); A, B and C accrue on both.
    function testAdmissionBoundaryUnderTheNewSplit() public {
        admitNew(1, 1, 0); // NAND only
        mining.accrueUnsettled(address(nft), 1, 84_000); // pending() 0, claim pays 84,000
        newMiner(2, 0, 1); // LATCH only
        accrue(2, 8_400); // carried in
        (uint256 settled, uint256 carried) = admit(one(2));
        assertEq(settled, 84_000);
        assertEq(carried, 8_400);
        PoolMath.Accrual memory a = pool.accrual();
        uint256 t = 84_000 + 8_400;
        assertEq(a.total, t);
        assertEq(
            pool.ledgerState().nandBase,
            _p(84_000) * pool.LEDGER_UNIT(),
            "old miner's income: old composition, all NAND"
        );
        assertEq(a.nandIncome, _p(84_000), "the LATCH-only incoming miner carries nothing to NAND");
        assertEq(a.latchIncome, _p(8_400), "its carried income goes to LATCH by its own burn");
        assertEq(a.recipientA, _a(t));
        assertEq(a.sink, _c(t));
        assertEq(bem.balanceOf(SINK), 0, "admission accrues C but does not pay it");
        assertReconciled();
    }

    // ---- small units and rounding ------------------------------------------------------------

    function testSmallTotalsUseIndependentFloors() public pure {
        // T, A (= B), C, participants: floor(2T/84) differs from 2 * floor(T/84) at 42, 43, 83, 126, 1050.
        uint256[4][17] memory table = [
            [uint256(0), 0, 0, 0],
            [uint256(1), 0, 0, 0],
            [uint256(41), 0, 0, 39],
            [uint256(42), 0, 1, 40],
            [uint256(43), 0, 1, 40],
            [uint256(83), 0, 1, 79],
            [uint256(84), 1, 2, 80],
            [uint256(85), 1, 2, 80],
            [uint256(125), 1, 2, 119],
            [uint256(126), 1, 3, 120],
            [uint256(127), 1, 3, 120],
            [uint256(167), 1, 3, 159],
            [uint256(168), 2, 4, 160],
            [uint256(169), 2, 4, 160],
            [uint256(1_049), 12, 24, 999],
            [uint256(1_050), 12, 25, 1_000],
            [
                uint256(1_000_000_000_000_000_007),
                11_904_761_904_761_904,
                23_809_523_809_523_809,
                952_380_952_380_952_387
            ]
        ];
        PoolMath.State memory s = PoolMath.State(0, 0, 0, 1, 1, 10, 10);
        PoolMath.Accrual memory previous;
        for (uint256 i; i < table.length; ++i) {
            PoolMath.Accrual memory a = PoolMath.accrue(table[i][0], s);
            assertEq(a.recipientA, table[i][1], "A");
            assertEq(a.recipientB, table[i][1], "B");
            assertEq(a.sink, table[i][2], "C");
            assertEq(a.participants, table[i][3], "participants");
            uint256 outer = table[i][0] - 2 * table[i][1] - table[i][2] - table[i][3];
            assertLe(outer, 3, "outer floors leave at most 3 units");
            assertGe(a.recipientA, previous.recipientA);
            assertGe(a.sink, previous.sink);
            assertGe(a.participants, previous.participants);
            previous = a;
        }
    }

    function testSinkIsPaidEvenWhenTheReleasedRoleIsDueNothing() public {
        admitNew(1, 1, 1);
        _income(42); // A = B = 0, C = 1
        vm.expectEmit(address(pool));
        emit RecipientPaid(A, recipientA, 0);
        vm.expectEmit(address(pool));
        emit SinkPaid(A, SINK, 1);
        assertEq(pool.releaseA(), 0);
        assertEq(bem.balanceOf(SINK), 1);
        assertEq(bem.balanceOf(recipientA), 0);
        assertEq(pool.releaseB(), 0);
        assertEq(bem.balanceOf(SINK), 1, "the same unit is not paid twice");
        _income(42); // T = 84: A = B = 1, C = 2
        vm.expectEmit(address(pool));
        emit RecipientPaid(B, recipientB, 1);
        vm.expectEmit(address(pool));
        emit SinkPaid(B, SINK, 1);
        assertEq(pool.releaseB(), 1);
        assertEq(pool.releaseA(), 1);
        assertEq(bem.balanceOf(SINK), 2);
        assertReconciled();
    }

    function testManyTinyInflowsEqualOneCombinedInflow() public {
        admitNew(1, 7, 3);
        uint256 snapshot = vm.snapshotState();
        uint256 total;
        for (uint256 i = 1; i <= 120; ++i) {
            uint256 x = i % 5 == 0 ? 1 : i % 83;
            total += x;
            _income(x);
            if (i % 7 == 0) pool.releaseA();
            if (i % 11 == 0) pool.releaseB();
            else pool.sync();
        }
        pool.releaseA();
        pool.releaseB();
        PoolMath.Accrual memory many = pool.accrual();
        uint256[3] memory paidMany =
            [bem.balanceOf(recipientA), bem.balanceOf(recipientB), bem.balanceOf(SINK)];
        vm.revertToState(snapshot);
        _income(total);
        pool.releaseB();
        pool.releaseA();
        PoolMath.Accrual memory once = pool.accrual();
        assertEq(keccak256(abi.encode(many)), keccak256(abi.encode(once)), "same accrual");
        assertEq(paidMany[0], bem.balanceOf(recipientA));
        assertEq(paidMany[1], bem.balanceOf(recipientB));
        assertEq(paidMany[2], bem.balanceOf(SINK));
        assertEq(bem.balanceOf(SINK), _c(total));
        assertReconciled();
    }

    function testSinkReceivesItsWeightNotTheRoundingResidue() public {
        admitNew(1, 7, 3);
        uint256 t = 84 * 1_000 + 83; // outer floors leave 3 units
        _income(t);
        pool.releaseA();
        pool.releaseB();
        claimAs(alice, range(1, 5), range(1, 5));
        claimAs(bob, range(6, 10), none());
        claimAs(carol, none(), range(6, 10));
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(bem.balanceOf(SINK), _c(t));
        assertEq(bem.balanceOf(address(pool)), a.residue, "the residue stays in the pool");
        assertGe(a.residue, 3);
        assertLe(a.residue, residueBound());
        assertReconciled();
    }

    // ---- recipients, migration and the fixed sink ---------------------------------------------

    function testRoleMigrationKeepsPendingAndNeverTouchesTheSink() public {
        admitNew(1, 1, 1);
        _income(84_000);
        pool.releaseB(); // B 1,000 and C 2,000
        _income(84_000); // T = 168,000: A due 2,000, B due 1,000, C due 2,000
        address newA = makeAddr("newA");
        vm.prank(recipientA);
        pool.setRecipient(A, newA);
        assertEq(pool.sinkPaid(), 2_000, "migration does not touch C");
        assertEq(pool.recipientClaimable(A), 2_000, "unpaid income follows the role");
        assertEq(pool.recipientClaimable(B), 1_000);
        assertEq(pool.releaseA(), 2_000);
        assertEq(bem.balanceOf(newA), 2_000);
        assertEq(bem.balanceOf(recipientA), 0);
        assertEq(bem.balanceOf(SINK), 4_000);
        assertEq(pool.recipientClaimable(B), 1_000, "B unaffected");
        assertReconciled();
    }

    function testTheSinkIsAFixedAddressThatNoRoleCanUse() public {
        // Deployment refuses A or B at the sink.
        TapeoutMinerPool.Deployment memory d = deployment(whitelist());
        d.recipientA = SINK;
        vm.expectRevert(TapeoutMinerPool.InvalidAddress.selector);
        new TapeoutMinerPool(d);
        d = deployment(whitelist());
        d.recipientB = SINK;
        vm.expectRevert(TapeoutMinerPool.InvalidAddress.selector);
        new TapeoutMinerPool(d);
        // Neither role can be moved to it, and there is no third role to move.
        vm.prank(recipientA);
        vm.expectRevert(TapeoutMinerPool.InvalidAddress.selector);
        pool.setRecipient(A, SINK);
        vm.prank(recipientB);
        vm.expectRevert(TapeoutMinerPool.InvalidAddress.selector);
        pool.setRecipient(B, SINK);
        vm.prank(SINK);
        (bool ok,) = address(pool).call(abi.encodeWithSelector(pool.setRecipient.selector, uint8(2), alice));
        assertFalse(ok, "Recipient has only A and B");
        vm.prank(SINK);
        vm.expectRevert(TapeoutMinerPool.Unauthorized.selector);
        pool.setRecipient(A, alice);
        assertEq(pool.SINK(), SINK);
    }

    // ---- atomic failure and reentrancy ---------------------------------------------------------

    function _ledger() internal view returns (uint256[7] memory v) {
        v = [
            pool.recipientAPaid(),
            pool.recipientBPaid(),
            pool.sinkPaid(),
            pool.totalPaid(),
            bem.balanceOf(address(pool)),
            bem.balanceOf(recipientA),
            bem.balanceOf(SINK)
        ];
    }

    function testAFailedSinkTransferRevertsTheWholeReleaseAndClaimsStillWork() public {
        admitNew(1, 3, 1);
        _income(84_000);
        pool.sync();
        bem.setBlockedTo(SINK, true);
        uint256[7] memory before = _ledger();
        vm.expectRevert(bytes("BEM_DESTINATION_BLOCKED"));
        pool.releaseA();
        vm.expectRevert(bytes("BEM_DESTINATION_BLOCKED"));
        pool.releaseB();
        assertEq(
            keccak256(abi.encode(_ledger())), keccak256(abi.encode(before)), "nothing paid, nothing recorded"
        );
        // Receipt claims, harvests, syncs and admissions do not depend on the sink.
        assertEq(claimAs(alice, range(1, 5), range(1, 5)), 5 * 6_000 + 5 * 2_000);
        accrue(1, 8_400);
        pool.harvestRange(0, 1);
        admitNew(2, 1, 1);
        pool.sync();
        assertEq(pool.sinkClaimable(), _c(84_000 + 8_400), "C stays accrued in the pool");
        bem.setBlockedTo(SINK, false);
        assertEq(pool.releaseA(), _a(92_400));
        assertEq(bem.balanceOf(SINK), _c(92_400));
        assertReconciled();
    }

    function testAFailedRoleTransferRevertsTheWholeReleaseIncludingTheSink() public {
        admitNew(1, 3, 1);
        _income(84_000);
        bem.setBlockedTo(recipientA, true);
        uint256[7] memory before = _ledger();
        vm.expectRevert(bytes("BEM_DESTINATION_BLOCKED"));
        pool.releaseA();
        assertEq(keccak256(abi.encode(_ledger())), keccak256(abi.encode(before)));
        assertEq(pool.releaseB(), 1_000, "B unaffected");
        assertEq(bem.balanceOf(SINK), 2_000, "B's release paid all of C");
        bem.setBlockedTo(recipientA, false);
        assertEq(pool.releaseA(), 1_000);
        assertEq(bem.balanceOf(SINK), 2_000);
        assertReconciled();
    }

    function testFeeOnTransferBemIsRefusedForTheWholeRelease() public {
        admitNew(1, 1, 1);
        _income(84_000);
        bem.setFaults(false, false, true); // every transfer loses 1 unit
        vm.expectRevert(TapeoutMinerPool.UnexpectedTokenBehavior.selector);
        pool.releaseA();
        assertEq(pool.sinkPaid(), 0);
        assertEq(pool.totalPaid(), 0);
    }

    function testReentrantCallsDuringEitherPaymentAreRefused() public {
        admitNew(1, 1, 1);
        _income(84_000);
        // During A's transfer, a reentrant releaseB fails; the outer release completes once.
        bem.setTransferHook(recipientA, address(pool), abi.encodeCall(pool.releaseB, ()), false);
        assertEq(pool.releaseA(), 1_000);
        assertTrue(bem.hookCalled());
        assertFalse(bem.hookSucceeded());
        assertEq(bytes4(bem.hookResult()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(pool.recipientBPaid(), 0);
        assertEq(bem.balanceOf(recipientB), 0);
        assertEq(bem.balanceOf(SINK), 2_000);
        // During the sink transfer, a reentrant releaseA or claim fails as well.
        _income(84_000);
        bem.setTransferHook(SINK, address(pool), abi.encodeCall(pool.releaseA, ()), false);
        assertEq(pool.releaseB(), 2_000);
        assertFalse(bem.hookSucceeded());
        assertEq(pool.recipientAPaid(), 1_000);
        bem.setTransferHook(SINK, address(pool), abi.encodeCall(pool.claim, (NAND, 1)), false);
        _income(84_000);
        pool.releaseA();
        assertFalse(bem.hookSucceeded());
        assertEq(pool.claimed(NAND, 1), 0);
        // A failure that propagates rolls the whole release back.
        _income(84_000);
        bem.setTransferHook(SINK, address(pool), abi.encodeCall(pool.sync, ()), true);
        uint256[7] memory before = _ledger();
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        pool.releaseB();
        assertEq(keccak256(abi.encode(_ledger())), keccak256(abi.encode(before)));
        bem.setTransferHook(address(0), address(0), "", false);
        pool.releaseB();
        pool.releaseA();
        assertEq(bem.balanceOf(SINK), _c(4 * 84_000));
        assertReconciled();
    }

    // ---- independence from the ordinary flows -------------------------------------------------

    function testHarvestSyncAdmissionAndClaimsNeverPayTheSink() public {
        admitNew(1, 3, 1);
        accrue(1, 84_000);
        pool.harvestRange(0, 1);
        _income(8_400);
        pool.sync();
        admitNew(2, 1, 1);
        claimAs(alice, range(1, 5), range(1, 5));
        vm.prank(bob);
        pool.claim(NAND, 6);
        assertEq(bem.balanceOf(SINK), 0);
        assertEq(pool.sinkPaid(), 0);
        assertEq(pool.sinkClaimable(), _c(92_400));
        assertReconciled();
    }

    /// @notice A claim runs `_sync`: BEM held but not yet recognized becomes income, which raises C's
    ///         entitlement, while the claim never pays C (follow-up reviews D-210-01 / P2-1).
    function testClaimsRecognizeHeldIncomeAndAccrueCWithoutPayingIt() public {
        admitNew(1, 3, 1);
        _income(84_000); // held, not yet recognized
        assertEq(pool.totalAccounted(), 0);
        assertEq(pool.accrual().sink, 0);
        assertEq(claimAs(alice, one(1), none()), 6_000, "NAND #1: 80,000 * 3/4 / 10");
        assertEq(pool.totalAccounted(), 84_000, "the claim recognized the held BEM");
        assertEq(pool.accrual().sink, _c(84_000), "C accrued");
        assertEq(pool.sinkPaid(), 0, "C was not paid");
        assertEq(bem.balanceOf(SINK), 0);
        assertReconciled();
    }

    function testSyncAfterEachPaymentFindsNoDeficitAndNothingNew() public {
        admitNew(1, 1, 1);
        _income(84_000);
        pool.releaseA();
        assertEq(pool.sync(), 0, "C's outflow is in totalPaid: no deficit, nothing re-recognized");
        assertEq(pool.unrecognizedBalance(), 0);
        claimAs(alice, one(1), none());
        assertEq(pool.sync(), 0);
        pool.releaseB();
        assertEq(pool.sync(), 0);
        assertEq(pool.totalAccounted(), 84_000);
        assertEq(pool.totalPaid(), 1_000 + 1_000 + 2_000 + 4_000);
        _income(84);
        assertEq(pool.sync(), 84, "new income is recognized once");
        assertEq(pool.sync(), 0);
        assertReconciled();
    }

    /// @notice Arbitrary inflows and release orders against the cumulative formula.
    function testFuzzReleasesPayExactlyTheCumulativeFormula(uint64[8] memory inflows, uint8 order) public {
        admitNew(1, 2, 1);
        uint256 total;
        uint256 paidA;
        uint256 paidB;
        for (uint256 i; i < inflows.length; ++i) {
            uint256 x = uint256(inflows[i]) % 10_000_000;
            total += x;
            _income(x);
            if ((order >> i) & 1 == 0) {
                assertEq(pool.releaseA(), _a(total) - paidA);
                paidA = _a(total);
            } else {
                assertEq(pool.releaseB(), _a(total) - paidB);
                paidB = _a(total);
            }
            assertEq(bem.balanceOf(SINK), _c(total));
        }
        assertEq(bem.balanceOf(recipientA), paidA);
        assertEq(bem.balanceOf(recipientB), paidB);
        assertReconciled();
    }
}
