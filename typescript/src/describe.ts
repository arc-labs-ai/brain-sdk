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
export function describeThrown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return String(value);
  try {
    return JSON.stringify(value) ?? Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
