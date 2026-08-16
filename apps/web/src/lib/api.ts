/** Control-plane client.
 *
 *  Default transport is the Vite dev/preview proxy at `/api`, which injects the
 *  operator bearer token server-side (DECISIONS #17: no login on localhost, and
 *  the token must not ship inside the bundle). Setting VITE_API_URL switches to
 *  a direct cross-origin call, in which case VITE_API_TOKEN is required. */

/* Read through the whole `import.meta.env` object rather than two member
 * accesses: Vite injects the object in a build, and node (which the test runner
 * uses directly, without Vite) leaves it undefined. */
const environment = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
const configuredUrl = environment.VITE_API_URL;
const configuredToken = environment.VITE_API_TOKEN;

export const apiBase = configuredUrl && configuredUrl.length > 0 ? configuredUrl.replace(/\/$/, "") : "/api";
const directToken = configuredToken && configuredToken.length > 0 ? configuredToken : null;

export class ApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.path = path;
  }

  /** The endpoint is not implemented yet — pages degrade instead of erroring. */
  get missingEndpoint(): boolean {
    return this.status === 404 || this.status === 405 || this.status === 501;
  }

  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

const parseError = async (response: Response, path: string): Promise<ApiError> => {
  const text = await response.text().catch(() => "");
  let detail = text;
  try {
    const parsed = JSON.parse(text) as { error?: string; issues?: unknown };
    if (typeof parsed.error === "string") detail = parsed.error;
  } catch {
    // Non-JSON error bodies (proxy failures, HTML) are surfaced verbatim.
  }
  return new ApiError(response.status, path, detail.slice(0, 400) || `HTTP ${response.status}`);
};

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(directToken ? { Authorization: `Bearer ${directToken}` } : {}),
        ...init?.headers,
      },
    });
  } catch (reason: unknown) {
    throw new ApiError(0, path, reason instanceof Error ? reason.message : "Network error");
  }
  if (!response.ok) throw await parseError(response, path);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text.length > 0 ? (JSON.parse(text) as T) : (undefined as T));
};

export const api = {
  get: <T>(path: string): Promise<T> => request<T>(path),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  patch: <T>(path: string, body: unknown): Promise<T> => request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown): Promise<T> => request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  delete: <T>(path: string): Promise<T> => request<T>(path, { method: "DELETE" }),
};

export const errorMessage = (reason: unknown): string =>
  reason instanceof ApiError
    ? reason.status === 0
      ? `${reason.message} (${apiBase}${reason.path})`
      : `${reason.status} ${reason.message}`
    : reason instanceof Error
      ? reason.message
      : String(reason);
