import type { ApiError } from "./api";

/**
 * Should the page abandon what it is showing and render the error instead?
 *
 * `usePoll` sets `error` but keeps the last good `data`, which is right for a
 * transient failure and wrong for a deletion: a 404 is authoritative even when a
 * prior poll succeeded — the row is gone and the cached copy is a lie. Extracted
 * as a pure function of two arguments because the web tests are
 * `renderToStaticMarkup` snapshots and cannot drive a 2.5 s poll through
 * success-then-404.
 */
export const fatal = (error: ApiError | null, data: unknown): boolean =>
  error !== null && (data === null || error.status === 404);
