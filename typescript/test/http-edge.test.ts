/** Opt-in integration tests against a running Brain HTTP edge. */
import { describe, expect, it } from "vitest";

import { BrainHttpClient } from "../src/http/index.js";

function clientOrSkip(skip: () => void): BrainHttpClient {
  const baseUrl = process.env.BRAIN_SDK_IT_HTTP;
  const apiKey = process.env.BRAIN_SDK_IT_HTTP_KEY ?? process.env.BRAIN_SDK_IT_API_KEY;
  if (!baseUrl || !apiKey) {
    const message =
      "live edge tests require BRAIN_SDK_IT_HTTP and BRAIN_SDK_IT_HTTP_KEY " +
      "(or BRAIN_SDK_IT_API_KEY)";
    if (process.env.BRAIN_SDK_IT_REQUIRED === "1") throw new Error(message);
    skip();
  }
  return new BrainHttpClient({ apiKey: apiKey!, baseUrl: baseUrl! });
}

describe("live Brain HTTP edge", () => {
  it("checks identity and capabilities", async ({ skip }) => {
    const client = clientOrSkip(skip);
    const [identity, capabilities] = await Promise.all([client.whoami(), client.capabilities()]);

    expect(identity.namespace).not.toBe("");
    expect(identity.spaceId).not.toBe("");
    expect(capabilities.vectorDim).toBeGreaterThan(0);
    expect(Array.isArray(capabilities.schemaNamespaces)).toBe(true);
  });

  it("round-trips a memory through encode, recall, list, and forget", async ({ skip }) => {
    const client = clientOrSkip(skip);
    const text = `brain-sdk live edge integration ${crypto.randomUUID()}`;
    const encoded = await client.encode({ text });
    expect(encoded.memoryId).not.toBe("");

    try {
      const recalled = await client.recall({ query: text, maxResults: 5 });
      expect(Array.isArray(recalled.memories)).toBe(true);
      const page = await client.memoryList({ limit: 100 });
      expect(page.items.some((item) => item.memoryId === encoded.memoryId)).toBe(true);
    } finally {
      const forgotten = await client.forget({ memoryId: encoded.memoryId });
      expect(forgotten.memoryId).toBe(encoded.memoryId);
    }
  });
});
