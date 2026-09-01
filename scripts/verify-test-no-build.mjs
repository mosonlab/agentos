#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/+$/u, "");
const workspaces = [
  ["@anneal/web", "apps/web"],
  ["@anneal/api", "packages/api"],
  ["@anneal/build-info", "packages/build-info"],
  ["@anneal/db", "packages/db"],
  ["@anneal/github-client", "packages/github-client"],
  ["@anneal/inbox", "packages/inbox"],
  ["@anneal/merge-executor", "packages/merge-executor"],
  ["@anneal/runner", "packages/runner"],
];

const temporaryRoot = mkdtempSync(join(tmpdir(), "anneal-no-test-build."));
const recorderDirectory = join(temporaryRoot, "bin");
const recorder = join(temporaryRoot, "tsc-invocations");
const workspaceRoot = join(temporaryRoot, "runner-workspaces");

const assertNoDist = (context) => {
  for (const [, workspace] of workspaces) {
    assert.equal(existsSync(join(repositoryRoot, workspace, "dist")), false, `${context}: ${workspace}/dist exists`);
  }
};

try {
  assert.equal(process.env.AGENTOS_ALLOW_SCRATCH_DATABASES, "1", "set AGENTOS_ALLOW_SCRATCH_DATABASES=1");
  assert.ok(process.env.TEST_DATABASE_URL, "set TEST_DATABASE_URL to a safe scratch database");
  assert.ok(process.env.TEST_DATABASE_MAINTENANCE_URL, "set TEST_DATABASE_MAINTENANCE_URL to its scratch server");
  const sourceUrl = new URL(process.env.TEST_DATABASE_URL);
  const maintenanceUrl = new URL(process.env.TEST_DATABASE_MAINTENANCE_URL);
  const sourceDatabase = sourceUrl.pathname.slice(1);
  const maintenanceDatabase = maintenanceUrl.pathname.slice(1);
  assert.ok(sourceDatabase && sourceDatabase !== "agentos", "scratch source must use a non-default database");
  assert.ok(maintenanceDatabase && maintenanceDatabase !== "agentos", "scratch maintenance must use a non-default database");
  assert.notEqual(sourceDatabase, maintenanceDatabase, "scratch source and maintenance databases must differ");
  assert.equal(`${sourceUrl.protocol}//${sourceUrl.username}@${sourceUrl.host}`, `${maintenanceUrl.protocol}//${maintenanceUrl.username}@${maintenanceUrl.host}`, "scratch URLs must use the same server and role");
  const scratchSchema = sourceUrl.searchParams.get("schema");
  assert.ok(scratchSchema && scratchSchema !== "public", "scratch database must name a non-public schema");
  assertNoDist("before proof");

  mkdirSync(recorderDirectory);
  writeFileSync(join(recorderDirectory, "tsc"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$AGENTOS_TSC_RECORD\"\nexit 86\n");
  chmodSync(join(recorderDirectory, "tsc"), 0o755);
  writeFileSync(recorder, "");

  const environment = {
    ...process.env,
    AGENTOS_RUN_SCOPE_BYPASS: "regression-verification",
    AGENTOS_TSC_RECORD: recorder,
    PATH: `${recorderDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    RUNNER_WORKSPACE_ROOT: workspaceRoot,
  };
  const probe = spawnSync("tsc", ["--intentional-recorder-probe"], { cwd: repositoryRoot, env: environment });
  assert.equal(probe.status, 86, "the PATH recorder did not intercept the intentional tsc probe");
  assert.match(readFileSync(recorder, "utf8"), /--intentional-recorder-probe/u);
  truncateSync(recorder, 0);

  const commands = workspaces.map(([name]) => ["npm", ["run", "test", "-w", name]]);
  commands.push(["npm", ["run", "test:db", "-w", "@anneal/api", "--", "src/chain-branch.dbtest.ts"]]);

  for (const [executable, args] of commands) {
    const display = [executable, ...args].join(" ");
    process.stdout.write(`no-test-build proof: ${display}\n`);
    const result = spawnSync(executable, args, { cwd: repositoryRoot, env: environment, stdio: "inherit" });
    assert.equal(result.status, 0, `${display} exited ${result.status ?? result.signal}`);
    assert.equal(readFileSync(recorder, "utf8"), "", `${display} spawned tsc`);
    assertNoDist(display);
  }

  process.stdout.write("no-test-build proof: PASS; recorder observed the probe and no test command spawned tsc or created dist\n");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
