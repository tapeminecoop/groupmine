// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TapeoutEntitlementReceipt} from "../src/TapeoutEntitlementReceipt.sol";
import {TapeoutMinerPool} from "../src/TapeoutMinerPool.sol";
import {TapeoutReceiptDistributor} from "../src/TapeoutReceiptDistributor.sol";

/// @notice Optional Foundry deployment path for operators who sign with --ledger / --account.
///         The CLI (`npm run pool -- deploy-receipts` / `deploy` / `deploy-distributor`) produces the same
///         transactions. DeployPool deploys both custody pools of the processor against the one receipt
///         pair, then the distributor that serves both (2.3.0); each pool binds it with its own
///         bindDistributor afterwards.
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
    function run()
        external
        returns (
            TapeoutMinerPool optimalPool,
            TapeoutMinerPool regularPool,
            TapeoutReceiptDistributor distributor
        )
    {
        string memory json = vm.readFile(vm.envString("SYSTEM_CONFIG"));
        require(vm.parseJsonUint(json, ".chainId") == block.chainid, "SYSTEM_CONFIG chainId mismatch");
        // A single-pool system file (2.2.0 and earlier) is refused, never read as one of the two pools.
        require(
            !vm.keyExistsJson(json, ".pool"),
            "SYSTEM_CONFIG is a single-pool file: 2.3.0 needs .pools.optimal and .pools.regular"
        );
        TapeoutMinerPool.Deployment memory optimal = _deployment(json, ".pools.optimal");
        TapeoutMinerPool.Deployment memory regular = _deployment(json, ".pools.regular");
        address distributorOwner = vm.parseJsonAddress(json, ".distributor.owner");
        vm.startBroadcast();
        optimalPool = new TapeoutMinerPool(optimal);
        regularPool = new TapeoutMinerPool(regular);
        distributor = new TapeoutReceiptDistributor(distributorOwner, optimalPool, regularPool);
        vm.stopBroadcast();
        console2.log("Optimal TapeoutMinerPool", address(optimalPool));
        console2.log("Regular TapeoutMinerPool", address(regularPool));
        console2.log("TapeoutReceiptDistributor", address(distributor));
    }

    /// @dev Both pools take the same protocol and receipts; owner, recipients, whitelist and name are per pool.
    function _deployment(string memory json, string memory key)
        private
        view
        returns (TapeoutMinerPool.Deployment memory)
    {
        return TapeoutMinerPool.Deployment({
            owner: vm.parseJsonAddress(json, string.concat(key, ".owner")),
            bem: vm.parseJsonAddress(json, ".protocol.bem"),
            mining: vm.parseJsonAddress(json, ".protocol.mining"),
            minerCollection: vm.parseJsonAddress(json, ".protocol.minerCollection"),
            nandReceipt: vm.envAddress("NAND_RECEIPT"),
            latchReceipt: vm.envAddress("LATCH_RECEIPT"),
            recipientA: vm.parseJsonAddress(json, string.concat(key, ".recipientA")),
            recipientB: vm.parseJsonAddress(json, string.concat(key, ".recipientB")),
            depositors: vm.parseJsonAddressArray(json, string.concat(key, ".depositors")),
            poolName: vm.parseJsonString(json, string.concat(key, ".name"))
        });
    }
}
