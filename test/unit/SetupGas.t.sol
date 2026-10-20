// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {console2} from "forge-std/console2.sol";
import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutReceiptDistributor} from "../../src/TapeoutReceiptDistributor.sol";

/// @notice The operator tooling sizes setup batches with the gas models in sdk/gas.ts. These tests check
///         that each model is an upper bound at the batch size the CLI plans, and that the CLI's default
///         delivery and claim batches fit the BSC per-transaction cap (BEP-652, 2^24 gas) within the 3/4
///         planning budget. Transaction gas = measured execution with the touched contracts cooled
///         + 21,000 + calldata (4/16 per zero/non-zero byte).
contract SetupGasTest is SystemTestBase {
    uint256 internal constant TX_GAS_CAP = 16_777_216;
    uint256 internal constant BATCH_GAS_BUDGET = TX_GAS_CAP * 3 / 4;
    // Mirrors of sdk/gas.ts.
    uint256 internal constant ISSUE_BASE = 100_000;
    uint256 internal constant ISSUE_PER_ID = 54_000;
    uint256 internal constant FUND_BASE = 100_000;
    uint256 internal constant FUND_PER_ID = 40_000;
    uint256 internal constant ALLOCATE_BASE = 60_000;
    uint256 internal constant ALLOCATE_PER_ID = 27_000;
    uint256 internal constant ALLOCATE_PER_RANGE = 120_000;
    // CLI defaults (cli/pool.ts): claim-receipts --max-ids 300, claim batches of 200 IDs.
    uint256 internal constant DELIVER_DEFAULT = 300;
    uint256 internal constant CLAIM_DEFAULT = 200;

    function _calldataGas(bytes memory data) internal pure returns (uint256 gas) {
        for (uint256 i; i < data.length; ++i) {
            gas += data[i] == 0 ? 4 : 16;
        }
    }

    function _txGas(address from, address target, bytes memory data) internal returns (uint256) {
        vm.cool(address(nandReceipt));
        vm.cool(address(latchReceipt));
        vm.cool(address(distributor));
        vm.cool(address(pool));
        vm.cool(address(bem));
        vm.prank(from);
        uint256 before = gasleft();
        (bool ok, bytes memory result) = target.call(data);
        uint256 used = before - gasleft();
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        return used + 21_000 + _calldataGas(data);
    }

    function _wallet(uint256 i) internal pure returns (address) {
        return address(uint160(0x10000 + i));
    }

    function testIssueBatchModelBoundsIssuingToTheOperatorAndToTheDistributor() public {
        uint256 n = (BATCH_GAS_BUDGET - ISSUE_BASE) / ISSUE_PER_ID; // CLI default batch
        uint256 model = ISSUE_BASE + n * ISSUE_PER_ID;
        uint256 toOperator =
            _txGas(operator, address(nandReceipt), abi.encodeCall(nandReceipt.issue, (operator, n)));
        // Issuing straight into the distributor also runs its receive hook for every ID.
        uint256 toDistributor = _txGas(
            operator, address(latchReceipt), abi.encodeCall(latchReceipt.issue, (address(distributor), n))
        );
        console2.log("issue batch", n);
        console2.log("  to operator", toOperator);
        console2.log("  to distributor", toDistributor);
        assertLe(toOperator, model);
        assertLe(toDistributor, model);
        assertLe(model, BATCH_GAS_BUDGET);
    }

    function testFundBatchModelBoundsMovingReceiptsIntoTheDistributor() public {
        uint256 n = (BATCH_GAS_BUDGET - FUND_BASE) / FUND_PER_ID;
        if (n > 300) n = 300; // CLI default is min(300, model)
        issue(nandReceipt, operator, n);
        uint256 used = _txGas(
            operator,
            address(nandReceipt),
            abi.encodeCall(
                nandReceipt.safeBatchTransferFrom, (operator, address(distributor), range(1, n), _ones(n), "")
            )
        );
        console2.log("fund batch", n, used);
        assertLe(used, FUND_BASE + n * FUND_PER_ID);
        assertLe(FUND_BASE + n * FUND_PER_ID, BATCH_GAS_BUDGET);
    }

    function testAllocationModelBoundsManySmallRangesAndOneLargeRange() public {
        uint256 ranges = (BATCH_GAS_BUDGET - ALLOCATE_BASE) / (ALLOCATE_PER_RANGE + ALLOCATE_PER_ID);
        issue(nandReceipt, address(distributor), ranges + 400);

        // Worst case for the batcher: single-ID ranges, each for a new wallet.
        TapeoutReceiptDistributor.AllocationInput[] memory small =
            new TapeoutReceiptDistributor.AllocationInput[](ranges);
        for (uint256 i; i < ranges; ++i) {
            small[i] = TapeoutReceiptDistributor.AllocationInput({
                category: NAND, wallet: _wallet(i), firstId: uint64(i + 1), count: 1
            });
        }
        uint256 smallGas =
            _txGas(operator, address(distributor), abi.encodeCall(distributor.allocate, (small)));
        uint256 smallModel = ALLOCATE_BASE + ranges * (ALLOCATE_PER_RANGE + ALLOCATE_PER_ID);

        // CLI default ID cap in one range.
        TapeoutReceiptDistributor.AllocationInput[] memory large =
            new TapeoutReceiptDistributor.AllocationInput[](1);
        large[0] = TapeoutReceiptDistributor.AllocationInput({
            category: NAND, wallet: alice, firstId: uint64(ranges + 1), count: 400
        });
        uint256 largeGas =
            _txGas(operator, address(distributor), abi.encodeCall(distributor.allocate, (large)));
        uint256 largeModel = ALLOCATE_BASE + ALLOCATE_PER_RANGE + 400 * ALLOCATE_PER_ID;

        console2.log("allocate ranges", ranges, smallGas, smallModel);
        console2.log("allocate 400 ids", largeGas, largeModel);
        assertLe(smallGas, smallModel);
        assertLe(largeGas, largeModel);
        assertLe(smallModel, BATCH_GAS_BUDGET);
        assertLe(largeModel, BATCH_GAS_BUDGET);
    }

    function testDefaultDeliveryAndClaimBatchesFitTheBudget() public {
        issue(nandReceipt, address(distributor), DELIVER_DEFAULT);
        TapeoutReceiptDistributor.AllocationInput[] memory e =
            new TapeoutReceiptDistributor.AllocationInput[](1);
        e[0] = TapeoutReceiptDistributor.AllocationInput({
            category: NAND, wallet: alice, firstId: 1, count: uint64(DELIVER_DEFAULT)
        });
        vm.startPrank(operator);
        distributor.allocate(e);
        nandReceipt.finalizeIssuance();
        latchReceipt.finalizeIssuance();
        distributor.finalizeAllocation();
        pool.activate(DELIVER_DEFAULT, 0);
        vm.stopPrank();
        admitNew(1, 40, 0);
        accrue(1, 1_000 * BEM_UNIT);
        pool.harvest(one(1));

        uint256 deliver =
            _txGas(alice, address(distributor), abi.encodeCall(distributor.claim, (DELIVER_DEFAULT)));
        uint256 claim =
            _txGas(alice, address(pool), abi.encodeCall(pool.claimBatch, (range(1, CLAIM_DEFAULT), none())));
        console2.log("deliver", DELIVER_DEFAULT, deliver);
        console2.log("claimBatch", CLAIM_DEFAULT, claim);
        assertGt(bem.balanceOf(alice), 0);
        assertLe(deliver, BATCH_GAS_BUDGET);
        assertLe(claim, BATCH_GAS_BUDGET);
    }

    function _ones(uint256 n) internal pure returns (uint256[] memory v) {
        v = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            v[i] = 1;
        }
    }
}
