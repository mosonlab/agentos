import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  dbtestInvocationDecision,
  regressionVerificationBypass,
} from "../packages/api/src/dbtest-scope.ts";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const guard = join(repositoryRoot, "scripts", "run-scope-guard.sh");

const environment = (overrides = {}) => {
  const clean = { ...process.env, NO_COLOR: "1" };
  for (const name of Object.keys(clean)) {
    if (name.startsWith("AGENTOS_RUN_")) delete clean[name];
  }
  return { ...clean, ...overrides };
};

const run = (command, args, overrides = {}) => spawnSync(command, args, {
  cwd: repositoryRoot,
  encoding: "utf8",
  env: environment(overrides),
});

const expectedRefusal = (script, runId) => {
  const workspaceScript = ["lint:biome", "lint:types"].includes(script) ? "lint" : script;
  return `run-scope-guard: ${script} refused for Run ${runId}: inside an Anneal Run, verify only the affected workspace using npm run ${workspaceScript} -w <workspace> and named test files; the Regression step owns repository-wide proof and the Merge Gate.\n`;
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const makeCallerFixture = (name) => {
  const directory = mkdtempSync(join(tmpdir(), "run-scope-caller."));
  const script = join(directory, name);
  writeFileSync(script, "#!/usr/bin/env bash\nbash \"$@\" &\nchild=$!\nwait \"$child\"\nstatus=$?\nexit \"$status\"\n", { mode: 0o755 });
  chmodSync(script, 0o755);
  return { directory, script };
};

test("RUN-SCOPE-GUARD host fast path is silent", () => {
  const result = run("bash", [guard, "build"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("RUN-SCOPE-GUARD refuses a forged Regression bypass and audits the caller command line", (t) => {
  const caller = makeCallerFixture("forged-run-scope-bypass-caller.sh");
  t.after(() => rmSync(caller.directory, { recursive: true, force: true }));

  const result = run("bash", [caller.script, guard, "build"], {
    AGENTOS_RUN_ID: "run-forged-bypass",
    AGENTOS_RUN_SCOPE_BYPASS: regressionVerificationBypass,
    AGENTOS_TOOLS: caller.directory,
  });
  assert.equal(result.status, 78);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, new RegExp(escapeRegExp(expectedRefusal("build", "run-forged-bypass").trim()), "u"));
  assert.ok(
    result.stderr.split("\n").some((line) => line.includes(caller.script)),
    `forged bypass audit did not include caller command line: ${result.stderr}`,
  );
});

test("RUN-SCOPE-GUARD accepts the bypass only for a regression-verification.sh ancestor under AGENTOS_TOOLS", (t) => {
  const caller = makeCallerFixture("regression-verification.sh");
  t.after(() => rmSync(caller.directory, { recursive: true, force: true }));

  const result = run("bash", [caller.script, guard, "build"], {
    AGENTOS_RUN_ID: "run-legitimate-bypass",
    AGENTOS_RUN_SCOPE_BYPASS: regressionVerificationBypass,
    AGENTOS_TOOLS: caller.directory,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("RUN-SCOPE-GUARD rejects a Bash stdin program that only names the regression tool as an argument", (t) => {
  const toolsDirectory = mkdtempSync(join(tmpdir(), "run-scope-stdin-spoof."));
  t.after(() => rmSync(toolsDirectory, { recursive: true, force: true }));
  const expectedTool = join(toolsDirectory, "regression-verification.sh");

  const result = spawnSync("bash", ["-s", expectedTool], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment({
      AGENTOS_RUN_ID: "run-stdin-spoof",
      AGENTOS_RUN_SCOPE_BYPASS: regressionVerificationBypass,
      AGENTOS_TOOLS: toolsDirectory,
    }),
    input: `bash "${guard}" build\n`,
  });
  assert.equal(result.status, 78, result.stderr);
  assert.match(result.stderr, /run-scope-bypass: refused forged Regression bypass/u);
  assert.match(result.stderr, new RegExp(escapeRegExp(expectedRefusal("build", "run-stdin-spoof").trim()), "u"));
});

test("RUN-SCOPE-GUARD wrong, empty, and missing bypass values refuse once", () => {
  for (const bypass of [undefined, "", "regression", "regression-verification "]) {
    const overrides = { AGENTOS_RUN_ID: "run-refused" };
    if (bypass !== undefined) overrides.AGENTOS_RUN_SCOPE_BYPASS = bypass;
    const result = run("bash", [guard, "lint", "ignored", "arguments"], overrides);
    assert.equal(result.status, 78);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, expectedRefusal("lint", "run-refused"));
  }
});

test("RUN-SCOPE-GUARD prefixes all eight repository-wide root scripts", () => {
  for (const script of ["build", "lint", "lint:biome", "lint:types", "typecheck", "test", "test:db", "merge-gate"]) {
    const result = run("npm", ["run", script, "--", "a-named-file-does-not-narrow-root-scope"], {
      AGENTOS_RUN_ID: "root-script-run",
    });
    assert.equal(result.status, 78, `${script}: ${result.stderr}`);
    assert.equal(result.stderr, expectedRefusal(script, "root-script-run"));
  }
});

test("DBTEST-SCOPE refuses a Run without a scratch database, named files included", () => {
  const noScratchDatabase =
    "run-scope-guard: test:db -w @anneal/api refused for Run db-run: an Anneal Run is granted no scratch PostgreSQL, so test:db -w @anneal/api is merge gate evidence. Do not attempt it inside a Run, and do not report its absence as a gap.";

  for (const args of [[], ["src/chain.dbtest.ts"]]) {
    assert.deepEqual(dbtestInvocationDecision({
      args,
      environment: { AGENTOS_RUN_ID: "db-run" },
      cpuCount: 8,
    }), { exitCode: 78, refusal: noScratchDatabase });
  }

  const bypassed = dbtestInvocationDecision({
    args: [],
    environment: { AGENTOS_RUN_ID: "db-run", AGENTOS_RUN_SCOPE_BYPASS: regressionVerificationBypass },
    cpuCount: 8,
  });
  assert.equal(bypassed.exitCode, null);
});

test("DBTEST-SCOPE refuses only an unscoped invocation once a Run holds a scratch database", () => {
  const scratchDatabase = { AGENTOS_RUN_ID: "db-run", TEST_DATABASE_URL: "postgresql://scratch/db?schema=run" };

  const refused = dbtestInvocationDecision({ args: [], environment: scratchDatabase, cpuCount: 8 });
  assert.deepEqual(refused, {
    exitCode: 78,
    refusal:
      "run-scope-guard: test:db -w @anneal/api refused for Run db-run: inside an Anneal Run, verify only the affected workspace using npm run test:db -w @anneal/api -- src/<file>.dbtest.ts; the Regression step owns repository-wide proof and the Merge Gate.",
  });

  const focused = dbtestInvocationDecision({
    args: ["src/chain.dbtest.ts"],
    environment: scratchDatabase,
    cpuCount: 8,
  });
  assert.equal(focused.exitCode, null);
  assert.equal(focused.concurrency, 2);
});

test("DBTEST-SCOPE executes through a symlinked repository path", (t) => {
  const stubDirectory = mkdtempSync(join(tmpdir(), "run-scope-dbtest."));
  t.after(() => rmSync(stubDirectory, { recursive: true, force: true }));
  const linkedRepository = join(stubDirectory, "repository");
  symlinkSync(repositoryRoot, linkedRepository, "dir");

  const result = run(
    process.execPath,
    ["--import", "tsx", join(linkedRepository, "packages", "api", "scripts", "dbtest.mjs")],
    { AGENTOS_RUN_ID: "symlink-run", TEST_DATABASE_URL: "" },
  );
  assert.equal(result.status, 78, result.stderr);
  assert.equal(
    result.stderr,
    "run-scope-guard: test:db -w @anneal/api refused for Run symlink-run: an Anneal Run is granted no scratch PostgreSQL, so test:db -w @anneal/api is merge gate evidence. Do not attempt it inside a Run, and do not report its absence as a gap.\n",
  );
});

test("DBTEST-SCOPE preserves host and bypass concurrency and caps Runs at two", () => {
  const decision = (configured, extra = {}) => dbtestInvocationDecision({
    args: ["src/chain.dbtest.ts"],
    environment: {
      AGENTOS_RUN_ID: "db-run",
      TEST_DATABASE_URL: "postgresql://scratch/db?schema=run",
      ...(configured === undefined ? {} : { AGENTOS_DBTEST_CONCURRENCY: configured }),
      ...extra,
    },
    cpuCount: 8,
  });

  for (const [configured, effective, capped] of [
    [undefined, 2, true],
    ["1", 1, false],
    ["2", 2, false],
    ["3", 2, true],
    ["12", 2, true],
  ]) {
    const result = decision(configured);
    assert.equal(result.concurrency, effective);
    assert.equal(Boolean(result.capLog), capped);
    if (capped) assert.match(`dbtest: ${result.capLog}\n`, /^dbtest: capped concurrency from \d+ to 2 inside Anneal Run db-run\n$/u);
  }

  const host = dbtestInvocationDecision({
    args: [],
    environment: { AGENTOS_DBTEST_CONCURRENCY: "9" },
    cpuCount: 8,
  });
  assert.equal(host.concurrency, 9);
  assert.equal(host.capLog, null);

  const bypassed = decision("9", { AGENTOS_RUN_SCOPE_BYPASS: regressionVerificationBypass });
  assert.equal(bypassed.concurrency, 9);
  assert.equal(bypassed.capLog, null);
});

test("DBTEST-SCOPE leaves invalid configured concurrency loud", () => {
  for (const bad of ["0", "-2", "3.5", "many", " 3"]) {
    assert.throws(() => dbtestInvocationDecision({
      args: ["src/chain.dbtest.ts"],
      environment: {
        AGENTOS_RUN_ID: "db-run",
        TEST_DATABASE_URL: "postgresql://scratch/db?schema=run",
        AGENTOS_DBTEST_CONCURRENCY: bad,
      },
      cpuCount: 8,
    }), /positive integer/u);
  }
});

test("MERGE-GATE-SCOPE writes a no-verdict refusal before Docker", (t) => {
  const stubDirectory = mkdtempSync(join(tmpdir(), "run-scope-gate."));
  t.after(() => rmSync(stubDirectory, { recursive: true, force: true }));
  const sentinel = join(stubDirectory, "docker-reached");
  const docker = join(stubDirectory, "docker");
  writeFileSync(docker, `#!/bin/sh\nprintf reached > '${sentinel}'\nexit 99\n`);
  const chmod = spawnSync("chmod", ["+x", docker]);
  assert.equal(chmod.status, 0);

  const result = run("bash", [join(repositoryRoot, "scripts", "merge-gate.sh"), "--expect-head", "HEAD"], {
    AGENTOS_RUN_ID: "x",
    PATH: `${stubDirectory}:${process.env.PATH}`,
  });
  const ansiEscape = String.fromCharCode(27);
  const normalized = result.stdout.replaceAll(new RegExp(`${ansiEscape}\\[[0-9;]*m`, "gu"), "");
  assert.equal(result.status, 76, result.stderr);
  assert.equal(normalized, "GATE NOT RUN: refused inside Anneal run x\n");
  assert.doesNotMatch(normalized, /MERGE GATE: (?:PASS|FAIL)/u);
  assert.equal(existsSync(sentinel), false, existsSync(sentinel) ? readFileSync(sentinel, "utf8") : "");
});
