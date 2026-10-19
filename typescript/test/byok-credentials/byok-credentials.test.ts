/**
 * BYOK credential error contract.
 *
 * The wire codes and their retry classification are a cross-SDK contract: all
 * three SDKs must agree, and the classification is what decides whether a
 * client hammers an endpoint that can never succeed. These tests pin it on the
 * TypeScript side; `rust/src/wire/types.rs` and
 * `python/tests/test_byok_credentials.py` pin the same facts.
 */
import { describe, it, expect } from "vitest";

import {
  ServerError,
  isLlmCredentialMissing,
  isLlmCredentialUnavailable,
  isRetryable,
} from "../../src/errors.js";
import { ErrorCategoryWire, WireErrorCode } from "../../src/wire/types.js";

function serverError(code: number, category: ErrorCategoryWire): ServerError {
  return new ServerError({
    code,
    category,
    message: "test",
    details: null,
    retryAfterMs: null,
  });
}

describe("BYOK credential errors", () => {
  it("pins the wire code values", () => {
    // The numeric block assigns the category, so moving one silently changes
    // whether clients retry it.
    expect(WireErrorCode.LlmCredentialMissing).toBe(0x0066);
    expect(WireErrorCode.LlmCredentialUnavailable).toBe(0x0095);
  });

  it("identifies a missing provider credential", () => {
    const err = serverError(WireErrorCode.LlmCredentialMissing, ErrorCategoryWire.Conflict);
    expect(isLlmCredentialMissing(err)).toBe(true);
    expect(isLlmCredentialUnavailable(err)).toBe(false);
  });

  it("identifies a transient credential-resolution failure", () => {
    const err = serverError(WireErrorCode.LlmCredentialUnavailable, ErrorCategoryWire.Unavailable);
    expect(isLlmCredentialUnavailable(err)).toBe(true);
    expect(isLlmCredentialMissing(err)).toBe(false);
  });

  it("treats missing as terminal and unavailable as retryable", () => {
    // The whole reason the two codes exist separately. Collapsing them either
    // retries a condition that cannot self-heal, or permanently fails a write
    // whose tenant has a perfectly good key.
    const missing = serverError(WireErrorCode.LlmCredentialMissing, ErrorCategoryWire.Conflict);
    const unavailable = serverError(
      WireErrorCode.LlmCredentialUnavailable,
      ErrorCategoryWire.Unavailable,
    );
    expect(isRetryable(missing)).toBe(false);
    expect(isRetryable(unavailable)).toBe(true);
  });

  it("does not misidentify an unrelated error", () => {
    const other = serverError(WireErrorCode.ActAsDenied, ErrorCategoryWire.Authorization);
    expect(isLlmCredentialMissing(other)).toBe(false);
    expect(isLlmCredentialUnavailable(other)).toBe(false);
  });
});
