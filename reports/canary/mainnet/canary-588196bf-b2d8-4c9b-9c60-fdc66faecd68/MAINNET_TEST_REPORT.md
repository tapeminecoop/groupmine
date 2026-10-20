# TapeOut Recoverable Canary Test Report

Status: **PARTIAL — ORIGINAL AUTOMATION FAILED; BOTH MINERS RETURNED AND ACCOUNTING RECONCILED**. Evidence scope: **ACTUAL_BSC_MAINNET**. The original FAIL_OR_INCOMPLETE result and failed assertions are preserved. Total fees: 0.00091132426 BNB. Final confirmed ownership block: 128772561.

## Objective and actual scope

Exercise designated miners #3204 (2 NAND, 0 LATCH) and #12485 (1 NAND, 1 LATCH), with isolated receipts (4 NAND IDs, 2 LATCH IDs), an EOA plus a controlled contract holder, composition changes 2:0 to 3:1, exact BEM payouts, and mandatory fixed-wallet recovery. This is not a test of two independent EOA signers or a live multisig.

## Source and build

Base revision: c4bc022c76c5de528a98caa58974ee5772f80d4a. Candidate source/artifact digest: `a4003a06dca0164c89852cb65b137d45fa24665fa8cf21f33cab220af2c9385f`.
Solidity 0.8.24; Paris; via-IR; optimizer 200 runs. See candidate.json and production-canary.diff for exact source hashes, artifact hashes and exhaustive adaptation.

## Deployed identities and permissions

{
  "nand": "0xa246ab1715b8d0c66072dc0db934906516a96229",
  "latch": "0xf6133735fa93c6042f3bf84eb47894e23566cc62",
  "helper": "0xa93cb7a0af86af3a15bba3732564c9405e9ccf57",
  "pool": "0x5904d00d2990c8734051b5d0e7aaeba636dc591e",
  "distributor": "0x47f09bb7a2361f8e2341d046441aea0321e2b612"
}


{
  "nand": {
    "codeHash": "0x7f59d20c18c4dec6ddf617a9f085a87d4622efc279fbc1438e5293333288ec8f",
    "bytes": 8743,
    "immutableTemplateMatched": true
  },
  "latch": {
    "codeHash": "0x7f59d20c18c4dec6ddf617a9f085a87d4622efc279fbc1438e5293333288ec8f",
    "bytes": 8743,
    "immutableTemplateMatched": true
  },
  "helper": {
    "codeHash": "0x8ca6042e3eb2cc0dd51140193a52879153323afcd6d0609e76e01ba1499b3607",
    "bytes": 3410,
    "immutableTemplateMatched": true
  },
  "pool": {
    "codeHash": "0xd05dd9b09dcb11da1ae202b57954758e4e8e65a1d6f532908cc01638ea6b63ae",
    "bytes": 20404,
    "immutableTemplateMatched": true
  },
  "distributor": {
    "codeHash": "0x3e2fa6a91cb4d3661049fdd6d7e315b12b816c317fd64e0c70c9e8c72733846f",
    "bytes": 7680,
    "immutableTemplateMatched": true
  }
}


Production pool and its accounting library are unchanged. The canary has different bytecode and adds an immutable recovery controller (0x7eEDccb674e9549b61B01Eb65aC68DA071ADF129), ID restrictions (3204 and 12485), an irreversible shutdown and independent fixed-destination NFT returns. It retains production authoritative burn reads, strict admission settlement, carried-income treatment, 100:1:1 accounting, receipt history and transfer semantics. The original wallet is the sole depositor. Shutdown works after ordinary owner renunciation. No arbitrary recovery destination, BEM sweep, reopening or arbitrary helper executor exists.

Shutdown and each emergencyReturn make no Mining or BEM calls. The NFT contract must still allow transfer. Already received BEM remains attributed using the frozen final composition and persistent per-ID/role histories; claims, sync and releases continue after shutdown. Unreceived Mining income follows the NFT and is excluded from pool payments.

## Initial ownership, status, composition and approvals

`results.json:observations.initial` includes a block-pinned snapshot, protocol identities, BEM decimals, both owners, full Mining records, burn-cache/circuitBurn cross-checks, pending and token approvals. pending is not treated as an exact promise of claim payout.

## Issuance and JSON allocation

The intended issuance is 4 NAND and 2 LATCH receipts to the original wallet, followed by supply finalization, transfer into the production distributor, JSON import, complete bidirectional verification and allocation finalization. The intended allocation is wallet NAND #1-3/LATCH #1 and helper NAND #4/LATCH #2 (delivered late). Only completed journal actions and passing assertions below establish which steps actually occurred; missing phases are not presumed executed. See allocation-artifact.json when present.

## Chronological transaction results

| Action | Hash | Block | Gas used | Fee BNB |
| --- | --- | ---: | ---: | ---: |
| deploy-nand | 0x44f5b07b3291820d1b48e31bbbe2fe6293e8bb8875c9139c4033b972b091b58b | 128769877 | 2066032 | 0.00011363176 |
| deploy-latch | 0x9e8b3a04191e045ffabf37ad75e691272c0625724649106845b60d95fdcabb25 | 128769904 | 2066082 | 0.00011363451 |
| deploy-helper | 0xf18524f74f8443657c8c5a13889b0f8fb85289654b2bc0142f6bd3a62a7ca519 | 128769930 | 822046 | 0.00004521253 |
| deploy-pool | 0xa741b47e8e5530a77eacddb19865275e7448745f0b4c5dca2f8aab5ab46b3bf5 | 128769959 | 4847694 | 0.00026662317 |
| deploy-distributor | 0x71bcb25c11675907740d283152460f605c44e194360bab6c46960bfd059cec02 | 128769998 | 1771212 | 0.00009741666 |
| bindPool | 0x38972ca6ed55959c6eb415c91018bf251c4d223e307adeca309b257362c06055 | 128770042 | 58506 | 0.00000321783 |
| issue | 0xe165517e310fa725d1f9a705a21014db2df7a4031cf077274015ee5315debea4 | 128770085 | 240731 | 0.000013240205 |
| issue | 0x1906d24cb23398f23199e1f0804ced37f97e01604c04424a40eb6fea50a38181 | 128770125 | 148024 | 0.00000814132 |
| finalizeIssuance | 0xae667f0c88b6c5f9973e85f5b30e345c6a37fdf527cf7d2b384c2c0bdb1faffe | 128770164 | 48908 | 0.00000268994 |
| finalizeIssuance | 0x6291bff1b3fef7fe10fb37833e07f17f21f2738bedd7c338c0ed24860175e49e | 128770204 | 48908 | 0.00000268994 |
| safeBatchTransferFrom | 0xb4789d32f71b2dfa23d470d584599415be87ef8f36ca7b40727ce96f951876bb | 128770244 | 195247 | 0.000010738585 |
| safeBatchTransferFrom | 0x7e8a14cdfcbbe0b622044393aed2146482ef215c5f463cce4d7123faabeab1af | 128770285 | 128625 | 0.000007074375 |
| allocate | 0x161b55e1dd16e05e899a6ca8418f73d63fddf936254fabb86ab0b50f78c3a184 | 128770320 | 508069 | 0.000027943795 |
| finalizeAllocation | 0x31eda798d6c5c6eb24ff9606a522b5caa37b50920c61caeef42109a9c9059c5c | 128770363 | 69523 | 0.000003823765 |
| activate | 0xd103157482c252078863ad274e611a20237d7a76a3de0542b850e520285ee354 | 128770397 | 111548 | 0.00000613514 |
| renounce-nand | 0xa1d3e944debea1c5287f49ba0998edb730baf5c263303bc7e4b7ffef2d04a0ed | 128770432 | 25688 | 0.00000141284 |
| renounce-latch | 0x2121a94030a4998a2921612e16d2bd723af81e25ad15727302d7da0b5e22a8ad | 128770466 | 25688 | 0.00000141284 |
| renounce-distributor | 0x58f3b7e91d42b089b8bdffb406e11f6f70295c03511f86e8feda1f200f36325c | 128770498 | 25543 | 0.000001404865 |
| renounce-pool | 0xd40fef5ed9c0a3260284aefdba3a28c651c46ffab68c7c024453206acc7ac791 | 128770534 | 26027 | 0.000001431485 |
| approve-3204-only | 0x3815421652d6b3b8d39212d363499363a81996058d771e56a0415e440aaea19e | 128770594 | 56352 | 0.00000309936 |
| phase-A-deposit-3204 | 0x17ebd294dabb251705fda3a1e16e6d2a4114468855db801ebf26d9cefcf1176b | 128770632 | 425562 | 0.00002340591 |
| phase-A-bounded-harvest | 0x5bb97ed6c1b94c6b2568061d951c66c9612c9cb81436822167f41d1e5606349d | 128770802 | 143514 | 0.00000789327 |
| deliver-original-wallet-receipts | 0x8af79e655f45c68b21efa63ea5929b26bb5e79b128414d5e7b729b1effbba5b8 | 128770834 | 250349 | 0.000013769195 |
| phase-A-subset-claim | 0xa6438e8a80b805186749921a318826872424883aa2ea5c50cda4deca9fc0d396 | 128770867 | 172561 | 0.000009490855 |
| old-miner-income-held-before-admission | 0xd2a0223551d9a4f81c410dfbb6af0a416e7328117c31577b938b5d5dd954c747 | 128771042 | 104805 | 0.000005764275 |
| approve-12485-only | 0xc660ebe245ff8670261d627103f50c86875f5d8d78dadd6062a1d239dc65df8c | 128771219 | 56352 | 0.00000309936 |
| phase-B-deposit-12485 | 0x7ce5693b11b0f6fc676e76cc1ea00c9f3cea214db07ef9c3f592be6f7112c5b1 | 128771269 | 398484 | 0.00002191662 |
| phase-C-harvest-3-1 | 0xea57b883a14776c1516fc5fae8a724b5be1724f1992a18dc35757b3686d60082 | 128771444 | 178991 | 0.000009844505 |
| late-deliver-helper-receipts | 0x888396a14b72a2512f8dfea542a0144ae7a7718e9b556ad326fb1601cad93b2c | 128771481 | 161147 | 0.000008863085 |
| helper-initial-receipt-claim | 0x304c0899d71f84a08784189800b56d36dc707d7def68395f14cfae035de866d1 | 128771518 | 188613 | 0.000010373715 |
| original-selected-claim | 0xecb59b3a10c4e410cb4871fd8aa3aec47a3fee0419fb3044b4342e963e4bf238 | 128771559 | 129015 | 0.000007095825 |
| transfer-unpaid-nand-1-to-helper | 0x64d008b2c408a9266216098a00d2e4f6d6109c141e59bb4a8c3fe241ee819a95 | 128771596 | 60062 | 0.00000330341 |
| permanent-shutdown | 0x52243fd1faa90ec521717ada08a4cea9d7956cef03dddaaf31eadf1d8010ff4a | 128771706 | 45903 | 0.000002524665 |
| return-3204 | 0x6c15f5ab160aa381e600f663c0c3b94f321b08b5d376027d1cc7568dadb97b5b | 128771735 | 105579 | 0.000005806845 |
| return-12485 | 0x768804c76e15f33b2ded37efc0e303105b5f926f0d80c32c747e9184c489e29b | 128771766 | 83705 | 0.000004603775 |
| cleanup-wallet-receipt-claims | 0x0a57207e1a97afc3a61fcc2d2efb8843d6932c7994a4bb8731e87edb7564f461 | 128772081 | 131430 | 0.00000722865 |
| cleanup-helper-receipt-claims-including-transferred-1 | 0xa2a71b1ac13a62c451368394527cd5f00c10cc9693a8a27bef628ecc771ab932 | 128772121 | 122634 | 0.00000674487 |
| cleanup-helper-repeat-claim-1 | 0x43d154b82c0f54e1ec52b9ec9db2aff939167cc464fb1ce90754ac2893668cf6 | 128772162 | 77551 | 0.000004265305 |
| cleanup-release-A-separately | 0x34826a61c8f3533e875c844c4b173643cdb98975c1d76427c4b69d8604aa7b9a | 128772205 | 99526 | 0.00000547393 |
| cleanup-release-B-separately | 0x763544c8b0c4d427340a98359e65c592e07f4c779d491d297c3d228ede3af4f4 | 128772240 | 98228 | 0.00000540254 |
| cleanup-helper-forwards-BEM-to-original | 0x8f93e2e45bdf9b8aee31d120459c704bb8766a4a58febb3b5c1a470d3c316251 | 128772278 | 35458 | 0.00000195019 |
| cleanup-post-return-owner-income-3204 | 0x17e183c8b68075ab4991fe0ab6d4b3570594455a6663e4f2118444cb0c61791d | 128772456 | 104805 | 0.000005764275 |
| cleanup-post-return-owner-income-12485 | 0x658f532f94a10e4499dab42b0dcd979bc0436706206b8c4eaac78043e8525649 | 128772492 | 104805 | 0.000005764275 |

Every transaction's sender, target, function, calldata, hash, block/hash, timestamp, confirmations, gas/fee, raw event logs, decoded pool events, and balance/ownership changes are in journal.jsonl. Fork transaction hashes are never represented as mainnet hashes.

## Accounting boundaries and independent expected values

`results.json:observations.boundary` preserves the mined second admission and checkpoint events. Expected values use independent integer arithmetic, not PoolMath or sdk/math: P=floor(100T/102), A=B=floor(T/102); the all-NAND old base is frozen at the admission checkpoint; new participant delta splits floor(3d/4) and floor(d/4); fixed receipt supplies divide category amounts by 4 and 2. Zero carried income is recorded as zero; both old settlement and later new-period harvest must be positive. All BEM amounts are raw 8-decimal integers, with formatted payout examples in assertions.

## Individual assertions, failures and incomplete checks

| Assertion | Status |
| --- | --- |
| recovery-fixed-before-any-approval | PASS |
| complete-allocation-verified | PASS |
| owner-renounced-recovery-retained | PASS |
| phase-A-composition-2-0 | PASS |
| phase-A-positive-actual-revenue | PASS |
| phase-A-subset-claim-exact | PASS |
| retain-positive-unpaid-receipt | PASS |
| positive-already-held-unrecognized-income | PASS |
| second-miner-still-original-and-compatible | PASS |
| nonzero-old-period-settlement | PASS |
| phase-B-composition-3-1 | PASS |
| boundary-income-matches-independent-BEM-transfer-evidence | PASS |
| old-period-and-held-balance-all-nand | PASS |
| carried-income-new-composition-and-fixed-old-entitlements | PASS |
| both-nfts-in-canary | PASS |
| supplies-stay-4-and-2 | PASS |
| positive-new-period-harvest | PASS |
| undelivered-helper-receipts-have-entitlements | PASS |
| late-delivery-preserves-earlier-entitlement | PASS |
| helper-initial-receipt-claim-exact | PASS |
| original-selected-claim-exact | PASS |
| transfer-carries-positive-unpaid-income | PASS |
| transfer-keeps-history-and-unpaid | PASS |
| former-holder-claim-rejected | FAIL |
| permanently-closed | PASS |
| closed-pool-admission-rejected | FAIL |

Business failure: ASSERTION_FAILED former-holder-claim-rejected. Recovery failure: none recorded. Finalization failure: ASSERTION_FAILED closed-pool-admission-rejected.

## Final ownership, post-return behavior and BEM reconciliation

{
  "bemBalance": "7",
  "unrecognized": "0",
  "deficit": "0",
  "totalAccounted": "134815",
  "totalPaid": "134808",
  "recipientAAccrued": "1321",
  "recipientAPaid": "1321",
  "recipientBAccrued": "1321",
  "recipientBPaid": "1321",
  "nandIncome": "112707",
  "nandReceiptsAccrued": "112704",
  "nandReceiptsPaid": "112704",
  "latchIncome": "19463",
  "latchReceiptsAccrued": "19462",
  "latchReceiptsPaid": "19462",
  "residue": "7"
}


[
  {
    "id": "3204",
    "status": 1,
    "paidRaw": "4758",
    "transaction": "0x17e183c8b68075ab4991fe0ab6d4b3570594455a6663e4f2118444cb0c61791d",
    "scope": "POST_RETURN_PERSONAL_INCOME_EXCLUDED_FROM_POOL"
  },
  {
    "id": "12485",
    "status": 1,
    "paidRaw": "4925",
    "transaction": "0x658f532f94a10e4499dab42b0dcd979bc0436706206b8c4eaac78043e8525649",
    "scope": "POST_RETURN_PERSONAL_INCOME_EXCLUDED_FROM_POOL"
  }
]


Both final-owner assertions must pass at confirmed blocks; return transaction success alone is insufficient. Post-return personal income is recorded separately. Missing or zero post-return payment is unverified evidence of positive continued payment and is not presented as a positive result. Rounding residue (at most 7 raw BEM units for these supplies) is distinguished from unpaid entitlements. Successful recovery never changes a failed business test into PASS.

## BNB spending and limitations

Total confirmed fees: **0.00091132426 BNB** (911324260000000 wei). Approved cap: 0.0034190386 BNB; recovery reserve: 0.000074497 BNB. No NFT purchase/sale/list/burn/stop/challenge/reconfiguration, fundraising receipt or contributor allocation is in scope.

This disclosed recoverable variant differs from the non-withdrawable production pool in bytecode and authority. This bounded test is not an independent audit, a production deployment or proof of identical bytecode. Upstream NFT transfer availability and protocol behavior remain dependencies. Mock fault injection, local-fork execution and actual mainnet evidence are separately identified.


## Confirmed actual mainnet observations and final independent audit

Run: canary-588196bf-b2d8-4c9b-9c60-fdc66faecd68. Overall final status: **PARTIAL_AUTOMATION_FAILED_RECOVERY_AND_ACCOUNTING_PASS**. The original automatic run remains FAIL_OR_INCOMPLETE; successful recovery has not relabeled it PASS. Human approval is saved in reports/canary/approvals/canary-588196bf-b2d8-4c9b-9c60-fdc66faecd68.json. The originally proposed fee caps were retained; no additional fee headroom was used. The frozen candidate is a4003a06dca0164c89852cb65b137d45fa24665fa8cf21f33cab220af2c9385f; all production source files remain unchanged.

### Automation failure and approved payout continuation

The original runner incorrectly searched only the human-readable RPC error.message for a custom-error selector. The commercial RPC returned the generic text "execution reverted" while placing the exact revert bytes in structured error data. Consequently, the original former-holder and closed-admission assertions failed, the run aborted, and independent emergency returns were prioritized. Both failed assertions and their exact original messages remain unchanged in results.json.

After actual NFT ownership was back in the original wallet, a separate approved payout-continuation script reused the frozen Runner, ABI, fee caps and existing SDK structured-error decoder. It completed only the already-authorized remaining receipt claims, repeat-claim test, A/B releases, helper forwarding and post-return personal claims. No contract, recovery destination, miner admission or fee cap changed. The planned orderly final canary Mining harvest was **SKIPPED** because of the abort; the canary was never harvested after shutdown. Unreceived Mining accrual that followed the returned NFTs is part of the later personal payments, not pool income.

Structured-data simulations separately confirmed:

| Guard | Expected decoded error | Independent result |
| --- | --- | --- |
| former-holder-claim-structured-revert | NotHolder | PASS: NotHolder |
| closed-admission-structured-revert | CanaryClosed | PASS: CanaryClosed |
| closed-harvest-structured-revert | CanaryClosed | PASS: CanaryClosed |
| non-whitelisted-admission-at-pre-shutdown-block | NotDepositor | PASS: NotDepositor |

The non-whitelisted simulation used the confirmed pre-shutdown transfer block, so it checked NotDepositor while admissions were still open. Other simulations used post-return state. No intentionally failing transaction was broadcast. This diagnostic evidence explains the harness failure; it does not erase or overwrite the original failed automated assertions.

After all transactions, a separate read-only audit fetched canonical transaction receipts and block hashes from the commercial BSC RPC and checked final state at block **128772561**, hash **0x6f89f3fd00b45d01a2bafdccf60e47117e8104195cc00a2b795cd121eabaf8a2**, with the 3-confirmation policy. The audit head was 128772563. Actual mainnet receipts and final audit are in reports/canary/mainnet/canary-588196bf-b2d8-4c9b-9c60-fdc66faecd68/final-audit.json. The rehearsal evidence remains separately under reports/canary/fork/2026-10-20T15-19-24-355Z; no fork transaction is included as mainnet evidence.

| Actual mainnet test contract | Address | Observed runtime code hash |
| --- | --- | --- |
| nand | 0xa246ab1715b8d0c66072dc0db934906516a96229 | 0x7f59d20c18c4dec6ddf617a9f085a87d4622efc279fbc1438e5293333288ec8f |
| latch | 0xf6133735fa93c6042f3bf84eb47894e23566cc62 | 0x7f59d20c18c4dec6ddf617a9f085a87d4622efc279fbc1438e5293333288ec8f |
| helper | 0xa93cb7a0af86af3a15bba3732564c9405e9ccf57 | 0x8ca6042e3eb2cc0dd51140193a52879153323afcd6d0609e76e01ba1499b3607 |
| pool | 0x5904d00d2990c8734051b5d0e7aaeba636dc591e | 0xd05dd9b09dcb11da1ae202b57954758e4e8e65a1d6f532908cc01638ea6b63ae |
| distributor | 0x47f09bb7a2361f8e2341d046441aea0321e2b612 | 0x3e2fa6a91cb4d3661049fdd6d7e315b12b816c317fd64e0c70c9e8c72733846f |

The original wallet and immutable recovery destination are **0x7eEDccb674e9549b61B01Eb65aC68DA071ADF129**. The canonical NFT collection is 0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C. Ordinary pool ownership is renounced. The recovery controller remains bound to the original wallet; admissions and Mining harvests remain permanently closed. Receipt supplies remain 4 NAND and 2 LATCH, and the retained final accounting composition is 3:1.

| Miner | Final owner at confirmed block | Mining status | Actual NAND / LATCH | Return transaction |
| --- | --- | --- | --- | --- |
| 3204 | 0x7eEDccb674e9549b61B01Eb65aC68DA071ADF129 | 1 (ACTIVE) | 2 / 0 | 0x6c15f5ab160aa381e600f663c0c3b94f321b08b5d376027d1cc7568dadb97b5b |
| 12485 | 0x7eEDccb674e9549b61B01Eb65aC68DA071ADF129 | 1 (ACTIVE) | 1 / 1 | 0x768804c76e15f33b2ded37efc0e303105b5f926f0d80c32c747e9184c489e29b |

Both NFTs were checked by ownerOf, not inferred from transaction success. Neither NFT remains in the canary; per-token approvals are cleared. Recovery did not depend on payout completion, and received-BEM payouts were completed after the returns. The upstream NFT transfer dependency remains a limitation.

### Exact admission boundary and positive revenue

- #3204 first-admission carried income: 52409 raw (0.00052409 BEM) under 2:0.
- Before the first bounded harvest, pending was 187 raw; the mined harvest actually received 793 raw (0.00000793 BEM). Pending was never used to skip collection.
- Real old-period BEM held but not accounted before second admission: 1126 raw (0.00001126 BEM).
- Nonzero #3204 income settled INSIDE second admission: 1075 raw (0.00001075 BEM).
- #12485 carried income received under new 3:1 composition: 77784 raw (0.00077784 BEM).
- Old-period checkpoint gross 55403 raw (0.00055403 BEM), frozen NAND base 54316, LATCH base 0.
- Subsequent positive 3:1 harvest: 1628 raw (0.00001628 BEM).

The held balance came from an actual Mining claim, followed by another full approved interval before second admission. It did not replace settlement. Old bases were frozen, and actual incoming carried income used the new composition. Expected values for each payment were reconstructed independently from BEM Transfer logs through its mined transaction, fixed composition periods, fixed supplies and independently retained per-ID claimed history.

### Late distribution, transfer and separate payouts

Wallet allocation was NAND #1-3 and LATCH #1; helper allocation was NAND #4 and LATCH #2. Helper delivery occurred after accrual and preserved prior entitlement. NAND #1 transferred with claimed history 13039 raw and positive unpaid 15137 raw (0.00015137 BEM). The helper claimed that ID's exact expected amount. Claimed history and unpaid rights followed the ID, and a repeat claim paid zero. The former-holder and non-whitelisted admission rejections were simulations matching the expected custom-error selectors. No intentionally failing transaction was broadcast.

| Receipt/role ledger at final confirmed block | Accrued raw | Paid raw | Outstanding raw |
| --- | ---: | ---: | ---: |
| NAND receipts | 112704 | 112704 | 0 |
| LATCH receipts | 19462 | 19462 | 0 |
| Recipient A, original wallet | 1321 | 1321 | 0 |
| Recipient B, helper | 1321 | 1321 | 0 |

A/B fee-role payments and receipt payouts have separate transactions/events, despite sharing holder addresses. Final A and B each equal floor(134815/102). Every per-ID outstanding entitlement is zero. Helper BEM was forwarded only to the original wallet and its final balance is 0 raw.

Recognized gross pool income is 134815 raw (0.00134815 BEM); total paid is 134808 raw (0.00134808 BEM). The remaining pool balance is 7 raw (0.00000007 BEM), entirely the bounded rounding residue 7 raw. Unrecognized income and deficit are 0 and 0 raw. Actual BEM inbound/outbound events reconcile with the ledger; the final original-wallet BEM increase equals pool payouts plus separately recorded post-return personal income.

### Post-return personal mining income

- Miner #3204: 4758 raw (0.00004758 BEM) to the original current owner, transaction 0x17e183c8b68075ab4991fe0ab6d4b3570594455a6663e4f2118444cb0c61791d.
- Miner #12485: 4925 raw (0.00004925 BEM) to the original current owner, transaction 0x658f532f94a10e4499dab42b0dcd979bc0436706206b8c4eaac78043e8525649.

Both post-return payments were positive and their recorded statuses ACTIVE. Their total 9683 raw (0.00009683 BEM) is excluded from pool gross income. It includes any previously unreceived Mining accrual that followed the NFTs on emergency return and should not be interpreted as income earned exclusively after the return timestamp. These are observations from this bounded run, not a guarantee of future upstream protocol behavior.

### Fees and final balance conservation

43 mainnet transactions were confirmed. Canonical receipts independently sum to **0.00091132426 BNB**, 911324260000000 wei. This equals the journal's fee counter and the original wallet's initial-to-final BNB decrease. Initial wallet BNB: 0.0537995327; final confirmed wallet BNB: 0.05288820844.

The total cap was 0.0034190386 BNB, per-transaction cap 0.0006079617 BNB, and the earmarked recovery reserve 0.000074497 BNB within that total cap. The waiting budget was 300 seconds across five 60-second reward intervals; transaction confirmation/RPC latency is additional. No fee cap was raised. No asset purchase, sale, listing, burning, stopping, challenging, reconfiguration or fundraising allocation was performed.

### Eight final success conditions

| Condition | Status |
| --- | --- |
| designatedMinersDepositedAndUsed | PASS |
| compositionChangedTwoZeroToThreeOne | PASS |
| oldEntitlementsPreservedAndNewIncomeCorrect | PASS |
| distributionClaimsPositiveEntitlementTransfer | PASS |
| bothRolesCorrectlyPaid | PASS |
| bothActualFinalOwnersOriginalWallet | PASS |
| finalAccountingReconciled | PASS |
| noUnrelatedOrFundraisingAssetsModified | PASS |

Original automation assertions: 26, 24 PASS and 2 FAIL. The rest of its normal sequence was aborted. Payout-continuation assertions: 13, all PASS. Final independent asset/accounting audit: PASS; original automation status remains FAIL_OR_INCOMPLETE. Failure reasons: ASSERTION_FAILED former-holder-claim-rejected; ASSERTION_FAILED closed-pool-admission-rejected. The normal pre-shutdown helper repeat/A-B releases/final harvest were skipped; the receipt-repeat and A/B payment behaviors were exercised during post-return continuation, while the final canary harvest remained skipped. Earlier local environment/harness failures remain separately preserved in fork evidence and the pre-mainnet review; they are not mainnet transactions or retagged mainnet success.

The canary remains a disclosed recoverable variant with different bytecode and authority from production. This run is not an independent audit, a live multisig test, a production deployment or proof of identical production bytecode.
