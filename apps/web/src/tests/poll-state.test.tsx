import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../lib/api";
import { fatal } from "../lib/poll-state";

const notFound = new ApiError(404, "/tasks/t1", "Task not found");
const flaky = new ApiError(503, "/tasks/t1", "Service unavailable");
const task = { id: "t1" };

test("no error is never fatal, with or without data", () => {
  assert.equal(fatal(null, task), false);
  assert.equal(fatal(null, null), false);
});

test("a transient error keeps the last good render", () => {
  assert.equal(fatal(flaky, task), false);
});

test("a transient error with nothing to fall back on is fatal", () => {
  assert.equal(fatal(flaky, null), true);
});

test("a 404 is authoritative even after a successful poll", () => {
  // The regression this exists for: usePoll keeps `data` on error, so a task
  // deleted mid-view would otherwise render forever, silently stale.
  assert.equal(fatal(notFound, task), true);
});
