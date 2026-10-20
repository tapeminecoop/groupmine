// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice Independently deployed, unique-ID ERC-1155 entitlement receipt for one category (NAND or
///         LATCH). IDs are issued sequentially as 1..S, each with a supply of exactly one; every ID is
///         an equal share of its category's income. The issuer (owner) issues in batches and then
///         finalizes; after `finalizeIssuance` no code path can mint, burn or otherwise change the
///         supply, and the issuer keeps no power over holders' receipts.
/// @dev No immutables on purpose: every deployment has the same runtime code, so the custody pool
///      can verify a receipt by code hash (`keccak256(type(TapeoutEntitlementReceipt).runtimeCode)`)
///      instead of trusting an arbitrary ERC-1155 to provide unique-ID, fixed-supply semantics.
///      The holder index follows the GroupBuyVault pattern in TapeoutMarket/test1 (commit 9d86a26).
contract TapeoutEntitlementReceipt is ERC1155, Ownable2Step {
    bytes32 public constant NAND = keccak256("TAPEOUT_NAND_ENTITLEMENT");
    bytes32 public constant LATCH = keccak256("TAPEOUT_LATCH_ENTITLEMENT");
    uint256 public constant MAX_ISSUE_BATCH = 500;
    uint256 public constant MAX_PAGE = 1000;

    bytes32 public category;
    string public name;
    string public symbol;
    bool public issuanceFinalized;

    uint256 private _supply;
    mapping(uint256 id => address holder) private _holders;

    error InvalidCategory();
    error InvalidCount();
    error IssuanceClosed();
    error NotIssuerHeld(uint256 id);
    error InvalidAmount(uint256 id, uint256 value);
    error InvalidPage();

    event Issued(address indexed to, uint256 firstId, uint256 count, uint256 supply);
    event Retracted(uint256 firstId, uint256 count, uint256 supply);
    event IssuanceFinalized(uint256 supply);
    event BaseURIUpdated(string uri);

    constructor(
        bytes32 category_,
        string memory name_,
        string memory symbol_,
        string memory uri_,
        address issuer
    ) ERC1155(uri_) Ownable(issuer) {
        if (category_ != NAND && category_ != LATCH) revert InvalidCategory();
        category = category_;
        name = name_;
        symbol = symbol_;
    }

    // ---------------------------------------------------------------------------------- issuance

    /// @notice Issue the next `count` IDs (supply+1 .. supply+count) to `to` in one batch.
    function issue(address to, uint256 count) external onlyOwner returns (uint256 firstId) {
        if (issuanceFinalized) revert IssuanceClosed();
        if (count == 0 || count > MAX_ISSUE_BATCH) revert InvalidCount();
        firstId = _supply + 1;
        uint256[] memory ids = new uint256[](count);
        uint256[] memory values = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = firstId + i;
            values[i] = 1;
        }
        _mintBatch(to, ids, values, "");
        emit Issued(to, firstId, count, _supply);
    }

    /// @notice Before finalization, undo over-issuance: burn the highest `count` IDs, all of which
    ///         must still be held by the issuer. IDs held by anyone else can never be retracted.
    function retract(uint256 count) external onlyOwner {
        if (issuanceFinalized) revert IssuanceClosed();
        if (count == 0 || count > _supply || count > MAX_ISSUE_BATCH) revert InvalidCount();
        uint256 firstId = _supply - count + 1;
        uint256[] memory ids = new uint256[](count);
        uint256[] memory values = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = _supply - i; // highest first, so the remaining IDs stay 1..S
            values[i] = 1;
            if (_holders[ids[i]] != msg.sender) revert NotIssuerHeld(ids[i]);
        }
        _burnBatch(msg.sender, ids, values);
        emit Retracted(firstId, count, _supply);
    }

    /// @notice Permanently fix the supply at the IDs issued so far.
    function finalizeIssuance() external onlyOwner {
        if (issuanceFinalized) revert IssuanceClosed();
        issuanceFinalized = true;
        emit IssuanceFinalized(_supply);
    }

    function setURI(string calldata uri_) external onlyOwner {
        _setURI(uri_);
        emit BaseURIUpdated(uri_);
    }

    // ---------------------------------------------------------------------------------- views

    /// @notice Number of issued IDs; the IDs are exactly 1..totalSupply().
    function totalSupply() external view returns (uint256) {
        return _supply;
    }

    function totalSupply(uint256 id) external view returns (uint256) {
        return _holders[id] == address(0) ? 0 : 1;
    }

    function exists(uint256 id) external view returns (bool) {
        return _holders[id] != address(0);
    }

    function holderOf(uint256 id) external view returns (address) {
        return _holders[id];
    }

    /// @notice Holders of IDs firstId..firstId+count-1 (zero address for IDs that do not exist).
    function holdersPage(uint256 firstId, uint256 count) external view returns (address[] memory holders) {
        if (firstId == 0 || count == 0 || count > MAX_PAGE) revert InvalidPage();
        holders = new address[](count);
        for (uint256 i; i < count; ++i) {
            holders[i] = _holders[firstId + i];
        }
    }

    // ---------------------------------------------------------------------------------- internals

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override
    {
        bool minting = from == address(0);
        bool burning = to == address(0);
        if ((minting || burning) && issuanceFinalized) revert IssuanceClosed();
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            uint256 value = values[i];
            if (value > 1) revert InvalidAmount(id, value);
            if (value == 0) continue;
            if (minting) {
                // Only `issue` mints, and only the next sequential IDs.
                if (id != _supply + 1) revert InvalidAmount(id, value);
                ++_supply;
            } else if (burning) {
                // Only `retract` burns, and only from the top.
                if (id != _supply) revert InvalidAmount(id, value);
                --_supply;
            }
            // Balance checks happen in super._update; any inconsistency reverts the whole call.
            _holders[id] = to;
        }
        super._update(from, to, ids, values);
    }
}
