/**
 * One fetch wrapper for every call the browser makes to this app's API.
 *
 * The routes are cost-tiered rate limited (A10) and several of them return
 * 503 when a feature is not configured. Both are ordinary, expected
 * answers rather than bugs, so they get a typed shape the UI can render as
 * a state instead of a stack trace:
 *
 *   429 → `retryAfterSeconds` from the Retry-After header; the caller shows
 *         a countdown and stops asking until it elapses;
 *   503 → the feature is switched off; the caller says so plainly.
 */

export class ApiError extends Error {
  readonly status: number;
  /** Seconds to wait before retrying — only meaningful for 429. */
  readonly retryAfterSeconds: number | null;

  constructor(message: string, status: number, retryAfterSeconds: number | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  get isUnavailable(): boolean {
    return this.status === 503;
  }
}

/** Default wait when a 429 arrives without a usable Retry-After header. */
export const DEFAULT_RETRY_AFTER_SECONDS = 60;

function parseRetryAfter(res: Response): number | null {
  const raw = res.headers.get("Retry-After");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

/**
 * Fetch JSON, or throw `ApiError`. Never throws on a parse failure of an
 * error body — the status is what matters.
 */
export async function apiFetch<T>(
  input: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(input, { cache: "no-store", ...init });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body (or none). The status carries the meaning.
  }
  if (!res.ok) {
    const message =
      typeof (body as { error?: unknown })?.error === "string"
        ? (body as { error: string }).error
        : `Request failed (${res.status})`;
    throw new ApiError(message, res.status, parseRetryAfter(res));
  }
  return body as T;
}

/** Unix seconds at which a rate-limited caller may try again. */
export function retryAtFrom(error: unknown): number | null {
  if (error instanceof ApiError && error.isRateLimited) {
    return (
      Math.floor(Date.now() / 1000) +
      (error.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS)
    );
  }
  return null;
}

/** The message shown for any failed request, in the app's own voice. */
export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}
