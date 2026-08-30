import assert from "node:assert/strict";
import { after, test } from "node:test";

import { preflightHarness, preKernelRun } from "./goal-execution-fixture.js";

/**
 * Spec §12.1, plan Step 3.1/3.5: every ambiguous, corrupt, or active fixture
 * aborts the Goal 5a0 preflight *before* the migration.
 *
 * Split out of preflight-goal-execution.dbtest.ts, where these four fixtures
 * were one test looping over a case table. Each case restages the whole
 * pre-kernel history — a `prisma migrate deploy` replay — and they cost 27 of
 * that file's 45 seconds between them. One test per case is also what makes
 * node:test name the case that failed instead of the loop that contained it.
 */

const harness = preflightHarness("preflight_abort");
after(async () => {
  await harness.cleanup();
});

const abortsWith = async (condition: string, rows: string[]): Promise<void> => {
  await harness.stage(rows);
  const result = harness.runPreflight();
  assert.equal(result.code, 1, `must abort: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, new RegExp(`STOP preflight ${condition}`, "u"));
  assert.doesNotMatch(result.stdout, /preflight PASS/u);
};

test("a Task with both null and non-null Run.goalId aborts the preflight", async () => {
  await abortsWith("mixed-lineage", [
    preKernelRun("r-a", "t-old", "g-up", 1),
    preKernelRun("r-b", "t-old", null, 2),
  ]);
});

test("a Task whose Runs name different Goals aborts the preflight", async () => {
  await abortsWith("ambiguous-goal", [
    `INSERT INTO "Goal" ("id", "projectId", "title", "spec", "updatedAt")
     VALUES ('g-second', 'p-up', 'Second', 'spec', NOW());`,
    preKernelRun("r-a", "t-old", "g-up", 1),
    preKernelRun("r-b", "t-old", "g-second", 2),
  ]);
});

test("a Goal-linked Run with no Task aborts the preflight", async () => {
  await abortsWith("orphan-run", [preKernelRun("r-a", null, "g-up", 1)]);
});

test("an active Goal-linked Run aborts the preflight", async () => {
  await abortsWith("active-run", [preKernelRun("r-a", "t-old", "g-up", 1, "running")]);
});
