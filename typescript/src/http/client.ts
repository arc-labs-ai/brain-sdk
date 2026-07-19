/**
 * {@link BrainHttpClient} — the HTTP tier of the Brain SDK.
 *
 * Talks JSON to the Brain HTTP edge (`brain-edge` self-hosted, or the Arc cloud
 * gateway). Same verb surface and field names as the Rust and Python HTTP
 * clients. For the native wire protocol (streaming, transactions, typed-graph
 * management), use {@link BrainClient} instead.
 */
import { BrainHttpError } from "./errors.js";
import type {
  Capabilities,
  EncodeInput,
  EncodeResult,
  ForgetInput,
  ForgetResult,
  LinkInput,
  LinkResult,
  PlanInput,
  PlanResult,
  ReasonInput,
  ReasonResult,
  RecallInput,
  RecallResult,
  UnlinkInput,
  UnlinkResult,
  Whoami,
} from "./types.js";

/**
 * Retry policy for the HTTP tier — applied only to idempotent verbs (`encode`,
 * `whoami`, `capabilities`). Transport/timeout errors (`status === 0`) and HTTP
 * `503` responses are retried; every other status — including all `4xx` — is
 * terminal. The backoff grows exponentially from `baseDelayMs` (100ms, 200ms,
 * …), capped at `maxDelayMs`; a server `Retry-After` hint overrides it.
 */
export interface HttpRetryPolicy {
  /** Total attempts including the first. `1` disables retry. */
  maxAttempts: number;
  /** First backoff; doubles each subsequent attempt (milliseconds). */
  baseDelayMs: number;
  /** Upper bound on any single backoff (also caps a server `Retry-After`). */
  maxDelayMs: number;
}

/** The default HTTP retry policy: 3 attempts, 100ms base backoff, 2s cap. */
export const DEFAULT_HTTP_RETRY: HttpRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 2000,
};

/** No retry: a single attempt. */
export const NO_HTTP_RETRY: HttpRetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
};

/** Options for {@link BrainHttpClient}. */
export interface BrainHttpClientOptions {
  /** The API key, sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /** Base URL of the edge. Defaults to `http://127.0.0.1:8080` (self-host). */
  baseUrl?: string;
  /** Per-request timeout in milliseconds (default 30_000). */
  timeoutMs?: number;
  /** Retry policy for idempotent verbs. Defaults to {@link DEFAULT_HTTP_RETRY}. */
  retry?: Partial<HttpRetryPolicy>;
  /** Override the `fetch` implementation (defaults to the global). */
  fetch?: typeof fetch;
}

type Method = "GET" | "POST" | "DELETE";

/** A {@link BrainHttpError} that may carry a parsed `Retry-After` hint (ms). */
type ErrorWithRetryAfter = BrainHttpError & { retryAfterMs?: number };

/** Parse a `Retry-After` header expressed as integer seconds, into ms. */
function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const secs = Number.parseInt(header.trim(), 10);
  return Number.isFinite(secs) && String(secs) === header.trim() ? secs * 1000 : undefined;
}

export class BrainHttpClient {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retry: HttpRetryPolicy;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: BrainHttpClientOptions) {
    if (!opts || !opts.apiKey) {
      throw new BrainHttpError(0, "config", "apiKey is required");
    }
    this.base = (opts.baseUrl ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.retry = { ...DEFAULT_HTTP_RETRY, ...(opts.retry ?? {}) };
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) {
      throw new BrainHttpError(0, "config", "no fetch available; pass opts.fetch");
    }
    this.fetchImpl = f;
  }

  /** Store a memory. Idempotent (stable server-side request id) — retried. */
  encode(input: EncodeInput): Promise<EncodeResult> {
    return this.requestWithRetry("POST", "/v1/memories", input);
  }

  /** Recall memories for a cue. */
  recall(input: RecallInput): Promise<RecallResult> {
    return this.requestOnce("POST", "/v1/recall", input);
  }

  /** Forget a memory. */
  forget(input: ForgetInput): Promise<ForgetResult> {
    return this.requestOnce("DELETE", "/v1/memories", input);
  }

  /** Create/overwrite a directed edge between two memories. */
  link(input: LinkInput): Promise<LinkResult> {
    return this.requestOnce("POST", "/v1/links", input);
  }

  /** Remove a directed edge (idempotent). */
  unlink(input: UnlinkInput): Promise<UnlinkResult> {
    return this.requestOnce("DELETE", "/v1/links", input);
  }

  /** Plan a path from a start state to a goal state. */
  plan(input: PlanInput): Promise<PlanResult> {
    return this.requestOnce("POST", "/v1/plan", input);
  }

  /** Infer over the graph from an observation. */
  reason(input: ReasonInput): Promise<ReasonResult> {
    return this.requestOnce("POST", "/v1/reason", input);
  }

  /** The identity Brain resolves from the credential. Idempotent GET — retried. */
  whoami(): Promise<Whoami> {
    return this.requestWithRetry("GET", "/v1/whoami");
  }

  /** What the connected shard supports. Idempotent GET — retried. */
  capabilities(): Promise<Capabilities> {
    return this.requestWithRetry("GET", "/v1/capabilities");
  }

  /** Whether to retry after `attempt` (1-based) produced `err`. */
  private shouldRetry(attempt: number, err: BrainHttpError): boolean {
    return attempt < this.retry.maxAttempts && (err.status === 0 || err.status === 503);
  }

  /** Milliseconds to wait after `attempt` (1-based) failed; a server hint wins. */
  private backoffMs(attempt: number, retryAfterMs: number | undefined): number {
    if (retryAfterMs !== undefined) {
      return Math.min(retryAfterMs, this.retry.maxDelayMs);
    }
    if (this.retry.baseDelayMs <= 0) return 0;
    return Math.min(this.retry.baseDelayMs * 2 ** (attempt - 1), this.retry.maxDelayMs);
  }

  /** Run an idempotent request, retrying `503`/transport per the policy. */
  private async requestWithRetry<T>(method: Method, path: string, body?: unknown): Promise<T> {
    let attempt = 1;
    for (;;) {
      try {
        return await this.requestOnce<T>(method, path, body);
      } catch (e) {
        const err = e as ErrorWithRetryAfter;
        if (err instanceof BrainHttpError && this.shouldRetry(attempt, err)) {
          const delay = this.backoffMs(attempt, err.retryAfterMs);
          await new Promise((resolve) => setTimeout(resolve, delay));
          attempt += 1;
          continue;
        }
        throw e;
      }
    }
  }

  private async requestOnce<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
    };
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, init);
    } catch (e) {
      throw new BrainHttpError(
        0,
        "transport",
        `request to ${this.base}${path} failed: ${(e as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
      let code = "http_error";
      let message = `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
        if (parsed?.error) {
          code = parsed.error.code ?? code;
          message = parsed.error.message ?? message;
        } else if (text) {
          message = text;
        }
      } catch {
        if (text) message = text;
      }
      const err: ErrorWithRetryAfter = new BrainHttpError(res.status, code, message);
      // Attach a server Retry-After hint for the retry scheduler. Not part of
      // the public {status, code, message} shape.
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs;
      throw err;
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
