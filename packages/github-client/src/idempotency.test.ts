import assert from "node:assert/strict";
import { test } from "node:test";

import {
  carriesIdempotencyKey,
  idempotencyKeyIn,
  idempotencyMarker,
  InvalidIdempotencyKeyError,
  withIdempotencyMarker,
} from "./idempotency.js";
import { confirmedWrite } from "./confirmed-write.js";

const KEY = "7:a1b2c3d4:activity-9f";

test("a marked body round-trips its key", () => {
  const body = withIdempotencyMarker("Gate verdict: PASS", KEY);
  assert.match(body, /^Gate verdict: PASS\n\n/u);
  assert.equal(idempotencyKeyIn(body), KEY);
  assert.equal(carriesIdempotencyKey(body, KEY), true);
  assert.equal(carriesIdempotencyKey(body, "7:other:activity-9f"), false);
});

test("marking twice does not accumulate markers", () => {
  const once = withIdempotencyMarker("hello", KEY);
  assert.equal(withIdempotencyMarker(once, KEY), once);
});

test("an unmarked body carries no key, and is not mistaken for someone else's", () => {
  assert.equal(idempotencyKeyIn("an ordinary human comment"), null);
  assert.equal(carriesIdempotencyKey("an ordinary human comment", KEY), false);
  // A body that merely mentions the label is not a marker.
  assert.equal(idempotencyKeyIn("agentos-idempotency-key: 7:a1b2c3d4:activity-9f"), null);
});

test("a key that could break out of the comment is refused at construction, not escaped", () => {
  for (const key of ["a --> b", "line\nbreak", "", "x".repeat(201), "<!-- nested -->"]) {
    assert.throws(() => idempotencyMarker(key), InvalidIdempotencyKeyError, JSON.stringify(key));
    assert.throws(() => carriesIdempotencyKey("body", key), InvalidIdempotencyKeyError, JSON.stringify(key));
  }
});

test("the marker is what makes a non-idempotent write recognisable on read-back", async () => {
  // The comment case end to end, against a fake comment surface: the POST is
  // lost, the read-back finds the marker, and no second comment is written.
  const posted: string[] = [];
  const body = withIdempotencyMarker("Merge gate: PASS 0123456789abcdef", KEY);
  const result = await confirmedWrite<number>({
    resend: "never",
    attempts: 6,
    attempt: async () => {
      posted.push(body);
      return { status: "lost", reason: "unexpected EOF" };
    },
    readBack: async () => {
      const index = posted.findIndex((comment) => carriesIdempotencyKey(comment, KEY));
      return index === -1 ? { status: "absent" } : { status: "applied", value: index };
    },
  });
  assert.deepEqual(result, { status: "applied", value: 0, attempts: 1, confirmedBy: "read-back" });
  assert.equal(posted.length, 1);
});
