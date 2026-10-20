// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {console2} from "forge-std/console2.sol";
import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutEntitlementReceipt} from "../../src/TapeoutEntitlementReceipt.sol";
import {TapeoutReceiptDistributor} from "../../src/TapeoutReceiptDistributor.sol";

/// @dev Creates a contract from initcode, so a deployment can be given an exact gas limit.
contract Deployer {
    function deploy(bytes calldata init) external returns (address deployed) {
        bytes memory code = init;
        assembly {
            deployed := create(0, add(code, 0x20), mload(code))
        }
        require(deployed != address(0), "deployment failed");
    }
}

/// @notice The CLI gives every planned transaction a worst-case gas bound from sdk/gas.ts, uses it as the
///         transaction's gas limit, and refuses plans above 3/4 of the BSC per-transaction cap (BEP-652,
///         2^24 gas). Each test here runs the call as its own transaction (isolation) with exactly the
///         bound minus the intrinsic cost (21,000 + calldata) as gas: success shows a transaction with
///         that gas limit succeeds, refunds included. Logged values are the gas each transaction used.
///         Admission and harvest run the real Mining contract and are checked on the BSC fork instead.
/// forge-config: default.isolate = true
contract GasModelTest is SystemTestBase {
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
    uint256 internal constant REVOKE_BASE = 100_000;
    uint256 internal constant REVOKE_PER_ID = 8_000;
    uint256 internal constant REVOKE_PER_RANGE = 30_000;
    uint256 internal constant DELIVER_BASE = 100_000;
    uint256 internal constant DELIVER_PER_ID = 37_000;
    uint256 internal constant DELIVER_PER_RANGE = 100_000;
    uint256 internal constant CLAIM_BASE = 200_000;
    uint256 internal constant CLAIM_PER_ID = 32_000;
    uint256 internal constant DEPLOY_RECEIPT = 3_000_000;
    uint256 internal constant DEPLOY_POOL = 6_000_000;
    uint256 internal constant DEPLOY_DISTRIBUTOR = 2_500_000;
    uint256 internal constant CALL_FINALIZE_ISSUANCE = 100_000;
    uint256 internal constant CALL_FINALIZE_ALLOCATION = 150_000;
    uint256 internal constant CALL_ACTIVATE = 250_000;
    uint256 internal constant CALL_RELEASE = 250_000;
    uint256 internal constant CALL_SET_RECIPIENT = 150_000;
    uint256 internal constant CALL_RENOUNCE = 100_000;
    uint256 internal constant CALL_APPROVE = 150_000;
    // CLI default delivery size (claim-receipts / deliver --max-ids).
    uint256 internal constant DELIVER_DEFAULT = 300;

    function _calldataGas(bytes memory data) internal pure returns (uint256 gas) {
        for (uint256 i; i < data.length; ++i) {
            gas += data[i] == 0 ? 4 : 16;
        }
    }

    /// @dev Sends `data` from `from` as a transaction whose gas limit is `bound`; reverts (with the call's
    ///      revert data, or empty on out-of-gas) if it does not fit. Returns the gas the transaction used.
    function _within(address from, address target, bytes memory data, uint256 bound)
        internal
        returns (uint256 used)
    {
        uint256 intrinsic = 21_000 + _calldataGas(data);
        assertLe(bound, BATCH_GAS_BUDGET, "bound above the planning budget");
        vm.prank(from);
        uint256 before = gasleft();
        (bool ok, bytes memory result) = target.call{gas: bound - intrinsic}(data);
        used = before - gasleft();
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    /// @dev A creation transaction with gas limit `bound` (the CREATE opcode charges what a creation
    ///      transaction adds to the intrinsic 21,000 + calldata; the helper's call overhead and the 63/64
    ///      rule only make the check stricter).
    function _deployWithin(bytes memory init, uint256 bound) internal returns (uint256 used) {
        Deployer deployer = new Deployer();
        bytes memory data = abi.encodeCall(Deployer.deploy, (init));
        uint256 intrinsic = 21_000 + _calldataGas(init);
        uint256 before = gasleft();
        (bool ok,) = address(deployer).call{gas: bound - intrinsic}(data);
        used = before - gasleft();
        require(ok, "deployment does not fit its bound");
    }

    function _wallet(uint256 i) internal pure returns (address) {
        return address(uint160(0x10000 + i));
    }

    function _entry(address wallet, uint256 firstId, uint256 count)
        internal
        pure
        returns (TapeoutReceiptDistributor.AllocationInput memory)
    {
        return TapeoutReceiptDistributor.AllocationInput({
            category: NAND, wallet: wallet, firstId: uint64(firstId), count: uint64(count)
        });
    }

    function _allocate(TapeoutReceiptDistributor.AllocationInput[] memory entries) internal {
        vm.prank(operator);
        distributor.allocate(entries);
    }

    function _ones(uint256 n) internal pure returns (uint256[] memory v) {
        v = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            v[i] = 1;
        }
    }

    /// @dev Guards the method: without isolation, writes earlier in the test would make later
    ///      transactions look cheaper than they are.
    function testCallsRunAsSeparateTransactions() public {
        vm.prank(operator);
        uint256 before = gasleft();
        nandReceipt.setURI("x");
        assertGe(before - gasleft(), 21_000, "isolation is off");
    }

    // ---------------------------------------------------------------------------------- setup batches

    function testIssueBatchModelCoversIssuingToTheOperatorAndToTheDistributor() public {
        uint256 n = (BATCH_GAS_BUDGET - ISSUE_BASE) / ISSUE_PER_ID; // CLI default batch
        uint256 bound = ISSUE_BASE + n * ISSUE_PER_ID;
        uint256 toOperator =
            _within(operator, address(nandReceipt), abi.encodeCall(nandReceipt.issue, (operator, n)), bound);
        // Issuing straight into the distributor also runs its receive hook for every ID.
        uint256 toDistributor = _within(
            operator,
            address(latchReceipt),
            abi.encodeCall(latchReceipt.issue, (address(distributor), n)),
            bound
        );
        console2.log("issue batch", n, bound);
        console2.log("  to operator", toOperator);
        console2.log("  to distributor", toDistributor);
    }

    function testFundBatchModelCoversMovingReceiptsIntoTheDistributor() public {
        uint256 n = 300; // CLI default, below the model's maximum
        issue(nandReceipt, operator, n);
        bytes memory data = abi.encodeCall(
            nandReceipt.safeBatchTransferFrom, (operator, address(distributor), range(1, n), _ones(n), "")
        );
        uint256 used = _within(operator, address(nandReceipt), data, FUND_BASE + n * FUND_PER_ID);
        console2.log("fund batch", n, used, FUND_BASE + n * FUND_PER_ID);
    }

    function testAllocationModelCoversManySmallRangesAndOneLargeRange() public {
        uint256 ranges = (BATCH_GAS_BUDGET - ALLOCATE_BASE) / (ALLOCATE_PER_RANGE + ALLOCATE_PER_ID);
        issue(nandReceipt, address(distributor), ranges + 400);

        // Worst case for the batcher: single-ID ranges, each for a new wallet.
        TapeoutReceiptDistributor.AllocationInput[] memory small =
            new TapeoutReceiptDistributor.AllocationInput[](ranges);
        for (uint256 i; i < ranges; ++i) {
            small[i] = _entry(_wallet(i), i + 1, 1);
        }
        uint256 smallBound = ALLOCATE_BASE + ranges * (ALLOCATE_PER_RANGE + ALLOCATE_PER_ID);
        uint256 smallGas = _within(
            operator, address(distributor), abi.encodeCall(distributor.allocate, (small)), smallBound
        );

        // CLI default ID cap in one range.
        TapeoutReceiptDistributor.AllocationInput[] memory large =
            new TapeoutReceiptDistributor.AllocationInput[](1);
        large[0] = _entry(alice, ranges + 1, 400);
        uint256 largeBound = ALLOCATE_BASE + ALLOCATE_PER_RANGE + 400 * ALLOCATE_PER_ID;
        uint256 largeGas = _within(
            operator, address(distributor), abi.encodeCall(distributor.allocate, (large)), largeBound
        );

        console2.log("allocate ranges", ranges, smallGas, smallBound);
        console2.log("allocate 400 ids", largeGas, largeBound);
    }

    function testRevokeModelCoversLargeAndFragmentedWallets() public {
        // alice: 1,500 IDs in two ranges (the most one revocation can plan); bob: 85 single-ID ranges.
        issue(nandReceipt, address(distributor), 1585);
        TapeoutReceiptDistributor.AllocationInput[] memory e =
            new TapeoutReceiptDistributor.AllocationInput[](2);
        e[0] = _entry(alice, 1, 1000);
        e[1] = _entry(alice, 1001, 500);
        _allocate(e);
        TapeoutReceiptDistributor.AllocationInput[] memory f =
            new TapeoutReceiptDistributor.AllocationInput[](85);
        for (uint256 i; i < 85; ++i) {
            f[i] = _entry(bob, 1501 + i, 1);
        }
        _allocate(f);

        uint256 largeBound = REVOKE_BASE + 2 * REVOKE_PER_RANGE + 1500 * REVOKE_PER_ID;
        uint256 large = _within(
            operator, address(distributor), abi.encodeCall(distributor.revokeWallet, (alice)), largeBound
        );
        uint256 fragmentedBound = REVOKE_BASE + 85 * (REVOKE_PER_RANGE + REVOKE_PER_ID);
        uint256 fragmented = _within(
            operator, address(distributor), abi.encodeCall(distributor.revokeWallet, (bob)), fragmentedBound
        );
        console2.log("revoke 1500 ids", large, largeBound);
        console2.log("revoke 85 ranges", fragmented, fragmentedBound);
        assertEq(distributor.beneficiaryOf(NAND, 1500), address(0));
    }

    // ---------------------------------------------------------------------------------- delivery and claims

    function testDeliveryModelCoversOneLargeAndManySmallRanges() public {
        // alice: the default 300 IDs in one range; bob: 60 single-ID ranges.
        issue(nandReceipt, address(distributor), DELIVER_DEFAULT + 60);
        TapeoutReceiptDistributor.AllocationInput[] memory e =
            new TapeoutReceiptDistributor.AllocationInput[](61);
        e[0] = _entry(alice, 1, DELIVER_DEFAULT);
        for (uint256 i; i < 60; ++i) {
            e[i + 1] = _entry(bob, DELIVER_DEFAULT + 1 + i, 1);
        }
        _allocate(e);
        vm.prank(operator);
        nandReceipt.finalizeIssuance();
        vm.prank(operator);
        latchReceipt.finalizeIssuance();
        vm.prank(operator);
        distributor.finalizeAllocation();

        uint256 singleBound = DELIVER_BASE + DELIVER_PER_RANGE + DELIVER_DEFAULT * DELIVER_PER_ID;
        uint256 single = _within(
            alice, address(distributor), abi.encodeCall(distributor.claim, (DELIVER_DEFAULT)), singleBound
        );
        uint256 manyBound = DELIVER_BASE + 60 * (DELIVER_PER_RANGE + DELIVER_PER_ID);
        uint256 many =
            _within(carol, address(distributor), abi.encodeCall(distributor.deliver, (bob, 60)), manyBound);
        console2.log("deliver 300 ids, 1 range", single, singleBound);
        console2.log("deliver 60 ranges", many, manyBound);
        assertEq(nandReceipt.balanceOf(alice, DELIVER_DEFAULT), 1);
        assertEq(nandReceipt.balanceOf(bob, DELIVER_DEFAULT + 60), 1);
    }

    function testClaimModelCoversTheLargestPlannedBatch() public {
        uint256 n = (BATCH_GAS_BUDGET - CLAIM_BASE) / CLAIM_PER_ID; // largest --batch-size the CLI accepts
        issue(nandReceipt, alice, n);
        finalizeIssuance();
        activate();
        admitNew(1, 40, 0);
        accrue(1, 10_000 * BEM_UNIT);
        pool.harvest(one(1));

        uint256 bound = CLAIM_BASE + n * CLAIM_PER_ID;
        uint256 used =
            _within(alice, address(pool), abi.encodeCall(pool.claimBatch, (range(1, n), none())), bound);
        console2.log("claimBatch", n, used, bound);
        assertEq(pool.claimable(NAND, n), 0);
    }

    // ---------------------------------------------------------------------------------- deployments and single calls

    function testDeploymentModelsCoverTheLargestConfigurations() public {
        string memory long64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assertEq(bytes(long64).length, 64); // TapeoutMinerPool accepts names up to 64 bytes
        string memory uri200 = string.concat(long64, long64, long64, "ipfs://bafy-0123456789");
        uint256 receiptGas = _deployWithin(
            abi.encodePacked(
                type(TapeoutEntitlementReceipt).creationCode,
                abi.encode(NAND_CATEGORY, long64, "TOPNAND-LONGSYMB", uri200, operator)
            ),
            DEPLOY_RECEIPT
        );

        address[] memory depositors = new address[](16); // TapeoutMinerPool.MAX_DEPOSITORS
        for (uint256 i; i < 16; ++i) {
            depositors[i] = _wallet(100 + i);
        }
        TapeoutMinerPool.Deployment memory d = deployment(depositors);
        d.poolName = long64;
        uint256 poolGas =
            _deployWithin(abi.encodePacked(type(TapeoutMinerPool).creationCode, abi.encode(d)), DEPLOY_POOL);
        uint256 distributorGas = _deployWithin(
            abi.encodePacked(
                type(TapeoutReceiptDistributor).creationCode, abi.encode(operator, address(pool))
            ),
            DEPLOY_DISTRIBUTOR
        );
        console2.log("deploy receipt", receiptGas, DEPLOY_RECEIPT);
        console2.log("deploy pool (16 depositors)", poolGas, DEPLOY_POOL);
        console2.log("deploy distributor", distributorGas, DEPLOY_DISTRIBUTOR);
    }

    function testSingleCallsFitTheirBounds() public {
        issue(nandReceipt, address(distributor), 10);
        issue(latchReceipt, address(distributor), 10);
        TapeoutReceiptDistributor.AllocationInput[] memory e =
            new TapeoutReceiptDistributor.AllocationInput[](2);
        e[0] = _entry(alice, 1, 10);
        e[1] = TapeoutReceiptDistributor.AllocationInput({
            category: LATCH, wallet: alice, firstId: 1, count: 10
        });
        _allocate(e);

        uint256 finalizeIssuanceGas = _within(
            operator,
            address(nandReceipt),
            abi.encodeCall(nandReceipt.finalizeIssuance, ()),
            CALL_FINALIZE_ISSUANCE
        );
        vm.prank(operator);
        latchReceipt.finalizeIssuance();
        uint256 finalizeAllocationGas = _within(
            operator,
            address(distributor),
            abi.encodeCall(distributor.finalizeAllocation, ()),
            CALL_FINALIZE_ALLOCATION
        );
        uint256 activateGas =
            _within(operator, address(pool), abi.encodeCall(pool.activate, (10, 10)), CALL_ACTIVATE);
        uint256 approveGas = _within(
            depositor,
            address(nft),
            abi.encodeWithSignature("setApprovalForAll(address,bool)", address(pool), true),
            CALL_APPROVE
        );
        admitNew(1, 5, 5);
        accrue(1, 1_000 * BEM_UNIT);
        pool.harvest(one(1));
        uint256 releaseAGas = _within(carol, address(pool), abi.encodeCall(pool.releaseA, ()), CALL_RELEASE);
        uint256 releaseBGas = _within(carol, address(pool), abi.encodeCall(pool.releaseB, ()), CALL_RELEASE);
        uint256 setRecipientGas = _within(
            recipientA,
            address(pool),
            abi.encodeCall(pool.setRecipient, (TapeoutMinerPool.Recipient.A, dave)),
            CALL_SET_RECIPIENT
        );
        uint256 renounceGas =
            _within(operator, address(pool), abi.encodeWithSignature("renounceOwnership()"), CALL_RENOUNCE);

        console2.log("finalizeIssuance", finalizeIssuanceGas);
        console2.log("finalizeAllocation", finalizeAllocationGas);
        console2.log("activate", activateGas);
        console2.log("setApprovalForAll", approveGas);
        console2.log("releaseA / releaseB", releaseAGas, releaseBGas);
        console2.log("setRecipient", setRecipientGas);
        console2.log("renounceOwnership", renounceGas);
        assertGt(bem.balanceOf(recipientA), 0);
        assertEq(pool.owner(), address(0));
    }
}
