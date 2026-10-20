// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {DistributorTestBase} from "../helpers/DistributorTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutReceipt} from "../../src/TapeoutReceipt.sol";
import {HistoricalDistributor} from "../../src/HistoricalDistributor.sol";
import {MockBEM, MockMining, MockNFT} from "../helpers/Mocks.sol";

contract DistributorHandler is Test {
    TapeoutMinerPool internal pool;
    MockBEM internal bem;
    MockMining internal mining;
    MockNFT internal nft;
    HistoricalDistributor[2] internal dists; // indexed by category
    uint256 internal minerCount;

    mapping(address distributor => uint256 amount) public donated;
    mapping(address account => uint256 amount) public lastEntitlement;
    bool public monotonic = true;
    mapping(bytes32 => uint256) public calls;

    constructor(
        TapeoutMinerPool pool_,
        MockBEM bem_,
        MockMining mining_,
        MockNFT nft_,
        HistoricalDistributor nandDist,
        HistoricalDistributor latchDist,
        uint256 minerCount_
    ) {
        pool = pool_;
        bem = bem_;
        mining = mining_;
        nft = nft_;
        dists[0] = nandDist;
        dists[1] = latchDist;
        minerCount = minerCount_;
    }

    function accrue(uint256 minerSeed, uint64 amount, bool hiddenFromPending) external {
        uint256 tokenId = bound(minerSeed, 1, minerCount);
        uint256 value = bound(amount, 0, 5e9);
        if (hiddenFromPending) mining.accrueUnsettled(address(nft), tokenId, value);
        else mining.accrue(address(nft), tokenId, value);
        calls["accrue"]++;
    }

    function harvest(uint256 start, uint256 count) external {
        pool.harvestRange(bound(start, 0, minerCount - 1), bound(count, 1, minerCount));
        calls["harvest"]++;
    }

    function donateToPool(uint64 amount) external {
        bem.mint(address(pool), bound(amount, 0, 1e9));
        calls["donatePool"]++;
    }

    function donateToDistributor(bool latchSide, uint32 amount) external {
        HistoricalDistributor d = dists[latchSide ? 1 : 0];
        uint256 value = bound(amount, 0, 1e6);
        bem.mint(address(d), value);
        donated[address(d)] += value;
        calls["donateDistributor"]++;
    }

    /// @dev The pool's own permissionless release (no distributor call).
    function releaseViaPool(bool latchSide) external {
        pool.releaseHistorical(latchSide ? TapeoutMinerPool.Category.LATCH : TapeoutMinerPool.Category.NAND);
        calls["releaseViaPool"]++;
    }

    function releaseViaDistributor(bool latchSide) external {
        dists[latchSide ? 1 : 0].releaseFromPool();
        _observe();
        calls["releaseViaDistributor"]++;
    }

    function sync(bool latchSide) external {
        dists[latchSide ? 1 : 0].sync();
        _observe();
        calls["sync"]++;
    }

    function claim(bool latchSide, uint256 accountSeed, address caller) external {
        HistoricalDistributor d = dists[latchSide ? 1 : 0];
        (address account,) = d.contributorAt(bound(accountSeed, 0, d.contributorCount() - 1));
        vm.prank(caller);
        d.claim(account);
        _observe();
        calls["claim"]++;
    }

    function claimBatch(bool latchSide, uint256 seed) external {
        HistoricalDistributor d = dists[latchSide ? 1 : 0];
        uint256 n = d.contributorCount();
        uint256 size = bound(seed, 1, 2 * n); // duplicates are likely
        address[] memory batch = new address[](size);
        for (uint256 i; i < size; ++i) {
            (batch[i],) = d.contributorAt(uint256(keccak256(abi.encode(seed, i))) % n);
        }
        d.claimBatch(batch);
        _observe();
        calls["claimBatch"]++;
    }

    function claimRange(bool latchSide, uint256 start, uint256 count) external {
        HistoricalDistributor d = dists[latchSide ? 1 : 0];
        uint256 n = d.contributorCount();
        d.claimRange(bound(start, 0, n - 1), bound(count, 1, n + 2));
        _observe();
        calls["claimRange"]++;
    }

    /// @dev Receipt holders claim from the pool too, so every pool bucket moves during the campaign.
    function claimReceipt(bool latchSide, uint256 idSeed) external {
        TapeoutMinerPool.Category category =
            latchSide ? TapeoutMinerPool.Category.LATCH : TapeoutMinerPool.Category.NAND;
        uint256 id = bound(idSeed, 1, pool.shareCount(category));
        TapeoutReceipt receipt = pool.receiptOf(category);
        vm.prank(receipt.holderOf(id));
        pool.claim(category, id);
        calls["claimReceipt"]++;
    }

    function _observe() internal {
        for (uint256 k; k < 2; ++k) {
            HistoricalDistributor d = dists[k];
            uint256 n = d.contributorCount();
            for (uint256 i; i < n; ++i) {
                (address account,) = d.contributorAt(i);
                uint256 e = d.entitlementOf(account);
                if (e < lastEntitlement[account]) monotonic = false;
                lastEntitlement[account] = e;
            }
        }
    }
}

/// @notice Two distributors (NAND and LATCH) are the pool's historical recipients from activation.
///         Contributors receive BEM only from their distributor, so their balances are an
///         independent record of what each distributor paid.
contract DistributorInvariantTest is DistributorTestBase {
    DistributorHandler internal handler;
    HistoricalDistributor internal nandDist;
    HistoricalDistributor internal latchDist;
    address internal dave = makeAddr("dave");
    TapeoutMinerPool.Config internal config;
    uint256 internal constant MINERS = 4;

    function setUp() public override {
        super.setUp();
        address[] memory nandAccounts = contributors(5);
        uint96[] memory nandWeights = new uint96[](5);
        (nandWeights[0], nandWeights[1], nandWeights[2], nandWeights[3], nandWeights[4]) =
            (1, 2, type(uint96).max / 3, 12_345, 7);
        nandDist = newDistributor(NAND, nandAccounts, nandWeights);
        address[] memory latchAccounts = triple(makeAddr("latch-a"), makeAddr("latch-b"), makeAddr("latch-c"));
        latchDist = newDistributor(LATCH, latchAccounts, weights3(3, 1, 1));

        config = cfg(13, 7, 3, 2, 61_803_399);
        config.historicalNandRecipient = address(nandDist);
        config.historicalLatchRecipient = address(latchDist);
        setupAndActivate(config, alice, bob, carol, dave);
        newMinersDeposited(1, MINERS);
        handler = new DistributorHandler(pool, bem, mining, nft, nandDist, latchDist, MINERS);
        targetContract(address(handler));
    }

    function _dists() internal view returns (HistoricalDistributor[2] memory) {
        return [nandDist, latchDist];
    }

    /// @notice Every unit a distributor received is held or paid: balance + totalPaid equals what
    ///         the pool released to it plus direct transfers, and contributors hold exactly totalPaid.
    function invariantBemConservation() public view {
        HistoricalDistributor[2] memory ds = _dists();
        for (uint256 k; k < 2; ++k) {
            HistoricalDistributor d = ds[k];
            uint256 received = pool.historicalPaid(TapeoutMinerPool.Category(k)) + handler.donated(address(d));
            assertEq(bem.balanceOf(address(d)) + d.totalPaid(), received, "distributor conservation");
            assertEq(d.totalAccounted() + d.unrecognizedBalance(), received, "recognized + unrecognized");
            uint256 held;
            for (uint256 i; i < d.contributorCount(); ++i) {
                (address account,) = d.contributorAt(i);
                held += bem.balanceOf(account);
            }
            assertEq(held, d.totalPaid(), "contributors hold exactly what was paid");
        }
    }

    /// @notice No contributor is ever paid more than floor(totalAccounted * w / W).
    function invariantNoOverpayment() public view {
        HistoricalDistributor[2] memory ds = _dists();
        for (uint256 k; k < 2; ++k) {
            HistoricalDistributor d = ds[k];
            uint256 sum;
            for (uint256 i; i < d.contributorCount(); ++i) {
                (address account, uint256 weight) = d.contributorAt(i);
                uint256 entitled = Math.mulDiv(d.totalAccounted(), weight, d.totalWeight());
                assertLe(d.claimed(account), entitled, "overpaid");
                assertEq(bem.balanceOf(account), d.claimed(account), "history equals payouts");
                sum += d.claimed(account);
            }
            assertEq(sum, d.totalPaid());
            assertLe(d.totalPaid(), d.totalAccounted());
        }
    }

    function invariantLedgersReconcile() public view {
        assertDistributorReconciled(nandDist);
        assertDistributorReconciled(latchDist);
        assertReconciled();
    }

    function invariantEntitlementsNeverDecrease() public view {
        assertTrue(handler.monotonic());
    }

    function afterInvariant() external view {
        assertGt(
            handler.calls("accrue") + handler.calls("donatePool") + handler.calls("donateDistributor"), 0
        );
    }
}
