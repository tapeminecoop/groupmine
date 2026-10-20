// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @dev Adapted from test/helpers/Mocks.sol in TapeoutMarket/test1 (commit 9d86a26).
contract MockNFT is ERC721 {
    bool public broken;

    constructor() ERC721("Local miner", "MINER") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }

    function setBroken(bool flag) external {
        broken = flag;
    }

    function transferFrom(address from, address to, uint256 id) public override {
        require(!broken, "NFT_BROKEN");
        super.transferFrom(from, to, id);
    }
}

/// @dev 8 decimals like real BEM. Fault switches model a broken balance read, a broken
///      transfer, a fee-on-transfer token, and an external balance decrease.
contract MockBEM is ERC20 {
    bool public brokenBalance;
    bool public brokenTransfer;
    bool public taxed;

    constructor() ERC20("Local BEM", "BEM") {}

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function mint(address to, uint256 n) external {
        _mint(to, n);
    }

    function burn(address from, uint256 n) external {
        _burn(from, n);
    }

    function setFaults(bool balanceFault, bool transferFault, bool tax) external {
        brokenBalance = balanceFault;
        brokenTransfer = transferFault;
        taxed = tax;
    }

    function balanceOf(address a) public view override returns (uint256) {
        require(!brokenBalance, "BEM_BALANCE_BROKEN");
        return super.balanceOf(a);
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        require(!brokenTransfer, "BEM_TRANSFER_BROKEN");
        if (taxed && value > 0) {
            _burn(msg.sender, 1);
            return super.transfer(to, value - 1);
        }
        return super.transfer(to, value);
    }
}

/// @dev Multi-miner model of the observed Mining behaviour:
///      - claim(key) is permissionless and mints to the NFT's *current* holder;
///      - unclaimed income stays with the miner when the NFT moves;
///      - `pending` only reports part of the claimable amount (`unsettled` is invisible to it),
///        reproducing the real pending()==0 / claim()>0 observation;
///      - claim for a key that was never started reverts, like the real contract.
contract MockMining {
    MockBEM public immutable bem;
    bool public broken;
    bool public zeroReverts;
    uint256 public claims;
    address public lastCaller;

    mapping(bytes32 => bool) public started;
    mapping(bytes32 => bool) public keyBroken;
    mapping(bytes32 => uint256) public rewards;
    mapping(bytes32 => uint256) public unsettled;
    mapping(bytes32 => address) public collections;
    mapping(bytes32 => uint256) public tokenIds;
    mapping(bytes32 => uint256) public claimCount;

    error UnknownMinerKey(bytes32 key);

    constructor(MockBEM token) {
        bem = token;
    }

    function minerKey(address collection, uint256 tokenId) public pure returns (bytes32) {
        return keccak256(abi.encode(collection, tokenId));
    }

    function start(address collection, uint256 tokenId) public returns (bytes32 k) {
        k = minerKey(collection, tokenId);
        started[k] = true;
        collections[k] = collection;
        tokenIds[k] = tokenId;
    }

    /// @notice Income visible to `pending`.
    function accrue(address collection, uint256 tokenId, uint256 amount) external {
        rewards[start(collection, tokenId)] += amount;
    }

    /// @notice Income that `claim` settles but `pending` does not report.
    function accrueUnsettled(address collection, uint256 tokenId, uint256 amount) external {
        unsettled[start(collection, tokenId)] += amount;
    }

    function setBroken(bool flag) external {
        broken = flag;
    }

    function setZeroReverts(bool flag) external {
        zeroReverts = flag;
    }

    function setKeyBroken(address collection, uint256 tokenId, bool flag) external {
        keyBroken[minerKey(collection, tokenId)] = flag;
    }

    function pending(bytes32 k) external view returns (uint256) {
        require(!broken, "MINING_BROKEN");
        return rewards[k];
    }

    function claim(bytes32 k) external {
        require(!broken, "MINING_BROKEN");
        if (!started[k]) revert UnknownMinerKey(k);
        require(!keyBroken[k], "MINER_BROKEN");
        uint256 n = rewards[k] + unsettled[k];
        require(n > 0 || !zeroReverts, "ZERO_REWARDS");
        rewards[k] = 0;
        unsettled[k] = 0;
        claims++;
        claimCount[k]++;
        lastCaller = msg.sender;
        if (n == 0) return;
        bem.mint(IERC721(collections[k]).ownerOf(tokenIds[k]), n);
    }
}

/// @dev ERC-1155 holder that can be told to claim from inside its own receive hook.
contract ReceiptHolder {
    bytes4 private constant RECEIVED = 0xf23a6e61;
    bytes4 private constant BATCH_RECEIVED = 0xbc197c81;
    address public target;
    bytes public hookCall;
    bool public hookOk;
    bytes public hookResult;

    function setHook(address target_, bytes calldata call) external {
        target = target_;
        hookCall = call;
    }

    function execute(address to, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory result) = to.call(data);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        return result;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4) {
        _hook();
        return RECEIVED;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        returns (bytes4)
    {
        _hook();
        return BATCH_RECEIVED;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x4e2312e0 || id == 0x01ffc9a7;
    }

    function _hook() private {
        if (target == address(0)) return;
        (hookOk, hookResult) = target.call(hookCall);
    }
}
