import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { promisify } from "node:util";

import {
  AssigneeType,
  PrismaClient,
  TaskStatus,
} from "@agentos/db";

import { handleRegressionCompletion } from "./app.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const BRANCH = "agentos/repair-test";
const RESOLVED = "c".repeat(40);
const exec = promisify(execFile);

const seedRegression = async () => {
  const project = await db.project.create({ data: { name: "Repair", slug: `repair-${Date.now()}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const makeAgent = (name: string) => db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name, title: name,
    model: "gpt-5.6-sol:high", runnerPreference: "CODEX", foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const [regressionAgent, resolverAgent, fixAgent] = await Promise.all([
    makeAgent("review-coordinator-sol"), makeAgent("merge-resolver"), makeAgent("senior-dev"),
  ]);
  const repo = await db.repo.create({ data: {
    projectId: project.id, name: "widgets", remoteUrl: "https://github.com/acme/widgets.git",
    mountPath: "/repo", defaultBranch: "main",
  } });
  for (const agent of [regressionAgent, resolverAgent, fixAgent]) {
    await db.agentRepoAccess.create({ data: {
      projectId: project.id, agentId: agent.id, repoId: repo.id, mountPath: "/repo", permissions: "GIT_WRITE",
    } });
  }
  const template = await db.taskTemplate.create({ data: {
    projectId: project.id, name: "direct-engineer-workflow", description: "tail", variables: [],
  } });
  const [fixStep, regressionStep] = await Promise.all([
    db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id, stepIndex: 4, name: "Fix", assigneeType: AssigneeType.AGENT,
      assigneeAgentId: fixAgent.id, prompt: "fix", approvalGate: false, outputKind: "fixed-implementation",
    } }),
    db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id, stepIndex: 5, name: "Regression", assigneeType: AssigneeType.AGENT,
      assigneeAgentId: regressionAgent.id, prompt: "verify", approvalGate: false, outputKind: "regression-verification",
    } }),
  ]);
  const chainId = `chain-${Date.now()}`;
  const fix = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: fixStep.id,
    name: "Fix", description: "fix", assigneeType: AssigneeType.AGENT, assigneeAgentId: fixAgent.id,
    status: TaskStatus.DONE, chainId, chainIndex: 4, targetBranch: "main",
  } });
  const regression = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: regressionStep.id,
    name: "Regression", description: "verify", assigneeType: AssigneeType.AGENT, assigneeAgentId: regressionAgent.id,
    status: TaskStatus.DOING, chainId, chainIndex: 5, targetBranch: "main",
  } });
  await db.task.update({ where: { id: fix.id }, data: { followUpTaskId: regression.id } });
  const run = await db.run.create({ data: {
    projectId: project.id, taskId: regression.id, agentId: regressionAgent.id, repoId: repo.id,
    runNumber: 1, dedupeKey: `task:${regression.id}:run:1`, runner: "CODEX", model: regressionAgent.model,
    promptHash: "hash", status: "SUCCEEDED", branch: BRANCH, pushedBranch: BRANCH,
    targetBranch: "main", headSha: HEAD,
  } });
  const session = await db.session.create({ data: {
    runId: run.id, projectId: project.id, agentId: regressionAgent.id, taskId: regression.id,
    runner: "CODEX", executionStatus: "SUCCEEDED",
  } });
  return { project, template, repo, regressionAgent, regression, run, session };
};

const verdict = (outcome: "refresh-conflict" | "review-fail" | "gate-fail") => JSON.stringify(outcome === "refresh-conflict"
  ? { schemaVersion: 1, outcome, headSha: HEAD, baseHeadSha: BASE, summary: "merge conflict" }
  : outcome === "review-fail"
    ? { schemaVersion: 1, outcome, headSha: HEAD, baseHeadSha: BASE, summary: "MF-2 remains open" }
    : { schemaVersion: 1, outcome, headSha: HEAD, baseHeadSha: BASE, gateVerdict: "FAIL", summary: "suite failed" });

const exercise = async (outcome: "refresh-conflict" | "review-fail" | "gate-fail") => {
  const seeded = await seedRegression();
  await db.taskStepOutput.create({ data: {
    taskId: seeded.regression.id, runId: seeded.run.id, kind: "regression-verification",
    body: verdict(outcome), commitSha: HEAD,
  } });
  const input = {
    task: seeded.regression,
    run: { id: seeded.run.id, agentId: seeded.regressionAgent.id, branch: BRANCH, headSha: HEAD, sessionId: seeded.session.id },
    now: new Date(),
  };
  assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, input)), "handled");
  return { ...seeded, input };
};

const repairFor = (
  seeded: Awaited<ReturnType<typeof exercise>>,
  repairKind: "refresh-conflict" | "review-fix" | "gate-fix",
) => db.task.findFirstOrThrow({ where: {
  projectId: seeded.project.id,
  name: `Autonomous merge tail: ${repairKind}`,
} });

const repairCount = (seeded: Awaited<ReturnType<typeof exercise>>) => db.task.count({ where: {
  projectId: seeded.project.id,
  name: { startsWith: "Autonomous merge tail:" },
} });

const completeRepair = async (
  seeded: Awaited<ReturnType<typeof exercise>>,
  repairId: string,
  output: string,
  headSha: string | null = RESOLVED,
) => {
  const run = await db.run.findFirstOrThrow({ where: { taskId: repairId } });
  const repair = await db.task.findUniqueOrThrow({ where: { id: repairId } });
  const runnerId = `repair-runner-${repairId}`;
  const fencingToken = `repair:${run.id}:1`;
  await db.run.update({ where: { id: run.id }, data: {
    status: "RUNNING", runnerId, fencingToken, leaseExpiresAt: new Date(Date.now() + 60_000),
  } });
  await db.session.create({ data: {
    runId: run.id, projectId: seeded.project.id, agentId: repair.assigneeAgentId!, taskId: repair.id,
    runner: "CODEX", executionStatus: "RUNNING",
  } });
  await db.task.update({ where: { id: repair.id }, data: { status: TaskStatus.DOING } });
  await db.taskStepOutput.create({ data: {
    taskId: repair.id, runId: run.id, kind: "result", body: output, commitSha: headSha,
  } });
  const prior = process.env.RUNNER_TOKEN;
  process.env.RUNNER_TOKEN = "merge-tail-repair-token";
  try {
    const response = await createApp(db).request(`/runner/runs/${run.id}/complete`, {
      method: "POST",
      headers: { Authorization: "Bearer merge-tail-repair-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId, fencingToken, exitCode: 0, terminalEventSeen: true, terminalSuccess: true,
        cleanupStatus: "SUCCEEDED", branch: BRANCH, headSha,
      }),
    });
    assert.equal(response.status, 200, await response.text());
  } finally {
    if (prior === undefined) delete process.env.RUNNER_TOKEN;
    else process.env.RUNNER_TOKEN = prior;
  }
};

test("a refresh conflict creates exactly one resolver and its completion re-runs regression", async () => {
  const seeded = await exercise("refresh-conflict");
  const repair = await repairFor(seeded, "refresh-conflict");
  assert.equal(repair.followUpTaskId, null);
  assert.equal((await db.agent.findUniqueOrThrow({ where: { id: repair.assigneeAgentId! } })).name, "merge-resolver");
  assert.equal(await repairCount(seeded), 1);
  await completeRepair(seeded, repair.id, JSON.stringify({
    schemaVersion: 1, outcome: "resolved", startHeadSha: HEAD, targetHeadSha: BASE,
    resolvedHeadSha: RESOLVED, tradeOffs: [], changedTestExpectations: [],
  }));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } })).status, TaskStatus.TODO);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 2);
  const result = await db.taskActivity.findFirstOrThrow({ where: {
    taskId: seeded.regression.id,
    metadata: { path: ["kind"], equals: "mergeTail.repairResult" },
  } });
  assert.match(result.body, new RegExp(`${HEAD}.*${RESOLVED}`));

  assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, seeded.input)), "handled");
  assert.equal(await repairCount(seeded), 1);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 1);
});

test("a gate FAIL creates one fix-agent task and a second FAIL escalates with both heads in activity", async () => {
  const seeded = await exercise("gate-fail");
  const repair = await repairFor(seeded, "gate-fix");
  assert.equal(repair.followUpTaskId, null);
  assert.equal((await db.agent.findUniqueOrThrow({ where: { id: repair.assigneeAgentId! } })).name, "senior-dev");
  await completeRepair(seeded, repair.id, "Fixed the failing regression and reran the affected suite.");
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 2);
  assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, seeded.input)), "handled");
  assert.equal(await repairCount(seeded), 1);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 1);
  const trail = await db.taskActivity.findMany({ where: { taskId: seeded.regression.id }, select: { body: true } });
  assert.match(trail.map(({ body }) => body).join("\n"), new RegExp(`${HEAD}.*${BASE}`, "s"));
});

test("a semantic FAIL skips the gate path and creates one review-fix task", async () => {
  const seeded = await exercise("review-fail");
  const repair = await repairFor(seeded, "review-fix");
  assert.equal(repair.followUpTaskId, null);
  assert.equal((await db.agent.findUniqueOrThrow({ where: { id: repair.assigneeAgentId! } })).name, "senior-dev");
  assert.match(repair.description, /MF-2 remains open/u);
  await completeRepair(seeded, repair.id, "Closed MF-2 and reran its focused regression.");
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 2);
  assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, seeded.input)), "handled");
  assert.equal(await repairCount(seeded), 1);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 1);
});

test("malformed, unknown, and head-unbound resolver outputs stop loudly", async () => {
  const cases: Array<[string, string, string | null]> = [
    ["prose", "resolved it", RESOLVED],
    ["unknown", JSON.stringify({ schemaVersion: 1, outcome: "other", startHeadSha: HEAD, targetHeadSha: BASE }), RESOLVED],
    ["null-head", JSON.stringify({
      schemaVersion: 1, outcome: "resolved", startHeadSha: HEAD, targetHeadSha: BASE,
      resolvedHeadSha: RESOLVED, tradeOffs: [], changedTestExpectations: [],
    }), null],
  ];
  for (const [label, output, headSha] of cases) {
    const seeded = await exercise("refresh-conflict");
    const repair = await repairFor(seeded, "refresh-conflict");
    await completeRepair(seeded, repair.id, output, headSha);
    const regression = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
    assert.equal(regression.status, TaskStatus.REVIEW, label);
    assert.match(regression.failureReason ?? "", /invalid output/u, label);
    assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 1, label);
    await resetTestDb(db);
  }
});

test("successful resolver, review-fix, and gate-fix completions rerun regression with exact-head PASS evidence", async () => {
  for (const outcome of ["refresh-conflict", "review-fail", "gate-fail"] as const) {
    const seeded = await exercise(outcome);
    const repair = await repairFor(seeded, outcome === "gate-fail" ? "gate-fix" : outcome === "review-fail" ? "review-fix" : outcome);
    const output = outcome === "refresh-conflict"
      ? JSON.stringify({
        schemaVersion: 1, outcome: "resolved", startHeadSha: HEAD, targetHeadSha: BASE,
        resolvedHeadSha: RESOLVED, tradeOffs: [], changedTestExpectations: [],
      })
      : "fixed gate failure";
    await completeRepair(seeded, repair.id, output);
    const run2 = await db.run.findFirstOrThrow({ where: { taskId: seeded.regression.id, runNumber: 2 } });
    await db.run.update({ where: { id: run2.id }, data: { headSha: RESOLVED } });
    await db.taskStepOutput.update({ where: { taskId: seeded.regression.id }, data: {
      runId: run2.id,
      body: JSON.stringify({ schemaVersion: 1, outcome: "pass", headSha: RESOLVED, baseHeadSha: BASE, gateVerdict: "PASS" }),
      commitSha: RESOLVED,
    } });
    assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, {
      task: seeded.regression,
      run: { id: run2.id, agentId: seeded.regressionAgent.id, branch: BRANCH, headSha: RESOLVED, sessionId: seeded.session.id },
      now: new Date(),
    })), "advance", outcome);
    await resetTestDb(db);
  }
});

test("a resolver process failure escalates instead of leaving regression silently parked", async () => {
  const seeded = await exercise("refresh-conflict");
  const repair = await repairFor(seeded, "refresh-conflict");
  const run = await db.run.findFirstOrThrow({ where: { taskId: repair.id } });
  const runnerId = "merge-tail-repair-runner";
  const fencingToken = `repair:${run.id}:1`;
  await db.run.update({ where: { id: run.id }, data: {
    status: "RUNNING", runnerId, fencingToken, leaseExpiresAt: new Date(Date.now() + 60_000),
  } });
  await db.session.create({ data: {
    runId: run.id, projectId: seeded.project.id, agentId: repair.assigneeAgentId!, taskId: repair.id,
    runner: "CODEX", executionStatus: "RUNNING",
  } });
  await db.task.update({ where: { id: repair.id }, data: { status: TaskStatus.DOING } });
  const prior = process.env.RUNNER_TOKEN;
  process.env.RUNNER_TOKEN = "merge-tail-repair-token";
  try {
    const response = await createApp(db).request(`/runner/runs/${run.id}/complete`, {
      method: "POST",
      headers: { Authorization: "Bearer merge-tail-repair-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId, fencingToken, exitCode: 1, terminalEventSeen: true, terminalSuccess: false,
        failureClass: "TASK_FAILED", failureReason: "resolver crashed", retryable: false,
        cleanupStatus: "SUCCEEDED",
      }),
    });
    assert.equal(response.status, 200);
  } finally {
    if (prior === undefined) delete process.env.RUNNER_TOKEN;
    else process.env.RUNNER_TOKEN = prior;
  }
  const regression = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
  assert.equal(regression.status, TaskStatus.REVIEW);
  assert.match(regression.failureReason ?? "", /failed without closing/u);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 1);
});

test("a stale branch is mechanically refreshed before exact-head PASS advances", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-merge-refresh-"));
  try {
    const origin = join(root, "origin.git");
    const author = ["-c", "user.name=AgentOS Test", "-c", "user.email=test@example.invalid"];
    await exec("git", ["init", "--bare", origin]);
    const source = join(root, "source");
    await exec("git", ["clone", origin, source]);
    await writeFile(join(source, "base.txt"), "base\n");
    await exec("git", [...author, "add", "base.txt"], { cwd: source });
    await exec("git", [...author, "commit", "-m", "base"], { cwd: source });
    await exec("git", ["branch", "-M", "main"], { cwd: source });
    await exec("git", ["push", "origin", "main"], { cwd: source });
    await exec("git", ["checkout", "-b", "feature"], { cwd: source });
    await writeFile(join(source, "feature.txt"), "feature\n");
    await exec("git", [...author, "add", "feature.txt"], { cwd: source });
    await exec("git", [...author, "commit", "-m", "feature"], { cwd: source });
    await exec("git", ["push", "origin", "feature"], { cwd: source });
    await exec("git", ["checkout", "main"], { cwd: source });
    await writeFile(join(source, "main.txt"), "advanced\n");
    await exec("git", [...author, "add", "main.txt"], { cwd: source });
    await exec("git", [...author, "commit", "-m", "advance main"], { cwd: source });
    await exec("git", ["push", "origin", "main"], { cwd: source });
    const baseSha = (await exec("git", ["rev-parse", "main"], { cwd: source })).stdout.trim();

    const work = join(root, "work");
    await exec("git", ["clone", "--branch", "feature", origin, work]);
    await exec("git", ["fetch", "origin", "main"], { cwd: work });
    await exec("git", [...author, "merge", "--no-edit", "origin/main"], { cwd: work });
    const refreshedHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: work })).stdout.trim();
    await exec("git", ["merge-base", "--is-ancestor", baseSha, refreshedHead], { cwd: work });

    const seeded = await seedRegression();
    await db.run.update({ where: { id: seeded.run.id }, data: { headSha: refreshedHead } });
    await db.taskStepOutput.create({ data: {
      taskId: seeded.regression.id, runId: seeded.run.id, kind: "regression-verification",
      body: JSON.stringify({ schemaVersion: 1, outcome: "pass", headSha: refreshedHead, baseHeadSha: baseSha, gateVerdict: "PASS" }),
      commitSha: refreshedHead,
    } });
    assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, {
      task: seeded.regression,
      run: { id: seeded.run.id, agentId: seeded.regressionAgent.id, branch: BRANCH, headSha: refreshedHead, sessionId: seeded.session.id },
      now: new Date(),
    })), "advance");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
