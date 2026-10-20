// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Pure allocation math for the pool's cumulative income.
/// @dev Every bucket is a floor function of the single cumulative total `T` of recognized BEM.
///      Each function is non-decreasing in `T`, so per-ID and per-recipient entitlements never
///      shrink, nothing is paid twice, and the rounding residue never accumulates: at any `T` it is
///      at most `1 + (S_N + H_N - 1) + (S_L + H_L - 1)` raw units and is retained by the pool.
///
///      fee           = floor(T * 2 / 102)                      (100:2 model, not 2% of gross)
///      entitlement   = T - fee                                 (100 of 102 parts, rounded in holders' favour)
///      nandIncome    = floor(entitlement * W_N / 1e8)
///      latchIncome   = floor(entitlement * W_L / 1e8)          (W_L = 1e8 - W_N)
///      perNandShare  = floor(nandIncome / (S_N + H_N))         (0 when the denominator is 0)
///      perLatchShare = floor(latchIncome / (S_L + H_L))
///      receipts      = S * perShare,  historical = H * perShare (one historical share = one receipt)
library PoolMath {
    uint256 internal constant WEIGHT_SCALE = 100_000_000;
    uint256 internal constant FEE_PARTS = 2;
    uint256 internal constant ENTITLEMENT_PARTS = 100;
    uint256 internal constant TOTAL_PARTS = 102;

    struct Shares {
        uint256 nandShares; // S_N: active NAND receipt IDs 1..S_N
        uint256 latchShares; // S_L: active LATCH receipt IDs 1..S_L
        uint256 historicalNandShares; // H_N
        uint256 historicalLatchShares; // H_L
        uint256 nandWeight; // W_N, scaled by WEIGHT_SCALE
    }

    struct Accrual {
        uint256 total;
        uint256 fee;
        uint256 entitlement;
        uint256 nandIncome;
        uint256 latchIncome;
        uint256 perNandShare;
        uint256 perLatchShare;
        uint256 nandReceipts;
        uint256 latchReceipts;
        uint256 historicalNand;
        uint256 historicalLatch;
        uint256 residue;
    }

    function accrue(uint256 total, Shares memory s) internal pure returns (Accrual memory a) {
        a.total = total;
        a.fee = total * FEE_PARTS / TOTAL_PARTS;
        a.entitlement = total - a.fee;
        a.nandIncome = a.entitlement * s.nandWeight / WEIGHT_SCALE;
        a.latchIncome = a.entitlement * (WEIGHT_SCALE - s.nandWeight) / WEIGHT_SCALE;
        uint256 nandDenominator = s.nandShares + s.historicalNandShares;
        uint256 latchDenominator = s.latchShares + s.historicalLatchShares;
        if (nandDenominator != 0) a.perNandShare = a.nandIncome / nandDenominator;
        if (latchDenominator != 0) a.perLatchShare = a.latchIncome / latchDenominator;
        a.nandReceipts = s.nandShares * a.perNandShare;
        a.latchReceipts = s.latchShares * a.perLatchShare;
        a.historicalNand = s.historicalNandShares * a.perNandShare;
        a.historicalLatch = s.historicalLatchShares * a.perLatchShare;
        a.residue = total - a.fee - a.nandReceipts - a.latchReceipts - a.historicalNand - a.historicalLatch;
    }
}
