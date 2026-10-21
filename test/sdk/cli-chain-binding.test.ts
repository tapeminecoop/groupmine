/**
 * Follow-up review finding GPT T-210-01: offline receipt-deployment plans keep the chain the reviewed
 * system file names. The offline cases run the actual CLI entry point as a child process whose environment
 * holds only PATH and HOME (no RPC_URL); the online cases run it against loopback Anvil nodes.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main as cli } from '../../cli/pool.ts';
import { startAnvil } from '../../scripts/lib/anvil.ts';
import example from '../../deployments/examples/system.bsc.example.json' with { type: 'json' };

type Plan = { cast: string; to: string | null };
type Result = { mode: string; chainId?: number; chainSource?: string; chainNote?: string; context?: { kind: string }; plans: Plan[] };

const dir = mkdtempSync(join(tmpdir(), 'cli-chain-binding-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const systemFile = (chainId: number) => {
  const file = join(dir, `system-${chainId}.json`);
  writeFileSync(file, JSON.stringify({ ...example, chainId }));
  return file;
};

/** The CLI entry point with a scrubbed environment: no RPC_URL or wallet variable can reach it. */
function offlineCli(argv: string[]) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'cli/pool.ts', ...argv], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } });
  return { status: r.status, result: r.status === 0 ? JSON.parse(r.stdout) as Result : undefined, stderr: r.stderr };
}

test('offline deploy-receipts keeps the configured chain 56: in the output and as --chain 56 in both creation commands', () => {
  const { status, result, stderr } = offlineCli(['deploy-receipts', '--system', systemFile(56)]);
  assert.equal(status, 0, stderr);
  assert.equal(result!.mode, 'PLAN_ONLY_NOT_SENT');
  assert.equal(result!.chainId, 56);
  assert.equal(result!.chainSource, 'CONFIGURED_NOT_RPC_VERIFIED');
  assert.match(result!.chainNote!, /no node was queried/);
  assert.equal(result!.context, undefined, 'no network was queried');
  assert.equal(result!.plans.length, 2);
  for (const p of result!.plans) {
    assert.equal(p.to, null);
    assert.match(p.cast, /^cast send --rpc-url "\$RPC_URL" --chain 56 <SIGNER_FLAGS> --gas-limit \d+ --create 0x[0-9a-f]+$/);
  }
});

test('another configured chain is kept, and no binding leaks from one invocation into the next', async () => {
  const saved = process.env.RPC_URL;
  delete process.env.RPC_URL;
  try {
    const first = await cli(['deploy-receipts', '--system', systemFile(97)]) as Result;
    assert.equal(first.chainId, 97);
    assert.ok(first.plans.every(p => p.cast.includes(' --chain 97 ')));
    // An invocation that binds chain 97 and then fails before planning...
    await assert.rejects(cli(['deploy-receipts', '--system', systemFile(97), '--send-local', '--from', '0x00000000000000000000000000000000000000d1']), /Missing --rpc-url/);
    // ...leaves nothing behind for the next one.
    const second = await cli(['deploy-receipts', '--system', systemFile(56)]) as Result;
    assert.equal(second.chainId, 56);
    assert.ok(second.plans.every(p => p.cast.includes(' --chain 56 ') && !p.cast.includes('--chain 97')));
  } finally {
    if (saved !== undefined) process.env.RPC_URL = saved;
  }
});

test('a node serving another chain is refused before any plan or Safe batch file exists', async () => {
  const node = await startAnvil(18591, ['--chain-id', '31337', '--silent']);
  try {
    const safeJson = join(dir, 'mismatch-safe.json');
    await assert.rejects(cli(['deploy-receipts', '--system', systemFile(56), '--rpc-url', node.url, '--safe-json', safeJson, '--safe', '0x00000000000000000000000000000000000000ab']),
      /serves chain 31337 but the reviewed files name chain 56; refusing to plan/);
    assert.equal(existsSync(safeJson), false);
    await assert.rejects(cli(['deploy-receipts', '--system', systemFile(56), '--rpc-url', node.url]), /refusing to plan/);
  } finally {
    await node.stop();
  }
});

test('a loopback node on the configured chain: the plans name it as the planning node and target it, with --chain', async () => {
  const node = await startAnvil(18592, ['--chain-id', '56', '--silent']);
  try {
    const result = await cli(['deploy-receipts', '--system', systemFile(56), '--rpc-url', node.url]) as Result;
    assert.equal(result.chainId, 56);
    assert.equal(result.chainSource, 'PLANNING_NODE');
    assert.equal(result.chainNote, undefined);
    assert.equal(result.context!.kind, 'LOCAL_DEV_NODE');
    for (const p of result.plans) assert.ok(p.cast.startsWith(`cast send --rpc-url "${node.url}" --chain 56 <SIGNER_FLAGS> `), p.cast);
  } finally {
    await node.stop();
  }
});
