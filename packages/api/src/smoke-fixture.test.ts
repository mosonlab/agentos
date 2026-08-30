import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { taskInput } from "./task-patch.js";

/**
 * The other half of the fixture-parity check.
 *
 * `apps/web/src/tests/smoke-fixture.test.tsx` proves the console puts
 * `opensPullRequest` on the wire. This proves what the server does with the
 * body either way, using the schema the create-task route actually parses with
 * — so the two halves cannot agree with each other while both being wrong about
 * the API.
 *
 * The asymmetry is the whole point: omitting the field is not neutral. It is a
 * request to open a pull request.
 */
const FIXTURE = JSON.parse(readFileSync(
  fileURLToPath(new URL("../../../docs/release/fixtures/oss-b0-smoke-task.json", import.meta.url)),
  "utf8",
)) as { task: Record<string, unknown> };

test("the published smoke fixture parses into a task that does not open a pull request", () => {
  const parsed = taskInput.parse(FIXTURE.task);
  assert.equal(parsed.opensPullRequest, false);
  assert.equal(parsed.approvalGate, false);
  assert.equal(parsed.name, "OSS-B0 v0.1.0 deterministic smoke");
  assert.equal(parsed.targetBranch, "main");
  assert.equal(parsed.maxDurationMin, 15);
  assert.equal(parsed.stallTimeoutMin, 5);
  assert.equal(parsed.maxSessionsPerTask, 1);
});

test("dropping the field from the same body silently restores the pull request", () => {
  const { opensPullRequest, ...withoutTheField } = FIXTURE.task;
  assert.equal(opensPullRequest, false, "the fixture is the one that says false");
  const parsed = taskInput.parse(withoutTheField);
  assert.equal(
    parsed.opensPullRequest,
    true,
    "this default is deliberate and behaviour-preserving; it is also why the console must send the field",
  );
});
