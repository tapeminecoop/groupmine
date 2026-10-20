// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TapeoutEntitlementReceipt} from "../src/TapeoutEntitlementReceipt.sol";
import {TapeoutMinerPool} from "../src/TapeoutMinerPool.sol";
import {TapeoutReceiptDistributor} from "../src/TapeoutReceiptDistributor.sol";

/// @notice Optional Foundry deployment path for operators who sign with --ledger / --account.
///         The CLI (`npm run pool -- deploy-receipts` / `deploy`) produces the same transactions.
///
///   SYSTEM_CONFIG=deployments/system.json forge script script/DeployPool.s.sol:DeployReceipts \
///     --rpc-url "$RPC_URL" --ledger --sender <deployer> --broadcast
///   SYSTEM_CONFIG=deployments/system.json NAND_RECEIPT=0x… LATCH_RECEIPT=0x… \
///     forge script script/DeployPool.s.sol:DeployPool --rpc-url "$RPC_URL" --ledger --sender <deployer> --broadcast
contract DeployReceipts is Script {
    function run() external returns (TapeoutEntitlementReceipt nand, TapeoutEntitlementReceipt latch) {
        string memory json = vm.readFile(vm.envString("SYSTEM_CONFIG"));
        require(vm.parseJsonUint(json, ".chainId") == block.chainid, "SYSTEM_CONFIG chainId mismatch");
        address issuer = vm.parseJsonAddress(json, ".receipts.issuer");
        vm.startBroadcast();
        nand = new TapeoutEntitlementReceipt(
            keccak256("TAPEOUT_NAND_ENTITLEMENT"),
            vm.parseJsonString(json, ".receipts.nand.name"),
            vm.parseJsonString(json, ".receipts.nand.symbol"),
            vm.parseJsonString(json, ".receipts.nand.uri"),
            issuer
        );
        latch = new TapeoutEntitlementReceipt(
            keccak256("TAPEOUT_LATCH_ENTITLEMENT"),
            vm.parseJsonString(json, ".receipts.latch.name"),
            vm.parseJsonString(json, ".receipts.latch.symbol"),
            vm.parseJsonString(json, ".receipts.latch.uri"),
            issuer
        );
        vm.stopBroadcast();
        console2.log("NAND receipt", address(nand));
        console2.log("LATCH receipt", address(latch));
    }
}

contract DeployPool is Script {
    function run() external returns (TapeoutMinerPool pool, TapeoutReceiptDistributor distributor) {
        string memory json = vm.readFile(vm.envString("SYSTEM_CONFIG"));
        require(vm.parseJsonUint(json, ".chainId") == block.chainid, "SYSTEM_CONFIG chainId mismatch");
        TapeoutMinerPool.Deployment memory d = TapeoutMinerPool.Deployment({
            owner: vm.parseJsonAddress(json, ".pool.owner"),
            bem: vm.parseJsonAddress(json, ".protocol.bem"),
            mining: vm.parseJsonAddress(json, ".protocol.mining"),
            minerCollection: vm.parseJsonAddress(json, ".protocol.minerCollection"),
            nandReceipt: vm.envAddress("NAND_RECEIPT"),
            latchReceipt: vm.envAddress("LATCH_RECEIPT"),
            recipientA: vm.parseJsonAddress(json, ".pool.recipientA"),
            recipientB: vm.parseJsonAddress(json, ".pool.recipientB"),
            depositors: vm.parseJsonAddressArray(json, ".pool.depositors"),
            poolName: vm.parseJsonString(json, ".pool.name")
        });
        address distributorOwner = vm.parseJsonAddress(json, ".distributor.owner");
        vm.startBroadcast();
        pool = new TapeoutMinerPool(d);
        distributor = new TapeoutReceiptDistributor(distributorOwner, pool);
        vm.stopBroadcast();
        console2.log("TapeoutMinerPool", address(pool));
        console2.log("TapeoutReceiptDistributor", address(distributor));
    }
}
