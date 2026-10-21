// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {console2} from "forge-std/console2.sol";
import {SystemTestBase} from "../helpers/SystemTestBase.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {MockMining} from "../helpers/Mocks.sol";

/// @notice Internal security review (f2c8e50), workstream C. Documents (does not dispute) the liveness
///         consequences of strict settlement: the admission path depends on every registered miner
///         staying claimable or REVOKED forever, and revoked miners keep their composition weight and
///         keep costing gas. Mock-only status injection; on the deployed protocol a pool-held miner has
///         no observed route into COOLING or status 0 (docs/ARCHITECTURE.md 4.5, UNVERIFIED restart
///         semantics in docs/VERIFICATION_REPORT.md 3.2).
contract AuditAdmissionLivenessTest is SystemTestBase {
    function setUp() public override {
        super.setUp();
        setupStandard();
    }

    function testPermanentlyNonClaimableOldMinerBlocksEveryLaterAdmissionButNotPayouts() public {
        admitNew(1, 9, 1);
        admitNew(2, 2, 2);
        accrue(1, 1_050_000);
        pool.harvestRange(0, 2);
        bytes32 key2 = mining.minerKey(address(nft), 2);
        mining.setStatus(address(nft), 2, 3); // mock-only fault injection: COOLING without a payout
        bytes memory expected = abi.encodeWithSelector(
            TapeoutMinerPool.SettlementFailed.selector, 2, abi.encodeWithSelector(MockMining.NotActiveMiner.selector, key2)
        );
        for (uint256 id = 3; id < 6; ++id) {
            newMiner(id, 1, 1);
            vm.startPrank(depositor);
            nft.setApprovalForAll(address(pool), true);
            vm.expectRevert(expected);
            pool.depositMiners(one(id));
            vm.stopPrank();
        }
        // registerMiners is blocked by the same boundary; the plain-transferred NFT then sits in custody.
        vm.prank(depositor);
        nft.transferFrom(depositor, address(pool), 3);
        vm.prank(depositor);
        vm.expectRevert(expected);
        pool.registerMiners(one(3));
        assertEq(pool.minerCount(), 2);
        assertEq(nft.ownerOf(3), address(pool));
        // Income collection and payouts keep working around the failing miner.
        accrue(1, 2_040_000);
        (uint256 received, uint256 failed) = pool.harvestRange(0, 2);
        assertEq(failed, 1);
        assertEq(received, 2_040_000);
        assertGt(claimAs(alice, range(1, 5), range(1, 5)), 0);
        assertGt(pool.releaseA(), 0);
        assertGt(pool.releaseB(), 0);
        assertReconciled();
        // Only the protocol can unblock it; the pool has no eviction, skip or override.
        mining.setStatus(address(nft), 2, 1);
        vm.prank(depositor);
        (uint256 settled,) = pool.registerMiners(one(3));
        assertEq(settled, 0);
        assertEq(pool.minerCount(), 3);
    }

    function testRevokedMinersKeepTheirWeightAndKeepCostingGasOnEveryAdmission() public {
        for (uint256 id = 1; id <= 10; ++id) {
            admitNew(id, 5, 5);
        }
        newMiner(11, 1, 1);
        uint256 activeOld = _admitGas(11);
        for (uint256 id = 1; id <= 10; ++id) {
            mining.setStatus(address(nft), id, 2); // challenge
        }
        newMiner(12, 1, 1);
        uint256 revokedOld = _admitGas(12);
        console2.log("admission gas with 10 active old miners", activeOld);
        console2.log("admission gas with 10 revoked old miners", revokedOld);
        assertEq(pool.totalNandBurn(), 52, "revocation does not change the composition");
        assertEq(pool.totalLatchBurn(), 52);
        // Only miners 11 and 12 produce from now on; their income is still split by the full weight.
        accrue(11, 1_050_000);
        pool.harvestRange(0, 12);
        assertEq(pool.accrual().nandIncome, 500_000);
        assertEq(pool.accrual().latchIncome, 500_000);
        assertReconciled();
    }

    function _admitGas(uint256 id) internal returns (uint256 used) {
        vm.startPrank(depositor);
        nft.setApprovalForAll(address(pool), true);
        uint256 before = gasleft();
        pool.depositMiners(one(id));
        used = before - gasleft();
        vm.stopPrank();
    }
}
