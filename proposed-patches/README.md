# Proposed patches (internal security review, revision f2c8e50)

None of these is applied. They are proposals against the frozen candidate; `src/` is untouched.

| Patch | Target | Finding | Note |
| --- | --- | --- | --- |
| `0001-canary-structured-revert-matcher.patch` | `scripts/canary/workflow.ts` (+ new `scripts/canary/revert-matcher.ts`, a copy of `test/audit/revert-matcher.ts` without the `frozenRunnerDecision` helper) | T-1, T-2 | Negative tests decide on revert bytes and classify every other outcome; regression: `test/audit/revert-matcher.test.ts` |
| `0002-allocation-tooling-supply-and-finalize-preflight.patch` | `sdk/verify.ts`, `cli/pool.ts` | T-3, T-4 | `verify-allocation` reports issued supply and retained receipts; `finalize-allocation` gets the same readiness preflight as `import-allocation`/`activate`/`renounce`. `cli/pool.ts` must import `readAllocationState` from the SDK. Regression: `test/audit/verify-supply-gap.test.ts` (documents the gap; update its expectations when the patch lands) |

The changed canary runner must be rebuilt, fork-rehearsed and re-approved before any further live run
(`docs/CANARY_RUNBOOK.md`): the candidate fingerprint covers `scripts/canary/`.

## Follow-up review of 8cf31dc (2.1.0 fee split), 2026-10-21

| Patch | Target | Finding | Note |
| --- | --- | --- | --- |
| `0003-fee-split-change-report-claims-accrue-c.patch` | `docs/FEE_SPLIT_CHANGE_REPORT.md` | P2-1 | Entry-point table: `claim`/`claimBatch` do accrue C (they run `_sync`); they never pay it. Documentation only. |
| `0004-sdk-version-guard-for-tuple-layout.patch` | `sdk/pool.ts` | T2-1 | `readPoolSummary` refuses a pool whose `VERSION` is not a 2.1.0-layout version, so `inspect`/`reconcile` cannot silently decode a 2.0.0 tuple with the 2.1.0 ABI (or the reverse). Not applied; regression: `test/audit2/FeeSplitConsumers.t.sol`, `test/audit2/fee-split-consumers.test.ts`. |
