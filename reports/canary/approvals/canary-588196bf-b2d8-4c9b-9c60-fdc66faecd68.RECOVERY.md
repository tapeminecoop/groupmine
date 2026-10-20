# Approved Run: Standalone Fixed-Destination Recovery

Run: `canary-588196bf-b2d8-4c9b-9c60-fdc66faecd68`.
Original wallet and sole return destination: `0x7eEDccb674e9549b61B01Eb65aC68DA071ADF129`.
Collection: `0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C`.
Only authorized miners: `3204`, `12485`.
Expected canary pool: `0x5904D00d2990c8734051b5d0e7AAEbA636DC591e`.

The human explicitly approved the complete mainnet run and fixed-destination recovery in this chat.
The original proposal caps remain in effect: total 0.0034190386 BNB, per transaction 0.0006079617 BNB,
earmarked recovery reserve 0.000074497 BNB within the total cap. Recovery is not contingent on
completing receipt delivery, claims, reward collection, activation or report generation.

Keep the original private key and commercial RPC in this project's local `.env`. Do not put them in
command arguments. The following environment settings are public run gates only:

```sh
env MODE=mainnet ALLOW_MAINNET_BROADCAST=true APPROVED_RUN_ID=canary-588196bf-b2d8-4c9b-9c60-fdc66faecd68 npm run canary:recover -- --manifest reports/canary/mainnet/canary-588196bf-b2d8-4c9b-9c60-fdc66faecd68/manifest.json
```

The command reconciles saved transaction hashes/nonces/receipts, verifies the deployed canary and
immutable original wallet, permanently shuts down admissions/harvests, independently attempts each
held authorized NFT return and checks actual `ownerOf` for both IDs. It deliberately does not invoke
Mining, BEM balance queries/transfers or reward synchronization. One return failure does not suppress
the other attempt. Already-returned IDs are safe to retry after reconciling any pending transaction.

Do not rerun the live deployment runner, redeploy, repeat a deposit or blindly replace an unknown
transaction. If a hash is unknown or pending, reconcile its exact receipt, nonce and chain state
first. Preserve the manifest, exact saved artifacts, journal and recovery results. Actual final
ownership must be the original wallet; successful transaction status alone is insufficient.

The underlying NFT contract must still permit transfer. Recovery does not remove that upstream risk.
