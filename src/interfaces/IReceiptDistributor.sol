// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The views of TapeoutReceiptDistributor that a custody pool reads: its binding when the
///         owner binds it before activation (the pool must be one of the distributor's two fixed pools),
///         and its finality when custody begins.
interface IReceiptDistributor {
    function isPool(address candidate) external view returns (bool);

    function nandReceipt() external view returns (address);

    function latchReceipt() external view returns (address);

    function allocationFinalized() external view returns (bool);

    function owner() external view returns (address);
}
