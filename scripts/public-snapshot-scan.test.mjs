import assert from "node:assert/strict";
import test from "node:test";

import { globToRegExp, scanRepository, scanTextFindings } from "./public-snapshot-scan.mjs";

test("glob matching keeps the allowlist bounded", () => {
  assert.equal(globToRegExp("apps/**").test("apps/web/src/App.tsx"), true);
  assert.equal(globToRegExp("apps/**").test("packages/api/src/app.ts"), false);
  assert.equal(globToRegExp("docs/BACKLOG*.md").test("docs/BACKLOG-V2.md"), true);
});

test("credential evidence contains counts but never matched values", () => {
  const credential = `ghp_${"A".repeat(24)}`;
  const findings = scanTextFindings("fixture.txt", `token=${credential}\n`);
  assert.deepEqual(findings, [{ category: "credential", count: 1 }]);
  assert.equal(JSON.stringify(findings).includes(credential), false);
});

test("email and private-path evidence is redacted to metadata", () => {
  const email = ["person", "private.example"].join("@");
  const privatePath = ["", "Users", "private-person", "project"].join("/");
  const sensitive = `${email} ${privatePath}`;
  const findings = scanTextFindings("fixture.txt", sensitive);
  assert.deepEqual(findings, [
    { category: "private-absolute-path", count: 1 },
    { category: "pii-email", count: 1 },
  ]);
  assert.equal(JSON.stringify(findings).includes("private-person"), false);
  assert.equal(JSON.stringify(findings).includes("person@"), false);
});

test("the checked-out tree is fully classified", () => {
  const { report, includedPaths } = scanRepository();
  assert.equal(report.summary.countsByDisposition.blocker, 0);
  assert.equal(report.summary.countsByCategory.credential, 0);
  assert.equal(report.summary.countsByCategory["pii-government-id"], 0);
  assert.equal(report.scope.includedFiles, includedPaths.length);
  assert.equal(report.scope.trackedFiles, report.scope.includedFiles + report.scope.excludedFiles);
  assert.equal(includedPaths.includes("LICENSE"), true);
  assert.equal(includedPaths.includes("public-snapshot.json"), true);
});
