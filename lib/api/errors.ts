export type ErrorCode =
  | "bad_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid"
  | "rate_limited"
  | "provider_unavailable"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid: 422,
  rate_limited: 429,
  provider_unavailable: 503,
  internal: 500,
};

export interface FieldError {
  path: string;
  message: string;
}

/** An error that is safe to show to the caller. Anything else becomes a generic 500. */
export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly options: { retryable?: boolean; fieldErrors?: FieldError[]; detail?: string; current?: unknown } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = STATUS[code];
  }
}

export const forbidden = (message = "Your role does not allow this action.") => new ApiError("forbidden", message);
/** Used for both absent and inaccessible resources so existence is never leaked across workspaces. */
export const notFound = (what = "Resource") => new ApiError("not_found", `${what} was not found.`);
export const conflict = (message: string, current?: unknown) => new ApiError("conflict", message, { current });
