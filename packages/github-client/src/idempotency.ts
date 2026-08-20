/**
 * An idempotency key for the writes that have no natural one.
 *
 * A merge has a key the platform enforces for us: the expected-head sha in the
 * compare-and-swap. A pull request has one the platform enforces implicitly:
 * at most one open PR per head branch, so the head branch *is* the key. A
 * comment has neither — POST it twice and there are two comments, and no
 * read-back can tell the second from a human's reply.
 *
 * So the key is carried in the payload. The marker is an HTML comment, which
 * GitHub renders as nothing in issue, PR and review bodies, and which survives
 * a round trip through the API unchanged. `confirmedWrite`'s read-back for such
 * an operation is then "list the recent comments and look for this key" — a
 * question with an answer, instead of "is one of these mine?", which has none.
 *
 * The key is validated rather than escaped. A key containing `-->` would close
 * the comment early and produce a marker that reads back as a different key, or
 * as none — which is precisely the ambiguity the marker exists to remove — so
 * a malformed key is a thrown programming error at construction time, never a
 * quietly mangled write.
 */

const MARKER_LABEL = "agentos-idempotency-key";

/** Deliberately narrow: the characters an AgentOS key is built from (ids, shas,
 *  activity ids, colon-joined tuples) and nothing that could reopen or close an
 *  HTML comment. */
const KEY_PATTERN = /^[A-Za-z0-9._:@/+=-]{1,200}$/u;

const MARKER_PATTERN = new RegExp(`<!--\\s*${MARKER_LABEL}:\\s*([A-Za-z0-9._:@/+=-]{1,200})\\s*-->`, "u");

export class InvalidIdempotencyKeyError extends Error {
  constructor(key: string) {
    super(`idempotency key ${JSON.stringify(key)} is not of the form ${KEY_PATTERN.source}`);
    this.name = "InvalidIdempotencyKeyError";
  }
}

export const idempotencyMarker = (key: string): string => {
  if (!KEY_PATTERN.test(key)) throw new InvalidIdempotencyKeyError(key);
  return `<!-- ${MARKER_LABEL}: ${key} -->`;
};

/** The body to send. Appending twice is a no-op, so a resend built from an
 *  already-marked body cannot accumulate markers. */
export const withIdempotencyMarker = (body: string, key: string): string => {
  const marker = idempotencyMarker(key);
  return body.includes(marker) ? body : `${body}\n\n${marker}`;
};

/** The key a body carries, or null. Used by a read-back to recognise its own
 *  earlier write among writes it did not make. */
export const idempotencyKeyIn = (body: string): string | null => body.match(MARKER_PATTERN)?.[1] ?? null;

export const carriesIdempotencyKey = (body: string, key: string): boolean => {
  if (!KEY_PATTERN.test(key)) throw new InvalidIdempotencyKeyError(key);
  return idempotencyKeyIn(body) === key;
};
