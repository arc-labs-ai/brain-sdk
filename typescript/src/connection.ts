/**
 * The handshake outcome shared across the connection layer.
 *
 * There is one connection type — the multiplexed {@link MuxConnection}, which
 * runs its own handshake on stream 0 and returns this outcome. This module
 * holds only the result shape so both the mux and the high-level client can
 * name it without a cycle.
 */

import type { AuthOkPayload, WelcomePayload } from "./wire/types.js";

/** What the server told us during the handshake: the WELCOME and AUTH_OK. */
export interface HandshakeOutcome {
  welcome: WelcomePayload;
  authOk: AuthOkPayload;
}
