import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { decodeFunctionData, zeroAddress } from 'viem';
import { activationProblems, configHash, poolFileSchema, toConfig, type PoolConfig } from '../../sdk/config.ts';
import { tapeoutMinerPoolAbi } from '../../sdk/abi.ts';
import { castCommand, safeBatch } from '../../sdk/tx.ts';
import { claimPlans, configurePlan, deployPlan, harvestRangePlans } from '../../sdk/pool.ts';
import { toDeployment } from '../../sdk/config.ts';
import example from '../../deployments/examples/pool.bsc.example.json' with { type: 'json' };

test('config hash equals keccak256(abi.encode(Config)) as computed by cast', () => {
  const c = toConfig(poolFileSchema.parse(example));
  const encoded = execFileSync('cast', ['abi-encode', 'f((uint64,uint64,uint64,uint64,uint32,address,address,address))',
    `(${c.nandShares},${c.latchShares},${c.historicalNandShares},${c.historicalLatchShares},${c.nandWeight},${c.feeRecipient},${c.historicalNandRecipient},${c.historicalLatchRecipient})`], { encoding: 'utf8' }).trim();
  const expected = execFileSync('cast', ['keccak', encoded], { encoding: 'utf8' }).trim();
  assert.equal(configHash(c), expected);
});

test('activation preflight mirrors the contract checks', () => {
  const base: PoolConfig = toConfig(poolFileSchema.parse(example));
  assert.deepEqual(activationProblems(base), []);
  assert.match(activationProblems({ ...base, feeRecipient: zeroAddress }).join(), /fee recipient/);
  assert.match(activationProblems({ ...base, historicalNandRecipient: zeroAddress }).join(), /historical NAND/);
  assert.match(activationProblems({ ...base, latchShares: 0n, historicalLatchShares: 0n }).join(), /LATCH has weight/);
  assert.deepEqual(activationProblems({ ...base, latchShares: 0n, historicalLatchShares: 0n, nandWeight: 100_000_000 }), []);
  assert.throws(() => poolFileSchema.parse({ ...example, unexpected: 1 }));
  assert.throws(() => toConfig(poolFileSchema.parse({ ...example, economics: { ...example.economics, nandWeight: '1.5' } })));
});

test('plans encode the intended calls and export to Safe / cast formats', () => {
  const file = poolFileSchema.parse(example);
  const pool = '0x00000000000000000000000000000000000000aa';
  const configure = configurePlan(pool, toConfig(file));
  const decoded = decodeFunctionData({ abi: tapeoutMinerPoolAbi, data: configure.data });
  assert.equal(decoded.functionName, 'configure');
  const claims = claimPlans(pool, [1n, 2n, 3n], [1n], 2);
  assert.equal(claims.length, 2);
  assert.deepEqual(decodeFunctionData({ abi: tapeoutMinerPoolAbi, data: claims[1].data }).args, [[3n], [1n]]);
  assert.equal(harvestRangePlans(pool, 51n, 25).length, 3);
  const batch = safeBatch([configure], 56, 'test');
  assert.equal(batch.chainId, '56');
  assert.equal(batch.transactions[0].data, configure.data);
  assert.throws(() => safeBatch([deployPlan(toDeployment(file))], 56, 'deploy'), /Contract creation/);
  assert.match(castCommand(configure), /^cast send --rpc-url "\$RPC_URL" <SIGNER_FLAGS> 0x0+aa 0x/);
});
