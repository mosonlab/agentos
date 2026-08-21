import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { enqueueTaskRun, PrismaClient, RunnerPreference, TaskStatus } from "@agentos/db";

import { createApp } from "./test-app.js";
import { readStoredCliAvailability } from "./runner-cli-availability.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const RUNNER_TOKEN = "runner-cli-availability-token";
let db: PrismaClient;
const priorRunnerToken = process.env.RUNNER_TOKEN;

before(() => {
  process.env.RUNNER_TOKEN = RUNNER_TOKEN;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  if (priorRunnerToken === undefined) delete process.env.RUNNER_TOKEN;
  else process.env.RUNNER_TOKEN = priorRunnerToken;
});

const post = async (path: string, body: unknown) => {
  const response = await createApp(db).request(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) assert.fail(`${path} returned ${response.status}: ${await response.text()}`);
  return response;
};

let sequence = 0;
const seedTask = async (runnerPreference: RunnerPreference) => {
  sequence += 1;
  const suffix = `${process.pid}-${sequence}`;
  const project = await db.project.create({ data: { name: `CLI availability ${suffix}`, slug: `cli-availability-${suffix}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: `agent-${suffix}`,
    title: "Agent",
    model: runnerPreference === RunnerPreference.CODEX ? "gpt-5.6-sol" : "claude-opus-5:high",
    runnerPreference,
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: "repo",
    remoteUrl: "https://github.com/acme/widgets.git",
    mountPath: "/repo",
    defaultBranch: "main",
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: project.id,
    agentId: agent.id,
    repoId: repo.id,
    mountPath: "/repo",
    permissions: "GIT_WRITE",
  } });
  const task = await db.task.create({ data: {
    projectId: project.id,
    name: `${runnerPreference} task`,
    description: "exercise runner availability",
    assigneeAgentId: agent.id,
    repoId: repo.id,
    status: TaskStatus.TODO,
  } });
  const run = await db.$transaction((tx) => enqueueTaskRun(tx as never, task.id));
  return { task, run };
};

const claim = async () => {
  const response = await post("/runner/tasks/claim", { runnerId: "availability-runner", leaseSeconds: 60 });
  return response.status === 204 ? null : await response.json() as {
    runner: "CLAUDE" | "CODEX" | "PI";
    fencingToken: string;
    run: { id: string };
    task: { id: string };
  };
};

test("a missing CLI blocks only its backend, dedupes the outage, and recovers on the next report", async () => {
  const claude = await seedTask(RunnerPreference.CLAUDE);
  const codex = await seedTask(RunnerPreference.CODEX);
  const unavailable = {
    runner: "CLAUDE",
    binary: "claude",
    available: false,
    resolvedPath: null,
  };

  await post("/runner/availability", unavailable);
  await post("/runner/availability", unavailable);
  await post("/runner/availability", unavailable);

  const state = await db.runnerBackendState.findUniqueOrThrow({ where: { runner: "CLAUDE" } });
  const missing = readStoredCliAvailability(state.capabilities);
  assert.equal(missing?.available, false);
  assert.match(missing?.reason ?? "", /claude CLI "claude" was not found/u);
  assert.match((await db.task.findUniqueOrThrow({ where: { id: claude.task.id } })).failureReason ?? "", /claude CLI "claude" was not found/u);
  assert.equal(await db.inboxMessage.count({ where: { dedupeKey: { startsWith: "runner-cli-unavailable:CLAUDE:" } } }), 1);

  const otherClaim = await claim();
  assert.equal(otherClaim?.task.id, codex.task.id);
  assert.equal(otherClaim?.runner, "CODEX");
  await post(`/runner/runs/${otherClaim!.run.id}/start`, {
    runnerId: "availability-runner",
    fencingToken: otherClaim!.fencingToken,
    adapterVersion: "test",
    cliVersion: "codex-cli test",
    authMode: "test",
    manifest: {},
    workspacePath: "/tmp/availability-test",
  });
  await post(`/runner/runs/${otherClaim!.run.id}/complete`, {
    runnerId: "availability-runner",
    fencingToken: otherClaim!.fencingToken,
    exitCode: 0,
    terminalEventSeen: true,
    terminalSuccess: true,
    cleanupStatus: "SUCCEEDED",
    workspaceRetained: false,
  });
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: codex.run.id } })).status, "SUCCEEDED");

  await post("/runner/availability", {
    runner: "CLAUDE",
    binary: "claude",
    available: true,
    resolvedPath: "/opt/runner/bin/claude",
  });
  const recovered = await db.runnerBackendState.findUniqueOrThrow({ where: { runner: "CLAUDE" } });
  const available = readStoredCliAvailability(recovered.capabilities);
  assert.equal(available?.available, true);
  assert.equal(available?.reason, null);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: claude.task.id } })).failureReason, null);
  assert.equal(await db.inboxMessage.count({ where: {
    dedupeKey: { startsWith: "runner-cli-unavailable:CLAUDE:" }, status: "CLOSED",
  } }), 1);

  const recoveredClaim = await claim();
  assert.equal(recoveredClaim?.task.id, claude.task.id);
  assert.equal(recoveredClaim?.runner, "CLAUDE");
});

test("CLI availability reports preserve an independent authentication circuit", async () => {
  await db.runnerBackendState.create({ data: {
    runner: "CODEX",
    circuitOpen: true,
    circuitReason: "not-authenticated: run codex login",
    circuitOpenedAt: new Date("2026-08-21T00:00:00.000Z"),
  } });

  await post("/runner/availability", {
    runner: "CODEX", binary: "codex", available: false, resolvedPath: null,
  });
  await post("/runner/availability", {
    runner: "CODEX", binary: "codex", available: true, resolvedPath: "/opt/runner/bin/codex",
  });

  const state = await db.runnerBackendState.findUniqueOrThrow({ where: { runner: "CODEX" } });
  assert.equal(readStoredCliAvailability(state.capabilities)?.available, true);
  assert.equal(state.circuitOpen, true);
  assert.equal(state.circuitReason, "not-authenticated: run codex login");
});
