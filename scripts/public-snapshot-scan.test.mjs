import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  globToRegExp,
  scanRepository,
  scanTextFindings,
  scopeFor,
} from "./public-snapshot-scan.mjs";

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

test("only exact placeholder forms avoid a credential blocker", () => {
  const adversarial = "production-token-that-is-not-a-placeholder";
  const findings = scanTextFindings(".env.example", `API_KEY=${adversarial}\n`);
  assert.deepEqual(findings, [{ category: "credential", count: 1 }]);
  assert.equal(JSON.stringify(findings).includes(adversarial), false);

  assert.deepEqual(
    scanTextFindings(
      ".env.example",
      "FIRST_SECRET=\nSECOND_TOKEN=CHANGE_ME\nTHIRD_API_KEY=${INJECTED_API_KEY}\n",
    ),
    [{ category: "credential-placeholder", count: 3 }],
  );
});

test("repository-wide deny rules take precedence over reviewed source rules", () => {
  const manifest = JSON.parse(readFileSync("public-snapshot.json", "utf8"));
  for (const path of [
    "apps/web/runtime/session.stdout",
    "apps/web/coverage/operator.dump",
    "packages/api/private/operator-notes.md",
    "apps/web/src/runtime/session.ts",
  ]) {
    const scope = scopeFor(path, manifest);
    assert.equal(scope.classification, "excluded", path);
    assert.ok(scope.denies.length > 0, path);
  }

  assert.equal(
    scopeFor("packages/api/src/operator-notes.md", manifest).classification,
    "unclassified",
  );
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
  const { report, includedPaths } = scanRepository(undefined, { requireClean: false });
  assert.equal(report.summary.countsByDisposition.blocker, 0);
  assert.equal(report.summary.countsByCategory.credential, 0);
  assert.equal(report.summary.countsByCategory["pii-government-id"], 0);
  assert.equal(report.scope.includedFiles, includedPaths.length);
  assert.equal(report.scope.unclassifiedFiles, 0);
  assert.equal(report.scope.overlappingFiles, 0);
  assert.equal(
    report.scope.trackedFiles,
    report.scope.includedFiles +
      report.scope.excludedFiles +
      report.scope.unclassifiedFiles +
      report.scope.overlappingFiles,
  );
  assert.equal(includedPaths.includes("LICENSE"), true);
  assert.equal(includedPaths.includes("public-snapshot.json"), true);
});
