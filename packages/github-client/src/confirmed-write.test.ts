/**
 * The engine's contract, driven entirely through injected outcomes: EOF,
 * timeout, malformed response, refusal, and a read-back that itself fails.
 *
 * Two assertions recur because they are the whole point of the module: the
 * number of *sends*, and whether a send happened after a read-back that could
 * not be completed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { confirmedWrite, type ReadBack, type WriteAttempt } from "./confirmed-write.js";

/**
 * A recording pair of callbacks. Each list is consumed in order and its last
 * entry repeats, so "EOF forever" and "EOF then success" are both one literal.
 * `order` is what the sharper assertions are made against: a send that follows
 * an unreadable read-back is visible there and nowhere else.
 */
const driver = (attempts: Array<WriteAttempt<string>>, readBacks: Array<ReadBack<string>>) => {
  const order: string[] = [];
  let sends = 0;
  let reads = 0;
  return {
    get sends() { return sends; },
    get reads() { return reads; },
    order,
    attempt: async (): Promise<WriteAttempt<string>> => {
      order.push("send");
      return attempts[Math.min(sends++, attempts.length - 1)]!;
    },
    readBack: async (): Promise<ReadBack<string>> => {
      order.push("read");
      return readBacks[Math.min(reads++, readBacks.length - 1)]!;
    },
  };
};

const EOF: WriteAttempt<string> = { status: "lost", reason: "Post https://api.github.com/...: unexpected EOF" };
const TIMEOUT: WriteAttempt<string> = { status: "lost", reason: "request timed out after 20000ms" };
const MALFORMED: WriteAttempt<string> = { status: "lost", reason: "response body is not valid JSON" };
const REFUSED: WriteAttempt<string> = { status: "refused", reason: "HTTP 422: a pull request already exists" };

test("a write that succeeds is never read back", async () => {
  const fake = driver([{ status: "applied", value: "merged" }], [{ status: "absent" }]);
  const result = await confirmedWrite({ ...fake, resend: "after-confirmed-absent", attempts: 6 });
  assert.deepEqual(result, { status: "applied", value: "merged", attempts: 1, confirmedBy: "attempt" });
  assert.deepEqual(fake.order, ["send"]);
});

test("an EOF whose read-back finds the write applied is a success, and nothing is resent", async () => {
  // The engine's half of PR #150 on 2026-08-18: the merge POST reported EOF,
  // the read-back said MERGED, and a resend would have been a second merge
  // attempt on a merged PR. This is a fake driver, so it proves the state
  // machine and nothing about the executor; the production path is asserted in
  // merge-executor's decision-table.test.ts, under the same PR number.
  const fake = driver([EOF], [{ status: "applied", value: "merge-commit-sha" }]);
  const result = await confirmedWrite({ ...fake, resend: "after-confirmed-absent", attempts: 6 });
  assert.deepEqual(result, { status: "applied", value: "merge-commit-sha", attempts: 1, confirmedBy: "read-back" });
  assert.deepEqual(fake.order, ["send", "read"]);
});

test("an EOF whose read-back finds nothing is resent exactly once per confirmed absence", async () => {
  // The engine's half of PR #147 on the same night: EOF, read-back said OPEN,
  // and the resend was the right move — but only because the read-back had said
  // so first. Again a fake driver; the real merge PUT taking this branch, under
  // a re-verified authorization, is asserted in decision-table.test.ts.
  const fake = driver([EOF, { status: "applied", value: "merged on the second send" }], [{ status: "absent" }]);
  const result = await confirmedWrite({ ...fake, resend: "after-confirmed-absent", attempts: 6 });
  assert.equal(result.status, "applied");
  assert.equal(fake.sends, 2);
  assert.deepEqual(fake.order, ["send", "read", "send"]);
});

test("a read-back that cannot be completed stops the loop dead: indeterminate, never resent", async () => {
  // The hole this module exists to close. The write may have landed. Sending it
  // again is how one operation becomes two, and no error text justifies it.
  for (const outcome of [EOF, TIMEOUT, MALFORMED]) {
    const fake = driver([outcome], [{ status: "unreadable", reason: "the confirming read also hit EOF" }]);
    const result = await confirmedWrite({ ...fake, resend: "after-confirmed-absent", attempts: 6 });
    assert.equal(result.status, "indeterminate", outcome.reason);
    assert.equal(fake.sends, 1);
    assert.deepEqual(fake.order, ["send", "read"]);
    assert.match(result.status === "indeterminate" ? result.reason : "", /could not be completed/);
  }
});

test("a refusal is still read back — the platform saying no is not proof that nothing exists", async () => {
  // `gh pr create` answering "a pull request already exists for this head" is a
  // deterministic refusal AND evidence that the object is there.
  const found = driver([REFUSED], [{ status: "applied", value: "pull/7" }]);
  const reused = await confirmedWrite({ ...found, resend: "after-confirmed-absent", attempts: 6 });
  assert.deepEqual(reused, { status: "applied", value: "pull/7", attempts: 1, confirmedBy: "read-back" });

  const absent = driver([REFUSED], [{ status: "absent" }]);
  const refused = await confirmedWrite({ ...absent, resend: "after-confirmed-absent", attempts: 6 });
  assert.deepEqual(refused, { status: "refused", reason: REFUSED.reason, attempts: 1 });
  // A refusal is never resent, however much budget is left.
  assert.equal(absent.sends, 1);
});

test("a non-idempotent write is read back and then left alone", async () => {
  // A comment has no key the platform enforces, so the second POST is a second
  // comment. One send, one read, no resend — whatever the read-back found.
  const fake = driver([EOF], [{ status: "absent" }]);
  const result = await confirmedWrite({ ...fake, resend: "never", attempts: 6 });
  assert.equal(result.status, "not-applied");
  assert.equal(fake.sends, 1);
  assert.match(result.status === "not-applied" ? result.reason : "", /not idempotent/);
});

test("the attempt ceiling bounds the sends, and the outcome stays determinate", async () => {
  const fake = driver([EOF], [{ status: "absent" }]);
  const result = await confirmedWrite({ ...fake, resend: "after-confirmed-absent", attempts: 3 });
  assert.equal(result.status, "not-applied");
  assert.equal(fake.sends, 3);
  assert.equal(fake.reads, 3);
});

test("the default is a single send: retrying is opt-in, not the fallback", async () => {
  const fake = driver([EOF], [{ status: "absent" }]);
  const result = await confirmedWrite({ ...fake, resend: "after-confirmed-absent" });
  assert.equal(result.status, "not-applied");
  assert.equal(fake.sends, 1);
});

test("an exhausted caller budget stops the first send, and reports that nothing was written", async () => {
  const fake = driver([{ status: "applied", value: "must not happen" }], [{ status: "absent" }]);
  const result = await confirmedWrite({ ...fake, resend: "after-confirmed-absent", attempts: 6, canSend: () => false });
  assert.equal(result.status, "not-applied");
  assert.equal(fake.sends, 0);
  assert.equal(fake.reads, 0);
});

test("a budget that runs out mid-loop stops before the resend, not after it", async () => {
  const fake = driver([EOF], [{ status: "absent" }]);
  let sendsAllowed = 2;
  const result = await confirmedWrite({
    ...fake,
    resend: "after-confirmed-absent",
    attempts: 6,
    canSend: () => sendsAllowed-- > 0,
  });
  assert.equal(result.status, "not-applied");
  assert.equal(fake.sends, 2);
});

test("backoff runs only between a confirmed absence and the next send", async () => {
  const waited: number[] = [];
  const fake = driver([EOF, EOF, { status: "applied", value: "third time" }], [{ status: "absent" }]);
  await confirmedWrite({
    ...fake,
    resend: "after-confirmed-absent",
    attempts: 6,
    wait: async (attempt) => { waited.push(attempt); },
  });
  assert.deepEqual(waited, [1, 2]);
  assert.deepEqual(fake.order, ["send", "read", "send", "read", "send"]);
});

test("no wait is spent once the loop has decided to stop", async () => {
  const waited: number[] = [];
  const fake = driver([EOF], [{ status: "unreadable", reason: "EOF" }]);
  await confirmedWrite({
    ...fake,
    resend: "after-confirmed-absent",
    attempts: 6,
    wait: async (attempt) => { waited.push(attempt); },
  });
  assert.deepEqual(waited, []);
});
