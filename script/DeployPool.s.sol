// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TapeoutMinerPool} from "../src/TapeoutMinerPool.sol";

/// @notice Deploys one pool (and, through its constructor, both receipt collections) from a pool
///         definition JSON (see deployments/examples/pool.bsc.example.json). Economic
///         configuration, issuance and activation are separate owner transactions (see the CLI).
///
/// Example (signer chosen by the operator, e.g. --ledger or --account <keystore>):
///   POOL_CONFIG=deployments/pool.json forge script script/DeployPool.s.sol:DeployPool \
///     --rpc-url "$RPC_URL" --ledger --sender <deployer> --broadcast
contract DeployPool is Script {
    function run() external returns (TapeoutMinerPool pool) {
        string memory json = vm.readFile(vm.envString("POOL_CONFIG"));
        require(vm.parseJsonUint(json, ".chainId") == block.chainid, "POOL_CONFIG chainId mismatch");
        TapeoutMinerPool.Deployment memory d = TapeoutMinerPool.Deployment({
            owner: vm.parseJsonAddress(json, ".pool.owner"),
            bem: vm.parseJsonAddress(json, ".protocol.bem"),
            mining: vm.parseJsonAddress(json, ".protocol.mining"),
            minerCollection: vm.parseJsonAddress(json, ".protocol.minerCollection"),
            poolName: vm.parseJsonString(json, ".pool.name"),
            nand: TapeoutMinerPool.ReceiptMetadata(
                vm.parseJsonString(json, ".pool.nandReceipt.name"),
                vm.parseJsonString(json, ".pool.nandReceipt.symbol"),
                vm.parseJsonString(json, ".pool.nandReceipt.uri")
            ),
            latch: TapeoutMinerPool.ReceiptMetadata(
                vm.parseJsonString(json, ".pool.latchReceipt.name"),
                vm.parseJsonString(json, ".pool.latchReceipt.symbol"),
                vm.parseJsonString(json, ".pool.latchReceipt.uri")
            )
        });
        vm.startBroadcast();
        pool = new TapeoutMinerPool(d);
        vm.stopBroadcast();
        console2.log("TapeoutMinerPool", address(pool));
        console2.log("NAND receipt", address(pool.nandReceipt()));
        console2.log("LATCH receipt", address(pool.latchReceipt()));
        console2.log("owner", pool.owner());
    }
}
