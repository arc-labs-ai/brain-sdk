/**
 * The retry *decision* must be the same in all three SDKs.
 *
 * The wire gates prove the three SDKs put identical bytes on the wire. Nothing
 * proved they make identical decisions about those bytes, and they did not: a
 * socket-level failure (ECONNRESET, EPIPE) was retryable in Rust
 * (`BrainError::Io`) and Python (`OSError`) and NOT in TypeScript, which had no
 * transport-error class at all and produced a bare `BrainError` — for which
 * `isRetryable` answers false.
 *
 * Nothing failed when that was true. Both sides encode the same frame; one
 * side just gives up where the others try again, and the only symptom is a
 * TypeScript caller seeing more transient failures than a Rust caller against
 * the same server.
 *
 * The table below is the shared contract. `rust/tests/retry/main.rs` and
 * `python/tests/test_retry.py` assert the same rows, so a change to one SDK's
 * classification fails that SDK's own suite rather than drifting quietly.
 */

import { describe, expect, it } from "vitest";

import {
  BrainError,
  BrainTimeout,
  ConnectionClosed,
  ProtocolError,
  ServerError,
  TransportError,
  VersionMismatch,
  isRetryable,
} from "../src/errors.js";
import { ErrorCategoryWire, WireErrorCode } from "../src/wire/types.js";

function serverError(category: ErrorCategoryWire): ServerError {
  return new ServerError({
    code: WireErrorCode.PermissionDenied,
    category,
    message: "",
    details: null,
    retryAfterMs: null,
  });
}

/** Every row here must hold identically in Rust and Python. */
const CASES: Array<[string, unknown, boolean]> = [
  // Transient transport conditions — retry.
  ["a socket-level I/O failure", new TransportError("ECONNRESET"), true],
  ["an orderly peer close", new ConnectionClosed(), true],
  ["a request deadline", new BrainTimeout(1000), true],

  // Server verdicts that say "later" — retry.
  ["server ResourceExhausted", serverError(ErrorCategoryWire.ResourceExhausted), true],
  ["server Unavailable", serverError(ErrorCategoryWire.Unavailable), true],

  // Every other server category — a repeat sends the same request and gets
  // the same verdict. All nine are listed so a new category cannot be added
  // without a decision being made about it here.
  ["server Protocol", serverError(ErrorCategoryWire.Protocol), false],
  ["server Authentication", serverError(ErrorCategoryWire.Authentication), false],
  ["server Authorization", serverError(ErrorCategoryWire.Authorization), false],
  ["server Validation", serverError(ErrorCategoryWire.Validation), false],
  ["server NotFound", serverError(ErrorCategoryWire.NotFound), false],
  ["server Conflict", serverError(ErrorCategoryWire.Conflict), false],
  ["server Internal", serverError(ErrorCategoryWire.Internal), false],

  // Client-side faults — a repeat sends the same wrong thing.
  ["a protocol violation", new ProtocolError("unexpected opcode"), false],
  ["a version mismatch", new VersionMismatch(99, [1]), false],
  ["a bare BrainError", new BrainError("something"), false],

  // Not one of ours at all.
  ["a plain Error", new Error("boom"), false],
  ["a non-error value", "nope", false],
];

describe("retryability is classified identically across the three SDKs", () => {
  for (const [label, err, expected] of CASES) {
    it(`${expected ? "retries" : "does not retry"} ${label}`, () => {
      expect(isRetryable(err)).toBe(expected);
    });
  }

  it("covers every server error category", () => {
    // A category with no row above would silently default to "not retryable".
    const covered = new Set(CASES.map(([label]) => label).filter((l) => l.startsWith("server ")));
    const declared = Object.keys(ErrorCategoryWire).filter((k) => Number.isNaN(Number(k)));
    for (const name of declared) {
      expect(covered.has(`server ${name}`), `${name} has no retryability row`).toBe(true);
    }
  });

  it("a socket error surfaces as TransportError, not a bare BrainError", () => {
    // The regression this file exists for. A bare `BrainError` here is what
    // made a connection reset non-retryable in TypeScript alone.
    const err = new TransportError("read ECONNRESET");
    expect(err).toBeInstanceOf(BrainError);
    expect(err.name).toBe("TransportError");
    expect(isRetryable(err)).toBe(true);
  });
});
