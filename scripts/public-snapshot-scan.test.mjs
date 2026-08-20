import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

/** The address rule has to point at people. Every shape below is a Git remote:
 *  the credential or service login sits where a mailbox would, and reading it as
 *  personal data spends a blocker on a string that names no one. Each is written
 *  the way this repository's own tests write them. */
test("git remote userinfo is not read as a personal address", () => {
  const remotes = [
    "ssh://git@github.com/owner/name.git",
    "git@github.com:owner/name.git",
    "https://user:password@github.com/owner/name.git",
    "https://ghp_exampletoken@github.com/owner/name.git",
    "https://x-access-token:token@github.com/owner/name.git",
    "ssh://git:secret@github.com/owner/name.git",
    "ghp_exampletoken@github.com:owner/name.git",
    "ssh://x-access-token@github.com/owner/name.git",
    "oauth2@gitlab.com:owner/name.git",
    "token@github.com",
  ];
  for (const remote of remotes) {
    assert.deepEqual(scanTextFindings("fixture.ts", `const url = "${remote}";\n`), [], remote);
  }
});

/** The negative control for the rule above: narrowing what counts as an address
 *  must not stop counting addresses. A mailbox written as a mailbox is still PII,
 *  including on a line that also carries a URL — proximity to a scheme is not the
 *  test, occupying the userinfo position is. */
test("a real address is still counted next to a url", () => {
  const address = ["alice.smith", "corp.example.invalid"].join("@");
  assert.deepEqual(scanTextFindings("fixture.md", `mail ${address}\n`), [
    { category: "pii-email", count: 1 },
  ]);
  assert.deepEqual(
    scanTextFindings("fixture.md", `see https://github.com/owner/name and mail ${address}\n`),
    [{ category: "pii-email", count: 1 }],
  );
  assert.deepEqual(scanTextFindings("fixture.md", `<${address}>: reachable\n`), [
    { category: "pii-email", count: 1 },
  ]);
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
    report.scope.trackedFiles + report.scope.mintedFiles,
    report.scope.includedFiles +
      report.scope.excludedFiles +
      report.scope.unclassifiedFiles +
      report.scope.overlappingFiles,
  );
  assert.equal(includedPaths.includes("LICENSE"), true);
  assert.equal(includedPaths.includes("public-snapshot.json"), true);
});

test("a credential on the published surface is red whatever disposition it carries", () => {
  // The published half of the scoped check, proven on real bytes rather than a
  // fabricated report: `release-authority.json` is on the published surface, so
  // a token planted in it is a credential the export would carry. It is a
  // tracked file, so this test puts its bytes back rather than deleting it.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const artifact = resolve(root, "release-authority.json");
  const original = readFileSync(artifact);

  try {
    writeFileSync(artifact, JSON.stringify({ token: `ghp_${"A".repeat(24)}` }, null, 2));
    const { report, includedPaths } = scanRepository(undefined, { requireClean: false });
    assert.equal(includedPaths.includes("release-authority.json"), true, "the plant must be on the published surface");
    const flagged = report.findings.filter(
      (finding) => finding.category === "credential" && includedPaths.includes(finding.path),
    );
    assert.deepEqual(
      flagged.map((finding) => finding.path),
      ["release-authority.json"],
      "a credential on a published path must be reported out of scope",
    );
    assert.equal(JSON.stringify(flagged).includes("ghp_"), false, "no matched value may be emitted");

    // And the published clause does not consult the disposition: relabelling
    // the same finding the way an `approvedFindings` entry would still fails.
    const approved = {
      ...report,
      findings: report.findings.map((finding) =>
        finding.category === "credential" ? { ...finding, disposition: "approved-public-material" } : finding,
      ),
    };
    assert.equal(
      approved.findings.filter(
        (finding) => finding.category === "credential" && includedPaths.includes(finding.path),
      ).length,
      1,
      "approving a credential into the snapshot must not clear it",
    );
  } finally {
    writeFileSync(artifact, original);
  }
});

/**
 * The five Goal 5a0 scripts, named one at a time.
 *
 * These are the published boundary's own executable proof: two of them are the
 * test files that prove the other three refuse a filesystem-root, checkout,
 * non-empty, symlinked, or non-allowlisted evidence destination. A manifest
 * edit that dropped, renamed, narrowed or re-globbed any of them would still
 * produce a green scan — the scan reports on what is listed, and a shorter list
 * is a shorter, greener report. So the list is asserted by exact string here,
 * where removing one is a failing test rather than a quieter one.
 *
 * A wider glob that happens to cover a file is not a substitute. `scripts/*.mjs`
 * would publish these and much else besides, and the point is that this
 * repository decided on these five by name.
 */
const GOAL_5A0_MANIFEST_ENTRIES = [
  "scripts/goal-5a0-dependency-gate.sh",
  "scripts/goal-5a0-dependency-gate.test.mjs",
  "scripts/goal-5a0-evidence-destination.sh",
  "scripts/goal-5a0-handoff-preimage.mjs",
  "scripts/goal-5a0-handoff-preimage.test.mjs",
];

test("every Goal 5a0 manifest entry survives, by exact glob", () => {
  const manifest = JSON.parse(readFileSync("public-snapshot.json", "utf8"));
  const globs = manifest.include.map((entry) => entry.glob);
  for (const entry of GOAL_5A0_MANIFEST_ENTRIES) {
    assert.ok(globs.includes(entry), `public-snapshot.json no longer publishes ${entry} by name`);
    assert.ok(statSync(entry).isFile(), `${entry} is published but not in the checkout`);
  }
  // Both test files, specifically: a boundary published without its own proof
  // is a boundary nobody can check.
  assert.equal(GOAL_5A0_MANIFEST_ENTRIES.filter((entry) => entry.endsWith(".test.mjs")).length, 2);
});

test("the docs surface is closed and named one file at a time", () => {
  const manifest = JSON.parse(readFileSync("public-snapshot.json", "utf8"));
  const docs = manifest.include.map((entry) => entry.glob).filter((glob) => glob.startsWith("docs/"));
  // `docs/` is closed by default and this is the whole of what is open in it.
  // Publishing user documentation must not become a reason to publish plans,
  // reviews, specifications or runbooks alongside it.
  assert.deepEqual(docs.sort(), [
    "docs/public-snapshot.md",
    "docs/release/fixtures/oss-b0-smoke-task.json",
    "docs/release/v0.1.0-developer-preview.md",
    "docs/release/v0.1.0-license-and-assets.md",
    "docs/release/v0.1.0-migration-and-recovery.md",
    "docs/release/v0.1.0-release-notes.md",
    "docs/release/v0.1.0-security.md",
    "docs/release/v0.1.0-support-matrix.md",
  ]);
  // Named one at a time rather than by `docs/release/*.md`, because a directory
  // glob would publish anything dropped into the directory later — the
  // maintainer's evidence template is in there and is not a reader's document.
  // Adding a release page to the public set stays a reviewed manifest edit plus
  // a failing-then-updated test, not a side effect.
  for (const glob of docs) {
    assert.equal(glob.includes("*"), false, `${glob} must name one file, not a directory`);
  }
  assert.equal(
    manifest.exclude.some((entry) => entry.glob === "docs/release/v0.1.0-evidence-template.md"),
    true,
    "the evidence template is the maintainer's form, excluded by name with a reason",
  );
});

test("the six release documents the inventory names are published, and tracked", () => {
  // The release artifact inventory names exactly these six pages plus the five
  // root governance files. A manifest entry for a file that is not tracked
  // publishes nothing, and a tracked file with no entry is a scan failure, so
  // both halves are asserted here rather than assumed from either one.
  const released = [
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "SECURITY.md",
    "SUPPORT.md",
    "THIRD_PARTY_NOTICES.md",
    "docs/release/v0.1.0-developer-preview.md",
    "docs/release/v0.1.0-license-and-assets.md",
    "docs/release/v0.1.0-migration-and-recovery.md",
    "docs/release/v0.1.0-release-notes.md",
    "docs/release/v0.1.0-security.md",
    "docs/release/v0.1.0-support-matrix.md",
  ];
  const manifest = JSON.parse(readFileSync("public-snapshot.json", "utf8"));
  const included = new Set(manifest.include.map((entry) => entry.glob));
  for (const path of released) {
    assert.equal(included.has(path), true, `${path} must be published by exact name`);
    assert.equal(
      execFileSync("git", ["ls-files", path]).toString("utf8").trim(),
      path,
      `${path} must be tracked, not merely present on disk`,
    );
    assert.equal(scopeFor(path, manifest).classification, "included", `${path} must classify as included`);
  }
  const { report } = scanRepository(undefined, { requireClean: false });
  assert.equal(report.scope.unclassifiedFiles, 0);
});

test("every workspace manifest records the same first-party version", () => {
  // One version across the root and every workspace, with `private` intact.
  // A release that ships two versions of itself is ambiguous about which one
  // the tag names, and a manifest that lost `private: true` is one `npm publish`
  // away from a registry entry nobody decided to create.
  const manifests = execFileSync("git", ["ls-files", "package.json", "apps/*/package.json", "packages/*/package.json"])
    .toString("utf8").trim().split("\n");
  assert.ok(manifests.length >= 10, "expected the root manifest and every workspace manifest");
  for (const path of manifests) {
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(pkg.version, "0.1.0", `${path} must record version 0.1.0`);
    assert.equal(pkg.private, true, `${path} must stay private`);
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const [name, range] of Object.entries(pkg[field] ?? {})) {
        if (!name.startsWith("@agentos/")) continue;
        assert.equal(range, "0.1.0", `${path} must pin ${name} to the exact release version`);
      }
    }
  }
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  assert.equal(lock.version, "0.1.0", "the lockfile must record the same root version");
});

test("the release trust anchor is tracked, classified included, and actually published", () => {
  // The anchor is what the second authority path rests on: a published snapshot
  // that ships `release-authority.json` without the key it verifies against is
  // a snapshot whose readers stop at `authority`. Its include glob predates the
  // key, so until now it matched nothing and no test could tell the difference
  // between "published" and "not there".
  const anchor = "release-authority.pub";
  assert.equal(
    execFileSync("git", ["ls-files", anchor]).toString("utf8").trim(),
    anchor,
    "the trust anchor must be a tracked file, reviewed and gated like any other source",
  );
  const manifest = JSON.parse(readFileSync("public-snapshot.json", "utf8"));
  assert.equal(scopeFor(anchor, manifest).classification, "included");

  const { includedPaths } = scanRepository(undefined, { requireClean: false });
  assert.equal(includedPaths.includes(anchor), true, "the trust anchor must be on the published surface");
});
