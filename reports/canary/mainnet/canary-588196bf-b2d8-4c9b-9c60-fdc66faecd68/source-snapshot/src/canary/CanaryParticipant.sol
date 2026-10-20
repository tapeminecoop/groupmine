// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RecoverableTapeoutMinerPool} from "./RecoverableTapeoutMinerPool.sol";

/// @notice One-signer canary's second holder. No arbitrary executor, recipient setter or approval.
contract CanaryParticipant is ERC1155Holder, ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public immutable controller;
    IERC20 public immutable bem;
    address public immutable nandReceipt;
    address public immutable latchReceipt;
    RecoverableTapeoutMinerPool public pool;

    error Unauthorized();
    error InvalidBinding();
    error UnsupportedReceipt();

    constructor(address controller_, address bem_, address nand_, address latch_) {
        if (
            controller_ == address(0) || bem_.code.length == 0 || nand_.code.length == 0
                || latch_.code.length == 0
        ) revert InvalidBinding();
        controller = controller_;
        bem = IERC20(bem_);
        nandReceipt = nand_;
        latchReceipt = latch_;
    }

    modifier onlyController() {
        if (msg.sender != controller) revert Unauthorized();
        _;
    }

    function bindPool(RecoverableTapeoutMinerPool candidate) external onlyController {
        if (address(pool) != address(0) || address(candidate).code.length == 0) revert InvalidBinding();
        if (
            candidate.recoveryController() != controller || candidate.recipientA() != controller
                || candidate.recipientB() != address(this) || address(candidate.bem()) != address(bem)
                || address(candidate.nandReceipt()) != nandReceipt
                || address(candidate.latchReceipt()) != latchReceipt
        ) revert InvalidBinding();
        pool = candidate;
    }

    function claim(uint256[] calldata nandIds, uint256[] calldata latchIds)
        external
        onlyController
        nonReentrant
        returns (uint256)
    {
        return pool.claimBatch(nandIds, latchIds);
    }

    function transferReceipt(bool latch, uint256 id) external onlyController nonReentrant {
        IERC1155(latch ? latchReceipt : nandReceipt).safeTransferFrom(address(this), controller, id, 1, "");
    }

    function forwardBEM() external onlyController nonReentrant {
        bem.safeTransfer(controller, bem.balanceOf(address(this)));
    }

    function onERC1155Received(address, address, uint256, uint256, bytes memory)
        public
        view
        override
        returns (bytes4)
    {
        if (msg.sender != nandReceipt && msg.sender != latchReceipt) revert UnsupportedReceipt();
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] memory, uint256[] memory, bytes memory)
        public
        view
        override
        returns (bytes4)
    {
        if (msg.sender != nandReceipt && msg.sender != latchReceipt) revert UnsupportedReceipt();
        return this.onERC1155BatchReceived.selector;
    }
}
