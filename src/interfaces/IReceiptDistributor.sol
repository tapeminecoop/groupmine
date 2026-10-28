// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The views of TapeoutReceiptDistributor that the custody pool reads: its binding when the
///         owner binds it before activation, and its finality when custody begins.
interface IReceiptDistributor {
    function pool() external view returns (address);

    function nandReceipt() external view returns (address);

    function latchReceipt() external view returns (address);

    function allocationFinalized() external view returns (bool);

    function owner() external view returns (address);
}
