// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {console2} from "forge-std/console2.sol";
import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutEntitlementReceipt} from "../../src/TapeoutEntitlementReceipt.sol";
import {PoolMath} from "../../src/PoolMath.sol";

/// @notice Internal security review (f2c8e50), workstream A. Differential fuzz: a random interleaving of
///         admissions (visible and pending-hidden carried income), accruals, harvests, third-party
///         Mining claims, donations, holder claims (single and batch), receipt transfers, A/B releases
///         and A/B role migrations runs against the real contracts; the same sequence, as a textual
///         trace, is replayed by test/audit/model.py, a reference model written from
///         docs/ACCOUNTING.md with exact integer and rational arithmetic and no dependency on PoolMath
///         or sdk/math.ts. Every ledger quantity, per-ID history and account balance must agree, and
///         the model's own invariants (monotonicity, one-unit split bound, rational drift bound,
///         conservation, residue bound) must hold on every step.
///         Run: forge test --match-path 'test/audit/AuditDifferential.t.sol' --ffi -vv
contract AuditDifferentialTest is SystemTestBase {
    uint256 internal constant S_N = 7;
    uint256 internal constant S_L = 5;
    uint256 internal constant STEPS = 24;
    uint256 internal constant MAX_MINERS = 6;

    address internal eve = makeAddr("eve");
    address internal frank = makeAddr("frank");
    address[9] internal actors;
    uint256[] internal registered;
    uint256 internal nextMiner = 1;
    string internal trace;

    function setUp() public override {
        super.setUp();
        issue(nandReceipt, alice, 4);
        issue(nandReceipt, bob, 3);
        issue(latchReceipt, carol, 3);
        issue(latchReceipt, dave, 2);
        finalizeIssuance();
        activate();
        actors = [alice, bob, carol, dave, eve, frank, recipientA, recipientB, pool.SINK()];
    }

    /// forge-config: default.fuzz.runs = 400
    function testFuzzLedgerMatchesIndependentReferenceModel(uint256 seed) public {
        for (uint256 i; i < STEPS; ++i) {
            _step(uint256(keccak256(abi.encode(seed, i))));
        }
        pool.sync();
        string[] memory cmd = new string[](4);
        cmd[0] = "python3";
        cmd[1] = "-I";
        cmd[2] = "test/audit/model.py";
        cmd[3] = bytes(trace).length == 0 ? "-" : trace;
        uint256[] memory e = abi.decode(vm.ffi(cmd), (uint256[]));
        if (e[0] != 0) console2.log("trace:", trace);
        assertEq(e[0], 0, "reference model: invariant violated (trace logged)");
        PoolMath.Accrual memory a = pool.accrual();
        assertEq(pool.totalAccounted(), e[1], "totalAccounted");
        assertEq(a.recipientA, e[2], "A accrued");
        assertEq(a.sink, e[3], "C accrued");
        assertEq(a.nandIncome, e[4], "nandIncome");
        assertEq(a.latchIncome, e[5], "latchIncome");
        assertEq(a.perNandShare, e[6], "perNandShare");
        assertEq(a.perLatchShare, e[7], "perLatchShare");
        assertEq(a.residue, e[8], "residue");
        assertEq(pool.totalPaid(), e[9], "totalPaid");
        assertEq(pool.recipientAPaid(), e[10], "A paid");
        assertEq(pool.recipientBPaid(), e[11], "B paid");
        assertEq(pool.sinkPaid(), e[12], "C paid");
        assertEq(pool.receiptsPaid(NAND), e[13], "NAND receipts paid");
        assertEq(pool.receiptsPaid(LATCH), e[14], "LATCH receipts paid");
        assertEq(pool.compositionPeriod(), e[15], "periods");
        assertEq(bem.balanceOf(address(pool)), e[16], "pool balance");
        uint256 k = 17;
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
        uint256 op = r % 9;
        if (op == 0) _opAdmit(r);
        else if (op == 1) _opAccrue(r);
        else if (op == 2) _opHarvest();
        else if (op == 3) _opThirdParty(r);
        else if (op == 4) _opDonate(r);
        else if (op == 5) _opClaim(r);
        else if (op == 6) _opTransfer(r);
        else if (op == 7) _opRelease(r);
        else _opMigrate(r);
    }

    function _opAdmit(uint256 r) internal {
        if (registered.length >= MAX_MINERS) return;
        uint32 n = uint32((r >> 8) % 13);
        uint32 l = uint32((r >> 16) % 13);
        if (n + l == 0) n = 1;
        uint256 carry = (r >> 32) % 2_000_000_001;
        uint256 id = nextMiner++;
        newMiner(id, n, l);
        if ((r >> 100) & 1 == 1) mining.accrueUnsettled(address(nft), id, carry);
        else accrue(id, carry);
        admit(one(id));
        registered.push(id);
        _append(
            string.concat(
                "A:", vm.toString(id), ",", vm.toString(uint256(n)), ",", vm.toString(uint256(l)), ",",
                vm.toString(carry), ";"
            )
        );
    }

    function _opAccrue(uint256 r) internal {
        if (registered.length == 0) return;
        uint256 id = registered[(r >> 8) % registered.length];
        uint256 amount = (r >> 40) % 3_000_000_001;
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
        if (registered.length == 0) return;
        uint256 id = registered[(r >> 8) % registered.length];
        vm.prank(address(0xD00D));
        mining.claim(mining.minerKey(address(nft), id));
        _append(string.concat("T:", vm.toString(id), ";"));
    }

    function _opDonate(uint256 r) internal {
        uint256 amount = (r >> 40) % 1_000_000_001;
        bem.mint(address(pool), amount);
        _append(string.concat("D:", vm.toString(amount), ";"));
    }

    function _opClaim(uint256 r) internal {
        uint256 cat = (r >> 8) % 2;
        TapeoutEntitlementReceipt receipt = cat == 0 ? nandReceipt : latchReceipt;
        uint256 supply = cat == 0 ? S_N : S_L;
        uint256 id = 1 + (r >> 16) % supply;
        address holder = receipt.holderOf(id);
        if ((r >> 60) & 1 == 1) {
            uint256[] memory held = _held(receipt, holder, supply);
            vm.prank(holder);
            if (cat == 0) pool.claimBatch(held, none());
            else pool.claimBatch(none(), held);
            for (uint256 i; i < held.length; ++i) {
                _append(_claimOp(cat, held[i], holder));
            }
        } else {
            vm.prank(holder);
            pool.claim(TapeoutMinerPool.Category(cat), id);
            _append(_claimOp(cat, id, holder));
        }
    }

    function _opTransfer(uint256 r) internal {
        uint256 cat = (r >> 8) % 2;
        TapeoutEntitlementReceipt receipt = cat == 0 ? nandReceipt : latchReceipt;
        uint256 supply = cat == 0 ? S_N : S_L;
        uint256 id = 1 + (r >> 16) % supply;
        address from = receipt.holderOf(id);
        uint256 toIdx = (r >> 24) % 6;
        vm.prank(from);
        receipt.safeTransferFrom(from, actors[toIdx], id, 1, "");
        _append(string.concat("X:", vm.toString(cat), ",", vm.toString(id), ",", vm.toString(toIdx), ";"));
    }

    function _opRelease(uint256 r) internal {
        uint256 role = (r >> 8) % 2;
        if (role == 0) pool.releaseA();
        else pool.releaseB();
        _append(string.concat("L:", vm.toString(role), ";"));
    }

    function _opMigrate(uint256 r) internal {
        uint256 role = (r >> 8) % 2;
        uint256 toIdx = (r >> 16) % 6;
        address current = role == 0 ? pool.recipientA() : pool.recipientB();
        vm.prank(current);
        pool.setRecipient(TapeoutMinerPool.Recipient(role), actors[toIdx]);
        _append(string.concat("G:", vm.toString(role), ",", vm.toString(toIdx), ";"));
    }

    // ------------------------------------------------------------------------------- helpers

    function _claimOp(uint256 cat, uint256 id, address holder) internal view returns (string memory) {
        return string.concat("C:", vm.toString(cat), ",", vm.toString(id), ",", vm.toString(_idx(holder)), ";");
    }

    function _held(TapeoutEntitlementReceipt receipt, address holder, uint256 supply)
        internal
        view
        returns (uint256[] memory ids)
    {
        uint256[] memory tmp = new uint256[](supply);
        uint256 n;
        for (uint256 id = 1; id <= supply; ++id) {
            if (receipt.holderOf(id) == holder) tmp[n++] = id;
        }
        ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = tmp[i];
        }
    }

    function _idx(address a) internal view returns (uint256) {
        for (uint256 i; i < 9; ++i) {
            if (actors[i] == a) return i;
        }
        revert("unknown actor");
    }

    function _append(string memory s) internal {
        trace = string.concat(trace, s);
    }
}
