// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Allocation math for the pool's cumulative income (mirrored exactly by sdk/math.ts).
/// @dev Outer split of the cumulative recognized total T. The relative weights NAND + LATCH 100 :
///      A 1.25 : B 1.25 : C 2.5 (105 displayed parts) are held as the equal integer ratio
///      80 : 1 : 1 : 2 (84 parts):
///          recipientA   = floor(T *  1 / 84)
///          recipientB   = floor(T *  1 / 84)
///          sink         = floor(T *  2 / 84)    (C, paid to the pool's fixed sink address)
///          participants = floor(T * 80 / 84)
///      Each is computed from T on its own, never as T minus other rounded parts, so each is
///      non-decreasing in T. With r = T mod 84 the four floors leave r - floor(2r/84) - floor(80r/84)
///      raw units unallocated: at most 3 (for r = 64 ... 83).
///
///      Category ledger. The participants' entitlement is kept in ledger units of 1 / LEDGER_UNIT raw
///      BEM (LEDGER_UNIT = 84 * 1e18), where it is exact: T raw units are T * 80 * 1e18 ledger units.
///      The NAND and LATCH entitlements are kept in the same units and always add up to that total, so
///      no fraction is ever dropped at a boundary. Income enters the ledger in one of two ways:
///        - ordinary income, recognized while the pool's composition is (N, L), is split by N : L;
///        - carried income of an incoming miner (what its own Mining.claim paid during its admission)
///          is split by that miner's own burn n : l, whatever the pool's composition is.
///      In both cases NAND takes floor(units * n / (n + l)) and LATCH the rest, so a split loses
///      nothing and favours LATCH by less than one ledger unit. A carried split depends only on the
///      miner's (received, n, l), so admitting the same miners in any order, in one batch or in
///      several, gives the same ledger. Admissions are boundaries: `accountedBase` is T at the last
///      boundary and `nandBase` / `latchBase` the category entitlements there; inside a period
///          d          = (T - accountedBase) * 80 * 1e18
///          nandUnits  = nandBase  + floor(d * N / (N + L))
///          latchUnits = latchBase + d - floor(d * N / (N + L))
///      and nandBase + latchBase == accountedBase * 80 * 1e18 at every boundary. Category incomes are
///      floor(units / LEDGER_UNIT); together they are participants or participants - 1. Per-share values
///      are floor(categoryIncome / S) with S fixed at activation. Every quantity is non-decreasing in T,
///      never decreases at a boundary, and within one period depends only on T (path independent).
library PoolMath {
    uint256 internal constant TOTAL_PARTS = 84;
    uint256 internal constant PARTICIPANT_PARTS = 80;
    uint256 internal constant RECIPIENT_PARTS = 1;
    uint256 internal constant SINK_PARTS = 2;
    /// @dev Ledger units per raw BEM unit, divided by TOTAL_PARTS.
    uint256 internal constant LEDGER_PRECISION = 1e18;
    /// @dev Ledger units per raw BEM unit.
    uint256 internal constant LEDGER_UNIT = TOTAL_PARTS * LEDGER_PRECISION;

    struct State {
        uint256 accountedBase;
        uint256 nandBase;
        uint256 latchBase;
        uint256 totalNandBurn;
        uint256 totalLatchBurn;
        uint256 nandShares;
        uint256 latchShares;
    }

    struct Accrual {
        uint256 total;
        uint256 recipientA;
        uint256 recipientB;
        uint256 sink;
        uint256 participants;
        uint256 nandIncome;
        uint256 latchIncome;
        uint256 perNandShare;
        uint256 perLatchShare;
        uint256 nandReceipts;
        uint256 latchReceipts;
        uint256 residue;
    }

    function accrue(uint256 total, State memory s) internal pure returns (Accrual memory a) {
        a.total = total;
        a.recipientA = total * RECIPIENT_PARTS / TOTAL_PARTS;
        a.recipientB = a.recipientA;
        a.sink = total * SINK_PARTS / TOTAL_PARTS;
        a.participants = total * PARTICIPANT_PARTS / TOTAL_PARTS;
        (uint256 nandUnits, uint256 latchUnits) = categoryUnits(total, s);
        a.nandIncome = nandUnits / LEDGER_UNIT;
        a.latchIncome = latchUnits / LEDGER_UNIT;
        if (s.nandShares != 0) a.perNandShare = a.nandIncome / s.nandShares;
        if (s.latchShares != 0) a.perLatchShare = a.latchIncome / s.latchShares;
        a.nandReceipts = s.nandShares * a.perNandShare;
        a.latchReceipts = s.latchShares * a.perLatchShare;
        a.residue = total - a.recipientA - a.recipientB - a.sink - a.nandReceipts - a.latchReceipts;
    }

    /// @notice Category entitlements at `total` in ledger units: the boundary values plus the current
    ///         period's ordinary income split by the pool's composition. Without a composition (only
    ///         before the first admission, when nothing is recognized) nothing is split.
    function categoryUnits(uint256 total, State memory s)
        internal
        pure
        returns (uint256 nandUnits, uint256 latchUnits)
    {
        nandUnits = s.nandBase;
        latchUnits = s.latchBase;
        uint256 weight = s.totalNandBurn + s.totalLatchBurn;
        if (weight != 0) {
            uint256 d = participantUnits(total - s.accountedBase);
            uint256 toNand = d * s.totalNandBurn / weight;
            nandUnits += toNand;
            latchUnits += d - toNand;
        }
    }

    /// @notice An incoming miner's carried income split by its own burn (`nand` : `latch`).
    function carriedUnits(uint256 received, uint256 nand, uint256 latch)
        internal
        pure
        returns (uint256 toNand, uint256 toLatch)
    {
        uint256 units = participantUnits(received);
        toNand = units * nand / (nand + latch);
        toLatch = units - toNand;
    }

    /// @notice The participants' exact share of `amount` raw BEM, in ledger units.
    function participantUnits(uint256 amount) internal pure returns (uint256) {
        return amount * PARTICIPANT_PARTS * LEDGER_PRECISION;
    }
}
