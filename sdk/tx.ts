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
import { mockMiningAbi, tapeoutEntitlementReceiptAbi, tapeoutMinerPoolAbi, tapeoutReceiptDistributorAbi } from './abi.js';
import { BATCH_GAS_BUDGET, TX_GAS_CAP } from './constants.js';

/** An unsigned transaction. Plans are what the CLI prints, simulates, exports for a Safe, or sends to a
 *  local Anvil node; the tooling never handles private keys. `gas` is the plan's worst-case bound
 *  (sdk/gas.ts): it is the gas limit for local sends and printed cast commands, because a transaction
 *  that calls the real Mining contract can need more gas when included than when estimated. */
export interface TxPlan {
  to: Address | null;
  data: Hex;
  value: bigint;
  description: string;
  gas?: bigint;
}

export interface SentTx {
  description: string;
  hash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
  status: 'success' | 'reverted';
  contractAddress?: Address | null;
}

const errorAbi = [...tapeoutMinerPoolAbi, ...tapeoutEntitlementReceiptAbi, ...tapeoutReceiptDistributorAbi, ...mockMiningAbi]
  .filter(item => item.type === 'error') as Abi;

export function client(rpcUrl: string): PublicClient {
  return createPublicClient({ transport: http(rpcUrl, { retryCount: 2, timeout: 120_000 }) });
}

/** Extract revert data from a viem error and decode it against the system's custom errors. */
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
      if (data.startsWith('0x5f9bb3be')) return 'Mining refused the claim (0x5f9bb3be: miner not ACTIVE)';
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

/** eth_call + eth_estimateGas; flags plans a BSC transaction could not carry (BEP-652, 2^24 gas). */
export async function simulate(rpc: PublicClient, plan: TxPlan, from: Address) {
  try {
    const result = await rpc.call({ account: from, to: plan.to ?? undefined, data: plan.data, value: plan.value });
    const gas = await rpc.estimateGas({ account: from, to: plan.to ?? undefined, data: plan.data, value: plan.value });
    return { ok: true as const, gas, returnData: result.data, exceedsTxGasCap: gas > TX_GAS_CAP, exceedsBatchBudget: gas > BATCH_GAS_BUDGET };
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

/** Send on local Anvil. Plans above the BSC per-transaction gas cap are refused even locally, so a
 *  rehearsal fails exactly where mainnet would. A plan's bound is its gas limit, and an estimate above
 *  the bound is reported as a model error. A revert is replayed to report its reason. */
export async function sendLocal(rpc: PublicClient, plan: TxPlan, from: Address): Promise<SentTx> {
  let gas: bigint | undefined;
  try {
    gas = await rpc.estimateGas({ account: from, to: plan.to ?? undefined, data: plan.data, value: plan.value });
  } catch (error) {
    throw new Error(`Simulation failed for "${plan.description}": ${describeError(error)}`);
  }
  if (gas > TX_GAS_CAP) throw new Error(`"${plan.description}" needs ${gas} gas, above the BSC per-transaction cap ${TX_GAS_CAP}`);
  if (plan.gas !== undefined && gas > plan.gas) throw new Error(`"${plan.description}" estimates ${gas} gas, above its planned bound ${plan.gas}: the gas model in sdk/gas.ts is too low`);
  const limit = plan.gas ?? (gas + gas / 5n > TX_GAS_CAP ? TX_GAS_CAP : gas + gas / 5n);
  const hash = await rpc.request({
    method: 'eth_sendTransaction',
    params: [{ from, ...(plan.to ? { to: plan.to } : {}), data: plan.data, value: toHex(plan.value), gas: toHex(limit) }],
  } as never) as Hex;
  const receipt = await rpc.waitForTransactionReceipt({ hash, timeout: 600_000 });
  if (receipt.status !== 'success') {
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

/** Safe{Wallet} Transaction Builder batch file (Transaction Builder > Load). A batch executes as one
 *  MultiSend transaction, so its plans must fit one BSC transaction together. */
export function safeBatch(plans: TxPlan[], chainId: number, name: string, safe?: Address) {
  if (plans.some(p => p.to === null)) throw new Error('Contract creation cannot be batched through a Safe; deploy from an EOA with the owner set to the Safe');
  return {
    version: '1.0',
    chainId: String(chainId),
    createdAt: Date.now(),
    meta: { name, description: plans.map(p => p.description).join('; ').slice(0, 1000), txBuilderVersion: '1.16.5', createdFromSafeAddress: safe ?? '', createdFromOwnerAddress: '' },
    transactions: plans.map(p => ({ to: p.to, value: p.value.toString(), data: p.data, contractMethod: null, contractInputsValues: null })),
  };
}

/** Equivalent Foundry command; the operator chooses the signer (--ledger, --account, ...). A planned
 *  bound becomes `--gas-limit`, so cast does not size the limit from its own estimate. */
export function castCommand(plan: TxPlan): string {
  const value = plan.value > 0n ? ` --value ${plan.value}` : '';
  const gas = plan.gas !== undefined ? ` --gas-limit ${plan.gas}` : '';
  return plan.to
    ? `cast send --rpc-url "$RPC_URL" <SIGNER_FLAGS>${value}${gas} ${plan.to} ${plan.data}`
    : `cast send --rpc-url "$RPC_URL" <SIGNER_FLAGS>${value}${gas} --create ${plan.data}`;
}
