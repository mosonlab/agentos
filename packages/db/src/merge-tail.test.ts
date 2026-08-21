import assert from "node:assert/strict";
import test from "node:test";

import {
  defenseListReason,
  isMergeReadinessStep,
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

test("the defense list covers gate, migration, authority, role, template, and workflow paths", () => {
  for (const path of [
    "scripts/merge-gate.sh",
    "scripts/gate-worker/gate-dispatch.sh",
    "packages/db/prisma/migrations/20260821_tail/migration.sql",
    "docs/release/release-authority.public.pem",
    "agents/roles/merge-resolver.md",
    "agents/templates/direct-engineer-workflow/06-merge-readiness.md",
    "packages/api/src/merge-readiness-worker.ts",
    "packages/api/src/app.ts",
  ]) assert.notEqual(defenseListReason(path), null, path);
  assert.equal(defenseListReason("apps/web/src/app.tsx"), null);
});

test("resolution review triggers only when existing test lines changed", () => {
  assert.deepEqual(resolutionTestTriggers([{ filename: "src/a.test.ts", patch: "@@ -1,0 +2 @@\n+added" }]), []);
  assert.deepEqual(resolutionTestTriggers([{ filename: "src/a.test.ts", patch: "@@ -1 +1 @@\n-old\n+new" }]), [
    { path: "src/a.test.ts", reason: "existing-test-lines-modified" },
  ]);
  assert.deepEqual(resolutionTestTriggers([{ filename: "src/a.ts", patch: "@@ -1 +1 @@\n-old\n+new" }]), []);
  assert.deepEqual(resolutionTestTriggers([{ filename: "src/a.test.ts", patch: null }]), [
    { path: "src/a.test.ts", reason: "existing-test-lines-unverifiable" },
  ]);
});
