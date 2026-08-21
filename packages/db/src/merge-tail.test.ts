import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  defenseListReason,
  defenseTriggers,
  isTestPath,
  isMergeReadinessStep,
  parseResolverResult,
  parseRegressionVerdict,
  resolutionTestTriggers,
} from "./merge-tail.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

test("regression verdicts are exact-head, versioned, and fail closed", () => {
  const pass = parseRegressionVerdict(JSON.stringify({ schemaVersion: 1, outcome: "pass", headSha: A, baseHeadSha: B, gateVerdict: "PASS" }));
  assert.equal(pass.status, "ok");
  assert.equal(parseRegressionVerdict(JSON.stringify({ schemaVersion: 1, outcome: "pass", headSha: A, baseHeadSha: B, gateVerdict: "FAIL" })).status, "invalid");
  assert.equal(parseRegressionVerdict("MERGE GATE: PASS").status, "invalid");
});

test("both canonical readiness steps are mechanical server-owned shapes", () => {
  assert.equal(isMergeReadinessStep({ stepIndex: 6, outputKind: "merge-authorization", taskTemplateName: "direct-engineer-workflow" }), true);
  assert.equal(isMergeReadinessStep({ stepIndex: 11, outputKind: "merge-authorization", taskTemplateName: "compound-engineer-workflow" }), true);
  assert.equal(isMergeReadinessStep({ stepIndex: 6, outputKind: "approval", taskTemplateName: "direct-engineer-workflow" }), false);
});

test("merge-resolver results are versioned and head-bound", () => {
  assert.equal(parseResolverResult(JSON.stringify({
    schemaVersion: 1, outcome: "resolved", startHeadSha: A, targetHeadSha: B,
    resolvedHeadSha: B, tradeOffs: [], changedTestExpectations: [],
  })).status, "ok");
  for (const body of [undefined, "prose", JSON.stringify({ outcome: "resolved" }), JSON.stringify({
    schemaVersion: 1, outcome: "other", startHeadSha: A, targetHeadSha: B,
  })]) assert.equal(parseResolverResult(body).status, "invalid");
});

test("the defense list covers gate, migration, authority, role, template, and workflow paths", () => {
  for (const path of [
    "scripts/merge-gate.sh",
    "scripts/gate-worker/gate-dispatch.sh",
    "packages/db/prisma/migrations/20260821_tail/migration.sql",
    "docs/release/release-authority.public.pem",
    "agents/roles/merge-resolver.md",
    "agents/templates/direct-engineer-workflow/06-merge-readiness.md",
    "packages/api/src/merge-readiness-worker.ts",
    "packages/api/src/merge-evidence-worker.ts",
    "packages/api/src/github-read.ts",
    "packages/api/src/index.ts",
    "packages/api/src/app.ts",
  ]) assert.notEqual(defenseListReason(path), null, path);
  assert.equal(defenseListReason("apps/web/src/app.tsx"), null);
});

test("resolution review triggers only when existing test lines changed", () => {
  assert.deepEqual(resolutionTestTriggers([{ filename: "src/a.test.ts", previousFilename: null, patch: "@@ -1,0 +2 @@\n+added" }]), []);
  assert.deepEqual(resolutionTestTriggers([{ filename: "src/a.test.ts", previousFilename: null, patch: "@@ -1 +1 @@\n-old\n+new" }]), [
    { path: "src/a.test.ts", reason: "existing-test-lines-modified" },
  ]);
  assert.deepEqual(resolutionTestTriggers([{ filename: "src/a.ts", previousFilename: null, patch: "@@ -1 +1 @@\n-old\n+new" }]), []);
  assert.deepEqual(resolutionTestTriggers([{ filename: "src/a.test.ts", previousFilename: null, patch: null }]), [
    { path: "src/a.test.ts", reason: "existing-test-lines-unverifiable" },
  ]);
  assert.deepEqual(resolutionTestTriggers([{
    filename: "scripts/renamed.mjs", previousFilename: "scripts/merge-integrator-system-test.mjs",
    patch: "@@ -1 +1 @@\n-old\n+new",
  }]), [{ path: "scripts/merge-integrator-system-test.mjs", reason: "existing-test-lines-modified" }]);
});

test("the test-path predicate covers the repository's tracked test inventory", () => {
  const tracked = execFileSync("git", ["-C", "../..", "ls-files"], { encoding: "utf8" })
    .trim().split("\n")
    .filter((path) => /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:\.(?:dbtest|test|spec)|-test)\.[^.]+$/u.test(path));
  assert.ok(tracked.includes("scripts/merge-integrator-system-test.mjs"));
  for (const path of tracked) assert.equal(isTestPath(path), true, path);
});

test("renames preserve guarded source identities", () => {
  assert.deepEqual(defenseTriggers([{
    filename: "packages/api/src/reader.ts",
    previousFilename: "packages/api/src/merge-readiness-worker.ts",
    patch: null,
  }]), [{ path: "packages/api/src/merge-readiness-worker.ts", reason: "merge-tail-machinery" }]);
});
