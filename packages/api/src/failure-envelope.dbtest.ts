import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";

import { FAILURE_ENVELOPE_VERSION, type FailureEnvelope, PrismaClient } from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const isolatedRoot = process.env.RUNNER_WORKSPACE_ROOT!;

const withRunnerToken = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  const priorToken = process.env.RUNNER_TOKEN;
  const priorRoot = process.env.RUNNER_WORKSPACE_ROOT;
  mkdirSync(isolatedRoot, { recursive: true });
  process.env.RUNNER_TOKEN = "runner-db-token";
  process.env.RUNNER_WORKSPACE_ROOT = isolatedRoot;
  try {
    return await operation();
  } finally {
    if (priorToken === undefined) delete process.env.RUNNER_TOKEN; else process.env.RUNNER_TOKEN = priorToken;
    if (priorRoot === undefined) delete process.env.RUNNER_WORKSPACE_ROOT; else process.env.RUNNER_WORKSPACE_ROOT = priorRoot;
  }
};

let seedCounter = 0;

const seedRunningRun = async () => {
  const suffix = `${Date.now()}-${seedCounter++}`;
  const project = await db.project.create({ data: { name: "Envelope", slug: `envelope-${suffix}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: "agent", title: "Agent", model: "claude",
    foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id, name: "repo", remoteUrl: "https://example.test/repo.git", mountPath: "/repo",
  } });
  const task = await db.task.create({ data: {
    projectId: project.id, name: "Rate limit the inbox poller", description: "task", assigneeAgentId: agent.id,
    repoId: repo.id, status: "DOING",
  } });
  const runnerId = `runner-${suffix}`;
  const fencingToken = `1:${task.id}:${suffix}`;
  const run = await db.run.create({ data: {
    projectId: project.id, taskId: task.id, agentId: agent.id, repoId: repo.id, runNumber: 1,
    dedupeKey: `task:${task.id}:run:1`, runner: "CLAUDE", runnerId, fencingToken,
    leaseExpiresAt: new Date(Date.now() + 60_000), status: "RUNNING", model: "claude", promptHash: "hash",
    maxRunsPerTask: 5,
  } });
  await db.session.create({ data: {
    runId: run.id, projectId: project.id, agentId: agent.id, taskId: task.id, runner: "CLAUDE", executionStatus: "RUNNING",
  } });
  return { project, agent, repo, task, run, runnerId, fencingToken };
};

/**
 * The 2026-08-17 shape, in the form the wire carries it.
 *
 * The task is *about* rate limiting, so the agent's own stdout is full of the
 * phrase; nothing on a verdict channel says the environment did anything. The
 * runner's own grep read stdout and answered RATE_LIMITED + retryable, and the
 * route believed it — `body.retryable ?? failureIsRetryable(...)` meant the
 * runner always won. Every retry then failed the same way until the task's run
 * budget was gone.
 */
const misclassifiedBody = (runnerId: string, fencingToken: string, envelope?: Partial<FailureEnvelope>) => ({
  runnerId,
  fencingToken,
  exitCode: 1,
  signal: null,
  terminalEventSeen: true,
  terminalSuccess: false,
  failureClass: "RATE_LIMITED",
  failureReason: "rate limit",
  retryable: true,
  cleanupStatus: "SUCCEEDED",
  ...(envelope === undefined ? {} : {
    failureEnvelope: {
      version: FAILURE_ENVELOPE_VERSION,
      phase: "EXECUTE",
      runnerClass: "RATE_LIMITED",
      exitCode: 1,
      signal: null,
      terminationReason: null,
      terminalEventSeen: true,
      terminalSuccess: false,
      agentExited: true,
      providerError: null,
      stderrSummary: null,
      stdoutSummary: "added the 429 rate limit backoff and a quota header parser",
      timedOut: false,
      transient: false,
      timeoutMs: null,
      ...envelope,
    },
  }),
});

const complete = (runId: string, body: unknown) => withRunnerToken(() => createApp(db).request(`/runner/runs/${runId}/complete`, {
  method: "POST",
  headers: { Authorization: "Bearer runner-db-token", "Content-Type": "application/json" },
  body: JSON.stringify(body),
}));

test("a runner with no envelope keeps the old contract, misverdict and all", async () => {
  const { task, run, runnerId, fencingToken } = await seedRunningRun();
  assert.equal((await complete(run.id, misclassifiedBody(runnerId, fencingToken))).status, 200);
  const closed = await db.run.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(closed.status, "FAILED");
  // The runner's word, taken verbatim — this is the behaviour an old runner
  // still depends on, and it is also exactly the defect. Both facts have to be
  // true at once for the fix below to mean anything.
  assert.equal(closed.failureClass, "RATE_LIMITED");
  assert.equal(closed.retryable, true);
  assert.equal(closed.failureEnvelope, null);
  assert.equal(await db.run.count({ where: { taskId: task.id, runNumber: 2 } }), 1, "a retry that cannot succeed");
});

test("an envelope moves the verdict to the API, and the misverdict stops burning budget", async () => {
  const { task, run, runnerId, fencingToken } = await seedRunningRun();
  assert.equal((await complete(run.id, misclassifiedBody(runnerId, fencingToken, {}))).status, 200);
  const closed = await db.run.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(closed.status, "FAILED");
  assert.equal(closed.failureClass, "TASK_FAILED", "stdout is the agent's work, not a verdict channel");
  assert.equal(closed.retryable, false);
  assert.equal(await db.run.count({ where: { taskId: task.id, runNumber: 2 } }), 0, "no retry, so no budget spent on one");
  assert.equal(closed.maxRunsPerTask, 5, "and no ceiling raised either");
});

test("the envelope is persisted verbatim as the evidence behind the verdict", async () => {
  const { run, runnerId, fencingToken } = await seedRunningRun();
  await complete(run.id, misclassifiedBody(runnerId, fencingToken, { stderrSummary: "fatal: nothing to commit" }));
  const stored = (await db.run.findUniqueOrThrow({ where: { id: run.id } })).failureEnvelope as unknown as FailureEnvelope;
  assert.equal(stored.phase, "EXECUTE");
  assert.equal(stored.stdoutSummary, "added the 429 rate limit backoff and a quota header parser");
  assert.equal(stored.stderrSummary, "fatal: nothing to commit");
  // The runner's own first guess survives next to the API's verdict, so a
  // disagreement is visible instead of silently resolved.
  assert.equal(stored.runnerClass, "RATE_LIMITED");
});

test("the runner cannot declare a failure retryable the API's whitelist refuses", async () => {
  const { task, run, runnerId, fencingToken } = await seedRunningRun();
  await complete(run.id, {
    ...misclassifiedBody(runnerId, fencingToken, { stderrSummary: "fatal: unrecoverable" }),
    failureClass: "TASK_FAILED",
    retryable: true,
    externalFailure: true,
  });
  const closed = await db.run.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(closed.retryable, false);
  assert.equal(closed.maxRunsPerTask, 5, "an untrusted `externalFailure: true` no longer raises the ceiling");
  assert.equal(await db.run.count({ where: { taskId: task.id } }), 1);
});

/**
 * Copied verbatim from the `"a hung push arrives at the API as a typed timeout"`
 * test in packages/runner/src/delivery.test.ts, which asserts this exact object
 * as the output of a real `deliverWorkspace` hitting a real per-command
 * timeout. Keep the two in step: it is what makes this a test of the payload a
 * runner sends rather than of a shape invented here.
 */
const hungPushEnvelope = {
  version: FAILURE_ENVELOPE_VERSION,
  phase: "DELIVER",
  runnerClass: "TOOL_FAILED",
  exitCode: 0,
  signal: null,
  terminationReason: null,
  terminalEventSeen: true,
  terminalSuccess: true,
  agentExited: true,
  providerError: null,
  stderrSummary: "git push timed out after 6000ms; its process group was killed",
  stdoutSummary: null,
  timedOut: true,
  transient: true,
  timeoutMs: 6000,
};

test("a real hung push is retried transience, and buys the task an attempt instead of spending one", async () => {
  const { task, run, runnerId, fencingToken } = await seedRunningRun();
  await complete(run.id, {
    runnerId,
    fencingToken,
    exitCode: 0,
    signal: null,
    terminalEventSeen: true,
    // What runner.ts sends when the agent finished and the push did not: the
    // run did not succeed, while the envelope still records that the agent's
    // own terminal event did.
    terminalSuccess: false,
    // The runner's advisory verdict, straight out of delivery.ts's text rule.
    failureClass: "TOOL_FAILED",
    failureReason: "git push timed out after 6000ms; its process group was killed",
    retryable: false,
    pushStatus: "FAILED",
    cleanupStatus: "SUCCEEDED",
    failureEnvelope: hungPushEnvelope,
  });
  const closed = await db.run.findUniqueOrThrow({ where: { id: run.id } });
  // The runner said TOOL_FAILED and non-retryable. Both are overruled, because
  // the envelope carries the fact its text did not: a typed CommandTimeoutError.
  assert.equal(closed.failureClass, "TRANSIENT_PROVIDER");
  assert.equal(closed.retryable, true);
  assert.equal(closed.maxRunsPerTask, 6, "the agent finished; a hung push must not cost the task an attempt");
  const retry = await db.run.findFirstOrThrow({ where: { taskId: task.id, runNumber: 2 } });
  assert.equal(retry.maxRunsPerTask, 6);
});

test("an agent stderr that only says ECONNRESET stays retryable, as it was before the authority moved", async () => {
  const { task, run, runnerId, fencingToken } = await seedRunningRun();
  await complete(run.id, misclassifiedBody(runnerId, fencingToken, {
    runnerClass: "TRANSIENT_PROVIDER",
    stderrSummary: "fatal: unable to access 'https://github.com/acme/app.git/': read ECONNRESET",
    stdoutSummary: null,
  }));
  const closed = await db.run.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(closed.failureClass, "TRANSIENT_PROVIDER");
  assert.equal(closed.retryable, true);
  assert.equal(await db.run.count({ where: { taskId: task.id, runNumber: 2 } }), 1);
});

test("an envelope version this API does not know is stored but never read", async () => {
  const { task, run, runnerId, fencingToken } = await seedRunningRun();
  await complete(run.id, misclassifiedBody(runnerId, fencingToken, { version: FAILURE_ENVELOPE_VERSION + 1 }));
  const closed = await db.run.findUniqueOrThrow({ where: { id: run.id } });
  // Half-reading a shape whose field meanings may have changed is worse than
  // not reading it, so the route falls back to the legacy fields.
  assert.equal(closed.failureClass, "RATE_LIMITED");
  assert.equal(closed.retryable, true);
  assert.equal(await db.run.count({ where: { taskId: task.id, runNumber: 2 } }), 1);
  assert.notEqual(closed.failureEnvelope, null, "and the evidence is kept regardless");
});

test("a future envelope whose shape this API cannot parse still completes the run", async () => {
  // The version bump that actually happens: new phases, new failure classes,
  // fields that changed shape. Validating v1's schema before reading `version`
  // would 400 this — and a completion is a terminal write, so the run would
  // never record one and reconciliation would later call it LOST.
  const { task, run, runnerId, fencingToken } = await seedRunningRun();
  const future = {
    version: FAILURE_ENVELOPE_VERSION + 1,
    phase: "PUBLISH",
    runnerClass: "QUOTA_EXHAUSTED",
    exitCode: { code: 1, core: false },
    evidence: [{ channel: "stderr", text: "something a v2 runner knows about" }],
  };
  const response = await complete(run.id, {
    ...misclassifiedBody(runnerId, fencingToken),
    failureEnvelope: future,
  });
  assert.equal(response.status, 200);
  const closed = await db.run.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(closed.status, "FAILED");
  assert.equal(closed.failureClass, "RATE_LIMITED", "legacy fields, unchanged");
  assert.deepEqual(closed.failureEnvelope, future, "and the unreadable evidence is kept whole");
  assert.equal(await db.run.count({ where: { taskId: task.id, runNumber: 2 } }), 1);
});

test("a v1 envelope the schema rejects degrades to the legacy fields, never to a 400", async () => {
  const { run, runnerId, fencingToken } = await seedRunningRun();
  const response = await complete(run.id, {
    ...misclassifiedBody(runnerId, fencingToken),
    failureEnvelope: { version: FAILURE_ENVELOPE_VERSION, phase: "NOT_A_PHASE", exitCode: "one" },
  });
  assert.equal(response.status, 200);
  const closed = await db.run.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(closed.failureClass, "RATE_LIMITED");
  assert.equal(closed.status, "FAILED");
});

test("a successful completion records no failure envelope", async () => {
  const { run, runnerId, fencingToken } = await seedRunningRun();
  await complete(run.id, {
    runnerId,
    fencingToken,
    exitCode: 0,
    terminalEventSeen: true,
    terminalSuccess: true,
    output: "done",
    cleanupStatus: "SUCCEEDED",
    failureEnvelope: {
      version: FAILURE_ENVELOPE_VERSION,
      phase: "EXECUTE",
      runnerClass: null,
      exitCode: 0,
      signal: null,
      terminationReason: null,
      terminalEventSeen: true,
      terminalSuccess: true,
      agentExited: true,
      providerError: null,
      stderrSummary: null,
      stdoutSummary: null,
      timedOut: false,
      transient: false,
      timeoutMs: null,
    },
  });
  const closed = await db.run.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(closed.status, "SUCCEEDED");
  assert.equal(closed.failureClass, null);
  assert.equal(closed.failureEnvelope, null);
});
