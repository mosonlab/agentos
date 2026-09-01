import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  dbtestInvocationDecision,
  regressionVerificationBypass,
  runScopeRefusalMessage,
} from "../packages/api/scripts/dbtest.mjs";

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

const expectedRefusal = (script, runId) => `${runScopeRefusalMessage(script, runId)}\n`;

test("RUN-SCOPE-GUARD host fast path and exact Regression bypass are silent", () => {
  for (const overrides of [{}, {
    AGENTOS_RUN_ID: "run-1",
    AGENTOS_RUN_SCOPE_BYPASS: regressionVerificationBypass,
  }]) {
    const result = run("bash", [guard, "build"], overrides);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
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

test("RUN-SCOPE-GUARD prefixes all six repository-wide root scripts", () => {
  for (const script of ["build", "lint", "typecheck", "test", "test:db", "merge-gate"]) {
    const result = run("npm", ["run", script, "--", "a-named-file-does-not-narrow-root-scope"], {
      AGENTOS_RUN_ID: "root-script-run",
    });
    assert.equal(result.status, 78, `${script}: ${result.stderr}`);
    assert.equal(result.stderr, expectedRefusal(script, "root-script-run"));
  }
});

test("DBTEST-SCOPE refuses only an unscoped non-bypassed Run invocation", () => {
  const refused = dbtestInvocationDecision({
    args: [],
    environment: { AGENTOS_RUN_ID: "db-run" },
    cpuCount: 8,
  });
  assert.deepEqual(refused, {
    exitCode: 78,
    refusal: runScopeRefusalMessage("test:db -w @anneal/api", "db-run"),
  });

  const focused = dbtestInvocationDecision({
    args: ["src/chain.dbtest.ts"],
    environment: { AGENTOS_RUN_ID: "db-run" },
    cpuCount: 8,
  });
  assert.equal(focused.exitCode, null);
  assert.equal(focused.concurrency, 2);
});

test("DBTEST-SCOPE preserves host and bypass concurrency and caps Runs at two", () => {
  const decision = (configured, extra = {}) => dbtestInvocationDecision({
    args: ["src/chain.dbtest.ts"],
    environment: {
      AGENTOS_RUN_ID: "db-run",
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
      environment: { AGENTOS_RUN_ID: "db-run", AGENTOS_DBTEST_CONCURRENCY: bad },
      cpuCount: 8,
    }), /positive integer/u);
  }
});

test("MERGE-GATE-SCOPE writes a no-verdict refusal before Docker", (t) => {
  const stubDirectory = mkdtempSync(join(tmpdir(), "run-scope-gate."));
  t.after(() => rmSync(stubDirectory, { recursive: true, force: true }));
  const sentinel = join(stubDirectory, "docker-reached");
  const docker = join(stubDirectory, "docker");
  writeFileSync(docker, `#!/bin/sh\nprintf reached > '${sentinel}'\n+exit 99\n`);
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
