import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * The default 5s is fine for the offline suites — corpus round-trips and
     * codec checks run in single-digit milliseconds. It is not fine for the
     * integration suites, which mint an API key over HTTP, open a TCP
     * connection, complete a handshake and run several round-trips against one
     * shared Brain, while vitest runs test *files* in parallel across every
     * core.
     *
     * Under that contention the work still completes, just not within 5s, and
     * the failure surfaces as an opaque `STACK_TRACE_ERROR` with no hint that a
     * timeout is what happened. Observed as roughly a 1-in-5 red run with a
     * different integration file failing each time — which is the worst kind of
     * flake, because it trains you to re-run instead of look.
     *
     * 30s is well clear of the observed worst case without being so long that a
     * genuinely hung test stalls the suite.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
