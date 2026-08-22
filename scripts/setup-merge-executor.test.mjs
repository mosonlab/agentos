import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  const marker = wizard.indexOf("# STAGES — author this section.");
  assert.ok(marker > 0, "STAGES marker is absent");
  const separatorEnd = wizard.indexOf("\n", wizard.indexOf("# ─", marker)) + 1;
  const library = wizard.slice(0, separatorEnd);
  assert.equal(
    createHash("sha256").update(library).digest("hex"),
    "33fa2aa97b8244f5d0675da4be7a82674d43cb0c8c28755f7eb56e980205fd0f",
    "wizard library above the authored stages differs from the canonical template",
  );
});

const runIdentityRefusal = (uidByUser) => {
  const fixture = mkdtempSync(join(tmpdir(), "merge-executor-identity-"));
  try {
    mkdirSync(join(fixture, "scripts"));
    mkdirSync(join(fixture, "packages", "merge-executor"), { recursive: true });
    mkdirSync(join(fixture, "bin"));
    copyFileSync(WIZARD_PATH, join(fixture, WIZARD_PATH));
    chmodSync(join(fixture, WIZARD_PATH), 0o755);
    writeFileSync(join(fixture, "package.json"), "{}\n");
    writeFileSync(join(fixture, "packages", "merge-executor", "package.json"), "{}\n");
    writeFileSync(join(fixture, ".env"), "");
    chmodSync(join(fixture, ".env"), 0o600);
    const cases = Object.entries(uidByUser).map(([user, uid]) => `    ${user}) printf '%s\\n' '${uid}' ;;`).join("\n");
    writeFileSync(join(fixture, "bin", "id"), `#!/bin/sh
case "$1" in
  -u)
    case "$2" in
${cases}
      *) exit 1 ;;
    esac
    ;;
  -Gn) printf '%s\\n' users ;;
  *) exit 0 ;;
esac
`);
    chmodSync(join(fixture, "bin", "id"), 0o755);
    return spawnSync("bash", [WIZARD_PATH], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(fixture, "bin")}:${process.env.PATH}` },
      input: "\nexecutor\napi,runner\nmerge-executor\nmerge-executor\nhttp://127.0.0.1:3000\n",
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
};

test("uid 0 is refused for both the executor and every declared peer", () => {
  const executorRoot = runIdentityRefusal({ executor: 0, api: 502, runner: 503 });
  assert.notEqual(executorRoot.status, 0);
  assert.match(executorRoot.stderr, /root-os-user: MERGE_EXECUTOR_OS_USER must not resolve to uid 0/u);

  const peerRoot = runIdentityRefusal({ executor: 501, api: 0, runner: 503 });
  assert.notEqual(peerRoot.status, 0);
  assert.match(peerRoot.stderr, /root-peer-user: declared peer api must not resolve to uid 0/u);
});

test("key validation consumes an administrator metadata receipt without traversing the protected path", () => {
  const validator = authoredStages.match(/validate_private_key_metadata_receipt\(\) \{(?<body>[\s\S]*?)\n\}/u)?.groups?.body ?? "";
  assert.match(validator, /MERGE_EXECUTOR_KEY_METADATA_V1/u);
  assert.match(validator, /validate_parent_mode_receipt/u);
  assert.doesNotMatch(validator, /(?:\[\[\s+-f|\[\[\s+-L|\bstat\b|\bfile_metadata\b|\bmode_of\b|\buid_of\b|\bsize_of\b)/u);
  assert.match(authoredStages, /sudo bash scripts\/setup-merge-executor\.sh --inspect-key-metadata %q %q/u);
  assert.match(authoredStages, /metadata-inspection-requires-root/u);
  assert.match(authoredStages, /key bytes were not read/u);
  assert.match(runbook, /mode-0700 executor-owned\s+directory/u);
  assert.match(runbook, /MERGE_EXECUTOR_KEY_METADATA_V1/u);
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
    "root-os-user",
    "root-peer-user",
    "key-mode-not-owner-only",
    "root-execution",
  ]) assert.match(authoredStages, new RegExp(namedRefusal, "u"));

  assert.match(readme, /\[operator runbook\]\(docs\/runbooks\/merge-executor\.md\)/u);
  assert.match(readme, /bash scripts\/setup-merge-executor\.sh/u);
  assert.match(envExample, /docs\/runbooks\/merge-executor\.md/u);
  assert.match(envExample, /scripts\/setup-merge-executor\.sh/u);
  for (const name of CAPTURED) assert.match(envExample, new RegExp(`^${name}=`, "mu"), `${name} is absent from .env.example`);
});

test("health and platform claims match the implemented and evidenced surfaces", () => {
  assert.match(runbook, /`daemons` row/u);
  assert.match(runbook, /`online: true`/u);
  assert.match(runbook, /`workspaceRoot: null` and `diskFreeBytes: null`/u);
  assert.match(runbook, /Run record[^.]*`adapterVersion`\s+and `cliVersion`[^.]*`merge-executor-v1`/u);
  assert.doesNotMatch(runbook, /Find the exact `MERGE_EXECUTOR_RUNNER_ID`, the `merge-executor-v1` adapter\/CLI identity/u);
  assert.match(readme, /documented but unverified macOS\s+LaunchDaemon and Linux systemd profiles/u);
  assert.match(runbook, /documented but unverified/u);
});

test("the wizard links official concepts and ends with exact non-secret next commands", () => {
  assert.match(authoredStages, /https:\/\/docs\.github\.com\/en\/apps\/creating-github-apps\/registering-a-github-app/u);
  assert.match(authoredStages, /https:\/\/docs\.github\.com\/en\/apps\/using-github-apps\/installing-your-own-github-app/u);
  assert.match(authoredStages, /npm run build/u);
  assert.match(authoredStages, /docs\/runbooks\/merge-executor\.md/u);
  assert.match(authoredStages, /No service was installed, no administrator command was run/u);
});
