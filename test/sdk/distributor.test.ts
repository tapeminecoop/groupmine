import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { decodeDeployData, decodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { historicalDistributorAbi } from '../../sdk/abi.ts';
import bytecode from '../../sdk/bytecode.json' with { type: 'json' };
import {
  MAX_CONTRIBUTORS, MAX_INITCODE_SIZE, buildContributorList, contributorsHash, distributorClaimPlans, distributorClaimRangePlans, distributorDeployPlan,
  distributorEncodedArgs, distributorReleasePlan, distributorSplit, weightsFileSchema, type WeightsFile,
} from '../../sdk/distributor.ts';
import { main } from '../../cli/pool.ts';
import example from '../../deployments/examples/historical-nand.example.json' with { type: 'json' };

const POOL = '0x00000000000000000000000000000000000000aa' as Address;
const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';
const C = '0x00000000000000000000000000000000000000c3';
const file = (contributors: WeightsFile['contributors'], extra: Partial<WeightsFile> = {}): WeightsFile =>
  weightsFileSchema.parse({ category: 'NAND', contributors, ...extra });

test('contributors are sorted by address and hashed like the contract (cast cross-check)', () => {
  const list = buildContributorList(file([{ account: C, weight: 3 }, { account: A, weight: '1' }, { account: B, weight: 2, ref: 'b' }]));
  assert.deepEqual(list.contributors.map(c => c.account), [A, B, C].map(a => getAddress(a)));
  assert.deepEqual(list.contributors.map(c => c.weight), [1n, 2n, 3n]);
  assert.deepEqual(list.contributors.map(c => c.index), [0, 1, 2]);
  assert.equal(list.contributors[1].ref, 'b');
  assert.equal(list.totalWeight, 6n);
  const encoded = execFileSync('cast', ['abi-encode', 'f(address[],uint96[])', `[${[A, B, C].join(',')}]`, '[1,2,3]'], { encoding: 'utf8' }).trim();
  assert.equal(list.contributorsHash, execFileSync('cast', ['keccak', encoded], { encoding: 'utf8' }).trim());
  // Sorting is numeric, not by input order or checksum casing.
  const reversed = buildContributorList(file([{ account: B.toUpperCase().replace('0X', '0x'), weight: 2 }, { account: A, weight: 1 }]));
  assert.deepEqual(reversed.contributors.map(c => c.account), [A, B].map(a => getAddress(a)));
});

test('weights file errors: duplicates, zero address, bad checksum, weight range, checksum total, size, shape', () => {
  assert.throws(() => buildContributorList(file([{ account: A, weight: 1 }, { account: A.toUpperCase().replace('0X', '0x'), weight: 2 }])), /already listed at contributors\[0\]/);
  assert.throws(() => buildContributorList(file([{ account: '0x0000000000000000000000000000000000000000', weight: 1 }])), /zero address/);
  assert.throws(() => buildContributorList(file([{ account: '0x00000000000000000000000000000000000000Ab', weight: 1 }])), /invalid EIP-55 checksum/);
  assert.throws(() => buildContributorList(file([{ account: A, weight: (2n ** 96n).toString() }])), /exceeds uint96/);
  assert.equal(buildContributorList(file([{ account: A, weight: (2n ** 96n - 1n).toString() }])).totalWeight, 2n ** 96n - 1n);
  assert.throws(() => buildContributorList(file([{ account: A, weight: 1 }, { account: B, weight: 2 }], { totalWeight: 4 })), /totalWeight checksum 4 does not match .* 3/);
  assert.equal(buildContributorList(file([{ account: A, weight: 1 }, { account: B, weight: 2 }], { totalWeight: '3' })).totalWeight, 3n);
  assert.throws(() => buildContributorList(file([{ account: POOL, weight: 1 }]), [POOL]), /cannot be a contributor/);
  for (const weight of [0, -1, 1.5, '0', '01', '1e3', '']) assert.throws(() => file([{ account: A, weight: weight as never }]));
  assert.throws(() => file([]));
  const tooMany = Array.from({ length: MAX_CONTRIBUTORS + 1 }, (_, i) => ({ account: `0x${(i + 1).toString(16).padStart(40, '0')}`, weight: 1 }));
  assert.throws(() => file(tooMany));
  assert.equal(buildContributorList(file(tooMany.slice(0, MAX_CONTRIBUTORS))).contributors.length, MAX_CONTRIBUTORS);
  assert.throws(() => buildContributorList({ category: 'NAND', contributors: tooMany }), /nest distributors/);
  assert.throws(() => weightsFileSchema.parse({ category: 'BOTH', contributors: [{ account: A, weight: 1 }] }));
  assert.throws(() => weightsFileSchema.parse({ category: 'NAND', contributors: [{ account: A, weight: 1, extra: true }] }));
  assert.throws(() => weightsFileSchema.parse({ category: 'NAND', contributors: [{ account: A, weight: 1 }], unexpected: 1 }));
});

test('split mirrors the Solidity vectors: exact floors, bounded residue', () => {
  const s = distributorSplit(80n * 10n ** 8n, [50n, 30n, 20n]);
  assert.deepEqual(s.entitlements, [40n * 10n ** 8n, 24n * 10n ** 8n, 16n * 10n ** 8n]);
  assert.equal(s.residue, 0n);
  const thirds = distributorSplit(100n, [1n, 1n, 1n]);
  assert.deepEqual([thirds.entitlements, thirds.residue], [[33n, 33n, 33n], 1n]);
  assert.deepEqual(distributorSplit(102n, [1n, 1n, 1n]).entitlements, [34n, 34n, 34n]);
  const big = 2n ** 96n - 1n;
  const huge = distributorSplit(1_000_000_007n, [big, big, 1n]);
  assert.deepEqual(huge.entitlements, [500_000_003n, 500_000_003n, 0n]);
  assert.equal(huge.residue, 1n);
  assert.throws(() => distributorSplit(-1n, [1n]));
});

test('split conservation, residue bound and monotonicity over random inputs', () => {
  let seed = 987654321n;
  const rand = (max: bigint) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n; return seed % max; };
  for (let i = 0; i < 2000; i++) {
    const n = Number(rand(20n)) + 1;
    const weights = Array.from({ length: n }, () => (rand(2n) === 0n ? rand(1000n) : rand(2n ** 64n) * rand(2n ** 32n)) + 1n);
    const total = rand(10n ** 18n);
    const a = distributorSplit(total, weights);
    assert.equal(a.entitled + a.residue, total);
    assert.ok(a.residue >= 0n && a.residue <= BigInt(n - 1));
    const b = distributorSplit(total + rand(10n ** 9n), weights);
    assert.ok(b.entitlements.every((e, k) => e >= a.entitlements[k]));
  }
});

test('plans encode the constructor and claim calls', () => {
  const list = buildContributorList(weightsFileSchema.parse(example));
  const deploy = distributorDeployPlan(POOL, list);
  assert.equal(deploy.to, null);
  const decoded = decodeDeployData({ abi: historicalDistributorAbi, bytecode: bytecode.HistoricalDistributor.bytecode as Hex, data: deploy.data });
  assert.deepEqual(decoded.args, [getAddress(POOL), 0, list.contributors.map(c => c.account), list.contributors.map(c => c.weight)]);
  assert.equal(`${bytecode.HistoricalDistributor.bytecode}${distributorEncodedArgs(POOL, list).slice(2)}`, deploy.data);
  assert.equal(contributorsHash(list.contributors.map(c => c.account), list.contributors.map(c => c.weight)), list.contributorsHash);
  // EIP-3860: a full list fits the initcode limit; anything that would not is refused before signing.
  const full = buildContributorList(file(Array.from({ length: MAX_CONTRIBUTORS }, (_, i) => ({ account: `0x${(0xff00n * 2n ** 144n + BigInt(i + 1)).toString(16).padStart(40, '0')}`, weight: '79228162514264337593543950335' }))));
  assert.ok((distributorDeployPlan(POOL, full).data.length - 2) / 2 <= MAX_INITCODE_SIZE);
  const oversized = { ...full, contributors: Array.from({ length: 700 }, (_, index) => ({ ...full.contributors[0], index })) };
  assert.throws(() => distributorDeployPlan(POOL, oversized), /EIP-3860 initcode limit/);

  const distributor = '0x00000000000000000000000000000000000000dd' as Address;
  const ranges = distributorClaimRangePlans(distributor, 250, 100);
  assert.equal(ranges.length, 3);
  assert.deepEqual(decodeFunctionData({ abi: historicalDistributorAbi, data: ranges[2].data }).args, [200n, 100n]);
  const listed = distributorClaimPlans(distributor, [A, B, C].map(a => getAddress(a)), 2);
  assert.equal(decodeFunctionData({ abi: historicalDistributorAbi, data: listed[0].data }).functionName, 'claimBatch');
  assert.deepEqual(decodeFunctionData({ abi: historicalDistributorAbi, data: listed[1].data }), { functionName: 'claim', args: [getAddress(C)] });
  assert.equal(decodeFunctionData({ abi: historicalDistributorAbi, data: distributorReleasePlan(distributor).data }).functionName, 'releaseFromPool');
});

test('CLI distributor-check validates the example file and prints the deployment arguments', async () => {
  const result = await main(['distributor-check', '--weights', 'deployments/examples/historical-nand.example.json', '--income', '80', '--pool', POOL]) as Record<string, any>;
  assert.equal(result.status, 'WEIGHTS_VALID');
  assert.equal(result.totalWeight, 100n);
  assert.deepEqual(result.contributors.map((c: { amountBem: string }) => c.amountBem), ['40.00000000', '24.00000000', '16.00000000']);
  assert.equal(result.preview.residueRaw, 0n);
  assert.equal(result.constructorArgs.pool, getAddress(POOL));
  assert.equal(result.constructorArgs.category, 0);
  assert.match(result.constructorArgs.encodedConstructorArgs, /^0x[0-9a-f]+$/);
  const noPool = await main(['distributor-check', '--weights', 'deployments/examples/historical-nand.example.json']) as Record<string, any>;
  assert.equal(noPool.constructorArgs.pool, undefined);
  assert.equal(noPool.contributorsHash, result.contributorsHash);
  await assert.rejects(main(['distributor-check', '--weights', 'deployments/examples/historical-nand.example.json', '--pool', example.contributors[0].account]), /cannot be a contributor/);
});
