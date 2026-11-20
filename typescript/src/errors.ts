/**
 * Client error taxonomy.
 *
 * Every connection operation rejects with a `BrainError` (or a subclass) on
 * failure. The subclasses separate the layers a caller reacts to differently:
 * a protocol-sequence violation, a structured error the server returned,
 * version negotiation failure, a clean peer close, and a timeout. Frame-codec
 * failures keep throwing `FrameError` from the wire layer (a corrupt frame is
 * fatal for the connection). `isRetryable` reads the server category so a
 * future retry policy can branch on it.
 */

import { ErrorCategoryWire, WireErrorCode, type ErrorResponse } from "./wire/types.js";

/** Base class for every client-side failure. */
export class BrainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrainError";
  }
}

/**
 * The peer broke the protocol sequence — e.g. an unexpected opcode where the
 * handshake expects WELCOME, or a response on an unknown stream.
 */
export class ProtocolError extends BrainError {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/**
 * A socket-level I/O failure — a reset, a broken pipe, a DNS or connect error.
 *
 * Distinct from {@link ConnectionClosed}, which is an orderly close. This is
 * the counterpart of Rust's `BrainError::Io` and Python's `OSError`, both of
 * which their `is_retryable` treats as transient. TypeScript had no such class:
 * a socket `error` event became a bare {@link BrainError}, which
 * {@link isRetryable} answers `false` for — so an ECONNRESET mid-request was
 * retried by two SDKs and not by this one.
 */
export class TransportError extends BrainError {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

/** The peer closed the connection. */
export class ConnectionClosed extends BrainError {
  constructor(message = "connection closed by peer") {
    super(message);
    this.name = "ConnectionClosed";
  }
}

/** An operation did not complete within its deadline. */
export class BrainTimeout extends BrainError {
  constructor(public readonly timeoutMs: number) {
    super(`operation timed out after ${timeoutMs}ms`);
    this.name = "BrainTimeout";
  }
}

/** The server chose a wire version the client did not offer. */
export class VersionMismatch extends BrainError {
  constructor(
    public readonly chosen: number,
    public readonly supported: number[],
  ) {
    super(`version mismatch: server chose ${chosen}, client supports [${supported.join(", ")}]`);
    this.name = "VersionMismatch";
  }
}

/**
 * The server returned a structured ERROR frame. The full payload is preserved
 * for code/category branching and `retryAfterMs`.
 */
export class ServerError extends BrainError {
  readonly code: number;
  readonly category: ErrorCategoryWire;
  readonly retryAfterMs: number | null;
  readonly response: ErrorResponse;

  constructor(response: ErrorResponse) {
    super(
      `server error [code=0x${response.code.toString(16).padStart(4, "0")} ` +
        `category=${response.category}]: ${response.message}`,
    );
    this.name = "ServerError";
    this.code = response.code;
    this.category = response.category;
    this.retryAfterMs = response.retryAfterMs;
    this.response = response;
  }
}

/**
 * Whether retrying the operation could plausibly succeed. A transient
 * transport drop or timeout, or a resource-exhaustion / unavailable server
 * verdict, is retryable; a malformed-input or auth verdict is not. This is the
 * category signal the `withRetry` combinator consults.
 */
export function isRetryable(err: unknown): boolean {
  if (
    err instanceof ConnectionClosed ||
    err instanceof BrainTimeout ||
    // Matches Rust's `BrainError::Io` and Python's `OSError` arms.
    err instanceof TransportError
  ) {
    return true;
  }
  if (err instanceof ServerError) {
    return (
      err.category === ErrorCategoryWire.ResourceExhausted ||
      err.category === ErrorCategoryWire.Unavailable
    );
  }
  return false;
}

/**
 * Whether the failure is an `act_as` authorization denial (`ActAsDenied`,
 * `0x0033`): the connection principal lacks the `canActAs` grant, or the
 * requested `act_as` namespace is outside its allowlist. Never retryable —
 * the fix is a differently-scoped credential, not a repeat. Lets a pooled
 * multi-tenant caller distinguish this from an ordinary permission denial.
 */
/**
 * Whether the failure is a missing BYOK provider credential
 * (`LlmCredentialMissing`, `0x0066`): the write's namespace has no LLM
 * provider key registered.
 *
 * **Never retryable** — retrying cannot create a key. Brain refuses the write
 * rather than storing a memory it cannot ground, because HyPE and extraction
 * are mandatory; an admitted write would land as text with no questions,
 * entities or statements and recall would quietly degrade. Surface this to the
 * operator as "register a provider key", not as a transient failure.
 */
export function isLlmCredentialMissing(err: unknown): boolean {
  // See `isActAsDenied` for why `code` is compared as a plain number.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
  return err instanceof ServerError && err.code === WireErrorCode.LlmCredentialMissing;
}

/**
 * Whether the failure is a transient BYOK credential-resolution failure
 * (`LlmCredentialUnavailable`, `0x0095`): the credential broker was
 * unreachable or timed out.
 *
 * **Retryable**, unlike {@link isLlmCredentialMissing}. Treating the two the
 * same would either hammer an endpoint that can never succeed, or permanently
 * fail a write whose tenant has a perfectly good key.
 */
export function isLlmCredentialUnavailable(err: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
  return err instanceof ServerError && err.code === WireErrorCode.LlmCredentialUnavailable;
}

/**
 * Whether the shard's write-ahead log has latched into a terminal faulted
 * state (`ShardStorageFaulted`, `0x00A0`, category `OperatorIntervention`).
 *
 * **Terminal, and not transient.** The shard keeps answering this way until
 * its process is restarted, so retrying cannot make progress — only operator
 * action clears it. {@link isRetryable} already returns `false` for it,
 * because that function is an allowlist over `ResourceExhausted` and
 * `Unavailable`.
 *
 * Deliberately distinct from the `Unavailable`-category shard errors
 * (`ShardUnavailable` / `Restarting` / `Maintenance`), which *do* clear on
 * their own. Surface this one to a human as an outage needing attention
 * rather than as a blip, and do not fold it into a generic "server busy" path.
 */
export function isShardStorageFaulted(err: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
  return err instanceof ServerError && err.code === WireErrorCode.ShardStorageFaulted;
}

/**
 * For a validation refusal, the name of the request field the server rejected
 * — `"text"`, `"vector"`, and so on — or `null` when this is not an
 * `InvalidArgument` or the server named no field.
 *
 * `InvalidArgument` (`0x0040`) is now the *only* code for a field-level
 * refusal. Nine narrower codes used to carry that information in the code
 * itself and were removed; the conditions they named now arrive as
 * `InvalidArgument` with `ErrorDetails.field`: `"text"` for an empty or
 * oversize text, `"kind"` for a client-supplied memory kind,
 * `"vector"` for a wrong dimension, non-finite value or wrong L2 norm,
 * `"model_fingerprint"` for a mismatch, and the budget's own field name for
 * an out-of-range plan or reason budget.
 *
 * So code that read `if (err.code === WireErrorCode.TextTooLarge)` becomes
 * `if (invalidField(err) === "text")`. Treat the set of field names as open:
 * match the ones you handle and fall back to the message for the rest, rather
 * than assuming that list is exhaustive forever.
 */
export function invalidField(err: unknown): string | null {
  if (!(err instanceof ServerError)) return null;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
  if (err.code !== WireErrorCode.InvalidArgument) return null;
  return err.response.details?.field ?? null;
}

export function isActAsDenied(err: unknown): boolean {
  // `code` is deliberately `number`, not `WireErrorCode`: a newer server may
  // send a code this SDK does not declare, and typing the field as the enum
  // would assert otherwise. Comparing the two is the intended use.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
  return err instanceof ServerError && err.code === WireErrorCode.ActAsDenied;
}
