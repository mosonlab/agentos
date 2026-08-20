import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { planEnvironmentVariable } from "./dbtest-plan.js";
import { fixtureDatabaseUrl } from "./dbtest-url-fixture.js";

const preamble = pathToFileURL(fileURLToPath(new URL("../scripts/dbtest-preamble.mjs", import.meta.url))).href;

const assignment = {
  databaseUrl: fixtureDatabaseUrl("scratch", "secret", "127.0.0.1:55432/agentos_cp_a_chain_1_abcdefabcdef?schema=agentos"),
  workspaceRoot: "/tmp/roots/workspaces/chain",
  controlPlaneStateDir: "/tmp/roots/state/chain",
  filesRoot: "/tmp/roots/files/chain",
};

/**
 * Runs a file the way node:test runs a test file — the preamble imported ahead
 * of it — and reports what that file saw.
 */
const runEntry = (
  t: { after: (fn: () => void) => void },
  planFor: (entryPath: string) => Record<string, unknown>,
): { status: number | null; stdout: string; stderr: string } => {
  const directory = mkdtempSync(join(tmpdir(), "agentos-preamble-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const entry = join(directory, "entry.mjs");
  writeFileSync(entry, [
    "const seen = {",
    "  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,",
    "  DATABASE_URL: process.env.DATABASE_URL,",
    "  RUNNER_WORKSPACE_ROOT: process.env.RUNNER_WORKSPACE_ROOT,",
    "  CONTROL_PLANE_STATE_DIR: process.env.CONTROL_PLANE_STATE_DIR,",
    "  FILES_ROOT: process.env.FILES_ROOT,",
    "};",
    "process.stdout.write(JSON.stringify(seen));",
  ].join("\n"));
  const planPath = join(directory, "plan.json");
  // realpathSync because a temporary directory is reached through a symlink on
  // macOS: this is the spelling difference the plan has to survive.
  writeFileSync(planPath, JSON.stringify({ files: planFor(realpathSync(entry)) }));

  const result = spawnSync(process.execPath, ["--import", "tsx", "--import", preamble, entry], {
    encoding: "utf8",
    env: {
      ...process.env,
      [planEnvironmentVariable]: planPath,
      TEST_DATABASE_URL: fixtureDatabaseUrl("scratch", "secret", "127.0.0.1:55432/shared?schema=agentos"),
      DATABASE_URL: fixtureDatabaseUrl("scratch", "secret", "127.0.0.1:55432/shared?schema=agentos"),
      RUNNER_WORKSPACE_ROOT: "/tmp/roots/workspaces",
      CONTROL_PLANE_STATE_DIR: "/tmp/roots/state",
      FILES_ROOT: "/tmp/roots/files",
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

test("DBTEST-PREAMBLE hands the file its own database and roots before it runs", (t) => {
  const { status, stdout, stderr } = runEntry(t, (entryPath) => ({ [entryPath]: assignment }));

  assert.equal(status, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), {
    TEST_DATABASE_URL: assignment.databaseUrl,
    DATABASE_URL: assignment.databaseUrl,
    RUNNER_WORKSPACE_ROOT: assignment.workspaceRoot,
    CONTROL_PLANE_STATE_DIR: assignment.controlPlaneStateDir,
    FILES_ROOT: assignment.filesRoot,
  });
});

test("DBTEST-PREAMBLE refuses to run a file the plan does not name", (t) => {
  // The failure this guards is not a missing database — it is a file that runs
  // anyway, against the database and directories every other file is using,
  // while the whole point of the plan is that several files run at once.
  const { status, stdout, stderr } = runEntry(t, () => ({
    "/repo/src/somewhere-else.dbtest.ts": assignment,
  }));

  assert.notEqual(status, 0, "a file with no assignment was allowed to run");
  assert.match(stderr, /dbtest-plan-assignment-missing/u);
  assert.equal(stdout, "", "the file ran before the check could stop it");
});
