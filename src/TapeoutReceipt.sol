// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

/// @notice Unique-ID ERC-1155 receipt collection for one entitlement category (NAND or LATCH) of a
///         single TapeoutMinerPool. Each ID has a supply of at most one; every ID carries the same
///         economic weight inside its category. Income accounting lives in the pool and is attached
///         to the ID, so a transfer moves the ID's unclaimed income to the new holder.
/// @dev Deployed by the pool's constructor, which makes the pool the only minter/burner.
///      Mint and burn are possible only until the pool activates and calls `finalizeMinting`;
///      afterwards the supply is fixed forever and ordinary ERC-1155 transfers are the only
///      way IDs move. The holder index follows the pattern of GroupBuyVault's `_holders`
///      in TapeoutMarket/test1 (commit 9d86a26).
contract TapeoutReceipt is ERC1155 {
    uint256 public constant MAX_PAGE = 1000;

    address public immutable pool;
    string public name;
    string public symbol;
    bool public mintingFinalized;
    /// @notice High-water mark of minted IDs (not lowered by pre-activation burns).
    uint256 public highestMintedId;

    uint256 private _supply;
    mapping(uint256 id => address holder) private _holders;

    error OnlyPool();
    error MintingClosed();
    error InvalidReceiptId(uint256 id);
    error AlreadyMinted(uint256 id);
    error NotMinted(uint256 id);
    error InvalidAmount(uint256 id, uint256 value);
    error InvalidPage();

    event MintingFinalized(uint256 supply, uint256 highestMintedId);
    event BaseURIUpdated(string uri);

    constructor(string memory name_, string memory symbol_, string memory uri_) ERC1155(uri_) {
        pool = msg.sender;
        name = name_;
        symbol = symbol_;
    }

    modifier onlyPool() {
        if (msg.sender != pool) revert OnlyPool();
        _;
    }

    function mint(address to, uint256 id) external onlyPool {
        _mint(to, id, 1, "");
    }

    function mintBatch(address to, uint256[] calldata ids) external onlyPool {
        uint256[] memory values = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            values[i] = 1;
        }
        _mintBatch(to, ids, values, "");
    }

    /// @notice Pre-activation correction of a manual allocation error.
    function burn(uint256 id) external onlyPool {
        address holder = _holders[id];
        if (holder == address(0)) revert NotMinted(id);
        _burn(holder, id, 1);
    }

    function finalizeMinting() external onlyPool {
        mintingFinalized = true;
        emit MintingFinalized(_supply, highestMintedId);
    }

    function setURI(string calldata uri_) external onlyPool {
        _setURI(uri_);
        emit BaseURIUpdated(uri_);
    }

    /// @notice Number of IDs currently in existence.
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

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override
    {
        bool minting = from == address(0);
        bool burning = to == address(0);
        if ((minting || burning) && mintingFinalized) revert MintingClosed();
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            uint256 value = values[i];
            if (value > 1) revert InvalidAmount(id, value);
            if (value == 0) continue;
            if (minting) {
                if (id == 0) revert InvalidReceiptId(id);
                // Checked per element, so a duplicate ID inside one mint batch also reverts.
                if (_holders[id] != address(0)) revert AlreadyMinted(id);
                ++_supply;
                if (id > highestMintedId) highestMintedId = id;
            } else if (burning) {
                --_supply;
            }
            // Balance checks happen in super._update; any inconsistency reverts the whole call.
            _holders[id] = to;
        }
        super._update(from, to, ids, values);
    }
}
