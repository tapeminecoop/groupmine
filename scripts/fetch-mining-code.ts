#!/usr/bin/env node
/**
 * Read-only: fetches, at a pinned block, the Mining proxy's code, its ERC-1967 implementation and the
 * external library that implementation delegate-calls, plus the owner and initializer words, and writes
 * them with hashes for the static analysis in scripts/mining-analysis/ (eth_getStorageAt, eth_getCode,
 * eth_getBlockByNumber only).
 *   node --import tsx scripts/fetch-mining-code.ts [block] [outDir]
 * Defaults: block 128,713,128 (the fork suite's pinned block), outDir reports/mining-code.
 * Env: RPC_URL (archive; default the public blastapi endpoint).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createPublicClient, getAddress, http, keccak256, type Hex } from 'viem';
import { BSC_PROTOCOL } from '../sdk/constants.ts';

const url = process.env.RPC_URL ?? 'https://bsc-mainnet.public.blastapi.io';
const rpc = createPublicClient({ transport: http(url, { timeout: 60_000, retryCount: 6, retryDelay: 3000 }) });
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
// OpenZeppelin 5 namespaced storage (ERC-7201): OwnableUpgradeable's owner, Initializable's version and flag.
const OWNER_SLOT = '0x9016d09d72d40fdae2fd8ceac6b6234c7706214fd39c1cd1e609a0528c199300';
const INITIALIZABLE_SLOT = '0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00';
const block = BigInt(process.argv[2] ?? 128_713_128);
const outDir = process.argv[3] ?? 'reports/mining-code';

const pinned = await rpc.getBlock({ blockNumber: block });
const slot = await rpc.getStorageAt({ address: BSC_PROTOCOL.mining, slot: IMPLEMENTATION_SLOT, blockNumber: block });
const implementation = getAddress(`0x${(slot ?? '0x').slice(-40)}`);
const implementationCode = await rpc.getCode({ address: implementation, blockNumber: block });
if (!implementationCode || implementationCode === '0x') throw new Error('no implementation code');
// PUSH20 <address> GAS DELEGATECALL: the linked library (the implementation's only hard-coded delegate target).
const libraries = [...new Set([...implementationCode.slice(2).matchAll(/73([0-9a-f]{40})5af4/g)].map(m => getAddress(`0x${m[1]}`)))];
if (libraries.length !== 1) throw new Error(`expected one linked library, found ${libraries.length}`);
const library = libraries[0];
const libraryCode = await rpc.getCode({ address: library, blockNumber: block });
if (!libraryCode || libraryCode === '0x') throw new Error('no library code');
const proxyCode = await rpc.getCode({ address: BSC_PROTOCOL.mining, blockNumber: block });
if (!proxyCode || proxyCode === '0x') throw new Error('no proxy code');
const ownerWord = (await rpc.getStorageAt({ address: BSC_PROTOCOL.mining, slot: OWNER_SLOT, blockNumber: block })) ?? '0x0';
const initializableWord = (await rpc.getStorageAt({ address: BSC_PROTOCOL.mining, slot: INITIALIZABLE_SLOT, blockNumber: block })) ?? '0x0';

await mkdir(outDir, { recursive: true });
await writeFile(`${outDir}/implementation.hex`, `${implementationCode}\n`);
await writeFile(`${outDir}/library.hex`, `${libraryCode}\n`);
await writeFile(`${outDir}/proxy.hex`, `${proxyCode}\n`);
const manifest = {
  readOnly: true, chainId: 56, block, blockHash: pinned.hash, rpcHost: new URL(url).host, proxy: BSC_PROTOCOL.mining,
  implementation: { address: implementation, bytes: (implementationCode.length - 2) / 2, keccak256: keccak256(implementationCode as Hex), file: 'implementation.hex' },
  library: { address: library, bytes: (libraryCode.length - 2) / 2, keccak256: keccak256(libraryCode as Hex), file: 'library.hex' },
  proxyCode: { bytes: (proxyCode.length - 2) / 2, keccak256: keccak256(proxyCode as Hex), file: 'proxy.hex' },
  storage: { ownerSlot: OWNER_SLOT, owner: getAddress(`0x${ownerWord.slice(-40).padStart(40, '0')}`), initializableSlot: INITIALIZABLE_SLOT, initializableWord },
};
await writeFile(`${outDir}/manifest.json`, `${JSON.stringify(manifest, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
console.log(JSON.stringify(manifest, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
