import { describe, expect, it } from "vitest";

import { deriveSpaceId } from "../src/index.js";

function toUuidString(b: Uint8Array): string {
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

describe("deriveSpaceId", () => {
  it("matches the server's frozen golden vector", () => {
    // The same vector brain-core pins: client and server must agree, or a
    // space string would resolve to different storage ids on each side.
    const id = deriveSpaceId("acme", "support-bot:user123");
    expect(toUuidString(id)).toBe("119061cc-b6db-5cde-8edd-0cefa33452eb");
  });

  it("diverges the same space string across namespaces", () => {
    expect(deriveSpaceId("ns_a", "u1")).not.toEqual(deriveSpaceId("ns_b", "u1"));
  });
});
