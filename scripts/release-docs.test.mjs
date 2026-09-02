import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const PUBLIC_EXISTING_MODE_DOCS = [
  "docs/install.md",
  "docs/release/migration-and-recovery.md",
  "docs/release/support-matrix.md",
];

const CURRENT_CLI_SURFACE_DOCS = [
  "README.md",
  "README.zh-CN.md",
  "docs/architecture.md",
  "docs/install.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "docs/release/support-matrix.md",
  "docs/release/v0.2.0-release-notes.md",
];

const CANONICAL_ONBOARDING_DOC = "docs/runbooks/add-a-project.md";
const REDUCED_CANONICAL_SYNC_DOCS = ["agents/README.md", "docs/install.md"];
const CANONICAL_NAME_MANAGEMENT_RULE =
  "An Agent or task template whose name is a canonical name is rewritten to the canonical text on every deploy; a project that needs a different prompt uses a different name.";
const CANONICAL_SYNC_COMMANDS = [
  "db:sync-canonical-prompts",
  "db:verify-agent-template",
  "--install-full",
];
const FULL_TAIL_READINESS_CATEGORIES = [
  "Repository files",
  "Control-plane prerequisites",
  "Operator infrastructure",
];
const FULL_TAIL_REPOSITORY_FILES = [
  "scripts/merge-gate.sh",
];

test("published docs do not advertise or require the retired repository CLI", () => {
  for (const path of CURRENT_CLI_SURFACE_DOCS) {
    const text = readFileSync(path, "utf8");
    assert.doesNotMatch(
      text,
      /npm\s+run\s+agentos\b|agentos(?:\s+--)?\s+help\b|packages\/cli(?:\/dist)?\b|phase-0\s+cli\b|cli\s+help\s+check\b/iu,
      path,
    );
  }
  assert.match(
    readFileSync("docs/architecture.md", "utf8"),
    /does not ship a repository command-line interface/u,
  );
});

test("tagged release verification retains its historical CLI check", () => {
  const notes = readFileSync("docs/release/v0.1.0-release-notes.md", "utf8");
  assert.match(notes, /npm\s+run\s+agentos\s+--\s+help\b/u);
  assert.match(
    readFileSync("docs/release/v0.2.0-release-notes.md", "utf8"),
    /v0\.1\.0 release notes[\s\S]*apply unchanged/u,
  );
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

test("the add-project runbook owns canonical sync and full-tail onboarding", () => {
  const onboarding = readFileSync(CANONICAL_ONBOARDING_DOC, "utf8");
  assert.match(onboarding, /^## Tier 0 checklist\b/m);
  assert.match(onboarding, /^## Tier 1 checklist\b/m);
  assert.match(onboarding, /- \[ \]/u);

  for (const command of CANONICAL_SYNC_COMMANDS) {
    assert.ok(onboarding.includes(command), `${CANONICAL_ONBOARDING_DOC}: ${command}`);
  }
  assert.match(onboarding, /partial (?:canonical )?inventory/u, CANONICAL_ONBOARDING_DOC);
  for (const category of FULL_TAIL_READINESS_CATEGORIES) {
    assert.ok(onboarding.includes(category), `${CANONICAL_ONBOARDING_DOC}: ${category}`);
  }
  for (const repositoryFile of FULL_TAIL_REPOSITORY_FILES) {
    assert.ok(onboarding.includes(`\`${repositoryFile}\``), `${CANONICAL_ONBOARDING_DOC}: ${repositoryFile}`);
  }
  assert.match(onboarding, /in-Project Repo/u, CANONICAL_ONBOARDING_DOC);
  assert.match(onboarding, /AgentRepoAccess[\s\S]*every\s+effective\s+template\s+assignee|every\s+effective\s+template\s+assignee[\s\S]*AgentRepoAccess/iu, CANONICAL_ONBOARDING_DOC);
  assert.match(onboarding, /required model CLIs for the selected roles/u, CANONICAL_ONBOARDING_DOC);
  assert.match(onboarding, /authenticated `gh`/u, CANONICAL_ONBOARDING_DOC);
  assert.match(onboarding, /GITHUB_READ_TOKEN/u, CANONICAL_ONBOARDING_DOC);
  assert.match(onboarding, /RUNNER_GATE_SERVER/u, CANONICAL_ONBOARDING_DOC);
  assert.match(onboarding, /private merge-executor GitHub App installed on the target repository/u, CANONICAL_ONBOARDING_DOC);
  assert.match(onboarding, /isolated executor service/u, CANONICAL_ONBOARDING_DOC);
  assert.match(onboarding, /Provider authentication is runner-host\s+infrastructure/u, CANONICAL_ONBOARDING_DOC);
  assert.match(onboarding, /AgentSecretGrant[\s\S]*not\s+(?:required|a\s+full-tail\s+readiness\s+prerequisite)/iu, CANONICAL_ONBOARDING_DOC);
  assert.match(onboarding, /Node on the runner[\s\S]*documented prerequisites, not probes/iu, CANONICAL_ONBOARDING_DOC);
  assert.match(onboarding, /Regression, not an in-Run agent, executes the gate/u, CANONICAL_ONBOARDING_DOC);

  for (const path of REDUCED_CANONICAL_SYNC_DOCS) {
    const text = readFileSync(path, "utf8");
    assert.ok(text.replace(/\s+/gu, " ").includes(CANONICAL_NAME_MANAGEMENT_RULE), `${path}: canonical-name management rule`);
    assert.match(text, /(?:\.\.\/)?(?:docs\/)?runbooks\/add-a-project\.md/u, path);
    for (const command of CANONICAL_SYNC_COMMANDS) {
      assert.doesNotMatch(text, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"), `${path}: ${command}`);
    }
    for (const category of FULL_TAIL_READINESS_CATEGORIES) {
      assert.doesNotMatch(text, new RegExp(`^## .*${category}`, "mu"), `${path}: ${category}`);
    }
  }
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
