# Fresh evidence of the internal security review of revision f2c8e50 (2026-10-21)

Produced on the reviewer's machine from a clean `npm ci --ignore-scripts` and a fresh `forge build`
(forge 1.4.3-stable, solc 0.8.24, node v20.19.5, viem 2.57.2, OpenZeppelin 5.4.0). No transaction was
broadcast; no credential was used. The report is `docs/INTERNAL_SECURITY_REVIEW_f2c8e50.md`.

| File | Content |
| --- | --- |
| `01-build-and-forge-test.log` | install, build, `forge test`: 107 passed, 0 failed, 3 skipped (fork suites without RPC) |
| `02-sdk-typecheck-local-e2e.log` | `test:sdk` 36/36, `typecheck`, canary `build-source --check`, `test:local-e2e` PASS |
| `03-audit-forge-tests.log` | first run of `test/audit/*`: 8 passed, 2 failed (defects in the review's own tests, see report §3.3) |
| `04-fork-tests.log` + `fork-rerun/` | `npm run test:fork` at block 128,713,128 with the recorded inputs: 11/11; observation JSON byte-identical to the committed `reports/fork-*.json` |
| `05-differential-fuzz.log` | corrected differential fuzz against `test/audit/model.py`: 401 runs PASS |
| `06-audit-suite-final.log` | final run of the whole audit suite: 10/10 Foundry, 9/9 + 1/1 SDK |
| `local-e2e-rerun/` | `reports/local-e2e*.json` as written by this review's run (the committed files were restored) |
| `chain/*.code` | deployed runtime code of the live canary contracts read at head 128,777,627 (`cast code`), used for the masked comparison with the fresh build |
