import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildChildEnvironment } from "./adapters.js";
import type { ClaimedTask } from "./api.js";
import type { RunnerConfig } from "./config.js";
import { platformCommitArgs } from "./exec.js";
import { provisionWorkspace, workspaceEnvironment, type Workspace } from "./workspace.js";

const HUMAN = { name: "Human Maintainer", email: "maintainer@example.invalid" };

const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    ...(env ? { env } : {}),
  }).trim();

const seedRemote = async (root: string): Promise<string> => {
  const remote = join(root, "origin.git");
  const seed = join(root, "seed");
  git(root, ["init", "--bare", "--initial-branch=main", remote]);
  git(root, ["init", "--initial-branch=main", seed]);
  git(seed, ["config", "user.name", "Seed Author"]);
  git(seed, ["config", "user.email", "seed@example.invalid"]);
  await writeFile(join(seed, "base.txt"), "base\n");
  git(seed, ["add", "base.txt"]);
  git(seed, ["commit", "-m", "seed"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-u", "origin", "main"]);
  return remote;
};

const config = (root: string, identity: RunnerConfig["gitIdentity"] = HUMAN): RunnerConfig => ({
  apiUrl: "http://api.invalid",
  runnerToken: "runner-token",
  runnerId: "runner-provenance",
  daemonVersion: "0.0.0-test",
  pollIntervalMs: 5_000,
  leaseSeconds: 60,
  heartbeatIntervalMs: 5_000,
  path: process.env.PATH ?? "/usr/bin:/bin",
  home: join(root, "home"),
  gitIdentity: identity,
  workspaceRoot: join(root, "runs"),
  failedWorkspaceRetention: 0,
  workspaceReclaimIntervalMs: 300_000,
  toolDeadlineMs: 60_000,
  apiTimeoutMs: 5_000,
  runAsPrefix: [],
  binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" },
});

const claim = (
  remoteUrl: string,
  runId: string,
  overrides: Partial<Pick<ClaimedTask["task"], "chainId" | "chainIndex" | "templateStep">> = {},
): ClaimedTask => ({
  executionMode: "agent",
  specificationMaterialization: null,
  task: {
    id: `task-${runId}`,
    chainId: "chain-provenance",
    chainIndex: 3,
    name: "Implement provenance",
    description: "Add commit provenance",
    repoId: "repo-provenance",
    targetBranch: "main",
    maxDurationMin: 30,
    stallTimeoutMin: 10,
    maxSessionsPerTask: 2,
    templateStep: { name: "Implementation", outputKind: "implementation" },
    ...overrides,
  },
  agent: {
    id: "agent-provenance",
    name: "implementer",
    model: "codex",
    foundationalPrompt: "foundation",
    rolePrompt: "implement",
    disabledTools: [],
  },
  repo: { id: "repo-provenance", remoteUrl, defaultBranch: "main", mountPath: "repo" },
  run: {
    id: runId,
    runNumber: 1,
    opensPullRequest: true,
    pullRequestBase: "main",
    maxDurationMin: 30,
    stallTimeoutMin: 10,
    maxRunsPerTask: 2,
    model: "codex",
    codexServiceTier: "DEFAULT",
    subagentModel: null,
    subagentMaxConcurrent: null,
    targetBranch: "main",
    targetBranchPublished: false,
    pinnedBaseSha: null,
    implementationBaseSha: null,
    implementationHeadSha: null,
    promptHash: "hash",
    workspacePath: null,
    branch: `agentos/${runId}`,
    baseSha: null,
  },
  session: { id: `session-${runId}` },
  resume: null,
  nextEventSeq: 0,
  runner: "CODEX",
  fencingToken: "fence",
  sessionToken: "session-token",
  secrets: {
    GIT_AUTHOR_NAME: "Hostile Secret Author",
    GIT_AUTHOR_EMAIL: "hostile@example.invalid",
    GIT_COMMITTER_NAME: "Hostile Secret Committer",
    GIT_COMMITTER_EMAIL: "hostile@example.invalid",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "Hostile Config Author",
  },
  priorOutputs: [],
  operatorNotes: [],
  previousRunHandoff: null,
  regressionRepairHandoff: null,
});

const providerEnvironment = (configured: RunnerConfig, claimed: ClaimedTask, workspace: Workspace): NodeJS.ProcessEnv =>
  buildChildEnvironment(configured, claimed, {
    base: join(configured.workspaceRoot, "scratch"),
    workspaceRoot: join(configured.workspaceRoot, "scratch", "workspaces"),
    stateDir: join(configured.workspaceRoot, "scratch", "state"),
    configRoot: join(configured.workspaceRoot, "scratch", "config"),
  }, workspace.path, workspace.commitHooksPath);

const commitMessage = (cwd: string): string => git(cwd, ["show", "-s", "--format=%B", "HEAD"]);

test("a chain provider commit pins the human identity and records its exact claimed run provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "anneal-provenance-chain-"));
  try {
    const remote = await seedRemote(root);
    const configured = config(root);
    const claimed = claim(remote, "run-real-123");
    const workspace = await provisionWorkspace(configured, claimed);
    const env = providerEnvironment(configured, claimed, workspace);
    assert.equal(env.GIT_CONFIG_COUNT, "1", "the task secret cannot replace runner-owned Git config injection");
    assert.equal(env.GIT_CONFIG_KEY_0, "core.hooksPath");
    assert.equal(env.GIT_AUTHOR_NAME, undefined, "task secrets cannot override local human identity");

    await writeFile(join(workspace.path, "provider.txt"), "provider change\n");
    git(workspace.path, ["add", "provider.txt"], env);
    git(workspace.path, ["commit", "-m", "provider commit"], env);

    assert.equal(git(workspace.path, ["show", "-s", "--format=%an", "HEAD"]), HUMAN.name);
    assert.equal(git(workspace.path, ["show", "-s", "--format=%ae", "HEAD"]), HUMAN.email);
    assert.equal(commitMessage(workspace.path), [
      "provider commit",
      "",
      "Co-Authored-By: Anneal Chain <chain@anneal.invalid>",
      `X-Anneal-Run: ${claimed.run.id}`,
      "X-Anneal-Step: 3: Implementation",
      "X-Anneal-Provider: codex",
    ].join("\n"));
    assert.throws(
      () => git(workspace.path, ["config", "--local", "--get", "core.hooksPath"]),
      /Command failed/u,
      "a retained workspace must not keep the provider hook activated",
    );

    await writeFile(join(workspace.path, "platform.txt"), "runner owned\n");
    git(workspace.path, ["add", "platform.txt"], workspaceEnvironment(configured));
    git(workspace.path, platformCommitArgs("runner platform commit", "platform.txt"), workspaceEnvironment(configured));
    assert.doesNotMatch(commitMessage(workspace.path), /X-Anneal-Run:/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the provider hook covers an in-workspace linked worktree but refuses a nested independent repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "anneal-provenance-worktree-"));
  try {
    const remote = await seedRemote(root);
    const configured = config(root);
    const claimed = claim(remote, "run-linked-456");
    const workspace = await provisionWorkspace(configured, claimed);
    const env = providerEnvironment(configured, claimed, workspace);
    const linked = join(workspace.path, "worktrees", "linked");
    await mkdir(join(workspace.path, "worktrees"));
    git(workspace.path, ["worktree", "add", "-b", "linked", linked], env);
    await writeFile(join(linked, "linked.txt"), "linked change\n");
    git(linked, ["add", "linked.txt"], env);
    git(linked, ["commit", "-m", "linked commit"], env);
    assert.match(commitMessage(linked), new RegExp(`^X-Anneal-Run: ${claimed.run.id}$`, "mu"));
    assert.equal(git(linked, ["show", "-s", "--format=%ae", "HEAD"]), HUMAN.email);

    const nested = join(workspace.path, "nested");
    git(workspace.path, ["init", "--initial-branch=main", nested], env);
    git(nested, ["config", "user.name", HUMAN.name], env);
    git(nested, ["config", "user.email", HUMAN.email], env);
    await writeFile(join(nested, "nested.txt"), "nested change\n");
    git(nested, ["add", "nested.txt"], env);
    git(nested, ["commit", "-m", "nested commit"], env);
    assert.doesNotMatch(commitMessage(nested), /X-Anneal-Run:/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rewrite operations remain unmarked and conflicting provenance fails the commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "anneal-provenance-rewrite-"));
  try {
    const remote = await seedRemote(root);
    const configured = config(root);
    const claimed = claim(remote, "run-rewrite-789");
    const workspace = await provisionWorkspace(configured, claimed);
    const env = providerEnvironment(configured, claimed, workspace);

    await writeFile(join(workspace.path, "provider.txt"), "provider change\n");
    git(workspace.path, ["add", "provider.txt"], env);
    git(workspace.path, ["commit", "-m", "provider commit"], env);
    assert.match(commitMessage(workspace.path), /X-Anneal-Run: run-rewrite-789/u);

    await writeFile(join(workspace.path, "provider.txt"), "amended provider change\n");
    git(workspace.path, ["add", "provider.txt"], env);
    git(workspace.path, ["commit", "--amend", "--no-edit"], env);
    assert.doesNotMatch(commitMessage(workspace.path), /X-Anneal-|Anneal Chain/u, "--amend strips inherited provenance");

    git(workspace.path, ["switch", "-c", "cherry-source"], workspaceEnvironment(configured));
    await writeFile(join(workspace.path, "cherry.txt"), "source\n");
    git(workspace.path, ["add", "cherry.txt"], workspaceEnvironment(configured));
    git(workspace.path, ["commit", "-m", [
      "cherry source",
      "",
      "Co-Authored-By: Anneal Chain <chain@anneal.invalid>",
      "X-Anneal-Run: run-from-another-chain",
      "X-Anneal-Step: 1: Earlier step",
      "X-Anneal-Provider: claude",
    ].join("\n")], workspaceEnvironment(configured));
    const cherry = git(workspace.path, ["rev-parse", "HEAD"]);
    git(workspace.path, ["switch", "-C", workspace.branch, "HEAD^"], workspaceEnvironment(configured));
    git(workspace.path, ["cherry-pick", cherry], env);
    assert.doesNotMatch(commitMessage(workspace.path), /X-Anneal-|Anneal Chain/u, "CHERRY_PICK_HEAD strips copied provenance");

    await writeFile(join(workspace.path, "conflict.txt"), "conflict\n");
    git(workspace.path, ["add", "conflict.txt"], env);
    assert.throws(
      () => git(workspace.path, ["commit", "-m", "conflict\n\nX-Anneal-Run: another-run"], env),
      /Conflicting or incomplete Anneal provenance trailers/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary runs stay unmarked while global runner identity is pinned locally", async () => {
  const root = await mkdtemp(join(tmpdir(), "anneal-provenance-ordinary-"));
  try {
    const remote = await seedRemote(root);
    const configured = config(root, null);
    await mkdir(configured.home, { recursive: true });
    const globalEnv = { ...process.env, HOME: configured.home, GIT_CONFIG_GLOBAL: join(configured.home, ".gitconfig") };
    git(root, ["config", "--global", "user.name", HUMAN.name], globalEnv);
    git(root, ["config", "--global", "user.email", HUMAN.email], globalEnv);
    const claimed = claim(remote, "run-ordinary", { chainId: null, chainIndex: null, templateStep: null });
    const workspace = await provisionWorkspace(configured, claimed);
    assert.equal(workspace.commitHooksPath, undefined);
    const env = providerEnvironment(configured, claimed, workspace);
    assert.equal(env.GIT_CONFIG_COUNT, undefined);
    await writeFile(join(workspace.path, "ordinary.txt"), "ordinary\n");
    git(workspace.path, ["add", "ordinary.txt"], env);
    git(workspace.path, ["commit", "-m", "ordinary commit"], env);
    assert.doesNotMatch(commitMessage(workspace.path), /X-Anneal-/u);
    assert.equal(git(workspace.path, ["show", "-s", "--format=%an <%ae>", "HEAD"]), `${HUMAN.name} <${HUMAN.email}>`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
