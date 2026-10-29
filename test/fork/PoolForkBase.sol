// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {TapeoutMinerPool} from "../../src/TapeoutMinerPool.sol";
import {TapeoutEntitlementReceipt} from "../../src/TapeoutEntitlementReceipt.sol";
import {TapeoutReceiptDistributor} from "../../src/TapeoutReceiptDistributor.sol";
import {PoolMath} from "../../src/PoolMath.sol";
import {IMining} from "../../src/interfaces/IMining.sol";

interface IBeacon {
    function implementation() external view returns (address);
}

interface IMiningMany {
    function claimMany(bytes32[] calldata keys) external;
}

/// @notice Shared setup for the real-protocol fork tests: pinned fork, the exact Paris artifacts from
///         ./out, and helpers that move miners with fork-only impersonation. Protocol code and storage
///         are never modified.
abstract contract PoolForkBase is Test {
    address internal constant COLLECTION = 0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C;
    address internal constant MINING = 0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46;
    address internal constant BEM = 0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a;
    address internal constant MINING_IMPLEMENTATION = 0xa3DBe873DA37cD4e4a13c7cEf23a7dB6Ca60f898;
    address internal constant COLLECTION_BEACON = 0xf8D6d8EB894d6971c8976Ad8b4971cbEFE028156;
    bytes32 internal constant IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 internal constant BEACON_SLOT =
        0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;
    bytes32 internal constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;
    bytes32 internal constant KEY_3204 = 0xb0e5b7d325dead6144886258056fb8e27ff5f6192aaa90fd0b45682c297c1c0d;
    uint256 internal constant TX_GAS_CAP = 16_777_216; // BEP-652 / EIP-7825, BSC Mendel (2026-04-28)

    TapeoutMinerPool.Category internal constant NAND = TapeoutMinerPool.Category.NAND;
    TapeoutMinerPool.Category internal constant LATCH = TapeoutMinerPool.Category.LATCH;

    IERC20 internal bem = IERC20(BEM);
    IMining internal mining = IMining(MINING);
    IERC721 internal collection = IERC721(COLLECTION);

    address internal operator = makeAddr("fork.operator");
    address internal depositor = makeAddr("fork.depositor");
    address internal recipientA = makeAddr("fork.recipientA");
    address internal recipientB = makeAddr("fork.recipientB");
    address internal alice = makeAddr("fork.alice");
    address internal bob = makeAddr("fork.bob");
    address internal carol = makeAddr("fork.carol");
    address internal keeper = makeAddr("fork.keeper");

    TapeoutEntitlementReceipt internal nandReceipt;
    TapeoutEntitlementReceipt internal latchReceipt;
    TapeoutMinerPool internal pool;
    /// @dev The processor's second pool (2.3.0): same receipts and distributor as `pool`.
    TapeoutMinerPool internal regularPool;
    TapeoutReceiptDistributor internal distributor;
    uint256 internal forkBlock;
    uint256 internal nandMiner;
    uint256 internal latchMiner;

    function setUp() public virtual {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        forkBlock = vm.envUint("FORK_BLOCK");
        vm.createSelectFork(rpc, forkBlock);
        nandMiner = vm.envOr("FORK_NAND_MINER", uint256(12733));
        latchMiner = vm.envOr("FORK_LATCH_MINER", uint256(13948));
    }

    /// @dev Fork-only impersonation of the miners' current holders: move each to the depositor.
    function _moveAllToDepositor(uint256[] memory tokenIds) internal {
        for (uint256 i; i < tokenIds.length; ++i) {
            _moveToDepositor(tokenIds[i]);
        }
    }

    // ---------------------------------------------------------------------------------- deployment

    function _artifact(string memory name) internal view returns (bytes memory) {
        return vm.parseJsonBytes(
            vm.readFile(string.concat("out/", name, ".sol/", name, ".json")), ".bytecode.object"
        );
    }

    function _create(bytes memory initCode) internal returns (address deployed) {
        assembly {
            deployed := create(0, add(initCode, 0x20), mload(initCode))
        }
        require(deployed != address(0), "artifact deployment failed");
    }

    /// @dev Receipts S_N = 20 / S_L = 10 -> distributor -> alice 12 + 4, bob 8, carol 6; distributor
    ///      bound and finalized, pool active, and (2.2.0) every owner renounced, as custody requires.
    function _deploySystem() internal {
        _deploySystemKeepingOwners();
        vm.startPrank(operator);
        _renounceAll();
        vm.stopPrank();
    }

    /// @dev The same system with every owner still in place (custody closed).
    function _deploySystemKeepingOwners() internal {
        bytes memory receiptCode = _artifact("TapeoutEntitlementReceipt");
        nandReceipt = TapeoutEntitlementReceipt(
            _create(
                abi.encodePacked(
                    receiptCode,
                    abi.encode(keccak256("TAPEOUT_NAND_ENTITLEMENT"), "Fork NAND", "fNAND", "", operator)
                )
            )
        );
        latchReceipt = TapeoutEntitlementReceipt(
            _create(
                abi.encodePacked(
                    receiptCode,
                    abi.encode(keccak256("TAPEOUT_LATCH_ENTITLEMENT"), "Fork LATCH", "fLATCH", "", operator)
                )
            )
        );
        address[] memory depositors = new address[](1);
        depositors[0] = depositor;
        TapeoutMinerPool.Deployment memory d = TapeoutMinerPool.Deployment({
            owner: operator,
            bem: BEM,
            mining: MINING,
            minerCollection: COLLECTION,
            nandReceipt: address(nandReceipt),
            latchReceipt: address(latchReceipt),
            recipientA: recipientA,
            recipientB: recipientB,
            depositors: depositors,
            poolName: "Fork Pool"
        });
        pool = TapeoutMinerPool(_create(abi.encodePacked(_artifact("TapeoutMinerPool"), abi.encode(d))));
        d.poolName = "Fork Regular Pool";
        regularPool =
            TapeoutMinerPool(_create(abi.encodePacked(_artifact("TapeoutMinerPool"), abi.encode(d))));
        distributor = TapeoutReceiptDistributor(
            _create(
                abi.encodePacked(
                    _artifact("TapeoutReceiptDistributor"),
                    abi.encode(operator, address(pool), address(regularPool))
                )
            )
        );
        vm.startPrank(operator);
        nandReceipt.issue(operator, 20);
        latchReceipt.issue(address(distributor), 10); // minted straight into the distributor
        nandReceipt.finalizeIssuance();
        latchReceipt.finalizeIssuance();
        uint256[] memory ids = new uint256[](20);
        uint256[] memory ones = new uint256[](20);
        for (uint256 i; i < 20; ++i) {
            ids[i] = i + 1;
            ones[i] = 1;
        }
        nandReceipt.safeBatchTransferFrom(operator, address(distributor), ids, ones, "");
        TapeoutReceiptDistributor.AllocationInput[] memory e =
            new TapeoutReceiptDistributor.AllocationInput[](4);
        e[0] = TapeoutReceiptDistributor.AllocationInput(NAND, alice, 1, 12);
        e[1] = TapeoutReceiptDistributor.AllocationInput(LATCH, alice, 1, 4);
        e[2] = TapeoutReceiptDistributor.AllocationInput(NAND, bob, 13, 8);
        e[3] = TapeoutReceiptDistributor.AllocationInput(LATCH, carol, 5, 6);
        distributor.allocate(e);
        distributor.finalizeAllocation();
        pool.bindDistributor(address(distributor));
        pool.activate(20, 10);
        vm.stopPrank();
    }

    /// @dev Called while pranking the operator: both receipts, the distributor and the pool renounce.
    function _renounceAll() internal {
        nandReceipt.renounceOwnership();
        latchReceipt.renounceOwnership();
        distributor.renounceOwnership();
        pool.renounceOwnership();
    }

    function _moveToDepositor(uint256 tokenId) internal returns (address holder, uint256 pendingBefore) {
        holder = collection.ownerOf(tokenId);
        bytes32 key = mining.minerKey(COLLECTION, tokenId);
        uint256 holderBem = bem.balanceOf(holder);
        pendingBefore = mining.pending(key);
        vm.prank(holder);
        collection.transferFrom(holder, depositor, tokenId);
        assertEq(bem.balanceOf(holder), holderBem, "transfer pays nothing to the previous holder");
        assertEq(mining.pending(key), pendingBefore, "transfer leaves the miner's income in place");
    }

    function _admit(uint256[] memory tokenIds)
        internal
        returns (uint256 settled, uint256 carried, uint256 gasUsed)
    {
        vm.startPrank(depositor);
        collection.setApprovalForAll(address(pool), true);
        uint256 g = gasleft();
        (settled, carried) = pool.depositMiners(tokenIds);
        gasUsed = g - gasleft();
        vm.stopPrank();
    }

    function _one(uint256 x) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = x;
    }

    function _range(uint256 first, uint256 last) internal pure returns (uint256[] memory r) {
        r = new uint256[](last - first + 1);
        for (uint256 i; i < r.length; ++i) {
            r[i] = first + i;
        }
    }

    function _coolProtocol() internal {
        vm.cool(address(pool));
        vm.cool(BEM);
        vm.cool(MINING);
        vm.cool(MINING_IMPLEMENTATION);
        vm.cool(COLLECTION);
        vm.cool(COLLECTION_BEACON);
        vm.cool(IBeacon(COLLECTION_BEACON).implementation());
    }
}
