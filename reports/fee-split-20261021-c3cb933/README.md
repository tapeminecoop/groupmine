# Fee split evidence: `TapeoutMinerPool/2.1.0` (80 : 1 : 1 : 2 of 84, sink C)

Produced for [docs/FEE_SPLIT_CHANGE_REPORT.md](../../docs/FEE_SPLIT_CHANGE_REPORT.md). Starting revision
`c3cb93375737de7ec63baa9f390edd0c15a5c7a4`. Every transaction here belongs to a local Anvil chain or a
local BSC fork. None was sent to a public network, no real key signed anything, and no `.env` or
wallet was read.

| Path | Contents |
| --- | --- |
| `assertions.json` | Each requirement of the change and each validation item, its evidence (test, check or observation, located in `run/`), and a status computed from the recorded results (PASS / FAIL / NOT_RUN) |
| `run/run-manifest.json` | The recorded `npm run verify`: tested tree fingerprint, tools, artifact hashes, fork inputs, and every step's command, timestamps, exit code and summary |
| `run/logs/` | One log per step (local paths removed) |
| `run/*.json`, `run/*.tap`, `run/*.txt` | The step outputs: Solidity and SDK results, local and fork end-to-end reports, fork observations (`fork-sink.json` is the real-BEM sink test), the Safe test, the largest-wallet check, Slither, and the post-run contract identity |
| `run/canary-fork/` | The local-only canary-2 candidate on two local BSC forks: summary, complete run, interrupted run with standalone recovery (manifests, journals, results). The saved ABI/bytecode bundle is recorded by hash |
| `contract-identity-before.json` | Contract identity of `c3cb933`, from a fresh build of `git archive c3cb933` with the same toolchain |
| `contract-identity-compare.json` | Before against `run/contract-identity.json`: the official comparison, field-level differences, the metadata-only check for the distributor and the canary helper, and whether only the expected differences occur |
| `bem-probe.json` | Read-only facts about BEM at fork block 128,713,128 (hash `0x760f050b…081f`): code size and hash, ERC-1967 slots, supply, the sink's balance |
| `historical-unchanged.json` | The historical 2.0.0 reports, journals, approvals and snapshots compared byte for byte with `c3cb933` after the run |

Fork sources:
- BSC block 128,713,128 (`0x760f050b7ec66ced2a2745918d7492650150f9d71d3159259412996ebe65081f`) for the fork
  tests, the fork end-to-end runs and the BEM probe;
- block 128,812,145 (`0x383f1f97b08e13da4cbfc88908ec57643a0f186ee89de5d0a7a765f920f4a922`) for the canary
  rehearsal;
- the real Mining revocation replay forks the block before it (119,597,280).

The RPC host is `bsc-mainnet.public.blastapi.io`, used read-only as the fork source.

## How this directory was made

1. **The recorded run** started in the worktree, after all code changes, with:
   ```bash
   FORK_RPC_URL=https://bsc-mainnet.public.blastapi.io SLITHER=<slither 0.11.3 venv>/bin/slither CANARY_FORK_BLOCK=128812145 node --import tsx scripts/verify-all.ts
   ```
   An earlier start was stopped before its fork steps so that `.gitignore` could keep this directory's
   logs; this is the complete run that followed.
2. **Copying and restoring.** The runner writes into `reports/`. Its outputs were copied into `run/`
   (`reports/canary-local-rehearsal/` became `run/canary-fork/`). The tracked files in `reports/`, the
   historical 2.0.0 evidence, were then restored to `c3cb933`, and the run's new top-level files were
   removed, as the remediation run did. The manifest's `reports/…` paths therefore refer to run-time
   locations.
3. **Baseline identity.** `git archive c3cb933` was extracted and built in a scratch directory with
   `forge build --skip test --skip script`. The identity was computed as `scripts/contract-identity.ts`
   computes it, then compared with
   `node --import tsx scripts/contract-identity.ts --compare contract-identity-before.json run/contract-identity.json`.
4. **BEM probe.** `eth_getCode`, `eth_getStorageAt` and `eth_call` against a local Anvil fork of block
   128,713,128.
5. **`assertions.json`** was generated from `run/` and the two comparison files. Nothing in it is
   asserted by hand.
