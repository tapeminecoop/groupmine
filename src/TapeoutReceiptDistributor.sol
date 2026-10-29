// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {TapeoutEntitlementReceipt} from "./TapeoutEntitlementReceipt.sol";
import {TapeoutMinerPool} from "./TapeoutMinerPool.sol";

/// @notice Holds NAND and LATCH receipts until each allocated wallet claims its own. The operator
///         funds it with receipts, imports the allocation (tooling turns the JSON wallet counts into
///         ID ranges), and finalizes; afterwards beneficiaries and allocations are immutable.
///         One distributor serves a processor's two custody pools (the Optimal Pool and the Regular
///         Pool), which share this receipt pair: each receipt is allocated and delivered once, and its
///         holder claims that receipt's income from each pool independently.
/// @dev The two pools are fixed at deployment and cannot be changed, added or removed. They must be
///      distinct contracts reporting the same receipts and the same BEM, Mining and miner collection.
///      "Optimal" and "regular" are the deployment's labels: this contract treats both pools alike, and
///      neither pool enforces any Mining property of the miners it admits.
///      While held here, receipts keep their place in both pools' accounting: nobody can claim their
///      BEM (only a receipt's holder can, and this contract never calls a pool except to read claim
///      history), approve them, or move them anywhere except to their recorded beneficiary. Receipts
///      with BEM claim history in either pool are refused as inventory, and nothing can be received
///      after finalization, so previously distributed receipts can never be redistributed.
contract TapeoutReceiptDistributor is Ownable2Step, ReentrancyGuard, IERC1155Receiver {
    struct Range {
        TapeoutMinerPool.Category category;
        uint64 firstId;
        uint64 count;
        uint64 delivered;
    }

    struct AllocationInput {
        TapeoutMinerPool.Category category;
        address wallet;
        uint64 firstId;
        uint64 count;
    }

    uint256 public constant MAX_RANGE = 1000;
    uint256 public constant MAX_PAGE = 500;

    /// @notice The processor's two custody pools, fixed at deployment.
    TapeoutMinerPool public immutable optimalPool;
    TapeoutMinerPool public immutable regularPool;
    TapeoutEntitlementReceipt public immutable nandReceipt;
    TapeoutEntitlementReceipt public immutable latchReceipt;

    bool public allocationFinalized;
    uint256[2] private _inventory;
    uint256[2] private _allocated;
    uint256[2] private _delivered;
    mapping(TapeoutMinerPool.Category => mapping(uint256 id => address wallet)) private _beneficiary;
    mapping(address wallet => Range[]) private _ranges;
    /// @dev Index of the wallet's first range with undelivered IDs; earlier ranges are complete.
    mapping(address wallet => uint256 index) private _nextRange;
    address[] private _wallets;
    mapping(address wallet => bool) private _listed;

    error InvalidAddress();
    error DuplicatePool();
    error IncompatiblePoolReceipts();
    error IncompatiblePoolProtocol();
    error UnsupportedToken(address token);
    error AllocationClosed();
    error AllocationOpen();
    error IssuanceNotFinalized();
    error InvalidAllocation();
    error NotInInventory(TapeoutMinerPool.Category category, uint256 id);
    error AlreadyAllocated(TapeoutMinerPool.Category category, uint256 id, address wallet);
    error InventoryNotCovered(TapeoutMinerPool.Category category, uint256 allocated, uint256 inventory);
    error InvalidAmount(uint256 id, uint256 value);
    error ConsumedRewardHistory(TapeoutMinerPool.Category category, uint256 id);
    error NothingToDeliver(address wallet);
    error InvalidPage();

    event InventoryReceived(TapeoutMinerPool.Category indexed category, address indexed from, uint256 count);
    event Allocated(
        address indexed wallet, TapeoutMinerPool.Category indexed category, uint256 firstId, uint256 count
    );
    event WalletRevoked(address indexed wallet, uint256 nandCount, uint256 latchCount);
    event AllocationFinalized(uint256 nandCount, uint256 latchCount, uint256 wallets);
    event Delivered(
        address indexed wallet, TapeoutMinerPool.Category indexed category, uint256 firstId, uint256 count
    );

    /// @param optimalPool_ The processor's Optimal Pool.
    /// @param regularPool_ The processor's Regular Pool: a different contract with the same receipts,
    ///        BEM, Mining and miner collection.
    constructor(address owner_, TapeoutMinerPool optimalPool_, TapeoutMinerPool regularPool_)
        Ownable(owner_)
    {
        if (address(optimalPool_).code.length == 0 || address(regularPool_).code.length == 0) {
            revert InvalidAddress();
        }
        if (optimalPool_ == regularPool_) revert DuplicatePool();
        TapeoutEntitlementReceipt nand = optimalPool_.nandReceipt();
        TapeoutEntitlementReceipt latch = optimalPool_.latchReceipt();
        if (regularPool_.nandReceipt() != nand || regularPool_.latchReceipt() != latch) {
            revert IncompatiblePoolReceipts();
        }
        if (
            optimalPool_.bem() != regularPool_.bem() || optimalPool_.mining() != regularPool_.mining()
                || optimalPool_.minerCollection() != regularPool_.minerCollection()
        ) revert IncompatiblePoolProtocol();
        optimalPool = optimalPool_;
        regularPool = regularPool_;
        nandReceipt = nand;
        latchReceipt = latch;
    }

    // ---------------------------------------------------------------------------------- funding

    function onERC1155Received(address, address from, uint256 id, uint256 value, bytes calldata)
        external
        returns (bytes4)
    {
        TapeoutMinerPool.Category category = _categoryOf(msg.sender);
        if (allocationFinalized) revert AllocationClosed();
        if (_acceptOne(category, id, value)) {
            ++_inventory[uint256(category)];
            emit InventoryReceived(category, from, 1);
        }
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address from,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata
    ) external returns (bytes4) {
        TapeoutMinerPool.Category category = _categoryOf(msg.sender);
        if (allocationFinalized) revert AllocationClosed();
        uint256 accepted;
        for (uint256 i; i < ids.length; ++i) {
            if (_acceptOne(category, ids[i], values[i])) ++accepted;
        }
        _inventory[uint256(category)] += accepted;
        emit InventoryReceived(category, from, accepted);
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    // ---------------------------------------------------------------------------------- allocation

    /// @notice Record beneficiaries for ranges of IDs held as inventory. Each ID once.
    function allocate(AllocationInput[] calldata entries) external onlyOwner {
        if (allocationFinalized) revert AllocationClosed();
        if (entries.length == 0) revert InvalidAllocation();
        for (uint256 e; e < entries.length; ++e) {
            AllocationInput calldata a = entries[e];
            if (
                a.wallet == address(0) || a.wallet == address(this) || a.wallet == address(optimalPool)
                    || a.wallet == address(regularPool) || a.count == 0 || a.count > MAX_RANGE
                    || a.firstId == 0
            ) revert InvalidAllocation();
            address[] memory holders = _receipt(a.category).holdersPage(a.firstId, a.count);
            mapping(uint256 => address) storage beneficiary = _beneficiary[a.category];
            for (uint256 i; i < a.count; ++i) {
                uint256 id = uint256(a.firstId) + i;
                if (holders[i] != address(this)) revert NotInInventory(a.category, id);
                if (beneficiary[id] != address(0)) revert AlreadyAllocated(a.category, id, beneficiary[id]);
                beneficiary[id] = a.wallet;
            }
            if (!_listed[a.wallet]) {
                _listed[a.wallet] = true;
                _wallets.push(a.wallet);
            }
            _ranges[a.wallet]
            .push(Range({category: a.category, firstId: a.firstId, count: a.count, delivered: 0}));
            _allocated[uint256(a.category)] += a.count;
            emit Allocated(a.wallet, a.category, a.firstId, a.count);
        }
    }

    /// @notice Before finalization, remove every range allocated to `wallet` (to correct an import).
    function revokeWallet(address wallet) external onlyOwner {
        if (allocationFinalized) revert AllocationClosed();
        Range[] storage list = _ranges[wallet];
        uint256[2] memory removed;
        for (uint256 r; r < list.length; ++r) {
            Range storage range = list[r];
            mapping(uint256 => address) storage beneficiary = _beneficiary[range.category];
            for (uint256 i; i < range.count; ++i) {
                delete beneficiary[uint256(range.firstId) + i];
            }
            removed[uint256(range.category)] += range.count;
        }
        _allocated[0] -= removed[0];
        _allocated[1] -= removed[1];
        delete _ranges[wallet];
        emit WalletRevoked(wallet, removed[0], removed[1]);
    }

    /// @notice Freeze the allocation and open claims. Every held receipt must be allocated, and both
    ///         receipt collections must have finalized issuance.
    function finalizeAllocation() external onlyOwner {
        if (allocationFinalized) revert AllocationClosed();
        if (!nandReceipt.issuanceFinalized() || !latchReceipt.issuanceFinalized()) {
            revert IssuanceNotFinalized();
        }
        for (uint256 c; c < 2; ++c) {
            if (_allocated[c] != _inventory[c]) {
                revert InventoryNotCovered(TapeoutMinerPool.Category(c), _allocated[c], _inventory[c]);
            }
        }
        allocationFinalized = true;
        emit AllocationFinalized(_inventory[0], _inventory[1], _wallets.length);
    }

    // ---------------------------------------------------------------------------------- delivery

    /// @notice Deliver up to `maxIds` of the caller's allocated receipts to the caller.
    function claim(uint256 maxIds) external nonReentrant returns (uint256 delivered) {
        return _deliver(msg.sender, maxIds);
    }

    /// @notice Push up to `maxIds` of `wallet`'s allocated receipts to `wallet` itself. Anyone may call;
    ///         the destination is always the recorded beneficiary.
    function deliver(address wallet, uint256 maxIds) external nonReentrant returns (uint256 delivered) {
        return _deliver(wallet, maxIds);
    }

    // ---------------------------------------------------------------------------------- views

    /// @notice Whether `candidate` is one of the two custody pools this distributor serves.
    function isPool(address candidate) external view returns (bool) {
        return candidate == address(optimalPool) || candidate == address(regularPool);
    }

    function beneficiaryOf(TapeoutMinerPool.Category category, uint256 id) external view returns (address) {
        return _beneficiary[category][id];
    }

    function rangesOf(address wallet) external view returns (Range[] memory) {
        return _ranges[wallet];
    }

    /// @notice Allocated and still undelivered IDs of `wallet`, per category.
    function pendingOf(address wallet) external view returns (uint256 nandCount, uint256 latchCount) {
        Range[] storage list = _ranges[wallet];
        for (uint256 r = _nextRange[wallet]; r < list.length; ++r) {
            uint256 left = list[r].count - list[r].delivered;
            if (list[r].category == TapeoutMinerPool.Category.NAND) nandCount += left;
            else latchCount += left;
        }
    }

    /// @notice Index in `rangesOf(wallet)` of the first range with undelivered IDs (the next delivery
    ///         starts there); equal to the number of ranges once everything is delivered.
    function nextRangeOf(address wallet) external view returns (uint256) {
        return _nextRange[wallet];
    }

    function walletCount() external view returns (uint256) {
        return _wallets.length;
    }

    function walletsPage(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 length = _wallets.length;
        if (limit == 0 || limit > MAX_PAGE || offset > length) revert InvalidPage();
        uint256 count = limit > length - offset ? length - offset : limit;
        page = new address[](count);
        for (uint256 i; i < count; ++i) {
            page[i] = _wallets[offset + i];
        }
    }

    /// @notice Inventory received, allocated and delivered per category ([NAND, LATCH]).
    function totals()
        external
        view
        returns (uint256[2] memory inventory, uint256[2] memory allocated, uint256[2] memory delivered)
    {
        return (_inventory, _allocated, _delivered);
    }

    // ---------------------------------------------------------------------------------- internals

    function _categoryOf(address token) private view returns (TapeoutMinerPool.Category) {
        if (token == address(nandReceipt)) return TapeoutMinerPool.Category.NAND;
        if (token == address(latchReceipt)) return TapeoutMinerPool.Category.LATCH;
        revert UnsupportedToken(token);
    }

    function _receipt(TapeoutMinerPool.Category category) private view returns (TapeoutEntitlementReceipt) {
        return category == TapeoutMinerPool.Category.NAND ? nandReceipt : latchReceipt;
    }

    /// @dev Inventory must be fresh: a receipt whose BEM has ever been claimed, in either pool, is refused.
    function _acceptOne(TapeoutMinerPool.Category category, uint256 id, uint256 value)
        private
        view
        returns (bool)
    {
        if (value == 0) return false;
        if (value != 1) revert InvalidAmount(id, value);
        if (optimalPool.claimed(category, id) != 0 || regularPool.claimed(category, id) != 0) {
            revert ConsumedRewardHistory(category, id);
        }
        return true;
    }

    /// @dev Starts at the wallet's cursor, so a delivery pays only for the ranges and IDs it transfers,
    ///      however many ranges were completed before. Every range from the cursor on has undelivered
    ///      IDs (ranges hold at least one ID and only this function delivers). All bookkeeping, the
    ///      cursor included, is written before each transfer; a failing receiver reverts all of it.
    function _deliver(address wallet, uint256 maxIds) private returns (uint256 total) {
        if (!allocationFinalized) revert AllocationOpen();
        Range[] storage list = _ranges[wallet];
        uint256 length = list.length;
        for (uint256 r = _nextRange[wallet]; r < length && total < maxIds; ++r) {
            Range storage range = list[r];
            uint256 left = range.count - range.delivered;
            uint256 n = left < maxIds - total ? left : maxIds - total;
            uint256 first = uint256(range.firstId) + range.delivered;
            range.delivered += uint64(n);
            _delivered[uint256(range.category)] += n;
            total += n;
            if (n == left) _nextRange[wallet] = r + 1;
            uint256[] memory ids = new uint256[](n);
            uint256[] memory values = new uint256[](n);
            for (uint256 i; i < n; ++i) {
                ids[i] = first + i;
                values[i] = 1;
            }
            _receipt(range.category).safeBatchTransferFrom(address(this), wallet, ids, values, "");
            emit Delivered(wallet, range.category, first, n);
        }
        if (total == 0) revert NothingToDeliver(wallet);
    }
}
