/**
 * Review findings CT-01 / T-1 / T-2: the canary's expected-revert verifier (scripts/canary/revert-verifier.ts)
 * against provider error shapes served by a local mock JSON-RPC server, and against a real Anvil node.
 * Nothing leaves the machine.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import {
  createPublicClient, encodeAbiParameters, encodeDeployData, encodeErrorResult, encodeFunctionData, http, keccak256, stringToHex, type Abi, type Address, type Hex,
} from 'viem';
import { startAnvil } from '../../scripts/lib/anvil.ts';
import { classifyRevert, verifyExpectedRevert, type ExpectedError } from '../../scripts/canary/revert-verifier.ts';
import { tapeoutEntitlementReceiptAbi, tapeoutMinerPoolAbi } from '../../sdk/abi.ts';
import bytecode from '../../sdk/bytecode.json' with { type: 'json' };

const POOL_ABI = tapeoutMinerPoolAbi as Abi;
const NOT_HOLDER: ExpectedError = { abi: POOL_ABI, name: 'NotHolder', args: [0, 1n] };
const selector = (signature: string) => keccak256(stringToHex(signature)).slice(0, 10) as Hex;
const DATA = encodeErrorResult({ abi: POOL_ABI, errorName: 'NotHolder', args: [0, 1n] });
const WRONG_ARGS = encodeErrorResult({ abi: POOL_ABI, errorName: 'NotHolder', args: [0, 2n] });
const OTHER_ERROR = encodeErrorResult({ abi: POOL_ABI, errorName: 'NotDepositor', args: ['0x0000000000000000000000000000000000000001'] });
// An Error(string) whose reason contains "revert" and the expected selector as text.
const MISLEADING = `0x08c379a0${encodeAbiParameters([{ type: 'string' }], [`execution reverted: custom error ${selector('NotHolder(uint8,uint256)')}`]).slice(2)}` as Hex;
const TARGET = '0x5904d00d2990c8734051b5d0e7aaeba636dc591e' as const;
const CALLER = '0x7eEDccb674e9549b61B01Eb65aC68DA071ADF129' as const;
const CALLDATA = encodeFunctionData({ abi: POOL_ABI, functionName: 'claim', args: [0, 1n] });

type Reply = { error: unknown } | { result: unknown } | 'HTTP_502' | 'HANG';
const servers: Server[] = [];
after(() => servers.forEach(s => s.close()));
const BLOCK = {
  number: '0x10', hash: `0x${'ab'.repeat(32)}`, parentHash: `0x${'00'.repeat(32)}`, timestamp: '0x1', nonce: '0x0000000000000000', difficulty: '0x0',
  gasLimit: '0x1c9c380', gasUsed: '0x0', miner: '0x0000000000000000000000000000000000000000', extraData: '0x', baseFeePerGas: '0x1', size: '0x1',
  transactions: [], uncles: [], logsBloom: `0x${'00'.repeat(256)}`, sha3Uncles: `0x${'00'.repeat(32)}`, stateRoot: `0x${'00'.repeat(32)}`,
  receiptsRoot: `0x${'00'.repeat(32)}`, transactionsRoot: `0x${'00'.repeat(32)}`, mixHash: `0x${'00'.repeat(32)}`, totalDifficulty: '0x0',
};

/** A JSON-RPC server answering eth_call with `replies` in turn (the last one repeats); counts eth_calls. */
async function server(replies: Reply[]) {
  const hits = { calls: 0 };
  const url = await new Promise<string>(resolve => {
    const s = createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        const { id, method } = JSON.parse(body);
        const send = (payload: object) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, ...payload })); };
        if (method === 'eth_chainId') return send({ result: '0x38' });
        if (method === 'eth_getBlockByNumber') return send({ result: BLOCK });
        const reply = replies[Math.min(hits.calls++, replies.length - 1)];
        if (reply === 'HTTP_502') { res.writeHead(502); res.end('bad gateway'); return; }
        if (reply === 'HANG') return; // never answers: the client times out
        send(reply);
      });
    });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as { port: number }).port}`));
  });
  const rpc = createPublicClient({ transport: http(url, { retryCount: 0, timeout: 500 }) });
  return { rpc, hits };
}
const verify = async (replies: Reply[], attempts = 3) => {
  const { rpc, hits } = await server(replies);
  const result = await verifyExpectedRevert({ rpc, from: CALLER, to: TARGET, data: CALLDATA, expected: NOT_HOLDER, blockNumber: 16n, attempts, retryDelayMs: 10 });
  return { result, hits };
};

const show = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));

/** The frozen runner's predicate (scripts/canary/workflow.ts at f2c8e50), for comparison only. */
const frozen = (message: string) => /revert/i.test(message) && message.toLowerCase().includes(selector('NotHolder(uint8,uint256)'));

test('correct revert bytes in structured data pass, whatever the message says and however they are nested', async () => {
  for (const error of [
    { code: 3, message: 'execution reverted', data: DATA },
    { code: -32000, message: 'execution reverted', data: { data: DATA, message: 'reverted' } },
    { code: -32603, message: 'Internal error', data: { originalError: { code: 3, data: DATA, message: 'execution reverted' } } },
  ]) {
    const { result, hits } = await verify([{ error }]);
    assert.equal(result.verdict, 'PASS', show(result));
    assert.equal(result.kind, 'EXPECTED_REVERT');
    assert.deepEqual(result.decoded, { name: 'NotHolder', args: [0, 1n] });
    assert.equal(hits.calls, 1);
    // The record pins the call: chain, block, caller, target, calldata, raw bytes, expectation.
    assert.deepEqual([result.chainId, result.block?.number, result.caller, result.target, result.calldata, result.revertData], [56, 16n, CALLER, TARGET, CALLDATA, DATA.toLowerCase()]);
  }
  // The frozen predicate missed the first shape (a generic message): the false negative of the mainnet run.
  assert.equal(frozen('Execution reverted for an unknown reason.'), false);
});

test('a wrong error, wrong arguments or a misleading Error(string) fail at once and are never retried', async () => {
  const wrongError = await verify([{ error: { code: 3, message: 'execution reverted', data: OTHER_ERROR } }]);
  assert.deepEqual([wrongError.result.verdict, wrongError.result.kind, wrongError.hits.calls], ['FAIL', 'WRONG_ERROR', 1]);
  const wrongArgs = await verify([{ error: { code: 3, message: 'execution reverted', data: WRONG_ARGS } }]);
  assert.deepEqual([wrongArgs.result.verdict, wrongArgs.result.kind], ['FAIL', 'WRONG_ARGUMENTS']);
  assert.deepEqual(wrongArgs.result.decoded, { name: 'NotHolder', args: [0, 2n] });
  const misleading = await verify([{ error: { code: 3, message: `execution reverted: custom error ${selector('NotHolder(uint8,uint256)')}`, data: MISLEADING } }]);
  assert.deepEqual([misleading.result.verdict, misleading.result.kind], ['FAIL', 'WRONG_ERROR']);
  assert.equal((misleading.result.decoded as { name: string }).name, 'Error');
  // The frozen predicate would have accepted that message: a false positive on text alone.
  assert.equal(frozen(`execution reverted: custom error ${selector('NotHolder(uint8,uint256)')}`), true);
  const success = await verify([{ result: '0x' }]);
  assert.deepEqual([success.result.verdict, success.result.kind, success.hits.calls], ['FAIL', 'UNEXPECTED_SUCCESS', 1]);
});

test('missing, empty, malformed or ambiguous data and transport failures are UNVERIFIED after bounded retries, never PASS', async () => {
  const cases: [Reply, string][] = [
    // The selector and arguments appear only in the message text: not evidence.
    [{ error: { code: -32603, message: `execution reverted: custom error ${DATA}` } }, 'NO_REVERT_DATA'],
    [{ error: { code: 3, message: 'execution reverted', data: '0x' } }, 'NO_REVERT_DATA'],
    [{ error: { code: 3, message: 'execution reverted', data: `${DATA}0` } }, 'MALFORMED_REVERT_DATA'],
    [{ error: { code: 3, message: 'execution reverted', data: DATA.slice(0, 30) } }, 'MALFORMED_REVERT_DATA'],
    [{ error: { code: 3, message: 'execution reverted', data: `${DATA}00` } }, 'MALFORMED_REVERT_DATA'],
    [{ error: { code: -32000, message: 'execution reverted', data: { data: DATA, originalError: { data: OTHER_ERROR } } } }, 'AMBIGUOUS_REVERT_DATA'],
    ['HTTP_502', 'TRANSPORT_ERROR'],
    ['HANG', 'TRANSPORT_ERROR'],
  ];
  for (const [reply, kind] of cases) {
    const { result, hits } = await verify([reply], 3);
    assert.equal(result.verdict, 'UNVERIFIED', `${kind}: ${show(result)}`);
    assert.equal(result.kind, kind);
    assert.equal(hits.calls, 3, `${kind} is retried at most 3 times`);
    assert.equal(result.attempts.length, 3);
  }
});

test('a transient failure followed by correct bytes passes, with every attempt recorded', async () => {
  const { result, hits } = await verify(['HTTP_502', { error: { code: 3, message: 'execution reverted', data: DATA } }], 3);
  assert.deepEqual([result.verdict, hits.calls, result.attempts.map(a => a.kind)], ['PASS', 2, ['TRANSPORT_ERROR', 'EXPECTED_REVERT']]);
  assert.doesNotMatch(show(result.attempts), /127\.0\.0\.1/, 'diagnostics never carry the RPC URL');
});

test('classification is by decoded bytes only: a non-error object or calldata never counts', () => {
  // A plain Error whose message contains the full revert bytes has no structured data.
  assert.equal(classifyRevert(new Error(`reverted with ${DATA}`), NOT_HOLDER).kind, 'NO_REVERT_DATA');
  // Calldata in a request body is not revert data.
  assert.equal(classifyRevert(Object.assign(new Error('x'), { body: { params: [{ data: DATA }] } }), NOT_HOLDER).kind, 'NO_REVERT_DATA');
  assert.equal(classifyRevert(Object.assign(new Error('x'), { data: DATA }), NOT_HOLDER).kind, 'EXPECTED_REVERT');
});

test('a real Anvil node: an actual custom-error revert is verified from its structured data', async () => {
  const node = await startAnvil(18548, ['--chain-id', '31337', '--silent']);
  try {
    const rpc = createPublicClient({ transport: http(node.url) });
    const [deployer, stranger] = await rpc.request({ method: 'eth_accounts' } as never) as Address[];
    const receiptAbi = tapeoutEntitlementReceiptAbi as Abi;
    const hash = await rpc.request({ method: 'eth_sendTransaction', params: [{ from: deployer, data: encodeDeployData({ abi: receiptAbi, bytecode: bytecode.TapeoutEntitlementReceipt.bytecode as Hex,
      args: [keccak256(stringToHex('TAPEOUT_NAND_ENTITLEMENT')), 'N', 'N', '', deployer] }) }] } as never) as Hex;
    const receipt = (await rpc.waitForTransactionReceipt({ hash })).contractAddress!;
    const issue = encodeFunctionData({ abi: receiptAbi, functionName: 'issue', args: [stranger, 1n] });
    const expected: ExpectedError = { abi: receiptAbi, name: 'OwnableUnauthorizedAccount', args: [stranger] };
    const ok = await verifyExpectedRevert({ rpc, from: stranger, to: receipt, data: issue, expected });
    assert.deepEqual([ok.verdict, ok.kind], ['PASS', 'EXPECTED_REVERT'], show(ok));
    const wrongArgs = await verifyExpectedRevert({ rpc, from: stranger, to: receipt, data: issue, expected: { ...expected, args: [deployer] } });
    assert.deepEqual([wrongArgs.verdict, wrongArgs.kind], ['FAIL', 'WRONG_ARGUMENTS']);
    const unexpected = await verifyExpectedRevert({ rpc, from: deployer, to: receipt, data: issue, expected });
    assert.deepEqual([unexpected.verdict, unexpected.kind], ['FAIL', 'UNEXPECTED_SUCCESS']);
  } finally {
    await node.stop();
  }
});
