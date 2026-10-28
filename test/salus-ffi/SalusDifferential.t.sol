// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {console2} from "forge-std/console2.sol";
import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutEntitlementReceipt} from "../../src/TapeoutEntitlementReceipt.sol";
import {PoolMath} from "../../src/PoolMath.sol";

/// @notice SALUS remediation differential test. A random interleaving of miner preparation (carried
///         income visible to pending() or hidden from it), batch admissions in random order, accruals,
///         harvests, third-party claims, donations, revocations, holder claims, receipt transfers and
///         A/B releases runs against the real contracts on the mock protocol; the same sequence, as a
///         textual trace, is replayed by test/salus-ffi/model.py, an independent reference model (exact
///         rationals and a from-scratch entry ledger, no PoolMath, no sdk/math.ts). Every ledger
///         quantity, the carried-income totals, the ledger units, per-ID histories and every account
///         balance must agree, and the model's own invariants must hold.
///         Run: forge test --match-path 'test/salus-ffi/*' --ffi
contract SalusDifferentialTest is SystemTestBase {
    uint256 internal constant S_N = 7;
    uint256 internal constant S_L = 5;
    uint256 internal constant STEPS = 30;
    uint256 internal constant MAX_MINERS = 9;

    address internal eve = makeAddr("eve");
    address internal frank = makeAddr("frank");
    address[9] internal actors;
    uint256[] internal prepared;
    uint256[] internal registered;
    mapping(uint256 => bool) internal revoked;
    uint256 internal nextMiner = 1;
    string internal trace;

    function setUp() public override {
        super.setUp();
        issue(nandReceipt, alice, 4);
        issue(nandReceipt, bob, 3);
        issue(latchReceipt, carol, 3);
        issue(latchReceipt, dave, 2);
        finalizeIssuance();
        activate(); // binds the (empty) distributor, finalizes it, activates, renounces every owner
        actors = [alice, bob, carol, dave, eve, frank, recipientA, recipientB, pool.SINK()];
    }

    /// forge-config: default.fuzz.runs = 300
    function testFuzzLedgerMatchesTheSalusReferenceModel(uint256 seed) public {
        for (uint256 i; i < STEPS; ++i) {
            _step(uint256(keccak256(abi.encode(seed, i))));
        }
        _compare();
    }

    /// @notice The SALUS example (X 10:0 and Y 5:5, 105 BEM each) in three orders, each against the model.
    function testSalusExampleMatchesTheModelInEveryOrder() public {
        uint256 snapshot = vm.snapshotState();
        for (uint256 order; order < 3; ++order) {
            vm.revertToState(snapshot);
            trace = "";
            _prepare(1, 10, 0, 105 * BEM_UNIT, false);
            _prepare(2, 5, 5, 105 * BEM_UNIT, true);
            if (order == 0) {
                _admit(_one(1));
                _admit(_one(2));
            } else if (order == 1) {
                _admit(_one(2));
                _admit(_one(1));
            } else {
                _admit(two(2, 1));
            }
            assertEq(pool.accrual().nandIncome, 150 * BEM_UNIT);
            assertEq(pool.accrual().latchIncome, 50 * BEM_UNIT);
            _compare();
        }
    }

    // ------------------------------------------------------------------------------- comparison

    function _compare() internal {
        pool.sync();
        string[] memory cmd = new string[](4);
        cmd[0] = "python3";
        cmd[1] = "-I";
        cmd[2] = "test/salus-ffi/model.py";
        cmd[3] = bytes(trace).length == 0 ? "-" : trace;
        uint256[] memory e = abi.decode(vm.ffi(cmd), (uint256[]));
        if (e[0] != 0) console2.log("trace:", trace);
        assertEq(e[0], 0, "reference model: invariant violated (trace logged)");
        PoolMath.Accrual memory a = pool.accrual();
        (uint256 nandUnits, uint256 latchUnits) =
            PoolMath.categoryUnits(pool.totalAccounted(), pool.ledgerState());
        uint256[22] memory got = [
            pool.totalAccounted(),
            a.recipientA,
            a.sink,
            a.nandIncome,
            a.latchIncome,
            a.perNandShare,
            a.perLatchShare,
            a.residue,
            pool.totalPaid(),
            pool.recipientAPaid(),
            pool.recipientBPaid(),
            pool.sinkPaid(),
            pool.receiptsPaid(NAND),
            pool.receiptsPaid(LATCH),
            pool.carriedIncome(),
            pool.carriedNandUnits(),
            nandUnits,
            latchUnits,
            pool.totalNandBurn(),
            pool.totalLatchBurn(),
            pool.minerCount(),
            bem.balanceOf(address(pool))
        ];
        string[22] memory names = [
            "totalAccounted",
            "A accrued",
            "C accrued",
            "nandIncome",
            "latchIncome",
            "perNandShare",
            "perLatchShare",
            "residue",
            "totalPaid",
            "A paid",
            "B paid",
            "C paid",
            "NAND receipts paid",
            "LATCH receipts paid",
            "carried income",
            "carried NAND units",
            "NAND ledger units",
            "LATCH ledger units",
            "NAND burn",
            "LATCH burn",
            "registered miners",
            "pool balance"
        ];
        for (uint256 i; i < 22; ++i) {
            assertEq(got[i], e[1 + i], names[i]);
        }
        uint256 k = 23;
        for (uint256 id = 1; id <= S_N; ++id) {
            assertEq(pool.claimed(NAND, id), e[k++], "claimed NAND");
        }
        for (uint256 id = 1; id <= S_L; ++id) {
            assertEq(pool.claimed(LATCH, id), e[k++], "claimed LATCH");
        }
        for (uint256 i; i < 9; ++i) {
            assertEq(bem.balanceOf(actors[i]), e[k++], "actor balance");
        }
        assertReconciled();
    }

    // ------------------------------------------------------------------------------- operations

    function _step(uint256 r) internal {
        uint256 op = r % 10;
        if (op == 0 || op == 1) _opPrepare(r);
        else if (op == 2) _opAdmit(r);
        else if (op == 3) _opAccrue(r);
        else if (op == 4) _opHarvest();
        else if (op == 5) _opThirdParty(r);
        else if (op == 6) _opDonate(r);
        else if (op == 7) _opClaim(r);
        else if (op == 8) _opTransfer(r);
        else if ((r >> 200) % 4 == 0) _opRevoke(r);
        else _opRelease(r);
    }

    function _prepare(uint256 id, uint32 n, uint32 l, uint256 carry, bool hidden) internal {
        newMiner(id, n, l);
        if (hidden) mining.accrueUnsettled(address(nft), id, carry);
        else accrue(id, carry);
        prepared.push(id);
        _append(
            string.concat(
                "P:",
                vm.toString(id),
                ",",
                vm.toString(uint256(n)),
                ",",
                vm.toString(uint256(l)),
                ",",
                vm.toString(carry),
                ";"
            )
        );
    }

    function _opPrepare(uint256 r) internal {
        if (nextMiner > MAX_MINERS) return;
        uint32 n = uint32((r >> 8) % 13);
        uint32 l = uint32((r >> 16) % 13);
        if (n + l == 0) n = 1;
        uint256 carry = (r >> 32) % 2_000_000_001;
        if ((r >> 96) % 5 == 0) carry %= 100; // small raw amounts
        _prepare(nextMiner++, n, l, carry, (r >> 100) & 1 == 1);
    }

    function _admit(uint256[] memory ids) internal {
        admit(ids);
        string memory op = "A:";
        for (uint256 i; i < ids.length; ++i) {
            op = string.concat(op, i == 0 ? "" : ",", vm.toString(ids[i]));
            registered.push(ids[i]);
            for (uint256 j; j < prepared.length; ++j) {
                if (prepared[j] == ids[i]) {
                    prepared[j] = prepared[prepared.length - 1];
                    prepared.pop();
                    break;
                }
            }
        }
        _append(string.concat(op, ";"));
    }

    function _opAdmit(uint256 r) internal {
        if (prepared.length == 0) return;
        uint256 k = 1 + (r >> 8) % (prepared.length < 3 ? prepared.length : 3);
        uint256[] memory pool_ = new uint256[](prepared.length);
        for (uint256 i; i < prepared.length; ++i) {
            pool_[i] = prepared[i];
        }
        uint256[] memory ids = new uint256[](k);
        uint256 left = pool_.length;
        for (uint256 i; i < k; ++i) {
            uint256 j = uint256(keccak256(abi.encode(r, i))) % left;
            ids[i] = pool_[j];
            pool_[j] = pool_[left - 1];
            --left;
        }
        _admit(ids);
    }

    function _liveRegistered(uint256 r) internal view returns (uint256 id, bool found) {
        if (registered.length == 0) return (0, false);
        uint256 start = r % registered.length;
        for (uint256 i; i < registered.length; ++i) {
            id = registered[(start + i) % registered.length];
            if (!revoked[id]) return (id, true);
        }
        return (0, false);
    }

    function _opAccrue(uint256 r) internal {
        uint256 id;
        bool found;
        if ((r >> 8) & 1 == 1 && prepared.length != 0) {
            (id, found) = (prepared[(r >> 16) % prepared.length], true);
        } else {
            (id, found) = _liveRegistered(r >> 16);
        }
        if (!found) return;
        uint256 amount = (r >> 32) % 1_000_000_001;
        if ((r >> 100) & 1 == 1) mining.accrueUnsettled(address(nft), id, amount);
        else accrue(id, amount);
        _append(string.concat("R:", vm.toString(id), ",", vm.toString(amount), ";"));
    }

    function _opHarvest() internal {
        if (registered.length == 0) return;
        pool.harvestRange(0, registered.length);
        _append("H;");
    }

    function _opThirdParty(uint256 r) internal {
        (uint256 id, bool found) = _liveRegistered(r >> 8);
        if (!found) return;
        vm.prank(address(0xD00D));
        mining.claim(mining.minerKey(address(nft), id));
        _append(string.concat("T:", vm.toString(id), ";"));
    }

    function _opDonate(uint256 r) internal {
        uint256 amount = (r >> 8) % 300_000_001;
        bem.mint(address(pool), amount);
        _append(string.concat("D:", vm.toString(amount), ";"));
    }

    function _opRevoke(uint256 r) internal {
        (uint256 id, bool found) = _liveRegistered(r >> 8);
        if (!found) return;
        mining.setStatus(address(nft), id, 2);
        revoked[id] = true;
        _append(string.concat("V:", vm.toString(id), ";"));
    }

    function _receipt(uint256 c) internal view returns (TapeoutEntitlementReceipt) {
        return c == 0 ? nandReceipt : latchReceipt;
    }

    function _actorIndex(address who) internal view returns (uint256) {
        for (uint256 i; i < 6; ++i) {
            if (actors[i] == who) return i;
        }
        revert("holder is not an actor");
    }

    function _opClaim(uint256 r) internal {
        uint256 c = (r >> 8) & 1;
        uint256 id = 1 + (r >> 16) % (c == 0 ? S_N : S_L);
        address holder = _receipt(c).holderOf(id);
        vm.prank(holder);
        pool.claim(c == 0 ? NAND : LATCH, id);
        _append(
            string.concat(
                "C:", vm.toString(c), ",", vm.toString(id), ",", vm.toString(_actorIndex(holder)), ";"
            )
        );
    }

    function _opTransfer(uint256 r) internal {
        uint256 c = (r >> 8) & 1;
        uint256 id = 1 + (r >> 16) % (c == 0 ? S_N : S_L);
        uint256 to = (r >> 32) % 6;
        address holder = _receipt(c).holderOf(id);
        vm.prank(holder);
        _receipt(c).safeTransferFrom(holder, actors[to], id, 1, "");
        _append(string.concat("X:", vm.toString(c), ",", vm.toString(id), ",", vm.toString(to), ";"));
    }

    function _opRelease(uint256 r) internal {
        uint256 role = (r >> 8) & 1;
        if (role == 0) pool.releaseA();
        else pool.releaseB();
        _append(string.concat("L:", vm.toString(role), ";"));
    }

    function _append(string memory op) internal {
        trace = string.concat(trace, op);
    }

    function _one(uint256 x) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = x;
    }
}
