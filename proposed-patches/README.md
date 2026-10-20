# Proposed patches (internal security review, revision f2c8e50)

None of these is applied. They are proposals against the frozen candidate; `src/` is untouched.

| Patch | Target | Finding | Note |
| --- | --- | --- | --- |
| `0001-canary-structured-revert-matcher.patch` | `scripts/canary/workflow.ts` (+ new `scripts/canary/revert-matcher.ts`, a copy of `test/audit/revert-matcher.ts` without the `frozenRunnerDecision` helper) | T-1, T-2 | Negative tests decide on revert bytes and classify every other outcome; regression: `test/audit/revert-matcher.test.ts` |
| `0002-allocation-tooling-supply-and-finalize-preflight.patch` | `sdk/verify.ts`, `cli/pool.ts` | T-3, T-4 | `verify-allocation` reports issued supply and retained receipts; `finalize-allocation` gets the same readiness preflight as `import-allocation`/`activate`/`renounce`. `cli/pool.ts` must import `readAllocationState` from the SDK. Regression: `test/audit/verify-supply-gap.test.ts` (documents the gap; update its expectations when the patch lands) |

The changed canary runner must be rebuilt, fork-rehearsed and re-approved before any further live run
(`docs/CANARY_RUNBOOK.md`): the candidate fingerprint covers `scripts/canary/`.
