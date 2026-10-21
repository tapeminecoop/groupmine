# Remediation evidence (internal security reviews of `f2c8e50`)

Produced for [docs/AUDIT_REMEDIATION_REPORT.md](../../docs/AUDIT_REMEDIATION_REPORT.md).

| Path | Contents |
| --- | --- |
| `contract-identity-before.json` | Existing Solidity sources, ABIs, creation bytecode and runtime templates from a forced clean build of `b846c0c`, before any change |
| `findings.json` | The cross-review findings matrix, machine-readable |
| `run/run-manifest.json` | The definitive `npm run verify` run: tested tree fingerprint, tools, artifact hashes, and every step's command, timestamps, exit code and summary |
| `run/logs/` | One log per step (local paths removed) |
| `run/*.json`, `run/*.tap`, `run/*.txt` | The step outputs: Solidity and SDK results, local and fork end-to-end reports, fork observations, the Safe test, the largest-wallet check, Slither, and the post-run contract identity |
| `run/canary-fork/` | The corrected canary workflow on a local BSC fork, as a new local candidate: summary, complete and interrupted runs (manifests, journals, results, recovery). The saved ABI/bytecode bundle is recorded by hash |

The runner writes into `reports/`. After the run, its outputs were copied here and the earlier
baseline evidence in `reports/` was restored, so the manifest's `reports/…` paths refer to the
run-time locations. All transactions belong to local Anvil chains or local forks. None was sent to a
public network, and no real key signed anything.
