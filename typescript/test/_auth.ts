/**
 * Shared auth fixtures for the mock-server tests.
 *
 * Auth is mandatory: every connect needs a credential. The mock servers no
 * longer echo a client-sent agent id (the client doesn't send one); instead
 * they ASSIGN one. `SERVER_AGENT_ID` is byte 0x22 to match the conformance
 * golden's `resp_auth_ok` agent id.
 */

import type { Auth } from "../src/client.js";

/** A throwaway bearer token good enough for the mock servers. */
export const TEST_AUTH: Auth = {
  kind: "token",
  token: new TextEncoder().encode("opaque-token"),
};

/** The agent id the mock servers assign in AUTH_OK (matches the golden). */
export const SERVER_AGENT_ID = new Uint8Array(16).fill(0x22);
