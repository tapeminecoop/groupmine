// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutEntitlementReceipt} from "../../src/TapeoutEntitlementReceipt.sol";
import {PoolMath} from "../../src/PoolMath.sol";
import {MockBEM, MockMining, MockNFT} from "../helpers/Mocks.sol";

/// @dev Drives admissions (some of which must roll back), harvests, third-party claims, donations,
///      status changes, claims, transfers and recipient payments. It keeps an independent model of the
///      specification: expected settlement and carried amounts come from Mining's owed balances, and
///      category totals are replayed with the old/new composition boundary.
contract SystemHandler is Test {
    TapeoutMinerPool internal pool;
    MockBEM internal bem;
    MockMining internal mining;
    MockNFT internal nft;
    address internal depositor;
    address[] internal actors;
    address[] internal payees;

    uint256 internal nextTokenId = 1;
    uint256[] public registered;
    uint256[] internal waiting;

    // Reference model.
    uint256 public gTotal;
    uint256 public gNandBase;
    uint256 public gLatchBase;
    uint256 public gParticipantBase;
    uint256 public gNandBurn;
    uint256 public gLatchBurn;

    bool public amountsMatch = true;
    bool public rollbacksClean = true;
    bool public monotonic = true;
    uint256 internal lastNand;
    uint256 internal lastLatch;
    uint256 internal lastPerNand;
    uint256 internal lastPerLatch;
    mapping(bytes32 => uint256) public calls;

    constructor(
        TapeoutMinerPool pool_,
        MockBEM bem_,
        MockMining mining_,
        MockNFT nft_,
        address depositor_,
        address[] memory actors_,
        address[] memory payees_
    ) {
        pool = pool_;
        bem = bem_;
        mining = mining_;
        nft = nft_;
        depositor = depositor_;
        actors = actors_;
        payees = payees_;
        vm.prank(depositor);
        nft.setApprovalForAll(address(pool), true);
    }

    // ------------------------------------------------------------------ model helpers

    function modelCategories() public view returns (uint256 nand, uint256 latch) {
        uint256 participants = gTotal * 80 / 84;
        nand = gNandBase;
        latch = gLatchBase;
        uint256 weight = gNandBurn + gLatchBurn;
        if (weight != 0) {
            uint256 d = participants - gParticipantBase;
            nand += d * gNandBurn / weight;
            latch += d * gLatchBurn / weight;
        }
    }

    function _unrecognized() internal view returns (uint256) {
        if (gNandBurn + gLatchBurn == 0) return 0;
        return bem.balanceOf(address(pool)) + pool.totalPaid() - gTotal;
    }

    function _key(uint256 id) internal view returns (bytes32) {
        return mining.minerKey(address(nft), id);
    }

    function _owed(uint256 id) internal view returns (uint256) {
        return mining.rewards(_key(id)) + mining.unsettled(_key(id));
    }

    function _status(uint256 id) internal view returns (uint8 status) {
        (,, status,,,,,,) = mining.records(_key(id));
    }

    function _claimable(uint256 id) internal view returns (bool) {
        return _status(id) == 1 && !mining.keyBroken(_key(id)) && !mining.broken();
    }

    function _observe() internal {
        PoolMath.Accrual memory a = pool.accrual();
        if (
            a.nandIncome < lastNand || a.latchIncome < lastLatch || a.perNandShare < lastPerNand
                || a.perLatchShare < lastPerLatch
        ) monotonic = false;
        (lastNand, lastLatch, lastPerNand, lastPerLatch) =
            (a.nandIncome, a.latchIncome, a.perNandShare, a.perLatchShare);
    }

    // ------------------------------------------------------------------ actions

    function prepareMiner(uint32 nandSeed, uint32 latchSeed, uint64 carrySeed, bool hidden) external {
        if (registered.length + waiting.length >= 24) return;
        uint32 n = uint32(bound(nandSeed, 0, 120));
        uint32 l = uint32(bound(latchSeed, 0, 120));
        if (n + l == 0) n = 1;
        uint256 id = nextTokenId++;
        nft.mint(depositor, id);
        mining.start(address(nft), id, n, l);
        uint256 carry = bound(carrySeed, 0, 5e9);
        if (hidden) mining.accrueUnsettled(address(nft), id, carry);
        else mining.accrue(address(nft), id, carry);
        waiting.push(id);
        calls["prepare"]++;
    }

    function admit(uint256 countSeed) external {
        if (waiting.length == 0) return;
        uint256 k = bound(countSeed, 1, waiting.length > 3 ? 3 : waiting.length);
        uint256[] memory ids = new uint256[](k);
        for (uint256 i; i < k; ++i) {
            ids[i] = waiting[waiting.length - 1 - i];
        }
        bool firstAdmission = gNandBurn + gLatchBurn == 0;
        uint256 preExisting = firstAdmission ? 0 : _unrecognized();
        uint256 heldBeforeComposition =
            firstAdmission ? bem.balanceOf(address(pool)) + pool.totalPaid() - gTotal : 0;
        bool shouldRevert = mining.broken();
        uint256 expectSettled;
        for (uint256 i; i < registered.length; ++i) {
            uint8 status = _status(registered[i]);
            if (status == 2) continue; // revoked: permanent, never collectible, skipped
            if (status != 1 || mining.keyBroken(_key(registered[i]))) shouldRevert = true;
            expectSettled += _owed(registered[i]);
        }
        uint256 expectCarried = heldBeforeComposition;
        uint256 addNand;
        uint256 addLatch;
        for (uint256 i; i < k; ++i) {
            if (mining.keyBroken(_key(ids[i])) || _status(ids[i]) != 1) shouldRevert = true;
            expectCarried += _owed(ids[i]);
            (,,, uint32 n, uint32 l,,,,) = mining.records(_key(ids[i]));
            addNand += n;
            addLatch += l;
        }
        uint256 totalBefore = pool.totalAccounted();
        uint256 countBefore = pool.minerCount();
        vm.prank(depositor);
        try pool.depositMiners(ids) returns (uint256 settled, uint256 carried) {
            if (shouldRevert) amountsMatch = false;
            if (settled != expectSettled || carried != expectCarried) amountsMatch = false;
            // Model: old income under the old composition, checkpoint, new composition, carried income.
            gTotal += preExisting + settled;
            (uint256 nand, uint256 latch) = modelCategories();
            (gNandBase, gLatchBase, gParticipantBase) = (nand, latch, nand + latch);
            gNandBurn += addNand;
            gLatchBurn += addLatch;
            gTotal += carried;
            for (uint256 i; i < k; ++i) {
                registered.push(ids[i]);
                waiting.pop();
            }
            calls["admit"]++;
        } catch {
            if (!shouldRevert) amountsMatch = false;
            if (pool.totalAccounted() != totalBefore || pool.minerCount() != countBefore) {
                rollbacksClean = false;
            }
            for (uint256 i; i < k; ++i) {
                if (nft.ownerOf(ids[i]) != depositor) rollbacksClean = false;
            }
            calls["admitReverted"]++;
        }
        _observe();
    }

    function accrueRegistered(uint256 minerSeed, uint64 amount, bool hidden) external {
        if (registered.length == 0) return;
        uint256 id = registered[bound(minerSeed, 0, registered.length - 1)];
        uint256 value = bound(amount, 0, 3e9);
        if (hidden) mining.accrueUnsettled(address(nft), id, value);
        else mining.accrue(address(nft), id, value);
        calls["accrue"]++;
    }

    function harvestAll() external {
        if (registered.length == 0) return;
        uint256 expected = _unrecognized();
        for (uint256 i; i < registered.length; ++i) {
            if (_claimable(registered[i])) expected += _owed(registered[i]);
        }
        uint256 before = pool.totalAccounted();
        pool.harvestRange(0, registered.length);
        if (pool.totalAccounted() - before != expected) amountsMatch = false;
        gTotal += expected;
        _observe();
        calls["harvest"]++;
    }

    function donate(uint64 amount) external {
        bem.mint(address(pool), bound(amount, 0, 1e9));
        calls["donate"]++;
    }

    function thirdPartyClaim(uint256 minerSeed) external {
        if (registered.length == 0) return;
        uint256 id = registered[bound(minerSeed, 0, registered.length - 1)];
        if (!_claimable(id)) return;
        bytes32 key = _key(id);
        vm.prank(address(0xD00D));
        mining.claim(key);
        calls["thirdParty"]++;
    }

    /// @dev A challenge revokes a registered miner: permanent, and its unpaid rewards stay uncollectible.
    function revokeMiner(uint256 minerSeed) external {
        if (registered.length == 0) return;
        uint256 id = registered[bound(minerSeed, 0, registered.length - 1)];
        if (_status(id) == 2) return;
        mining.setStatus(address(nft), id, 2);
        calls["revoke"]++;
    }

    /// @dev Mock-only fault injection: a registered miner reported COOLING (unreachable for pool-held
    ///      miners on the real protocol). Admissions must fail closed while it lasts.
    function coolMiner(uint256 minerSeed, bool cooling) external {
        if (registered.length == 0) return;
        uint256 id = registered[bound(minerSeed, 0, registered.length - 1)];
        if (_status(id) == 2) return;
        mining.setStatus(address(nft), id, cooling ? 3 : 1);
        calls["status"]++;
    }

    function breakKey(uint256 minerSeed, bool flag) external {
        if (registered.length == 0) return;
        uint256 id = registered[bound(minerSeed, 0, registered.length - 1)];
        mining.setKeyBroken(address(nft), id, flag);
        calls["breakKey"]++;
    }

    function claim(uint256 actorSeed, uint256 pick) external {
        if (gNandBurn + gLatchBurn == 0) return;
        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        uint256[] memory nandIds = _held(pool.nandReceipt(), actor, pick);
        uint256[] memory latchIds = _held(pool.latchReceipt(), actor, pick >> 64);
        if (nandIds.length + latchIds.length == 0) return;
        gTotal += _unrecognized();
        vm.prank(actor);
        pool.claimBatch(nandIds, latchIds);
        _observe();
        calls["claim"]++;
    }

    function transfer(bool latchCategory, uint256 idSeed, uint256 toSeed) external {
        TapeoutEntitlementReceipt receipt = latchCategory ? pool.latchReceipt() : pool.nandReceipt();
        uint256 supply = receipt.totalSupply();
        if (supply == 0) return;
        uint256 id = bound(idSeed, 1, supply);
        address from = receipt.holderOf(id);
        address to = actors[bound(toSeed, 0, actors.length - 1)];
        vm.prank(from);
        receipt.safeTransferFrom(from, to, id, 1, "");
        calls["transfer"]++;
    }

    function release(bool b) external {
        if (gNandBurn + gLatchBurn == 0) return;
        gTotal += _unrecognized();
        address sink = pool.SINK();
        uint256 sinkBefore = bem.balanceOf(sink);
        uint256 sinkPaidBefore = pool.sinkPaid();
        uint256 otherPaid = b ? pool.recipientAPaid() : pool.recipientBPaid();
        uint256 rolePaid = b ? pool.recipientBPaid() : pool.recipientAPaid();
        uint256 got = b ? pool.releaseB() : pool.releaseA();
        // Model: at one total T the role receives floor(T/84) minus what it had, C receives floor(2T/84)
        // minus everything it had, and the other role is untouched.
        uint256 cDue = gTotal * 2 / 84 - sinkPaidBefore;
        if (got != gTotal / 84 - rolePaid) amountsMatch = false;
        if (pool.sinkPaid() != gTotal * 2 / 84 || bem.balanceOf(sink) != sinkBefore + cDue) {
            amountsMatch = false;
        }
        if ((b ? pool.recipientAPaid() : pool.recipientBPaid()) != otherPaid) amountsMatch = false;
        _observe();
        calls["release"]++;
    }

    function _held(TapeoutEntitlementReceipt receipt, address actor, uint256 pick)
        internal
        view
        returns (uint256[] memory ids)
    {
        uint256 supply = receipt.totalSupply();
        uint256[] memory tmp = new uint256[](supply);
        uint256 n;
        for (uint256 id = 1; id <= supply; ++id) {
            if (receipt.holderOf(id) == actor && (pick >> (id % 64)) & 1 == 1) tmp[n++] = id;
        }
        ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = tmp[i];
        }
    }

    function registeredCount() external view returns (uint256) {
        return registered.length;
    }
}

contract PoolInvariantTest is SystemTestBase {
    SystemHandler internal handler;
    address[] internal actorList;
    address[] internal payeeList;

    function setUp() public override {
        super.setUp();
        issue(nandReceipt, alice, 7);
        issue(nandReceipt, bob, 6);
        issue(latchReceipt, carol, 5);
        issue(latchReceipt, dave, 4);
        finalizeIssuance();
        activate();
        actorList.push(alice);
        actorList.push(bob);
        actorList.push(carol);
        actorList.push(dave);
        payeeList.push(alice);
        payeeList.push(bob);
        payeeList.push(carol);
        payeeList.push(dave);
        payeeList.push(recipientA);
        payeeList.push(recipientB);
        payeeList.push(pool.SINK());
        handler = new SystemHandler(pool, bem, mining, nft, depositor, actorList, payeeList);
        targetContract(address(handler));
    }

    function invariantModelMatchesTheLedger() public view {
        assertTrue(handler.amountsMatch(), "settlement / carried / harvest amounts");
        assertTrue(handler.rollbacksClean(), "failed admissions changed state");
        assertEq(pool.totalAccounted(), handler.gTotal(), "recognized total");
        (uint256 nand, uint256 latch) = handler.modelCategories();
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(a.nandIncome, nand, "NAND income vs old/new composition model");
        assertEq(a.latchIncome, latch, "LATCH income vs old/new composition model");
        assertEq(pool.totalNandBurn(), handler.gNandBurn());
        assertEq(pool.totalLatchBurn(), handler.gLatchBurn());
    }

    function invariantFourAccountConservation() public view {
        assertReconciled();
        uint256 paidOut;
        for (uint256 i; i < payeeList.length; ++i) {
            paidOut += bem.balanceOf(payeeList[i]);
        }
        assertEq(paidOut, pool.totalPaid(), "payees received exactly what was paid");
        assertEq(
            bem.balanceOf(address(pool)) + pool.totalPaid(), bem.totalSupply() - bem.balanceOf(depositor)
        );
    }

    function invariantPerIdHistories() public view {
        PoolMath.Accrual memory a = pool.accrual();
        uint256 sum;
        for (uint256 id = 1; id <= pool.nandShares(); ++id) {
            uint256 c = pool.claimed(NAND, id);
            assertLe(c, a.perNandShare);
            sum += c;
        }
        assertEq(sum, pool.receiptsPaid(NAND));
        sum = 0;
        for (uint256 id = 1; id <= pool.latchShares(); ++id) {
            uint256 c = pool.claimed(LATCH, id);
            assertLe(c, a.perLatchShare);
            sum += c;
        }
        assertEq(sum, pool.receiptsPaid(LATCH));
        assertEq(nandReceipt.totalSupply(), 13);
        assertEq(latchReceipt.totalSupply(), 9);
    }

    function invariantEntitlementsNeverDecrease() public view {
        assertTrue(handler.monotonic());
    }

    function invariantCompositionAndCustody() public view {
        uint256 n;
        uint256 l;
        for (uint256 i; i < handler.registeredCount(); ++i) {
            uint256 id = handler.registered(i);
            TapeoutMinerPool.Miner memory m = pool.miner(id);
            n += m.nandBurn;
            l += m.latchBurn;
            assertEq(nft.ownerOf(id), address(pool));
        }
        assertEq(n, pool.totalNandBurn());
        assertEq(l, pool.totalLatchBurn());
    }
}
