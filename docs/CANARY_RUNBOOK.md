# Recoverable Canary Runbook

This workflow is isolated from the production CLI and non-withdrawable production pool. Only miners
3204 and 12485 of the configured canonical TapeOut collection are permitted. The fixed original
wallet is the sole depositor and immutable recovery controller. Never use fundraising receipts.

## Configuration and preparation

Copy `.env.example` to this project's `.env` locally and fill `OWNER_PRIVATE_KEY` and `BSC_RPC_URL`.
Never paste the private key into chat, another project's environment, command arguments or a report.
The canary scripts explicitly call Node's `process.loadEnvFile('.env')`; the existing CLI does not.
The file is gitignored. Start with `MODE=fork` and `ALLOW_MAINNET_BROADCAST=false`.

```sh
npm run canary:build
npm run canary:verify-local
npm run canary:test
npm run test:sdk
npm run typecheck
npm run canary:inspect
npm run canary:fork
npm run canary:prepare
```

Inspect is read-only. Fork uses the commercial RPC only as a read-only source, pins a fresh block,
checks the real owner/status and the exact 2:0 / 1:1 burns, derives the original wallet then removes
the private key from the environment before starting Anvil. All fork transactions use local-only
impersonation/funding. A complete run and a separate interrupted run use fresh Anvil forks and the
same designated IDs, supplies and EOA-plus-contract-holder arrangement. Recovery is demonstrated
with actual NFT transfers, never by restoring a snapshot. The interrupted run starts standalone
recovery in a new process using only the persistent manifest/journal.

The candidate fingerprint covers production/canary Solidity, SDK, canary scripts/tests, dependencies,
build configuration and this runbook. Any change requires rebuilding, repeating the fork rehearsal,
and preparing an updated proposal. Source HEAD and every source/artifact SHA-256 are recorded.

`canary:prepare` creates `reports/canary/proposals/<run-id>.json` including the original wallet,
exact miners, candidate digest, predicted five deployment addresses, initial nonce, complete
transaction scope, actual fork gas measurements, current fee quote, proposed bounded fees/reserve,
waiting duration, confirmations and closure plan. It does not authorize broadcasting. The user must
approve that concrete proposal. The agent then records that approval and its exact proposal hash
in `reports/canary/approvals/<run-id>.json`; do not create this record before human approval.

After approval, configure the exact approved `MAX_RUN_FEE_BNB`, `MAX_TX_FEE_BNB`,
`RECOVERY_RESERVE_BNB`, `MAX_WAIT_SECONDS`, `MIN_CONFIRMATIONS`, `APPROVED_RUN_ID`, `MODE=mainnet`
and `ALLOW_MAINNET_BROADCAST=true`, then:

```sh
npm run canary:live -- --broadcast
```

The total cap includes recovery. Ordinary steps cannot consume the reserved portion of that cap or
the spendable wallet reserve. Each action is simulated and gas estimated before sequential sending.
Neither rewards nor NFTs are sent to an uncontrolled address. There are five fresh contracts; the
original receipt/distributor artifacts are reused. The helper has no BNB requirement or arbitrary
executor. A and B have separate transaction events, despite sharing holder addresses.

Five bounded reward intervals are planned: an initial all-NAND harvest, an old-miner claim that leaves
real BEM unrecognized in the pool, another full interval before the second admission's old-period
settlement, a 3:1 harvest, and the post-return personal-income check. With 60-second intervals the
total explicit waiting budget is 300 seconds. The direct old-miner claim does not replace settlement:
the second admission must independently receive positive old-period income after the next interval.

## Negative tests: structured revert verification

The negative tests are a former holder's claim, a non-whitelisted admission, and admission and harvest
after shutdown. Each simulates the call at one pinned block and decides on revert bytes from the
JSON-RPC error's structured `data`, at any nesting a provider uses
(`scripts/canary/revert-verifier.ts`). The bytes must ABI-decode to the expected custom error with
exactly the expected arguments, and re-encode to the same bytes. Message text is kept for diagnosis
only and is never evidence.

| Result | Outcomes | Effect |
| --- | --- | --- |
| PASS | the expected error and arguments | the workflow continues |
| FAIL | another error, other arguments, or no revert | the normal workflow stops; recovery follows |
| UNVERIFIED | no, empty, malformed or ambiguous revert data, or a transport failure, after 3 read-only attempts at the same block | the normal workflow stops; recovery follows |

Each record names the chain, block number and hash, caller, target, calldata, raw revert data,
decoded result and every attempt. An inconclusive negative test never lets live actions continue,
and the bounded retries never delay or replace recovery.

This replaces the original matcher, which searched viem's message text for "revert" and the
selector. On the mainnet run that matcher produced the two false negatives recorded in
`reports/canary/mainnet/canary-588196bf-…/results.json`. That run's recorded outcome stays
`PARTIAL_AUTOMATION_FAILED_RECOVERY_AND_ACCOUNTING_PASS`: 24 passes and 2 failures, with the final
pre-shutdown harvest skipped. Later diagnostics do not change it. Its source snapshot and the
approved-candidate guard pinned to `c4bc022` are unchanged. The corrected runner is a new candidate:
any further live run needs a rebuild, a fork rehearsal, a new proposal and a new approval.

## Local-candidate rehearsal without keys

```sh
node --import tsx scripts/canary/fork-local-candidate.ts --owner 0x7eEDccb674e9549b61B01Eb65aC68DA071ADF129 --fork-rpc <READ_ONLY_RPC> --out <DIR>
```

This runs the corrected workflow on two local Anvil forks: complete, then interrupted with standalone
recovery. It runs under a new run identity, as a separately fingerprinted `LOCAL_CANDIDATE_NOT_APPROVED`.
It never loads `.env`, refuses to run if `OWNER_PRIVATE_KEY` is set, impersonates the wallet's public
address on the fork only, and writes nothing under `reports/canary/`. The identity checks are those of
the normal rehearsal: `build-source --check`, the runner's deployed-code checks and the protocol
preflight at the fork block. It is evidence for the corrected tooling, not an approval for a live run.

## Emergency recovery after interruption

Do not restart the live runner, redeploy or repeat a deposit. The journal records intent, nonce and
the signed transaction hash *before* live broadcast, then the exact confirmed receipt and effects.
First reconcile any unknown/pending transaction by its hash, nonce, receipt and chain state. The
standalone command does this reconciliation and stops on an unresolved hash rather than retrying.
It can also reconstruct a deployment address if the process stopped before updating its manifest.

The previously approved fixed-destination recovery remains authorized after normal tests abort.
With the same original key, RPC and approved run gates configured:

```sh
npm run canary:recover -- --manifest reports/canary/mainnet/<approved-run-id>/manifest.json
```

For a still-running local fork only:

```sh
npm run canary:recover -- --manifest reports/canary/fork/<timestamp>/interrupted/manifest.json --local-rpc http://127.0.0.1:18566
```

Recovery does **not** call Mining.pending, Mining.claim, BEM.balanceOf, BEM.transfer, reward sync,
normal activation or receipt distribution. It checks our deployed bytecode, immutable controller
and NFT collection; sends `shutdown()` (irreversible); attempts `emergencyReturn(3204)` and
`emergencyReturn(12485)` in independent transactions; verifies both actual owners. One failed return
does not suppress the other attempt. Retry after resolving the underlying failure. Returned IDs
are idempotent. There is no destination argument, admission reopening or post-shutdown harvest.
Authorized NFTs transferred into the canary but never registered can also return, even before
activation and after owner renunciation. Upstream NFT transfer availability is still required.

If a return hash is pending, resolve it before sending another transaction from the same wallet.
Do not remove fee caps to bypass an exhausted budget: recovery reserve was earmarked at approval;
if external conditions require additional spending, obtain explicit approval for that adjustment.

## Payouts after shutdown

The pool keeps `active`, the admitted registry, final composition bases, all per-ID claimed histories,
A/B paid counters and total accounting intact. Shutdown prevents admissions and Mining harvests,
but `sync`, `claim`, `claimBatch`, `releaseA` and `releaseB` still account/pay BEM already held using
the frozen final composition. Restore BEM availability before retrying those payments. There is no
administrator sweep. Helper receipt claims use `CanaryParticipant.claim(nandIds,latchIds)` and its
`forwardBEM()` sends only its own BEM to the fixed original wallet. `transferReceipt` also goes only
to that wallet. Unreceived Mining income goes with a returned NFT and is not a pool payment.

## Evidence and success

Keep `reports/canary/fork/` and `reports/canary/mainnet/` separate. A mainnet PASS requires all eight
conditions in the requested task, including actual final ownerOf checks for both NFTs and complete
payout reconciliation. Recovery alone does not turn a failed business test into PASS. Both old
settlement and new-period income must be positive; zero incoming carried income is allowed and
recorded honestly. Actual BEM has 8 decimals; raw integer values are authoritative. Post-return
personal income is separate. Zero or unverified post-return payments must not be described as proof
of positive continued payment. This test is not an independent audit or proof of production-bytecode
identity. The canary's recovery authority is absent from production.
