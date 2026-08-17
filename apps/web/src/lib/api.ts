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

const requestRaw = async (path: string, init?: RequestInit): Promise<Response> => {
  try {
    return await fetch(`${apiBase}${path}`, {
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
};

const requestText = async (path: string, init?: RequestInit): Promise<string> => {
  const response = await requestRaw(path, init);
  if (!response.ok) throw await parseError(response, path);
  if (response.status === 204) return "";
  return response.text();
};

/** One poll's answer: whether anything arrived, and the validator to send next
 *  time. `changed: false` means the server said 304 and `body` is meaningless. */
export type Polled = { changed: boolean; body: string; etag: string | null };

/**
 * A conditional GET for the polling loop.
 *
 * Two layers, because they fail in different places. The `If-None-Match` header
 * is the good one: an unchanged `GET /tasks` costs a header exchange instead of
 * a payload, which on a full board is 1.58 MB the page never reads. The text
 * comparison in `usePoll` is the fallback for a control plane that mints no
 * validator — it still skips the `JSON.parse` and the re-render, just not the
 * transfer.
 *
 * `cache: "no-store"` so the browser's own HTTP cache never intercepts: with a
 * cached copy it would attach its own validator and hand back a synthesised 200,
 * and the caller could not tell a fresh payload from a replayed one.
 */
const requestPolled = async (path: string, etag: string | null): Promise<Polled> => {
  const response = await requestRaw(path, {
    cache: "no-store",
    ...(etag === null ? {} : { headers: { "If-None-Match": etag } }),
  });
  const nextTag = response.headers.get("ETag");
  if (response.status === 304) return { changed: false, body: "", etag: nextTag ?? etag };
  if (!response.ok) throw await parseError(response, path);
  if (response.status === 204) return { changed: true, body: "", etag: nextTag };
  return { changed: true, body: await response.text(), etag: nextTag };
};

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const text = await requestText(path, init);
  return (text.length > 0 ? (JSON.parse(text) as T) : (undefined as T));
};

export const api = {
  get: <T>(path: string): Promise<T> => request<T>(path),
  poll: (path: string, etag: string | null): Promise<Polled> => requestPolled(path, etag),
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
