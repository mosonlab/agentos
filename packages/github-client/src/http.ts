/**
 * The transport seam every AgentOS process shares when it talks to GitHub over
 * HTTP.
 *
 * It is an injected function, not a fetch call, for two reasons that are both
 * load-bearing. Tests drive EOF, timeout and malformed-body cases without a
 * network. And the merge executor's custody claim (§D-P1) is that its
 * credential never reaches a child process — a transport this package could
 * not spawn from is a transport that cannot break the claim, so nothing here
 * imports `node:child_process` and `no-child-process.test.ts` asserts it.
 *
 * `callWithTimeout` turns the two ways a request can fail to answer — the
 * connection dying, and the connection never finishing — into the same shape:
 * a response object whose status is `NO_RESPONSE`. A caller that pattern-matches
 * on status therefore cannot forget the lost case, which is what a thrown
 * exception invites.
 */

import { NO_RESPONSE } from "./classify.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type HttpResponse = { status: number; body: string };

export type HttpRequest = {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
};

export type Http = (request: HttpRequest) => Promise<HttpResponse>;

/** A response, or the recorded absence of one. `status: NO_RESPONSE` carries
 *  the transport error's text in `body`. */
export type HttpAttempt = HttpResponse | { status: typeof NO_RESPONSE; body: string };

/** What a caller wants recorded about a request it made — used by the merge
 *  executor's no-publication assertion, which proves the credential appears in
 *  no URL and no body. */
export type HttpTrace = Array<{ method: string; url: string; body?: string }>;

export const callWithTimeout = async (
  http: Http,
  request: Omit<HttpRequest, "signal">,
  timeoutMs: number,
  trace?: HttpTrace,
): Promise<HttpAttempt> => {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
  trace?.push({ method: request.method, url: request.url, ...(request.body === undefined ? {} : { body: request.body }) });
  try {
    return await http({ ...request, signal: controller.signal });
  } catch (error: unknown) {
    // Deliberately not rethrown. A write whose response was lost is a state the
    // caller has to handle, and an exception is the one shape that lets it be
    // handled by accident.
    return { status: NO_RESPONSE, body: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
};
