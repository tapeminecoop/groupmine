// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutEntitlementReceipt} from "../../src/TapeoutEntitlementReceipt.sol";
import {PoolMath} from "../../src/PoolMath.sol";

/// @notice Review-only differential test (Fable 5.1, target 6345de8): random action traces are applied
///         to the real contracts and, as a textual trace, to test/review-fable51/model_fable.py, an
///         independent model written from the economic specification only. Every ledger quantity,
///         boundary base, per-ID history, per-miner carried record and account balance is compared.
///         The model's own invariants (conservation, monotonicity, bounds against the exact rational
///         economics, residue bound) are checked on the model side and reported in the status word.
///         Run: forge test --match-path 'test/review-fable51/ReviewDifferential.t.sol' --ffi
contract ReviewDifferentialTest is SystemTestBase {
    uint256 internal constant SN = 6;
    uint256 internal constant SL = 4;
    address internal eve = makeAddr("eve");
    address[9] internal actors;
    string internal trace;
    uint256 internal nextId;
    uint256[] internal prepared;
    uint256 internal seedState;

    function setUp() public override {
        super.setUp();
        issue(nandReceipt, alice, 3);
        issue(nandReceipt, bob, 3);
        issue(latchReceipt, carol, 2);
        issue(latchReceipt, dave, 2);
        finalizeIssuance();
        activate(); // empty allocation finalized, activated, every owner renounced
        actors = [alice, bob, carol, dave, eve, recipientA, recipientB, pool.SINK(), depositor];
        vm.prank(depositor);
        nft.setApprovalForAll(address(pool), true);
    }

    // ------------------------------------------------------------------------------ randomness
    function rnd(uint256 bound_) internal returns (uint256) {
        seedState = uint256(keccak256(abi.encode(seedState)));
        return bound_ == 0 ? 0 : seedState % bound_;
    }

    function rndAmount() internal returns (uint256) {
        uint256 k = rnd(4);
        if (k == 0) return rnd(200);
        if (k == 1) return rnd(1_000_000);
        if (k == 2) return rnd(1e12);
        return 0;
    }

    function append(string memory op) internal {
        trace = string.concat(trace, op, ";");
    }

    function actorIndex(address a) internal view returns (uint256) {
        for (uint256 i; i < actors.length; ++i) {
            if (actors[i] == a) return i;
        }
        revert("unknown actor");
    }

    function status(uint256 id) internal view returns (uint8) {
        return mining.getMiner(mining.minerKey(address(nft), id)).status;
    }

    // ------------------------------------------------------------------------------ one step
    function step() internal {
        uint256 k = rnd(16);
        if (k < 2) {
            uint256 id = ++nextId;
            uint32 n = uint32(rnd(10));
            uint32 l = uint32(rnd(10));
            if (n + l == 0) n = 1;
            uint256 vis = rndAmount();
            uint256 hid = rndAmount();
            newMiner(id, n, l);
            if (vis != 0) mining.accrue(address(nft), id, vis);
            if (hid != 0) mining.accrueUnsettled(address(nft), id, hid);
            prepared.push(id);
            append(
                string.concat(
                    "M:",
                    vm.toString(id),
                    ",",
                    vm.toString(uint256(n)),
                    ",",
                    vm.toString(uint256(l)),
                    ",",
                    vm.toString(vis),
                    ",",
                    vm.toString(hid)
                )
            );
        } else if (k < 5) {
            if (prepared.length == 0) return;
            uint256 count = 1 + rnd(3);
            uint256[] memory ids = new uint256[](0);
            string memory op = "A:";
            for (uint256 i; i < count; ++i) {
                uint256 id = prepared[rnd(prepared.length)];
                bool dup;
                for (uint256 j; j < ids.length; ++j) {
                    if (ids[j] == id) dup = true;
                }
                if (dup) continue;
                uint256[] memory grown = new uint256[](ids.length + 1);
                for (uint256 j; j < ids.length; ++j) {
                    grown[j] = ids[j];
                }
                grown[ids.length] = id;
                ids = grown;
                op = string.concat(op, ids.length == 1 ? "" : ",", vm.toString(id));
            }
            vm.prank(depositor);
            try pool.depositMiners(ids) {} catch {}
            append(op);
        } else if (k == 5) {
            if (prepared.length == 0) return;
            uint256 id = prepared[rnd(prepared.length)];
            if (nft.ownerOf(id) != depositor) return;
            vm.prank(depositor);
            nft.transferFrom(depositor, address(pool), id);
            append(string.concat("N:", vm.toString(id)));
        } else if (k == 6) {
            if (prepared.length == 0) return;
            uint256 id = prepared[rnd(prepared.length)];
            vm.prank(depositor);
            try pool.registerMiners(one(id)) {} catch {}
            append(string.concat("E:", vm.toString(id)));
        } else if (k == 7) {
            if (prepared.length == 0) return;
            uint256 id = prepared[rnd(prepared.length)];
            uint256 amt = rndAmount();
            if (rnd(2) == 0) mining.accrue(address(nft), id, amt);
            else mining.accrueUnsettled(address(nft), id, amt);
            append(string.concat("R:", vm.toString(id), ",", vm.toString(amt)));
        } else if (k == 8) {
            uint256 count = pool.minerCount();
            if (count == 0) return;
            pool.harvestRange(0, count);
            append("H");
        } else if (k == 9) {
            if (prepared.length == 0) return;
            uint256 id = prepared[rnd(prepared.length)];
            vm.prank(address(0xD00D));
            try mining.claim(mining.minerKey(address(nft), id)) {} catch {}
            append(string.concat("P:", vm.toString(id)));
        } else if (k == 10) {
            uint256 amt = rndAmount();
            bem.mint(address(pool), amt);
            append(string.concat("D:", vm.toString(amt)));
        } else if (k == 11) {
            if (prepared.length == 0) return;
            uint256 id = prepared[rnd(prepared.length)];
            if (status(id) != 1) return;
            // Real-protocol revocation pays the holder first, then the status is terminal.
            vm.prank(address(0xBEEF));
            mining.claim(mining.minerKey(address(nft), id));
            mining.setStatus(address(nft), id, 2);
            append(string.concat("V:", vm.toString(id)));
        } else if (k == 12) {
            if (prepared.length == 0) return;
            uint256 id = prepared[rnd(prepared.length)];
            uint8 s = status(id);
            if (s == 1) {
                mining.setStatus(address(nft), id, 3); // mock-only fault injection
                append(string.concat("K:", vm.toString(id)));
            } else if (s == 3) {
                mining.setStatus(address(nft), id, 1);
                append(string.concat("U:", vm.toString(id)));
            }
        } else if (k == 13) {
            uint256 c = rnd(2);
            TapeoutEntitlementReceipt r = c == 0 ? nandReceipt : latchReceipt;
            uint256 id = 1 + rnd(c == 0 ? SN : SL);
            address holder = r.holderOf(id);
            vm.prank(holder);
            pool.claim(TapeoutMinerPool.Category(c), id);
            append(
                string.concat(
                    "C:", vm.toString(c), ",", vm.toString(id), ",", vm.toString(actorIndex(holder))
                )
            );
        } else if (k == 14) {
            uint256 c = rnd(2);
            TapeoutEntitlementReceipt r = c == 0 ? nandReceipt : latchReceipt;
            uint256 id = 1 + rnd(c == 0 ? SN : SL);
            address from = r.holderOf(id);
            uint256 to = rnd(5);
            vm.prank(from);
            r.safeTransferFrom(from, actors[to], id, 1, "");
            append(string.concat("X:", vm.toString(c), ",", vm.toString(id), ",", vm.toString(to)));
        } else {
            uint256 role = rnd(2);
            if (role == 0) pool.releaseA();
            else pool.releaseB();
            append(string.concat("L:", vm.toString(role)));
        }
    }

    // ------------------------------------------------------------------------------ comparison
    function model() internal returns (uint256[] memory e) {
        string[] memory cmd = new string[](4);
        cmd[0] = "python3";
        cmd[1] = "-I";
        cmd[2] = "test/review-fable51/model_fable.py";
        cmd[3] = bytes(trace).length == 0 ? "" : trace;
        e = abi.decode(vm.ffi(cmd), (uint256[]));
    }

    /// @dev The current category units by the specification's formula (written here, not PoolMath).
    function currentUnits() internal view returns (uint256 nu, uint256 lu) {
        PoolMath.State memory s = pool.ledgerState();
        nu = s.nandBase;
        lu = s.latchBase;
        uint256 w = s.totalNandBurn + s.totalLatchBurn;
        if (w != 0) {
            uint256 d = (pool.totalAccounted() - s.accountedBase) * 80 * 1e18;
            uint256 toNand = d * s.totalNandBurn / w;
            nu += toNand;
            lu += d - toNand;
        }
    }

    function compare() internal {
        pool.sync();
        uint256[] memory e = model();
        assertEq(e[0], 0, string.concat("model invariant violated for trace ", trace));
        PoolMath.Accrual memory a = pool.accrual();
        PoolMath.State memory s = pool.ledgerState();
        (uint256 nu, uint256 lu) = currentUnits();
        uint256 i = 1;
        assertEq(pool.totalAccounted(), e[i++], "T");
        assertEq(a.recipientA, e[i++], "A");
        assertEq(a.sink, e[i++], "C");
        assertEq(a.nandIncome, e[i++], "nandIncome");
        assertEq(a.latchIncome, e[i++], "latchIncome");
        assertEq(a.perNandShare, e[i++], "perNandShare");
        assertEq(a.perLatchShare, e[i++], "perLatchShare");
        assertEq(a.residue, e[i++], "residue");
        assertEq(pool.totalPaid(), e[i++], "totalPaid");
        assertEq(pool.recipientAPaid(), e[i++], "recipientAPaid");
        assertEq(pool.recipientBPaid(), e[i++], "recipientBPaid");
        assertEq(pool.sinkPaid(), e[i++], "sinkPaid");
        assertEq(pool.receiptsPaid(NAND), e[i++], "nandReceiptsPaid");
        assertEq(pool.receiptsPaid(LATCH), e[i++], "latchReceiptsPaid");
        assertEq(pool.carriedIncome(), e[i++], "carriedIncome");
        assertEq(pool.carriedNandUnits(), e[i++], "carriedNandUnits");
        assertEq(nu, e[i++], "nandUnits");
        assertEq(lu, e[i++], "latchUnits");
        assertEq(s.accountedBase, e[i++], "accountedBase");
        assertEq(s.nandBase, e[i++], "nandBase");
        assertEq(s.latchBase, e[i++], "latchBase");
        assertEq(s.totalNandBurn, e[i++], "N");
        assertEq(s.totalLatchBurn, e[i++], "L");
        assertEq(pool.minerCount(), e[i++], "minerCount");
        assertEq(bem.balanceOf(address(pool)), e[i++], "pool balance");
        assertEq(pool.compositionPeriod(), e[i++], "periods");
        for (uint256 id = 1; id <= SN; ++id) {
            assertEq(pool.claimed(NAND, id), e[i++], "claimed NAND");
        }
        for (uint256 id = 1; id <= SL; ++id) {
            assertEq(pool.claimed(LATCH, id), e[i++], "claimed LATCH");
        }
        for (uint256 x; x < actors.length; ++x) {
            assertEq(bem.balanceOf(actors[x]), e[i++], "actor balance");
        }
        for (uint256 x; x < pool.minerCount(); ++x) {
            (uint256 id,) = pool.minerAt(x);
            assertEq(pool.miner(id).carriedIncome, e[i++], "per-miner carried");
        }
        assertEq(i, e.length, "word count");
        assertReconciled();
    }

    /// forge-config: default.fuzz.runs = 300
    function testFuzzTraceMatchesIndependentModel(uint256 seed) public {
        seedState = seed;
        uint256 ops = 12 + rnd(28);
        for (uint256 i; i < ops; ++i) {
            step();
        }
        compare();
    }

    /// @notice Long traces with many small raw amounts: the rounding-sensitive regime.
    /// forge-config: default.fuzz.runs = 100
    function testFuzzSmallAmountTracesMatchIndependentModel(uint256 seed) public {
        seedState = seed;
        for (uint256 i; i < 60; ++i) {
            uint256 k = rnd(16);
            // bias toward admissions, accruals and harvests with tiny amounts
            if (k < 6) {
                uint256 id = ++nextId;
                uint32 n = uint32(rnd(13));
                uint32 l = uint32(rnd(13));
                if (n + l == 0) l = 1;
                uint256 vis = rnd(100);
                newMiner(id, n, l);
                if (vis != 0) mining.accrue(address(nft), id, vis);
                prepared.push(id);
                append(
                    string.concat(
                        "M:",
                        vm.toString(id),
                        ",",
                        vm.toString(uint256(n)),
                        ",",
                        vm.toString(uint256(l)),
                        ",",
                        vm.toString(vis),
                        ",0"
                    )
                );
                vm.prank(depositor);
                try pool.depositMiners(one(id)) {} catch {}
                append(string.concat("A:", vm.toString(id)));
            } else {
                step();
            }
        }
        compare();
    }
}
