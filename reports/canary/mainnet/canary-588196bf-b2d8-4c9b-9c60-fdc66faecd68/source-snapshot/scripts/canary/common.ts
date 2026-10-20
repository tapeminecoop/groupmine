import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createPublicClient, http, keccak256, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { BSC_PROTOCOL, BSC_IDENTITY, ERC1967_IMPLEMENTATION_SLOT, ERC1967_BEACON_SLOT, beaconAbi, erc20Abi, miningAbi } from '../../sdk/constants.ts';

export const ROOT = process.cwd();
export const BASE = 'c4bc022c76c5de528a98caa58974ee5772f80d4a';
export const IDS = [3204n, 12485n] as const;
export const P = BSC_PROTOCOL;
export const json = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2) + '\n';
export const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export function save(path: string, v: unknown) {
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeFileSync(fd, json(v)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}
export function journal(path: string, v: unknown) {
  const fd = openSync(path, 'a', 0o600);
  try { appendFileSync(fd, JSON.stringify({ at: new Date().toISOString(), ...v as object }, (_, x) => typeof x === 'bigint' ? x.toString() : x) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
}
export function env() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  if (process.env.EXPECTED_CHAIN_ID && process.env.EXPECTED_CHAIN_ID !== '56') throw Error('EXPECTED_CHAIN_ID must be 56');
  return process.env;
}
export function redact(e: unknown) {
  let s = e instanceof Error ? e.message : String(e);
  for (const name of ['OWNER_PRIVATE_KEY', 'BSC_RPC_URL']) if (process.env[name]) s = s.replaceAll(process.env[name]!, '[REDACTED]');
  return s.replace(/https?:\/\/[^\s"'<>]+/g, '[REDACTED_RPC]').slice(0, 3000);
}
export function ownerFromEnv(): Address {
  const key = process.env.OWNER_PRIVATE_KEY;
  if (!key || !/^0x[\da-fA-F]{64}$/.test(key)) throw Error('Configure OWNER_PRIVATE_KEY in this project .env (never paste it into chat)');
  return privateKeyToAccount(key as Hex).address;
}
export function remote() {
  if (!process.env.BSC_RPC_URL) throw Error('Configure BSC_RPC_URL in this project .env');
  return createPublicClient({ transport: http(process.env.BSC_RPC_URL, { timeout: 30_000, retryCount: 1 }) });
}
export const artifacts = {
  nand: 'TapeoutEntitlementReceipt', latch: 'TapeoutEntitlementReceipt', helper: 'CanaryParticipant', pool: 'RecoverableTapeoutMinerPool', distributor: 'TapeoutReceiptDistributor',
} as const;
export type ContractName = keyof typeof artifacts;
export function artifact(name: ContractName) {
  const n = artifacts[name];
  return JSON.parse(readFileSync(`out/${n}.sol/${n}.json`, 'utf8')) as { abi: Abi; bytecode: { object: Hex }; deployedBytecode: { object: Hex; immutableReferences?: Record<string, { start: number; length: number }[]> }; metadata: unknown };
}
export function fingerprint() {
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'sdk', 'scripts/canary', 'test/unit/CanaryRecovery.t.sol', 'test/sdk/canary.test.ts', 'foundry.toml', 'package.json', 'package-lock.json', '.env.example', 'docs/CANARY_RUNBOOK.md'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
  const files = Object.fromEntries([...new Set(paths)].map(p => [p, hash(readFileSync(p))]));
  const build = Object.fromEntries(Object.keys(artifacts).map(k => [k, hash(readFileSync(`out/${artifacts[k as ContractName]}.sol/${artifacts[k as ContractName]}.json`))]));
  const data = { baseRevision: BASE, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), files, build, settings: { solc: '0.8.24', evm: 'paris', viaIR: true, optimizerRuns: 200 } };
  if (data.head !== BASE) throw Error('Source HEAD differs from reviewed baseline; review explicitly before updating BASE');
  return { ...data, digest: hash(json(data)) };
}
export function verifyRuntime(name: ContractName, code: Hex, savedArtifact = artifact(name)) {
  const a = savedArtifact.deployedBytecode;
  if (code.length !== a.object.length) throw Error(`Runtime size mismatch: ${name}`);
  const mask = (input: string) => {
    const chars = [...input.slice(2)];
    for (const ranges of Object.values(a.immutableReferences ?? {})) for (const r of ranges) chars.fill('0', r.start * 2, (r.start + r.length) * 2);
    return chars.join('');
  };
  if (mask(code) !== mask(a.object)) throw Error(`Runtime mismatch: ${name}`);
  return { codeHash: keccak256(code), bytes: (code.length - 2) / 2, immutableTemplateMatched: true };
}
export const nftAbi = [
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getApproved', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'isApprovedForAll', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'bool' }] },
] as const;
export async function preflight(rpc: ReturnType<typeof remote>, owner: Address, expectedOwners: Partial<Record<string, Address>> = {}) {
  const chainId = await rpc.getChainId();
  if (chainId !== 56) throw Error('Wrong network');
  const b = await rpc.getBlock({ blockTag: 'latest' });
  const at = { blockNumber: b.number };
  const read = (address: Address, abi: Abi, functionName: string, args: unknown[] = []) => rpc.readContract({ address, abi, functionName, args, ...at } as never) as Promise<any>;
  const implSlot = await rpc.getStorageAt({ address: P.mining, slot: ERC1967_IMPLEMENTATION_SLOT, ...at });
  const beaconSlot = await rpc.getStorageAt({ address: P.minerCollection, slot: ERC1967_BEACON_SLOT, ...at });
  const impl = `0x${implSlot!.slice(26)}` as Address;
  const beacon = `0x${beaconSlot!.slice(26)}` as Address;
  const collectionImpl = await read(beacon, beaconAbi, 'implementation');
  const implCode = await rpc.getCode({ address: impl, ...at });
  const checks = {
    miningImplementation: impl.toLowerCase() === BSC_IDENTITY.miningImplementation.toLowerCase(),
    miningCode: !!implCode && keccak256(implCode) === BSC_IDENTITY.miningImplementationCodeHash,
    beacon: beacon.toLowerCase() === BSC_IDENTITY.collectionBeacon.toLowerCase(),
    collectionImplementation: collectionImpl.toLowerCase() === BSC_IDENTITY.collectionImplementation.toLowerCase(),
    bemDecimals: await read(P.bem, erc20Abi, 'decimals') === 8,
    ownerIsEOA: !await rpc.getCode({ address: owner, ...at }) || await rpc.getCode({ address: owner, ...at }) === '0x',
  };
  const protocol = {} as Record<string, unknown>;
  for (const [label, address] of Object.entries(P)) {
    const code = await rpc.getCode({ address, ...at });
    if (!code || code === '0x') throw Error(`Missing protocol code: ${label}`);
    protocol[label] = { address, codeHash: keccak256(code) };
  }
  const expectedCode = {
    bem: '0x982ba79538b51e54ee1382f57522098af0635b0f67f2574d393b29ed0958b344',
    mining: '0xed6b710a769987f50494d713f278817992e3266e45898a990be878efc2fcbbce',
    minerCollection: '0xd8c4b0216e0aadd615fbd134465b6af060a11769edc7c844d8f14d1b8a783992',
  };
  for (const [label, expected] of Object.entries(expectedCode)) checks[`${label}Runtime` as keyof typeof checks] = (protocol[label] as { codeHash: string }).codeHash === expected;
  const collectionCode = await rpc.getCode({ address: collectionImpl, ...at });
  checks['collectionImplementationCode' as keyof typeof checks] = !!collectionCode && keccak256(collectionCode) === '0x2ea433839e23b3773b7880d6f1807affb0f648ae98760b9a3b6394879665c345';
  const miners = [];
  const burnAbi = [{ type: 'function', name: 'circuitBurn', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint32' }, { type: 'uint32' }] }] as const;
  for (const [i, id] of IDS.entries()) {
    const key = await read(P.mining, miningAbi, 'minerKey', [P.minerCollection, id]);
    const record = await read(P.mining, miningAbi, 'getMiner', [key]);
    const cached = await read(P.mining, miningAbi, 'cachedBurn', [P.minerCollection, id]);
    const burn = await read(P.mining, burnAbi, 'circuitBurn', [P.minerCollection, id]);
    const holder = await read(P.minerCollection, nftAbi, 'ownerOf', [id]);
    const expected = i === 0 ? [2, 0] : [1, 1];
    checks[`miner${id}` as keyof typeof checks] = holder.toLowerCase() === (expectedOwners[String(id)] ?? owner).toLowerCase() && record.status === 1 && record.circuits.toLowerCase() === P.minerCollection.toLowerCase() && BigInt(record.circuitId) === id && record.nandBurn === expected[0] && record.latchBurn === expected[1] && cached[0] && cached[1] === expected[0] && cached[2] === expected[1] && burn[0] === expected[0] && burn[1] === expected[1];
    miners.push({ id, key, owner: holder, record, cachedBurn: cached, circuitBurn: burn, pendingRaw: await read(P.mining, miningAbi, 'pending', [key]), approved: await read(P.minerCollection, nftAbi, 'getApproved', [id]) });
  }
  const result = { scope: 'READ_ONLY_BSC_SNAPSHOT', chainId, block: b.number, blockHash: b.hash, timestamp: b.timestamp, owner, checks, protocol, miningImplementation: impl, collectionImplementation: collectionImpl, miners, bnbRaw: await rpc.getBalance({ address: owner, ...at }), bemRaw: await read(P.bem, erc20Abi, 'balanceOf', [owner]), bemDecimals: 8, warning: 'pending is an observation, not a promise of claim payout' };
  if (!Object.values(checks).every(Boolean)) throw Error(`PRECONDITION_MISMATCH: ${json(result)}`);
  return result;
}
