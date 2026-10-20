# Future live smoke test (plan only, not executed)

The production pool has no way to return a miner, and that stays so. A live test with real miners
therefore needs either a separate probe contract (A) or a separate test-only pool variant (B). Neither
is the production deployment: both have different bytecode and permissions. The exact production
artifacts stay covered by the local-fork tests in [VERIFICATION_REPORT.md](VERIFICATION_REPORT.md).
Nothing in this document has been deployed or run on BSC mainnet.

## A. Minimal recoverable protocol probe

**Setup:** one operator-controlled ACTIVE miner, and a small test-only custody contract whose return
address is fixed at construction to the operator's original wallet.

| Step | What it exercises |
| --- | --- |
| 1. Deposit: the probe pulls the NFT from the fixed wallet (the only accepted source) | real ERC-721 custody by a contract |
| 2. Read `getMiner`, `cachedBurn` and `circuitBurn` | composition reads against live state |
| 3. Wait, then call `Mining.claim(key)`; measure the probe's BEM delta | income paid to a contract holder; `pending()` against actual payout |
| 4. Forward the BEM to the fixed wallet | payout routing |
| 5. Return the NFT to the fixed wallet | recovery |

**Recovery design:** returning the NFT must never depend on a successful claim. The return function
sends only to the fixed wallet, works whatever Mining does, and may be callable by anyone (the
destination cannot be changed). A final claim, if attempted, goes inside `try/catch` before the
return.

**Proves:** real custody and return; real claims paying a contract; composition reads; that after the
return the miner is still ACTIVE and the original wallet keeps collecting rewards.

**Does not prove:** anything about receipts, the distributor, the 102-part split, the admission
boundary, or the production pool's bytecode.

## B. Optional recoverable test-only pool variant

A copy of the production pool with an added, disclosed shutdown path, used for a complete live
workflow on throwaway value.

- **Isolation:** separate test receipts and a separate distributor; only controlled test miners,
  wallets, receipt holders and A/B recipients; no fundraising assets or contributor entitlements.
- **Fixed return destinations:** each miner goes back to the depositor recorded at admission, or to one
  recovery address fixed at construction; no free-form destination.
- **Shutdown sequence:**
  1. close admissions;
  2. attempt a final harvest (each miner in `try/catch`, so a failing claim cannot block recovery);
  3. recognize what arrived;
  4. return every NFT;
  5. leave receipt claims and A/B releases working for recognized BEM.

  Shutdown must be possible even if the final `Mining.claim` fails, so harvesting is never the only way
  to get a miner back.
- **Authority disclosure:** if shutdown is owner-gated, renouncing ownership removes it. Either keep a
  named recovery role that survives renunciation (disclosed as the one difference in trust), or let any
  whitelisted depositor trigger shutdown to the fixed destinations. State which, and that this
  authority does not exist in production.
- **Differences from production, to list in the test report:**
  - the shutdown and return functions and their role;
  - the different bytecode and code hash;
  - possibly a lower whitelist size or batch limits for the test.

  Receipts and distributor can be the production artifacts.

**Proves, live:**
- the full workflow on real BSC: deployment, issuance, distribution, deposits, a composition-changing
  admission, harvests, receipt transfers carrying unpaid BEM, claims, A/B releases;
- final reconciliation;
- recovery of every miner.

**Does not prove:** that the production bytecode behaves identically. The shared code paths do, but
the deployed artifact differs, so production-specific guarantees (no withdrawal, exact code hash)
still rest on the fork tests of the exact production artifacts.

## Evidence to record for either approach

- Transaction hashes, block numbers and contract addresses with their code hashes.
- NFT owner before deposit, during custody and after return.
- Non-zero BEM actually collected and where it was paid.
- For B: a composition-changing admission with its settled and carried amounts; a receipt transfer and
  the new holder's claim of unpaid BEM; final `reconcile --deep` output.
- After return: the miner's status is ACTIVE and the original wallet's own claim pays.
