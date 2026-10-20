// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {DistributorTestBase} from "../helpers/DistributorTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {HistoricalDistributor} from "../../src/HistoricalDistributor.sol";

contract DistributorSetupTest is DistributorTestBase {
    address internal h1 = makeAddr("historical-1");
    address internal h2 = makeAddr("historical-2");
    address internal h3 = makeAddr("historical-3");

    function testDeploymentBindsPoolCategoryAndFixedList() public {
        (address[] memory a, uint96[] memory w) = sortedList(triple(h1, h2, h3), weights3(50, 30, 20));
        HistoricalDistributor d = new HistoricalDistributor(pool, NAND, a, w);
        assertEq(address(d.pool()), address(pool));
        assertEq(uint8(d.category()), uint8(NAND));
        assertEq(uint8(d.role()), uint8(TapeoutMinerPool.Recipient.HISTORICAL_NAND));
        assertEq(address(d.bem()), address(pool.bem()));
        assertEq(d.VERSION(), "HistoricalDistributor/1.0.0");
        assertEq(d.totalWeight(), 100);
        assertEq(d.contributorCount(), 3);
        assertEq(d.contributorsHash(), keccak256(abi.encode(a, w)));
        for (uint256 i; i < 3; ++i) {
            (address account, uint256 weight) = d.contributorAt(i);
            assertEq(account, a[i]);
            assertEq(weight, w[i]);
            assertEq(d.indexOf(account), i);
            assertEq(d.weightOf(account), w[i]);
            assertTrue(d.isContributor(account));
            assertEq(d.claimed(account), 0);
        }
        assertEq(d.totalAccounted(), 0);
        assertEq(d.totalPaid(), 0);

        HistoricalDistributor latchDist = newDistributor(LATCH, pair(h1, h2), weights2(1, 3));
        assertEq(uint8(latchDist.category()), uint8(LATCH));
        assertEq(uint8(latchDist.role()), uint8(TapeoutMinerPool.Recipient.HISTORICAL_LATCH));
        assertEq(latchDist.totalWeight(), 4);
    }

    function testCreationEventCarriesTheReviewedListHash() public {
        (address[] memory a, uint96[] memory w) = sortedList(pair(h1, h2), weights2(7, 9));
        vm.expectEmit(true, true, false, true);
        emit HistoricalDistributor.DistributorCreated(
            address(pool), LATCH, keccak256(abi.encode(a, w)), 2, 16
        );
        new HistoricalDistributor(pool, LATCH, a, w);
    }

    function testConstructorRejectsMalformedLists() public {
        (address[] memory a, uint96[] memory w) = sortedList(triple(h1, h2, h3), weights3(1, 2, 3));

        vm.expectRevert(abi.encodeWithSelector(HistoricalDistributor.InvalidContributorCount.selector, 0, 0));
        new HistoricalDistributor(pool, NAND, new address[](0), new uint96[](0));

        vm.expectRevert(abi.encodeWithSelector(HistoricalDistributor.InvalidContributorCount.selector, 3, 2));
        new HistoricalDistributor(pool, NAND, a, weights2(1, 2));

        // Unsorted: swap the first two entries.
        address[] memory unsorted = triple(a[1], a[0], a[2]);
        vm.expectRevert(abi.encodeWithSelector(HistoricalDistributor.ContributorsNotSorted.selector, 1, a[0]));
        new HistoricalDistributor(pool, NAND, unsorted, w);

        // Duplicate account.
        address[] memory duplicated = triple(a[0], a[1], a[1]);
        vm.expectRevert(abi.encodeWithSelector(HistoricalDistributor.ContributorsNotSorted.selector, 2, a[1]));
        new HistoricalDistributor(pool, NAND, duplicated, w);

        // The zero address can never be first in a strictly ascending list.
        address[] memory zeroFirst = triple(address(0), a[1], a[2]);
        vm.expectRevert(
            abi.encodeWithSelector(HistoricalDistributor.ContributorsNotSorted.selector, 0, address(0))
        );
        new HistoricalDistributor(pool, NAND, zeroFirst, w);

        vm.expectRevert(abi.encodeWithSelector(HistoricalDistributor.ZeroWeight.selector, 1, a[1]));
        new HistoricalDistributor(pool, NAND, a, weights3(1, 0, 3));
    }

    function testConstructorRejectsItselfAndThePoolAsContributors() public {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        (address[] memory a, uint96[] memory w) = sortedList(pair(h1, predicted), weights2(1, 1));
        uint256 selfIndex = a[0] == predicted ? 0 : 1;
        vm.expectRevert(
            abi.encodeWithSelector(HistoricalDistributor.InvalidContributor.selector, selfIndex, predicted)
        );
        new HistoricalDistributor(pool, NAND, a, w);

        (a, w) = sortedList(pair(h1, address(pool)), weights2(1, 1));
        uint256 poolIndex = a[0] == address(pool) ? 0 : 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                HistoricalDistributor.InvalidContributor.selector, poolIndex, address(pool)
            )
        );
        new HistoricalDistributor(pool, NAND, a, w);
    }

    function testConstructorRequiresARealPool() public {
        (address[] memory a, uint96[] memory w) = sortedList(pair(h1, h2), weights2(1, 1));
        vm.expectRevert(HistoricalDistributor.InvalidAddress.selector);
        new HistoricalDistributor(TapeoutMinerPool(makeAddr("not-a-contract")), NAND, a, w);
        // A contract without the pool interface reverts on the bem() read.
        vm.expectRevert();
        new HistoricalDistributor(TapeoutMinerPool(address(nft)), NAND, a, w);
    }

    function testContributorCountIsCappedAtMax() public {
        uint256 max = 400;
        address[] memory a = new address[](max + 1);
        uint96[] memory w = new uint96[](max + 1);
        for (uint256 i; i <= max; ++i) {
            a[i] = address(uint160(0x10000 + i));
            w[i] = 1;
        }
        vm.expectRevert(
            abi.encodeWithSelector(HistoricalDistributor.InvalidContributorCount.selector, max + 1, max + 1)
        );
        new HistoricalDistributor(pool, NAND, a, w);
        assembly {
            mstore(a, max)
            mstore(w, max)
        }
        HistoricalDistributor d = new HistoricalDistributor(pool, NAND, a, w);
        assertEq(d.contributorCount(), d.MAX_CONTRIBUTORS());
        assertEq(d.totalWeight(), max);
        assertEq(d.indexOf(address(uint160(0x10000 + 377))), 377);
    }

    /// @notice The suites run on Paris, which predates EIP-3860, so the initcode limit that
    ///         Shanghai-and-later chains (BSC included) enforce on the creation transaction is checked
    ///         here: code plus constructor arguments for a full list must stay within 49,152 bytes.
    function testFullListCreationFitsTheInitcodeLimit() public view {
        uint256 max = 400;
        address[] memory a = new address[](max);
        uint96[] memory w = new uint96[](max);
        for (uint256 i; i < max; ++i) {
            a[i] = address(uint160(type(uint160).max - max + i));
            w[i] = type(uint96).max / uint96(max);
        }
        uint256 initcode =
            type(HistoricalDistributor).creationCode.length + abi.encode(pool, NAND, a, w).length;
        assertLe(initcode, 49_152);
        assertEq(abi.encode(pool, NAND, a, w).length, 4 * 32 + 2 * 32 + 64 * max);
    }

    function testWeightsUseTheFullUint96Range() public {
        uint96 big = type(uint96).max;
        HistoricalDistributor d = newDistributor(NAND, triple(h1, h2, h3), weights3(big, big, 1));
        assertEq(d.totalWeight(), 2 * uint256(big) + 1);
        bem.mint(address(d), 1_000_000_007);
        d.claim(h3);
        d.claim(h1);
        assertEq(bem.balanceOf(h3), 0); // 1/(2^97-1) of the income rounds down to zero
        assertEq(bem.balanceOf(h1), uint256(1_000_000_007) * big / (2 * uint256(big) + 1));
        assertDistributorReconciled(d);
    }

    function testLookupAndPageViews() public {
        address[] memory accounts = contributors(7);
        uint96[] memory w = new uint96[](7);
        for (uint256 i; i < 7; ++i) {
            w[i] = uint96(i + 1);
        }
        HistoricalDistributor d = newDistributor(NAND, accounts, w);
        address outsider = makeAddr("outsider");
        assertFalse(d.isContributor(outsider));
        assertFalse(d.isContributor(address(0)));
        assertFalse(d.isContributor(address(type(uint160).max)));
        vm.expectRevert(abi.encodeWithSelector(HistoricalDistributor.NotContributor.selector, outsider));
        d.indexOf(outsider);
        vm.expectRevert(abi.encodeWithSelector(HistoricalDistributor.NotContributor.selector, outsider));
        d.weightOf(outsider);
        vm.expectRevert(abi.encodeWithSelector(HistoricalDistributor.NotContributor.selector, outsider));
        d.claimable(outsider);

        (address[] memory page, uint256[] memory weights, uint256[] memory claimedAmounts) =
            d.contributorsPage(5, 10);
        assertEq(page.length, 2);
        assertEq(weights.length, 2);
        assertEq(claimedAmounts.length, 2);
        (address account5,) = d.contributorAt(5);
        assertEq(page[0], account5);
        for (uint256 i = 1; i < 7; ++i) {
            (address prev,) = d.contributorAt(i - 1);
            (address cur,) = d.contributorAt(i);
            assertLt(uint160(prev), uint160(cur));
        }
        (page,,) = d.contributorsPage(7, 1);
        assertEq(page.length, 0);
        vm.expectRevert(HistoricalDistributor.InvalidPage.selector);
        d.contributorsPage(8, 1);
        vm.expectRevert(HistoricalDistributor.InvalidPage.selector);
        d.contributorsPage(0, 0);
        vm.expectRevert(HistoricalDistributor.InvalidPage.selector);
        d.contributorsPage(0, 501);
    }

    function testReleaseFromPoolRequiresTheRecipientRole() public {
        HistoricalDistributor d = newDistributor(NAND, pair(h1, h2), weights2(1, 1));
        setupDefault(); // historical recipients are plain accounts
        vm.expectRevert(abi.encodeWithSelector(HistoricalDistributor.NotPoolRecipient.selector, histNandTo));
        d.releaseFromPool();
        assertEq(d.pendingFromPool(), 0);
    }
}
