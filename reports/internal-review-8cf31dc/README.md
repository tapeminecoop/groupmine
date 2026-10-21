# Fresh evidence of Fable's follow-up review of candidate 8cf31dc (2.1.0 fee split), 2026-10-21

Produced on the reviewer's machine from `npm ci --ignore-scripts`, `forge clean` and a fresh `forge build` of
the checked-out candidate (branch `claude/fee-split-review-8cf31dc` at `8cf31dc`). Nothing was signed or
broadcast; no `.env` or key was read; the public RPC was used only as a read-only fork source and for two
`cast` reads. Report: `docs/INTERNAL_FEE_SPLIT_REVIEW_8cf31dc_FABLE.md`; machine-readable summary: `results.json`.

| File | Content |
| --- | --- |
| `01-build-and-forge-test.log` | clean install, build, `forge test` (151 passed; the `--ffi` differential test fails without the flag; 4 fork tests skipped) |
| `02-sdk-typecheck.log` | `test:sdk` 55/55, `typecheck`, the review's SDK test 3/3, canary revert tests 16/16 |
| `03-audit2-fork-audit-gas-e2e.log` | review-only suite `test/audit2` 30/30; `npm run test:fork` 17/17 at block 128,713,128; candidate `test/audit` with `--ffi` 10/10 (401 differential runs); GasModel figures; local e2e PASS (64 steps) |
| `fork-rerun/` | the fork observations written by this review's run (identical to `reports/fee-split-20261021-c3cb933/run/`), including `fork-sink.json` |
| `local-e2e/` | this review's local e2e outputs (the committed historical files were restored) |
| `baseline-c3cb933/build.log` | scratch build of `git archive c3cb933`: runtime hashes used for the metadata-stripped bytecode comparison |
