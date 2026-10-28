// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutEntitlementReceipt} from "../../src/TapeoutEntitlementReceipt.sol";
import {TapeoutReceiptDistributor} from "../../src/TapeoutReceiptDistributor.sol";
import {MockMining, MockNFT} from "../helpers/Mocks.sol";

/// @dev Performs the initialization steps in any order (finalizations, binding, activation, each
///      renunciation, an ownership hand-over to a second key) and keeps trying to admit miners. Every
///      admission that succeeds is checked against the finality conditions at that moment.
contract FinalityHandler is Test {
    TapeoutMinerPool internal pool;
    TapeoutEntitlementReceipt internal nand;
    TapeoutEntitlementReceipt internal latch;
    TapeoutReceiptDistributor internal distributor;
    MockMining internal mining;
    MockNFT internal nft;
    address internal operator;
    address internal depositor;
    address internal second = makeAddr("second-key");

    bool public violation;
    uint256 public admissions;
    uint256 public refused;
    uint256 internal nextId = 1;
    mapping(bytes32 => uint256) public calls;

    constructor(
        TapeoutMinerPool pool_,
        TapeoutReceiptDistributor distributor_,
        MockMining mining_,
        MockNFT nft_,
        address operator_,
        address depositor_
    ) {
        pool = pool_;
        distributor = distributor_;
        nand = pool_.nandReceipt();
        latch = pool_.latchReceipt();
        mining = mining_;
        nft = nft_;
        operator = operator_;
        depositor = depositor_;
        vm.prank(depositor);
        nft.setApprovalForAll(address(pool), true);
    }

    /// @dev No transaction can come from the zero address, so a renounced owner acts no more (a prank
    ///      from address(0) would match Ownable's zero owner, which no real sender can).
    function _as(address who, address target, bytes memory data) internal returns (bool ok) {
        if (who == address(0)) return false;
        vm.prank(who);
        (ok,) = target.call(data);
    }

    function _owner(address target) internal view returns (address) {
        return TapeoutMinerPool(target).owner(); // Ownable's owner(), same selector on all four
    }

    function finalizeIssuance(bool latchSide) external {
        address r = latchSide ? address(latch) : address(nand);
        _as(_owner(r), r, abi.encodeWithSignature("finalizeIssuance()"));
        calls["finalizeIssuance"]++;
    }

    function finalizeAllocation() external {
        _as(
            _owner(address(distributor)),
            address(distributor),
            abi.encodeWithSignature("finalizeAllocation()")
        );
        calls["finalizeAllocation"]++;
    }

    function bind() external {
        _as(
            _owner(address(pool)), address(pool), abi.encodeCall(pool.bindDistributor, (address(distributor)))
        );
        calls["bind"]++;
    }

    function activate() external {
        _as(
            _owner(address(pool)),
            address(pool),
            abi.encodeCall(pool.activate, (nand.totalSupply(), latch.totalSupply()))
        );
        calls["activate"]++;
    }

    function renounce(uint8 which) external {
        address[4] memory targets = [address(nand), address(latch), address(distributor), address(pool)];
        address t = targets[which % 4];
        address current = _owner(t);
        if (current != address(0)) _as(current, t, abi.encodeWithSignature("renounceOwnership()"));
        calls["renounce"]++;
    }

    /// @dev A two-step hand-over to a second key: ownership that moves is still ownership.
    function handOver(uint8 which, bool accept) external {
        address[4] memory targets = [address(nand), address(latch), address(distributor), address(pool)];
        address t = targets[which % 4];
        address current = _owner(t);
        if (current == address(0)) return;
        address to = current == operator ? second : operator;
        _as(current, t, abi.encodeWithSignature("transferOwnership(address)", to));
        if (accept) _as(to, t, abi.encodeWithSignature("acceptOwnership()"));
        calls["handOver"]++;
    }

    /// @dev An operator following docs/OPERATIONS.md from wherever the system stands (steps that can no
    ///      longer succeed, e.g. after a premature renunciation, just fail).
    function followRunbook() external {
        _as(_owner(address(nand)), address(nand), abi.encodeWithSignature("finalizeIssuance()"));
        _as(_owner(address(latch)), address(latch), abi.encodeWithSignature("finalizeIssuance()"));
        _as(
            _owner(address(distributor)),
            address(distributor),
            abi.encodeWithSignature("finalizeAllocation()")
        );
        _as(
            _owner(address(pool)), address(pool), abi.encodeCall(pool.bindDistributor, (address(distributor)))
        );
        _as(
            _owner(address(pool)),
            address(pool),
            abi.encodeCall(pool.activate, (nand.totalSupply(), latch.totalSupply()))
        );
        address[4] memory targets = [address(nand), address(latch), address(distributor), address(pool)];
        for (uint256 i; i < 4; ++i) {
            _as(_owner(targets[i]), targets[i], abi.encodeWithSignature("renounceOwnership()"));
        }
        calls["followRunbook"]++;
    }

    function issueMore(bool latchSide) external {
        address r = latchSide ? address(latch) : address(nand);
        _as(_owner(r), r, abi.encodeWithSignature("issue(address,uint256)", _owner(r), uint256(1)));
        calls["issueMore"]++;
    }

    function tryAdmit(uint32 n, uint32 l, uint64 carry) external {
        if (nextId > 40) return;
        uint256 id = nextId++;
        nft.mint(depositor, id);
        mining.start(address(nft), id, uint32(bound(n, 1, 50)), uint32(bound(l, 0, 50)));
        mining.accrue(address(nft), id, bound(carry, 0, 1e12));
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        // Conditions as they stand right before the attempt.
        bool final_ = pool.active() && pool.owner() == address(0) && nand.owner() == address(0)
            && latch.owner() == address(0) && distributor.owner() == address(0) && nand.issuanceFinalized()
            && latch.issuanceFinalized() && distributor.allocationFinalized()
            && pool.distributor() == address(distributor) && nand.totalSupply() == pool.nandShares()
            && latch.totalSupply() == pool.latchShares();
        vm.prank(depositor);
        try pool.depositMiners(ids) {
            if (!final_) violation = true;
            ++admissions;
        } catch {
            if (final_) violation = true; // a fully initialized pool must admit an ACTIVE miner
            ++refused;
        }
    }
}

/// @notice Invariant 8 of the SALUS remediation: no admission succeeds before every finality condition
///         holds, whatever order the initialization steps run in; once custody is open it stays open
///         and the conditions stay true (they are irreversible). Also invariant 9: admissions keep
///         working with no owner anywhere.
contract SalusFinalityInvariantTest is SystemTestBase {
    FinalityHandler internal handler;

    function setUp() public override {
        super.setUp();
        issue(nandReceipt, alice, 3);
        issue(latchReceipt, address(distributor), 2);
        TapeoutReceiptDistributor.AllocationInput[] memory e =
            new TapeoutReceiptDistributor.AllocationInput[](1);
        e[0] =
            TapeoutReceiptDistributor.AllocationInput({category: LATCH, wallet: carol, firstId: 1, count: 2});
        vm.prank(operator);
        distributor.allocate(e);
        handler = new FinalityHandler(pool, distributor, mining, nft, operator, depositor);
        targetContract(address(handler));
    }

    function invariantNoAdmissionBeforeFinality() public view {
        assertFalse(
            handler.violation(), "an admission succeeded before finality, or a final pool refused one"
        );
        if (pool.minerCount() != 0 || pool.custodyOpen()) {
            assertTrue(pool.custodyOpen());
            assertTrue(pool.active());
            assertEq(pool.owner(), address(0));
            assertEq(nandReceipt.owner(), address(0));
            assertEq(latchReceipt.owner(), address(0));
            assertEq(distributor.owner(), address(0));
            assertTrue(nandReceipt.issuanceFinalized() && latchReceipt.issuanceFinalized());
            assertTrue(distributor.allocationFinalized());
            assertEq(nandReceipt.totalSupply(), pool.nandShares());
            assertEq(latchReceipt.totalSupply(), pool.latchShares());
        }
    }

    function invariantCustodyOpensOnlyWithItsFirstAdmission() public view {
        assertEq(pool.custodyOpen(), handler.admissions() != 0);
        assertEq(pool.minerCount(), handler.admissions());
    }

    /// @dev With FINALITY_COVERAGE_LOG set, each run appends "admissions,refused" so the report can show
    ///      both outcomes were exercised.
    function afterInvariant() external {
        string memory file = vm.envOr("FINALITY_COVERAGE_LOG", string(""));
        if (bytes(file).length == 0) return;
        vm.writeLine(
            file, string.concat(vm.toString(handler.admissions()), ",", vm.toString(handler.refused()))
        );
    }
}
