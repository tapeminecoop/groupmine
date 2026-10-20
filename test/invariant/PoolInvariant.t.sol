// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PoolTestBase} from "../helpers/PoolTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutReceipt} from "../../src/TapeoutReceipt.sol";
import {PoolMath} from "../../src/PoolMath.sol";
import {MockBEM, MockMining, MockNFT} from "../helpers/Mocks.sol";

contract PoolHandler is Test {
    TapeoutMinerPool internal pool;
    MockBEM internal bem;
    MockMining internal mining;
    MockNFT internal nft;
    address[] internal actors;
    address[] internal recipients;
    uint256 internal minerCount;

    uint256 public lastPerNand;
    uint256 public lastPerLatch;
    bool public monotonic = true;
    mapping(bytes32 => uint256) public calls;

    constructor(
        TapeoutMinerPool pool_,
        MockBEM bem_,
        MockMining mining_,
        MockNFT nft_,
        address[] memory actors_,
        address[] memory recipients_,
        uint256 minerCount_
    ) {
        pool = pool_;
        bem = bem_;
        mining = mining_;
        nft = nft_;
        actors = actors_;
        recipients = recipients_;
        minerCount = minerCount_;
    }

    function accrue(uint256 minerSeed, uint64 amount, bool hiddenFromPending) external {
        uint256 tokenId = bound(minerSeed, 1, minerCount);
        uint256 value = bound(amount, 0, 5e9);
        if (hiddenFromPending) mining.accrueUnsettled(address(nft), tokenId, value);
        else mining.accrue(address(nft), tokenId, value);
        calls["accrue"]++;
    }

    function harvestSome(uint256 seed) external {
        uint256 count = bound(seed, 1, minerCount);
        uint256[] memory ids = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = bound(uint256(keccak256(abi.encode(seed, i))), 1, minerCount);
        }
        pool.harvest(ids);
        _observe();
        calls["harvest"]++;
    }

    function harvestRange(uint256 start, uint256 count) external {
        start = bound(start, 0, minerCount - 1);
        count = bound(count, 1, minerCount);
        pool.harvestRange(start, count);
        _observe();
        calls["harvestRange"]++;
    }

    function donate(uint64 amount) external {
        bem.mint(address(pool), bound(amount, 0, 1e9));
        calls["donate"]++;
    }

    function thirdPartyMiningClaim(uint256 minerSeed) external {
        uint256 tokenId = bound(minerSeed, 1, minerCount);
        bytes32 key = mining.minerKey(address(nft), tokenId);
        vm.prank(address(0xD00D));
        mining.claim(key);
        calls["thirdPartyClaim"]++;
    }

    function claim(uint256 actorSeed, uint256 seed) external {
        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        uint256[] memory nandIds = _held(TapeoutMinerPool.Category.NAND, actor, seed);
        uint256[] memory latchIds = _held(TapeoutMinerPool.Category.LATCH, actor, seed >> 128);
        if (nandIds.length == 0 && latchIds.length == 0) return;
        vm.prank(actor);
        pool.claimBatch(nandIds, latchIds);
        _observe();
        calls["claim"]++;
    }

    function claimOne(bool latchCategory, uint256 idSeed) external {
        TapeoutMinerPool.Category category =
            latchCategory ? TapeoutMinerPool.Category.LATCH : TapeoutMinerPool.Category.NAND;
        uint256 id = bound(idSeed, 1, pool.shareCount(category));
        address holder = pool.receiptOf(category).holderOf(id);
        vm.prank(holder);
        pool.claim(category, id);
        _observe();
        calls["claimOne"]++;
    }

    function transferReceipt(bool latchCategory, uint256 idSeed, uint256 toSeed) external {
        TapeoutMinerPool.Category category =
            latchCategory ? TapeoutMinerPool.Category.LATCH : TapeoutMinerPool.Category.NAND;
        TapeoutReceipt receipt = pool.receiptOf(category);
        uint256 id = bound(idSeed, 1, pool.shareCount(category));
        address from = receipt.holderOf(id);
        address to = actors[bound(toSeed, 0, actors.length - 1)];
        vm.prank(from);
        receipt.safeTransferFrom(from, to, id, 1, "");
        calls["transfer"]++;
    }

    function releaseFee() external {
        pool.releaseFee();
        calls["releaseFee"]++;
    }

    function releaseHistorical(bool latchCategory) external {
        pool.releaseHistorical(
            latchCategory ? TapeoutMinerPool.Category.LATCH : TapeoutMinerPool.Category.NAND
        );
        calls["releaseHistorical"]++;
    }

    function rotateRecipient(uint8 roleSeed, uint256 toSeed) external {
        TapeoutMinerPool.Recipient role = TapeoutMinerPool.Recipient(bound(roleSeed, 0, 2));
        address current = pool.recipientOf(role);
        address next = recipients[bound(toSeed, 0, recipients.length - 1)];
        vm.prank(current);
        pool.setRecipient(role, next);
        calls["rotate"]++;
    }

    function _held(TapeoutMinerPool.Category category, address actor, uint256 seed)
        internal
        view
        returns (uint256[] memory ids)
    {
        TapeoutReceipt receipt = pool.receiptOf(category);
        uint256 shares = pool.shareCount(category);
        uint256[] memory tmp = new uint256[](shares);
        uint256 n;
        for (uint256 id = 1; id <= shares; ++id) {
            if (receipt.holderOf(id) == actor && (seed >> (id % 200)) & 1 == 1) tmp[n++] = id;
        }
        ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = tmp[i];
        }
    }

    function _observe() internal {
        PoolMath.Accrual memory a = pool.accrual();
        if (a.perNandShare < lastPerNand || a.perLatchShare < lastPerLatch) monotonic = false;
        lastPerNand = a.perNandShare;
        lastPerLatch = a.perLatchShare;
    }
}

contract PoolInvariantTest is PoolTestBase {
    PoolHandler internal handler;
    address internal dave = makeAddr("dave");
    address[] internal actorList;
    address[] internal recipientList;
    TapeoutMinerPool.Config internal config;
    uint256 internal constant MINERS = 6;

    function setUp() public override {
        super.setUp();
        config = cfg(13, 7, 3, 2, 61_803_399);
        setupAndActivate(config, alice, bob, carol, dave);
        newMinersDeposited(1, MINERS);
        actorList.push(alice);
        actorList.push(bob);
        actorList.push(carol);
        actorList.push(dave);
        recipientList.push(feeTo);
        recipientList.push(histNandTo);
        recipientList.push(histLatchTo);
        recipientList.push(makeAddr("r1"));
        recipientList.push(makeAddr("r2"));
        handler = new PoolHandler(pool, bem, mining, nft, actorList, recipientList, MINERS);
        targetContract(address(handler));
    }

    /// @notice Every BEM unit that ever existed went to the pool first; the pool holds what it
    ///         has not paid, and every payout reached a known holder or recipient.
    function invariantBemConservation() public view {
        assertEq(bem.balanceOf(address(pool)) + pool.totalPaid(), bem.totalSupply());
        uint256 paidOut;
        for (uint256 i; i < actorList.length; ++i) {
            paidOut += bem.balanceOf(actorList[i]);
        }
        for (uint256 i; i < recipientList.length; ++i) {
            paidOut += bem.balanceOf(recipientList[i]);
        }
        assertEq(paidOut, pool.totalPaid());
        assertLe(pool.totalAccounted(), bem.totalSupply());
    }

    function invariantLedgerReconciles() public view {
        assertReconciled();
        PoolMath.Accrual memory a = pool.accrual();
        assertLe(a.residue, residueBound(config));
        assertLe(pool.feePaid(), a.fee);
        assertLe(pool.historicalPaid(NAND), a.historicalNand);
        assertLe(pool.historicalPaid(LATCH), a.historicalLatch);
    }

    /// @notice Per-ID claim histories never exceed the cumulative per-share income and sum to
    ///         exactly what was paid to receipt holders in each collection.
    function invariantPerIdHistoriesSumToPaid() public view {
        PoolMath.Accrual memory a = pool.accrual();
        uint256 nandSum;
        for (uint256 id = 1; id <= config.nandShares; ++id) {
            uint256 c = pool.claimed(NAND, id);
            assertLe(c, a.perNandShare);
            nandSum += c;
            assertEq(nand.totalSupply(id), 1);
        }
        uint256 latchSum;
        for (uint256 id = 1; id <= config.latchShares; ++id) {
            uint256 c = pool.claimed(LATCH, id);
            assertLe(c, a.perLatchShare);
            latchSum += c;
            assertEq(latch.totalSupply(id), 1);
        }
        assertEq(nandSum, pool.receiptsPaid(NAND));
        assertEq(latchSum, pool.receiptsPaid(LATCH));
        assertEq(nand.totalSupply(), config.nandShares);
        assertEq(latch.totalSupply(), config.latchShares);
    }

    function invariantPerShareIncomeNeverDecreases() public view {
        assertTrue(handler.monotonic());
    }

    function invariantMinersStayInCustody() public view {
        for (uint256 tokenId = 1; tokenId <= MINERS; ++tokenId) {
            assertEq(nft.ownerOf(tokenId), address(pool));
        }
    }

    function afterInvariant() external view {
        // Make sure the campaign exercised the economically relevant paths.
        assertGt(handler.calls("accrue") + handler.calls("donate"), 0);
    }
}
