import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  CleanupStatus,
  MERGE_INTEGRATOR_KIND,
  MERGE_INTEGRATOR_SCHEMA_VERSION,
  Prisma,
  PrismaClient,
  PushStatus,
  RunStatus,
  SessionExecutionStatus,
  TaskStatus,
  isIntegratorStoppedError,
} from "@anneal/db";

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
  });
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.SUCCEEDED);
});

test("a resolved integrator stop race rolls back the whole predecessor completion", async () => {
  sequence += 1;
  const suffix = `${process.pid}-${sequence}`;
  const project = await db.project.create({ data: { name: "Stop race", slug: `stop-race-${suffix}` } });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const predecessorAgent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: `predecessor-${suffix}`,
    title: "Predecessor",
    model: "gpt-5.6-sol:high",
    runnerPreference: "CODEX",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const integratorAgent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: "merge-integrator",
    title: "Merge integrator",
    model: "mechanical/merge-executor-v1",
    runnerPreference: "CLAUDE",
    foundationalPrompt: "mechanical",
    rolePrompt: "mechanical",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: "repo",
    remoteUrl: "https://github.com/acme/repo.git",
    mountPath: "/repo",
    defaultBranch: "main",
  } });
  const template = await db.taskTemplate.create({ data: {
    projectId: project.id,
    name: `stop-race-template-${suffix}`,
    description: "Exercise the completion-to-integrator transaction seam",
    variables: [],
  } });
  const predecessorStep = await db.taskTemplateStep.create({ data: {
    taskTemplateId: template.id,
    assigneeAgentId: predecessorAgent.id,
    stepIndex: 1,
    name: "Predecessor",
    assigneeType: "AGENT",
    prompt: "produce output",
    outputKind: "result",
    layer: 1,
  } });
  const integratorStep = await db.taskTemplateStep.create({ data: {
    taskTemplateId: template.id,
    assigneeAgentId: integratorAgent.id,
    stepIndex: 2,
    name: "Integrator",
    assigneeType: "AGENT",
    prompt: "merge",
    outputKind: "merge-result",
    opensPullRequest: false,
    layer: 2,
  } });
  const chainId = `stop-race-chain-${suffix}`;
  const predecessor = await db.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    templateId: template.id,
    templateStepId: predecessorStep.id,
    assigneeAgentId: predecessorAgent.id,
    name: "Predecessor",
    description: "complete",
    status: TaskStatus.DOING,
    chainId,
    chainIndex: 1,
    chainLayer: 1,
  } });
  const successor = await db.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    templateId: template.id,
    templateStepId: integratorStep.id,
    assigneeAgentId: integratorAgent.id,
    name: "Integrator",
    description: "merge",
    status: TaskStatus.TODO,
    chainId,
    chainIndex: 2,
    chainLayer: 2,
    opensPullRequest: false,
  } });
  const run = await db.run.create({ data: {
    projectId: project.id,
    taskId: predecessor.id,
    agentId: predecessorAgent.id,
    repoId: repo.id,
    runNumber: 1,
    dedupeKey: `task:${predecessor.id}:run:1`,
    status: RunStatus.RUNNING,
    runner: "CODEX",
    model: predecessorAgent.model,
    promptHash: "hash",
    branch: `codex/stop-race-${suffix}`,
    runnerId: RUNNER_ID,
    fencingToken: `fence-${suffix}`,
    leaseGeneration: 1,
    leaseExpiresAt: new Date(Date.now() + 600_000),
    heartbeatAt: new Date(),
    claimedAt: new Date(),
  } });
  const session = await db.session.create({ data: {
    runId: run.id,
    projectId: project.id,
    taskId: predecessor.id,
    agentId: predecessorAgent.id,
    runner: "CODEX",
    executionStatus: SessionExecutionStatus.RUNNING,
  } });
  const stop = await db.taskActivity.create({ data: {
    taskId: successor.id,
    actorType: "control-plane",
    body: "Merge integrator stopped: base-drift",
    metadata: {
      kind: MERGE_INTEGRATOR_KIND.result,
      schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
      outcome: "stopped",
      condition: "base-drift",
      evidence: "base advanced",
      sourceRunId: null,
    },
  } });

  let dispositionReads = 0;
  const withResolvedStopOnReread = (tx: Prisma.TransactionClient): Prisma.TransactionClient => {
    const activity = new Proxy(tx.taskActivity, {
      get(target, property, receiver) {
        if (property === "findMany") {
          return async (args: Prisma.TaskActivityFindManyArgs) => {
            const rows = await target.findMany(args);
            const ascending = !Array.isArray(args.orderBy) && args.orderBy?.createdAt === "asc";
            if (args.where?.taskId === successor.id && ascending) {
              dispositionReads += 1;
              if (dispositionReads === 2) {
                return [...rows, { metadata: {
                  kind: MERGE_INTEGRATOR_KIND.stopAnswer,
                  schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
                  stopId: stop.id,
                  condition: "base-drift",
                  choice: "abandon",
                  disposition: "terminal-abandoned",
                } }];
              }
            }
            return rows;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return new Proxy(tx, {
      get(target, property, receiver) {
        if (property === "taskActivity") return activity;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  const racingDb = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        return (
          operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options?: { isolationLevel?: Prisma.TransactionIsolationLevel; maxWait?: number; timeout?: number },
        ) => target.$transaction((tx) => operation(withResolvedStopOnReread(tx)), options);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  await assert.rejects(
    completeRun(racingDb, {
      runId: run.id,
      body: { ...completion(run.fencingToken!), output: "predecessor output" },
      claimantClass: "runner",
    }),
    (error: unknown) => {
      assert.equal(isIntegratorStoppedError(error), true);
      if (!isIntegratorStoppedError(error)) return false;
      assert.equal(error.taskId, successor.id);
      assert.equal(error.condition, "base-drift");
      return true;
    },
  );
  assert.equal(dispositionReads, 2, "openRun and the post-savepoint branch must both read stop dispositions");

  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.RUNNING);
  assert.equal((await db.session.findUniqueOrThrow({ where: { id: session.id } })).executionStatus, SessionExecutionStatus.RUNNING);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: predecessor.id } })).status, TaskStatus.DOING);
  assert.equal(await db.taskStepOutput.count({ where: { taskId: predecessor.id } }), 0);
  assert.equal(await db.taskActivity.count({ where: { taskId: predecessor.id } }), 0);
  const parked = await db.task.findUniqueOrThrow({ where: { id: successor.id } });
  assert.equal(parked.status, TaskStatus.TODO);
  assert.equal(parked.failureReason, null);
  assert.equal(await db.run.count({ where: { taskId: successor.id } }), 0);
  assert.deepEqual(
    await db.taskActivity.findMany({ where: { taskId: successor.id }, select: { id: true } }),
    [{ id: stop.id }],
  );
});

test("completion persists outside-workspace worktree observations without changing the outcome", async () => {
  const { run } = await seed();
  const violations = ["/operator/worktrees/one", "/operator/worktrees/two"];
  const result = await completeRun(db, {
    runId: run.id,
    body: { ...completion(run.fencingToken!), worktreeContainmentViolations: violations },
    claimantClass: "runner",
  });
  assert.equal((result as { succeeded?: boolean }).succeeded, true);
  const closed = await db.run.findUniqueOrThrow({ where: { id: run.id } });
  assert.deepEqual(closed.worktreeContainmentViolations, violations);
  assert.equal(closed.status, RunStatus.SUCCEEDED);
});

test("omitted and empty containment observations remain absent on compliant completion", async () => {
  for (const violations of [undefined, []] as const) {
    const { run } = await seed();
    const result = await completeRun(db, {
      runId: run.id,
      body: {
        ...completion(run.fencingToken!),
        ...(violations === undefined ? {} : { worktreeContainmentViolations: [...violations] }),
      },
      claimantClass: "runner",
    });
    assert.equal((result as { succeeded?: boolean }).succeeded, true);
    const closed = await db.run.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(closed.worktreeContainmentViolations, null);
    assert.equal(closed.status, RunStatus.SUCCEEDED);
  }
});
