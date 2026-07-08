/**
 * Shared integration-test harness: attach to a real `brain-server` and mint
 * per-test data-plane keys.
 *
 * These helpers back the feature-folder integration suites (`test/encode/`,
 * `test/recall/` …). They are **gated on the environment** so the default
 * offline `vitest` run (no server) still passes: when `BRAIN_SDK_IT_DATA` is
 * unset, {@link itTarget} returns `null` and each suite uses
 * `describe.skipIf(...)`. Boot a server and export the vars with
 * `scripts/it-server.sh up` (see that script's header), then re-run.
 *
 * Auth is mandatory and the credential is the whole identity: every test mints
 * a fresh `brain_` token bound to `(namespace, agentId)` via the admin plane
 * (`POST /v1/api-keys`) and connects with it, so isolation is real.
 */

import { BrainClient, newId } from "../../src/client.js";
import type { Auth } from "../../src/client.js";
import type { RecallAnswer, RecallRequest } from "../../src/wire/types.js";

/** How long {@link recallUntil} polls before giving up. ENCODE is durable on
 * ack but the semantic index becomes searchable a beat later. */
export const VISIBILITY_TIMEOUT_MS = 5000;

export interface ItTarget {
  dataHost: string;
  dataPort: number;
  adminHost: string;
  adminPort: number;
  adminSecret: string;
  namespace: string;
}

/** Read the integration target from the environment, or `null` when it is not
 * configured (so the suite skips cleanly offline). */
export function itTarget(): ItTarget | null {
  const data = process.env.BRAIN_SDK_IT_DATA;
  if (!data) return null;
  const [dataHost, dataPort] = splitHostPort(data);
  const [adminHost, adminPort] = splitHostPort(process.env.BRAIN_SDK_IT_ADMIN ?? "127.0.0.1:19092");
  return {
    dataHost,
    dataPort,
    adminHost,
    adminPort,
    adminSecret: process.env.BRAIN_SDK_IT_ADMIN_SECRET ?? "sdk-it-admin-secret",
    namespace: process.env.BRAIN_SDK_IT_NAMESPACE ?? "sdk-it",
  };
}

function splitHostPort(s: string): [string, number] {
  const i = s.lastIndexOf(":");
  return [s.slice(0, i), Number(s.slice(i + 1))];
}

function hex(id: Uint8Array): string {
  return Array.from(id, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Mint a FULL data-plane token bound to `(namespace, agentId)`. */
export async function mint(t: ItTarget, agentId: Uint8Array): Promise<string> {
  const res = await fetch(`http://${t.adminHost}:${t.adminPort}/v1/api-keys`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${t.adminSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agent_id_hex: hex(agentId),
      namespace: t.namespace,
      permissions: ["FULL"],
    }),
  });
  const text = await res.text();
  if (res.status !== 201) throw new Error(`admin mint failed (${res.status}): ${text}`);
  const secret = JSON.parse(text).secret as string | undefined;
  if (!secret) throw new Error(`mint response carries no secret: ${text}`);
  return secret;
}

/** Mint a token for `agentId` and connect a client as that agent. */
export async function connectAs(t: ItTarget, agentId: Uint8Array): Promise<BrainClient> {
  const token = await mint(t, agentId);
  const auth: Auth = { kind: "token", token: new TextEncoder().encode(token) };
  return BrainClient.connect(t.dataHost, t.dataPort, { auth });
}

/** Mint + connect as a brand-new random agent. */
export async function connectFresh(
  t: ItTarget,
): Promise<{ client: BrainClient; agentId: Uint8Array }> {
  const agentId = newId();
  return { client: await connectAs(t, agentId), agentId };
}

/**
 * Poll RECALL until `pred` holds or `timeoutMs` elapses, returning the final
 * answer. ENCODE is durable the instant it acks, but the semantic index
 * becomes *searchable* a beat later, so read-your-writes against the retrieval
 * path needs a short poll — centralized here so a visibility lag never shows up
 * as a flaky assertion.
 */
export async function recallUntil(
  client: BrainClient,
  req: RecallRequest,
  pred: (a: RecallAnswer) => boolean,
  timeoutMs = VISIBILITY_TIMEOUT_MS,
): Promise<RecallAnswer> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answer = await client.recall(req);
    if (pred(answer) || Date.now() >= deadline) return answer;
    await new Promise((r) => setTimeout(r, 150));
  }
}
