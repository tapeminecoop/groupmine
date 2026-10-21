# Mining status lifecycle (release gate U-01)

Date: 2026-10-21. Branch `claude/security-review-remediation`. This closes the upstream question U-01
of [AUDIT_REMEDIATION_REPORT.md](AUDIT_REMEDIATION_REPORT.md):
- can a REVOKED miner ever become claimable or restart?
- does its unpaid debt stay uncollectible?
- how does a COOLING miner restart, and is its debt reset?

**Scope.** All work ran on local BSC forks and local analysis only. Public RPC access was read-only
(`bsc-mainnet.public.blastapi.io`). Nothing was deployed, signed or broadcast, no wallet secret or
`.env` was loaded, and no Solidity under `src/` was changed. Protocol code and storage were never
modified: no `vm.etch`, `vm.store`, `mockCall` or `deal`. On the forks, the current NFT holders and
the real challenger were impersonated, and the block number and time were advanced. Mining's source
is not published, so every code-level statement below was derived from the deployed bytecode.

Status words: **VERIFIED** means executed on a fork, or derived from the deployed code by the
reproducible analysis described below. **UNVERIFIED** means not established.

## 1. Answer

All statements apply to Mining implementation `0xa3DBe873…f898` and its library `0xFbB661Fe…E6bA`
(identity in §3). They are the code behind the Mining proxy since block 119,565,927, and that code
can no longer be replaced (§3).

| # | Statement | Status | Evidence |
| --- | --- | --- | --- |
| 1 | REVOKED (2) is terminal. No function moves a miner out of status 2: not back to ACTIVE, not to COOLING, not to idle (0) | **VERIFIED** | Code: the status byte is written at exactly three sites, and none of them accepts status 2 (§4). Fork: on #2247 at the pinned block, the holder's `start`, `stop`, `reclaim` and `claim` all revert; `claimMany` skips it; nothing changes a month later. Same after replaying its real revocation |
| 2 | A REVOKED miner earns nothing and pays nothing after its revocation | **VERIFIED** | Code: revocation removes the miner's weight. Weight is written back only by `start` (which refuses status 2) or for ACTIVE records. The only BEM payment, the settlement routine, is entered only for status 1. `pending` returns 0 unless the status is 1. Fork: `pending` 0 and claims refused a month later, record unchanged |
| 3 | The revocation itself first pays the holder everything accrued, as any settlement does (up to BEM's remaining supply, §5) | **VERIFIED** | Code: `challenge` settles before it writes status 2 when the miner is ACTIVE. Fork replay of #2247's real revocation: the holder received exactly what a claim would have paid, 1,454,667 raw, the same amount as on chain |
| 4 | "Uncollectible debt" is not a loss. `debt` is the accumulator checkpoint (weight × accumulator / 1e27 at the last settlement), not an amount owed. After a revocation it is frozen and nothing remains owed | **VERIFIED** | Code: settlement sets `debt` to the accrued value and pays `accrued − debt`. `debt` is written only by settlement, `start`, `reclaim` and the demotion helper's ACTIVE branch. Fork: `debt` rose by exactly the revocation payment (212,133,524 → 213,588,191), then stayed constant |
| 5 | A COOLING (3) miner can be restarted only by the miner NFT's holder, and only from block `stopBlock + 1,201` | **VERIFIED** | Code: `start`'s gate. Fork: #672's holder restarts it, a stranger cannot (`0xa8ee9629`). After a stop, `start` is refused at `stopBlock + 1,200` and accepted at `stopBlock + 1,201` |
| 6 | A restart resets the debt to the current accumulator. The cooling period earns nothing, and income accrues from the restart and goes to the holder | **VERIFIED** | Code: `start` writes the full record, with `debt` = weight × accumulator / 1e27. Fork: #672's debt went 5,408,752 → 35,610,025 at its restart. Nothing was pending, and a claim paid nothing; a day later a claim paid 531,091 raw to the holder |
| 7 | A COOLING miner can still be revoked through block `stopBlock + 1,200`, without any payment (the stop already paid and removed the weight). After that, `challenge` refuses it while it is cooling | **VERIFIED** (new) | Code: `challenge`'s condition. Fork: after #2247's holder stops it, its real challenge revokes it at `stopBlock + 1,200` with no `Claimed` event. At `stopBlock + 1,201` the challenge reverts and the holder can restart instead |
| 8 | Status 0 is never re-entered | **VERIFIED** | Code: the three status writes store 1, 3 and 2 |
| 9 | Demotion (`kick`, a better `start`, `reclaim`) never changes a status. It settles and re-weights only an ACTIVE record; any other record only loses its bonus/optimal bits | **VERIFIED** | Code (§5) |
| 10 | The library cannot change any miner record | **VERIFIED** | Code (§6) |
| 11 | Starting a never-started circuit (0 → 1) on this implementation | **UNVERIFIED by execution**; VERIFIED from code | `start`'s gate admits status 0. Not executed: the two original starts recorded (#2247, #672) ran under the previous implementation |

## 2. What this means for the pool

- **The REVOKED skip in `_settleOld` is sound for this implementation.** When a registered miner is
  revoked, the `challenge` transaction itself pays the miner's accrued income to the holder, here the
  pool. The miner then accrues nothing, every claim for it reverts, and it can never restart, so
  skipping it at admission loses nothing (statements 1 to 4).
- **Revocation income is booked in the right composition period.** The pool receives that payment
  without calling Mining, so the next recognition of its balance books it: an admission's step 2
  (before the checkpoint) or a harvest. Every admission settles all registered miners first. The
  income paid at a revocation therefore accrued after the miner's last settlement, which was no
  earlier than the last admission, so it accrued in the composition period still current when it is
  booked. This is reasoning from the pool's code (`_sync` runs in admission step 2
  before `_checkpoint`; ARCHITECTURE.md §4.2) combined with statement 3. It was not executed with a
  pool-held miner, because a real counterexample was available only for #2247 at a historical block.
- **COOLING does not arise for pool-held miners.** Only the NFT holder can stop a miner, and the pool
  never calls `stop` (existing fork test `testOnlyTheCurrentHolderCanStop`). A registered miner can
  still be revoked by anyone with a vector its circuit fails. It then keeps its burn weight in the
  pool's composition (O-02, pending acceptance).
- **Admission requires ACTIVE** (`_readComposition`). A revoked miner can never be admitted again. A
  cooling miner can be restarted by its holder and then admitted; it carries only income accrued
  since the restart (statement 6).
- The remaining upstream dependency is the miner collection, which Mining asks for `ownerOf` when it
  checks holders and pays income. Its beacon owner can still upgrade it (U-02, pending acceptance).

## 3. Identity and upgrade authority

| Item | Value |
| --- | --- |
| Mining proxy | `0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46`, 130 bytes (`0xed6b710a…bbce`): it reads the ERC-1967 slot and delegate-calls, with no storage writes and no admin functions |
| Implementation | `0xa3DBe873DA37cD4e4a13c7cEf23a7dB6Ca60f898`, 24,574 bytes, code hash `0x63b1124d3448fdeb28b163c52142e15a7a464d7ae7d817e51f6c242b62424479` (the hash `protocol-check` pins), solc 0.8.24 metadata, 93 functions |
| Linked library | `0xFbB661Fe281112C601954AbB0a3CDCC697a6E6bA` (hard-coded `PUSH20` before every library `DELEGATECALL`), 10,136 bytes, code hash `0x028ff888dc6b7505d507ffd33ef99d8541a23852d36a0463de235af6772e4737`, 9 functions |
| History | Implementation slot first set, to `0x7637b9a6…8CAE`, at block 117,234,441; changed to `0xa3DB…f898` at block 119,565,927; unchanged at every probe through 128,713,128 (one probe per million blocks, then bisection: `reports/probe-implementation-history.json`) |
| Owner | `0x000…000` at block 128,713,128: OpenZeppelin `OwnableUpgradeable` slot `0x9016…9300` is zero; Initializable version 1 |

The implementation can no longer be replaced:
- **Implementation slot.** It is written only by `upgradeToAndCall` (site `0x30af`), on paths that
  require `msg.sender == owner` and a call through the proxy.
- **Owner slot.** It is written only at `0x4c75` (by `transferOwnership` and the initializer) and
  `0x53db` (by `renounceOwnership` and `0x3fb27b85`). Every path to these sites requires
  `msg.sender == owner`, except the initializer's.
- **Initializer.** It passes its guard only at version 0, or at version 1 when the proxy has no code.
  Neither holds.
- **No self-destruct.** Neither the implementation nor the library contains `SELFDESTRUCT`, `CREATE`,
  `CREATE2` or `CALLCODE`.

With the owner renounced, nothing can change the owner or the implementation. Owner-only functions
(including `pause`) can no longer be called.

## 4. Status transitions

A miner's record is `keccak256(key . 8)` + 0…6, where `key = keccak256(circuits ‖ circuitId)`:

| Word | Contents |
| --- | --- |
| +0 | `circuits`, `circuitId`, `taskId` |
| +1 | `gateCount`, `stateCount`, `depth`, `area`, `mult`, `since` |
| +2 | **status (low byte)**, `registrant`, `nandBurn`, `latchBurn` |
| +3 | `bstar`, `bonus`, `optimal`, `commitBlock` |
| +4 | `firstUnusedId`, `stopBlock` (bits 64–127), verified weight (bits 128–255) |
| +5 | unverified weight |
| +6 | `debt` |

The status byte is written at exactly three of the implementation's 89 storage-write sites:

| From → to | Function, site | Condition on every path (symbolic execution) | Payment | Executed on a fork |
| --- | --- | --- | --- | --- |
| 0 → 1 | `start`, `0x1954` (status 1 is a constant stored at `0x15d2`) | status 0 | none (no weight before) | no (UNVERIFIED by execution) |
| 3 → 1 | `start`, `0x1954` | status 3 and `block.number > stopBlock + 1200` | none; debt rebased | yes: #672 restart and the boundary |
| 1 → 3 | `stop`, `0x2a33` | status 1; caller holds the NFT | settles first, then removes the weight and records `stopBlock` | yes (existing lifecycle tests and here) |
| 1 → 2 | `challenge`, `0x3527` | status 1; a vector the circuit fails | settles first (`0x34d7`), then removes the weight | yes: #2247's real revocation replayed |
| 3 → 2 | `challenge`, `0x3527` | status 3 and `block.number <= stopBlock + 1200` | none | yes |
| 2 → any | none | – | – | every attempt refused |

Guards and their revert data:
- **`start`** passes its gate (`0x14eb`–`0x1504`, `0x1daf`–`0x1de4`) only as listed above, and
  otherwise reverts with `0x802cdbc8`. Before the gate it has no side effect other than a read-only
  call. A caller who does not hold the NFT gets `0xa8ee9629`.
- **`claim` and `stop`** revert with `0x5f9bb3be` unless the status is 1. `stop` by a non-holder
  reverts with `0xa8ee9629`.
- **`challenge`** refuses any other state with `0x5f9bb3be` (observed for a revoked miner and for a
  cooling miner past its cooldown).
- **`reclaim`** reverts with `0xd4c8e0a4` unless the status is 1.

The error names are not published; these are the selectors in the code, with the meanings the code
and the official frontend's messages give.

## 5. Payments, weights and debt

- **One payment path.** The implementation has one `CALL`: `BEM.mint(holder, amount)` at `0x51d9`,
  inside the settlement routine `0x50ac`. Settlement first sets `debt := weight × acc / 1e27`. It then
  mints the difference to the old `debt` to the NFT's current holder, capped at BEM's remaining supply
  (`MAX_SUPPLY() − totalSupply()`); nothing is minted when that is zero. Near BEM's maximum supply,
  the uncapped remainder is forgone, since `debt` has already advanced.
- **Settlement is gated.** It is entered from six sites, each after a status-1 check for the key it
  settles: `claim`, `stop`, `challenge`, `reclaim` (its own key), `claimMany` (per key, skipping
  others) and the demotion helper's ACTIVE branch. Control-flow exploration shows no other way in.
  `pending` returns 0 for any status other than 1.
- **Weights.** A record's weights are set by `start` (behind its gate) and changed by `reclaim` and
  the demotion helper for status-1 records only. `stop` and `challenge` clear them. The weight
  totals move by exactly the miner's weight (fork: 12 removed at #2247's revocation, 3 added at
  #672's restart).
- **Demotion helper (`0x5746`).** It is reached from `kick`, `reclaim` and `start`. For an ACTIVE
  record it settles, recomputes the weight without the bonus and rebases the debt. For any other
  record it only clears the bonus and optimal bits (`0x57b5`) and emits `Demoted`.
- **Other writes.** `reclaim`, `kick` and `start` write record words +3, +4 and +6 and the per-task
  leader records (mapping 9: holder + 1 and cost; mapping 0x19). Every one of the 89 write sites is
  classified in `reports/mining-lifecycle-analysis.json`.

## 6. The library

`0xFbB6…E6bA` runs in Mining's storage through `DELEGATECALL`, so its writes were analysed too:
- Of its 9 functions, only `0x42e970bb` can reach a storage write (17 sites). It refuses direct
  calls (`address(this)` must not be the library).
- It writes only below its first argument: the array length at the pointer, two-word elements at
  `keccak256(pointer)`, and the bytes data under them.
- Mining calls it only from `registerCounterexample` (site `0x0df4`) and passes
  `ces[taskId][circuits]` (mapping 0x18).
- The other library calls (`0x0f10eaf3`, `0x19b5e29a`, `0xdae832b6`, `0xbec54efa`, `0x4a7f17e8`,
  `0xfadec174`) compute; they cannot write storage.

## 7. Executed evidence

`test/fork/MiningTransitions.t.sol`, run with the fork suite through `scripts/fork-test.ts`:
**16 / 16 PASS** at block 128,713,128 (hash `0x760f050b…081f`), 2026-10-21 03:54 UTC. Observations
are in `reports/fork-transitions-*.json`.

| Test | State | What it shows |
| --- | --- | --- |
| `testRevokedMinerStaysRevokedAndEarnsNothing` | pinned block, #2247 (revoked at 119,597,281) | weight 0, nothing pending. The holder's `start` (`0x802cdbc8`), `stop` (`0x5f9bb3be`), `reclaim` (`0xd4c8e0a4`) and `claim` (`0x5f9bb3be`) are refused and `claimMany` pays nothing. A month later, record and totals are unchanged and nothing has been paid |
| `testRealRevocationPaysHolderOnceThenNothing` | fork of block 119,597,280, executing at block 119,597,281 and its timestamp | The real challenge (tx `0x2234e269…bb14`, exact calldata, real sender) pays the holder 1,454,667 raw, exactly a claim's amount and the on-chain amount, emits `Revoked`, and removes weight 12 from the total. Debt rises by the payment and then stays. Every way back is refused, including a second challenge. Nothing accrues in a month |
| `testStopCooldownDecidesBetweenRevocationAndRestart` | same historical fork | The holder stops #2247 (paid 1,454,667). At `stopBlock + 1200` no restart, but the challenge revokes with no payment. From a snapshot at `stopBlock + 1201`: the challenge reverts `0x5f9bb3be` and the holder restarts (unverified, task 0) |
| `testCoolingMinerRestartsWithDebtRebased` | pinned block, #672 (stopped at 118,184,257) | A stranger cannot restart it (`0xa8ee9629`); the holder can. Status 1, `stopBlock` cleared, unverified weight 3 back in the total, debt 5,408,752 → 35,610,025, nothing pending at the restart. One day later 531,091 raw is claimable and paid to the holder |
| `testRestartNeedsMoreThanTheCooldown` | pinned block, #672 | Restart, then stop: `start` refused at `stopBlock + 1200`, accepted at `stopBlock + 1201` |

The historical fork runs the same implementation as the pinned block. The test asserts this by
reading the proxy's implementation slot.

Read-only probes (`reports/`):
- `probe-start-2247.json` and `probe-start-672.json`: the original starts, located by binary search
  over the status, with full calldata. #672 started unverified (task 0, no samples, block 117,291,096).
  #2247 started verified (task 228, 5 samples, block 117,648,266). Both ran under the previous
  implementation.
- `probe-restarts.json`: all 21,000 records at block 128,713,128. 17,806 ACTIVE, all with weight and
  none with a `stopBlock`. 11 REVOKED and 23 COOLING, all with zero weight (and `stopBlock` set for
  every cooling one). `start` clears `stopBlock`, so this neither confirms nor excludes earlier
  restarts. Public RPC log queries were refused (rate-limited or paid-only), so restarts in history
  were not enumerated.
- `probe-implementation-history.json`: the implementation history in §3.

## 8. Method and its limits

`scripts/mining-analysis/` (Python 3, standard library only), run on the fetched code:
- **`evm.py`**: a disassembler.
- **`cfg.py`**: control-flow exploration of every dispatcher entry. It tracks only jump-target
  constants on the stack and explores both branches of every conditional jump. All jumps in all 93
  implementation and 9 library entries resolved, so the reachable set over-approximates every real
  execution.
- **`sym.py`**: a bounded symbolic executor with symbolic storage and calldata. External calls return
  unknowns.
- **`lifecycle.py`**: re-derives every fact in §3 to §6 as **133 checks** and writes
  `reports/mining-lifecycle-analysis.json`. It refuses code with other hashes.

Limits:
- Symbolic execution unrolls loops at most 2 to 6 times. The status conditions are established on
  every explored path. The path from each lifecycle function's entry to its status check is explored
  in full, so no loop is cut before a check.
- Memory and storage aliasing is decided syntactically. Reentrancy is not modelled, but every
  external call other than BEM's `mint` is a `STATICCALL` (which cannot change state) or a
  `DELEGATECALL` into the analysed library (or, in the owner-only upgrade, into the new
  implementation). `mint` follows the record update.
- Some write sites are not reached symbolically. They are classified from the fork trace of a real
  restart (#672) and from the code, as listed in the report's `classification` field. Two of them,
  the leader-record writes in `start`, were resolved by symbolic execution from inside `start` with
  an unknown stack.
- The names of `start`'s arguments and of the errors are inferred; the deployed contract publishes
  neither.
- Behaviour before block 119,565,927 (the previous implementation) was not analysed. The current
  records of all revoked and cooling miners have zero weight.
- Pool-side booking of a revocation payout (§2) is reasoning from the pool's code, not an execution
  with a pool-held miner.

## 9. Reproduce

```bash
node --import tsx scripts/fetch-mining-code.ts 128713128 reports/mining-code
```

```bash
python3 -I scripts/mining-analysis/lifecycle.py reports/mining-code reports/mining-lifecycle-analysis.json
```

```bash
FORK_RPC_URL=<read-only archive RPC> FORK_BLOCK=128713128 FORK_NAND_MINER=12733 FORK_LATCH_MINER=13948 FORK_INACTIVE_TOKEN=648 FORK_SCALE_MINERS=4183,1574,6940,4307,4655,3207,13617,7924,11127,4951,3932,10031,14559,16112,8714,2161,6767,11214,6453,14011,16944,15731,7541,5930 npm run test:fork
```

Read-only probes: `scripts/probe-start.ts <tokenId> <fromBlock> <toBlock>`,
`scripts/probe-restarts.ts <block>` and `scripts/probe-implementation-history.ts <fromBlock> <toBlock>`.
The historical fork tests need an archive endpoint that serves block 119,597,280.

At the release block, `npm run pool -- protocol-check` must report `IDENTITY_MATCHES_RECORDED`. It
pins the implementation code hash above, and with it the library, whose address is hard-coded in
that code and which cannot self-destruct. With the owner renounced, a change would be unexpected, and
these conclusions would then have to be re-derived.
