// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {IMining} from "../../src/interfaces/IMining.sol";

/// @dev Adapted from test/helpers/Mocks.sol in TapeoutMarket/test1 (commit 9d86a26) and groupmine 48a2d74.
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

/// @dev 8 decimals like real BEM, with fault switches (broken balance read, broken transfer, fee on
///      transfer) for the payment-rollback regressions.
contract MockBEM is ERC20 {
    bool public brokenBalance;
    bool public brokenTransfer;
    bool public taxed;
    /// @dev Destinations whose incoming transfers revert (e.g. only the pool's sink).
    mapping(address => bool) public blockedTo;
    /// @dev Optional callback after a transfer to `hookTrigger`: calls `hookTarget` with `hookData`;
    ///      if `hookBubble`, a failed callback reverts the transfer with the callback's revert data.
    address public hookTrigger;
    address public hookTarget;
    bytes public hookData;
    bool public hookBubble;
    bool public hookCalled;
    bool public hookSucceeded;
    bytes public hookResult;

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

    function setBlockedTo(address to, bool flag) external {
        blockedTo[to] = flag;
    }

    function setTransferHook(address trigger, address target, bytes calldata data, bool bubble) external {
        (hookTrigger, hookTarget, hookData, hookBubble) = (trigger, target, data, bubble);
        (hookCalled, hookSucceeded) = (false, false);
    }

    function balanceOf(address a) public view override returns (uint256) {
        require(!brokenBalance, "BEM_BALANCE_BROKEN");
        return super.balanceOf(a);
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        require(!brokenTransfer, "BEM_TRANSFER_BROKEN");
        require(!blockedTo[to], "BEM_DESTINATION_BLOCKED");
        bool ok;
        if (taxed && value > 0) {
            _burn(msg.sender, 1);
            ok = super.transfer(to, value - 1);
        } else {
            ok = super.transfer(to, value);
        }
        if (to == hookTrigger && hookTarget != address(0)) {
            (bool success, bytes memory result) = hookTarget.call(hookData);
            (hookCalled, hookSucceeded, hookResult) = (true, success, result);
            if (!success && hookBubble) {
                assembly {
                    revert(add(result, 32), mload(result))
                }
            }
        }
        return ok;
    }
}

/// @dev Model of the observed Mining behaviour (see docs/VERIFICATION_REPORT.md):
///      - claim(key) is permissionless, mints to the NFT's current holder, and reverts unless the
///        miner record's status is ACTIVE (1), like the real 0x5f9bb3be revert;
///      - `pending` reports only part of what claim pays (`unsettled` is invisible to it);
///      - claimMany skips keys that cannot be claimed instead of reverting;
///      - the miner record carries nandBurn/latchBurn, mirrored by cachedBurn.
contract MockMining {
    struct Record {
        address circuits;
        uint64 circuitId;
        uint8 status;
        uint32 nandBurn;
        uint32 latchBurn;
        bool cached;
        uint32 cachedNand;
        uint32 cachedLatch;
        uint64 circuitIdOverride;
    }

    MockBEM public immutable bem;
    bool public broken;
    uint256 public claims;
    address public lastCaller;

    mapping(bytes32 => Record) public records;
    mapping(bytes32 => bool) public keyBroken;
    mapping(bytes32 => uint256) public rewards;
    mapping(bytes32 => uint256) public unsettled;
    mapping(bytes32 => uint256) public claimCount;

    error NotActiveMiner(bytes32 key);

    constructor(MockBEM token) {
        bem = token;
    }

    function minerKey(address collection, uint256 tokenId) public pure returns (bytes32) {
        return keccak256(abi.encode(collection, tokenId));
    }

    /// @notice Start a miner with its burn composition (ACTIVE, burn cached).
    function start(address collection, uint256 tokenId, uint32 nand, uint32 latch)
        public
        returns (bytes32 k)
    {
        k = minerKey(collection, tokenId);
        records[k] = Record({
            circuits: collection,
            circuitId: uint64(tokenId),
            status: 1,
            nandBurn: nand,
            latchBurn: latch,
            cached: true,
            cachedNand: nand,
            cachedLatch: latch,
            circuitIdOverride: 0
        });
    }

    /// @notice Status changes for tests. REVOKED (2) is terminal, as on the real protocol (a revoked
    ///         circuit can never mine again). Other transitions, such as an ACTIVE miner becoming
    ///         COOLING (3) without a payout, are mock-only fault injection: on the real protocol only
    ///         the NFT holder can stop a miner, and stop() pays the holder first.
    function setStatus(address collection, uint256 tokenId, uint8 status) external {
        Record storage r = records[minerKey(collection, tokenId)];
        require(r.status != 2, "REVOKED_IS_TERMINAL");
        r.status = status;
    }

    function setCachedBurn(address collection, uint256 tokenId, bool cached, uint32 nand, uint32 latch)
        external
    {
        Record storage r = records[minerKey(collection, tokenId)];
        r.cached = cached;
        r.cachedNand = nand;
        r.cachedLatch = latch;
    }

    function setRecordCircuitId(address collection, uint256 tokenId, uint64 circuitId) external {
        records[minerKey(collection, tokenId)].circuitIdOverride = circuitId;
    }

    /// @notice Income visible to `pending`.
    function accrue(address collection, uint256 tokenId, uint256 amount) external {
        rewards[minerKey(collection, tokenId)] += amount;
    }

    /// @notice Income that `claim` settles but `pending` does not report.
    function accrueUnsettled(address collection, uint256 tokenId, uint256 amount) external {
        unsettled[minerKey(collection, tokenId)] += amount;
    }

    function setBroken(bool flag) external {
        broken = flag;
    }

    function setKeyBroken(address collection, uint256 tokenId, bool flag) external {
        keyBroken[minerKey(collection, tokenId)] = flag;
    }

    function getMiner(bytes32 k) external view returns (IMining.MinerRecord memory m) {
        Record storage r = records[k];
        m.circuits = r.circuits;
        m.circuitId = r.circuitIdOverride != 0 ? r.circuitIdOverride : r.circuitId;
        m.status = r.status;
        m.nandBurn = r.nandBurn;
        m.latchBurn = r.latchBurn;
        m.gateCount = r.nandBurn + r.latchBurn;
        m.stateCount = r.latchBurn;
        m.bstar = uint64(r.nandBurn) + r.latchBurn;
        m.area = uint64(r.nandBurn) + r.latchBurn;
        m.mult = 1;
    }

    function cachedBurn(address collection, uint256 tokenId) external view returns (bool, uint32, uint32) {
        Record storage r = records[minerKey(collection, tokenId)];
        return (r.cached, r.cachedNand, r.cachedLatch);
    }

    function pending(bytes32 k) external view returns (uint256) {
        require(!broken, "MINING_BROKEN");
        return rewards[k];
    }

    function claim(bytes32 k) public {
        require(!broken, "MINING_BROKEN");
        if (records[k].status != 1) revert NotActiveMiner(k);
        require(!keyBroken[k], "MINER_BROKEN");
        uint256 n = rewards[k] + unsettled[k];
        rewards[k] = 0;
        unsettled[k] = 0;
        claims++;
        claimCount[k]++;
        lastCaller = msg.sender;
        if (n == 0) return;
        Record storage r = records[k];
        bem.mint(IERC721(r.circuits).ownerOf(r.circuitId), n);
    }

    /// @notice Like the deployed contract: keys that cannot be claimed are skipped silently.
    function claimMany(bytes32[] calldata keys) external {
        for (uint256 i; i < keys.length; ++i) {
            try this.claim(keys[i]) {} catch {}
        }
    }
}

/// @dev ERC-1155 holder that can be told to call something from inside its receive hook.
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

/// @dev ERC-1155 wallet contract whose receive hooks can be told to refuse transfers.
contract ToggleReceiver {
    bool public refuse;

    error Refused();

    function setRefuse(bool flag) external {
        refuse = flag;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        view
        returns (bytes4)
    {
        if (refuse) revert Refused();
        return 0xf23a6e61;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        view
        returns (bytes4)
    {
        if (refuse) revert Refused();
        return 0xbc197c81;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x4e2312e0 || id == 0x01ffc9a7;
    }
}

/// @dev Any other ERC-1155, used to show that the pool and distributor bind only the real receipts.
contract ForeignERC1155 is ERC1155 {
    bytes32 public category;

    constructor(bytes32 category_) ERC1155("") {
        category = category_;
    }

    function mint(address to, uint256 id) external {
        _mint(to, id, 1, "");
    }

    function issuanceFinalized() external pure returns (bool) {
        return true;
    }

    function totalSupply() external pure returns (uint256) {
        return 1;
    }
}
