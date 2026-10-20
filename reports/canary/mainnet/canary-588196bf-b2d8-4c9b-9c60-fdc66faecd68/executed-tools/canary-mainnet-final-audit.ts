import { readFileSync } from 'node:fs';
import { env, remote, save, P, nftAbi, artifact, fingerprint } from '/Users/jaychen/Desktop/tapemine/scripts/canary/common.ts';
import { erc20Abi, miningAbi } from '/Users/jaychen/Desktop/tapemine/sdk/constants.ts';

async function main() {
  process.chdir('/Users/jaychen/Desktop/tapemine');
  env();
  const dir = 'reports/canary/mainnet/canary-588196bf-b2d8-4c9b-9c60-fdc66faecd68';
  const m = JSON.parse(readFileSync(`${dir}/manifest.json`, 'utf8'));
  const r = JSON.parse(readFileSync(`${dir}/results.json`, 'utf8'));
  const cleanup = JSON.parse(readFileSync(`${dir}/cleanup.json`, 'utf8'));
  const rpc = remote();
  if (await rpc.getChainId() !== 56) throw Error('Wrong chain');
  const version = await rpc.request({ method: 'web3_clientVersion' });
  if (/anvil|hardhat|ganache/i.test(version)) throw Error('Fork is not mainnet');
  if (fingerprint().digest !== m.candidateDigest) throw Error('Frozen candidate changed');
  const head = await rpc.getBlockNumber({ cacheTime: 0 });
  const stable = head - BigInt(m.minConfirmations - 1);
  const block = await rpc.getBlock({ blockNumber: stable });
  const read = (address: any, abi: any, functionName: string, args: any[] = []) => rpc.readContract({ address, abi, functionName, args, blockNumber: stable } as any) as Promise<any>;
  const pool = (fn: string, args: any[] = []) => read(m.contracts.pool, artifact('pool').abi, fn, args);
  const bem = (a: any) => read(P.bem, erc20Abi, 'balanceOf', [a]);
  const miners = [];
  for (const id of [3204n, 12485n]) {
    const key = await read(P.mining, miningAbi, 'minerKey', [P.minerCollection, id]);
    miners.push({ id, owner: await read(P.minerCollection, nftAbi, 'ownerOf', [id]), approved: await read(P.minerCollection, nftAbi, 'getApproved', [id]), record: await read(P.mining, miningAbi, 'getMiner', [key]), returnedFlag: await pool('returned', [id]) });
  }
  const ledger = await pool('reconciliation');
  const shares = [];
  for (const [category, name, count] of [[0, 'nand', 4], [1, 'latch', 2]] as const) for (let id = 1; id <= count; id++) shares.push({ category, id, holder: await read(m.contracts[name], artifact(name).abi, 'holderOf', [BigInt(id)]), claimed: await pool('claimed', [category, BigInt(id)]), outstanding: await pool('claimable', [category, BigInt(id)]) });
  const rows = readFileSync(`${dir}/journal.jsonl`, 'utf8').trim().split('\n').map(JSON.parse).filter((x: any) => x.stage === 'CONFIRMED');
  let fee = 0n;
  const receipts = [];
  for (const row of rows) {
    const actual = await rpc.getTransactionReceipt({ hash: row.hash });
    const canonical = await rpc.getBlock({ blockNumber: actual.blockNumber });
    if (actual.transactionHash !== row.hash || actual.blockHash !== row.blockHash || canonical.hash !== actual.blockHash || actual.status !== 'success' || actual.blockNumber > stable) throw Error(`Receipt finality/canonical mismatch ${row.action}`);
    fee += actual.gasUsed * actual.effectiveGasPrice;
    receipts.push({ action: row.action, hash: row.hash, block: actual.blockNumber, blockHash: actual.blockHash, confirmationsAtAudit: Number(head - actual.blockNumber + 1n), gasUsed: actual.gasUsed, effectiveGasPrice: actual.effectiveGasPrice });
  }
  const initialBNB = BigInt(r.observations.initial.bnbRaw);
  const finalBNB = await rpc.getBalance({ address: m.owner, blockNumber: stable });
  const ownerBEM = await bem(m.owner), helperBEM = await bem(m.contracts.helper), poolBEM = await bem(m.contracts.pool);
  const postReturnIncome = r.observations.postReturn.reduce((s: bigint, x: any) => s + BigInt(x.paidRaw ?? 0), 0n);
  const nftTransfers = rows.flatMap((row: any) => row.events.filter((log: any) => log.address.toLowerCase() === P.minerCollection.toLowerCase() && log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' && log.topics.length === 4).map((log: any) => ({ action: row.action, id: BigInt(log.topics[3]) })));
  const allowedTargets = new Set([P.mining, P.minerCollection, ...Object.values(m.contracts)].map((x: any) => x.toLowerCase()));
  const checks = {
    businessAssertionsPassed: r.status === 'PASS' && Object.values(r.assertions).every((x: any) => x.status === 'PASS'),
    bothActualOwnersAreOriginalWallet: miners.every(x => x.owner.toLowerCase() === m.owner.toLowerCase()),
    neitherNFTInCanary: miners.every(x => x.owner.toLowerCase() !== m.contracts.pool.toLowerCase()),
    bothMiningStatusesActive: miners.every(x => x.record.status === 1),
    bothReturnFlags: miners.every(x => x.returnedFlag === true),
    noRemainingTokenApproval: miners.every(x => /^0x0{40}$/.test(x.approved)),
    permanentlyClosed: await pool('closed') === true,
    ordinaryOwnerRenounced: /^0x0{40}$/.test(await pool('owner')),
    recoveryWalletFixed: (await pool('recoveryController')).toLowerCase() === m.owner.toLowerCase(),
    fixedSupplies: await read(m.contracts.nand, artifact('nand').abi, 'totalSupply') === 4n && await read(m.contracts.latch, artifact('latch').abi, 'totalSupply') === 2n,
    finalCompositionRetained: await pool('totalNandBurn') === 3n && await pool('totalLatchBurn') === 1n,
    noOutstandingReceiptEntitlements: shares.every(x => x.outstanding === 0n),
    rolesFullyPaid: ledger.recipientAAccrued === ledger.recipientAPaid && ledger.recipientBAccrued === ledger.recipientBPaid,
    noDeficitOrUnrecognized: ledger.deficit === 0n && ledger.unrecognized === 0n,
    onlyRoundingResidueRemains: poolBEM === ledger.residue && ledger.residue <= 7n,
    allHelperBEMForwarded: helperBEM === 0n,
    postReturnBothPaidPositive: r.observations.postReturn.length === 2 && r.observations.postReturn.every((x: any) => BigInt(x.paidRaw ?? 0) > 0n),
    receiptFeesMatchJournal: fee === BigInt(m.totalFeeRaw),
    walletBNBReconciles: initialBNB - finalBNB === fee,
    walletBEMReconciles: ownerBEM - BigInt(r.observations.initial.bemRaw) === ledger.totalPaid + postReturnIncome,
    feeCapRespected: fee <= BigInt(m.maxRunFee),
    noUnrelatedNFTsTargetsOrGlobalApprovals: nftTransfers.length === 4 && nftTransfers.every((x: any) => x.id === 3204n || x.id === 12485n) && rows.every((x: any) => x.target === null || allowedTargets.has(x.target.toLowerCase())) && rows.every((x: any) => x.function !== 'setApprovalForAll'),
    receivedBEMPayoutContinuationPassed: cleanup.status === 'RECOVERY_AND_PAYOUTS_PASS_ORIGINAL_AUTOMATION_FAILURE_PRESERVED' && Object.values(cleanup.checks).every((x: any) => x.status === 'PASS'),
    negativeGuardsConfirmedFromStructuredRevertData: Object.values(cleanup.diagnostics).every((x: any) => x.status === 'PASS'),
  };
  const assetAndAccountingPassed = Object.entries(checks).filter(([name]) => name !== 'businessAssertionsPassed').every(([, value]) => value);
  const result = { scope: 'ACTUAL_BSC_MAINNET_READ_ONLY_FINAL_AUDIT', status: Object.values(checks).every(Boolean) ? 'PASS' : assetAndAccountingPassed ? 'ASSETS_AND_ACCOUNTING_PASS_ORIGINAL_AUTOMATION_FAILED' : 'FAIL', assetAndAccountingStatus: assetAndAccountingPassed ? 'PASS' : 'FAIL', originalAutomationStatus: r.status, auditedAt: new Date().toISOString(), head, confirmedBlock: stable, blockHash: block.hash, timestamp: block.timestamp, minConfirmations: m.minConfirmations, originalWallet: m.owner, canary: m.contracts.pool, checks, miners, shares, ledger, receipts, nftTransfers, initialBNBRaw: initialBNB, finalBNBRaw: finalBNB, totalFeeRaw: fee, ownerBEMRaw: ownerBEM, helperBEMRaw: helperBEM, poolBEMRaw: poolBEM, postReturnIncomeRaw: postReturnIncome };
  save(`${dir}/final-audit.json`, result);
  console.log(JSON.stringify({ status: result.status, confirmedBlock: String(stable), checks }, null, 2));
  // This command audits asset safety/accounting; the original automation failure stays explicit.
  if (!assetAndAccountingPassed) process.exitCode = 1;
}
main().catch(() => { console.error('Final read-only audit failed; inspect preserved run evidence without retrying transactions blindly.'); process.exitCode = 1; });
