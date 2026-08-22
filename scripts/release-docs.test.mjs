import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const PUBLIC_EXISTING_MODE_DOCS = [
  "README.md",
  "README.zh-CN.md",
  "docs/release/v0.1.0-migration-and-recovery.md",
  "docs/release/v0.1.0-support-matrix.md",
];

const CURRENT_CLI_SURFACE_DOCS = [
  "README.md",
  "README.zh-CN.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "docs/release/v0.1.0-release-notes.md",
  "docs/release/v0.1.0-support-matrix.md",
  "docs/release/v0.2.0-release-notes.md",
];

test("published docs do not advertise or require the retired repository CLI", () => {
  for (const path of CURRENT_CLI_SURFACE_DOCS) {
    const text = readFileSync(path, "utf8");
    assert.doesNotMatch(text, /agentos\s+help|phase-0\s+CLI|CLI\s+help check/u, path);
  }
  assert.match(readFileSync("README.md", "utf8"), /does not ship a repository command-line interface/u);
  assert.match(readFileSync("README.zh-CN.md", "utf8"), /不再提供仓库命令行界面/u);
});

test("published docs describe the executable existing-mode consumer truthfully", () => {
  const docs = PUBLIC_EXISTING_MODE_DOCS.map((path) => [path, readFileSync(path, "utf8")]);
  for (const [path, text] of docs) {
    assert.equal(
      text.includes("oss-d-interface-unavailable"),
      false,
      `${path} must not document a condition the release migrator cannot emit`,
    );
    assert.match(text, /--existing/u, `${path} must state the existing-mode boundary`);
  }

  const migrationGuide = docs.find(([path]) => path.endsWith("migration-and-recovery.md"))?.[1];
  assert.ok(migrationGuide);
  assert.match(migrationGuide, /npm run db:migrate:release -- --existing\n/u);
  assert.match(
    migrationGuide,
    /STOP release-migrate arguments: existing-mode-requires---backup-bundle/u,
  );
  assert.match(migrationGuide, /does not ship the\n> backup producer/u);
});

test("the documented no-bundle invocation stops at the argument boundary", () => {
  const result = spawnSync("npm", ["run", "db:migrate:release", "--", "--existing"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      RUNNER_WORKSPACE_ROOT: process.env.RUNNER_WORKSPACE_ROOT,
    },
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stderr,
    /^STOP release-migrate arguments: existing-mode-requires---backup-bundle$/mu,
  );
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /step=target|DATABASE_URL|postgres/iu);
});
