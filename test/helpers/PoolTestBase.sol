// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutReceipt} from "../../src/TapeoutReceipt.sol";
import {PoolMath} from "../../src/PoolMath.sol";
import {MockNFT, MockBEM, MockMining} from "./Mocks.sol";

abstract contract PoolTestBase is Test {
    TapeoutMinerPool.Category internal constant NAND = TapeoutMinerPool.Category.NAND;
    TapeoutMinerPool.Category internal constant LATCH = TapeoutMinerPool.Category.LATCH;
    uint256 internal constant BEM_UNIT = 1e8;
    uint32 internal constant W = 100_000_000;

    TapeoutMinerPool internal pool;
    TapeoutReceipt internal nand;
    TapeoutReceipt internal latch;
    MockNFT internal nft;
    MockBEM internal bem;
    MockMining internal mining;

    address internal operator = makeAddr("operator");
    address internal feeTo = makeAddr("feeRecipient");
    address internal histNandTo = makeAddr("historicalNand");
    address internal histLatchTo = makeAddr("historicalLatch");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal reserve = makeAddr("reserve");

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        nft = new MockNFT();
        bem = new MockBEM();
        mining = new MockMining(bem);
        pool = deployPool(operator);
        nand = pool.nandReceipt();
        latch = pool.latchReceipt();
    }

    function deployPool(address owner) internal returns (TapeoutMinerPool) {
        return new TapeoutMinerPool(
            TapeoutMinerPool.Deployment({
                owner: owner,
                bem: address(bem),
                mining: address(mining),
                minerCollection: address(nft),
                poolName: "TapeOut Pool Test",
                nand: TapeoutMinerPool.ReceiptMetadata(
                    "TapeOut NAND Receipt", "tNAND", "ipfs://nand/{id}.json"
                ),
                latch: TapeoutMinerPool.ReceiptMetadata(
                    "TapeOut LATCH Receipt", "tLATCH", "ipfs://latch/{id}.json"
                )
            })
        );
    }

    function cfg(uint64 sN, uint64 sL, uint64 hN, uint64 hL, uint32 wN)
        internal
        view
        returns (TapeoutMinerPool.Config memory c)
    {
        c = TapeoutMinerPool.Config({
            nandShares: sN,
            latchShares: sL,
            historicalNandShares: hN,
            historicalLatchShares: hL,
            nandWeight: wN,
            feeRecipient: feeTo,
            historicalNandRecipient: hN == 0 ? address(0) : histNandTo,
            historicalLatchRecipient: hL == 0 ? address(0) : histLatchTo
        });
    }

    /// @dev Small default pool: NAND 1..5 alice, 6..9 bob; LATCH 1..2 alice, 3..4 carol.
    function defaultConfig() internal view returns (TapeoutMinerPool.Config memory) {
        return cfg(9, 4, 1, 1, 80_000_000);
    }

    function configure(TapeoutMinerPool.Config memory c) internal {
        vm.prank(operator);
        pool.configure(c);
    }

    function issueRange(TapeoutMinerPool.Category category, address to, uint256 first, uint256 count)
        internal
    {
        vm.prank(operator);
        pool.issueReceiptRange(category, to, first, count);
    }

    function activate() internal {
        bytes32 h = pool.currentConfigHash();
        vm.prank(operator);
        pool.activate(h);
    }

    /// @dev Configure, split each collection between two holders, and activate.
    function setupAndActivate(
        TapeoutMinerPool.Config memory c,
        address nandA,
        address nandB,
        address latchA,
        address latchB
    ) internal {
        configure(c);
        uint256 nandSplit = c.nandShares / 2 + c.nandShares % 2;
        uint256 latchSplit = c.latchShares / 2 + c.latchShares % 2;
        if (nandSplit != 0) issueRange(NAND, nandA, 1, nandSplit);
        if (c.nandShares > nandSplit) issueRange(NAND, nandB, nandSplit + 1, c.nandShares - nandSplit);
        if (latchSplit != 0) issueRange(LATCH, latchA, 1, latchSplit);
        if (c.latchShares > latchSplit) {
            issueRange(LATCH, latchB, latchSplit + 1, c.latchShares - latchSplit);
        }
        activate();
    }

    function setupDefault() internal {
        configure(defaultConfig());
        issueRange(NAND, alice, 1, 5);
        issueRange(NAND, bob, 6, 4);
        issueRange(LATCH, alice, 1, 2);
        issueRange(LATCH, carol, 3, 2);
        activate();
    }

    function newMiner(uint256 tokenId) internal {
        nft.mint(operator, tokenId);
        mining.start(address(nft), tokenId);
    }

    function depositMiners(uint256[] memory tokenIds) internal {
        vm.startPrank(operator);
        nft.setApprovalForAll(address(pool), true);
        pool.depositMiners(tokenIds);
        vm.stopPrank();
    }

    function newMinersDeposited(uint256 first, uint256 count) internal returns (uint256[] memory tokenIds) {
        tokenIds = range(first, first + count - 1);
        for (uint256 i; i < count; ++i) {
            newMiner(tokenIds[i]);
        }
        depositMiners(tokenIds);
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

    function none() internal pure returns (uint256[] memory r) {
        r = new uint256[](0);
    }

    /// @dev Asserts the ledger identity exposed by `reconciliation()` and its bucket sums.
    function assertReconciled() internal view {
        TapeoutMinerPool.Reconciliation memory r = pool.reconciliation();
        assertEq(r.deficit, 0, "deficit");
        uint256 outstanding = (r.feeAccrued - r.feePaid) + (r.nandReceiptsAccrued - r.nandReceiptsPaid)
            + (r.latchReceiptsAccrued - r.latchReceiptsPaid)
            + (r.historicalNandAccrued - r.historicalNandPaid)
            + (r.historicalLatchAccrued - r.historicalLatchPaid);
        assertEq(r.bemBalance, outstanding + r.residue + r.unrecognized, "balance identity");
        assertEq(
            r.totalPaid,
            r.feePaid + r.nandReceiptsPaid + r.latchReceiptsPaid + r.historicalNandPaid
                + r.historicalLatchPaid,
            "paid identity"
        );
        assertEq(
            r.totalAccounted,
            r.feeAccrued + r.nandReceiptsAccrued + r.latchReceiptsAccrued + r.historicalNandAccrued
                + r.historicalLatchAccrued + r.residue,
            "accrued identity"
        );
    }

    /// @dev Upper bound on retained rounding residue for a configuration.
    function residueBound(TapeoutMinerPool.Config memory c) internal pure returns (uint256 bound) {
        bound = 1;
        uint256 dN = uint256(c.nandShares) + c.historicalNandShares;
        uint256 dL = uint256(c.latchShares) + c.historicalLatchShares;
        if (dN != 0) bound += dN - 1;
        if (dL != 0) bound += dL - 1;
    }

    function accrualOf(uint256 total, TapeoutMinerPool.Config memory c)
        internal
        pure
        returns (PoolMath.Accrual memory)
    {
        return PoolMath.accrue(
            total,
            PoolMath.Shares(
                c.nandShares, c.latchShares, c.historicalNandShares, c.historicalLatchShares, c.nandWeight
            )
        );
    }
}
