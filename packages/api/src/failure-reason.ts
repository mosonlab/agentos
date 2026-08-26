/**
 * A failure reason is evidence, and the API's job is to keep it, not to grade
 * its length. Refusing an over-long reason with a 400 destroyed the whole
 * report — a session that wrote a long diagnosis into `failureReason` lost its
 * run to the validation error rather than to the failure it was describing.
 *
 * So the bound stays (unbounded client text is still not stored verbatim) but
 * it is enforced by truncation: the head of the reason survives, and the marker
 * says plainly that a tail was dropped so nobody reads the remainder as the
 * whole story.
 */

import { z } from "zod";

/** What one stored reason may occupy, wherever it entered from. */
export const FAILURE_REASON_LIMIT = 4000;

/** A high surrogate is only half a character. Cutting between the halves would
 *  store a lone surrogate, which is not text PostgreSQL will accept, so the
 *  orphan goes with the tail it belonged to. */
const withoutOrphanSurrogate = (text: string): string => {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
};

export const truncateFailureReason = (reason: string, limit: number): string => {
  if (reason.length <= limit) return reason;
  const marker = `\n[truncated by the API: ${reason.length} characters exceeded the ${limit}-character limit]`;
  const kept = limit - marker.length;
  return kept > 0
    ? `${withoutOrphanSurrogate(reason.slice(0, kept))}${marker}`
    : withoutOrphanSurrogate(reason.slice(0, limit));
};

/** The failure-reason field every client-facing schema uses, so that no entry
 *  point can reintroduce the 400 by declaring its own `z.string().max(...)`. */
export const failureReasonText = (limit: number): z.ZodType<string, string> =>
  z.string().transform((reason) => truncateFailureReason(reason, limit));
