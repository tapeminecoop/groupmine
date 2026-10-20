import { existsSync, readFileSync } from 'node:fs';
import { encodeFunctionData, formatUnits, keccak256, parseAbiItem, parseEventLogs, stringToHex, type Address, type Hex } from 'viem';
import { allocationArtifact, allocationBatches, assignIds, loadAllocationFile, validateAllocation } from '../../sdk/allocation.ts';
import { parseAllocationArtifact, readAllocationState, verifyAllocation } from '../../sdk/verify.ts';
import { erc20Abi, miningAbi } from '../../sdk/constants.ts';
import { artifact, IDS, nftAbi, P, preflight, redact, save } from './common.ts';
import { Runner } from './transactions.ts';

export async function workflow(r: Runner, interrupted = false) {
  const { owner, dir } = r.manifest;
  const results: Record<string, any> = { scope: r.manifest.mode === 'fork' ? 'LOCAL_BSC_FORK_ONLY' : 'ACTUAL_BSC_MAINNET', status: 'IN_PROGRESS', assertions: {}, observations: {}, sourceDigest: r.manifest.candidateDigest };
  const check = (name: string, ok: boolean, evidence: unknown = null) => {
    results.assertions[name] = { status: ok ? 'PASS' : 'FAIL', evidence };
    save(`${dir}/results.json`, results);
    if (!ok) throw Error(`ASSERTION_FAILED ${name}`);
  };
  const pabi = artifact('pool').abi;
  const due = (c: number, id: bigint) => r.pool<bigint>('claimable', [c, id]);
  const bem = (a: Address) => r.read<bigint>(P.bem, erc20Abi, 'balanceOf', [a]);
  const events = (receipt: any, name: string) => parseEventLogs({ abi: pabi, eventName: name, logs: receipt.logs }).map((l: any) => l.args);
  const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
  const histories: Record<number, Record<string, bigint>> = { 0: {}, 1: {} };
  const tokenTransfers = async (through: bigint) => {
    const from = BigInt(r.manifest.poolDeployBlock as string);
    const logs = [];
    for (let start = from; start <= through; start += 500n) logs.push(...await r.rpc.getLogs({ address: P.bem, event: transferEvent, fromBlock: start, toBlock: start + 499n < through ? start + 499n : through }));
    return logs;
  };
  let waits = 0;
  const accrue = async () => {
    if (r.manifest.mode === 'fork') {
      await r.rpc.request({ method: 'evm_increaseTime', params: [r.manifest.accrualIntervalSeconds] } as never);
      await r.rpc.request({ method: 'evm_mine', params: [] } as never);
    } else {
      const seconds = r.manifest.accrualIntervalSeconds;
      if (waits + seconds > r.manifest.maxWaitSeconds) throw Error('Approved reward waiting limit reached');
      console.log(`Bounded reward accrual wait: ${seconds}s (${waits + seconds}/${r.manifest.maxWaitSeconds}s)`);
      const until = Date.now() + seconds * 1000;
      while (Date.now() < until) await new Promise(resolve => setTimeout(resolve, Math.min(30_000, until - Date.now())));
      waits += seconds;
    }
  };
  const rejected = async (name: string, from: Address, to: Address, data: Hex, expectedError: string) => {
    let reason = '';
    try { await r.rpc.call({ account: from, to, data }); } catch (e) { reason = redact(e); }
    const expectedSelector = keccak256(stringToHex(expectedError)).slice(0, 10);
    check(name, /revert/i.test(reason) && reason.toLowerCase().includes(expectedSelector), { simulationOnly: true, expectedError, expectedSelector, reason });
  };
  const exactClaim = async (name: string, holder: Address, nand: bigint[], latch: bigint[], helper = false) => {
    const before = await bem(holder);
    const receipt = await r.write(helper ? 'helper' : 'pool', helper ? 'claim' : 'claimBatch', [nand, latch], name);
    // Independently reconstruct gross income through THIS mined transaction from BEM transfers.
    // Do not use pool.claimable, sdk/math or PoolMath to generate the expected payment.
    const logs = await tokenTransfers(receipt.blockNumber);
    const total = logs.filter(log => log.args.to?.toLowerCase() === r.manifest.contracts.pool!.toLowerCase() && (log.blockNumber < receipt.blockNumber || log.transactionIndex! <= receipt.transactionIndex)).reduce((s, log) => s + log.args.value!, 0n);
    const oldBase = results.observations.boundary?.nandBase ?? 0n;
    const participant = total * 100n / 102n;
    const perNand = results.observations.boundary ? (oldBase + (participant - oldBase) * 3n / 4n) / 4n : participant / 4n;
    const perLatch = results.observations.boundary ? (participant - oldBase) / 4n / 2n : 0n;
    let expected = 0n;
    const expectedById = [];
    for (const [category, ids, perShare] of [[0, nand, perNand], [1, latch, perLatch]] as const) for (const id of ids) {
      const previous = histories[category][String(id)] ?? 0n;
      const amount = perShare - previous;
      expected += amount;
      expectedById.push({ category, id, previous, perShare, amount });
    }
    const payments = events(receipt, 'ReceiptIncomeClaimed');
    const paid = payments.reduce((s: bigint, x: any) => s + x.amount, 0n);
    check(`${name}-exact`, paid === expected && await bem(holder) - before === expected && payments.length === expectedById.length && expectedById.every(x => payments.some((p: any) => Number(p.category) === x.category && p.id === x.id && p.holder.toLowerCase() === holder.toLowerCase() && p.amount === x.amount)), { expectedRaw: expected, paidRaw: paid, formatted: formatUnits(paid, 8), grossIncomeFromTransfers: total, expectedById });
    for (const x of expectedById) histories[x.category][String(x.id)] = x.perShare;
    return paid;
  };
  let businessError: string | undefined;
  try {
    results.observations.initial = await preflight(r.rpc, owner);
    const nand = await r.deploy('nand', [await import('viem').then(v => v.keccak256(v.stringToHex('TAPEOUT_NAND_ENTITLEMENT'))), 'Recoverable Canary NAND', 'cNAND', '', owner]);
    const latch = await r.deploy('latch', [await import('viem').then(v => v.keccak256(v.stringToHex('TAPEOUT_LATCH_ENTITLEMENT'))), 'Recoverable Canary LATCH', 'cLATCH', '', owner]);
    const helper = await r.deploy('helper', [owner, P.bem, nand, latch]);
    const pool = await r.deploy('pool', [{ owner, ...P, nandReceipt: nand, latchReceipt: latch, recipientA: owner, recipientB: helper, depositors: [owner], poolName: 'RECOVERABLE CANARY 3204 + 12485' }]);
    const distributor = await r.deploy('distributor', [owner, pool]);
    await r.write('helper', 'bindPool', [pool]);
    check('recovery-fixed-before-any-approval', (await r.pool<Address>('recoveryController')).toLowerCase() === owner.toLowerCase() && !await r.pool('closed'));
    await r.write('nand', 'issue', [owner, 4n]);
    await r.write('latch', 'issue', [owner, 2n]);
    await r.write('nand', 'finalizeIssuance');
    await r.write('latch', 'finalizeIssuance');
    await r.write('nand', 'safeBatchTransferFrom', [owner, distributor, [1n, 2n, 3n, 4n], [1n, 1n, 1n, 1n], '0x']);
    await r.write('latch', 'safeBatchTransferFrom', [owner, distributor, [1n, 2n], [1n, 1n], '0x']);
    const allocationFile = `${dir}/allocation.json`;
    save(allocationFile, { allocations: [{ wallet: owner, nandCount: 3, latchCount: 1 }, { wallet: helper, nandCount: 1, latchCount: 1 }] });
    const input = await loadAllocationFile(allocationFile);
    const validated = validateAllocation(input.file);
    const assignments = assignIds(validated.entries, { NAND: [1, 2, 3, 4], LATCH: [1, 2] });
    for (const batch of allocationBatches(assignments)) await r.write('distributor', 'allocate', [batch]);
    const target = { chainId: 56, distributor, nandReceipt: nand, latchReceipt: latch };
    const alloc = allocationArtifact({ ...target, sourceSha256: input.sha256, blockNumber: await r.rpc.getBlockNumber() }, assignments);
    save(`${dir}/allocation-artifact.json`, alloc);
    const verified = verifyAllocation(parseAllocationArtifact(alloc), await readAllocationState(r.rpc, distributor), target);
    check('complete-allocation-verified', verified.status === 'READY_TO_FINALIZE', verified);
    await r.write('distributor', 'finalizeAllocation');
    await r.write('pool', 'activate', [4n, 2n]);
    for (const name of ['nand', 'latch', 'distributor', 'pool'] as const) await r.write(name, 'renounceOwnership', [], `renounce-${name}`);
    check('owner-renounced-recovery-retained', await r.pool('owner') === '0x0000000000000000000000000000000000000000' && (await r.pool<Address>('recoveryController')).toLowerCase() === owner.toLowerCase());

    // Live state is rechecked AFTER setup and immediately before either designated admission.
    await preflight(r.rpc, owner);
    await r.send('approve-3204-only', P.minerCollection, encodeFunctionData({ abi: nftAbi, functionName: 'approve', args: [pool, 3204n] }), 'approve');
    const first = await r.write('pool', 'depositMiners', [[3204n]], 'phase-A-deposit-3204');
    const a1 = events(first, 'MinersAdmitted')[0];
    check('phase-A-composition-2-0', await r.pool('totalNandBurn') === 2n && await r.pool('totalLatchBurn') === 0n, a1);
    await accrue();
    const firstKey = await r.read(P.mining, miningAbi, 'minerKey', [P.minerCollection, 3204n]);
    const pendingBeforeFirstHarvest = await r.read(P.mining, miningAbi, 'pending', [firstKey]);
    const firstHarvest = await r.write('pool', 'harvest', [[3204n]], 'phase-A-bounded-harvest');
    check('phase-A-positive-actual-revenue', events(firstHarvest, 'Harvested')[0].received > 0n, { pendingBeforeHarvestRaw: pendingBeforeFirstHarvest, actualReceivedRaw: events(firstHarvest, 'Harvested')[0].received, observation: 'Pending is never used to decide whether to claim or as an exact payout promise' });
    await r.write('distributor', 'deliver', [owner, 4n], 'deliver-original-wallet-receipts');
    await exactClaim('phase-A-subset-claim', owner, [1n, 2n], []);
    check('retain-positive-unpaid-receipt', await due(0, 3n) > 0n, { receipt: 'NAND #3', unpaidRaw: await due(0, 3n) });
    if (interrupted) {
      results.status = 'INTERRUPTED_FOR_STANDALONE_RECOVERY';
      save(`${dir}/results.json`, results);
      return results; // Caller terminates ordinary workflow and runs recovery in another process.
    }
    await accrue();
    // Build a genuinely unrecognized old-period balance using real protocol income, then allow
    // a further full interval so the admission STILL has nonzero old-miner income to settle.
    const oldKey = await r.read(P.mining, miningAbi, 'minerKey', [P.minerCollection, 3204n]);
    const directClaim = await r.send('old-miner-income-held-before-admission', P.mining, encodeFunctionData({ abi: miningAbi, functionName: 'claim', args: [oldKey] }), 'claim');
    check('positive-already-held-unrecognized-income', await r.pool<bigint>('unrecognizedBalance') > 0n, { transaction: directClaim.transactionHash, unrecognizedRaw: await r.pool('unrecognizedBalance') });
    await accrue();
    // Do not harvest #3204 here: second admission itself must settle old-period income.
    const oldTotal = await r.pool<bigint>('totalAccounted');
    const unrecognized = await r.pool<bigint>('unrecognizedBalance');
    const key2 = await r.read(P.mining, miningAbi, 'minerKey', [P.minerCollection, 12485n]);
    const record2 = await r.read(P.mining, miningAbi, 'getMiner', [key2]);
    check('second-miner-still-original-and-compatible', (await r.read<Address>(P.minerCollection, nftAbi, 'ownerOf', [12485n])).toLowerCase() === owner.toLowerCase() && record2.status === 1 && record2.nandBurn === 1 && record2.latchBurn === 1);
    await r.send('approve-12485-only', P.minerCollection, encodeFunctionData({ abi: nftAbi, functionName: 'approve', args: [pool, 12485n] }), 'approve');
    await preflight(r.rpc, owner, { '3204': pool });
    const pendingBeforeSecondAdmission = await r.read(P.mining, miningAbi, 'pending', [key2]);
    const second = await r.write('pool', 'depositMiners', [[12485n]], 'phase-B-deposit-12485');
    const a2 = events(second, 'MinersAdmitted')[0];
    const checkpoints = events(second, 'CompositionCheckpoint');
    check('nonzero-old-period-settlement', a2.settledOldIncome > 0n, a2);
    check('phase-B-composition-3-1', await r.pool('totalNandBurn') === 3n && await r.pool('totalLatchBurn') === 1n, a2);
    const boundaryTotal = checkpoints[0].totalAccounted;
    const cpLog = parseEventLogs({ abi: pabi, eventName: 'CompositionCheckpoint', logs: second.logs })[0];
    const incomeLogs = await tokenTransfers(second.blockNumber);
    const paidIntoPool = (log: any) => log.args.to?.toLowerCase() === pool.toLowerCase();
    const oldInflow = incomeLogs.filter(log => paidIntoPool(log) && (log.blockNumber < second.blockNumber || log.blockNumber === second.blockNumber && log.logIndex! < cpLog.logIndex!)).reduce((s, log) => s + log.args.value!, 0n);
    const carriedActual = incomeLogs.filter(log => paidIntoPool(log) && log.transactionHash === second.transactionHash && log.logIndex! > cpLog.logIndex!).reduce((s, log) => s + log.args.value!, 0n);
    check('boundary-income-matches-independent-BEM-transfer-evidence', oldInflow === boundaryTotal && carriedActual === a2.carriedIncome, { oldInflow, carriedActual, logs: incomeLogs });
    // Independent specification arithmetic: deliberately does not import sdk/math or PoolMath.
    const nandBase = oldInflow * 100n / 102n;
    check('old-period-and-held-balance-all-nand', checkpoints[0].nandBase === nandBase && checkpoints[0].latchBase === 0n && boundaryTotal === oldTotal + unrecognized + a2.settledOldIncome, { oldTotal, unrecognized, boundaryTotal, checkpoint: checkpoints[0] });
    const actual = await r.pool('accrual');
    const post = actual.total * 100n / 102n - nandBase;
    check('carried-income-new-composition-and-fixed-old-entitlements', actual.nandIncome === nandBase + post * 3n / 4n && actual.latchIncome === post / 4n && actual.total === boundaryTotal + a2.carriedIncome, { actual, carriedRaw: a2.carriedIncome, carriedFormatted: formatUnits(a2.carriedIncome, 8), zeroCarriedIsAllowed: true });
    results.observations.boundary = { firstAdmission: a1, secondAdmission: a2, checkpoint: checkpoints[0], nandBase, pendingBeforeSecondAdmissionRaw: pendingBeforeSecondAdmission, pendingAfterSecondAdmissionRaw: await r.read(P.mining, miningAbi, 'pending', [key2]) };
    check('both-nfts-in-canary', (await r.read<Address>(P.minerCollection, nftAbi, 'ownerOf', [3204n])).toLowerCase() === pool.toLowerCase() && (await r.read<Address>(P.minerCollection, nftAbi, 'ownerOf', [12485n])).toLowerCase() === pool.toLowerCase());
    check('supplies-stay-4-and-2', await r.read(nand, artifact('nand').abi, 'totalSupply') === 4n && await r.read(latch, artifact('latch').abi, 'totalSupply') === 2n);

    await accrue();
    const harvest = await r.write('pool', 'harvest', [[3204n, 12485n]], 'phase-C-harvest-3-1');
    const h = events(harvest, 'Harvested')[0];
    check('positive-new-period-harvest', h.received > 0n && h.failed === 0n, h);
    const helperNandDue = await due(0, 4n), helperLatchDue = await due(1, 2n);
    check('undelivered-helper-receipts-have-entitlements', helperNandDue > 0n && helperLatchDue > 0n && (await r.read<Address>(nand, artifact('nand').abi, 'holderOf', [4n])).toLowerCase() === distributor.toLowerCase(), { helperNandDue, helperLatchDue });
    await r.write('distributor', 'deliver', [helper, 2n], 'late-deliver-helper-receipts');
    check('late-delivery-preserves-earlier-entitlement', await due(0, 4n) === helperNandDue && await due(1, 2n) === helperLatchDue);
    await exactClaim('helper-initial-receipt-claim', helper, [4n], [2n], true);
    await exactClaim('original-selected-claim', owner, [2n], [1n]);
    const history = await r.pool('claimed', [0, 1n]), unpaid = await due(0, 1n);
    check('transfer-carries-positive-unpaid-income', unpaid > 0n, { historyRaw: history, unpaidRaw: unpaid });
    await r.write('nand', 'safeTransferFrom', [owner, helper, 1n, 1n, '0x'], 'transfer-unpaid-nand-1-to-helper');
    check('transfer-keeps-history-and-unpaid', await r.pool('claimed', [0, 1n]) === history && await due(0, 1n) === unpaid);
    await rejected('former-holder-claim-rejected', owner, pool, encodeFunctionData({ abi: pabi, functionName: 'claim', args: [0, 1n] }), 'NotHolder(uint8,uint256)');
    await rejected('non-whitelisted-admission-rejected', helper, pool, encodeFunctionData({ abi: pabi, functionName: 'depositMiners', args: [[3204n]] }), 'NotDepositor(address)');
    await exactClaim('helper-claims-transferred-nand-1', helper, [1n], [], true);
    check('repeat-claim-pays-zero', await exactClaim('helper-repeat-claim', helper, [1n], [], true) === 0n);
    for (const [role, recipient] of [['A', owner], ['B', helper]] as const) {
      const before = await bem(recipient);
      const receipt = await r.write('pool', `release${role}`, [], `release-${role}-separately`);
      const paid = events(receipt, 'RecipientPaid')[0];
      check(`role-${role}-separate-cumulative-allocation`, paid.amount === await r.pool<bigint>('totalAccounted') / 102n && await bem(recipient) - before === paid.amount, paid);
    }
    const finalHarvest = await r.write('pool', 'harvest', [[3204n, 12485n]], 'phase-D-orderly-final-harvest');
    check('orderly-final-harvest-no-failure', events(finalHarvest, 'Harvested')[0].failed === 0n);
  } catch (e) {
    businessError = redact(e);
    results.error = businessError;
    results.status = 'BUSINESS_TEST_FAILED_RECOVERING';
    save(`${dir}/results.json`, results);
  }

  // Recovery happens before any report generation or optional payout completion.
  try { await r.recover(); }
  catch (e) { results.recoveryError = redact(e); }
  const { pool, helper, nand, latch, distributor } = r.manifest.contracts;
  try {
    if (pool) {
      check('permanently-closed', await r.pool('closed') === true);
      await rejected('closed-pool-admission-rejected', owner, pool, encodeFunctionData({ abi: pabi, functionName: 'depositMiners', args: [[3204n]] }), 'CanaryClosed()');
      await rejected('closed-pool-harvest-rejected', owner, pool, encodeFunctionData({ abi: pabi, functionName: 'harvest', args: [[3204n, 12485n]] }), 'CanaryClosed()');
      const finalBlock = await r.rpc.getBlockNumber({ cacheTime: 0 });
      for (const id of IDS) check(`final-owner-${id}`, (await r.read<Address>(P.minerCollection, nftAbi, 'ownerOf', [id], finalBlock)).toLowerCase() === owner.toLowerCase(), { confirmedBlock: finalBlock, blockHash: (await r.rpc.getBlock({ blockNumber: finalBlock })).hash });
      if (await r.pool('active') && helper && nand && latch) {
        // BEM already received stays payable after shutdown using frozen final composition.
        const owned = async (receipt: Address, ids: bigint[], holder: Address) => {
          const out: bigint[] = [];
          for (const id of ids) if ((await r.read<Address>(receipt, artifact('nand').abi, 'holderOf', [id])).toLowerCase() === holder.toLowerCase()) out.push(id);
          return out;
        };
        for (const [holder, isHelper] of [[owner, false], [helper, true]] as const) {
          const ns = await owned(nand, [1n, 2n, 3n, 4n], holder), ls = await owned(latch, [1n, 2n], holder);
          if (ns.length + ls.length) await exactClaim(`final-${isHelper ? 'helper' : 'wallet'}-receipt-claims`, holder, ns, ls, isHelper);
        }
        await r.write('pool', 'releaseA', [], 'final-release-A');
        await r.write('pool', 'releaseB', [], 'final-release-B');
        await r.write('helper', 'forwardBEM', [], 'helper-forwards-BEM-to-original');
        const ledger = await r.pool('reconciliation');
        const transfers = await tokenTransfers(await r.rpc.getBlockNumber({ cacheTime: 0 }));
        const inbound = transfers.filter(log => log.args.to?.toLowerCase() === pool.toLowerCase()).reduce((s, log) => s + log.args.value!, 0n);
        const outbound = transfers.filter(log => log.args.from?.toLowerCase() === pool.toLowerCase()).reduce((s, log) => s + log.args.value!, 0n);
        check('actual-BEM-transfers-match-total-income-and-payouts', inbound === ledger.totalAccounted && outbound === ledger.totalPaid, { inbound, outbound, transfers });
        let nandClaimed = 0n, latchClaimed = 0n;
        for (const id of [1n, 2n, 3n, 4n]) nandClaimed += await r.pool<bigint>('claimed', [0, id]);
        for (const id of [1n, 2n]) latchClaimed += await r.pool<bigint>('claimed', [1, id]);
        const base = results.observations.boundary?.nandBase ?? 0n;
        const n = await r.pool<bigint>('totalNandBurn'), l = await r.pool<bigint>('totalLatchBurn');
        const delta = inbound * 100n / 102n - base;
        const expectedNand = (base + delta * n / (n + l)) / 4n * 4n;
        const expectedLatch = delta * l / (n + l) / 2n * 2n;
        check('independent-final-payout-reconciliation', ledger.nandReceiptsAccrued === expectedNand && ledger.latchReceiptsAccrued === expectedLatch && nandClaimed === ledger.nandReceiptsPaid && latchClaimed === ledger.latchReceiptsPaid && ledger.recipientAPaid === ledger.totalAccounted / 102n && ledger.recipientBPaid === ledger.recipientAPaid && ledger.nandReceiptsPaid === ledger.nandReceiptsAccrued && ledger.latchReceiptsPaid === ledger.latchReceiptsAccrued && ledger.unrecognized === 0n && ledger.deficit === 0n && ledger.bemBalance === ledger.residue && ledger.residue <= 7n && ledger.totalAccounted === ledger.totalPaid + ledger.bemBalance, { ledger, expectedNand, expectedLatch, nandClaimed, latchClaimed });
        results.observations.finalLedger = ledger;
      }
      await accrue();
      const returned = [];
      for (const id of IDS) {
        const key = await r.read(P.mining, miningAbi, 'minerKey', [P.minerCollection, id]);
        const record = await r.read(P.mining, miningAbi, 'getMiner', [key]);
        const before = await bem(owner);
        try {
          const receipt = await r.send(`post-return-owner-income-${id}`, P.mining, encodeFunctionData({ abi: miningAbi, functionName: 'claim', args: [key] }), 'claim');
          returned.push({ id, status: record.status, paidRaw: await bem(owner) - before, transaction: receipt.transactionHash, scope: 'POST_RETURN_PERSONAL_INCOME_EXCLUDED_FROM_POOL' });
        } catch (e) { returned.push({ id, status: record.status, result: 'UNVERIFIED', reason: redact(e) }); }
      }
      results.observations.postReturn = returned;
      if (distributor && existsSync(`${dir}/allocation-artifact.json`)) {
        const allocation = JSON.parse(readFileSync(`${dir}/allocation-artifact.json`, 'utf8'));
        results.observations.finalAllocation = verifyAllocation(allocation, await readAllocationState(r.rpc, distributor), { chainId: 56, distributor, nandReceipt: nand!, latchReceipt: latch! });
      }
      const rows = readFileSync(`${dir}/journal.jsonl`, 'utf8').trim().split('\n').map(x => JSON.parse(x)).filter(x => x.stage === 'CONFIRMED');
      const nftTransfers = rows.flatMap(x => x.events.filter((e: any) => e.address.toLowerCase() === P.minerCollection.toLowerCase() && e.topics[0] === keccak256(stringToHex('Transfer(address,address,uint256)')) && e.topics.length === 4).map((e: any) => ({ action: x.action, tokenId: BigInt(e.topics[3]) })));
      const allowed = new Set([P.mining, P.minerCollection, ...Object.values(r.manifest.contracts)].map(x => x!.toLowerCase()));
      check('no-unrelated-assets-or-collection-wide-approvals', rows.every(x => x.target === null || allowed.has(x.target.toLowerCase())) && rows.every(x => x.function !== 'setApprovalForAll') && nftTransfers.length === 4 && nftTransfers.every(x => IDS.some(id => id === x.tokenId)), { nftTransfers, transactionTargets: [...new Set(rows.map(x => x.target))] });
    }
  } catch (e) { results.finalizationError = redact(e); }
  const success = !businessError && !results.recoveryError && !results.finalizationError && Object.values(results.assertions).every((x: any) => x.status === 'PASS');
  results.status = success ? 'PASS' : 'FAIL_OR_INCOMPLETE';
  results.totalFeeRaw = r.manifest.totalFeeRaw;
  results.completedAt = new Date().toISOString();
  save(`${dir}/results.json`, results);
  r.manifest.status = results.status;
  r.persist();
  return results;
}
