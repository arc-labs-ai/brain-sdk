/**
 * Feature: handshake + mandatory auth (integration, real server).
 *
 * Gated on `BRAIN_SDK_IT_DATA` (see `scripts/it-server.sh`); skips offline.
 */

import { describe, expect, it } from "vitest";

import { BrainClient, newId } from "../../src/client.js";
import { connectAs, connectFresh, itTarget } from "../common/harness.js";

const T = itTarget();

describe.skipIf(T === null)("handshake (integration)", () => {
  const t = T!;

  it("minted token resolves the session identity", async () => {
    const agent = newId();
    const client = await connectAs(t, agent);
    try {
      const s = client.connection;
      // The server derives identity from the credential.
      expect([...s.spaceId]).toEqual([...agent]);
      expect(s.namespace).toBe(t.namespace);
      expect(s.chosenVersion).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("two agents get distinct sessions in the same tenant", async () => {
    const a = await connectFresh(t);
    const b = await connectFresh(t);
    try {
      expect([...a.spaceId]).not.toEqual([...b.spaceId]);
      expect([...a.client.connection.spaceId]).toEqual([...a.spaceId]);
      expect([...b.client.connection.spaceId]).toEqual([...b.spaceId]);
      expect(a.client.connection.namespace).toBe(b.client.connection.namespace);
    } finally {
      await a.client.close();
      await b.client.close();
    }
  });

  it("an unminted token is refused", async () => {
    // A token the server never minted must not resolve to a session. Assert
    // the specific rejection, not a bare `toThrow()`: that would also pass on
    // a connection refusal or a codec bug, which is the opposite of what this
    // is checking.
    const bogus = { kind: "token" as const, token: new TextEncoder().encode("brain_not-a-real-key") };
    await expect(
      BrainClient.connect(t.dataHost, t.dataPort, { auth: bogus }),
    ).rejects.toThrow(/unknown API key/);
  });
});
