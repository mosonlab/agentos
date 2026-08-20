import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { preKernelRun, preKernelSeed, stageAtPreviousMigration } from "./goal-execution-fixture.js";

/**
 * The Goal 5a0 migration preflight, exercised as the operator runs it.
 *
 * Spec §12.1 and plan Step 3.1/3.5: every ambiguous, corrupt, or active fixture
 * must abort *before* the migration, and the report must carry IDs and counts
 * and nothing else. It runs against a database staged at the migration before
 * the kernel, because that is the only state in which the preflight is ever run.
 */

const dbDirectory = fileURLToPath(new URL("../../db", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const isolatedCheckout = mkdtempSync(join(tmpdir(), "agentos-public-lineage-"));
const currentBranch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();

// Linked worktrees can share private objects with this public lineage. Clone
// only the current branch so the preflight sees the history a standalone public
// clone sees, without weakening the production authority checks.
execFileSync("git", [
  "clone", "--quiet", "--no-local", "--no-checkout", "--single-branch",
  "--branch", currentBranch, repositoryRoot, isolatedCheckout,
]);
// The authority the recorded revalidation names; the preflight refuses to pass
// without them, so these are the real values, not placeholders.
const MASTER_SHA = "485fb118db96e3977006a2edc866a38b751ff0e2";
const CONTROL_PLANE_A_SHA = "c671439831b075568420b92f4494227fa7fc392b";

let fixture: ReturnType<typeof stageAtPreviousMigration>;
after(() => {
  fixture?.cleanup();
  rmSync(isolatedCheckout, { recursive: true, force: true });
});

const stage = (rows: string[]): void => {
  fixture?.cleanup();
  fixture = stageAtPreviousMigration("preflight");
  fixture.execute(preKernelSeed + rows.join("\n"));
};

interface PreflightResult { code: number; stdout: string; stderr: string }

const runPreflight = (environment: Record<string, string | undefined> = {}): PreflightResult => {
  const env = {
    ...process.env,
    DATABASE_URL: fixture.url,
    GOAL5A0_MASTER_SHA: MASTER_SHA,
    GOAL5A0_CONTROL_PLANE_A_SHA: CONTROL_PLANE_A_SHA,
    GIT_DIR: join(isolatedCheckout, ".git"),
    GIT_WORK_TREE: repositoryRoot,
    PATH: `${dbDirectory}/node_modules/.bin:${process.env.PATH ?? ""}`,
    ...environment,
  } as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(environment)) if (value === undefined) delete env[key];
  try {
    // Run exactly as `npm run db:preflight-goal-execution` runs it: from the db
    // workspace, not from the repository root. The authority evidence and the
    // git checks must resolve from the script's own location, or the wired
    // script stops for the wrong reason every time.
    const stdout = execFileSync("npx", ["tsx", "prisma/preflight-goal-execution.ts"], {
      cwd: dbDirectory,
      env,
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? -1, stdout: String(failure.stdout ?? ""), stderr: String(failure.stderr ?? "") };
  }
};

test("a clean history passes and the report carries only IDs and counts", () => {
  stage([preKernelRun("r-1", "t-old", "g-up", 1)]);

  const result = runPreflight();
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /preflight PASS/u);
  assert.match(result.stdout, /preflight count tasksToBackfill=1/u);
  assert.match(result.stdout, /preflight count goalLinkedRuns=1/u);
  assert.doesNotMatch(result.stdout + result.stderr, /secret-looking/u, "no prompt or spec text reaches the report");
});

test("every ambiguous, corrupt, or active fixture aborts before the migration", () => {
  const cases: Array<{ label: string; condition: string; rows: string[]; extra?: string }> = [
    {
      label: "a Task with both null and non-null Run.goalId",
      condition: "mixed-lineage",
      rows: [preKernelRun("r-a", "t-old", "g-up", 1), preKernelRun("r-b", "t-old", null, 2)],
    },
    {
      label: "a Task whose Runs name different Goals",
      condition: "ambiguous-goal",
      extra: `INSERT INTO "Goal" ("id", "projectId", "title", "spec", "updatedAt")
              VALUES ('g-second', 'p-up', 'Second', 'spec', NOW());`,
      rows: [preKernelRun("r-a", "t-old", "g-up", 1), preKernelRun("r-b", "t-old", "g-second", 2)],
    },
    {
      label: "a Goal-linked Run with no Task",
      condition: "orphan-run",
      rows: [preKernelRun("r-a", null, "g-up", 1)],
    },
    {
      label: "an active Goal-linked Run",
      condition: "active-run",
      rows: [preKernelRun("r-a", "t-old", "g-up", 1, "running")],
    },
  ];

  for (const testCase of cases) {
    stage(testCase.extra ? [testCase.extra, ...testCase.rows] : testCase.rows);
    const result = runPreflight();
    assert.equal(result.code, 1, `${testCase.label} must abort: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, new RegExp(`STOP preflight ${testCase.condition}`, "u"), testCase.label);
    assert.doesNotMatch(result.stdout, /preflight PASS/u, testCase.label);
  }
});

test("a Goal/Run project disagreement cannot even be created on the pre-kernel schema", () => {
  stage([preKernelRun("r-1", "t-old", "g-up", 1)]);
  // The preflight checks this condition anyway, as defence in depth. The pre-kernel
  // composite foreign key Run(goalId, projectId) -> Goal already makes the corrupt
  // state unreachable, and that is worth pinning: if a future migration weakens the
  // key, this test fails and the preflight's query becomes the live guard rather
  // than a redundant one.
  assert.throws(
    () => fixture.execute(`
      INSERT INTO "Project" ("id", "name", "slug", "updatedAt") VALUES ('p-other', 'other', 'other', NOW());
      INSERT INTO "Goal" ("id", "projectId", "title", "spec", "updatedAt") VALUES ('g-other', 'p-other', 'Other', 'spec', NOW());
      ${preKernelRun("r-cross", "t-old", "g-other", 2)}`),
    /Run_goalId_projectId_fkey/u,
  );
});

test("missing authority evidence and an unnamed schema both stop the preflight", () => {
  stage([preKernelRun("r-1", "t-old", "g-up", 1)]);

  const noMaster = runPreflight({ GOAL5A0_MASTER_SHA: undefined });
  assert.equal(noMaster.code, 1);
  assert.match(noMaster.stderr, /STOP preflight authority/u);

  const wrongAncestry = runPreflight({ GOAL5A0_CONTROL_PLANE_A_SHA: "0".repeat(40) });
  assert.equal(wrongAncestry.code, 1);
  assert.match(wrongAncestry.stderr, /STOP preflight authority/u);

  const url = new URL(fixture.url);
  url.searchParams.delete("schema");
  const noSchema = runPreflight({ DATABASE_URL: url.toString() });
  assert.equal(noSchema.code, 1);
  assert.match(noSchema.stderr, /must name the target schema explicitly/u);
});
