import assert from "node:assert/strict";
import { test } from "node:test";

import { FAILURE_REASON_LIMIT, failureReasonText, truncateFailureReason } from "./failure-reason.js";

test("a reason within the limit is stored exactly as it arrived", () => {
  const reason = "git push timed out after 6000ms";
  assert.equal(truncateFailureReason(reason, FAILURE_REASON_LIMIT), reason);
  assert.equal(truncateFailureReason("x".repeat(100), 100), "x".repeat(100));
});

test("an over-long reason keeps its head, is marked, and fits the limit", () => {
  const truncated = truncateFailureReason(`${"d".repeat(9000)}TAIL`, FAILURE_REASON_LIMIT);
  assert.equal(truncated.length, FAILURE_REASON_LIMIT);
  assert.ok(truncated.startsWith("d".repeat(100)));
  assert.equal(truncated.includes("TAIL"), false);
  assert.match(truncated, /\n\[truncated by the API: 9004 characters exceeded the 4000-character limit\]$/u);
});

// The marker cannot be honoured below its own length, and a limit that small is
// a caller's mistake rather than a shape this function may invent an answer
// for: it still returns evidence, cut to the bound it was given.
test("a limit narrower than the marker still yields a bounded reason", () => {
  const truncated = truncateFailureReason("y".repeat(50), 10);
  assert.equal(truncated, "y".repeat(10));
});

test("the schema truncates rather than rejecting", () => {
  const parsed = failureReasonText(FAILURE_REASON_LIMIT).safeParse("z".repeat(20_000));
  assert.equal(parsed.success, true);
  assert.equal(parsed.data!.length, FAILURE_REASON_LIMIT);
});

// PostgreSQL rejects a lone surrogate outright, so a cut that lands between the
// halves of an astral character must drop the orphan rather than store it.
test("truncation never cuts a surrogate pair in half", () => {
  // The sweep is the point: where the cut lands inside the emoji run depends on
  // the marker's own length, so a single fixture proves only its own offset.
  for (let head = 3900; head <= 3960; head += 1) {
    const truncated = truncateFailureReason(`${"a".repeat(head)}${"\u{1f600}".repeat(50)}`, FAILURE_REASON_LIMIT);
    assert.ok(truncated.length <= FAILURE_REASON_LIMIT, `head ${head}`);
    for (const character of truncated) {
      const code = character.codePointAt(0)!;
      assert.ok(code < 0xd800 || code > 0xdfff, `lone surrogate at head ${head}`);
    }
  }
});
