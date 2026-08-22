import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";

const WIZARD_PATH = "scripts/setup-merge-executor.sh";
const RUNBOOK_PATH = "docs/runbooks/merge-executor.md";
const wizard = readFileSync(WIZARD_PATH, "utf8");
const runbook = readFileSync(RUNBOOK_PATH, "utf8");
const readme = readFileSync("README.md", "utf8");
const envExample = readFileSync(".env.example", "utf8");

const CAPTURED = [
  "MERGE_EXECUTOR_OS_USER",
  "MERGE_EXECUTOR_PEER_USERS",
  "MERGE_EXECUTOR_RUNNER_ID",
  "MERGE_EXECUTOR_RUNNER_IDS",
  "MERGE_EXECUTOR_API_URL",
  "MERGE_EXECUTOR_GITHUB_APP_ID",
  "MERGE_EXECUTOR_GITHUB_APP_INSTALLATION_ID",
  "MERGE_EXECUTOR_IDENTITY_LOGIN",
  "MERGE_EXECUTOR_GITHUB_APP_PRIVATE_KEY_FILE",
  "MERGE_EXECUTOR_TOKEN",
];

const SERVICE_VALUES = CAPTURED.filter((name) => name !== "MERGE_EXECUTOR_RUNNER_IDS");

const authoredStages = wizard.slice(wizard.indexOf("TOTAL_STAGES=5"));

test("the wizard is executable Bash and retains the canonical library bytes", () => {
  const syntax = spawnSync("bash", ["-n", WIZARD_PATH], { encoding: "utf8" });
  assert.equal(syntax.status, 0, `${syntax.stdout}\n${syntax.stderr}`);
  assert.ok((statSync(WIZARD_PATH).mode & 0o111) !== 0, "wizard is not executable");

  const marker = wizard.indexOf("# STAGES: author this section.");
  assert.ok(marker > 0, "STAGES marker is absent");
  const separatorEnd = wizard.indexOf("\n", wizard.indexOf("# ─", marker)) + 1;
  const library = wizard.slice(0, separatorEnd);
  assert.equal(
    createHash("sha256").update(library).digest("hex"),
    "d1f95e89977a9cc5ccaec9beb48032d3351fc9e7f9fd78152feb9eef1e2c5760",
    "wizard library above the authored stages differs from the canonical template",
  );
});

test("every captured value has its declared configuration destination", () => {
  const captured = [...authoredStages.matchAll(/\bask(?:_secret)? ([A-Z][A-Z0-9_]*) "/gu)].map((match) => match[1]);
  assert.deepEqual(captured, CAPTURED);

  for (const name of CAPTURED) {
    assert.match(authoredStages, new RegExp(`write_env ${name} "\\$${name}"`, "u"), `${name} is not written to .env`);
    assert.match(runbook, new RegExp("\\| `" + name + "` \\|", "u"), `${name} is absent from the destination table`);
  }

  const serviceWriter = authoredStages.match(/write_service_environment\(\) \{(?<body>[\s\S]*?)\n\}/u)?.groups?.body ?? "";
  for (const name of SERVICE_VALUES) {
    assert.match(serviceWriter, new RegExp(`\\b${name}\\b`, "u"), `${name} is absent from the executor service file`);
  }
  assert.doesNotMatch(serviceWriter, /\bMERGE_EXECUTOR_RUNNER_IDS\b/u);
  assert.match(runbook, /`MERGE_EXECUTOR_RUNNER_IDS` \| Same key \| Not copied \| API claim allowlist/u);
});

test("secret entry is hidden and no authored output or external argv receives it", () => {
  assert.match(authoredStages, /ask_secret MERGE_EXECUTOR_TOKEN "[^"]+"/u);
  assert.doesNotMatch(authoredStages, /\bask MERGE_EXECUTOR_TOKEN\b/u);
  assert.doesNotMatch(authoredStages, /\bset_secret\b/u);
  assert.doesNotMatch(authoredStages, /(?:say|step|note|warn) "[^"]*\$MERGE_EXECUTOR_TOKEN/u);
  assert.doesNotMatch(authoredStages, /^\s*(?:sudo|gh|curl)\b/gmu);
  assert.match(authoredStages, /write_env MERGE_EXECUTOR_TOKEN "\$MERGE_EXECUTOR_TOKEN"/u);
  assert.match(authoredStages, /chmod 0600 "\$tmp"/u);
  assert.match(authoredStages, /require_mode_0600 "\$ENV_FILE"/u);
  assert.match(runbook, /never belong in `\.env`, a plist, a unit, an argument/u);
});

test("the permission map names every required source operation and mutation evidence", () => {
  const permissions = [
    ["Administration", "Read", "branchProtectionRules"],
    ["Checks", "Read", "CheckRun"],
    ["Commit statuses", "Read", "StatusContext"],
    ["Contents", "Read and write", "createMergeCommit"],
    ["Merge queues", "Read and write", "dequeuePullRequest"],
    ["Metadata", "Read", "repository identity"],
    ["Pull requests", "Read and write", "disablePullRequestAutoMerge"],
    ["Workflows", "Read and write", "workflow files"],
  ];
  for (const [permission, access, operation] of permissions) {
    assert.match(runbook, new RegExp(`\\| ${permission} \\| ${access} \\|`, "u"), `${permission} access is missing`);
    assert.match(runbook, new RegExp(operation, "u"), `${permission} has no named source operation`);
    assert.match(authoredStages, new RegExp(`step "${permission}: ${access === "Read" ? "Read-only" : access === "Read and write" ? "Read and write" : access}`, "u"));
  }

  for (const operation of [
    "createSanitizedTree",
    "createMergeCommit",
    "updateBaseRef",
    "disablePullRequestAutoMerge",
    "dequeuePullRequest",
  ]) {
    const row = runbook.split("\n").find((line) => line.startsWith(`| \`${operation}\``));
    assert.ok(row, `${operation} mutation row is missing`);
    assert.ok((row.match(/\|/gu)?.length ?? 0) >= 4, `${operation} row lacks permission/evidence columns`);
  }
});

test("isolation, service, lifecycle, and public setup checklists stay present", () => {
  const normalizedRunbook = runbook.replace(/\s+/gu, " ");
  for (const required of [
    "dedicated, non-admin OS user",
    "root-owned runtime",
    "root-owned service configuration",
    "owner-only key",
    "distinct from `OPERATOR_TOKEN` and `RUNNER_TOKEN`",
    "macOS LaunchDaemon",
    "Linux systemd",
    "RunAtLoad",
    "WantedBy=multi-user.target",
    "no passwordless sudo",
    "`/runners`",
    "First positive App-bot merge",
    "Rotate the executor API token",
    "Rotate a GitHub App private key",
    "Recover from a lost App key",
    "does not adopt",
  ]) assert.match(normalizedRunbook, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), `missing checklist item: ${required}`);

  for (const namedRefusal of [
    "placeholder-value",
    "aliased-executor-token",
    "same-user-peer",
    "key-mode-not-owner-only",
    "root-execution",
  ]) assert.match(authoredStages, new RegExp(namedRefusal, "u"));

  assert.match(readme, /\[operator runbook\]\(docs\/runbooks\/merge-executor\.md\)/u);
  assert.match(readme, /bash scripts\/setup-merge-executor\.sh/u);
  assert.match(envExample, /docs\/runbooks\/merge-executor\.md/u);
  assert.match(envExample, /scripts\/setup-merge-executor\.sh/u);
  for (const name of CAPTURED) assert.match(envExample, new RegExp(`^${name}=`, "mu"), `${name} is absent from .env.example`);
});

test("the wizard links official concepts and ends with exact non-secret next commands", () => {
  assert.match(authoredStages, /https:\/\/docs\.github\.com\/en\/apps\/creating-github-apps\/registering-a-github-app/u);
  assert.match(authoredStages, /https:\/\/docs\.github\.com\/en\/apps\/using-github-apps\/installing-your-own-github-app/u);
  assert.match(authoredStages, /npm run build/u);
  assert.match(authoredStages, /docs\/runbooks\/merge-executor\.md/u);
  assert.match(authoredStages, /No service was installed, no administrator command was run/u);
});
