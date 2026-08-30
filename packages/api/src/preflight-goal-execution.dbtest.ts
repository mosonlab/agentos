import assert from "node:assert/strict";
import { after, test } from "node:test";

import { preflightHarness, preKernelRun } from "./goal-execution-fixture.js";

/**
 * The Goal 5a0 migration preflight, exercised as the operator runs it.
 *
 * Spec §12.1 and plan Step 3.1/3.5: every ambiguous, corrupt, or active fixture
 * must abort *before* the migration, and the report must carry IDs and counts
 * and nothing else. It runs against a database staged at the migration before
 * the kernel, because that is the only state in which the preflight is ever run.
 *
 * The four abort fixtures live in preflight-goal-execution-abort.dbtest.ts.
 * Each of them restages the whole pre-kernel history, and the tests in one file
 * run one after another, so together they were the longest single file in the
 * database wave.
 */

const harness = preflightHarness("preflight");
after(async () => {
  await harness.cleanup();
});

test("a clean history passes and the report carries only IDs and counts", async () => {
  await harness.stage([preKernelRun("r-1", "t-old", "g-up", 1)]);

  const result = harness.runPreflight();
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /preflight PASS/u);
  assert.match(result.stdout, /preflight count tasksToBackfill=1/u);
  assert.match(result.stdout, /preflight count goalLinkedRuns=1/u);
  assert.doesNotMatch(result.stdout + result.stderr, /secret-looking/u, "no prompt or spec text reaches the report");
});

test("a Goal/Run project disagreement cannot even be created on the pre-kernel schema", async () => {
  const fixture = await harness.stage([preKernelRun("r-1", "t-old", "g-up", 1)]);
  // The preflight checks this condition anyway, as defence in depth. The pre-kernel
  // composite foreign key Run(goalId, projectId) -> Goal already makes the corrupt
  // state unreachable, and that is worth pinning: if a future migration weakens the
  // key, this test fails and the preflight's query becomes the live guard rather
  // than a redundant one.
  await assert.rejects(
    async () => { await fixture.execute(`
      INSERT INTO "Project" ("id", "name", "slug", "updatedAt") VALUES ('p-other', 'other', 'other', NOW());
      INSERT INTO "Goal" ("id", "projectId", "title", "spec", "updatedAt") VALUES ('g-other', 'p-other', 'Other', 'spec', NOW());
      ${preKernelRun("r-cross", "t-old", "g-other", 2)}`); },
    /Run_goalId_projectId_fkey/u,
  );
});

test("an unnamed schema stops the preflight", async () => {
  const fixture = await harness.stage([preKernelRun("r-1", "t-old", "g-up", 1)]);

  const url = new URL(fixture.url);
  url.searchParams.delete("schema");
  const noSchema = harness.runPreflight({ DATABASE_URL: url.toString() });
  assert.equal(noSchema.code, 1);
  assert.match(noSchema.stderr, /must name the target schema explicitly/u);
});
