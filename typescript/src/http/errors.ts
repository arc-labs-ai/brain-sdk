/**
 * The one error type the HTTP client raises. Mirrors the Rust `BrainHttpError`
 * and the Python `BrainHttpError`: `status` + `code` + `message`.
 */
export class BrainHttpError extends Error {
  /** HTTP status (or `0` for a transport failure). */
  readonly status: number;
  /** Stable error code from the edge (`"transport"` for network failures). */
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BrainHttpError";
    this.status = status;
    this.code = code;
  }
}
