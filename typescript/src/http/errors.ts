/**
 * The one error type the HTTP client raises. Mirrors the Rust `BrainHttpError`
 * and the Python `BrainHttpError`: `status` + `code` + `message`.
 */
export class BrainHttpError extends Error {
  /** HTTP status (or `0` for a transport failure). */
  readonly status: number;
  /** Stable error code from the edge (`"transport"` for network failures). */
  readonly code: string;
  /** Per-field problems on a validation failure (`422`), when the server
   * reports them — e.g. `{ field: "email", message: "must be a valid email" }`. */
  readonly fieldErrors: ReadonlyArray<{ field: string; code?: string; message: string }>;

  constructor(
    status: number,
    code: string,
    message: string,
    options?: ErrorOptions & {
      fieldErrors?: ReadonlyArray<{ field: string; code?: string; message: string }>;
    },
  ) {
    super(message, options);
    this.name = "BrainHttpError";
    this.status = status;
    this.code = code;
    this.fieldErrors = options?.fieldErrors ?? [];
  }
}
