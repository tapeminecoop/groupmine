/**
 * Expected-revert verification for the canary runner's negative tests (review findings CT-01 / T-1,
 * T-2). The frozen runner searched viem's human-readable error message for "revert" and the expected
 * selector: a provider that keeps the revert bytes only in structured error data produced false
 * negatives, and an unrelated message containing the selector text could pass.
 *
 * Here a negative test passes only when the JSON-RPC error's structured `data` (at any nesting a
 * provider uses) holds revert bytes that ABI-decode to the expected custom error with exactly the
 * expected arguments, and re-encode to the same bytes. Every other outcome is classified:
 *   FAIL       WRONG_ERROR, WRONG_ARGUMENTS, UNEXPECTED_SUCCESS (semantic: never retried); CHAIN_MISMATCH
 *              (the node serves another chain than the caller expects: a configuration fault, not retried)
 *   UNVERIFIED NO_REVERT_DATA, MALFORMED_REVERT_DATA, AMBIGUOUS_REVERT_DATA, TRANSPORT_ERROR
 *              (retried a bounded number of times at the same pinned block, then reported as such);
 *              METADATA_UNAVAILABLE (follow-up review C-210-01: the chain id or the block could not be
 *              obtained and validated within the bounded attempts; the test call is then never made)
 * Message text is recorded for diagnostics only, never as evidence; calldata and request bodies are
 * never searched. Calls are pinned by block number and the block's hash is recorded; that is not
 * EIP-1898 hash pinning, so it does not prove the state was independent of a reorganization.
 */
import { decodeErrorResult, encodeErrorResult, keccak256, stringToHex, toHex, type Abi, type Address, type Hex, type PublicClient } from 'viem';

export type Verdict = 'PASS' | 'FAIL' | 'UNVERIFIED';
export type RevertKind =
  | 'EXPECTED_REVERT' | 'WRONG_ERROR' | 'WRONG_ARGUMENTS' | 'UNEXPECTED_SUCCESS' | 'CHAIN_MISMATCH'
  | 'NO_REVERT_DATA' | 'MALFORMED_REVERT_DATA' | 'AMBIGUOUS_REVERT_DATA' | 'TRANSPORT_ERROR' | 'METADATA_UNAVAILABLE';
/** Where an attempt was made: the two metadata reads come first, and the test call only after both. */
export type MetadataStage = 'chain-metadata' | 'block-metadata';
export interface ExpectedError { abi: Abi; name: string; args: readonly unknown[] }
export interface RevertOutcome {
  kind: RevertKind;
  verdict: Verdict;
  revertData?: Hex;
  decoded?: { name: string; args: readonly unknown[] };
  selector?: string;
  expectedSelector?: string;
  candidates?: Hex[];
  note?: string;
}
type ErrorItem = { type: 'error'; name: string; inputs: readonly { type: string }[] };
/** One negative test's evidence: the outcome, the metadata actually obtained, and every attempt. */
export interface VerifiedRevert extends RevertOutcome {
  stage?: MetadataStage;
  chainId?: number;
  block?: { number: bigint; hash: Hex };
  caller: Address;
  target: Address;
  calldata: Hex;
  expected: { name: string; args: readonly unknown[] };
  attempts: { attempt: number; kind: RevertKind; diagnostic?: string }[];
  metadataAttempts: { stage: MetadataStage; attempt: number; ok: boolean; diagnostic?: string }[];
}

const VERDICT: Record<RevertKind, Verdict> = {
  EXPECTED_REVERT: 'PASS', WRONG_ERROR: 'FAIL', WRONG_ARGUMENTS: 'FAIL', UNEXPECTED_SUCCESS: 'FAIL', CHAIN_MISMATCH: 'FAIL',
  NO_REVERT_DATA: 'UNVERIFIED', MALFORMED_REVERT_DATA: 'UNVERIFIED', AMBIGUOUS_REVERT_DATA: 'UNVERIFIED', TRANSPORT_ERROR: 'UNVERIFIED',
  METADATA_UNAVAILABLE: 'UNVERIFIED',
};
const STANDARD_ERRORS = [
  { type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] },
  { type: 'error', name: 'Panic', inputs: [{ name: 'code', type: 'uint256' }] },
] as const;
const isHexData = (v: unknown): v is Hex => typeof v === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(v);

/** Revert bytes from the structured `data` of an RPC error: error.data, error.data.data,
 *  error.data.originalError.data, error.error.data, along the whole cause chain. Request bodies
 *  (which hold the calldata), messages and details are never read. */
export function structuredRevertData(error: unknown) {
  const candidates = new Set<string>();
  let transport = false;
  let malformed = false;
  const seen = new Set<unknown>();
  const visitData = (d: unknown, depth: number) => {
    if (depth > 4 || d === undefined || d === null) return;
    if (typeof d === 'string') {
      if (isHexData(d)) candidates.add(d.toLowerCase());
      else if (/^0x/i.test(d)) malformed = true;
      return;
    }
    if (typeof d === 'object') for (const key of ['data', 'originalError', 'error']) visitData((d as Record<string, unknown>)[key], depth + 1);
  };
  const visitError = (e: unknown, depth: number) => {
    if (!e || typeof e !== 'object' || seen.has(e) || depth > 12) return;
    seen.add(e);
    const o = e as Record<string, unknown>;
    if (['HttpRequestError', 'TimeoutError', 'WebSocketRequestError', 'SocketClosedError'].includes(String(o.name)) || typeof o.status === 'number') transport = true;
    visitData(o.data, 0);
    visitError(o.cause, depth + 1);
    if (o.error && typeof o.error === 'object') {
      visitData((o.error as Record<string, unknown>).data, 0);
      visitError(o.error, depth + 1);
    }
  };
  visitError(error, 0);
  const list = [...candidates] as Hex[];
  return { data: list.length === 1 ? list[0] : undefined, candidates: list, transport, malformed };
}

const normalize = (v: unknown): unknown => typeof v === 'bigint' ? v.toString()
  : typeof v === 'number' ? String(v)
  : typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase()
  : Array.isArray(v) ? v.map(normalize) : v;
const equalArgs = (a: readonly unknown[], b: readonly unknown[]) => JSON.stringify(normalize([...a])) === JSON.stringify(normalize([...b]));

/** Classify one eth_call outcome (`error` undefined: the call returned normally). */
export function classifyRevert(error: unknown, expected: ExpectedError): RevertOutcome {
  const outcome = (kind: RevertKind, extra: Omit<RevertOutcome, 'kind' | 'verdict'> = {}): RevertOutcome => ({ kind, verdict: VERDICT[kind], ...extra });
  if (error === undefined) return outcome('UNEXPECTED_SUCCESS');
  const { data, candidates, transport, malformed } = structuredRevertData(error);
  if (candidates.length > 1) return outcome('AMBIGUOUS_REVERT_DATA', { candidates });
  if (data === undefined) return outcome(malformed ? 'MALFORMED_REVERT_DATA' : transport ? 'TRANSPORT_ERROR' : 'NO_REVERT_DATA');
  if (data.length === 2) return outcome('NO_REVERT_DATA', { revertData: data });
  if (data.length < 10) return outcome('MALFORMED_REVERT_DATA', { revertData: data });
  const item = (expected.abi as readonly { type: string; name?: string }[]).find(i => i.type === 'error' && i.name === expected.name) as ErrorItem | undefined;
  if (!item) throw new Error(`expected error ${expected.name} is not in the ABI`);
  const signature = `${item.name}(${item.inputs.map(i => i.type).join(',')})`;
  const expectedSelector = keccak256(stringToHex(signature)).slice(0, 10);
  const abi = [...expected.abi.filter(i => i.type === 'error'), ...STANDARD_ERRORS] as Abi;
  let decoded: { errorName: string; args?: readonly unknown[] };
  try {
    decoded = decodeErrorResult({ abi, data });
  } catch {
    return data.slice(0, 10) === expectedSelector
      ? outcome('MALFORMED_REVERT_DATA', { revertData: data, expectedSelector })
      : outcome('WRONG_ERROR', { revertData: data, selector: data.slice(0, 10), expectedSelector });
  }
  const args = decoded.args ?? [];
  if (decoded.errorName !== expected.name) return outcome('WRONG_ERROR', { revertData: data, decoded: { name: decoded.errorName, args }, expectedSelector });
  // Exact bytes: nothing appended to or missing from the canonical encoding.
  const canonical = encodeErrorResult({ abi, errorName: expected.name, args } as never);
  if (canonical.toLowerCase() !== data.toLowerCase()) return outcome('MALFORMED_REVERT_DATA', { revertData: data, decoded: { name: decoded.errorName, args }, note: 'decodes, but is not the canonical encoding' });
  if (!equalArgs(args, expected.args)) return outcome('WRONG_ARGUMENTS', { revertData: data, decoded: { name: decoded.errorName, args } });
  return outcome('EXPECTED_REVERT', { revertData: data, decoded: { name: decoded.errorName, args } });
}

/** Diagnostic text only: URLs (which may carry credentials) removed, length bounded. */
export const diagnostic = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/https?:\/\/[^\s"'<>]+/g, '[REDACTED_RPC]').slice(0, 600);

/**
 * Simulate `data` from `from` to `to` at one pinned block and verify it reverts with `expected`.
 *
 * The chain id and the block come first, each with up to `attempts` bounded attempts recorded in
 * `metadataAttempts` (stage, attempt, diagnostic). A value counts only when valid: a positive chain id,
 * equal to `expectedChainId` when given; a block with a number and a 32-byte hash, the requested number
 * when `blockNumber` is given. Without both, the result is UNVERIFIED METADATA_UNAVAILABLE and the test call
 * is never made; a different chain is FAIL CHAIN_MISMATCH. Only metadata actually obtained is reported.
 *
 * The raw `eth_call` request keeps the provider's error object intact. UNVERIFIED outcomes are retried up to
 * `attempts` times at the same pinned block; FAIL outcomes are returned at once.
 */
export async function verifyExpectedRevert(p: {
  rpc: PublicClient; from: Address; to: Address; data: Hex; expected: ExpectedError; blockNumber?: bigint; expectedChainId?: number;
  attempts?: number; retryDelayMs?: number;
}): Promise<VerifiedRevert> {
  const max = Math.max(1, p.attempts ?? 3);
  const pause = (attempt: number) => new Promise(resolve => setTimeout(resolve, (p.retryDelayMs ?? 1_000) * attempt));
  const request = { caller: p.from, target: p.to, calldata: p.data, expected: { name: p.expected.name, args: p.expected.args } };
  const metadataAttempts: VerifiedRevert['metadataAttempts'] = [];
  const acquire = async <T>(stage: MetadataStage, read: () => Promise<T>, invalid: (value: T) => string | undefined) => {
    for (let attempt = 1; ; attempt++) {
      let problem: string;
      try {
        const value = await read();
        const reason = invalid(value);
        if (reason === undefined) {
          metadataAttempts.push({ stage, attempt, ok: true });
          return { value };
        }
        problem = reason;
      } catch (e) {
        problem = diagnostic(e ?? new Error('empty rejection'));
      }
      metadataAttempts.push({ stage, attempt, ok: false, diagnostic: problem });
      if (attempt >= max) return undefined;
      await pause(attempt);
    }
  };
  const unavailable = (stage: MetadataStage, obtained: { chainId?: number }): VerifiedRevert => ({
    kind: 'METADATA_UNAVAILABLE', verdict: VERDICT.METADATA_UNAVAILABLE, stage, ...obtained, ...request, attempts: [], metadataAttempts,
    note: `${stage} could not be obtained and validated in ${max} attempts; the test call was not made`,
  });

  const chain = await acquire('chain-metadata', () => p.rpc.getChainId(), id => (Number.isSafeInteger(id) && id > 0 ? undefined : `invalid chain id ${String(id)}`));
  if (!chain) return unavailable('chain-metadata', {});
  if (p.expectedChainId !== undefined && chain.value !== p.expectedChainId) {
    return {
      kind: 'CHAIN_MISMATCH', verdict: VERDICT.CHAIN_MISMATCH, stage: 'chain-metadata', chainId: chain.value, ...request, attempts: [], metadataAttempts,
      note: `the node serves chain ${chain.value}, not the expected chain ${p.expectedChainId}; the test call was not made`,
    };
  }
  const block = await acquire('block-metadata',
    () => (p.blockNumber !== undefined ? p.rpc.getBlock({ blockNumber: p.blockNumber }) : p.rpc.getBlock({ blockTag: 'latest' })),
    b => (typeof b?.number !== 'bigint' ? 'block without a number'
      : typeof b.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(b.hash) ? 'block without a valid hash'
      : p.blockNumber !== undefined && b.number !== p.blockNumber ? `block ${b.number} returned for requested block ${p.blockNumber}`
      : undefined));
  if (!block) return unavailable('block-metadata', { chainId: chain.value });
  const pinned = { number: block.value.number!, hash: block.value.hash! };

  const attempts: VerifiedRevert['attempts'] = [];
  for (let attempt = 1; ; attempt++) {
    let error: unknown;
    try {
      await p.rpc.request({ method: 'eth_call', params: [{ from: p.from, to: p.to, data: p.data }, toHex(pinned.number)] } as never);
    } catch (e) {
      error = e ?? new Error('empty rejection');
    }
    const result = classifyRevert(error, p.expected);
    attempts.push({ attempt, kind: result.kind, ...(error ? { diagnostic: diagnostic(error) } : {}) });
    if (result.verdict !== 'UNVERIFIED' || attempt >= max) return { ...result, chainId: chain.value, block: pinned, ...request, attempts, metadataAttempts };
    await pause(attempt);
  }
}

/** Thrown by the canary workflow when a negative test is not PASS, after its evidence is saved. The message
 *  keeps the runner's `ASSERTION_<verdict> <name> (<kind>)` form; `verdict` tells a refuted expectation
 *  (FAIL) from a check that could not be completed (UNVERIFIED). */
export class NegativeTestStop extends Error {
  readonly test: string;
  readonly verdict: Verdict;
  readonly kind: string;
  constructor(test: string, verdict: Verdict, kind: string) {
    super(`ASSERTION_${verdict} ${test} (${kind})`);
    this.name = 'NegativeTestStop';
    this.test = test;
    this.verdict = verdict;
    this.kind = kind;
  }
}

/** Records a negative test's evidence and persists it; stops normal progress unless it passed. */
export function recordNegativeTest(results: Record<string, any>, name: string, evidence: { verdict: Verdict; kind: string }, persist: () => void) {
  results.assertions[name] = { status: evidence.verdict, evidence: { simulationOnly: true, ...evidence } };
  persist();
  if (evidence.verdict !== 'PASS') throw new NegativeTestStop(name, evidence.verdict, evidence.kind);
}

/** How the workflow records the error that stopped its normal steps. An UNVERIFIED negative test is an
 *  inconclusive infrastructure outcome, not a business-test failure; recovery runs either way. */
export function stopClassification(error: unknown) {
  if (error instanceof NegativeTestStop && error.verdict === 'UNVERIFIED') return { status: 'NEGATIVE_TEST_UNVERIFIED_RECOVERING', stopReason: 'INCONCLUSIVE_NEGATIVE_TEST' } as const;
  if (error instanceof NegativeTestStop) return { status: 'BUSINESS_TEST_FAILED_RECOVERING', stopReason: 'NEGATIVE_TEST_FAILED' } as const;
  return { status: 'BUSINESS_TEST_FAILED_RECOVERING', stopReason: 'ASSERTION_OR_UNCLASSIFIED_ERROR' } as const;
}
