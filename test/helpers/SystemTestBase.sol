// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutEntitlementReceipt} from "../../src/TapeoutEntitlementReceipt.sol";
import {TapeoutReceiptDistributor} from "../../src/TapeoutReceiptDistributor.sol";
import {PoolMath} from "../../src/PoolMath.sol";
import {MockNFT, MockBEM, MockMining} from "./Mocks.sol";

abstract contract SystemTestBase is Test {
    TapeoutMinerPool.Category internal constant NAND = TapeoutMinerPool.Category.NAND;
    TapeoutMinerPool.Category internal constant LATCH = TapeoutMinerPool.Category.LATCH;
    bytes32 internal constant NAND_CATEGORY = keccak256("TAPEOUT_NAND_ENTITLEMENT");
    bytes32 internal constant LATCH_CATEGORY = keccak256("TAPEOUT_LATCH_ENTITLEMENT");
    uint256 internal constant BEM_UNIT = 1e8;

    MockNFT internal nft;
    MockBEM internal bem;
    MockMining internal mining;
    TapeoutEntitlementReceipt internal nandReceipt;
    TapeoutEntitlementReceipt internal latchReceipt;
    TapeoutMinerPool internal pool;
    TapeoutReceiptDistributor internal distributor;

    address internal operator = makeAddr("operator");
    address internal depositor = makeAddr("depositor");
    address internal depositor2 = makeAddr("depositor2");
    address internal recipientA = makeAddr("recipientA");
    address internal recipientB = makeAddr("recipientB");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        nft = new MockNFT();
        bem = new MockBEM();
        mining = new MockMining(bem);
        nandReceipt =
            new TapeoutEntitlementReceipt(NAND_CATEGORY, "TapeOut NAND Entitlement", "tNAND", "", operator);
        latchReceipt = new TapeoutEntitlementReceipt(
            LATCH_CATEGORY, "TapeOut LATCH Entitlement", "tLATCH", "", operator
        );
        pool = deployPool(whitelist());
        distributor = new TapeoutReceiptDistributor(operator, pool);
    }

    function whitelist() internal view returns (address[] memory list) {
        list = new address[](2);
        list[0] = depositor;
        list[1] = depositor2;
    }

    function deployment(address[] memory depositors)
        internal
        view
        returns (TapeoutMinerPool.Deployment memory)
    {
        return TapeoutMinerPool.Deployment({
            owner: operator,
            bem: address(bem),
            mining: address(mining),
            minerCollection: address(nft),
            nandReceipt: address(nandReceipt),
            latchReceipt: address(latchReceipt),
            recipientA: recipientA,
            recipientB: recipientB,
            depositors: depositors,
            poolName: "TapeOut Pool Test"
        });
    }

    function deployPool(address[] memory depositors) internal returns (TapeoutMinerPool) {
        return new TapeoutMinerPool(deployment(depositors));
    }

    function issue(TapeoutEntitlementReceipt receipt, address to, uint256 count) internal {
        vm.startPrank(operator);
        while (count > 0) {
            uint256 n = count > 500 ? 500 : count;
            receipt.issue(to, n);
            count -= n;
        }
        vm.stopPrank();
    }

    function finalizeIssuance() internal {
        vm.startPrank(operator);
        nandReceipt.finalizeIssuance();
        latchReceipt.finalizeIssuance();
        vm.stopPrank();
    }

    /// @dev The 2.2.0 initialization: bind the distributor, finalize its allocation, activate, then every
    ///      owner renounces (custody, i.e. the first admission, requires all of it). Receipts the test
    ///      put into the distributor must be allocated before this.
    function activate() internal {
        activateKeepingOwners();
        renounceAll();
    }

    /// @dev Bind, finalize the allocation and activate; owners are kept (admissions stay closed).
    function activateKeepingOwners() internal {
        uint256 sN = nandReceipt.totalSupply();
        uint256 sL = latchReceipt.totalSupply();
        vm.startPrank(operator);
        if (pool.distributor() == address(0)) pool.bindDistributor(address(distributor));
        if (!distributor.allocationFinalized()) distributor.finalizeAllocation();
        pool.activate(sN, sL);
        vm.stopPrank();
    }

    /// @dev Both receipt collections, the distributor and the pool renounce ownership (those not yet).
    function renounceAll() internal {
        vm.startPrank(operator);
        if (nandReceipt.owner() == operator) nandReceipt.renounceOwnership();
        if (latchReceipt.owner() == operator) latchReceipt.renounceOwnership();
        if (distributor.owner() == operator) distributor.renounceOwnership();
        if (pool.owner() == operator) pool.renounceOwnership();
        vm.stopPrank();
    }

    /// @dev S_N = 10 (alice 1..5, bob 6..10), S_L = 10 (alice 1..5, carol 6..10); finalized, active,
    ///      every owner renounced.
    function setupStandard() internal {
        issue(nandReceipt, alice, 5);
        issue(nandReceipt, bob, 5);
        issue(latchReceipt, alice, 5);
        issue(latchReceipt, carol, 5);
        finalizeIssuance();
        activate();
    }

    function newMiner(uint256 tokenId, uint32 nand, uint32 latch) internal {
        newMinerFor(depositor, tokenId, nand, latch);
    }

    function newMinerFor(address owner, uint256 tokenId, uint32 nand, uint32 latch) internal {
        nft.mint(owner, tokenId);
        mining.start(address(nft), tokenId, nand, latch);
    }

    function admitAs(address who, uint256[] memory tokenIds)
        internal
        returns (uint256 settled, uint256 carried)
    {
        vm.startPrank(who);
        nft.setApprovalForAll(address(pool), true);
        (settled, carried) = pool.depositMiners(tokenIds);
        vm.stopPrank();
    }

    function admit(uint256[] memory tokenIds) internal returns (uint256 settled, uint256 carried) {
        return admitAs(depositor, tokenIds);
    }

    function admitNew(uint256 tokenId, uint32 nand, uint32 latch)
        internal
        returns (uint256 settled, uint256 carried)
    {
        newMiner(tokenId, nand, latch);
        return admit(one(tokenId));
    }

    function accrue(uint256 tokenId, uint256 amount) internal {
        mining.accrue(address(nft), tokenId, amount);
    }

    function claimAs(address who, uint256[] memory nandIds, uint256[] memory latchIds)
        internal
        returns (uint256)
    {
        vm.prank(who);
        return pool.claimBatch(nandIds, latchIds);
    }

    function range(uint256 first, uint256 last) internal pure returns (uint256[] memory r) {
        r = new uint256[](last - first + 1);
        for (uint256 i; i < r.length; ++i) {
            r[i] = first + i;
        }
    }

    function one(uint256 x) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = x;
    }

    function two(uint256 x, uint256 y) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = x;
        r[1] = y;
    }

    function none() internal pure returns (uint256[] memory r) {
        r = new uint256[](0);
    }

    /// @dev The ledger identities from docs/ACCOUNTING.md, with A, B and C (the sink) as separate accounts.
    function assertReconciled() internal view {
        TapeoutMinerPool.Reconciliation memory r = pool.reconciliation();
        assertEq(r.deficit, 0, "deficit");
        uint256 outstanding = (r.recipientAAccrued - r.recipientAPaid)
            + (r.recipientBAccrued - r.recipientBPaid) + (r.sinkAccrued - r.sinkPaid)
            + (r.nandReceiptsAccrued - r.nandReceiptsPaid) + (r.latchReceiptsAccrued - r.latchReceiptsPaid);
        assertEq(r.bemBalance, outstanding + r.residue + r.unrecognized, "balance identity");
        assertEq(
            r.totalPaid,
            r.recipientAPaid + r.recipientBPaid + r.sinkPaid + r.nandReceiptsPaid + r.latchReceiptsPaid,
            "paid identity"
        );
        assertEq(
            r.totalAccounted,
            r.recipientAAccrued + r.recipientBAccrued + r.sinkAccrued + r.nandReceiptsAccrued
                + r.latchReceiptsAccrued + r.residue,
            "accrued identity"
        );
        assertEq(r.recipientAAccrued, r.recipientBAccrued, "A and B accrue identically");
        assertEq(r.recipientAAccrued, r.totalAccounted / 84, "A accrues floor(T / 84)");
        assertEq(r.sinkAccrued, r.totalAccounted * 2 / 84, "C accrues floor(2T / 84)");
        assertLe(r.sinkPaid, r.sinkAccrued, "C never overpaid");
        assertLe(r.residue, residueBound(), "residue bound");
    }

    /// @dev 3 (outer floors: r - floor(2r/84) - floor(80r/84) <= 3 for r = T mod 84) + 1 (category
    ///      floors) + (S_N - 1) + (S_L - 1).
    function residueBound() internal view returns (uint256 bound) {
        bound = 4;
        uint256 sN = pool.nandShares();
        uint256 sL = pool.latchShares();
        if (sN != 0) bound += sN - 1;
        if (sL != 0) bound += sL - 1;
    }
}
