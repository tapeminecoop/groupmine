// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Subset of the deployed TapeOut Mining ABI used by the pool.
/// @dev Function signatures and the miner record layout come from the official TapeOut frontend ABI
///      (tapeout.net/pod, bundle sha256 0f1b12c3…a1e) and were checked against raw return data of the
///      deployed implementation (docs/VERIFICATION_REPORT.md). Observed behaviour the pool relies on:
///      - `claim(key)` is callable by anyone, pays the miner NFT's current holder, can pay while
///        `pending(key)` is zero, and reverts (0x5f9bb3be) unless the miner's status is ACTIVE (1);
///      - `claimMany(keys)` silently skips keys that cannot be claimed, so the pool never uses it
///        where every claim must succeed;
///      - `nandBurn`/`latchBurn` are the circuit's local actual burn (NAND/LATCH consumed), equal to
///        `cachedBurn` for every active miner sampled; `gateCount`, `area`, `bstar`, `mult`, `bonus`
///        and the weights are circuit metrics or mining power, not consumed materials.
interface IMining {
    struct MinerRecord {
        address circuits;
        uint64 circuitId;
        uint32 taskId;
        uint32 gateCount;
        uint32 stateCount;
        uint32 depth;
        uint64 area;
        uint32 mult;
        uint64 since;
        uint8 status;
        address registrant;
        uint32 nandBurn;
        uint32 latchBurn;
        uint64 bstar;
        uint64 bonus;
        bool optimal;
        uint64 commitBlock;
        uint64 firstUnusedId;
        uint64 stopBlock;
        uint128 verifWeight;
        uint128 unverWeight;
        uint256 debt;
    }

    function minerKey(address collection, uint256 tokenId) external view returns (bytes32);

    function getMiner(bytes32 key) external view returns (MinerRecord memory);

    function cachedBurn(address circuits, uint256 circuitId)
        external
        view
        returns (bool cached, uint32 nand, uint32 latch);

    function pending(bytes32 key) external view returns (uint256);

    function claim(bytes32 key) external;
}
