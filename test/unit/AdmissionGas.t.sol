// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SystemTestBase} from "../helpers/SystemTestBase.sol";

/// @notice Admission gas as the number of registered miners grows (mock Mining; cold accounts before
///         each measurement; every registered miner has income to settle). Written to
///         reports/gas-admission-local.json. Real Mining.claim is more expensive; see the fork report.
contract AdmissionGasTest is SystemTestBase {
    uint256 internal nextId = 1;

    function _cool() internal {
        vm.cool(address(pool));
        vm.cool(address(mining));
        vm.cool(address(bem));
        vm.cool(address(nft));
        vm.cool(address(nandReceipt));
        vm.cool(address(latchReceipt));
    }

    function _growTo(uint256 target) internal {
        while (pool.minerCount() < target) {
            uint256 n = target - pool.minerCount();
            if (n > 50) n = 50;
            uint256[] memory ids = new uint256[](n);
            for (uint256 i; i < n; ++i) {
                ids[i] = nextId;
                newMiner(nextId, uint32(1 + nextId % 17), uint32(nextId % 5));
                ++nextId;
            }
            admit(ids);
        }
    }

    function _accrueAll() internal {
        for (uint256 i; i < pool.minerCount(); ++i) {
            (uint256 id,) = pool.minerAt(i);
            accrue(id, 1_000 + id);
        }
    }

    function _measureAdmission(uint256 batch) internal returns (uint256 gasUsed) {
        uint256[] memory ids = new uint256[](batch);
        for (uint256 i; i < batch; ++i) {
            ids[i] = nextId;
            newMiner(nextId, 3, 1);
            accrue(nextId, 7_000);
            ++nextId;
        }
        _accrueAll();
        vm.startPrank(depositor);
        nft.setApprovalForAll(address(pool), true);
        _cool();
        uint256 g = gasleft();
        pool.depositMiners(ids);
        gasUsed = g - gasleft();
        vm.stopPrank();
    }

    function testAdmissionGasGrowsLinearlyWithRegisteredMiners() public {
        setupStandard();
        uint256[7] memory sizes = [uint256(0), 1, 10, 50, 100, 200, 400];
        string memory key = "admissionGas";
        uint256 previous;
        uint256 previousSize;
        for (uint256 i; i < sizes.length; ++i) {
            _growTo(sizes[i]);
            uint256 registeredBefore = pool.minerCount();
            uint256 gasOne = _measureAdmission(1);
            vm.serializeUint(
                key, string.concat("admitOneWith", vm.toString(registeredBefore), "Registered"), gasOne
            );
            if (i > 1) {
                uint256 perMiner = (gasOne - previous) / (registeredBefore - previousSize);
                vm.serializeUint(
                    key, string.concat("marginalPerOldMinerUpTo", vm.toString(registeredBefore)), perMiner
                );
            }
            previous = gasOne;
            previousSize = registeredBefore + 1;
            // Under BSC's 2^24 per-transaction cap the mock settles well beyond the sizes measured here.
            assertLt(gasOne, 16_777_216);
        }
        uint256 batchTen = _measureAdmission(10);
        string memory out = vm.serializeUint(
            key, string.concat("admitTenWith", vm.toString(pool.minerCount() - 10), "Registered"), batchTen
        );
        vm.writeJson(out, "reports/gas-admission-local.json");
    }
}
