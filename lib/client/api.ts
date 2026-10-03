export interface ApiFieldError {
  path: string;
  message: string;
}

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: ApiFieldError[],
    readonly requestId: string | null,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

interface Options {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Reuse the same key when retrying the same user action so the server can deduplicate it. */
  idempotencyKey?: string;
}

/** Browser-side wrapper for the application API envelope. */
export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(path, { method: options.method ?? "GET", headers, body: options.body !== undefined ? JSON.stringify(options.body) : undefined });
  } catch {
    throw new ApiClientError(0, "network", "Could not reach the server. Check your connection and try again.", [], null, true);
  }
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const e = payload?.error;
    throw new ApiClientError(res.status, e?.code ?? "internal", e?.message ?? "Something went wrong.", e?.fieldErrors ?? [], payload?.requestId ?? null, e?.retryable ?? false);
  }
  return payload.data as T;
}
