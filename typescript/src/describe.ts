/**
 * Rendering a thrown value for an error message.
 *
 * Its own module because both tiers need it and they must not need each
 * other: the HTTP tier runs wherever `fetch` does, including runtimes with no
 * `node:net` and no `node:crypto`, and this was the single symbol that made
 * `src/http/**` reach back into the socket transport. One import is enough to
 * drag `transport.d.ts` — and its `node:net` type reference — into the type
 * graph of a consumer that only ever wanted the HTTP client.
 */

/**
 * Render a non-`Error` thrown value for a message.
 *
 * `String(value)` collapses every object to the literal `[object Object]`,
 * which is the whole content of the message when a codec failure has already
 * desynchronized the stream and the thrown value is the only clue left.
 */
export function describeThrown(value: unknown, depth = 0): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return String(value);

  // Errors first, and this is the case that matters most: `JSON.stringify` of
  // an Error is the literal `{}`, because `name`, `message` and `stack` are all
  // non-enumerable. Falling through to the stringify below therefore threw away
  // the entire message — swapping `[object Object]` for `{}` and keeping none
  // of the detail this function exists to preserve.
  //
  // Duck-typed rather than `instanceof Error`, which is false for an Error from
  // another realm (a worker, a vm context) — exactly where a confusing message
  // is hardest to chase.
  const err = value as { name?: unknown; message?: unknown; cause?: unknown };
  if (typeof err.message === "string" && typeof err.name === "string") {
    const head = err.message ? `${err.name}: ${err.message}` : err.name;
    // `fetch` reports every transport failure as `TypeError: fetch failed` and
    // puts the real reason — refused connection, bad header value, DNS — in
    // `cause`. Without this the useful half is the half that is dropped.
    // Depth-bounded because a cause chain can be cyclic.
    if (err.cause != null && depth < 3) {
      return `${head} (cause: ${describeThrown(err.cause, depth + 1)})`;
    }
    return head;
  }

  try {
    return JSON.stringify(value) ?? Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
