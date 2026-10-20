import { parseAbi, type Address } from 'viem';

export const BSC_CHAIN_ID = 56;

/** Real TapeOut protocol on BSC. Same addresses as the official pod-mainnet config and the
 *  baseline identity review (TapeoutMarket/test1, commit 9d86a26). Re-verify before use. */
export const BSC_PROTOCOL = {
  minerCollection: '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C',
  mining: '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46',
  bem: '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a',
} as const satisfies Record<string, Address>;

/** Identity observations (read-only) used by `pool protocol-check`. Proxies can be upgraded, so a
 *  mismatch is a stop-and-review signal, not something the tooling silently accepts. */
export const BSC_IDENTITY = {
  miningImplementation: '0xa3dbe873da37cd4e4a13c7cef23a7db6ca60f898',
  miningImplementationCodeHash: '0x63b1124d3448fdeb28b163c52142e15a7a464d7ae7d817e51f6c242b62424479',
  collectionBeacon: '0xf8d6d8eb894d6971c8976ad8b4971cbefe028156',
  collectionImplementation: '0x8E1D125Def6d3826C278299273a0760D47626068',
  bemDecimals: 8,
} as const;

export const ERC1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const ERC1967_BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

export const miningAbi = parseAbi([
  'function minerKey(address collection, uint256 tokenId) view returns (bytes32)',
  'function pending(bytes32 key) view returns (uint256)',
  'function claim(bytes32 key)',
]);

export const erc721Abi = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
  'function transferFrom(address from, address to, uint256 tokenId)',
]);

export const erc20Abi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export const beaconAbi = parseAbi(['function implementation() view returns (address)']);

export const CATEGORY = { NAND: 0, LATCH: 1 } as const;
export type CategoryName = keyof typeof CATEGORY;
export const RECIPIENT = { FEE: 0, HISTORICAL_NAND: 1, HISTORICAL_LATCH: 2 } as const;
