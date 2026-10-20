# Baseline, branch state and evidence reuse

## 1. Starting point and branch inspection

- **Repository:** https://github.com/tapeminecoop/groupmine
- **Reviewed baseline:** `48a2d74939ee167b4d4bed99e6b1d0e759c6a5db` ("Add TapeOut multi-miner pool with
  NAND/LATCH receipts (V1)"). This work is on branch `worktree-pooled-mining-v2`, created from it.
- **Later change on `main`, merged here.** After this branch started, `main` gained `6aeb5a9` ("Add
  historical distributor and size CLI transactions for BSC's gas cap"): a `HistoricalDistributor`
  that splits a V1 historical NAND/LATCH recipient's income among fixed contributor weights, and gas
  sizing for the V1 CLI. The distributor depends on V1 pool features that V2 removes (historical
  recipients, `releaseHistorical`, `historicalClaimable`, `recipientOf`), and the V2 specification
  drops historical shares, so the merge into this branch removes it with its tests, SDK module, CLI
  commands, e2e script, example and reports. Its gas-cap safeguards were ported to the V2 tooling:
  every plan carries a worst-case bound used as its gas limit, plans over the budget and oversize
  `--batch-size` values are refused, and Safe batch files are split by gas (`sdk/gas.ts`,
  `test/unit/GasModel.t.sol`, `test/sdk/gas.test.ts`).
- **Review round.** A review of `6da9a41` (the PR head at the time; `main` was still `6aeb5a9`)
  produced the findings resolved in this round. No commits landed between that review and the start
  of this work. The changes, their tests and what remains open are listed in the findings matrix of
  [VERIFICATION_REPORT.md](VERIFICATION_REPORT.md).

## 2. What changed from V1

| Area | V1 (48a2d74) | This version |
| --- | --- | --- |
| Receipts | `TapeoutReceipt`, created by the pool constructor; the pool owner issued and finalized | `TapeoutEntitlementReceipt` deployed independently (same code twice) with its own issuer; the pool binds existing addresses by runtime code hash and category |
| Distribution | owner issued IDs directly to holders (plus a reserve holder) | `TapeoutReceiptDistributor`: funded with receipts, JSON import, finalization, user claims |
| NAND/LATCH split | manual NAND weight fixed at activation | `N/(N+L)` from the Mining burn data of admitted miners, with a checkpoint per admission |
| Historical shares | `H_N`/`H_L` paid to historical recipients | removed |
| Outer split | 2/102 fee to one fee recipient | A 1/102 and B 1/102, independent recipients and payment paths, no other fee |
| Admission | owner only, any phase; claimed only the incoming miner | fixed whitelist of depositors, after activation; strict five-step boundary that first claims every registered miner |
| Owner powers | configuration, issuance, deposits | `activate` only |
| Scale | not assessed against BSC limits | per-transaction gas cap (BEP-652) measured and enforced in tooling |

`TapeoutReceipt.sol`, the V1 tests and the V1 example files were removed; their behaviour that still
applies was carried into the new contracts and tests (§3).

## 3. What was reused

- **Ledger rules** from V1 (originally `GroupBuyVault` in TapeoutMarket/test1): recognize
  `balance + totalPaid − totalAccounted`, refuse balance decreases, check exact payment deltas, call
  `claim` even when `pending()` is zero, isolate harvest failures per miner, per-ID claimed history,
  holder-only claims, the receipt holder index.
- **Tests and mocks:** the multi-miner `MockMining` (now with miner records, burn cache and statuses),
  `MockBEM` fault switches, the receive-hook holder, and V1 regression scenarios (donations and
  third-party claims are income, fee-on-transfer and balance-decrease reverts, payment rollback,
  unclaimed income following an ID, approved operators cannot claim, claims independent of Mining).
- **Tooling:** CLI conventions (plans, Safe batches, loopback-only sends, no keys), the Anvil
  launcher, the fork runners' structure, ABI export, reconciliation checks.
- **Protocol facts** (re-observed at block 128,713,128 rather than assumed): contract addresses and
  implementation identity, `claim` paying the NFT holder, payments while `pending()` reads zero,
  third parties triggering payments into the pool.

## 4. Baseline evidence (V1, not re-run)

Recorded in `docs/VERIFICATION_REPORT.md` at 48a2d74: 56/56 Solidity unit, fuzz and invariant tests;
11/11 SDK tests; local CLI end-to-end 23/23 checks; real BSC Foundry fork 2/2 tests and CLI fork
14/14 checks at block 128,611,683 with miners #4630, #2458 and #6241. The V1 fork run recorded all
three miners reporting `pending() == 0` one hour after a deposit while a harvest still received
62,867,799 raw BEM, and a third-party `Mining.claim` paying 22,621,885 raw into the pool
(`git show 48a2d74:reports/fork-lifecycle.json`).

These results describe V1 code. They are evidence about the protocol, not about this implementation,
which is covered only by [VERIFICATION_REPORT.md](VERIFICATION_REPORT.md).

## 5. Earlier evidence inherited through V1

From [TapeoutMarket/test1](https://github.com/TapeoutMarket/test1) at
`9d86a2673dd3b415e5d8ce35cd818d4e73756116` (the previous single-miner GroupBuy design; read, not
re-run):

| Evidence | Reported result |
| --- | --- |
| Real BSC state on a local fork, block 128,554,249 | The `pending() == 0` / `claim() > 0` behaviour found and handled; custody, collection and entitlement transfer scenarios |
| BSC mainnet test (11 transactions through block 128,591,816) | One miner (#3204), 100 receipts, real BEM distribution; unclaimed entitlement moved with receipt #1 and the new holder claimed it; former holder rejected with `NotHolder` |

What this still supports: Mining pays the NFT's holder (also when others call `claim`), BEM behaves
as a plain ERC-20 on the tested paths, and per-ID claimed history lets unclaimed income follow a
receipt on mainnet. It says nothing about multi-miner custody, composition-weighted splitting, the
admission boundary, the distributor or the whitelist.
