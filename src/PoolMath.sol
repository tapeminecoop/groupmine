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
///      Participant income is split between NAND and LATCH by the aggregate burn composition (N, L) of
///      the admitted miners. The composition changes only at admissions, so time is divided into
///      composition periods. At each admission the category totals are checkpointed (`nandBase`,
///      `latchBase`) together with `participantBase = nandBase + latchBase`; inside a period
///          d          = participants - participantBase
///          nandIncome  = nandBase  + floor(d * N / (N + L))
///          latchIncome = latchBase + floor(d * L / (N + L))
///      so income recognized in an earlier period is never re-split with a later ratio. The at most one
///      raw unit that the two floors leave unallocated is carried into the next period's `d`.
///      Per-share values are floor(categoryIncome / S) with S fixed at activation. Every quantity is
///      non-decreasing in T, and within one period it depends only on T (path independent).
library PoolMath {
    uint256 internal constant TOTAL_PARTS = 84;
    uint256 internal constant PARTICIPANT_PARTS = 80;
    uint256 internal constant RECIPIENT_PARTS = 1;
    uint256 internal constant SINK_PARTS = 2;

    struct State {
        uint256 nandBase;
        uint256 latchBase;
        uint256 participantBase;
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
        a.nandIncome = s.nandBase;
        a.latchIncome = s.latchBase;
        uint256 weight = s.totalNandBurn + s.totalLatchBurn;
        if (weight != 0) {
            uint256 d = a.participants - s.participantBase;
            a.nandIncome += d * s.totalNandBurn / weight;
            a.latchIncome += d * s.totalLatchBurn / weight;
        }
        if (s.nandShares != 0) a.perNandShare = a.nandIncome / s.nandShares;
        if (s.latchShares != 0) a.perLatchShare = a.latchIncome / s.latchShares;
        a.nandReceipts = s.nandShares * a.perNandShare;
        a.latchReceipts = s.latchShares * a.perLatchShare;
        a.residue = total - a.recipientA - a.recipientB - a.sink - a.nandReceipts - a.latchReceipts;
    }
}
