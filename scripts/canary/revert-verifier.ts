/**
 * Expected-revert verification for the canary runner's negative tests (review findings CT-01 / T-1,
 * T-2). The frozen runner searched viem's human-readable error message for "revert" and the expected
 * selector: a provider that keeps the revert bytes only in structured error data produced false
 * negatives, and an unrelated message containing the selector text could pass.
 *
 * Here a negative test passes only when the JSON-RPC error's structured `data` (at any nesting a
 * provider uses) holds revert bytes that ABI-decode to the expected custom error with exactly the
 * expected arguments, and re-encode to the same bytes. Every other outcome is classified:
 *   FAIL       WRONG_ERROR, WRONG_ARGUMENTS, UNEXPECTED_SUCCESS (semantic: never retried)
 *   UNVERIFIED NO_REVERT_DATA, MALFORMED_REVERT_DATA, AMBIGUOUS_REVERT_DATA, TRANSPORT_ERROR
 *              (retried a bounded number of times at the same pinned block, then reported as such)
 * Message text is recorded for diagnostics only, never as evidence; calldata and request bodies are
 * never searched.
 */
import { decodeErrorResult, encodeErrorResult, keccak256, stringToHex, toHex, type Abi, type Address, type Hex, type PublicClient } from 'viem';

export type Verdict = 'PASS' | 'FAIL' | 'UNVERIFIED';
export type RevertKind =
  | 'EXPECTED_REVERT' | 'WRONG_ERROR' | 'WRONG_ARGUMENTS' | 'UNEXPECTED_SUCCESS'
  | 'NO_REVERT_DATA' | 'MALFORMED_REVERT_DATA' | 'AMBIGUOUS_REVERT_DATA' | 'TRANSPORT_ERROR';
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

const VERDICT: Record<RevertKind, Verdict> = {
  EXPECTED_REVERT: 'PASS', WRONG_ERROR: 'FAIL', WRONG_ARGUMENTS: 'FAIL', UNEXPECTED_SUCCESS: 'FAIL',
  NO_REVERT_DATA: 'UNVERIFIED', MALFORMED_REVERT_DATA: 'UNVERIFIED', AMBIGUOUS_REVERT_DATA: 'UNVERIFIED', TRANSPORT_ERROR: 'UNVERIFIED',
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
 * Simulate `data` from `from` to `to` at one pinned block and verify it reverts with `expected`. The
 * raw `eth_call` request keeps the provider's error object intact. UNVERIFIED outcomes are retried up to
 * `attempts` times at the same block; FAIL outcomes are returned at once.
 */
export async function verifyExpectedRevert(p: {
  rpc: PublicClient; from: Address; to: Address; data: Hex; expected: ExpectedError; blockNumber?: bigint; attempts?: number; retryDelayMs?: number;
}) {
  const chainId = await p.rpc.getChainId();
  const block = p.blockNumber !== undefined ? await p.rpc.getBlock({ blockNumber: p.blockNumber }) : await p.rpc.getBlock({ blockTag: 'latest' });
  const max = Math.max(1, p.attempts ?? 3);
  const attempts: { attempt: number; kind: RevertKind; diagnostic?: string }[] = [];
  for (let attempt = 1; ; attempt++) {
    let error: unknown;
    try {
      await p.rpc.request({ method: 'eth_call', params: [{ from: p.from, to: p.to, data: p.data }, toHex(block.number!)] } as never);
    } catch (e) {
      error = e ?? new Error('empty rejection');
    }
    const result = classifyRevert(error, p.expected);
    attempts.push({ attempt, kind: result.kind, ...(error ? { diagnostic: diagnostic(error) } : {}) });
    if (result.verdict !== 'UNVERIFIED' || attempt >= max) {
      return {
        ...result, chainId, block: { number: block.number, hash: block.hash }, caller: p.from, target: p.to, calldata: p.data,
        expected: { name: p.expected.name, args: p.expected.args }, attempts,
      };
    }
    await new Promise(resolve => setTimeout(resolve, (p.retryDelayMs ?? 1_000) * attempt));
  }
}
