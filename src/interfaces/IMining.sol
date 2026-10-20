// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Subset of the TapeOut Mining ABI used by the pool.
/// @dev Adapted from `IMining` in TapeoutMarket/test1 (commit 9d86a26) (src/interfaces/IProtocols.sol).
///      Behaviour the pool relies on, with the evidence recorded in docs/VERIFICATION_REPORT.md:
///      - `minerKey` is deterministic for (collection, tokenId);
///      - `claim(key)` is callable by anyone and pays the miner NFT's current holder;
///      - unclaimed income stays with the miner when the NFT changes hands;
///      - `pending(key)` can be zero while `claim(key)` still settles positive BEM, so the pool
///        never uses `pending` to decide whether to call `claim`, and only accounts BEM it receives.
interface IMining {
    function minerKey(address collection, uint256 tokenId) external view returns (bytes32);

    function pending(bytes32 key) external view returns (uint256);

    function claim(bytes32 key) external;
}
