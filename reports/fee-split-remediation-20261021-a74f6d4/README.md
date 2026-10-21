# Remediation evidence: follow-up reviews of the 2.1.0 fee split (`8cf31dc`)

Produced for [docs/FEE_SPLIT_AUDIT_REMEDIATION_REPORT.md](../../docs/FEE_SPLIT_AUDIT_REMEDIATION_REPORT.md).
Starting revision `a74f6d47577bc4c84a15e6dd244e72c490df901a`. No contract source changed. Every transaction
here belongs to a local Anvil chain or a local BSC fork. None was sent to a public network, no real key
signed anything, and no `.env` or wallet was read.

| Path | Contents |
| --- | --- |
| `assertions.json` | Each finding and preservation requirement with its evidence (in `run/` or this directory) and a status computed from the recorded results |
| `run/run-manifest.json` | The recorded `npm run verify`: tested tree fingerprint, tools, artifact hashes, fork inputs, and every step's command, timestamps, exit code and summary. The contract-identity step compares with `contract-identity-before.json` |
| `run/logs/` | One log per step (local paths removed); `audit-sdk-tests.log` includes the `test/audit2` TypeScript test |
| `run/*.json`, `run/*.tap`, `run/*.txt` | Step outputs: Solidity and SDK results, local and fork end-to-end reports, fork observations, the Safe test, the largest-wallet check, Slither, the post-run contract identity |
| `run/canary-fork/` | The modified canary workflow as a new local candidate on two local BSC forks: summary, complete run, interrupted run with standalone recovery. The saved ABI/bytecode bundle is recorded by hash |
| `contract-identity-before.json` | Contract identity at `a74f6d4` (fresh `forge build`), recorded before any change |
| `preservation-before.json`, `preservation-after.json` | sha256 of every `src/` file, the generated SDK ABI and bytecode, `foundry.toml`, `remappings.txt`, `package.json`, `package-lock.json`, the OpenZeppelin version, and the immutable-reference counts, before and after |
| `immutable-references.json` | Immutable-reference occurrences per production contract in the build and in `sdk/bytecode.json`, and whether their offsets are equal |
| `historical-unchanged.json` | The review reports, review-only tests, historical evidence, approvals, snapshots and patch files compared byte for byte with `a74f6d4` after the run |
| `reproductions/t-210-01-offline-{before,after}.json` | The actual CLI, `deploy-receipts --system deployments/examples/system.bsc.example.json`, run with an environment holding only `PATH` and `HOME` (no `RPC_URL`), before and after the fix |
| `reproductions/c-210-01-metadata-before-after.json` | The original (`a74f6d4`) and the remediated canary verifier against the same in-memory node: failing `getChainId`, failing `getBlock`, and a control |

Fork sources (read-only RPC host `bsc-mainnet.public.blastapi.io`):
- BSC block 128,713,128 (`0x760f050b…081f`) for the fork tests, the fork end-to-end runs and the Safe test;
- block 128,812,145 (`0x383f1f97…a922`) for the canary rehearsal;
- the block before the replayed revocation (119,597,280) for the Mining transition test.

## How this directory was made

1. **Before any change:** `forge build`, then `node --import tsx scripts/contract-identity.ts --out
   contract-identity-before.json` and `preservation.py before-a74f6d4`. The CLI reproduction before the
   fix ran next, and then the scratch reproduction of the original verifier (`git show
   a74f6d4:scripts/canary/revert-verifier.ts`, kept in the ignored `.runtime/`).
2. **After all code changes,** the recorded run:
   ```bash
   FORK_RPC_URL=https://bsc-mainnet.public.blastapi.io SLITHER=<slither 0.11.3>/bin/slither CANARY_FORK_BLOCK=128812145 IDENTITY_BASELINE=reports/fee-split-remediation-20261021-a74f6d4/contract-identity-before.json node --import tsx scripts/verify-all.ts
   ```
3. **Copy and restore.** The runner writes into `reports/`. Its outputs were copied into `run/`
   (`reports/canary-local-rehearsal/` became `run/canary-fork/`). The tracked files in `reports/` were
   then restored to `a74f6d4` and the run's new top-level files removed, as the earlier runs did. The
   manifest's `reports/…` paths refer to run-time locations.
4. **After the run:** `preservation-after.json`, `immutable-references.json` and
   `historical-unchanged.json`, then `assertions.json`. Nothing in it is asserted by hand.
