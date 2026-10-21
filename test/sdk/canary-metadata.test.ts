/**
 * Follow-up review finding GPT C-210-01: the canary's expected-revert verifier classifies failures to obtain
 * the chain id or the block the same structured way as eth_call failures, and makes no test call without
 * valid metadata. An in-memory node counts metadata reads and eth_calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeErrorResult, encodeFunctionData, type Abi, type Hex, type PublicClient } from 'viem';
import {
  NegativeTestStop, recordNegativeTest, stopClassification, verifyExpectedRevert, type ExpectedError,
} from '../../scripts/canary/revert-verifier.ts';
import { tapeoutMinerPoolAbi } from '../../sdk/abi.ts';

const POOL_ABI = tapeoutMinerPoolAbi as Abi;
const NOT_HOLDER: ExpectedError = { abi: POOL_ABI, name: 'NotHolder', args: [0, 1n] };
const DATA = encodeErrorResult({ abi: POOL_ABI, errorName: 'NotHolder', args: [0, 1n] });
const TARGET = '0x5904d00d2990c8734051b5d0e7aaeba636dc591e' as const;
const CALLER = '0x7eEDccb674e9549b61B01Eb65aC68DA071ADF129' as const;
const CALLDATA = encodeFunctionData({ abi: POOL_ABI, functionName: 'claim', args: [0, 1n] });
const HASH = `0x${'ab'.repeat(32)}` as Hex;
const block = (number: bigint, hash: unknown = HASH) => ({ number, hash });
const reverted = (data: Hex) => Object.assign(new Error('execution reverted'), { code: 3, data });

type Step<T> = T | Error;
/** An in-memory node: chain id and block answers taken in turn (the last one repeats); eth_call likewise. */
function node(chain: Step<unknown>[], blocks: Step<unknown>[], calls: (Error | 'OK')[] = [reverted(DATA)]) {
  const n = { chain: 0, block: 0, ethCall: 0, ethCallBlocks: [] as unknown[] };
  const next = <T>(list: Step<T>[], i: number) => list[Math.min(i, list.length - 1)];
  const rpc = {
    async getChainId() { const v = next(chain, n.chain++); if (v instanceof Error) throw v; return v; },
    async getBlock() { const v = next(blocks, n.block++); if (v instanceof Error) throw v; return v; },
    async request({ method, params }: { method: string; params: unknown[] }) {
      assert.equal(method, 'eth_call');
      n.ethCallBlocks.push(params[1]);
      const v = next(calls, n.ethCall++);
      if (v instanceof Error) throw v;
      return '0x';
    },
  } as unknown as PublicClient;
  return { rpc, n };
}
const verify = (rpc: PublicClient, extra: { blockNumber?: bigint; expectedChainId?: number } = { blockNumber: 16n, expectedChainId: 56 }) =>
  verifyExpectedRevert({ rpc, from: CALLER, to: TARGET, data: CALLDATA, expected: NOT_HOLDER, attempts: 3, retryDelayMs: 1, ...extra });
const down = () => Object.assign(new Error('fetch failed: http://user:secret@archive.example/rpc'), { name: 'HttpRequestError' });

test('getChainId fails: bounded metadata attempts, a structured UNVERIFIED result, no eth_call and no invented metadata', async () => {
  const { rpc, n } = node([down()], [block(16n)]);
  const r = await verify(rpc);
  assert.deepEqual([r.verdict, r.kind, r.stage], ['UNVERIFIED', 'METADATA_UNAVAILABLE', 'chain-metadata']);
  assert.deepEqual(r.metadataAttempts.map(a => [a.stage, a.attempt, a.ok]), [['chain-metadata', 1, false], ['chain-metadata', 2, false], ['chain-metadata', 3, false]]);
  assert.deepEqual([n.chain, n.block, n.ethCall], [3, 0, 0]);
  assert.equal(r.chainId, undefined);
  assert.equal(r.block, undefined);
  assert.deepEqual(r.attempts, []);
  assert.doesNotMatch(JSON.stringify(r.metadataAttempts), /secret|archive\.example/, 'diagnostics never carry the RPC URL');
});

test('getBlock fails: a structured UNVERIFIED result with the chain id it did obtain, and no eth_call', async () => {
  const { rpc, n } = node([56], [down()]);
  const r = await verify(rpc);
  assert.deepEqual([r.verdict, r.kind, r.stage, r.chainId], ['UNVERIFIED', 'METADATA_UNAVAILABLE', 'block-metadata', 56]);
  assert.deepEqual(r.metadataAttempts.map(a => [a.stage, a.ok]), [['chain-metadata', true], ['block-metadata', false], ['block-metadata', false], ['block-metadata', false]]);
  assert.deepEqual([n.chain, n.block, n.ethCall], [1, 3, 0]);
  assert.equal(r.block, undefined);
});

test('missing, malformed or inconsistent metadata fails closed without fabricated evidence', async () => {
  const cases: [string, Step<unknown>[], Step<unknown>[]][] = [
    ['chain id 0', [0], [block(16n)]],
    ['non-integer chain id', [Number.NaN], [block(16n)]],
    ['block without a number', [56], [{ number: null, hash: HASH }]],
    ['block without a hash', [56], [block(16n, null)]],
    ['malformed hash', [56], [block(16n, '0x1234')]],
    ['another block than requested', [56], [block(15n)]],
    ['no block at all', [56], [null]],
  ];
  for (const [label, chain, blocks] of cases) {
    const { rpc, n } = node(chain, blocks);
    const r = await verify(rpc);
    assert.deepEqual([r.verdict, r.kind], ['UNVERIFIED', 'METADATA_UNAVAILABLE'], label);
    assert.equal(n.ethCall, 0, `${label}: nothing called`);
    assert.equal(r.block, undefined, `${label}: no block reported`);
    if (label.includes('chain')) assert.equal(r.chainId, undefined, `${label}: no chain id reported`);
  }
});

test('metadata that fails once and then succeeds: the call runs at the chosen block, with every attempt recorded', async () => {
  const { rpc, n } = node([down(), 56], [down(), block(16n)]);
  const r = await verify(rpc);
  assert.deepEqual([r.verdict, r.kind, r.chainId, r.block], ['PASS', 'EXPECTED_REVERT', 56, { number: 16n, hash: HASH }]);
  assert.deepEqual(r.metadataAttempts.map(a => [a.stage, a.attempt, a.ok]), [['chain-metadata', 1, false], ['chain-metadata', 2, true], ['block-metadata', 1, false], ['block-metadata', 2, true]]);
  assert.deepEqual(n.ethCallBlocks, ['0x10']);
});

test('eth_call transport failures stay bounded UNVERIFIED at the pinned block; semantic results are not retried', async () => {
  const transport = node([56], [block(16n)], [down()]);
  const t = await verify(transport.rpc);
  assert.deepEqual([t.verdict, t.kind, transport.n.ethCall], ['UNVERIFIED', 'TRANSPORT_ERROR', 3]);
  assert.deepEqual(transport.n.ethCallBlocks, ['0x10', '0x10', '0x10'], 'never another block, never latest');
  const other = encodeErrorResult({ abi: POOL_ABI, errorName: 'NotDepositor', args: ['0x0000000000000000000000000000000000000001'] });
  const wrongArgs = encodeErrorResult({ abi: POOL_ABI, errorName: 'NotHolder', args: [0, 2n] });
  for (const [reply, kind] of [[reverted(DATA), 'EXPECTED_REVERT'], [reverted(other), 'WRONG_ERROR'], [reverted(wrongArgs), 'WRONG_ARGUMENTS'], ['OK', 'UNEXPECTED_SUCCESS']] as const) {
    const { rpc, n } = node([56], [block(16n)], [reply]);
    const r = await verify(rpc);
    assert.equal(r.kind, kind);
    assert.equal(r.verdict, kind === 'EXPECTED_REVERT' ? 'PASS' : 'FAIL');
    assert.equal(n.ethCall, 1, `${kind}: decided on the first call`);
  }
});

test('a node on another chain than expected is a FAIL, not retried, and nothing is called', async () => {
  const { rpc, n } = node([97], [block(16n)]);
  const r = await verify(rpc);
  assert.deepEqual([r.verdict, r.kind, r.chainId], ['FAIL', 'CHAIN_MISMATCH', 97]);
  assert.deepEqual([n.chain, n.block, n.ethCall], [1, 0, 0]);
  // Without an expected chain the chain id is recorded, not judged (the unchanged earlier behaviour).
  const free = node([97], [block(16n)]);
  assert.equal((await verify(free.rpc, { blockNumber: 16n })).verdict, 'PASS');
});

test('the workflow records an inconclusive check as UNVERIFIED infrastructure, after saving it, and stops normal progress', async () => {
  const { rpc } = node([down()], [block(16n)]);
  const results: Record<string, any> = { status: 'IN_PROGRESS', assertions: {} };
  const saved: string[] = [];
  let nextStepRan = false;
  try {
    recordNegativeTest(results, 'former-holder-claim-rejected', await verify(rpc), () => saved.push(JSON.stringify(results, (_, x) => (typeof x === 'bigint' ? String(x) : x))));
    nextStepRan = true;
  } catch (e) {
    assert.ok(e instanceof NegativeTestStop);
    assert.equal(e.message, 'ASSERTION_UNVERIFIED former-holder-claim-rejected (METADATA_UNAVAILABLE)');
    Object.assign(results, stopClassification(e));
  }
  assert.equal(nextStepRan, false, 'normal steps stop');
  assert.equal(saved.length, 1, 'the evidence was saved before stopping');
  assert.match(saved[0], /"status":"UNVERIFIED"/);
  assert.deepEqual([results.status, results.stopReason], ['NEGATIVE_TEST_UNVERIFIED_RECOVERING', 'INCONCLUSIVE_NEGATIVE_TEST']);
  assert.deepEqual(stopClassification(new NegativeTestStop('x', 'FAIL', 'WRONG_ERROR')), { status: 'BUSINESS_TEST_FAILED_RECOVERING', stopReason: 'NEGATIVE_TEST_FAILED' });
  assert.deepEqual(stopClassification(new Error('ASSERTION_FAILED something')), { status: 'BUSINESS_TEST_FAILED_RECOVERING', stopReason: 'ASSERTION_OR_UNCLASSIFIED_ERROR' });
});
