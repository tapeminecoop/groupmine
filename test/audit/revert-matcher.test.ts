/**
 * Internal security review (f2c8e50), workstream D. Reproduces, against viem 2.57.2 and local servers
 * only, the RPC error shapes a negative test can meet, and shows which of them the frozen canary
 * matcher (error-message text search) misjudges and how the proposed structured matcher decides.
 * Run: node --import tsx --test test/audit/revert-matcher.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createPublicClient, encodeAbiParameters, http, type Hex } from 'viem';
import { classifyNegative, frozenRunnerDecision, selectorOf } from './revert-matcher.ts';
import { startAnvil } from '../../scripts/lib/anvil.ts';

const EXPECTED = 'NotHolder(uint8,uint256)';
const SELECTOR = selectorOf(EXPECTED); // 0x794e61c9, as recorded in the mainnet results.json
const ARGS = encodeAbiParameters([{ type: 'uint8' }, { type: 'uint256' }], [0, 1n]).slice(2);
const REVERT_DATA = `${SELECTOR}${ARGS}` as Hex;
const OTHER_DATA = `${selectorOf('CanaryClosed()')}` as Hex;
const TARGET = '0x5904d00d2990c8734051b5d0e7aaeba636dc591e' as const;
const CALLDATA = '0xdbc7d8fd00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001' as Hex;

type Reply = { result?: unknown; error?: unknown } | 'TRANSPORT';
const servers: Server[] = [];
after(() => servers.forEach(s => s.close()));

function rpcServer(reply: Reply): Promise<string> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        if (reply === 'TRANSPORT') { res.writeHead(502); res.end('bad gateway'); return; }
        const id = JSON.parse(body).id;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, ...reply }));
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
}

async function simulate(url: string): Promise<unknown> {
  const rpc = createPublicClient({ transport: http(url, { retryCount: 0, timeout: 5_000 }) });
  try {
    await rpc.call({ account: '0x7eEDccb674e9549b61B01Eb65aC68DA071ADF129', to: TARGET, data: CALLDATA });
    return undefined;
  } catch (e) {
    return e;
  }
}

const shapes: { name: string; reply: Reply; frozen: boolean; proposed: string }[] = [
  // The commercial RPC's shape on the mainnet run: generic message, bytes in structured `data`.
  { name: 'structured data, generic message (mainnet RPC)', reply: { error: { code: 3, message: 'execution reverted', data: REVERT_DATA } }, frozen: false, proposed: 'EXPECTED_REVERT' },
  { name: 'structured data nested one level deeper', reply: { error: { code: 3, message: 'execution reverted', data: { data: REVERT_DATA } } }, frozen: false, proposed: 'EXPECTED_REVERT' },
  { name: 'bytes in the message text only (Anvil-like)', reply: { error: { code: -32603, message: `execution reverted: custom error ${SELECTOR}: ${ARGS}` } }, frozen: true, proposed: 'EXPECTED_REVERT' },
  { name: 'reverted, no bytes anywhere', reply: { error: { code: 3, message: 'execution reverted' } }, frozen: false, proposed: 'REVERT_UNVERIFIABLE' },
  { name: 'reverted with another selector', reply: { error: { code: 3, message: 'execution reverted', data: OTHER_DATA } }, frozen: false, proposed: 'UNEXPECTED_REVERT' },
  { name: 'transport failure (HTTP 502)', reply: 'TRANSPORT', frozen: false, proposed: 'TRANSPORT_OR_OTHER_ERROR' },
  { name: 'call succeeds (no revert at all)', reply: { result: '0x' }, frozen: false, proposed: 'DID_NOT_REVERT' },
];

for (const shape of shapes) {
  test(`shape: ${shape.name}`, async () => {
    const error = await simulate(await rpcServer(shape.reply));
    assert.equal(frozenRunnerDecision(error, EXPECTED), shape.frozen, 'frozen runner decision');
    const outcome = classifyNegative(error, EXPECTED);
    assert.equal(outcome.kind, shape.proposed, JSON.stringify(outcome));
  });
}

test('the frozen matcher is a false negative exactly on the structured shapes: it never passes an unexpected outcome', async () => {
  const falseNegatives = shapes.filter(s => s.proposed === 'EXPECTED_REVERT' && !s.frozen).map(s => s.name);
  assert.deepEqual(falseNegatives, ['structured data, generic message (mainnet RPC)', 'structured data nested one level deeper']);
  assert.ok(shapes.filter(s => s.proposed !== 'EXPECTED_REVERT').every(s => !s.frozen), 'frozen matcher must stay fail-closed');
});

test('real Anvil: a custom-error revert is matched by both; the rehearsal passed because Anvil writes the bytes into the message', async () => {
  const node = await startAnvil(18599, ['--silent']);
  try {
    const rpc = createPublicClient({ transport: http(node.url, { retryCount: 0 }) });
    // Runtime code that always reverts with NotHolder(0, 1): mstore the 68-byte payload, revert(0, 68).
    const w = (hex: string) => hex.padEnd(64, '0');
    const payload = REVERT_DATA.slice(2);
    const code = `0x7f${w(payload.slice(0, 64))}6000527f${w(payload.slice(64, 128))}6020527f${w(payload.slice(128, 136))}60405260446000fd` as Hex;
    await rpc.request({ method: 'anvil_setCode', params: [TARGET, code] } as never);
    const error = await simulate(node.url);
    assert.ok(error instanceof Error);
    assert.equal(frozenRunnerDecision(error, EXPECTED), true);
    const outcome = classifyNegative(error, EXPECTED);
    assert.equal(outcome.kind, 'EXPECTED_REVERT', JSON.stringify(outcome));
    assert.equal((outcome as { data: Hex }).data.toLowerCase(), REVERT_DATA.toLowerCase());
  } finally {
    await node.stop();
  }
});
