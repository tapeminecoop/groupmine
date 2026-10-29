import { existsSync, readFileSync } from 'node:fs';
import { createWalletClient, decodeEventLog, encodeDeployData, encodeFunctionData, getContractAddress, http, keccak256, type Abi, type Address, type Hex } from 'viem';
import { bsc } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { artifact, IDS, journal, nftAbi, P, redact, remote, save, verifyRuntime, type ContractName } from './common.ts';

export type Manifest = {
  schema: string; mode: 'fork' | 'mainnet'; runId: string; candidateDigest: string; owner: Address;
  contracts: Partial<Record<ContractName, Address>>; identities: Record<string, unknown>;
  maxRunFee: string; maxTxFee: string; recoveryReserve: string; minConfirmations: number;
  maxWaitSeconds: number; accrualIntervalSeconds: number; feePriceCeiling: string;
  totalFeeRaw: string; dir: string; startedAt: string; status: string; [key: string]: unknown;
};

export function budget(spent: bigint, cost: bigint, total: bigint, reserve: bigint, recovery: boolean) {
  if (cost <= 0n || spent + cost > total - (recovery ? 0n : reserve)) throw Error('Fee budget or recovery reserve would be exceeded');
}

export class Runner {
  readonly rpc;
  readonly path;
  constructor(public manifest: Manifest, rpc: ReturnType<typeof remote>) {
    this.rpc = rpc;
    this.path = `${manifest.dir}/journal.jsonl`;
  }
  persist() {
    // Preserve the exact ABI/build with the journal so recovery survives a rebuilt working tree.
    if (!existsSync(`${this.manifest.dir}/artifacts.json`)) save(`${this.manifest.dir}/artifacts.json`, Object.fromEntries((['nand', 'latch', 'helper', 'pool', 'regularPool', 'distributor'] as const).map(name => [name, artifact(name)])));
    save(`${this.manifest.dir}/manifest.json`, this.manifest);
  }
  artifact(name: ContractName) {
    const path = `${this.manifest.dir}/artifacts.json`;
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8'))[name] as ReturnType<typeof artifact> : artifact(name);
  }
  async reconcileJournal() {
    if (!existsSync(this.path)) return;
    const rows = readFileSync(this.path, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s));
    const hashes = new Map<string, any>();
    for (const row of rows) if (row.hash) hashes.set(row.hash, { ...hashes.get(row.hash), ...row });
    let spent = 0n;
    for (const row of hashes.values()) {
      const receipt = await this.rpc.getTransactionReceipt({ hash: row.hash }).catch(() => null);
      if (!receipt) throw Error(`UNKNOWN_OR_PENDING transaction ${row.hash}; do not retry blindly`);
      if (this.manifest.mode === 'mainnet') {
        const confirmed = await this.rpc.waitForTransactionReceipt({ hash: row.hash, confirmations: this.manifest.minConfirmations, timeout: 180_000 });
        if (confirmed.transactionHash !== row.hash || confirmed.blockHash !== receipt.blockHash) throw Error('Transaction replacement or reorganization requires reconciliation');
      }
      const fee = receipt.gasUsed * receipt.effectiveGasPrice;
      spent += fee;
      const tx = await this.rpc.getTransaction({ hash: row.hash });
      this.manifest.nextNonce = Math.max(Number(this.manifest.nextNonce ?? 0), tx.nonce + 1);
      if (row.stage !== 'CONFIRMED' && row.stage !== 'RECONCILED') {
        const intent = rows.find(x => x.stage === 'INTENT' && x.nonce === row.nonce);
        const block = await this.rpc.getBlock({ blockNumber: receipt.blockNumber });
        journal(this.path, { ...intent, stage: 'RECONCILED', action: row.action, hash: row.hash, status: receipt.status, block: receipt.blockNumber, blockHash: receipt.blockHash, timestamp: block.timestamp, confirmations: Number(await this.rpc.getBlockNumber({ cacheTime: 0 }) - receipt.blockNumber + 1n), gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, feeRaw: fee, logs: receipt.logs });
      }
      if (row.action.startsWith('deploy-') && receipt.status === 'success' && receipt.contractAddress) {
        const key = row.action.slice(7) as ContractName;
        this.manifest.contracts[key] = receipt.contractAddress;
        if (key === 'pool') this.manifest.poolDeployBlock = String(receipt.blockNumber);
        this.manifest.identities[key] = verifyRuntime(key, (await this.rpc.getCode({ address: receipt.contractAddress }))!, this.artifact(key));
      }
    }
    this.manifest.totalFeeRaw = String(spent);
    this.persist();
  }
  read<T = any>(address: Address, abi: Abi, functionName: string, args: unknown[] = [], blockNumber?: bigint): Promise<T> {
    return this.rpc.readContract({ address, abi, functionName, args, ...(blockNumber !== undefined ? { blockNumber } : {}) } as never) as Promise<T>;
  }
  pool<T = any>(functionName: string, args: unknown[] = []): Promise<T> { return this.read(this.manifest.contracts.pool!, this.artifact('pool').abi, functionName, args); }
  /** The second canary pool (never admits a miner). */
  regular<T = any>(functionName: string, args: unknown[] = []): Promise<T> { return this.read(this.manifest.contracts.regularPool!, this.artifact('regularPool').abi, functionName, args); }
  async snapshot(target?: Address) {
    const block = await this.rpc.getBlockNumber({ cacheTime: 0 });
    const state: Record<string, unknown> = { block, bnb: await this.rpc.getBalance({ address: this.manifest.owner, blockNumber: block }) };
    for (const id of IDS) state[`ownerOf${id}`] = await this.read(P.minerCollection, nftAbi, 'ownerOf', [id], block);
    const token = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
    state.bem = {};
    for (const address of [...new Set([this.manifest.owner, this.manifest.contracts.pool, this.manifest.contracts.helper, target].filter(Boolean))] as Address[]) {
      (state.bem as Record<string, unknown>)[address] = await this.read(P.bem, token, 'balanceOf', [address], block);
    }
    return state;
  }
  async assertIdentity() {
    for (const [key, address] of Object.entries(this.manifest.contracts)) {
      const code = await this.rpc.getCode({ address: address! });
      if (!code) throw Error(`Missing deployed code ${key}`);
      const identity = verifyRuntime(key as ContractName, code, this.artifact(key as ContractName));
      const recorded = this.manifest.identities[key] as { codeHash?: string } | undefined;
      if (recorded?.codeHash && recorded.codeHash !== identity.codeHash) throw Error(`Deployed identity changed ${key}`);
    }
    // Both canary pools carry the same fixed recovery wallet, protocol, receipts, recipients and whitelist.
    for (const name of ['pool', 'regularPool'] as const) {
      if (!this.manifest.contracts[name]) continue;
      const get = <T>(fn: string) => (name === 'pool' ? this.pool<T>(fn) : this.regular<T>(fn));
      if ((await get<Address>('recoveryController')).toLowerCase() !== this.manifest.owner.toLowerCase()) throw Error(`Wrong fixed recovery wallet: ${name}`);
      if ((await get<Address>('minerCollection')).toLowerCase() !== P.minerCollection.toLowerCase()) throw Error(`Wrong miner collection: ${name}`);
      // No reward dependency is invoked: these are immutable getters on our own pool.
      if ((await get<Address>('bem')).toLowerCase() !== P.bem.toLowerCase() || (await get<Address>('mining')).toLowerCase() !== P.mining.toLowerCase()) throw Error(`Protocol binding changed: ${name}`);
      for (const [getter, expected] of [['nandReceipt', this.manifest.contracts.nand], ['latchReceipt', this.manifest.contracts.latch], ['recipientA', this.manifest.owner], ['recipientB', this.manifest.contracts.helper]] as const) if (expected && (await get<Address>(getter)).toLowerCase() !== expected.toLowerCase()) throw Error(`Approved ${name} binding changed: ${getter}`);
      const depositors = await get<Address[]>('depositors');
      if (depositors.length !== 1 || depositors[0].toLowerCase() !== this.manifest.owner.toLowerCase()) throw Error(`Wrong depositor whitelist: ${name}`);
    }
  }
  async send(action: string, to: Address | null, data: Hex, functionName: string, recovery = false) {
    await this.assertIdentity();
    if (await this.rpc.getChainId() !== 56) throw Error('Chain changed');
    const sender = this.manifest.owner;
    const pendingNonce = await this.rpc.getTransactionCount({ address: sender, blockTag: 'pending' });
    const nonce = await this.rpc.getTransactionCount({ address: sender, blockTag: 'latest' });
    if (pendingNonce !== nonce) throw Error('Unknown/pending nonce: reconcile journal and receipts before continuing');
    if (!recovery && this.manifest.nextNonce !== undefined && nonce !== this.manifest.nextNonce) throw Error('Wallet nonce changed outside this run; deployment addresses/scope require renewed review');
    // Specific action simulated immediately before every send, including deployments and recovery.
    await this.rpc.call({ account: sender, ...(to ? { to } : {}), data, value: 0n });
    const estimated = await this.rpc.estimateGas({ account: sender, ...(to ? { to } : {}), data, value: 0n });
    const gas = estimated * 125n / 100n + 20_000n;
    if (gas > 16_777_216n) throw Error('Transaction gas exceeds BSC cap');
    // Anvil may recommend the preceding tx's price; recursively padding that quote compounds it.
    // A rehearsal pins the upstream quote. Mainnet always re-quotes immediately before each send.
    const quoted = this.manifest.mode === 'fork' ? BigInt(this.manifest.forkGasPrice as string) : await this.rpc.getGasPrice();
    const gasPrice = quoted * 110n / 100n;
    if (gasPrice > BigInt(this.manifest.feePriceCeiling)) throw Error('Gas price above approved ceiling');
    const cost = gas * gasPrice;
    if (cost > BigInt(this.manifest.maxTxFee)) throw Error('Transaction fee cap exceeded');
    budget(BigInt(this.manifest.totalFeeRaw), cost, BigInt(this.manifest.maxRunFee), BigInt(this.manifest.recoveryReserve), recovery);
    const balance = await this.rpc.getBalance({ address: sender });
    if (balance < cost + (recovery ? 0n : BigInt(this.manifest.recoveryReserve))) throw Error('Insufficient spendable BNB while preserving recovery reserve');
    // Recovery intentionally omits ALL BEM/Mining snapshots and checks.
    const before = recovery ? { ownerOf: Object.fromEntries(await Promise.all(IDS.map(async id => [String(id), await this.read(P.minerCollection, nftAbi, 'ownerOf', [id])]))) } : await this.snapshot(to ?? undefined);
    const intent = { action, sender, target: to, function: functionName, nonce, data, gas, gasPrice, maxFeeRaw: cost, before, predictedContract: to ? undefined : getContractAddress({ from: sender, nonce: BigInt(nonce) }) };
    journal(this.path, { stage: 'INTENT', ...intent });
    let txHash: Hex;
    if (this.manifest.mode === 'fork') {
      txHash = await this.rpc.request({ method: 'eth_sendTransaction', params: [{ from: sender, ...(to ? { to } : {}), data, gas: `0x${gas.toString(16)}`, gasPrice: `0x${gasPrice.toString(16)}`, nonce: `0x${nonce.toString(16)}` }] } as never) as Hex;
      journal(this.path, { stage: 'SUBMITTED', action, nonce, hash: txHash });
    } else {
      const account = privateKeyToAccount(process.env.OWNER_PRIVATE_KEY as Hex);
      if (account.address.toLowerCase() !== sender.toLowerCase()) throw Error('Signer changed');
      const wallet = createWalletClient({ account, chain: bsc, transport: http(process.env.BSC_RPC_URL) });
      const signed = await wallet.signTransaction({ ...(to ? { to } : {}), data, gas, gasPrice, nonce, value: 0n, type: 'legacy' });
      txHash = keccak256(signed);
      // Know and durably save the hash BEFORE broadcast. Never blindly resend after an RPC timeout.
      journal(this.path, { stage: 'SIGNED_HASH', action, nonce, hash: txHash });
      const response = await this.rpc.sendRawTransaction({ serializedTransaction: signed });
      if (response !== txHash) throw Error('RPC returned an unexpected transaction hash');
    }
    const receipt = await this.rpc.waitForTransactionReceipt({ hash: txHash, confirmations: this.manifest.mode === 'fork' ? 1 : this.manifest.minConfirmations, timeout: 180_000, onReplaced: () => { throw Error('Replacement detected; reconcile exact hash and nonce'); } });
    if (receipt.transactionHash !== txHash) throw Error('Receipt hash differs from submitted hash');
    const block = await this.rpc.getBlock({ blockNumber: receipt.blockNumber });
    const fee = receipt.gasUsed * receipt.effectiveGasPrice;
    this.manifest.totalFeeRaw = String(BigInt(this.manifest.totalFeeRaw) + fee);
    this.manifest.nextNonce = nonce + 1;
    const events: unknown[] = [];
    for (const log of receipt.logs) {
      let decoded: unknown;
      for (const name of Object.keys(this.manifest.contracts) as ContractName[]) try { decoded = decodeEventLog({ abi: this.artifact(name).abi, data: log.data, topics: log.topics }); break; } catch {}
      events.push({ address: log.address, topics: log.topics, data: log.data, decoded });
    }
    const after = recovery ? { ownerOf: Object.fromEntries(await Promise.all(IDS.map(async id => [String(id), await this.read(P.minerCollection, nftAbi, 'ownerOf', [id])]))) } : await this.snapshot(to ?? receipt.contractAddress ?? undefined);
    journal(this.path, { stage: 'CONFIRMED', ...intent, hash: txHash, status: receipt.status, block: receipt.blockNumber, blockHash: receipt.blockHash, timestamp: block.timestamp, confirmations: Number(await this.rpc.getBlockNumber({ cacheTime: 0 }) - receipt.blockNumber + 1n), gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, feeRaw: fee, contractAddress: receipt.contractAddress, events, after });
    this.persist();
    if (receipt.status !== 'success') throw Error(`${action} reverted: ${txHash}`);
    console.log(`${this.manifest.mode}: ${action} confirmed ${txHash}`);
    return receipt;
  }
  async write(name: ContractName, fn: string, args: unknown[] = [], action = fn, recovery = false) {
    return this.send(action, this.manifest.contracts[name]!, encodeFunctionData({ abi: this.artifact(name).abi, functionName: fn, args } as never), fn, recovery);
  }
  async deploy(name: ContractName, args: unknown[]) {
    const a = artifact(name);
    const receipt = await this.send(`deploy-${name}`, null, encodeDeployData({ abi: a.abi, bytecode: a.bytecode.object, args }), 'constructor');
    if (!receipt.contractAddress) throw Error('Deployment has no contract address');
    this.manifest.contracts[name] = receipt.contractAddress;
    if (name === 'pool') this.manifest.poolDeployBlock = String(receipt.blockNumber);
    const expected = (this.manifest.predictedContracts as Partial<Record<ContractName, Address>> | undefined)?.[name];
    if (expected && receipt.contractAddress.toLowerCase() !== expected.toLowerCase()) { this.persist(); throw Error(`Deployment address differs from approved ${name}`); }
    this.manifest.identities[name] = verifyRuntime(name, (await this.rpc.getCode({ address: receipt.contractAddress }))!);
    this.persist();
    return receipt.contractAddress;
  }
  async recover() {
    await this.reconcileJournal();
    if (!this.manifest.contracts.pool) return;
    await this.assertIdentity();
    const errors: Record<string, string> = {};
    if (!await this.pool('closed')) {
      try { await this.write('pool', 'shutdown', [], 'permanent-shutdown', true); }
      catch (e) { errors.shutdown = redact(e); }
    }
    // The second canary pool holds no miner, so closing it is all its recovery needs.
    if (this.manifest.contracts.regularPool && !await this.regular('closed')) {
      try { await this.write('regularPool', 'shutdown', [], 'permanent-shutdown-regular-pool', true); }
      catch (e) { errors.regularShutdown = redact(e); }
    }
    // Independent attempts, even after another return fails. No harvest or reward synchronization.
    for (const id of IDS) try {
      const holder = await this.read<Address>(P.minerCollection, nftAbi, 'ownerOf', [id]);
      if (holder.toLowerCase() === this.manifest.contracts.pool.toLowerCase()) await this.write('pool', 'emergencyReturn', [id], `return-${id}`, true);
      if ((await this.read<Address>(P.minerCollection, nftAbi, 'ownerOf', [id])).toLowerCase() !== this.manifest.owner.toLowerCase()) throw Error('NFT has not returned to original wallet');
    } catch (e) { errors[String(id)] = redact(e); }
    save(`${this.manifest.dir}/recovery.json`, { closed: await this.pool('closed'), ...(this.manifest.contracts.regularPool ? { regularPoolClosed: await this.regular('closed') } : {}),
      errors, verified: await Promise.all(IDS.map(async id => ({ id, owner: await this.read(P.minerCollection, nftAbi, 'ownerOf', [id]) }))) });
    if (Object.keys(errors).length) throw Error(`Recovery needs attention: ${JSON.stringify(errors)}`);
  }
}
