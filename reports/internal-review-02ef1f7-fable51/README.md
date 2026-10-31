# Evidence: internal review of Groupmine 2.3.0, target 02ef1f7 (Fable 5.1, 2026-10-31)

Report: `docs/INTERNAL_TWO_POOL_DISTRIBUTOR_REVIEW_02ef1f7.md`. Review-only tests: `test/review-02ef1f7/`
(`ReviewTwoPool.t.sol`, `ReviewTwoPoolFork.t.sol`). Worktree at the frozen commit; nothing under `src/`,
`sdk/`, `cli/`, `script/`, existing tests, lockfiles or historical reports changed (see `identity/`).

Scope: local execution only (forge in-process forks with `--no-storage-caching` where stated, loopback
Anvil, read-only public RPC `bsc-mainnet.public.blastapi.io` pinned by block hash). No transaction signed
or broadcast, no key or `.env` read, no protocol code or storage patched. The canary-4 rehearsal was
deliberately not run (it exercises the recovery entry points).

| Path | Contents |
| --- | --- |
| `identity/target-commit.txt`, `git-status-before.txt`, `source-sha256.txt`, `source-fingerprint.json` | the frozen target and its clean state before any run; fingerprint `5beb9b98…` equals the developer's recorded run |
| `identity/bytecode-vs-sdk.txt` | fresh build vs `sdk/bytecode.json` (match) |
| `identity/tracked-files-touched-by-runs.txt`, `git-status-after.txt`, `source-diff-after.txt` | which tracked files the runners overwrote (restored), and the final source-difference record |
| `logs/build-sizes.log`, `logs/canary-check.log`, `logs/export-abi*.{log,txt}` | sizes, canary-4 generator check, SDK re-export unchanged |
| `results/forge-tests-summary.json` (+ `logs/chainA.status`, `logs/frozen-suites.status`) | per-suite/per-test status, gas and fuzz/invariant counters for: the frozen suites run alone (244/244, 30 suites), `test/salus-ffi` 2/2, `test/audit` 10/10, `test/review-fable51` 20/20. The raw 28 MB `forge test --json` outputs are not committed (reproducible with the commands in the report) |
| `results/salus-ffi.json`, `results/audit-ffi.json`, `results/review-fable51.json` | the FFI suites' raw `--json` outputs (small) |
| `logs/gas-model.log` | `GasModelTest` 11/11 with the 2.3.0 bounds as gas limits |
| `logs/typecheck.log`, `results/sdk-tests.tap` (79/79 after the build), `results/audit-sdk-tests.tap` (13/13), `logs/sdk-tests.err` | TypeScript; the first SDK run (before `out/` existed) failed 9 tests on missing artifacts and was rerun (`logs/chainD.status`) |
| `logs/local-e2e.log`, `results/local-e2e*.json` | two-pool CLI lifecycle on loopback Anvil: 79/79 checks |
| `logs/largest-wallet.log`, `results/largest-wallet.json` | PASS |
| `logs/fork-test.log`, `results/fork/*.json` (+ `logs/chainC.status` with the endpoint probe) | 21/21 fork tests at block 128,713,128 (`0x760f050b…081f`) |
| `logs/fork-twopool-nocache.log` | `TwoPoolForkTest` without the storage cache: PASS |
| `logs/fork-e2e.log`, `logs/fork-safe-e2e.log`, `results/fork/fork-e2e*.json`, `results/fork/fork-safe-e2e.json` (+ `logs/chainD.status`) | CLI fork end-to-end 26/26; Safe end-to-end 294/294, 28 Safe transactions |
| `results/slither-src.json`, `logs/slither.txt` (+ `.status`) | Slither 0.11.3 on an isolated export: 170 results, 98 in `src/`, 0 new versus the 2.2.0 run |
| `logs/review-two-pool.log` | the 19 review-only two-pool tests (final run; an earlier run was rejected for a `testFail`-prefixed name, and one fixture expectation was corrected, see report §7) |
| `logs/review-two-pool-fork.log`, `results/review-02ef1f7-fork.json` | the real-state staggered lifecycle test (`--no-storage-caching`) and its observations |
| `results/summary.json` | machine-readable roll-up of steps and findings |

Commands, timestamps and exit codes: `logs/*.status` and `results/summary.json`.
