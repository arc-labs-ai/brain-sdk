/** Live wire round-trip for namespace-scoped BYOK credential lifecycle. */

import { describe, expect, it } from "vitest";

import { newId } from "../../src/client.js";
import { connectFresh, itLoopbackEnabled, itTarget } from "../common/harness.js";

const T = itTarget();
const FAKE_KEY = "sk-fake-DO-NOT-USE";

function assertRedacted(response: unknown): void {
  const serialized = JSON.stringify(response, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  expect(serialized).not.toContain(FAKE_KEY);
}

describe.skipIf(T === null || !itLoopbackEnabled())(
  "BYOK credential lifecycle (integration; requires BRAIN_SDK_IT_LOOPBACK=1 and the runner to share the server network namespace because plaintext provider keys are accepted only over loopback, TLS, or mTLS)",
  () => {
    const t = T!;

    it("round-trips a credential without exposing its key", async () => {
      const namespace = `sdk-byok-${crypto.randomUUID()}`;
      // The plaintext PUT is accepted only when the server sees the runner as a
      // loopback peer; a published container port is not sufficient.
      const { client } = await connectFresh(t, namespace);

      try {
        const absent = await client.getLlmCredential({ actAs: null });
        assertRedacted(absent);
        expect(absent.credential).toBeNull();

        const put = await client.putLlmCredential({
          provider: "openai",
          model: "gpt-4o-mini",
          apiKey: FAKE_KEY,
          requestId: newId(),
          actAs: null,
        });
        assertRedacted(put);
        expect(put.provider).toBe("openai");
        expect(put.model).toBe("gpt-4o-mini");
        expect(put.fingerprint).toBe(`…${FAKE_KEY.slice(-4)}`);
        expect(put.fingerprint).not.toBe(FAKE_KEY);
        expect(put.fingerprint.length).toBeLessThan(FAKE_KEY.length);

        const installed = await client.getLlmCredential({ actAs: null });
        assertRedacted(installed);
        expect(installed.credential).not.toBeNull();
        expect(installed.credential).toMatchObject({
          provider: "openai",
          model: "gpt-4o-mini",
          fingerprint: put.fingerprint,
        });
        expect(installed.credential?.fingerprint).toBe(`…${FAKE_KEY.slice(-4)}`);
        expect(installed.credential?.fingerprint).not.toBe(FAKE_KEY);
        expect(installed.credential?.fingerprint.length).toBeLessThan(FAKE_KEY.length);

        const verified = await client.verifyLlmCredential({
          requestId: newId(),
          actAs: null,
        });
        assertRedacted(verified);
        expect(verified).toHaveProperty("outcome");
        expect(verified.outcome).not.toBe("ok");

        const deleted = await client.deleteLlmCredential({ requestId: newId(), actAs: null });
        assertRedacted(deleted);
        expect(deleted.existed).toBe(true);

        const deletedAgain = await client.deleteLlmCredential({ requestId: newId(), actAs: null });
        assertRedacted(deletedAgain);
        expect(deletedAgain.existed).toBe(false);

        const absentAgain = await client.getLlmCredential({ actAs: null });
        assertRedacted(absentAgain);
        expect(absentAgain.credential).toBeNull();
      } finally {
        await client.close();
      }
    });
  },
);
