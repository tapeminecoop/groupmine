import {
  BaseError,
  createPublicClient,
  decodeErrorResult,
  http,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { mockMiningAbi, tapeoutMinerPoolAbi, tapeoutReceiptAbi } from './abi.js';

/** An unsigned transaction. Plans are what the CLI prints, simulates, exports for a Safe, or
 *  sends to a local Anvil node; the tooling never handles private keys. */
export interface TxPlan {
  to: Address | null;
  data: Hex;
  value: bigint;
  description: string;
}

export interface SentTx {
  description: string;
  hash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
  status: 'success' | 'reverted';
  contractAddress?: Address | null;
}

const errorAbi = [...tapeoutMinerPoolAbi, ...tapeoutReceiptAbi, ...mockMiningAbi].filter(item => item.type === 'error') as Abi;

export function client(rpcUrl: string): PublicClient {
  return createPublicClient({ transport: http(rpcUrl, { retryCount: 2, timeout: 60_000 }) });
}

/** Extract revert data from a viem error and decode it against the pool/receipt errors. */
export function describeError(error: unknown): string {
  if (error instanceof BaseError) {
    let data: Hex | undefined;
    error.walk(e => {
      const candidate = (e as { data?: unknown }).data;
      if (typeof candidate === 'string' && candidate.startsWith('0x')) data = candidate as Hex;
      else if (candidate && typeof candidate === 'object' && typeof (candidate as { data?: unknown }).data === 'string') data = (candidate as { data: Hex }).data;
      return false;
    });
    if (data && data.length >= 10) {
      try {
        const decoded = decodeErrorResult({ abi: errorAbi, data });
        return `${decoded.errorName}(${(decoded.args ?? []).map(a => String(a)).join(', ')})`;
      } catch {
        return `revert ${data}`;
      }
    }
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function simulate(rpc: PublicClient, plan: TxPlan, from: Address) {
  try {
    const result = await rpc.call({ account: from, to: plan.to ?? undefined, data: plan.data, value: plan.value });
    const gas = await rpc.estimateGas({ account: from, to: plan.to ?? undefined, data: plan.data, value: plan.value });
    return { ok: true as const, gas, returnData: result.data };
  } catch (error) {
    return { ok: false as const, error: describeError(error) };
  }
}

/** Refuse to send anywhere except a loopback Anvil node. */
export async function assertLocalAnvil(rpcUrl: string, rpc: PublicClient) {
  const url = new URL(rpcUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('--send-local only targets a loopback http:// Anvil endpoint');
  }
  const version = await rpc.request({ method: 'web3_clientVersion' } as never) as string;
  if (!/^anvil\//i.test(version)) throw new Error(`--send-local requires Anvil, found "${version}"`);
  return { clientVersion: version, chainId: await rpc.getChainId() };
}

export async function impersonate(rpc: PublicClient, account: Address) {
  await rpc.request({ method: 'anvil_impersonateAccount', params: [account] } as never);
}

export async function sendLocal(rpc: PublicClient, plan: TxPlan, from: Address): Promise<SentTx> {
  const hash = await rpc.request({
    method: 'eth_sendTransaction',
    params: [{ from, ...(plan.to ? { to: plan.to } : {}), data: plan.data, value: toHex(plan.value) }],
  } as never) as Hex;
  const receipt = await rpc.waitForTransactionReceipt({ hash, timeout: 600_000 });
  if (receipt.status !== 'success') {
    // Replay against the pre-transaction state to recover the revert reason and the gas picture.
    const tx = await rpc.getTransaction({ hash });
    let reason = 'unknown';
    try {
      await rpc.call({ account: from, to: plan.to ?? undefined, data: plan.data, value: plan.value, gas: tx.gas, blockNumber: receipt.blockNumber - 1n });
      reason = 'replay succeeded with the same gas limit at the previous block';
    } catch (error) {
      reason = describeError(error);
    }
    throw new Error(`Local transaction reverted: ${plan.description} (${hash}); gasLimit=${tx.gas} gasUsed=${receipt.gasUsed}; replay: ${reason}`);
  }
  return { description: plan.description, hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, status: receipt.status, contractAddress: receipt.contractAddress };
}

/** Safe{Wallet} Transaction Builder batch file (import via "Transaction Builder" > "Load"). */
export function safeBatch(plans: TxPlan[], chainId: number, name: string, safe?: Address) {
  if (plans.some(p => p.to === null)) throw new Error('Contract creation cannot be batched through a Safe; deploy from an EOA with owner set to the Safe');
  return {
    version: '1.0',
    chainId: String(chainId),
    createdAt: Date.now(),
    meta: { name, description: plans.map(p => p.description).join('; ').slice(0, 1000), txBuilderVersion: '1.16.5', createdFromSafeAddress: safe ?? '', createdFromOwnerAddress: '' },
    transactions: plans.map(p => ({ to: p.to, value: p.value.toString(), data: p.data, contractMethod: null, contractInputsValues: null })),
  };
}

/** Equivalent Foundry command; the operator chooses the signer (--ledger, --account, ...). */
export function castCommand(plan: TxPlan): string {
  const value = plan.value > 0n ? ` --value ${plan.value}` : '';
  return plan.to
    ? `cast send --rpc-url "$RPC_URL" <SIGNER_FLAGS>${value} ${plan.to} ${plan.data}`
    : `cast send --rpc-url "$RPC_URL" <SIGNER_FLAGS>${value} --create ${plan.data}`;
}
