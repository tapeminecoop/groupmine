// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IMining} from "./interfaces/IMining.sol";
import {PoolMath} from "./PoolMath.sol";
import {TapeoutReceipt} from "./TapeoutReceipt.sol";

/// @title TapeOut multi-miner custody and BEM distribution pool
/// @notice Holds any number of TapeOut miner NFTs, collects their BEM through the real
///         `Mining.claim` path, and distributes the BEM it actually receives to:
///         the fee recipient (2 of 102 parts), NAND receipt IDs, LATCH receipt IDs, and the
///         historical NAND/LATCH recipients, according to a configuration fixed at activation.
/// @dev Lifecycle: SETUP (owner configures, issues every receipt ID, may deposit miners)
///      -> `activate` (one-way) -> ACTIVE (economics and supply frozen; harvest, claims, releases).
///      There is no miner withdrawal, BEM withdrawal, pause, upgrade, or arbitrary call path.
///      Accounting is balance-based and cumulative; see PoolMath for the allocation functions.
///      Accounting/payment checks follow GroupBuyVault in TapeoutMarket/test1 (commit 9d86a26).
contract TapeoutMinerPool is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Category {
        NAND,
        LATCH
    }

    enum Recipient {
        FEE,
        HISTORICAL_NAND,
        HISTORICAL_LATCH
    }

    struct ReceiptMetadata {
        string name;
        string symbol;
        string uri;
    }

    struct Deployment {
        address owner;
        address bem;
        address mining;
        address minerCollection;
        string poolName;
        ReceiptMetadata nand;
        ReceiptMetadata latch;
    }

    /// @notice Manually decided economic inputs. Shares are counts; weight uses 8 decimals.
    struct Config {
        uint64 nandShares; // S_N: NAND receipt IDs 1..S_N, all issued before activation
        uint64 latchShares; // S_L: LATCH receipt IDs 1..S_L
        uint64 historicalNandShares; // H_N: extra NAND shares paid to historicalNandRecipient
        uint64 historicalLatchShares; // H_L: extra LATCH shares paid to historicalLatchRecipient
        uint32 nandWeight; // W_N in units of 1e-8; LATCH weight is 1e8 - W_N
        address feeRecipient;
        address historicalNandRecipient;
        address historicalLatchRecipient;
    }

    /// @notice balance + deficit == sum(accrued - paid) + residue + unrecognized.
    struct Reconciliation {
        uint256 bemBalance;
        uint256 unrecognized;
        uint256 deficit;
        uint256 totalAccounted;
        uint256 totalPaid;
        uint256 feeAccrued;
        uint256 feePaid;
        uint256 nandReceiptsAccrued;
        uint256 nandReceiptsPaid;
        uint256 latchReceiptsAccrued;
        uint256 latchReceiptsPaid;
        uint256 historicalNandAccrued;
        uint256 historicalNandPaid;
        uint256 historicalLatchAccrued;
        uint256 historicalLatchPaid;
        uint256 residue;
    }

    string public constant VERSION = "TapeoutMinerPool/1.0.0";
    uint256 public constant WEIGHT_SCALE = PoolMath.WEIGHT_SCALE;
    uint256 public constant FEE_PARTS = PoolMath.FEE_PARTS;
    uint256 public constant ENTITLEMENT_PARTS = PoolMath.ENTITLEMENT_PARTS;
    uint256 public constant TOTAL_PARTS = PoolMath.TOTAL_PARTS;
    uint256 public constant MAX_PAGE = 500;

    IERC20 public immutable bem;
    IMining public immutable mining;
    IERC721 public immutable minerCollection;
    TapeoutReceipt public immutable nandReceipt;
    TapeoutReceipt public immutable latchReceipt;

    string public poolName;
    bool public active;
    uint64 public activatedAt;
    bytes32 public activationConfigHash;

    Config private _config;

    uint256 public totalAccounted;
    uint256 public totalPaid;
    uint256 public feePaid;
    uint256[2] private _receiptsPaid;
    uint256[2] private _historicalPaid;
    mapping(Category => mapping(uint256 id => uint256 amount)) private _claimed;

    uint256[] private _miners;
    mapping(uint256 tokenId => bytes32 key) private _minerKeys;
    mapping(uint256 tokenId => bool registered) public isMiner;

    error AlreadyActive();
    error NotActive();
    error InvalidAddress();
    error InvalidName();
    error InvalidBatch();
    error InvalidWeight(uint256 nandWeight);
    error ShareCountBelowIssued(Category category, uint256 shares, uint256 highestMintedId);
    error MissingRecipient(Recipient role);
    error ZeroDenominator(Category category);
    error IssuanceIncomplete(Category category, uint256 issued, uint256 required);
    error ConfigHashMismatch(bytes32 expected, bytes32 actual);
    error ReceiptIdOutOfRange(Category category, uint256 id);
    error NotHolder(Category category, uint256 id);
    error UnknownMiner(uint256 tokenId);
    error MinerAlreadyRegistered(uint256 tokenId);
    error MinerNotHeld(uint256 tokenId);
    error InvalidPage();
    error Unauthorized();
    error BalanceDecreased(uint256 balance, uint256 expected);
    error UnexpectedTokenBehavior();

    event Configured(bytes32 indexed configHash, Config config);
    event ReceiptsIssued(Category indexed category, uint256 count, uint256 issuedTotal);
    event ReceiptsRevoked(Category indexed category, uint256[] ids);
    event Activated(bytes32 indexed configHash, Config config, uint256 activatedAt);
    event MinerRegistered(
        uint256 indexed tokenId,
        bytes32 indexed key,
        address indexed depositor,
        uint256 index,
        uint256 collected
    );
    event IncomeRecognized(uint256 received, uint256 totalAccounted);
    event MinerHarvested(uint256 indexed tokenId, uint256 received);
    event MinerHarvestFailed(uint256 indexed tokenId, bytes reason);
    event Harvested(address indexed caller, uint256 attempted, uint256 failed, uint256 received);
    event ReceiptIncomeClaimed(
        Category indexed category, uint256 indexed id, address indexed holder, uint256 amount
    );
    event FeeReleased(address indexed recipient, uint256 amount);
    event HistoricalReleased(Category indexed category, address indexed recipient, uint256 amount);
    event RecipientChanged(Recipient indexed role, address indexed previous, address indexed current);

    constructor(Deployment memory d) Ownable(d.owner) {
        if (d.bem.code.length == 0 || d.mining.code.length == 0 || d.minerCollection.code.length == 0) {
            revert InvalidAddress();
        }
        if (bytes(d.poolName).length == 0 || bytes(d.poolName).length > 64) revert InvalidName();
        bem = IERC20(d.bem);
        mining = IMining(d.mining);
        minerCollection = IERC721(d.minerCollection);
        poolName = d.poolName;
        nandReceipt = new TapeoutReceipt(d.nand.name, d.nand.symbol, d.nand.uri);
        latchReceipt = new TapeoutReceipt(d.latch.name, d.latch.symbol, d.latch.uri);
    }

    // ---------------------------------------------------------------------------------------------
    // Setup (owner, before activation)
    // ---------------------------------------------------------------------------------------------

    /// @notice Set or replace the whole configuration. Share counts may not drop below an
    ///         already-minted ID, so every issued ID always lies inside 1..S.
    function configure(Config calldata c) external onlyOwner {
        _requireSetup();
        if (c.nandWeight > WEIGHT_SCALE) revert InvalidWeight(c.nandWeight);
        uint256 nandHighest = nandReceipt.highestMintedId();
        if (c.nandShares < nandHighest) {
            revert ShareCountBelowIssued(Category.NAND, c.nandShares, nandHighest);
        }
        uint256 latchHighest = latchReceipt.highestMintedId();
        if (c.latchShares < latchHighest) {
            revert ShareCountBelowIssued(Category.LATCH, c.latchShares, latchHighest);
        }
        if (
            c.feeRecipient == address(this) || c.historicalNandRecipient == address(this)
                || c.historicalLatchRecipient == address(this)
        ) revert InvalidAddress();
        _config = c;
        emit Configured(configHash(c), c);
    }

    /// @notice Mint receipt IDs to explicit holders, one ID per entry.
    function issueReceipts(Category category, address[] calldata holders, uint256[] calldata ids)
        external
        onlyOwner
    {
        _requireSetup();
        if (ids.length == 0 || holders.length != ids.length) revert InvalidBatch();
        TapeoutReceipt receipt = receiptOf(category);
        uint256 limit = shareCount(category);
        for (uint256 i; i < ids.length; ++i) {
            if (ids[i] == 0 || ids[i] > limit) revert ReceiptIdOutOfRange(category, ids[i]);
            receipt.mint(holders[i], ids[i]);
        }
        emit ReceiptsIssued(category, ids.length, receipt.totalSupply());
    }

    /// @notice Mint the contiguous IDs firstId..firstId+count-1 to one holder.
    function issueReceiptRange(Category category, address holder, uint256 firstId, uint256 count)
        external
        onlyOwner
    {
        _requireSetup();
        if (firstId == 0 || count == 0) revert InvalidBatch();
        uint256 lastId = firstId + count - 1;
        if (lastId > shareCount(category)) revert ReceiptIdOutOfRange(category, lastId);
        uint256[] memory ids = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = firstId + i;
        }
        TapeoutReceipt receipt = receiptOf(category);
        receipt.mintBatch(holder, ids);
        emit ReceiptsIssued(category, count, receipt.totalSupply());
    }

    /// @notice Burn wrongly issued IDs so they can be re-issued. Impossible after activation.
    function revokeReceipts(Category category, uint256[] calldata ids) external onlyOwner {
        _requireSetup();
        if (ids.length == 0) revert InvalidBatch();
        TapeoutReceipt receipt = receiptOf(category);
        for (uint256 i; i < ids.length; ++i) {
            receipt.burn(ids[i]);
        }
        emit ReceiptsRevoked(category, ids);
    }

    /// @notice One-way switch to ACTIVE. Requires a complete, valid configuration whose hash the
    ///         caller has reviewed, and exactly the IDs 1..S issued in each collection. Closes
    ///         minting permanently and recognizes any BEM already held as pool income.
    function activate(bytes32 expectedConfigHash) external onlyOwner nonReentrant {
        _requireSetup();
        Config memory c = _config;
        bytes32 actual = configHash(c);
        if (actual != expectedConfigHash) revert ConfigHashMismatch(expectedConfigHash, actual);
        _validateForActivation(c);
        active = true;
        activatedAt = uint64(block.timestamp);
        activationConfigHash = actual;
        nandReceipt.finalizeMinting();
        latchReceipt.finalizeMinting();
        emit Activated(actual, c, block.timestamp);
        _sync();
    }

    function setReceiptURI(Category category, string calldata uri_) external onlyOwner {
        receiptOf(category).setURI(uri_);
    }

    // ---------------------------------------------------------------------------------------------
    // Miner custody (owner, any phase)
    // ---------------------------------------------------------------------------------------------

    /// @notice Pull miners from the caller (requires ERC-721 approval) and register them.
    function depositMiners(uint256[] calldata tokenIds) external onlyOwner nonReentrant {
        if (tokenIds.length == 0) revert InvalidBatch();
        for (uint256 i; i < tokenIds.length; ++i) {
            minerCollection.transferFrom(msg.sender, address(this), tokenIds[i]);
            _registerMiner(tokenIds[i], msg.sender);
        }
        if (active) _sync();
    }

    /// @notice Register miners that reached the pool without `depositMiners` (plain transferFrom).
    function registerMiners(uint256[] calldata tokenIds) external onlyOwner nonReentrant {
        if (tokenIds.length == 0) revert InvalidBatch();
        for (uint256 i; i < tokenIds.length; ++i) {
            _registerMiner(tokenIds[i], address(0));
        }
        if (active) _sync();
    }

    // ---------------------------------------------------------------------------------------------
    // Income collection (anyone, ACTIVE)
    // ---------------------------------------------------------------------------------------------

    /// @notice Recognize BEM that reached the pool by any route (harvests, third-party
    ///         Mining.claim calls on pool miners, direct transfers) as pool income.
    function sync() external nonReentrant returns (uint256 received) {
        _requireActive();
        received = _sync();
    }

    /// @notice Call Mining.claim for each listed registered miner and account the BEM received.
    /// @dev Always calls claim (never gated on `pending`). A miner whose claim reverts is reported
    ///      with MinerHarvestFailed and counted in `failed`; it is never treated as a zero claim
    ///      and never blocks the other miners. Only actual balance increases are accounted.
    function harvest(uint256[] calldata tokenIds)
        external
        nonReentrant
        returns (uint256 received, uint256 failed)
    {
        _requireActive();
        if (tokenIds.length == 0) revert InvalidBatch();
        _sync();
        uint256 balance = bem.balanceOf(address(this));
        for (uint256 i; i < tokenIds.length; ++i) {
            if (!isMiner[tokenIds[i]]) revert UnknownMiner(tokenIds[i]);
            bool ok;
            (ok, balance) = _harvestOne(tokenIds[i], balance);
            if (!ok) ++failed;
        }
        received = _sync();
        emit Harvested(msg.sender, tokenIds.length, failed, received);
    }

    /// @notice Harvest registry entries [start, start+count) (clamped to the registry length).
    function harvestRange(uint256 start, uint256 count)
        external
        nonReentrant
        returns (uint256 received, uint256 failed)
    {
        _requireActive();
        uint256 length = _miners.length;
        if (count == 0 || start >= length) revert InvalidBatch();
        uint256 end = count > length - start ? length : start + count;
        _sync();
        uint256 balance = bem.balanceOf(address(this));
        for (uint256 i = start; i < end; ++i) {
            bool ok;
            (ok, balance) = _harvestOne(_miners[i], balance);
            if (!ok) ++failed;
        }
        received = _sync();
        emit Harvested(msg.sender, end - start, failed, received);
    }

    // ---------------------------------------------------------------------------------------------
    // Claims and releases (ACTIVE)
    // ---------------------------------------------------------------------------------------------

    /// @notice Claim the income attached to one receipt ID held by the caller.
    function claim(Category category, uint256 id) external nonReentrant returns (uint256 amount) {
        _requireActive();
        _sync();
        PoolMath.Accrual memory a = _accrual(totalAccounted);
        uint256 perShare = category == Category.NAND ? a.perNandShare : a.perLatchShare;
        amount = _claimOne(category, id, perShare, shareCount(category));
        _receiptsPaid[uint256(category)] += amount;
        _pay(msg.sender, amount);
    }

    /// @notice Claim the income attached to any number of NAND and LATCH IDs held by the caller.
    function claimBatch(uint256[] calldata nandIds, uint256[] calldata latchIds)
        external
        nonReentrant
        returns (uint256 amount)
    {
        _requireActive();
        if (nandIds.length == 0 && latchIds.length == 0) revert InvalidBatch();
        _sync();
        PoolMath.Accrual memory a = _accrual(totalAccounted);
        amount = _claimMany(Category.NAND, nandIds, a.perNandShare)
            + _claimMany(Category.LATCH, latchIds, a.perLatchShare);
        _pay(msg.sender, amount);
    }

    /// @notice Pay the accrued fee to the fee recipient. Callable by anyone.
    function releaseFee() external nonReentrant returns (uint256 amount) {
        _requireActive();
        _sync();
        uint256 accrued = _accrual(totalAccounted).fee;
        amount = accrued - feePaid;
        feePaid = accrued;
        address to = _config.feeRecipient;
        _pay(to, amount);
        emit FeeReleased(to, amount);
    }

    /// @notice Pay a category's accrued historical income to its recipient. Callable by anyone.
    function releaseHistorical(Category category) external nonReentrant returns (uint256 amount) {
        _requireActive();
        _sync();
        PoolMath.Accrual memory a = _accrual(totalAccounted);
        uint256 accrued = category == Category.NAND ? a.historicalNand : a.historicalLatch;
        uint256 index = uint256(category);
        amount = accrued - _historicalPaid[index];
        _historicalPaid[index] = accrued;
        address to =
            recipientOf(category == Category.NAND ? Recipient.HISTORICAL_NAND : Recipient.HISTORICAL_LATCH);
        _pay(to, amount);
        emit HistoricalReleased(category, to, amount);
    }

    /// @notice After activation only the current holder of a recipient role can move it. Unreleased
    ///         income stays with the role. The owner has no power over recipients once ACTIVE.
    function setRecipient(Recipient role, address newRecipient) external {
        _requireActive();
        address current = recipientOf(role);
        if (msg.sender != current) revert Unauthorized();
        if (newRecipient == address(0) || newRecipient == address(this)) revert InvalidAddress();
        if (role == Recipient.FEE) _config.feeRecipient = newRecipient;
        else if (role == Recipient.HISTORICAL_NAND) _config.historicalNandRecipient = newRecipient;
        else _config.historicalLatchRecipient = newRecipient;
        emit RecipientChanged(role, current, newRecipient);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function config() external view returns (Config memory) {
        return _config;
    }

    function configHash(Config memory c) public pure returns (bytes32) {
        return keccak256(abi.encode(c));
    }

    function currentConfigHash() external view returns (bytes32) {
        return configHash(_config);
    }

    function receiptOf(Category category) public view returns (TapeoutReceipt) {
        return category == Category.NAND ? nandReceipt : latchReceipt;
    }

    function shareCount(Category category) public view returns (uint256) {
        return category == Category.NAND ? _config.nandShares : _config.latchShares;
    }

    function historicalShareCount(Category category) external view returns (uint256) {
        return category == Category.NAND ? _config.historicalNandShares : _config.historicalLatchShares;
    }

    function recipientOf(Recipient role) public view returns (address) {
        if (role == Recipient.FEE) return _config.feeRecipient;
        if (role == Recipient.HISTORICAL_NAND) return _config.historicalNandRecipient;
        return _config.historicalLatchRecipient;
    }

    /// @notice Issued IDs versus the configured active share count S (minting capacity left).
    function issuance(Category category)
        external
        view
        returns (uint256 shares, uint256 issued, uint256 remaining, bool mintingFinalized)
    {
        TapeoutReceipt receipt = receiptOf(category);
        shares = shareCount(category);
        issued = receipt.totalSupply();
        remaining = active || issued >= shares ? 0 : shares - issued;
        mintingFinalized = receipt.mintingFinalized();
    }

    /// @notice Allocation of the income already recognized (totalAccounted).
    function accrual() external view returns (PoolMath.Accrual memory) {
        return _accrual(totalAccounted);
    }

    /// @notice Allocation as it will be after the next sync (includes unrecognized balance).
    function previewAccrual() public view returns (PoolMath.Accrual memory) {
        return _accrual(totalAccounted + unrecognizedBalance());
    }

    /// @notice BEM held beyond what the ledger expects; recognized by the next sync.
    function unrecognizedBalance() public view returns (uint256) {
        uint256 balance = bem.balanceOf(address(this));
        uint256 expected = totalAccounted - totalPaid;
        if (balance < expected) revert BalanceDecreased(balance, expected);
        return balance - expected;
    }

    function claimed(Category category, uint256 id) external view returns (uint256) {
        return _claimed[category][id];
    }

    /// @notice Income the current holder of `id` can claim now (including unrecognized balance).
    function claimable(Category category, uint256 id) public view returns (uint256) {
        if (id == 0 || id > shareCount(category)) revert ReceiptIdOutOfRange(category, id);
        if (!active) return 0;
        PoolMath.Accrual memory a = previewAccrual();
        uint256 perShare = category == Category.NAND ? a.perNandShare : a.perLatchShare;
        return perShare - _claimed[category][id];
    }

    function claimableBatch(Category category, uint256[] calldata ids)
        external
        view
        returns (uint256[] memory amounts, uint256 total)
    {
        amounts = new uint256[](ids.length);
        if (ids.length == 0) return (amounts, 0);
        uint256 limit = shareCount(category);
        uint256 perShare;
        if (active) {
            PoolMath.Accrual memory a = previewAccrual();
            perShare = category == Category.NAND ? a.perNandShare : a.perLatchShare;
        }
        mapping(uint256 => uint256) storage history = _claimed[category];
        for (uint256 i; i < ids.length; ++i) {
            if (ids[i] == 0 || ids[i] > limit) revert ReceiptIdOutOfRange(category, ids[i]);
            if (!active) continue;
            amounts[i] = perShare - history[ids[i]];
            total += amounts[i];
        }
    }

    function feeClaimable() external view returns (uint256) {
        if (!active) return 0;
        return previewAccrual().fee - feePaid;
    }

    function historicalClaimable(Category category) external view returns (uint256) {
        if (!active) return 0;
        PoolMath.Accrual memory a = previewAccrual();
        uint256 accrued = category == Category.NAND ? a.historicalNand : a.historicalLatch;
        return accrued - _historicalPaid[uint256(category)];
    }

    function receiptsPaid(Category category) external view returns (uint256) {
        return _receiptsPaid[uint256(category)];
    }

    function historicalPaid(Category category) external view returns (uint256) {
        return _historicalPaid[uint256(category)];
    }

    /// @notice Full ledger snapshot. Identity: bemBalance + deficit == sum over buckets of
    ///         (accrued - paid) + residue + unrecognized, and totalPaid == sum of paid buckets.
    function reconciliation() external view returns (Reconciliation memory r) {
        r.bemBalance = bem.balanceOf(address(this));
        r.totalAccounted = totalAccounted;
        r.totalPaid = totalPaid;
        uint256 expected = totalAccounted - totalPaid;
        if (r.bemBalance >= expected) r.unrecognized = r.bemBalance - expected;
        else r.deficit = expected - r.bemBalance;
        PoolMath.Accrual memory a = _accrual(totalAccounted);
        r.feeAccrued = a.fee;
        r.feePaid = feePaid;
        r.nandReceiptsAccrued = a.nandReceipts;
        r.nandReceiptsPaid = _receiptsPaid[0];
        r.latchReceiptsAccrued = a.latchReceipts;
        r.latchReceiptsPaid = _receiptsPaid[1];
        r.historicalNandAccrued = a.historicalNand;
        r.historicalNandPaid = _historicalPaid[0];
        r.historicalLatchAccrued = a.historicalLatch;
        r.historicalLatchPaid = _historicalPaid[1];
        r.residue = a.residue;
    }

    function minerCount() external view returns (uint256) {
        return _miners.length;
    }

    function minerAt(uint256 index) external view returns (uint256 tokenId, bytes32 key) {
        tokenId = _miners[index];
        key = _minerKeys[tokenId];
    }

    function minerKeyOf(uint256 tokenId) external view returns (bytes32) {
        if (!isMiner[tokenId]) revert UnknownMiner(tokenId);
        return _minerKeys[tokenId];
    }

    function minersPage(uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory tokenIds, bytes32[] memory keys)
    {
        uint256 length = _miners.length;
        if (limit == 0 || limit > MAX_PAGE || offset > length) revert InvalidPage();
        uint256 count = limit > length - offset ? length - offset : limit;
        tokenIds = new uint256[](count);
        keys = new bytes32[](count);
        for (uint256 i; i < count; ++i) {
            tokenIds[i] = _miners[offset + i];
            keys[i] = _minerKeys[tokenIds[i]];
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _requireSetup() internal view {
        if (active) revert AlreadyActive();
    }

    function _requireActive() internal view {
        if (!active) revert NotActive();
    }

    function _validateForActivation(Config memory c) internal view {
        if (c.nandWeight > WEIGHT_SCALE) revert InvalidWeight(c.nandWeight);
        if (c.feeRecipient == address(0)) revert MissingRecipient(Recipient.FEE);
        if (c.historicalNandShares != 0 && c.historicalNandRecipient == address(0)) {
            revert MissingRecipient(Recipient.HISTORICAL_NAND);
        }
        if (c.historicalLatchShares != 0 && c.historicalLatchRecipient == address(0)) {
            revert MissingRecipient(Recipient.HISTORICAL_LATCH);
        }
        // A category that receives income must have somebody to receive it.
        if (c.nandWeight != 0 && uint256(c.nandShares) + c.historicalNandShares == 0) {
            revert ZeroDenominator(Category.NAND);
        }
        if (c.nandWeight != WEIGHT_SCALE && uint256(c.latchShares) + c.historicalLatchShares == 0) {
            revert ZeroDenominator(Category.LATCH);
        }
        _validateIssuance(Category.NAND, c.nandShares);
        _validateIssuance(Category.LATCH, c.latchShares);
    }

    /// @dev Every minted ID is <= S (enforced at mint and by `configure`), so `issued == S`
    ///      means the live IDs are exactly 1..S: no unissued share can dilute or orphan income.
    function _validateIssuance(Category category, uint256 shares) internal view {
        TapeoutReceipt receipt = receiptOf(category);
        uint256 issued = receipt.totalSupply();
        if (issued != shares || receipt.highestMintedId() > shares) {
            revert IssuanceIncomplete(category, issued, shares);
        }
    }

    function _registerMiner(uint256 tokenId, address depositor) internal {
        if (isMiner[tokenId]) revert MinerAlreadyRegistered(tokenId);
        if (minerCollection.ownerOf(tokenId) != address(this)) revert MinerNotHeld(tokenId);
        bytes32 key = mining.minerKey(address(minerCollection), tokenId);
        isMiner[tokenId] = true;
        _minerKeys[tokenId] = key;
        _miners.push(tokenId);
        // Registration requires the real claim path to accept the key. It also collects the
        // income the miner carried into the pool, which belongs to the pool like any other income.
        uint256 beforeBalance = bem.balanceOf(address(this));
        mining.claim(key);
        uint256 afterBalance = bem.balanceOf(address(this));
        emit MinerRegistered(
            tokenId,
            key,
            depositor,
            _miners.length - 1,
            afterBalance > beforeBalance ? afterBalance - beforeBalance : 0
        );
    }

    function _harvestOne(uint256 tokenId, uint256 beforeBalance) internal returns (bool ok, uint256 balance) {
        try mining.claim(_minerKeys[tokenId]) {
            balance = bem.balanceOf(address(this));
            // A decrease cannot be income; it is rejected by the following _sync.
            emit MinerHarvested(tokenId, balance > beforeBalance ? balance - beforeBalance : 0);
            ok = true;
        } catch (bytes memory reason) {
            balance = beforeBalance;
            emit MinerHarvestFailed(tokenId, reason);
        }
    }

    function _claimMany(Category category, uint256[] calldata ids, uint256 perShare)
        internal
        returns (uint256 total)
    {
        if (ids.length == 0) return 0;
        uint256 limit = shareCount(category);
        for (uint256 i; i < ids.length; ++i) {
            total += _claimOne(category, ids[i], perShare, limit);
        }
        _receiptsPaid[uint256(category)] += total;
    }

    function _claimOne(Category category, uint256 id, uint256 perShare, uint256 limit)
        internal
        returns (uint256 due)
    {
        if (id == 0 || id > limit) revert ReceiptIdOutOfRange(category, id);
        // Only the current holder can claim; ERC-1155 operators must transfer the ID first.
        if (receiptOf(category).balanceOf(msg.sender, id) != 1) revert NotHolder(category, id);
        mapping(uint256 => uint256) storage history = _claimed[category];
        due = perShare - history[id];
        history[id] = perShare;
        emit ReceiptIncomeClaimed(category, id, msg.sender, due);
    }

    function _accrual(uint256 total) internal view returns (PoolMath.Accrual memory) {
        Config storage c = _config;
        return PoolMath.accrue(
            total,
            PoolMath.Shares({
                nandShares: c.nandShares,
                latchShares: c.latchShares,
                historicalNandShares: c.historicalNandShares,
                historicalLatchShares: c.historicalLatchShares,
                nandWeight: c.nandWeight
            })
        );
    }

    /// @dev Recognize BEM that arrived since the last sync: balance + totalPaid - totalAccounted.
    function _sync() internal returns (uint256 received) {
        uint256 balance = bem.balanceOf(address(this));
        uint256 expected = totalAccounted - totalPaid;
        if (balance < expected) revert BalanceDecreased(balance, expected);
        received = balance - expected;
        if (received != 0) {
            totalAccounted += received;
            emit IncomeRecognized(received, totalAccounted);
        }
    }

    /// @dev Plain, non-rebasing, fee-free BEM only: both balance deltas must be exact.
    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        uint256 selfBefore = bem.balanceOf(address(this));
        uint256 toBefore = bem.balanceOf(to);
        totalPaid += amount;
        bem.safeTransfer(to, amount);
        if (bem.balanceOf(address(this)) != selfBefore - amount || bem.balanceOf(to) != toBefore + amount) {
            revert UnexpectedTokenBehavior();
        }
    }
}
