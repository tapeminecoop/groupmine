/**
 * Internal security review (f2c8e50), workstream D: proposed replacement for the canary runner's
 * negative-test matcher (scripts/canary/workflow.ts, `rejected`). The frozen runner tests a revert only
 * by searching the human-readable viem error message for the expected custom-error selector, which
 * depends on where the RPC puts the revert bytes. This helper decides on the revert *bytes* and
 * classifies every other outcome so that an unexpected exception can never pass a negative test.
 */
import { BaseError, keccak256, stringToHex, type Hex } from 'viem';

export type NegativeOutcome =
  | { kind: 'EXPECTED_REVERT'; selector: Hex; data: Hex; source: 'structured' | 'text' }
  | { kind: 'UNEXPECTED_REVERT'; selector: Hex; data: Hex; source: 'structured' | 'text' }
  | { kind: 'REVERT_UNVERIFIABLE'; details: string }
  | { kind: 'TRANSPORT_OR_OTHER_ERROR'; message: string }
  | { kind: 'DID_NOT_REVERT' };

export const selectorOf = (signature: string): Hex => keccak256(stringToHex(signature)).slice(0, 10) as Hex;

const isRevertBytes = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(v);

/** Revert bytes from the JSON-RPC error object, wherever viem kept them (error.data, error.data.data, any cause). */
export function structuredRevertData(error: unknown): Hex | undefined {
  if (!(error instanceof BaseError)) return undefined;
  let found: Hex | undefined;
  error.walk(e => {
    const d = (e as { data?: unknown }).data;
    if (isRevertBytes(d)) found = d;
    else if (d && typeof d === 'object' && isRevertBytes((d as { data?: unknown }).data)) found = (d as { data: Hex }).data;
    return found !== undefined;
  });
  return found;
}

/** Nodes that put the bytes into the error text only (Anvil, Hardhat): read them from the node's own
 *  message (`details`), never from viem's full message, which also prints the call's own calldata. */
export function textRevertData(error: unknown): Hex | undefined {
  const details = error instanceof BaseError ? error.details : error instanceof Error ? error.message : String(error);
  const custom = /custom error (0x[0-9a-fA-F]{8})(?::\s*([0-9a-fA-F]*))?/.exec(details);
  if (custom) return `${custom[1]}${custom[2] ?? ''}` as Hex;
  const generic = /revert(?:ed)?[^0-9a-fA-Fx]*?(0x[0-9a-fA-F]{8,})/i.exec(details);
  return generic ? (generic[1] as Hex) : undefined;
}

export function classifyNegative(error: unknown, expectedSignature: string): NegativeOutcome {
  if (error === undefined) return { kind: 'DID_NOT_REVERT' };
  const expected = selectorOf(expectedSignature);
  const structured = structuredRevertData(error);
  const data = structured ?? textRevertData(error);
  if (data) {
    const selector = data.slice(0, 10).toLowerCase() as Hex;
    const source = structured ? 'structured' : 'text';
    return selector === expected ? { kind: 'EXPECTED_REVERT', selector, data, source } : { kind: 'UNEXPECTED_REVERT', selector, data, source };
  }
  const details = error instanceof BaseError ? error.details : '';
  const message = error instanceof Error ? error.message : String(error);
  if (/revert/i.test(details) || /revert/i.test(message)) return { kind: 'REVERT_UNVERIFIABLE', details: details || message };
  return { kind: 'TRANSPORT_OR_OTHER_ERROR', message };
}

/** The frozen runner's decision, reproduced from scripts/canary/workflow.ts (`rejected`) and
 *  scripts/canary/common.ts (`redact`): true only when the viem message mentions a revert and contains
 *  the expected selector as text. */
export function frozenRunnerDecision(error: unknown, expectedSignature: string): boolean {
  let reason = error === undefined ? '' : error instanceof Error ? error.message : String(error);
  reason = reason.replace(/https?:\/\/[^\s"'<>]+/g, '[REDACTED_RPC]').slice(0, 3000);
  return /revert/i.test(reason) && reason.toLowerCase().includes(selectorOf(expectedSignature));
}
