import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { CleanupStatus, PrismaClient, PushStatus, RunStatus, SessionExecutionStatus, TaskStatus } from "@agentos/db";

import { completeRun } from "./run-completion.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

/**
 * The seam. Every one of these refusals is reachable over HTTP, but only as a
 * status code and a body; here each is a named value the caller maps, and the
 * "why did this refuse" question the route used to answer with a follow-up
 * query of its own is answered behind the interface.
 */

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const RUNNER_ID = "run-completion-runner";

let sequence = 0;
const seed = async (status: RunStatus = RunStatus.RUNNING) => {
  sequence += 1;
  const suffix = `${process.pid}-${sequence}`;
  const project = await db.project.create({ data: { name: "Completion", slug: `completion-${suffix}` } });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: `agent-${suffix}`, title: "Agent",
    model: "gpt-5.6-sol:high", runnerPreference: "CODEX", foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id, name: "repo", remoteUrl: "https://github.com/acme/repo.git",
    mountPath: "/repo", defaultBranch: "main",
  } });
  const task = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, name: "Completing", description: "work",
    assigneeAgentId: agent.id, status: TaskStatus.DOING,
  } });
  const run = await db.run.create({ data: {
    projectId: project.id, taskId: task.id, agentId: agent.id, repoId: repo.id,
    runNumber: 1, dedupeKey: `task:${task.id}:run:1`, status,
    runner: "CODEX", model: agent.model, promptHash: "hash", branch: `codex/completion-${suffix}`,
    runnerId: RUNNER_ID, fencingToken: `fence-${suffix}`, leaseGeneration: 1,
    leaseExpiresAt: new Date(Date.now() + 600_000),
    heartbeatAt: new Date(), claimedAt: new Date(),
  } });
  await db.session.create({ data: {
    runId: run.id, projectId: project.id, taskId: task.id, agentId: agent.id, runner: "CODEX",
    executionStatus: SessionExecutionStatus.RUNNING,
  } });
  return { project, task, run };
};

const completion = (fencingToken: string) => ({
  runnerId: RUNNER_ID,
  fencingToken,
  exitCode: 0,
  terminalEventSeen: true,
  terminalSuccess: true,
  externalFailure: false,
  pushStatus: PushStatus.NOT_REQUESTED,
  cleanupStatus: CleanupStatus.SUCCEEDED,
  workspaceRetained: false,
});

test("the merge-executor principal on an ordinary run is refused before anything is written", async () => {
  const { run } = await seed();
  const refused = await completeRun(db, {
    runId: run.id,
    body: completion(run.fencingToken!),
    claimantClass: "merge-executor",
  });
  assert.deepEqual(refused, {
    reason: "forbidden",
    message: "The merge-executor principal may only act on mechanical runs",
  });
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.RUNNING);
});

// WAITING_INBOX is an active status, so a suspended run whose fence is still
// good completes normally. The refusal exists for what `suspendForInbox`
// actually leaves behind: a suspended run the caller no longer holds the fence
// for. That is one stale token away from the case below, and the two must not
// answer the same thing.
test("a suspended run refuses as waiting-inbox, not as a stale fence", async () => {
  const { run } = await seed(RunStatus.WAITING_INBOX);
  const refused = await completeRun(db, {
    runId: run.id,
    body: completion("fence-from-a-previous-generation"),
    claimantClass: "runner",
  });
  assert.deepEqual(refused, {
    reason: "conflict",
    message: "Run suspended for Inbox",
    detail: { code: "WAITING_INBOX" },
  });
});

test("a superseded fencing token refuses as a fence, carrying the reason", async () => {
  const { run } = await seed();
  const refused = await completeRun(db, {
    runId: run.id,
    body: completion("fence-from-a-previous-generation"),
    claimantClass: "runner",
  });
  assert.deepEqual(refused, {
    reason: "conflict",
    message: "Stale fencing token",
    detail: { reason: "stale-fence" },
  });
});

test("an accepted completion returns what it did rather than a response", async () => {
  const { task, run } = await seed();
  const result = await completeRun(db, {
    runId: run.id,
    body: completion(run.fencingToken!),
    claimantClass: "runner",
  });
  assert.deepEqual(result, {
    taskId: task.id,
    succeeded: true,
    retryCreated: false,
    failureClass: null,
    releaseMergeLeaseTask: null,
  });
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.SUCCEEDED);
});
