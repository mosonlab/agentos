/**
 * Issue #114: what a run produced has to outlive the run.
 *
 * The runner has always sent the tail of a run's output on every completion,
 * succeeded or failed (see `packages/runner/src/run-output.test.ts`, which
 * drives the real `executeClaim` and asserts the exact payloads reproduced
 * below). This handler read it in one place only — synthesizing a
 * `TaskStepOutput` for a *successful* run whose task had a template, chain or
 * follow-up — and dropped it everywhere else. A failed run therefore left the
 * system with no record of what it had found, which is the case where the
 * record is worth the most: an incident could afterwards only be guessed at.
 *
 * The second defect is one of identity rather than loss. When a task already
 * had an output row, the completion transaction restamped that row's `runId`
 * and `metadata` with the completing run's while leaving the body written by an
 * earlier run — a row that claimed to be run 2's work while its text was run
 * 1's. Which run's output *counts* when more than one has produced something is
 * a cardinality question this table cannot express yet, and it is answered by
 * issue #121; this test only pins the lie shut.
 */

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";

import { DIRECT_TEMPLATE_NAME, enqueueTaskRun, PrismaClient, TaskStatus } from "@anneal/db";

import { hashToken } from "./auth.js";
import { previousRunHandoffForClaim } from "./canonical-task-output.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
const releasedChainLeases: string[] = [];
beforeEach(async () => {
  releasedChainLeases.length = 0;
  await resetTestDb(db);
});
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-run-output";
const RUNNER = "runner-run-output";
const isolatedRoot = process.env.RUNNER_WORKSPACE_ROOT!;

const withTokens = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  const prior = [
    ["OPERATOR_TOKEN", process.env.OPERATOR_TOKEN],
    ["RUNNER_TOKEN", process.env.RUNNER_TOKEN],
    ["RUNNER_WORKSPACE_ROOT", process.env.RUNNER_WORKSPACE_ROOT],
  ] as const;
  mkdirSync(isolatedRoot, { recursive: true });
  process.env.OPERATOR_TOKEN = OPERATOR;
  process.env.RUNNER_TOKEN = RUNNER;
  process.env.RUNNER_WORKSPACE_ROOT = isolatedRoot;
  try {
    return await operation();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
};

const call = async (
  method: string, path: string, token: string, body?: unknown,
): Promise<{ status: number; body: any }> => withTokens(async () => {
  const response = await createApp(db, {
    releaseMergeLease: async (chainId) => {
      if (chainId) releasedChainLeases.push(chainId);
    },
  }).request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json().catch(() => null) as any };
});

let sequence = 0;
const seedTask = async (options: { chained: boolean; outputKind?: string; templateName?: string; stepIndex?: number; approvalGate?: boolean }) => {
  sequence += 1;
  const suffix = `${process.pid}-${sequence}`;
  const project = await db.project.create({ data: { name: "Run output", slug: `run-output-${suffix}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: `agent-${suffix}`, title: "Agent",
    model: "claude-opus-5:high", foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id, name: "repo", remoteUrl: "https://github.com/acme/widgets.git",
    mountPath: "/repo", defaultBranch: "master",
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: project.id, agentId: agent.id, repoId: repo.id, mountPath: "/repo", permissions: "GIT_WRITE",
  } });
  const template = options.outputKind ? await db.taskTemplate.create({ data: {
    projectId: project.id,
    name: options.templateName ?? `template-${suffix}`,
    description: "completion boundary fixture",
    variables: [],
  } }) : null;
  const templateStep = template ? await db.taskTemplateStep.create({ data: {
    taskTemplateId: template.id,
    stepIndex: options.stepIndex ?? 0,
    layer: options.stepIndex ?? 0,
    name: "Regression verification",
    assigneeType: "AGENT",
    assigneeAgentId: agent.id,
    prompt: "verify",
    approvalGate: options.approvalGate ?? false,
    outputKind: options.outputKind!,
  } }) : null;
  const task = await db.task.create({ data: {
    projectId: project.id, name: "Find the inbox deadlock", description: "work", assigneeAgentId: agent.id,
    repoId: repo.id, status: TaskStatus.TODO, targetBranch: "master", approvalGate: options.approvalGate ?? false,
    ...(template && templateStep ? { templateId: template.id, templateStepId: templateStep.id } : {}),
    ...(options.chained ? { chainId: `chain-${suffix}`, chainIndex: 0, chainLayer: 0 } : {}),
  } });
  return { project, agent, repo, task };
};

/**
 * Puts a queued run into the state a successful claim leaves behind. The claim
 * route is exercised by its own tests; what these need is the *session*
 * credential a claim issues, because the output route below is the only
 * production writer of a step output and it authenticates with one.
 */
const claimRun = async (runId: string, runnerId: string) => {
  const sessionToken = `agos_session_${runId}`;
  const fencingToken = `fence-${runId}`;
  const now = new Date();
  const run = await db.run.update({ where: { id: runId }, data: {
    status: "RUNNING", runnerId, fencingToken, leaseGeneration: 1,
    leaseExpiresAt: new Date(now.getTime() + 600_000),
    sessionTokenHash: hashToken(sessionToken),
    sessionTokenExpiresAt: new Date(now.getTime() + 600_000),
    sessionTokenRevokedAt: null,
    claimedAt: now, heartbeatAt: now, startedAt: now,
  } });
  await db.session.create({ data: {
    runId, projectId: run.projectId, agentId: run.agentId, taskId: run.taskId, runner: run.runner,
    executionStatus: "RUNNING",
  } });
  await db.task.update({ where: { id: run.taskId! }, data: { status: TaskStatus.DOING } });
  return { run, sessionToken, fencingToken };
};

const enqueue = async (taskId: string): Promise<string> => {
  await db.task.update({ where: { id: taskId }, data: { status: TaskStatus.TODO } });
  const run = await db.$transaction((tx) => enqueueTaskRun(tx as never, taskId));
  return (run as { id: string }).id;
};

const addSuccessor = async (seed: Awaited<ReturnType<typeof seedTask>>) => {
  assert.ok(seed.task.chainId);
  return db.task.create({ data: {
    projectId: seed.project.id,
    name: "Canonical successor",
    description: "must not start from refused output",
    assigneeAgentId: seed.agent.id,
    repoId: seed.repo.id,
    status: TaskStatus.TODO,
    targetBranch: "master",
    chainId: seed.task.chainId,
    chainIndex: 1,
    chainLayer: 1,
  } });
};

/**
 * Both payloads are the objects `packages/runner/src/run-output.test.ts`
 * observed on the wire out of a real `executeClaim`: a stub agent that prints
 * to stdout and exits 1, and one that emits the adapter's terminal `result`
 * event and exits 0. Only the volatile fields (runner id, fencing token, shas)
 * are parameterised. Keep the two files in step — a shape invented here would
 * make these tests agree with nothing.
 */
const FAILED_TAIL = "reproduced the deadlock: workers 3 and 7 both hold the inbox advisory lock\n"
  + "the fix needs the lock ordering inverted in reconcile.ts";
const SUCCEEDED_TAIL = "inverted the lock ordering in reconcile.ts and added the regression test";
const SHA = "02283bb8e9a08426394a5d2dc471b19bbaea22d7";
const implementationOutput = (summary: string, headSha = SHA) => JSON.stringify({
  schemaVersion: 1,
  headSha,
  baseSha: SHA,
  summary,
  testsRun: ["npm test -- focused"],
});
const regressionOutput = (summary: string, headSha = SHA) => JSON.stringify({
  schemaVersion: 1,
  outcome: "gate-fail",
  headSha,
  baseHeadSha: "b".repeat(40),
  gateVerdict: "FAIL",
  summary,
});
const solFindingsOutput = (headSha = SHA) => JSON.stringify({
  schemaVersion: 1,
  headSha,
  reviewedBase: "b".repeat(40),
  reviewedHead: headSha,
  findings: [],
  commandsRun: ["git diff --check"],
});
const specOutput = (spec: string, headSha = SHA) => JSON.stringify({ schemaVersion: 1, headSha, spec });

const failedCompletion = (runnerId: string, fencingToken: string, branch: string) => ({
  runnerId,
  fencingToken,
  exitCode: 1,
  signal: null,
  terminalEventSeen: false,
  terminalSuccess: false,
  terminationReason: null,
  failureClass: "TASK_FAILED",
  retryable: false,
  failureReason: "Error: session ended without a result",
  output: FAILED_TAIL,
  failureEnvelope: {
    version: 1,
    phase: "EXECUTE",
    runnerClass: "TASK_FAILED",
    exitCode: 1,
    signal: null,
    terminationReason: null,
    terminalEventSeen: false,
    terminalSuccess: false,
    agentExited: true,
    providerError: null,
    stderrSummary: "Error: session ended without a result",
    stdoutSummary: FAILED_TAIL,
    timedOut: false,
    transient: false,
    timeoutMs: null,
  },
  branch,
  baseSha: SHA,
  headSha: SHA,
  pushStatus: "NOT_REQUESTED",
  cleanupStatus: "SUCCEEDED",
  workspaceRetained: false,
});

const succeededCompletion = (runnerId: string, fencingToken: string, branch: string) => ({
  runnerId,
  fencingToken,
  exitCode: 0,
  signal: null,
  terminalEventSeen: true,
  terminalSuccess: true,
  terminationReason: null,
  output: SUCCEEDED_TAIL,
  branch,
  baseSha: SHA,
  headSha: SHA,
  pushStatus: "SUCCEEDED",
  pushRemote: "https://github.com/acme/widgets.git",
  pushedBranch: branch,
  deliveryInstructions: `Branch '${branch}' was pushed. This step does not open a pull request.`,
  cleanupStatus: "SUCCEEDED",
  workspaceRetained: false,
});

test("a failed run's output survives on the run that produced it", async () => {
  const { task } = await seedTask({ chained: false });
  const runId = await enqueue(task.id);
  const { run, fencingToken } = await claimRun(runId, "runner-1");

  const completed = await call(
    "POST", `/runner/runs/${runId}/complete`, RUNNER,
    failedCompletion("runner-1", fencingToken, run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));

  const closed = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(closed.status, "FAILED");
  // The whole of issue #114: before this, the tail this failure arrived with
  // was read by nothing and stored nowhere, and the run's own account of what
  // it found died in the handler that received it.
  assert.equal(closed.output, FAILED_TAIL);
  // And it stays telemetry. The deliverables table is not where a failure's
  // stdout belongs, and nothing downstream may read this as a step's product.
  assert.equal(await db.taskStepOutput.count({ where: { taskId: task.id } }), 0);
});

test("the tail is kept off the task read routes that serialize whole run rows", async () => {
  const { project, task } = await seedTask({ chained: false });
  const runId = await enqueue(task.id);
  const { run, fencingToken } = await claimRun(runId, "runner-1");
  await call(
    "POST", `/runner/runs/${runId}/complete`, RUNNER,
    failedCompletion("runner-1", fencingToken, run.branch ?? "master"),
  );
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: runId } })).output, FAILED_TAIL);

  // Both routes spread whole run rows into their responses, so a 500k forensic
  // column would ride along on every poll of the board and the task page. The
  // evidence is on the row for whoever goes looking; it is not part of the
  // shape either client asks for.
  const detail = await call("GET", `/tasks/${task.id}`, OPERATOR);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.runs.length, 1);
  assert.equal("output" in detail.body.runs[0], false);
  assert.equal(detail.body.runs[0].failureReason, "Error: session ended without a result");

  const list = await call("GET", `/tasks?projectId=${project.id}`, OPERATOR);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const listed = (list.body as Array<{ id: string; runs: Array<Record<string, unknown>> }>)
    .find((row) => row.id === task.id);
  assert.ok(listed, "the task must still be listed");
  assert.equal("output" in listed.runs[0]!, false);
});

test("a successful run's output is kept on its run as well", async () => {
  const { task } = await seedTask({ chained: false });
  const runId = await enqueue(task.id);
  const { run, fencingToken } = await claimRun(runId, "runner-1");

  const completed = await call(
    "POST", `/runner/runs/${runId}/complete`, RUNNER,
    succeededCompletion("runner-1", fencingToken, run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));

  const closed = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(closed.status, "SUCCEEDED");
  // A plain task has no template, chain or follow-up, so this tail used to be
  // discarded too — success was no protection, only a different branch of the
  // same omission.
  assert.equal(closed.output, SUCCEEDED_TAIL);
});

test("ordinary chained steps retain completion-time output synthesis", async () => {
  const { task } = await seedTask({ chained: true });
  const runId = await enqueue(task.id);
  const { run, fencingToken } = await claimRun(runId, "runner-ordinary-chain");
  const completed = await call(
    "POST", `/runner/runs/${runId}/complete`, RUNNER,
    succeededCompletion("runner-ordinary-chain", fencingToken, run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const output = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: task.id } });
  assert.equal(output.runId, runId);
  assert.equal(output.body, SUCCEEDED_TAIL);
});

test("regression completion keeps final prose as Run.output but requires this run's explicit task_output", async () => {
  const { task } = await seedTask({ chained: true, outputKind: "regression-verification" });
  const runId = await enqueue(task.id);
  // The budget is spent, so the missing deliverable is not re-queued and this
  // terminal stop is what completion reaches.
  await db.run.update({ where: { id: runId }, data: { maxRunsPerTask: 1 } });
  const { run, sessionToken, fencingToken } = await claimRun(runId, "runner-regression");
  const nonVerdict = "GATE NOT RUN: the exact candidate was not transported";
  const activity = await call("POST", `/session/runs/${runId}/activity`, sessionToken, {
    fencingToken,
    body: nonVerdict,
  });
  assert.equal(activity.status, 201, JSON.stringify(activity.body));

  const completed = await call(
    "POST", `/runner/runs/${runId}/complete`, RUNNER,
    { ...succeededCompletion("runner-regression", fencingToken, run.branch ?? "master"), output: "I could not obtain a gate verdict." },
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));

  assert.equal((await db.run.findUniqueOrThrow({ where: { id: runId } })).output, "I could not obtain a gate verdict.");
  assert.equal(await db.taskStepOutput.count({ where: { taskId: task.id } }), 0, "completion prose became structured output");
  const stopped = await db.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(stopped.status, TaskStatus.REVIEW);
  assert.match(stopped.failureReason ?? "", /missing regression-verification task output for current Run/u);
  const activities = await db.taskActivity.findMany({ where: { taskId: task.id }, orderBy: { createdAt: "asc" } });
  assert.ok(activities.some(({ body }) => body === nonVerdict), "the agent's original non-verdict activity was lost");
  assert.ok(activities.some(({ metadata }) => (metadata as Record<string, unknown> | null)?.kind === "canonicalTaskOutput.refusal"));
  assert.deepEqual(releasedChainLeases, [task.chainId]);
});

test("every authored Regression stop verdict releases its chain lease", async () => {
  for (const verdict of [
    { schemaVersion: 1, outcome: "refresh-conflict", headSha: SHA, baseHeadSha: "b".repeat(40), summary: "conflict" },
    { schemaVersion: 1, outcome: "review-fail", headSha: SHA, baseHeadSha: "b".repeat(40), summary: "must-fix remains" },
    { schemaVersion: 1, outcome: "gate-fail", headSha: SHA, baseHeadSha: "b".repeat(40), gateVerdict: "FAIL", summary: "gate failed" },
  ] as const) {
    releasedChainLeases.length = 0;
    const { task } = await seedTask({
      chained: true,
      outputKind: "regression-verification",
      templateName: DIRECT_TEMPLATE_NAME,
      stepIndex: 5,
    });
    const runId = await enqueue(task.id);
    const { run, sessionToken, fencingToken } = await claimRun(runId, `runner-${verdict.outcome}`);
    const written = await call("PUT", `/session/runs/${runId}/output`, sessionToken, {
      fencingToken,
      kind: "regression-verification",
      body: JSON.stringify(verdict),
      commitSha: SHA,
    });
    assert.equal(written.status, 200, JSON.stringify(written.body));
    const completed = await call(
      "POST",
      `/runner/runs/${runId}/complete`,
      RUNNER,
      succeededCompletion(`runner-${verdict.outcome}`, fencingToken, run.branch ?? "master"),
    );
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.deepEqual(releasedChainLeases, [task.chainId], verdict.outcome);
  }
});

/**
 * A step whose deliverable only its agent can author used to settle SUCCEEDED
 * when the session ended without persisting one — the Claude adapter reads the
 * end of a turn as the end of the session, so a step that parked on a
 * background wait (a merge lease, a gate verdict) had its wait killed and its
 * run recorded as a success. The chain then stopped at the fail-loud below,
 * which only an operator could clear. The miss is a retryable failure of the
 * run instead, and the fail-loud is what is left when the budget is spent.
 */
const REGRESSION_STEP = {
  chained: true,
  outputKind: "regression-verification",
  templateName: DIRECT_TEMPLATE_NAME,
  stepIndex: 5,
} as const;

test("a required deliverable the run never persisted is a retryable failure, not a success", async () => {
  const { task } = await seedTask(REGRESSION_STEP);
  const runId = await enqueue(task.id);
  const { run, fencingToken } = await claimRun(runId, "runner-missing-output");
  const completed = await call(
    "POST",
    `/runner/runs/${runId}/complete`,
    RUNNER,
    succeededCompletion("runner-missing-output", fencingToken, run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.succeeded, false);
  assert.equal(completed.body.retryCreated, true);

  const settled = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(settled.status, "FAILED");
  assert.equal(settled.retryable, true);
  assert.equal(settled.failureClass, "PROTOCOL_ERROR");
  assert.match(settled.failureReason ?? "", /missing regression-verification task output for current Run/u);

  const retry = await db.run.findFirstOrThrow({ where: { taskId: task.id, runNumber: 2 } });
  assert.equal(retry.status, "QUEUED");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status, TaskStatus.DOING);
  // The chain still owns the delivery it is retrying, exactly as for any other
  // retried Regression failure.
  assert.deepEqual(releasedChainLeases, []);
});

test("a run that authored nothing is re-queued even when a prior run's output is on the task", async () => {
  const { task } = await seedTask({
    chained: true,
    outputKind: "implementation",
    templateName: DIRECT_TEMPLATE_NAME,
    stepIndex: 1,
  });
  const firstRunId = await enqueue(task.id);
  const first = await claimRun(firstRunId, "prior-output-runner-1");
  const written = await call("PUT", `/session/runs/${firstRunId}/output`, first.sessionToken, {
    fencingToken: first.fencingToken,
    kind: "implementation",
    body: implementationOutput("Run 1 implementation"),
    commitSha: SHA,
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal((await call(
    "POST", `/runner/runs/${firstRunId}/complete`, RUNNER,
    failedCompletion("prior-output-runner-1", first.fencingToken, first.run.branch ?? "master"),
  )).status, 200);
  const retried = await call("POST", `/tasks/${task.id}/retry`, OPERATOR);
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  const secondRunId = retried.body.id as string;
  const claimed = await claimRun(secondRunId, "prior-output-runner-2");
  const status = await call("GET", `/session/runs/${secondRunId}/status`, claimed.sessionToken);
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(status.body.task.outputRequired, true);
  assert.equal(status.body.task.outputRemediationAllowed, true);
  assert.equal(status.body.task.outputSatisfiedByPriorRun, false);
  assert.equal(status.body.task.outputPersisted, false, "the prior Run's output is not this Run's deliverable");

  const completed = await call(
    "POST", `/runner/runs/${secondRunId}/complete`, RUNNER,
    succeededCompletion("prior-output-runner-2", claimed.fencingToken, claimed.run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.succeeded, false);
  assert.equal(completed.body.retryCreated, true);
  // The row an earlier run authored is neither counted as this run's work nor
  // disturbed by the retry it produces.
  assert.equal((await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: task.id } })).runId, firstRunId);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status, TaskStatus.DOING);
  assert.equal((await db.run.findFirstOrThrow({ where: { taskId: task.id, runNumber: 3 } })).status, "QUEUED");
});

test("an immutable prior Run output disables remediation and explicitly satisfies the task", async () => {
  const { task } = await seedTask({
    chained: true,
    outputKind: "sol-findings",
    templateName: DIRECT_TEMPLATE_NAME,
    stepIndex: 2,
  });
  const firstRunId = await enqueue(task.id);
  const first = await claimRun(firstRunId, "immutable-output-runner-1");
  const written = await call("PUT", `/session/runs/${firstRunId}/output`, first.sessionToken, {
    fencingToken: first.fencingToken,
    kind: "sol-findings",
    body: solFindingsOutput(),
    commitSha: SHA,
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal((await call(
    "POST", `/runner/runs/${firstRunId}/complete`, RUNNER,
    failedCompletion("immutable-output-runner-1", first.fencingToken, first.run.branch ?? "master"),
  )).status, 200);
  const retried = await call("POST", `/tasks/${task.id}/retry`, OPERATOR);
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  const secondRunId = retried.body.id as string;
  const second = await claimRun(secondRunId, "immutable-output-runner-2");

  const status = await call("GET", `/session/runs/${secondRunId}/status`, second.sessionToken);

  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(status.body.task.outputRequired, true);
  assert.equal(status.body.task.outputRemediationAllowed, false);
  assert.equal(status.body.task.outputSatisfiedByPriorRun, true);
  assert.equal(status.body.task.outputPersisted, false);
});

test("a required deliverable that is present still settles SUCCEEDED", async () => {
  const { task } = await seedTask(REGRESSION_STEP);
  const runId = await enqueue(task.id);
  const { run, fencingToken, sessionToken } = await claimRun(runId, "runner-present-output");
  const written = await call("PUT", `/session/runs/${runId}/output`, sessionToken, {
    fencingToken,
    kind: "regression-verification",
    body: regressionOutput("gate failed"),
    commitSha: SHA,
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  const completed = await call(
    "POST",
    `/runner/runs/${runId}/complete`,
    RUNNER,
    succeededCompletion("runner-present-output", fencingToken, run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.succeeded, true);
  assert.equal(completed.body.retryCreated, false);
  const settled = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(settled.status, "SUCCEEDED");
  assert.equal(settled.failureReason, null);
  assert.equal(await db.run.count({ where: { taskId: task.id } }), 1);
});

test("a canonical Regression output refusal is the backstop once the run budget is spent", async () => {
  const { task } = await seedTask(REGRESSION_STEP);
  const runId = await enqueue(task.id);
  await db.run.update({ where: { id: runId }, data: { maxRunsPerTask: 1 } });
  const { run, fencingToken } = await claimRun(runId, "runner-canonical-refusal");
  const completed = await call(
    "POST",
    `/runner/runs/${runId}/complete`,
    RUNNER,
    succeededCompletion("runner-canonical-refusal", fencingToken, run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(await db.run.count({ where: { taskId: task.id } }), 1, "a spent budget queues nothing");
  assert.match((await db.task.findUniqueOrThrow({ where: { id: task.id } })).failureReason ?? "", /missing regression-verification task output/u);
  const refusal = await db.taskActivity.findFirst({
    where: { taskId: task.id, metadata: { path: ["kind"], equals: "canonicalTaskOutput.refusal" } },
  });
  assert.ok(refusal, "the stop is the canonical output refusal path");
  assert.deepEqual(releasedChainLeases, [task.chainId]);
});

test("a runner too old to send an output completes exactly as it always did", async () => {
  const { task } = await seedTask({ chained: false });
  const runId = await enqueue(task.id);
  const { run, fencingToken } = await claimRun(runId, "runner-1");

  // The same real payload with the field removed, which is what a runner
  // predating it sends: `output` is optional on the wire and this is the whole
  // of the backward-compatibility contract. The column stays NULL — the honest
  // answer for a run whose tail was never reported — and nothing else about the
  // completion changes.
  const { output: _omitted, ...oldRunnerBody } = succeededCompletion(
    "runner-1", fencingToken, run.branch ?? "master",
  );
  const completed = await call("POST", `/runner/runs/${runId}/complete`, RUNNER, oldRunnerBody);
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.succeeded, true);

  const closed = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(closed.status, "SUCCEEDED");
  assert.equal(closed.output, null);
  assert.equal(closed.headSha, SHA, "the rest of the completion landed as usual");
});

test("a later run does not restamp the output row an earlier run wrote", async () => {
  const { task } = await seedTask({ chained: true });
  const firstRunId = await enqueue(task.id);
  const first = await claimRun(firstRunId, "runner-1");

  // The only production writer of a step output: the agent's own session,
  // through the MCP output tool's route.
  const written = await call("PUT", `/session/runs/${firstRunId}/output`, first.sessionToken, {
    fencingToken: first.fencingToken,
    kind: "result",
    body: "The deadlock is in reconcile.ts; here is the patch and its proof.",
    commitSha: SHA,
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));

  const firstCompleted = await call(
    "POST", `/runner/runs/${firstRunId}/complete`, RUNNER,
    failedCompletion("runner-1", first.fencingToken, first.run.branch ?? "master"),
  );
  assert.equal(firstCompleted.status, 200, JSON.stringify(firstCompleted.body));

  // An operator reruns the step: the fourth run-creating path, and the one an
  // operator actually reaches from a task that landed in review.
  const retried = await call("POST", `/tasks/${task.id}/retry`, OPERATOR);
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  const second = await claimRun(retried.body.id as string, "runner-2");

  // Run 2 succeeds without writing an output of its own — the agent simply did
  // not call the tool, which is ordinary.
  const secondCompleted = await call(
    "POST", `/runner/runs/${second.run.id}/complete`, RUNNER,
    succeededCompletion("runner-2", second.fencingToken, second.run.branch ?? "master"),
  );
  assert.equal(secondCompleted.status, 200, JSON.stringify(secondCompleted.body));

  const row = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: task.id } });
  // One act of authorship: body, author and metadata all still run 1's. The
  // restamp used to move two of the three and leave the body behind.
  assert.equal(row.body, "The deadlock is in reconcile.ts; here is the patch and its proof.");
  assert.equal(row.runId, firstRunId);
  assert.equal(row.metadata, null);
  assert.equal(await db.taskStepOutput.count({ where: { taskId: task.id } }), 1);

  // Neither run lost its own tail to the other's completion.
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: firstRunId } })).output, FAILED_TAIL);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: second.run.id } })).output, SUCCEEDED_TAIL);
});

test("a canonical step cannot advance from a prior Run's output", async () => {
  const { task } = await seedTask({
    chained: true,
    outputKind: "implementation",
    templateName: DIRECT_TEMPLATE_NAME,
    stepIndex: 1,
  });
  const firstRunId = await enqueue(task.id);
  const first = await claimRun(firstRunId, "canonical-runner-1");
  const wrongKind = await call("PUT", `/session/runs/${firstRunId}/output`, first.sessionToken, {
    fencingToken: first.fencingToken,
    kind: "result",
    body: "wrong canonical kind",
    commitSha: SHA,
  });
  assert.equal(wrongKind.status, 409);
  const written = await call("PUT", `/session/runs/${firstRunId}/output`, first.sessionToken, {
    fencingToken: first.fencingToken,
    kind: "implementation",
    body: implementationOutput("Run 1 implementation"),
    commitSha: SHA,
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal((await call(
    "POST", `/runner/runs/${firstRunId}/complete`, RUNNER,
    failedCompletion("canonical-runner-1", first.fencingToken, first.run.branch ?? "master"),
  )).status, 200);

  const retried = await call("POST", `/tasks/${task.id}/retry`, OPERATOR);
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  const second = await claimRun(retried.body.id as string, "canonical-runner-2");
  // The budget is spent on this attempt, so the run that authors nothing is
  // not re-queued and this refusal is the terminal outcome.
  await db.run.update({ where: { id: second.run.id }, data: { maxRunsPerTask: 2 } });
  const completed = await call(
    "POST", `/runner/runs/${second.run.id}/complete`, RUNNER,
    succeededCompletion("canonical-runner-2", second.fencingToken, second.run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));

  const output = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: task.id } });
  assert.equal(output.runId, firstRunId);
  const stopped = await db.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(stopped.status, TaskStatus.REVIEW);
  assert.match(stopped.failureReason ?? "", /belongs to prior Run/u);

  const queuedThird = await call("POST", `/tasks/${task.id}/retry`, OPERATOR);
  assert.equal(queuedThird.status, 201, JSON.stringify(queuedThird.body));
  const loaded = await db.task.findUniqueOrThrow({
    where: { id: task.id },
    include: { templateStep: { include: { taskTemplate: { select: { name: true } } } } },
  });
  const handoff = await db.$transaction((tx) => previousRunHandoffForClaim(tx, {
    taskId: task.id,
    runId: queuedThird.body.id as string,
    runNumber: 3,
    templateStep: loaded.templateStep,
  }));
  assert.deepEqual(handoff?.output, {
    runId: firstRunId,
    kind: "implementation",
    body: implementationOutput("Run 1 implementation"),
    commitSha: SHA,
  });
});

test("canonical JSON contracts reject malformed bodies and never activate a successor", async () => {
  const malformed = [
    { name: "non-JSON", body: "implementation prose", error: /must be valid JSON/u },
    {
      name: "missing schemaVersion",
      body: JSON.stringify({ headSha: SHA, baseSha: SHA, summary: "implemented", testsRun: ["focused"] }),
      error: /schemaVersion 1 at schemaVersion/u,
    },
    {
      name: "unsupported schemaVersion",
      body: JSON.stringify({ schemaVersion: 2, headSha: SHA, baseSha: SHA, summary: "implemented", testsRun: ["focused"] }),
      error: /schemaVersion 1 at schemaVersion/u,
    },
    {
      name: "kind-specific malformed body",
      body: JSON.stringify({ schemaVersion: 1, headSha: SHA, summary: "implemented", testsRun: ["focused"] }),
      error: /schemaVersion 1 at baseSha/u,
    },
  ];
  for (const fixture of malformed) {
    const seed = await seedTask({
      chained: true,
      outputKind: "implementation",
      templateName: DIRECT_TEMPLATE_NAME,
      stepIndex: 1,
    });
    const successor = await addSuccessor(seed);
    const runId = await enqueue(seed.task.id);
    // A refused output leaves the run with nothing to deliver, which is
    // retryable until the budget is spent; this fixture is about the stop it
    // ends at, so it starts with the last attempt.
    await db.run.update({ where: { id: runId }, data: { maxRunsPerTask: 1 } });
    const claimed = await claimRun(runId, `contract-${fixture.name}`);
    const refused = await call("PUT", `/session/runs/${runId}/output`, claimed.sessionToken, {
      fencingToken: claimed.fencingToken,
      kind: "implementation",
      body: fixture.body,
      commitSha: SHA,
    });
    assert.equal(refused.status, 409, fixture.name);
    assert.match(refused.body.error, fixture.error, fixture.name);

    const completed = await call(
      "POST", `/runner/runs/${runId}/complete`, RUNNER,
      succeededCompletion(`contract-${fixture.name}`, claimed.fencingToken, claimed.run.branch ?? "master"),
    );
    assert.equal(completed.status, 200, `${fixture.name}: ${JSON.stringify(completed.body)}`);
    const stopped = await db.task.findUniqueOrThrow({ where: { id: seed.task.id } });
    assert.equal(stopped.status, TaskStatus.REVIEW, fixture.name);
    assert.equal(await db.run.count({ where: { taskId: successor.id } }), 0, fixture.name);
  }
});

test("a canonical output authored at an earlier head is not restamped at completion", async () => {
  const authoredHead = "a".repeat(40);
  const seed = await seedTask({
    chained: true,
    outputKind: "implementation",
    templateName: DIRECT_TEMPLATE_NAME,
    stepIndex: 1,
  });
  const successor = await addSuccessor(seed);
  const runId = await enqueue(seed.task.id);
  const claimed = await claimRun(runId, "stale-authored-head");
  const written = await call("PUT", `/session/runs/${runId}/output`, claimed.sessionToken, {
    fencingToken: claimed.fencingToken,
    kind: "implementation",
    body: implementationOutput("authored before final delivery commit", authoredHead),
    commitSha: authoredHead,
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));

  const completed = await call(
    "POST", `/runner/runs/${runId}/complete`, RUNNER,
    succeededCompletion("stale-authored-head", claimed.fencingToken, claimed.run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const output = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: seed.task.id } });
  assert.equal(output.commitSha, authoredHead);
  assert.equal((JSON.parse(output.body) as { headSha: string }).headSha, authoredHead);
  const stopped = await db.task.findUniqueOrThrow({ where: { id: seed.task.id } });
  assert.equal(stopped.status, TaskStatus.REVIEW);
  assert.match(stopped.failureReason ?? "", /not completion head/u);
  assert.equal(await db.run.count({ where: { taskId: successor.id } }), 0);
});

test("completion makes an admitted replacement output lose atomically before successor activation", { timeout: 20_000 }, async () => {
  const seed = await seedTask({
    chained: true,
    outputKind: "implementation",
    templateName: DIRECT_TEMPLATE_NAME,
    stepIndex: 1,
  });
  const successor = await addSuccessor(seed);
  const runId = await enqueue(seed.task.id);
  const claimed = await claimRun(runId, "output-completion-race");
  const originalBody = implementationOutput("the immutable accepted handoff");
  assert.equal((await call("PUT", `/session/runs/${runId}/output`, claimed.sessionToken, {
    fencingToken: claimed.fencingToken,
    kind: "implementation",
    body: originalBody,
    commitSha: SHA,
  })).status, 200);

  const completionClient = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
  const outputClient = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
  let completionLocked!: () => void;
  let outputWaiting!: () => void;
  let releaseCompletion!: () => void;
  const completionHasLock = new Promise<void>((resolve) => { completionLocked = resolve; });
  const outputReachedLock = new Promise<void>((resolve) => { outputWaiting = resolve; });
  const release = new Promise<void>((resolve) => { releaseCompletion = resolve; });
  const instrumentTransactions = (
    client: PrismaClient,
    intercept: (pending: Promise<unknown>) => Promise<unknown>,
  ): PrismaClient => new Proxy(client, { get(target, property, receiver) {
    if (property !== "$transaction") {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return (operation: (tx: any) => Promise<unknown>, options: unknown) => target.$transaction(async (tx) => {
      const instrumentedTx = new Proxy(tx, { get(txTarget, txProperty, txReceiver) {
        if (txProperty !== "$queryRaw") return Reflect.get(txTarget, txProperty, txReceiver);
        return (...args: unknown[]) => intercept(Reflect.apply(txTarget.$queryRaw, txTarget, args));
      } });
      return operation(instrumentedTx);
    }, options as any);
  } }) as PrismaClient;
  let completionIntercepted = false;
  let outputIntercepted = false;
  const completionDb = instrumentTransactions(completionClient, async (pending) => {
    const result = await pending;
    if (!completionIntercepted) {
      completionIntercepted = true;
      completionLocked();
      await release;
    }
    return result;
  });
  const outputDb = instrumentTransactions(outputClient, async (pending) => {
    if (!outputIntercepted) {
      outputIntercepted = true;
      outputWaiting();
    }
    return pending;
  });
  try {
    await withTokens(async () => {
      const completion = createApp(completionDb).request(`/runner/runs/${runId}/complete`, {
        method: "POST",
        headers: { Authorization: `Bearer ${RUNNER}`, "Content-Type": "application/json" },
        body: JSON.stringify(succeededCompletion("output-completion-race", claimed.fencingToken, claimed.run.branch ?? "master")),
      });
      await completionHasLock;
      const replacement = createApp(outputDb).request(`/session/runs/${runId}/output`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${claimed.sessionToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          fencingToken: claimed.fencingToken,
          kind: "implementation",
          body: implementationOutput("late replacement must lose"),
          commitSha: SHA,
        }),
      });
      await outputReachedLock;
      releaseCompletion();
      const [completed, replaced] = await Promise.all([completion, replacement]);
      assert.equal(completed.status, 200, await completed.text());
      assert.equal(replaced.status, 409);
      assert.match((await replaced.json() as { error: string }).error, /Stale fencing token/u);
    });
  } finally {
    await Promise.all([completionClient.$disconnect(), outputClient.$disconnect()]);
  }
  const output = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: seed.task.id } });
  assert.equal(output.body, originalBody);
  assert.equal(await db.run.count({ where: { taskId: successor.id, status: "QUEUED" } }), 1);
});

test("cancellation holding the Run mutex makes an already-authenticated output lose", { timeout: 20_000 }, async () => {
  const seed = await seedTask({
    chained: true,
    outputKind: "implementation",
    templateName: DIRECT_TEMPLATE_NAME,
    stepIndex: 1,
  });
  const runId = await enqueue(seed.task.id);
  const claimed = await claimRun(runId, "output-cancellation-race");
  const cancellationClient = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
  const outputClient = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
  let cancellationLocked!: () => void;
  let outputWaiting!: () => void;
  let releaseCancellation!: () => void;
  const cancellationHasLock = new Promise<void>((resolve) => { cancellationLocked = resolve; });
  const outputReachedLock = new Promise<void>((resolve) => { outputWaiting = resolve; });
  const release = new Promise<void>((resolve) => { releaseCancellation = resolve; });
  const instrumentTransactions = (
    client: PrismaClient,
    intercept: (pending: Promise<unknown>) => Promise<unknown>,
  ): PrismaClient => new Proxy(client, { get(target, property, receiver) {
    if (property !== "$transaction") {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return (operation: (tx: any) => Promise<unknown>, options: unknown) => target.$transaction(async (tx) => {
      const instrumentedTx = new Proxy(tx, { get(txTarget, txProperty, txReceiver) {
        if (txProperty !== "$queryRaw") return Reflect.get(txTarget, txProperty, txReceiver);
        return (...args: unknown[]) => intercept(Reflect.apply(txTarget.$queryRaw, txTarget, args));
      } });
      return operation(instrumentedTx);
    }, options as any);
  } }) as PrismaClient;
  let cancellationIntercepted = false;
  let outputIntercepted = false;
  const cancellationDb = instrumentTransactions(cancellationClient, async (pending) => {
    const result = await pending;
    if (!cancellationIntercepted) {
      cancellationIntercepted = true;
      cancellationLocked();
      await release;
    }
    return result;
  });
  const outputDb = instrumentTransactions(outputClient, async (pending) => {
    if (!outputIntercepted) {
      outputIntercepted = true;
      outputWaiting();
    }
    return pending;
  });
  try {
    await withTokens(async () => {
      const cancellation = createApp(cancellationDb).request(`/runs/${runId}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "cancel-output-race", reason: "operator stop" }),
      });
      await cancellationHasLock;
      const output = createApp(outputDb).request(`/session/runs/${runId}/output`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${claimed.sessionToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          fencingToken: claimed.fencingToken,
          kind: "implementation",
          body: implementationOutput("late output must lose"),
          commitSha: SHA,
        }),
      });
      await outputReachedLock;
      releaseCancellation();
      const [cancelled, written] = await Promise.all([cancellation, output]);
      assert.equal(cancelled.status, 200, await cancelled.text());
      assert.equal(written.status, 409);
      assert.match((await written.json() as { error: string }).error, /Stale fencing token/u);
    });
  } finally {
    await Promise.all([cancellationClient.$disconnect(), outputClient.$disconnect()]);
  }
  assert.equal(await db.taskStepOutput.count({ where: { taskId: seed.task.id } }), 0);
  const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(run.cancelRequestId, "cancel-output-race");
});

test("canonical approval revision requeues the same Spec, hands off its output, and activates Plan once after replacement approval", async () => {
  const seed = await seedTask({
    chained: true,
    outputKind: "spec",
    templateName: "compound-engineer-workflow",
    stepIndex: 1,
    approvalGate: true,
  });
  const plan = await addSuccessor(seed);
  const firstRunId = await enqueue(seed.task.id);
  const first = await claimRun(firstRunId, "revision-runner-1");
  assert.equal((await call("PUT", `/session/runs/${firstRunId}/output`, first.sessionToken, {
    fencingToken: first.fencingToken,
    kind: "spec",
    body: specOutput("first specification rejected at approval"),
    commitSha: SHA,
  })).status, 200);
  assert.equal((await call(
    "POST", `/runner/runs/${firstRunId}/complete`, RUNNER,
    succeededCompletion("revision-runner-1", first.fencingToken, first.run.branch ?? "master"),
  )).status, 200);

  const firstGate = await db.inboxMessage.findFirstOrThrow({ where: { gateTaskId: seed.task.id, status: "OPEN" } });
  const rejected = await call("POST", `/inbox/messages/${firstGate.id}/decision`, OPERATOR, {
    requestId: "revision-reject",
    decision: "reject",
  });
  assert.equal(rejected.status, 201, JSON.stringify(rejected.body));
  assert.equal(rejected.body.gateAction, "rejected");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seed.task.id } })).status, TaskStatus.TODO);
  assert.equal(await db.run.count({ where: { taskId: plan.id } }), 0);

  const claimed = await call("POST", "/runner/tasks/claim", RUNNER, {
    runnerId: "revision-runner-2",
    leaseSeconds: 60,
  });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.task.id, seed.task.id);
  assert.deepEqual(claimed.body.previousRunHandoff, {
    schemaVersion: 1,
    previousRunId: firstRunId,
    status: "SUCCEEDED",
    failureReason: null,
    retryReason: "approval-rejected-without-feedback",
    output: {
      runId: firstRunId,
      kind: "spec",
      body: specOutput("first specification rejected at approval"),
      commitSha: SHA,
    },
  });
  // A fresh branch/head alone is not approval evidence: Plan remains closed
  // until this Run publishes and completes a replacement persisted artifact.
  await db.run.update({ where: { id: claimed.body.run.id }, data: { headSha: "d".repeat(40) } });
  assert.equal(await db.run.count({ where: { taskId: plan.id } }), 0);

  const secondRunId = claimed.body.run.id as string;
  const replacementBody = specOutput("replacement specification accepted at approval");
  const replacement = await call("PUT", `/session/runs/${secondRunId}/output`, claimed.body.sessionToken, {
    fencingToken: claimed.body.fencingToken,
    kind: "spec",
    body: replacementBody,
    commitSha: SHA,
  });
  assert.equal(replacement.status, 200, JSON.stringify(replacement.body));
  const completed = await call(
    "POST", `/runner/runs/${secondRunId}/complete`, RUNNER,
    succeededCompletion("revision-runner-2", claimed.body.fencingToken, claimed.body.run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const secondGate = await db.inboxMessage.findFirstOrThrow({ where: { gateTaskId: seed.task.id, status: "OPEN" } });
  const approved = await call("POST", `/inbox/messages/${secondGate.id}/decision`, OPERATOR, {
    requestId: "revision-approve",
    decision: "approve",
  });
  assert.equal(approved.status, 201, JSON.stringify(approved.body));
  assert.equal(approved.body.gateAction, "approved");
  assert.equal(await db.run.count({ where: { taskId: plan.id } }), 1);
  assert.equal(await db.run.count({ where: { taskId: plan.id, status: "QUEUED" } }), 1);
  assert.equal((await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: seed.task.id } })).body, replacementBody);
});
