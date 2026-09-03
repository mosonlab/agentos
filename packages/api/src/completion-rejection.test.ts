import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPLETION_REJECTION_ACTIVITY_KIND,
  parseCompletionRejection,
} from "./completion-rejection.js";

const valid = {
  kind: COMPLETION_REJECTION_ACTIVITY_KIND,
  schemaVersion: 1,
  sourceRunId: "run-1",
  status: 400,
  responseBody: '{"error":"incompatible payload"}',
};

test("completion rejection parsing accepts the predecessor marker for its exact Run", () => {
  assert.deepEqual(parseCompletionRejection(valid, "run-1"), {
    status: "ok",
    rejection: { status: 400, responseBody: '{"error":"incompatible payload"}' },
  });
});

test("completion rejection parsing distinguishes malformed and different-Run records", () => {
  for (const metadata of [
    { ...valid, schemaVersion: 2 },
    { ...valid, status: "400" },
    { ...valid, status: 99 },
    { ...valid, status: 600 },
    { ...valid, responseBody: null },
  ]) {
    assert.deepEqual(parseCompletionRejection(metadata, "run-1"), { status: "malformed" });
  }
  const { sourceRunId: _sourceRunId, ...unattributed } = valid;
  assert.deepEqual(parseCompletionRejection(unattributed, "run-1"), {
    status: "different-run",
  });
  assert.deepEqual(parseCompletionRejection({ ...valid, sourceRunId: null }, "run-1"), {
    status: "different-run",
  });
  assert.deepEqual(parseCompletionRejection({ ...valid, sourceRunId: "run-2" }, "run-1"), {
    status: "different-run",
  });
  assert.deepEqual(parseCompletionRejection({ ...valid, sourceRunId: "run-2", status: "unknown" }, "run-1"), {
    status: "different-run",
  });
});
