# Baseline: what was reused, and what its evidence does and does not cover

**Repository:** https://github.com/TapeoutMarket/test1
**Commit used:** `9d86a2673dd3b415e5d8ce35cd818d4e73756116` (`docs: add complete English reports and
verified Word editions`). Cloned on 2026-10-20; `main` HEAD was exactly this commit, matching the
reviewed snapshot. The baseline was used as read-only reference material; none of its scripts were run
against BSC and none of its historical mainnet transaction plans were replayed.

## 1. Reuse map

| Baseline (test1 @ 9d86a26) | This repository | How it was adapted |
| --- | --- | --- |
| `src/interfaces/IProtocols.sol` (`IMining`) | `src/interfaces/IMining.sol` | Same three functions; documents the observed semantics the pool relies on |
| `GroupBuyVault._sync` (`balance + totalPaid − totalAccounted`) | `TapeoutMinerPool._sync` | Unchanged rule, still rejects balance decreases |
| `GroupBuyVault._pay` (exact sender/recipient deltas) | `TapeoutMinerPool._pay` | Unchanged rule |
| `GroupBuyVault._harvest` (claim even if `pending == 0`, account actual receipts) | `harvest`, `harvestRange`, registration claim | Many miners; failures isolated per miner and reported (see §3) |
| Per-ID `claimed`, `accPerShare − claimed[id]`, holder index, `NotHolder` | `claimed(category, id)`, `TapeoutReceipt` holder index | Keyed by `(category, id)`; per-share value derived from the cumulative ledger |
| Unique-ID ERC-1155 (100 IDs, supply 1) inside the vault | Two standalone `TapeoutReceipt` collections | Share count configurable (`S_N`, `S_L`), minting closed at activation |
| `test/helpers/Mocks.sol` | `test/helpers/Mocks.sol` | MockMining is multi-miner, models `pending()==0`/`claim()>0`, per-key failures and unknown keys |
| Accounting invariants (`test/invariant/Accounting.t.sol`) | `test/invariant/PoolInvariant.t.sol` | Rewritten for fee/category/historical buckets and per-ID sums |
| Foundry/solc settings (0.8.24, Paris, via-IR, optimizer 200, OZ 5.4.0) | `foundry.toml`, `package.json` | Same toolchain pins; plus a `fork` profile (Cancun EVM) |
| Protocol identity findings (`docs/REAL_PROTOCOL_IDENTITY_REVIEW.md`) | `sdk/constants.ts`, `protocol-check` | Addresses and implementation hashes re-observed on 2026-10-20 (unchanged) |
| CLI conventions (dry-run default, loopback-only local sends, no key handling) | `cli/pool.ts` | New command set for this product; adds Safe batch export |

Regression scenarios carried over from the baseline's unit tests: harvest settles income that
`pending()` does not report; claims do not depend on Mining; donations and third-party `Mining.claim`
calls are income; abnormal balance decreases and transfer-fee tokens revert without rewriting history;
failed payments roll back; positive unclaimed income follows the transferred ID and the former holder
gets `NotHolder`; zero-value, self and duplicate transfers keep the holder index consistent; an approved
operator cannot claim until it holds the ID.

Not carried over (features outside this product): Seaport and CircuitMarket purchase logic, funding,
withdrawals and refunds, the guardian, the UUPS factory and timelock, ERC-1167 clone templates, and
redemption — including the old rule that collecting every receipt lets someone withdraw the miner.

## 2. Inherited evidence (reported by the baseline; not re-run here)

These results come from the baseline's own reports and describe the **previous GroupBuy V1
implementation** (and, in the legacy reports, the earlier two-share `TestMinerVault`, which had owner
recovery powers and must not be confused with the 100-share, no-owner `GroupBuyVault`). Some older
README/readiness files still show historical `NOT_RUN` states; each report is read in its own date and
scope.

| Evidence | Reported result | Where |
| --- | --- | --- |
| Core contract/SDK validation | 79 Solidity tests/invariant properties, 78 SDK tests, TypeScript checks, local build/format/gas/export, Seaport-source integration with mock assets, Anvil CLI workflow | `CONTRACT_REPORT.md`, `reports/verification.json` |
| Real BSC state on a local fork | Block 128554249; 23 scenarios, 25 local-fork receipts; acquisition, custody, BEM collection/distribution, entitlement transfer, old exit branches; the `pending()==0` / `claim()>0` defect found, fixed and retested | `docs/REAL_BSC_FORK_TEST_REPORT.md`, `docs/REAL_PROTOCOL_IDENTITY_REVIEW.md` |
| BSC mainnet | Deployment and governance configured; 11 successful test transactions through block 128591816; one miner (#3204) and 100 receipts; real BEM distribution; unclaimed entitlement moved with receipt #1 and the new holder claimed 0.00000323 BEM; former holder rejected with `NotHolder`; ≥15 confirmations. Mainnet redemption and failed-funding refunds were not completed | `mainnet-test/MAINNET_TEST_REPORT.md`, `mainnet-rewards/BEM_REWARDS_TEST_REPORT.md`, `mainnet-entitlement-transfer/BEM_ENTITLEMENT_TRANSFER_REPORT.md` |
| Offline tooling regression | 840 passed, 0 failed, 0 skipped (mainnet-tool tests, not Solidity tests or live scenarios); TypeScript typecheck passed; zero RPC calls, signatures or broadcasts | `reports-en/verification/offline-checks.json` |

### What the inherited evidence supports for this product

It is evidence about the real protocol and about mechanisms this design reuses: the real `Mining.claim`
pays the NFT's holder (also when called by others) and can pay while `pending()` is zero; BEM
transfers from a contract to holders behave as plain ERC-20 transfers on the tested paths; per-ID
claimed history makes unclaimed income follow a receipt on mainnet.

It does **not** validate the new multi-miner custody, the two receipt collections, manual weights, the
historical shares, the 100:2 fee, activation and issuance, per-miner failure isolation, or any of this
repository's code. Those are covered only by the new results in
[VERIFICATION_REPORT.md](VERIFICATION_REPORT.md).

## 3. Intentional departures from baseline rules

- **Harvest failure handling.** The single-miner vault let a reverting `Mining.claim` revert the
  harvest. With many miners that would let one bad miner block collection from all others, so each
  miner's claim is isolated: success emits `MinerHarvested(id, amount)` (amount may be 0), failure
  emits `MinerHarvestFailed(id, reason)` and increments `failed`. The baseline's underlying concern —
  never turning an error into a fake zero claim, never booking estimates — is preserved, and
  registration (`depositMiners`/`registerMiners`) still requires a successful real claim.
- **An owner exists.** Manual configuration and issuance need an operator. Its powers end at
  activation except adding miners and editing receipt metadata.
- **No exit path.** By specification there is no miner withdrawal or redemption in this version.
