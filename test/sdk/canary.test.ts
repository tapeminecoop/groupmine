import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { budget, Runner, type Manifest } from '../../scripts/canary/transactions.ts';
import { artifact, journal, verifyRuntime } from '../../scripts/canary/common.ts';

test('normal fee spending preserves reserve; recovery uses its approved portion, never exceeds total', () => {
  budget(10n, 50n, 100n, 40n, false);
  assert.throws(() => budget(10n, 51n, 100n, 40n, false), /reserve/);
  budget(60n, 40n, 100n, 40n, true);
  assert.throws(() => budget(60n, 41n, 100n, 40n, true), /budget/);
});
test('canary is exactly the exhaustive patch of unchanged production accounting', () => {
  execFileSync(process.execPath, ['scripts/canary/build-source.mjs', '--check']);
  const source = readFileSync('src/canary/RecoverableTapeoutMinerPool.sol', 'utf8');
  const emergency = source.slice(source.indexOf('function emergencyReturn('), source.indexOf('    // Internals\n', source.indexOf('function emergencyReturn(')));
  assert.doesNotMatch(emergency, /mining\.|bem\.|_sync\(|_pay\(|_harvest/);
  assert.doesNotMatch(emergency, /address (to|destination)/);
});
test('runtime identity rejects modified production receipt bytecode', () => {
  const code = artifact('nand').deployedBytecode.object;
  assert.equal(verifyRuntime('nand', code).immutableTemplateMatched, true);
  assert.throws(() => verifyRuntime('nand', `0xff${code.slice(4)}`), /mismatch/);
});
test('unknown transaction hash blocks journal retry instead of sending again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-journal-'));
  journal(`${dir}/journal.jsonl`, { stage: 'SIGNED_HASH', action: 'deposit', hash: `0x${'1'.repeat(64)}` });
  const m = { dir } as Manifest;
  const r = new Runner(m, { getTransactionReceipt: async () => { throw Error('not found'); } } as any);
  await assert.rejects(r.reconcileJournal(), /UNKNOWN_OR_PENDING/);
});
