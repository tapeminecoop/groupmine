# TapeOut Recoverable Canary Test Report

Status: **FORK REHEARSAL PASS / MAINNET NOT RUN**. Mainnet approval is pending.

## Objective, scope and safety boundary

Exercise only miner #3204 (2 NAND / 0 LATCH) and #12485 (1 NAND / 1 LATCH), with isolated test receipts, a controlled second holder, separate admissions changing composition from 2:0 to 3:1, actual BEM claims, receipt transfer, separate A/B payments, permanent closure and fixed-wallet NFT recovery.

All transactions in the chronological table are LOCAL ANVIL FORK transactions. No real wallet signature was used for them. The commercial BSC RPC was a read-only fork source. Local impersonation/funding and time advancement were restricted to loopback Anvil. **No mainnet transaction has been signed or broadcast; actual mainnet BNB spent is 0.** No fundraising asset or contributor allocation was used.

## Source revision, exact candidate and build

- Base and current HEAD: c4bc022c76c5de528a98caa58974ee5772f80d4a. The original tree was clean. Implementation changes are uncommitted.
- Exact candidate SHA-256: a4003a06dca0164c89852cb65b137d45fa24665fa8cf21f33cab220af2c9385f.
- Source hashes, artifact hashes and settings: reports/canary/candidate.json and reports/canary/local-verification.json.
- Solidity 0.8.24; EVM Paris; via-IR; optimizer 200 runs. Canary runtime 20404 bytes, initcode 32279 bytes.
- Production sources remain unchanged. Exact adaptation: reports/canary/production-canary.diff; generated reproducibly by scripts/canary/build-source.mjs.

The canary copies the reviewed private/non-virtual production implementation and retains authoritative Mining composition reads, cached-burn cross-checks, strict old-miner settlement, incoming carried-income treatment, cumulative 100:1:1 accounting, receipt supplies and per-ID claimed history. It adds an immutable fixed-wallet recovery controller, a single depositor, only IDs 3204/12485 of its immutable collection, irreversible shutdown and independent per-miner returns. **Its bytecode and permissions differ from the non-withdrawable production pool.** Production has no recovery switch and was not deployed or modified by this work.

## Mainnet read-only identity and asset observations after rehearsal

Snapshot block 128769037, hash 0x20d3398cc7e5626ec5fa39beb0424a1ef25ba3824b7ce78c78e2e12bc7c51a8b. Recovery destination and signer: 0x7eEDccb674e9549b61B01Eb65aC68DA071ADF129.

| Miner | On-chain owner | Status | Actual NAND / LATCH | Pending raw | Token approval |
| --- | --- | --- | --- | ---: | --- |
| 3204 | 0x7eEDccb674e9549b61B01Eb65aC68DA071ADF129 | 1 (ACTIVE) | 2 / 0 | 43989 | 0x0000000000000000000000000000000000000000 |
| 12485 | 0x7eEDccb674e9549b61B01Eb65aC68DA071ADF129 | 1 (ACTIVE) | 1 / 1 | 66370 | 0x0000000000000000000000000000000000000000 |

All protocol and composition identity checks passed, including network 56, the canonical collection, proxy/beacon/implementation identities and code hashes, actual Mining records, cachedBurn and circuitBurn. BEM decimals: 8. Wallet BNB: 0.0537995327; wallet BEM: 9259723 raw (0.09259723 BEM). Pending is an observation and never an exact promise of a later claim amount.

## Fork source and contract identities

Source block 128768886, hash 0x32d46710fd4c02fdc185920b12c8b4d40016722cada692e0c120c2a967ea7e7d. Rehearsal directory: reports/canary/fork/2026-10-20T15-19-24-355Z. The rehearsed reward interval is 60 seconds, matching the proposed live interval; Anvil advances local time instead of waiting in real time. Confirmations on fork: 1; proposed mainnet confirmations: 3.

| Contract | LOCAL fork address | Observed runtime code hash | Proposed mainnet address, undeployed |
| --- | --- | --- | --- |
| nand | 0xa246ab1715b8d0c66072dc0db934906516a96229 | 0x7f59d20c18c4dec6ddf617a9f085a87d4622efc279fbc1438e5293333288ec8f | 0xA246aB1715B8D0c66072Dc0db934906516a96229 |
| latch | 0xf6133735fa93c6042f3bf84eb47894e23566cc62 | 0x7f59d20c18c4dec6ddf617a9f085a87d4622efc279fbc1438e5293333288ec8f | 0xf6133735fA93c6042F3BF84eB47894E23566cc62 |
| helper | 0xa93cb7a0af86af3a15bba3732564c9405e9ccf57 | 0x8ca6042e3eb2cc0dd51140193a52879153323afcd6d0609e76e01ba1499b3607 | 0xa93CB7A0aF86Af3a15bba3732564c9405e9CCf57 |
| pool | 0x5904d00d2990c8734051b5d0e7aaeba636dc591e | 0xd05dd9b09dcb11da1ae202b57954758e4e8e65a1d6f532908cc01638ea6b63ae | 0x5904D00d2990c8734051b5d0e7AAEbA636DC591e |
| distributor | 0x47f09bb7a2361f8e2341d046441aea0321e2b612 | 0x3e2fa6a91cb4d3661049fdd6d7e315b12b816c317fd64e0c70c9e8c72733846f | 0x47F09Bb7a2361F8E2341d046441Aea0321e2b612 |

Creation/runtime template hashes and immutable references are in the candidate/local build records. Actual fork bytecode was matched against the exact artifact with immutable positions masked, and controller/protocol/receipt/recipient/depositor bindings checked before NFT approval. Proposed mainnet addresses are nonce-derived expectations, not deployments. Actual mainnet deployed identity must be checked before any NFT approval or admission.

## Issuance and complete JSON allocation

Both production receipt implementations were freshly deployed on the fork, issued to the original wallet, finalized at 4 unique NAND IDs and 2 unique LATCH IDs, transferred to the production distributor, imported from allocation.json, completely verified in both directions and finalized. All four setup owners were renounced after their required finalization/activation.

| Holder | NAND IDs | LATCH IDs | Role |
| --- | --- | --- | --- |
| Original wallet | 1, 2, 3 | 1 | A |
| Controller-only CanaryParticipant | 4 | 2 | B |

The helper's receipts stayed in the distributor through income accrual, then were delivered with prior unpaid entitlements intact. The helper has no arbitrary executor, requires only the original signer, and needs no BNB. This is an **EOA-plus-contract-holder** test; no second independent EOA signer or live multisig was tested.

## Chronological LOCAL fork transactions

| Action | LOCAL fork hash | Block | Gas used | LOCAL simulated fee BNB |
| --- | --- | ---: | ---: | ---: |
| deploy-nand | 0x8ec3edd92484822e96430204f01cab2cbd364272265ceb569c4d13b16089dff0 | 128768887 | 2066032 | 0.00011363176 |
| deploy-latch | 0xa5a39df114a8a58ad02dc65dfe6d008695415d57bca40a04445e3f9d4e106511 | 128768888 | 2066082 | 0.00011363451 |
| deploy-helper | 0xda0284024a2a57b629f31bc0324bc5541c6b94b5fe0dcb6e1a748cf990c6f876 | 128768889 | 822046 | 0.00004521253 |
| deploy-pool | 0x10fb4bf97e1f7c3486d63ba80b2bbb62ec16e16c05597335b9644c46a850f42e | 128768890 | 4847694 | 0.00026662317 |
| deploy-distributor | 0x8afdbf63766377418ee788c9b35df5025c315b3e51c6a591ed18d22a384747d4 | 128768891 | 1771212 | 0.00009741666 |
| bindPool | 0x9a57c87fdb21bf29eb78328b2b5b9cc73e7ddfd9bb4393f4406027659911b635 | 128768892 | 58506 | 0.00000321783 |
| issue | 0x0e52fb04803be876b525173281d295d92432e24c88336dff96eddd2eaa406afe | 128768893 | 240731 | 0.000013240205 |
| issue | 0x4a81e04145034d50ef691e457e02bff2d4a07adb5c295813ac51fe25f6af648c | 128768894 | 148024 | 0.00000814132 |
| finalizeIssuance | 0xe1e80419ad0eb33d3e401031ba65c04aab2770c518b49d0f2f8279165b6593e7 | 128768895 | 48908 | 0.00000268994 |
| finalizeIssuance | 0xf7810a169f4c9d703d243af22e5f3805ee4652af311d8fa99b7dc450b075a242 | 128768896 | 48908 | 0.00000268994 |
| safeBatchTransferFrom | 0xbbfb03cd5f95e2b5b70a482590cf455fd7116a1548eb04f0a4e9a9561efe7855 | 128768897 | 195247 | 0.000010738585 |
| safeBatchTransferFrom | 0x4ce5a5d7c69cda265ab1eab84b23c6835e8ce9561c3aec556ebc8695764d2a24 | 128768898 | 128625 | 0.000007074375 |
| allocate | 0x2a1543de64f6e3a8787271bf296baaeadc8fd9ca1b0e0f6f966ebf1b26d54549 | 128768899 | 508069 | 0.000027943795 |
| finalizeAllocation | 0x442ef80a54384212c751c7d0c04fc83b4dcca7db5cc3489971192e76bfb4a44c | 128768900 | 69523 | 0.000003823765 |
| activate | 0x9017afc59c95d652c581d2e67273059e947d43a440c81a0bfd880d0aee7d7e29 | 128768901 | 111548 | 0.00000613514 |
| renounce-nand | 0xee77b2e1b7a9fc956a133de20aa21a77d8beeaff96fa35a4c90c96444f27ca60 | 128768902 | 25688 | 0.00000141284 |
| renounce-latch | 0x8b937103fab901b9717c8ffb642827e255af6fe1fe96a22802e2b2e1b8495841 | 128768903 | 25688 | 0.00000141284 |
| renounce-distributor | 0x835ab6f93d08e91943f64ce14dfd1e04bd5090acde98d87ab57f07ce25664fa6 | 128768904 | 25543 | 0.000001404865 |
| renounce-pool | 0xa49455f0f5b72a0f97b3c37d1f18f5a3d7ee3136fbbcd81b5af89fcf5a4ce9c9 | 128768905 | 26027 | 0.000001431485 |
| approve-3204-only | 0xbd0bc40988fe08b4d483214aee65819657266dcd90e33cda03412f65a464a8c4 | 128768906 | 56352 | 0.00000309936 |
| phase-A-deposit-3204 | 0x38e669188550229a9cb38588b150e759f414fa30a9c9a4d8b8f4ff07050afb3f | 128768907 | 425562 | 0.00002340591 |
| phase-A-bounded-harvest | 0xb886448dd22e3ea03a8b385e91a2c84f38c0eab14144d33ca7ab14992d9d545c | 128768909 | 143514 | 0.00000789327 |
| deliver-original-wallet-receipts | 0x38932a33ae578821ae9c57ea4af407057951d81e9da2ad1b165d8f2312871a6c | 128768910 | 250349 | 0.000013769195 |
| phase-A-subset-claim | 0x39f796f9ce4dbae5507afb7a831b9a7cde1e442055d3ba8f33b313798b2df7ea | 128768911 | 172561 | 0.000009490855 |
| old-miner-income-held-before-admission | 0x6de7ae007943b01c6cf22045b8e807dab099d886e979781660ab0765f89a84bd | 128768913 | 104805 | 0.000005764275 |
| approve-12485-only | 0x837de9323c2f14dcf2a271083b1a46fb2f44d50b6dc4445206ada0460e1130bf | 128768915 | 56352 | 0.00000309936 |
| phase-B-deposit-12485 | 0xa67104d72f16fbdd63530548ab9d3ddaab69407d7287bb0719564bcb1e1f3f01 | 128768916 | 398484 | 0.00002191662 |
| phase-C-harvest-3-1 | 0x73af162dea65fba1fad83f13247ee469ed6082af3405a6d185dccf152fe74cbd | 128768918 | 178991 | 0.000009844505 |
| late-deliver-helper-receipts | 0x00e27be70de3ac606e21903481017314444d3f87e1b83ae3f65f50e28c599879 | 128768919 | 161147 | 0.000008863085 |
| helper-initial-receipt-claim | 0xf9f52b0fd8a14840ec70408470d60b02dab9a589b68ed945b435c5c0d2058f07 | 128768920 | 188613 | 0.000010373715 |
| original-selected-claim | 0x812a189cc4cb74719480820baecccbbcc11c0ecc184ee710440f42239dde162d | 128768921 | 129015 | 0.000007095825 |
| transfer-unpaid-nand-1-to-helper | 0x9664998deab50f6e272ae8a0812adba270b923ec54391f02490657c6188d0016 | 128768922 | 60062 | 0.00000330341 |
| helper-claims-transferred-nand-1 | 0x95877999cada9d60fc7ace27451effbefb3cd24d2c9dbcc795aa573db0e965b5 | 128768923 | 101638 | 0.00000559009 |
| helper-repeat-claim | 0x0a86bb2fb86680ec58a1d68b72d66d045e6007ff766bbe688687095eb486679d | 128768924 | 77551 | 0.000004265305 |
| release-A-separately | 0xab607f3966091fef5cff0f3ab38f008b0be1c31ef3b8ddd16e11566be9a6983a | 128768925 | 99526 | 0.00000547393 |
| release-B-separately | 0x84abdff3eb8be713de8cddfb7140b648580a1f5b21bdf82341b6ab6d1134a83e | 128768926 | 98228 | 0.00000540254 |
| phase-D-orderly-final-harvest | 0xa9be408f8764b222e1a4c226c1688acf04d499d2005daca99218184c368d1415 | 128768927 | 101678 | 0.00000559229 |
| permanent-shutdown | 0x7632ee467dc0ed6e43ee1f9e1cd0ab93db6f2d03eda69629fcdf48a2115f00e3 | 128768928 | 45903 | 0.000002524665 |
| return-3204 | 0x3b3a0ec0cd7a7e0c44b8a357bc06e9ed28e2b88db2429c4547a969b7c9bdf4b5 | 128768929 | 105579 | 0.000005806845 |
| return-12485 | 0x6606a590a4d7cc283be6cb2abe4c201bf54060db39101cb5604926b74b828790 | 128768930 | 83705 | 0.000004603775 |
| final-wallet-receipt-claims | 0xb663dece798c4cdec2ff5de9b808f3b1c208f82b6b40e6ea7475b2bfb6237926 | 128768931 | 131430 | 0.00000722865 |
| final-helper-receipt-claims | 0xb29a2966d37707c27027173795dc22ed3e40e28da9c84c8c5cd4aa64be896b4a | 128768932 | 98548 | 0.00000542014 |
| final-release-A | 0x35c68003d5b160f11be9ba83083897108a72288576a1cf88b3ea8e1b7916f5ab | 128768933 | 61137 | 0.000003362535 |
| final-release-B | 0x31dac0170b3950571b8cff19bb4b8096061cf761e04b492bbd4418251b7d757b | 128768934 | 59839 | 0.000003291145 |
| helper-forwards-BEM-to-original | 0x2a0e035724089ba6fd457af65fb8432d6afc9d4016f3f25bb28c96f6a7c56743 | 128768935 | 35458 | 0.00000195019 |
| post-return-owner-income-3204 | 0x7268bdbe0dcc819e1dc7ffa1ab27afe13eb091ea512c52afdbbf490392bd7dd0 | 128768937 | 104805 | 0.000005764275 |
| post-return-owner-income-12485 | 0xaa4ebd900bb67759b4b08da15f5cae74cb664c78198553a59a971a3117306707 | 128768938 | 90216 | 0.00000496188 |

The persistent journal records sender, target, function, calldata, hash, nonce, block/hash, timestamp, confirmations, gas, fee, raw/decoded events and before/after BEM or ownership changes. Exact artifacts are saved beside each manifest. Live signed hashes will be persisted before broadcast; unknown/pending hashes must be reconciled before retrying.

## Old/new accounting boundary and independent expected payouts

- First admission carried income: 44458 raw (0.00044458 BEM) under 2:0.
- Actual old-period income settled INSIDE second admission: 626 raw (0.00000626 BEM).
- BEM already held but not accounted immediately before second admission: 637 raw (0.00000637 BEM). It came from a real Mining claim, followed by another full interval before admission, so it did not replace the positive old-miner settlement.
- Actual incoming #12485 carried income: 68728 raw (0.00068728 BEM) under 3:1. Zero would be permitted and recorded honestly.
- Old-period checkpoint gross: 46347 raw (0.00046347 BEM); frozen NAND base 45438, LATCH base 0.
- Positive new-period harvest: 1272 raw (0.00001272 BEM).
- Before the first bounded harvest, pending reported 0 raw while the actual mined harvest received 626 raw (0.00000626 BEM). Pending was never used to skip the claim.

Expected payments are reconstructed independently from recorded BEM Transfer events through the mined transaction, fixed periods and supplies, and independently maintained per-ID claimed histories. Neither PoolMath, sdk/math nor pool.claimable generates the expected payout. The specification is P=floor(100T/102), A=B=floor(T/102), old NAND base=floor(100T_boundary/102), new NAND=base+floor(3(P-base)/4), new LATCH=floor((P-base)/4); per-ID values divide NAND by 4 and LATCH by 2. Integer floors carry the documented rounding residue.

NAND #1 transferred with claimed history 11050 and positive unpaid 13177 raw (0.00013177 BEM). The new contract holder received its exact independently computed payout; a repeat claim paid zero. Former-holder and non-whitelisted admission simulations required the correct custom-error selectors; no intentionally failing transaction was broadcast. A/B payments were separated from receipt payouts by their own transactions/events and balance changes.

## Recovery, interrupted runner and final fork reconciliation

Normal path: final harvest/accounting, permanent shutdown, independent return transactions, actual ownerOf checks at confirmed blocks, completion of received-BEM payouts, helper BEM forwarding. Both actual final owners are 0x7eEDccb674e9549b61B01Eb65aC68DA071ADF129; the canary is closed. The closed pool also rejects admission and harvest in simulations.

An additional fresh fork interrupted the ordinary runner after #3204 admission and partial receipt claims. A new process read the saved manifest/journal and executed standalone shutdown/return; #3204 returned and #12485 remained in the fixed original wallet. Both actual owners were verified. No snapshot rollback was used as recovery evidence.

Shutdown and emergencyReturn make **no Mining.pending, Mining.claim, BEM.balanceOf, BEM.transfer or reward-sync call**. Recovery survives owner renunciation, incomplete registration and setup interruption. Independent returns permit retries and do not accept another destination. The NFT contract must still allow transfer; upstream transfer risk remains. Already received BEM retains the final admitted composition and persistent claimed histories; receipt claims/sync/A/B releases continue after shutdown, with no administrative sweep. Unreceived Mining income follows the returned NFT and is excluded from pool income.

| Final LOCAL fork ledger | Raw BEM |
| --- | ---: |
| Recognized gross income | 116347 |
| Total paid | 116344 |
| NAND receipt paid / accrued | 96908 / 96908 |
| LATCH receipt paid / accrued | 17156 / 17156 |
| A paid / accrued | 1140 / 1140 |
| B paid / accrued | 1140 / 1140 |
| Unrecognized / deficit | 0 / 0 |
| Rounding residue / pool balance | 3 / 3 |

All outstanding entitlements were paid. The residue is within the 7-raw-unit bound for these supplies and is not unpaid participant income. Actual BEM inflow/outflow logs independently equal recognized income and payments. NFT transfer logs contain only the four expected custody/return transfers of the two authorized IDs; no collection-wide approval or unrelated transaction target was used.

After the bounded post-return interval, both miners remained ACTIVE and paid their current owner on the fork:

- Miner #3204: 637 raw (0.00000637 BEM), LOCAL tx 0x7268bdbe0dcc819e1dc7ffa1ab27afe13eb091ea512c52afdbbf490392bd7dd0.
- Miner #12485: 637 raw (0.00000637 BEM), LOCAL tx 0xaa4ebd900bb67759b4b08da15f5cae74cb664c78198553a59a971a3117306707.

These personal payments are excluded from pool gross income. Equivalent post-return mainnet behavior remains **NOT RUN**.

## Individual assertions and failed/incomplete attempts

Current exact-candidate fork assertions: 41, all PASS. Local Solidity tests: 107/107; SDK tests: 36/36; formatting/source-adaptation/typecheck PASS. Mock recovery fault tests: 12/12, including Mining failure, BEM balance/transfer failure, invalid-opcode dependencies, owner renunciation, partial returns/retries, unauthorized callers/destination changes, unregistered custody and interrupted setup.

| Assertion | Current fork status |
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
| former-holder-claim-rejected | PASS |
| non-whitelisted-admission-rejected | PASS |
| helper-claims-transferred-nand-1-exact | PASS |
| helper-repeat-claim-exact | PASS |
| repeat-claim-pays-zero | PASS |
| role-A-separate-cumulative-allocation | PASS |
| role-B-separate-cumulative-allocation | PASS |
| orderly-final-harvest-no-failure | PASS |
| permanently-closed | PASS |
| closed-pool-admission-rejected | PASS |
| closed-pool-harvest-rejected | PASS |
| final-owner-3204 | PASS |
| final-owner-12485 | PASS |
| final-wallet-receipt-claims-exact | PASS |
| final-helper-receipt-claims-exact | PASS |
| actual-BEM-transfers-match-total-income-and-payouts | PASS |
| independent-final-payout-reconciliation | PASS |
| no-unrelated-assets-or-collection-wide-approvals | PASS |

Preserved prior attempts:

- 2026-10-20T15-08-24-589Z: FAIL_OR_INCOMPLETE; Gas price above approved ceiling. The first local attempt stopped before any NFT admission because Anvil's recommendation recursively compounded a 10% gas-price margin. Both NFTs remained in the original local wallet. The harness now pins the fresh upstream quote for fork-only fee simulation; mainnet still re-quotes with its approved caps. This failed attempt is retained and is not relabeled PASS.

A separate repeat attempt could not start while the local environment file was being edited; it sent no transaction. Missing configuration is not a protocol failure. Mainnet deployment, custody, income, payouts, recovery and final ownership checks remain NOT RUN; a successful fork does not establish them.

## Concrete mainnet proposal, pending human approval

Run ID: canary-588196bf-b2d8-4c9b-9c60-fdc66faecd68. Proposal file: reports/canary/proposals/canary-588196bf-b2d8-4c9b-9c60-fdc66faecd68.json; proposal SHA-256: 625c2ff5985917dcebd59d3aea88bdb5ca60b9b754dde12c6225cde1efd417d6.

- Exact miners: 3204 and 12485; fixed recovery wallet 0x7eEDccb674e9549b61B01Eb65aC68DA071ADF129.
- Five fresh contracts at the proposed addresses above; exact candidate a4003a06dca0164c89852cb65b137d45fa24665fa8cf21f33cab220af2c9385f.
- 47 planned sequential transactions, including deployments, full setup/distribution/admissions/claims/transfer/A-B releases, orderly harvest/shutdown, independent returns, remaining payouts/helper forwarding and separate post-return personal claims.
- Estimated fees at current quote: 0.0011148472 BNB. Total approved-cap PROPOSAL: 0.0034190386 BNB; per-transaction cap proposal: 0.0006079617 BNB; earmarked recovery reserve: 0.000074497 BNB. Reserve is part of the total cap and cannot be consumed by ordinary steps.
- Gas-price ceiling: 100000000 wei. Waiting bound: 300 seconds total across five 60-second intervals. Confirmation policy: 3 blocks per mainnet transaction.
- Any business assertion failure prioritizes fixed-destination recovery and retains the failure. No blind resend/redeployment on unknown or pending transactions. No other assets, recipients, code or spending scope is authorized by this proposal.

No approval record has been created. A populated environment file, fork success or this report is not approval to broadcast. Mainnet state/balances must be rechecked again after actual approval and immediately before the first real transaction.

## Evidence and limitations

See reports/canary/results.json, local-verification.json, recovery-test-results.json, candidate.json, reports/canary/fork/2026-10-20T15-19-24-355Z/source.json, both run manifests/artifacts/journals/results/recovery files, the proposal, production-canary.diff, and docs/CANARY_RUNBOOK.md. Fork hashes are never mainnet hashes. This is a bounded test of a disclosed recoverable variant, not an independent audit, a production deployment or proof of identical production bytecode. Overall MAINNET PASS is not established.
