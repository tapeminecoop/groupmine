import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { env, remote, save, redact, P, nftAbi, artifact, fingerprint, ownerFromEnv, hash } from '/Users/jaychen/Desktop/tapemine/scripts/canary/common.ts';
import { erc20Abi, miningAbi } from '/Users/jaychen/Desktop/tapemine/sdk/constants.ts';
import { describeError } from '/Users/jaychen/Desktop/tapemine/sdk/tx.ts';
import { Runner } from '/Users/jaychen/Desktop/tapemine/scripts/canary/transactions.ts';
const require = createRequire('/Users/jaychen/Desktop/tapemine/package.json');
const { encodeFunctionData, parseEventLogs, parseAbiItem, decodeErrorResult } = require('viem');
const id = 'canary-588196bf-b2d8-4c9b-9c60-fdc66faecd68';
const dir = `reports/canary/mainnet/${id}`;
const evidence: any = { scope: 'ACTUAL_BSC_MAINNET_APPROVED_RECOVERY_PAYOUT_CONTINUATION', originalAutomationStatus: 'FAIL_OR_INCOMPLETE', status: 'IN_PROGRESS', checks: {}, diagnostics: {}, postReturn: [], startedAt: new Date().toISOString() };
let runner: Runner;
const check = (name: string, ok: boolean, detail: any = null) => {
  evidence.checks[name] = { status: ok ? 'PASS' : 'FAIL', evidence: detail };
  save(`${dir}/cleanup.json`, evidence);
  if (!ok) throw Error(`CLEANUP_ASSERTION_FAILED ${name}`);
};

async function main() {
  process.chdir('/Users/jaychen/Desktop/tapemine');
  env();
  const m = JSON.parse(readFileSync(`${dir}/manifest.json`, 'utf8'));
  const original = JSON.parse(readFileSync(`${dir}/results.json`, 'utf8'));
  const proposalPath = `reports/canary/proposals/${id}.json`;
  const approval = JSON.parse(readFileSync(`reports/canary/approvals/${id}.json`, 'utf8'));
  if (approval.approved !== true || approval.proposalDigest !== hash(readFileSync(proposalPath)) || fingerprint().digest !== m.candidateDigest || ownerFromEnv().toLowerCase() !== m.owner.toLowerCase()) throw Error('Approved original candidate/signer mismatch');
  if (process.env.MODE !== 'mainnet' || process.env.ALLOW_MAINNET_BROADCAST !== 'true' || process.env.APPROVED_RUN_ID !== id) throw Error('Missing approved run gates');
  const rpc = remote();
  runner = new Runner(m, rpc);
  if (await rpc.getChainId() !== 56 || /anvil|hardhat|ganache/i.test(await rpc.request({ method: 'web3_clientVersion' }))) throw Error('Not actual BSC');
  await runner.reconcileJournal();
  const pool = m.contracts.pool, helper = m.contracts.helper, wallet = m.owner;
  const pabi = artifact('pool').abi;
  check('both-miners-already-back-before-payout-continuation', (await runner.read(P.minerCollection, nftAbi, 'ownerOf', [3204n])).toLowerCase() === wallet.toLowerCase() && (await runner.read(P.minerCollection, nftAbi, 'ownerOf', [12485n])).toLowerCase() === wallet.toLowerCase());
  check('pool-already-permanently-closed', await runner.pool('closed') === true);
  evidence.originalFailure = { error: original.error, finalizationError: original.finalizationError, assertions: Object.fromEntries(Object.entries(original.assertions).filter(([, x]: any) => x.status !== 'PASS')) };
  save(`${dir}/cleanup.json`, evidence);
  const diagnostic = async (name: string, from: any, fn: string, args: any[], expected: string, blockNumber?: bigint) => {
    let decoded: any = null, raw: string | undefined, described = '', reason = '';
    try { await rpc.call({ account: from, to: pool, data: encodeFunctionData({ abi: pabi, functionName: fn, args }), ...(blockNumber ? { blockNumber } : {}) }); }
    catch (e: any) {
      described = describeError(e);
      reason = redact(e);
      if (typeof e.walk === 'function') e.walk((cause: any) => {
        const d = cause.data;
        if (typeof d === 'string' && /^0x[0-9a-fA-F]+$/.test(d)) raw = d;
        else if (d && typeof d.data === 'string' && /^0x[0-9a-fA-F]+$/.test(d.data)) raw = d.data;
        return false;
      });
      if (raw) try { decoded = decodeErrorResult({ abi: pabi, data: raw }); } catch {}
    }
    evidence.diagnostics[name] = { simulationOnly: true, blockNumber: blockNumber ?? 'latest', expected, status: decoded?.errorName === expected ? 'PASS' : 'UNVERIFIED', decoded, rawRevertData: raw, sdkDescription: described, originalMessage: reason };
    save(`${dir}/cleanup.json`, evidence);
  };
  const prior = readFileSync(`${dir}/journal.jsonl`, 'utf8').trim().split('\n').map(JSON.parse).filter(x => x.stage === 'CONFIRMED');
  const transfer = prior.find(x => x.action === 'transfer-unpaid-nand-1-to-helper');
  await diagnostic('former-holder-claim-structured-revert', wallet, 'claim', [0, 1n], 'NotHolder');
  await diagnostic('closed-admission-structured-revert', wallet, 'depositMiners', [[3204n]], 'CanaryClosed');
  await diagnostic('closed-harvest-structured-revert', wallet, 'harvest', [[3204n, 12485n]], 'CanaryClosed');
  await diagnostic('non-whitelisted-admission-at-pre-shutdown-block', helper, 'depositMiners', [[3204n]], 'NotDepositor', BigInt(transfer.block));
  // Only already-received BEM is synchronized. There is NO canary Mining harvest after shutdown.
  if (await runner.pool<bigint>('unrecognizedBalance') > 0n) await runner.write('pool', 'sync', [], 'cleanup-sync-already-received-BEM');
  const bem = (a: any) => runner.read<bigint>(P.bem, erc20Abi, 'balanceOf', [a]);
  const history: Record<number, Record<string, bigint>> = { 0: {}, 1: {} };
  for (const row of prior) for (const log of row.events) if (log.address.toLowerCase() === pool.toLowerCase() && log.decoded?.eventName === 'ReceiptIncomeClaimed') {
    const a = log.decoded.args, c = Number(a.category), k = String(a.id);
    history[c][k] = (history[c][k] ?? 0n) + BigInt(a.amount);
  }
  const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
  const transfers = async (through: bigint) => {
    const out: any[] = [];
    for (let start = BigInt(m.poolDeployBlock); start <= through; start += 500n) out.push(...await rpc.getLogs({ address: P.bem, event: transferEvent, fromBlock: start, toBlock: start + 499n < through ? start + 499n : through }));
    return out;
  };
  const base = BigInt(original.observations.boundary.nandBase);
  const claim = async (label: string, holder: any, ns: bigint[], ls: bigint[], isHelper: boolean) => {
    const before = await bem(holder);
    const receipt = await runner.write(isHelper ? 'helper' : 'pool', isHelper ? 'claim' : 'claimBatch', [ns, ls], label);
    const logs = await transfers(receipt.blockNumber);
    const total = logs.filter(x => x.args.to.toLowerCase() === pool.toLowerCase() && (x.blockNumber < receipt.blockNumber || x.transactionIndex <= receipt.transactionIndex)).reduce((s, x) => s + x.args.value, 0n);
    const delta = total * 100n / 102n - base;
    const perNand = (base + delta * 3n / 4n) / 4n, perLatch = (delta / 4n) / 2n;
    const expectedRows = [];
    for (const [c, ids, per] of [[0, ns, perNand], [1, ls, perLatch]] as const) for (const tokenId of ids) expectedRows.push({ category: c, id: tokenId, expected: per - (history[c][String(tokenId)] ?? 0n), per });
    const expected = expectedRows.reduce((s, x) => s + x.expected, 0n);
    const payments = parseEventLogs({ abi: pabi, eventName: 'ReceiptIncomeClaimed', logs: receipt.logs }).map((x: any) => x.args);
    const actual = payments.reduce((s: bigint, x: any) => s + x.amount, 0n);
    check(`${label}-independent-exact-payout`, expected === actual && await bem(holder) - before === actual && payments.length === expectedRows.length && expectedRows.every(x => payments.some((p: any) => Number(p.category) === x.category && p.id === x.id && p.amount === x.expected)), { expectedRaw: expected, actualRaw: actual, expectedRows, hash: receipt.transactionHash });
    for (const row of expectedRows) history[row.category][String(row.id)] = row.per;
    return actual;
  };
  await claim('cleanup-wallet-receipt-claims', wallet, [2n, 3n], [1n], false);
  const helperClaim = await claim('cleanup-helper-receipt-claims-including-transferred-1', helper, [1n, 4n], [2n], true);
  check('transferred-receipt-successfully-claimed-by-helper-after-return', helperClaim > 0n);
  check('repeat-claim-consumed-entitlement-pays-zero', await claim('cleanup-helper-repeat-claim-1', helper, [1n], [], true) === 0n);
  for (const [role, recipient] of [['A', wallet], ['B', helper]] as const) {
    const before = await bem(recipient);
    const receipt = await runner.write('pool', `release${role}`, [], `cleanup-release-${role}-separately`);
    const payment: any = parseEventLogs({ abi: pabi, eventName: 'RecipientPaid', logs: receipt.logs })[0].args;
    const expected = await runner.pool<bigint>('totalAccounted') / 102n;
    check(`cleanup-role-${role}-cumulative-1-of-102`, payment.amount === expected && await bem(recipient) - before === expected, { expectedRaw: expected, actualRaw: payment.amount, hash: receipt.transactionHash });
  }
  const helperBefore = await bem(helper), walletBefore = await bem(wallet);
  await runner.write('helper', 'forwardBEM', [], 'cleanup-helper-forwards-BEM-to-original');
  check('helper-BEM-forwarded-only-to-original-wallet', await bem(helper) === 0n && await bem(wallet) - walletBefore === helperBefore, { amountRaw: helperBefore });
  const ledger = await runner.pool('reconciliation');
  const allTransfers = await transfers(await rpc.getBlockNumber({ cacheTime: 0 }));
  const incoming = allTransfers.filter(x => x.args.to.toLowerCase() === pool.toLowerCase()).reduce((s, x) => s + x.args.value, 0n);
  const outgoing = allTransfers.filter(x => x.args.from.toLowerCase() === pool.toLowerCase()).reduce((s, x) => s + x.args.value, 0n);
  const d = incoming * 100n / 102n - base;
  const expectedNand = (base + d * 3n / 4n) / 4n * 4n, expectedLatch = (d / 4n) / 2n * 2n;
  check('final-received-BEM-independent-reconciliation', ledger.totalAccounted === incoming && ledger.totalPaid === outgoing && ledger.nandReceiptsPaid === expectedNand && ledger.latchReceiptsPaid === expectedLatch && ledger.recipientAPaid === incoming / 102n && ledger.recipientBPaid === incoming / 102n && ledger.nandReceiptsPaid === ledger.nandReceiptsAccrued && ledger.latchReceiptsPaid === ledger.latchReceiptsAccrued && ledger.unrecognized === 0n && ledger.deficit === 0n && ledger.bemBalance === ledger.residue && ledger.residue <= 7n && incoming === outgoing + ledger.bemBalance, { incoming, outgoing, expectedNand, expectedLatch, ledger });
  evidence.finalLedger = ledger;
  console.log('Already-received BEM fully paid and reconciled. Waiting the remaining approved 60 seconds for separate post-return personal income.');
  await new Promise(resolve => setTimeout(resolve, 60_000));
  for (const tokenId of [3204n, 12485n]) {
    const key = await runner.read(P.mining, miningAbi, 'minerKey', [P.minerCollection, tokenId]);
    const record = await runner.read(P.mining, miningAbi, 'getMiner', [key]);
    const before = await bem(wallet);
    const receipt = await runner.send(`cleanup-post-return-owner-income-${tokenId}`, P.mining, encodeFunctionData({ abi: miningAbi, functionName: 'claim', args: [key] }), 'claim');
    const amount = await bem(wallet) - before;
    evidence.postReturn.push({ id: tokenId, status: record.status, paidRaw: amount, transaction: receipt.transactionHash, scope: 'POST_RETURN_PERSONAL_INCOME_EXCLUDED_FROM_POOL' });
    check(`post-return-miner-${tokenId}-pays-original-current-owner`, amount > 0n && record.status === 1, { paidRaw: amount, hash: receipt.transactionHash });
  }
  evidence.status = 'RECOVERY_AND_PAYOUTS_PASS_ORIGINAL_AUTOMATION_FAILURE_PRESERVED';
  evidence.completedAt = new Date().toISOString();
  evidence.totalFeeRaw = runner.manifest.totalFeeRaw;
  save(`${dir}/cleanup.json`, evidence);
  const preserved = JSON.parse(readFileSync(`${dir}/results.json`, 'utf8'));
  preserved.supplementalCleanup = { status: evidence.status, evidence: `${dir}/cleanup.json` };
  preserved.observations.finalLedger = evidence.finalLedger;
  preserved.observations.postReturn = evidence.postReturn;
  preserved.totalFeeRaw = runner.manifest.totalFeeRaw;
  save(`${dir}/results.json`, preserved);
  runner.manifest.status = 'FAIL_AUTOMATION_RECOVERY_AND_PAYOUTS_COMPLETE';
  runner.persist();
  console.log('Both miners remain returned. Original failed assertions remain unchanged; cleanup and accounting are complete.');
}
main().catch(e => { evidence.status = 'CLEANUP_NEEDS_ATTENTION'; evidence.error = redact(e); save(`${dir}/cleanup.json`, evidence); console.error(redact(e)); process.exitCode = 1; });
