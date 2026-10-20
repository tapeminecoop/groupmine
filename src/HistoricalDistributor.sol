// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TapeoutMinerPool} from "./TapeoutMinerPool.sol";

/// @title Historical income distributor for one TapeoutMinerPool category
/// @notice Serves as a pool's historical NAND or LATCH recipient and splits the BEM it actually
///         receives among a fixed list of historical contributors in proportion to manually decided
///         integer weights. Accounts and weights are fixed at deployment: there is no owner, no
///         withdrawal, no upgrade path, and no way to change, add or remove a contributor.
/// @dev Accounting follows the pool (see docs/ARCHITECTURE.md §8):
///      received          = balance + totalPaid - totalAccounted            (recognized on every sync)
///      entitlement(i)    = floor(totalAccounted * weight(i) / totalWeight)  (cumulative, monotonic)
///      claimable(i)      = entitlement(i) - claimed(i)
///      residue           = totalAccounted - sum of entitlements, 0 <= residue <= contributorCount - 1
///      The contributor list is stored sorted by address (strictly ascending, which also rejects the
///      zero address and duplicates), one storage slot per contributor.
contract HistoricalDistributor is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Contributor {
        address account;
        uint96 weight;
    }

    /// @notice bemBalance + deficit == (totalAccounted - totalPaid) + unrecognized and
    ///         totalAccounted == entitled + residue.
    struct Reconciliation {
        uint256 bemBalance;
        uint256 unrecognized;
        uint256 deficit;
        uint256 totalAccounted;
        uint256 totalPaid;
        uint256 entitled;
        uint256 residue;
    }

    string public constant VERSION = "HistoricalDistributor/1.0.0";
    /// @notice The constructor arguments are part of the creation transaction's initcode, which
    ///         EIP-3860 limits to 49,152 bytes (about 8 KB of creation code plus 64 bytes per
    ///         contributor), and BSC caps a transaction's gas limit at 2^24 (BEP-652, EIP-7825).
    ///         400 contributors need 33,865 bytes and about 11.2M gas, within 3/4 of that cap so a
    ///         signer's gas buffer still fits. Larger lists can name further distributors as
    ///         contributors.
    uint256 public constant MAX_CONTRIBUTORS = 400;
    uint256 public constant MAX_PAGE = 500;

    TapeoutMinerPool public immutable pool;
    TapeoutMinerPool.Category public immutable category;
    TapeoutMinerPool.Recipient public immutable role;
    IERC20 public immutable bem;
    uint256 public immutable totalWeight;
    /// @notice keccak256(abi.encode(accounts, weights)) of the sorted constructor arrays.
    bytes32 public immutable contributorsHash;

    uint256 public totalAccounted;
    uint256 public totalPaid;
    mapping(address account => uint256 amount) public claimed;

    Contributor[] private _contributors;

    error InvalidAddress();
    error InvalidContributorCount(uint256 accounts, uint256 weights);
    error ContributorsNotSorted(uint256 index, address account);
    error InvalidContributor(uint256 index, address account);
    error ZeroWeight(uint256 index, address account);
    error NotContributor(address account);
    error NotPoolRecipient(address currentRecipient);
    error InvalidBatch();
    error InvalidPage();
    error BalanceDecreased(uint256 balance, uint256 expected);
    error UnexpectedTokenBehavior();

    event DistributorCreated(
        address indexed pool,
        TapeoutMinerPool.Category indexed category,
        bytes32 contributorsHash,
        uint256 contributorCount,
        uint256 totalWeight
    );
    event IncomeRecognized(uint256 received, uint256 totalAccounted);
    event ContributorPaid(
        uint256 indexed index, address indexed account, address indexed caller, uint256 amount
    );

    /// @param accounts Contributor accounts, strictly ascending by address.
    /// @param weights  Positive weights in the same order; only their ratios matter.
    constructor(
        TapeoutMinerPool pool_,
        TapeoutMinerPool.Category category_,
        address[] memory accounts,
        uint96[] memory weights
    ) {
        if (address(pool_).code.length == 0) revert InvalidAddress();
        IERC20 token = pool_.bem();
        if (address(token).code.length == 0) revert InvalidAddress();
        uint256 count = accounts.length;
        if (count == 0 || count > MAX_CONTRIBUTORS || weights.length != count) {
            revert InvalidContributorCount(count, weights.length);
        }
        address previous;
        uint256 total;
        for (uint256 i; i < count; ++i) {
            address account = accounts[i];
            // Strictly ascending order rejects the zero address and duplicates in one comparison.
            if (account <= previous) revert ContributorsNotSorted(i, account);
            // Paying itself or the pool would fail the exact-delta check or turn into pool income.
            if (account == address(this) || account == address(pool_)) revert InvalidContributor(i, account);
            if (weights[i] == 0) revert ZeroWeight(i, account);
            _contributors.push(Contributor(account, weights[i]));
            total += weights[i];
            previous = account;
        }
        bytes32 listHash = keccak256(abi.encode(accounts, weights));
        pool = pool_;
        category = category_;
        role = category_ == TapeoutMinerPool.Category.NAND
            ? TapeoutMinerPool.Recipient.HISTORICAL_NAND
            : TapeoutMinerPool.Recipient.HISTORICAL_LATCH;
        bem = token;
        totalWeight = total;
        contributorsHash = listHash;
        emit DistributorCreated(address(pool_), category_, listHash, count, total);
    }

    // ---------------------------------------------------------------------------------------------
    // Income
    // ---------------------------------------------------------------------------------------------

    /// @notice Recognize BEM that reached the distributor by any route as income.
    function sync() external nonReentrant returns (uint256 received) {
        received = _sync();
    }

    /// @notice Convenience: pay this category's accrued historical income out of the pool (the
    ///         pool's `releaseHistorical` is permissionless as well), then recognize it.
    /// @return released Amount the pool paid in this call.
    /// @return received Income recognized by the sync (includes BEM that arrived by other routes).
    function releaseFromPool() external nonReentrant returns (uint256 released, uint256 received) {
        address current = pool.recipientOf(role);
        if (current != address(this)) revert NotPoolRecipient(current);
        released = pool.releaseHistorical(category);
        received = _sync();
    }

    // ---------------------------------------------------------------------------------------------
    // Claims (anyone may push; payouts always go to the contributor's own fixed account)
    // ---------------------------------------------------------------------------------------------

    /// @notice Pay `account` its unpaid entitlement. Callable by anyone.
    function claim(address account) external nonReentrant returns (uint256 amount) {
        _sync();
        amount = _claimIndex(indexOf(account), totalAccounted);
    }

    /// @notice Pay each listed contributor its unpaid entitlement. A duplicated account pays once.
    function claimBatch(address[] calldata accounts) external nonReentrant returns (uint256 total) {
        if (accounts.length == 0) revert InvalidBatch();
        _sync();
        uint256 accounted = totalAccounted;
        for (uint256 i; i < accounts.length; ++i) {
            total += _claimIndex(indexOf(accounts[i]), accounted);
        }
    }

    /// @notice Pay contributors [start, start+count) of the sorted list (clamped to its length).
    function claimRange(uint256 start, uint256 count) external nonReentrant returns (uint256 total) {
        uint256 length = _contributors.length;
        if (count == 0 || start >= length) revert InvalidBatch();
        uint256 end = count > length - start ? length : start + count;
        _sync();
        uint256 accounted = totalAccounted;
        for (uint256 i = start; i < end; ++i) {
            total += _claimIndex(i, accounted);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function contributorCount() external view returns (uint256) {
        return _contributors.length;
    }

    function contributorAt(uint256 index) external view returns (address account, uint256 weight) {
        Contributor memory c = _contributors[index];
        return (c.account, c.weight);
    }

    /// @notice Contributors [offset, offset+limit) with their weights and claimed amounts.
    function contributorsPage(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory accounts, uint256[] memory weights, uint256[] memory claimedAmounts)
    {
        uint256 length = _contributors.length;
        if (limit == 0 || limit > MAX_PAGE || offset > length) revert InvalidPage();
        uint256 count = limit > length - offset ? length - offset : limit;
        accounts = new address[](count);
        weights = new uint256[](count);
        claimedAmounts = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            Contributor memory c = _contributors[offset + i];
            accounts[i] = c.account;
            weights[i] = c.weight;
            claimedAmounts[i] = claimed[c.account];
        }
    }

    function isContributor(address account) public view returns (bool) {
        (bool found,) = _find(account);
        return found;
    }

    /// @notice Position of `account` in the sorted list; reverts for non-contributors.
    function indexOf(address account) public view returns (uint256 index) {
        bool found;
        (found, index) = _find(account);
        if (!found) revert NotContributor(account);
    }

    function weightOf(address account) external view returns (uint256) {
        return _contributors[indexOf(account)].weight;
    }

    /// @notice Cumulative entitlement of `account` from the income recognized so far.
    function entitlementOf(address account) external view returns (uint256) {
        return _entitlement(_contributors[indexOf(account)].weight, totalAccounted);
    }

    /// @notice What a claim for `account` would pay now (including unrecognized balance).
    function claimable(address account) external view returns (uint256) {
        uint256 weight = _contributors[indexOf(account)].weight;
        return _entitlement(weight, totalAccounted + unrecognizedBalance()) - claimed[account];
    }

    /// @notice BEM held beyond what the ledger expects; recognized by the next sync.
    function unrecognizedBalance() public view returns (uint256) {
        uint256 balance = bem.balanceOf(address(this));
        uint256 expected = totalAccounted - totalPaid;
        if (balance < expected) revert BalanceDecreased(balance, expected);
        return balance - expected;
    }

    /// @notice Historical income `releaseFromPool` would bring in now (0 unless this is the recipient).
    function pendingFromPool() external view returns (uint256) {
        if (pool.recipientOf(role) != address(this)) return 0;
        return pool.historicalClaimable(category);
    }

    /// @notice Full ledger snapshot; iterates the contributor list (bounded by MAX_CONTRIBUTORS).
    function reconciliation() external view returns (Reconciliation memory r) {
        uint256 accounted = totalAccounted;
        r.bemBalance = bem.balanceOf(address(this));
        r.totalAccounted = accounted;
        r.totalPaid = totalPaid;
        uint256 expected = accounted - totalPaid;
        if (r.bemBalance >= expected) r.unrecognized = r.bemBalance - expected;
        else r.deficit = expected - r.bemBalance;
        uint256 length = _contributors.length;
        for (uint256 i; i < length; ++i) {
            r.entitled += _entitlement(_contributors[i].weight, accounted);
        }
        r.residue = accounted - r.entitled;
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _entitlement(uint256 weight, uint256 accounted) internal view returns (uint256) {
        return Math.mulDiv(accounted, weight, totalWeight);
    }

    /// @dev Binary search over the strictly ascending list.
    function _find(address account) internal view returns (bool found, uint256 index) {
        uint256 low;
        uint256 high = _contributors.length;
        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (_contributors[mid].account < account) low = mid + 1;
            else high = mid;
        }
        found = low < _contributors.length && _contributors[low].account == account;
        index = low;
    }

    /// @dev Sets the contributor's history to its current entitlement, so each unit is paid once.
    function _claimIndex(uint256 index, uint256 accounted) internal returns (uint256 amount) {
        Contributor memory c = _contributors[index];
        uint256 entitled = _entitlement(c.weight, accounted);
        amount = entitled - claimed[c.account];
        if (amount == 0) return 0;
        claimed[c.account] = entitled;
        _pay(c.account, amount);
        emit ContributorPaid(index, c.account, msg.sender, amount);
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

    /// @dev Same rule as TapeoutMinerPool._pay: plain, non-rebasing, fee-free BEM only; both balance
    ///      deltas must be exact or the whole claim reverts.
    function _pay(address to, uint256 amount) internal {
        uint256 selfBefore = bem.balanceOf(address(this));
        uint256 toBefore = bem.balanceOf(to);
        totalPaid += amount;
        bem.safeTransfer(to, amount);
        if (bem.balanceOf(address(this)) != selfBefore - amount || bem.balanceOf(to) != toBefore + amount) {
            revert UnexpectedTokenBehavior();
        }
    }
}
