# Evidence: internal review of Groupmine 2.2.0, target 6345de8 (Fable 5.1, 2026-10-29)

Report: `docs/INTERNAL_GROUPMINE_2_2_REVIEW_6345de8_FABLE51.md`. Review-only tests and model:
`test/review-fable51/` (`model_fable.py`, `search_rounding.py`, `ReviewDifferential.t.sol`,
`ReviewFindings.t.sol`); the 2.1.0 counterexample test is copied to `poc/OldOrder.t.sol`.

Scope: local execution only (forge in-process forks, loopback Anvil, read-only public RPC
`bsc-mainnet.public.blastapi.io`). No transaction signed or broadcast, no key or `.env` read, no
protocol code or storage patched. The canary rehearsal was deliberately not run.

| Path | Contents |
| --- | --- |
| `identity/target-commit.txt`, `git-status-before.txt`, `source-sha256.txt`, `source-fingerprint.json`, `origin-main.txt` | the frozen target and its clean state before any run (fingerprint `c464fe4b…`, equal to the implementer's recorded run) |
| `identity/contract-identity.json` | `scripts/contract-identity.ts` on the fresh build (sizes 23,168 / 8,743 / 7,680 / 24,439 B) |
| `identity/source-diff-after.txt`, `git-status-after.txt` | the final source-difference record: only new review files; tracked files restored |
| `logs/build-sizes.log` | `forge build --sizes` |
| `logs/npm-ci.log` | `npm ci --ignore-scripts` |
| `results/forge-tests-summary.json` (+ `logs/chainA.status`) | per-suite, per-test status, gas and fuzz/invariant counters condensed from the three `forge test --json` outputs: `--no-match-path 'test/{fork,audit,salus-ffi}/*'` 226/226, `test/salus-ffi` 2/2, `test/audit` 10/10. The raw 25 MB `solidity-tests.json` is not committed (the recorded runs commit summaries too); it is reproducible with the command |
| `results/salus-ffi.json`, `results/audit-ffi.json` | the two FFI suites' raw `--json` outputs (small) |
| `logs/gas-model.log` | 11/11 |
| `logs/typecheck.log`, `results/sdk-tests.tap` (78/78), `results/audit-sdk-tests.tap` (13/13), `logs/local-e2e.log`, `results/local-e2e*.json` (59/59), `results/largest-wallet.json` (+ `logs/chainB.status`) | TypeScript, SDK and local Anvil runs |
| `logs/fork-test.log`, `results/fork/*.json` (+ `logs/chainC.status` with the endpoint probe) | real-BSC fork tests 20/20 at block 128,713,128 (`0x760f050b…081f`); the foundry RPC cache for that block pre-existed on this machine |
| `logs/fork-nocache.log` (+ `.status`) | SALUS and boundary fork tests with `--no-storage-caching`: 7/7 from the live endpoint |
| `logs/fork-e2e.log`, `logs/fork-safe-e2e.log`, `results/fork/fork-e2e*.json`, `results/fork/fork-safe-e2e.json` (+ `logs/chainD.status`) | CLI fork end-to-end 25/25; Safe end-to-end 266/266 |
| `results/slither-src.json`, `logs/slither.txt` (+ `.status`) | Slither 0.11.3 on an isolated export: 170 results in all, the 98 that touch `src/` kept in full in the JSON (check, impact, confidence, description), triaged in the report §3.2; `logs/slither.txt` is the complete text output. The raw 10 MB `slither.json` is not committed |
| `logs/review-findings.log` | the 18 review PoCs (all pass as asserted; gas figures inside) |
| `logs/review-differential.log` (+ `.status`) | 400 traces against the independent model |
| `results/rounding-search.json` | pure-arithmetic rounding/overflow search |
| `logs/old-order-c78a6d1.log` (+ `.status`) | the SALUS #2 counterexample executed on an export of `c78a6d1` |
| `logs/export-abi.log`, `logs/contract-identity.log` | SDK re-export unchanged; identity written |
| `results/summary.json` | machine-readable roll-up of every step |

Timestamps and exit codes: `logs/*.status`. Every `forge`/`node` command is the one in `results/summary.json`.
