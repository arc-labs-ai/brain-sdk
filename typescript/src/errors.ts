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
  if (err instanceof ConnectionClosed || err instanceof BrainTimeout) return true;
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
export function isActAsDenied(err: unknown): boolean {
  // `code` is deliberately `number`, not `WireErrorCode`: a newer server may
  // send a code this SDK does not declare, and typing the field as the enum
  // would assert otherwise. Comparing the two is the intended use.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
  return err instanceof ServerError && err.code === WireErrorCode.ActAsDenied;
}
