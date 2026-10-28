/**
 * Follow-up review findings Fable T2-1 / GPT ABI requirement: the standard readers decode the tuple
 * layouts of accrual(), previewAccrual(), reconciliation() and (2.2.0) ledgerState() only after VERSION
 * names a layout this SDK has (sdk/pool.ts assertReadLayout). Updated for TapeoutMinerPool/2.2.0 and the
 * local canary-3 (SALUS remediation): 2.1.0 is now one of the refused versions.
 * - Fake nodes (a viem custom transport answering eth_call by function) record every requested function,
 *   so the tests show what was read before a refusal.
 * - Loopback Anvil nodes run the actual CLI against real 2.2.0 and canary-3 pools and a legacy VERSION.
 * The old-ABI/new-blob proof for external consumers stays in test/audit2 (FeeSplitConsumers.t.sol,
 * fee-split-consumers.test.ts): this SDK cannot protect software that keeps the 2.0.0 ABI.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPublicClient, custom, decodeFunctionResult, encodeAbiParameters, encodeDeployData, encodeFunctionResult, http, toFunctionSelector, toHex,
  type Abi, type AbiFunction, type Address, type Hex,
} from 'viem';
import { main as cli } from '../../cli/pool.ts';
import { startAnvil, type AnvilNode } from '../../scripts/lib/anvil.ts';
import { mockBEMAbi, mockMiningAbi, mockNFTAbi, tapeoutEntitlementReceiptAbi, tapeoutMinerPoolAbi } from '../../sdk/abi.ts';
import bytecode from '../../sdk/bytecode.json' with { type: 'json' };
import { LATCH_CATEGORY, NAND_CATEGORY } from '../../sdk/config.ts';
import { accrue, SINK, type State } from '../../sdk/math.ts';
import {
  assertReadLayout, checkReconciliation, LOCAL_CANARY_LAYOUT_VERSIONS, READ_LAYOUT_VERSIONS, readLayoutPolicyFor, readPoolSummary,
} from '../../sdk/pool.ts';

const abi = tapeoutMinerPoolAbi as Abi;
const functions = (abi as readonly { type: string }[]).filter(i => i.type === 'function') as AbiFunction[];
const nameOf = new Map(functions.map(f => [toFunctionSelector(f), f.name]));
const POOL = '0x00000000000000000000000000000000000000f1' as Address;
const answer = (functionName: string, result: unknown) => encodeFunctionResult({ abi, functionName, result } as never);

/** A fake node: eth_call answered by function name (a function value throws instead), every request recorded. */
function fakeNode(answers: Record<string, Hex | (() => never)>) {
  const calls: { fn: string; block: unknown }[] = [];
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      if (method === 'eth_chainId') return '0x38';
      if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
      const [tx, block] = params as [{ data: Hex }, unknown];
      const fn = nameOf.get(tx.data.slice(0, 10) as Hex) ?? tx.data.slice(0, 10);
      calls.push({ fn, block });
      const a = answers[fn];
      if (a === undefined) throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' });
      return typeof a === 'function' ? a() : a;
    },
  }, { retryCount: 0 }); // the record shows exactly what the reader requested
  return { rpc: createPublicClient({ transport }), calls };
}

// A consistent 2.2.0 ledger: T = 1,050 raw, composition 3:1, 4 NAND and 2 LATCH receipts.
const state: State = { accountedBase: 0n, nandBase: 0n, latchBase: 0n, totalNandBurn: 3n, totalLatchBurn: 1n, nandShares: 4n, latchShares: 2n };
const accrual = accrue(1_050n, state);
const totalPaid = 12n + 25n + accrual.perNandShare;
const reconciliation = {
  bemBalance: 1_050n - totalPaid, unrecognized: 0n, deficit: 0n, totalAccounted: 1_050n, totalPaid,
  recipientAAccrued: accrual.recipientA, recipientAPaid: 12n, recipientBAccrued: accrual.recipientB, recipientBPaid: 0n,
  sinkAccrued: accrual.sink, sinkPaid: 25n, nandIncome: accrual.nandIncome, nandReceiptsAccrued: accrual.nandReceipts, nandReceiptsPaid: accrual.perNandShare,
  latchIncome: accrual.latchIncome, latchReceiptsAccrued: accrual.latchReceipts, latchReceiptsPaid: 0n, residue: accrual.residue,
};
const someone = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const pool21 = (version: string = READ_LAYOUT_VERSIONS[0]): Record<string, Hex> => ({
  VERSION: answer('VERSION', version), poolName: answer('poolName', 'Fixture'), owner: answer('owner', someone(0)), active: answer('active', true),
  activatedAt: answer('activatedAt', 1n), nandShares: answer('nandShares', 4n), latchShares: answer('latchShares', 2n), totalNandBurn: answer('totalNandBurn', 3n),
  totalLatchBurn: answer('totalLatchBurn', 1n), compositionPeriod: answer('compositionPeriod', 1n), ledgerState: answer('ledgerState', state), accrual: answer('accrual', accrual),
  reconciliation: answer('reconciliation', reconciliation), minerCount: answer('minerCount', 1n), recipientA: answer('recipientA', someone(0xaa)),
  recipientB: answer('recipientB', someone(0xbb)), SINK: answer('SINK', SINK), depositors: answer('depositors', [someone(0xd1)]),
  nandReceipt: answer('nandReceipt', someone(0x11)), latchReceipt: answer('latchReceipt', someone(0x12)), bem: answer('bem', someone(0xbe)),
  mining: answer('mining', someone(0x31)), minerCollection: answer('minerCollection', someone(0xc0)), distributor: answer('distributor', someone(0xd5)),
  custodyOpen: answer('custodyOpen', true), carriedIncome: answer('carriedIncome', 0n), carriedNandUnits: answer('carriedNandUnits', 0n),
});

test('2.2.0: VERSION is read first, then every field decodes at the same block, sink and ledger fields included', async () => {
  const { rpc, calls } = fakeNode(pool21());
  const s = await readPoolSummary(rpc, POOL, 100n);
  assert.equal(calls[0].fn, 'VERSION');
  assert.ok(calls.every(c => c.block === toHex(100n)), 'one pinned block for every read');
  assert.equal(s.version, 'TapeoutMinerPool/2.2.0');
  assert.deepEqual(s.state, state);
  assert.equal(s.custodyOpen, true);
  assert.deepEqual([s.accrual.participants, s.accrual.recipientA, s.accrual.sink, s.accrual.residue], [1_000n, 12n, 25n, 3n]);
  assert.deepEqual([s.reconciliation.sinkAccrued, s.reconciliation.sinkPaid, s.reconciliation.nandReceiptsAccrued, s.reconciliation.latchReceiptsAccrued], [25n, 25n, 748n, 250n]);
  assert.equal(s.sink, SINK);
  assert.equal(checkReconciliation(s.state, s.reconciliation).status, 'PASS');
});

test('2.0.0, unknown, empty or future versions are refused before any tuple is read', async () => {
  for (const version of ['TapeoutMinerPool/2.0.0', 'TapeoutMinerPool/2.1.0', 'TapeoutMinerPool/2.3.0', 'SomethingElse/1', '', 'TapeoutMinerPool/2.2.0 ', 'tapeoutminerpool/2.2.0']) {
    const { rpc, calls } = fakeNode(pool21(version));
    const error = await readPoolSummary(rpc, POOL, 7n).then(() => undefined, e => e as Error);
    assert.ok(error?.message.includes(`reports VERSION ${JSON.stringify(version)};`), `${JSON.stringify(version)}: ${error?.message}`);
    assert.deepEqual(calls.map(c => c.fn), ['VERSION'], `nothing but VERSION was read for ${JSON.stringify(version)}`);
  }
});

test('an unreadable, missing or malformed VERSION is refused, never taken for compatibility', async () => {
  const transportFailure = () => { throw Object.assign(new Error('fetch failed for http://user:secret@rpc.example/'), { code: -32603 }); };
  const cases: [string, Record<string, Hex | (() => never)>][] = [
    ['reverts', { ...pool21(), VERSION: (() => { throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' }); }) as () => never }],
    ['returns no data', { ...pool21(), VERSION: '0x' }],
    ['returns malformed data', { ...pool21(), VERSION: '0x1234' }],
    ['transport failure', { ...pool21(), VERSION: transportFailure as () => never }],
  ];
  for (const [label, answers] of cases) {
    const { rpc, calls } = fakeNode(answers);
    const error = await readPoolSummary(rpc, POOL).then(() => undefined, e => e as Error);
    assert.ok(error, `${label}: refused`);
    assert.match(error!.message, /VERSION\(\) could not be read/, label);
    assert.doesNotMatch(error!.message, /secret|https?:\/\//, `${label}: no RPC URL in the diagnostic`);
    assert.deepEqual(calls.map(c => c.fn), ['VERSION'], label);
  }
});

test('the local canary-3 layout is decoded only when the caller opts in; only loopback development nodes opt in', async () => {
  const canary = LOCAL_CANARY_LAYOUT_VERSIONS[0];
  const refused = fakeNode(pool21(canary));
  await assert.rejects(readPoolSummary(refused.rpc, POOL), /loopback development node/);
  assert.deepEqual(refused.calls.map(c => c.fn), ['VERSION']);
  const accepted = fakeNode(pool21(canary));
  const s = await readPoolSummary(accepted.rpc, POOL, undefined, { allowLocalCanary: true });
  assert.equal(s.version, canary);
  assert.equal(s.accrual.sink, 25n);
  assert.deepEqual(readLayoutPolicyFor('LOCAL_DEV_NODE'), { allowLocalCanary: true });
  for (const kind of ['REMOTE_DEV_NODE', 'LOCAL_NODE', 'REMOTE_NODE', 'unknown']) assert.deepEqual(readLayoutPolicyFor(kind), { allowLocalCanary: false }, kind);
  assert.equal(await assertReadLayout(fakeNode(pool21()).rpc, POOL), 'TapeoutMinerPool/2.2.0');
});

test('why the gate is needed: a layout this SDK lacks decodes without an error but into the wrong fields', async () => {
  // A hypothetical later layout that inserts one more field after recipientB, as 2.1.0 did with `sink`.
  const accrualOutput = (functions.find(f => f.name === 'accrual')!.outputs[0] as { components: readonly { name: string; type: string }[] }).components;
  const later = [...accrualOutput.slice(0, 4), { name: 'laterField', type: 'uint256' }, ...accrualOutput.slice(4)];
  const blob = encodeAbiParameters([{ type: 'tuple', components: later }], [{ ...accrual, laterField: 7n }]);
  const misread = decodeFunctionResult({ abi, functionName: 'accrual', data: blob }) as { participants: bigint; residue: bigint };
  assert.equal(misread.participants, 7n, 'decoded silently: participants is the inserted field');
  assert.notEqual(misread.residue, accrual.residue);
  const { rpc, calls } = fakeNode({ ...pool21('TapeoutMinerPool/2.3.0'), accrual: blob });
  await assert.rejects(readPoolSummary(rpc, POOL), /reports VERSION "TapeoutMinerPool\/2\.3\.0"/);
  assert.deepEqual(calls.map(c => c.fn), ['VERSION'], 'the blob was never requested');
});

// ---- the actual CLI on a loopback Anvil node --------------------------------------------------------

/** Runtime code that returns abi.encode(text) for any call: a stand-in for a pool reporting `text`. */
const versionStub = (text: string) => {
  const bytes = Buffer.from(text, 'utf8');
  assert.ok(bytes.length <= 32);
  const word = Buffer.concat([bytes, Buffer.alloc(32 - bytes.length)]).toString('hex');
  return `0x6020600052${`60${bytes.length.toString(16).padStart(2, '0')}602052`}7f${word}60405260606000f3` as Hex;
};

let node: AnvilNode;
const dir = mkdtempSync(join(tmpdir(), 'read-layout-'));
const files: Record<string, string> = {};
let canaryPool: Address;

before(async () => {
  node = await startAnvil(18593, ['--chain-id', '31337', '--silent']);
  const rpc = createPublicClient({ transport: http(node.url) });
  const [owner] = await rpc.request({ method: 'eth_accounts' } as never) as Address[];
  const deploy = async (abiOf: Abi, code: Hex, args: unknown[] = []) => {
    const hash = await rpc.request({ method: 'eth_sendTransaction', params: [{ from: owner, data: encodeDeployData({ abi: abiOf, bytecode: code, args }) }] } as never) as Hex;
    const receipt = await rpc.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    return receipt.contractAddress!;
  };
  const bem = await deploy(mockBEMAbi as Abi, bytecode.MockBEM.bytecode as Hex);
  const mining = await deploy(mockMiningAbi as Abi, bytecode.MockMining.bytecode as Hex, [bem]);
  const nft = await deploy(mockNFTAbi as Abi, bytecode.MockNFT.bytecode as Hex);
  const receipt = (category: Hex, symbol: string) => deploy(tapeoutEntitlementReceiptAbi as Abi, bytecode.TapeoutEntitlementReceipt.bytecode as Hex, [category, `Layout ${symbol}`, symbol, '', owner]);
  const nandReceipt = await receipt(NAND_CATEGORY, 'lN'), latchReceipt = await receipt(LATCH_CATEGORY, 'lL');
  const deployment = (name: string) => ({ owner, bem, mining, minerCollection: nft, nandReceipt, latchReceipt, recipientA: someone(0xaa), recipientB: someone(0xbb), depositors: [owner], poolName: name });
  const production = await deploy(abi, bytecode.TapeoutMinerPool.bytecode as Hex, [deployment('Layout production')]);
  const canaryArtifact = JSON.parse(readFileSync('out/RecoverableTapeoutMinerPool.sol/RecoverableTapeoutMinerPool.json', 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
  canaryPool = await deploy(canaryArtifact.abi, canaryArtifact.bytecode.object, [deployment('Layout canary')]);
  const legacy = someone(0x2000), empty = someone(0x2001);
  await rpc.request({ method: 'anvil_setCode', params: [legacy, versionStub('TapeoutMinerPool/2.0.0')] } as never);
  const write = (label: string, pool: Address) => {
    files[label] = join(dir, `${label}.json`);
    writeFileSync(files[label], JSON.stringify({ chainId: 31337, nandReceipt, latchReceipt, pool }));
  };
  write('production', production);
  write('canary', canaryPool);
  write('legacy', legacy);
  write('empty', empty);
});
after(async () => {
  await node?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('CLI on a loopback node: a real 2.2.0 pool is inspected and reconciled', async () => {
  const inspect = await cli(['inspect', '--addresses', files.production, '--rpc-url', node.url]) as { pool: { version: string; sink: string }; finality: { custodyOpen: boolean; missing: string[] } };
  assert.equal(inspect.pool.version, 'TapeoutMinerPool/2.2.0');
  assert.equal(inspect.finality.custodyOpen, false);
  assert.ok(inspect.finality.missing.includes('distributorBound') && inspect.finality.missing.includes('poolActive'));
  assert.equal(inspect.pool.sink, SINK);
  const reconcile = await cli(['reconcile', '--addresses', files.production, '--rpc-url', node.url]) as { status: string };
  assert.equal(reconcile.status, 'PASS');
});

test('CLI on a loopback node: the canary-3 layout is read there; the SDK default refuses it', async () => {
  const inspect = await cli(['inspect', '--addresses', files.canary, '--rpc-url', node.url]) as { pool: { version: string } };
  assert.equal(inspect.pool.version, 'RecoverableTapeoutMinerPool/canary-3-local');
  await assert.rejects(readPoolSummary(createPublicClient({ transport: http(node.url) }), canaryPool), /loopback development node/);
});

test('CLI: inspect, reconcile and composition refuse a 2.0.0 VERSION and an unreadable one', async () => {
  for (const command of [['inspect'], ['reconcile'], ['composition', '--token-ids', '1']]) {
    await assert.rejects(cli([...command, '--addresses', files.legacy, '--rpc-url', node.url]), /reports VERSION "TapeoutMinerPool\/2\.0\.0"/, command[0]);
    await assert.rejects(cli([...command, '--addresses', files.empty, '--rpc-url', node.url]), /VERSION\(\) could not be read/, command[0]);
  }
});
