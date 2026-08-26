/**
 * Operator cancellation and the merge lease.
 *
 * A chain acquires `refs/merge-lease/holder` when its Regression step starts and
 * the control plane releases it on every terminal outcome it writes itself. An
 * operator's cancellation is also a terminal outcome — settlement creates no
 * retry and no successor — so a cancelled chain-tail run that kept the lease
 * would strand the merge window until a machine stole it 45 minutes later.
 *
 * There are three terminal writers of a cancellation, and all three are here:
 * the cancel route (a run cancelled before it was ever claimed), the runner's
 * acknowledgement, and reconciliation terminalizing a cancellation whose runner
 * never came back. Reconciliation's other terminal outcome — a lost run with no
 * attempts left — is tested alongside them, because it strands the lease the
 * same way.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { DIRECT_TEMPLATE_NAME, MERGE_TAIL_KIND, PrismaClient, RunStatus, TaskStatus } from "@agentos/db";

import type { ReleaseMergeLease } from "./merge-lease.js";
import { reconcileDatabaseRuns } from "./reconcile.js";
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

const OPERATOR = "operator-cancel-release";
const RUNNER = "runner-cancel-release";
const RUNNER_ID = "cancel-release-runner";

const call = async (method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const prior = [
    ["OPERATOR_TOKEN", process.env.OPERATOR_TOKEN],
    ["RUNNER_TOKEN", process.env.RUNNER_TOKEN],
  ] as const;
  process.env.OPERATOR_TOKEN = OPERATOR;
  process.env.RUNNER_TOKEN = RUNNER;
  try {
    const response = await createApp(db, {
      releaseMergeLease: async (chainId) => {
      if (chainId) releasedChainLeases.push(chainId);
    },
    }).request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
};

const collectRelease: ReleaseMergeLease = async (chainId) => {
  if (!chainId) return;
  releasedChainLeases.push(chainId);
};

let sequence = 0;

/** One chain whose tail step is the Regression step that holds the lease. */
const seedChain = async (options: { outputKind?: string } = {}) => {
  sequence += 1;
  const suffix = `${process.pid}-${sequence}`;
  const project = await db.project.create({ data: { name: "Cancel release", slug: `cancel-release-${suffix}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: `agent-${suffix}`, title: "Agent",
    model: "claude-opus-5:high", foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id, name: "repo", remoteUrl: "https://github.com/acme/widgets.git",
    mountPath: "/repo", defaultBranch: "master",
  } });
  const template = await db.taskTemplate.create({ data: {
    projectId: project.id, name: DIRECT_TEMPLATE_NAME, description: "cancel fixture", variables: [],
  } });
  const templateStep = await db.taskTemplateStep.create({ data: {
    taskTemplateId: template.id, stepIndex: 6, layer: 6, name: "Regression verification",
    assigneeType: "AGENT", assigneeAgentId: agent.id, prompt: "verify", approvalGate: false,
    outputKind: options.outputKind ?? "regression-verification",
  } });
  const task = await db.task.create({ data: {
    projectId: project.id, name: "Regression", description: "prove the candidate", assigneeAgentId: agent.id,
    repoId: repo.id, status: TaskStatus.DOING, targetBranch: "master",
    templateId: template.id, templateStepId: templateStep.id,
    chainId: `chain-${suffix}`, chainIndex: 6, chainLayer: 6,
  } });
  return { project, agent, repo, task, chainId: task.chainId!, suffix };
};

/** A merge-tail auxiliary task: no chain of its own, bound to a Regression task. */
const seedAuxiliaryRepair = async (chain: Awaited<ReturnType<typeof seedChain>>) => {
  const auxiliary = await db.task.create({ data: {
    projectId: chain.project.id, name: "Automatic refresh repair", description: "repair the candidate",
    assigneeAgentId: chain.agent.id, repoId: chain.repo.id, status: TaskStatus.DOING, targetBranch: "master",
  } });
  await db.taskActivity.create({ data: {
    taskId: auxiliary.id, actorType: "control-plane", body: "Automatic refresh repair started",
    metadata: {
      kind: MERGE_TAIL_KIND.repairAttempt, schemaVersion: 1, repairKind: "refresh",
      regressionTaskId: chain.task.id, headSha: "a".repeat(40), baseHeadSha: "b".repeat(40),
    },
  } });
  return auxiliary;
};

const seedRun = async (
  chain: Awaited<ReturnType<typeof seedChain>>,
  options: {
    taskId?: string;
    status?: RunStatus;
    runNumber?: number;
    maxRunsPerTask?: number;
    leaseExpiresAt?: Date | null;
    heartbeatAt?: Date | null;
    claimed?: boolean;
  } = {},
) => {
  const status = options.status ?? RunStatus.RUNNING;
  const runNumber = options.runNumber ?? 1;
  const taskId = options.taskId ?? chain.task.id;
  const claimed = options.claimed ?? status !== RunStatus.QUEUED;
  const run = await db.run.create({ data: {
    projectId: chain.project.id, taskId, agentId: chain.agent.id, repoId: chain.repo.id,
    runNumber, dedupeKey: `task:${taskId}:run:${runNumber}`, status,
    runner: "CLAUDE", model: chain.agent.model, promptHash: "hash", branch: `claude/${chain.suffix}-${runNumber}`,
    targetBranch: "master", maxRunsPerTask: options.maxRunsPerTask ?? 5,
    ...(claimed ? {
      runnerId: RUNNER_ID,
      fencingToken: `fence-${chain.suffix}-${runNumber}`,
      leaseGeneration: 1,
      leaseExpiresAt: options.leaseExpiresAt === undefined ? new Date(Date.now() + 600_000) : options.leaseExpiresAt,
      heartbeatAt: options.heartbeatAt === undefined ? new Date() : options.heartbeatAt,
      claimedAt: new Date(),
    } : {}),
  } });
  if (claimed) await db.session.create({ data: {
    runId: run.id, projectId: chain.project.id, agentId: chain.agent.id, taskId, runner: "CLAUDE",
    executionStatus: "RUNNING",
  } });
  return run;
};

test("acknowledging an operator cancellation releases the Regression chain's lease", async () => {
  const chain = await seedChain();
  const run = await seedRun(chain);

  const requested = await call("POST", `/runs/${run.id}/cancel`, OPERATOR, {
    requestId: "cancel-running", reason: "operator stopped the regression",
  });
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  assert.equal(requested.body.cancellationState, "requested");
  // Only a terminal writer may free the lease, and the request is not one.
  assert.deepEqual(releasedChainLeases, []);

  const acknowledged = await call("POST", `/runner/runs/${run.id}/cancel/acknowledge`, RUNNER, {
    runnerId: RUNNER_ID, fencingToken: run.fencingToken, requestId: "cancel-running",
  });
  assert.equal(acknowledged.status, 200, JSON.stringify(acknowledged.body));
  assert.equal(acknowledged.body.cancellationState, "acknowledged");
  assert.equal("releaseMergeLeaseTask" in acknowledged.body, false, "the lease target is not part of the response");
  assert.deepEqual(releasedChainLeases, [chain.chainId]);

  // The acknowledgement is idempotent, and repeating it must not release again.
  const repeated = await call("POST", `/runner/runs/${run.id}/cancel/acknowledge`, RUNNER, {
    runnerId: RUNNER_ID, fencingToken: run.fencingToken, requestId: "cancel-running",
  });
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.deepEqual(releasedChainLeases, [chain.chainId]);
});

test("stopping and parking a queued Regression run releases the lease at once", async () => {
  const chain = await seedChain();
  const run = await seedRun(chain, { status: RunStatus.QUEUED });

  const stopped = await call("POST", `/runs/${run.id}/cancel`, OPERATOR, {
    requestId: "stop-and-park", reason: "operator parked the chain", parkTask: true,
  });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.equal(stopped.body.cancellationState, "acknowledged");
  assert.equal("releaseMergeLeaseTask" in stopped.body, false, "the lease target is not part of the response");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.task.id } })).status, TaskStatus.BACKLOG);
  assert.deepEqual(releasedChainLeases, [chain.chainId]);
});

test("cancelling an ordinary chain step never touches the lease", async () => {
  const chain = await seedChain({ outputKind: "implementation" });
  const run = await seedRun(chain);

  assert.equal((await call("POST", `/runs/${run.id}/cancel`, OPERATOR, {
    requestId: "cancel-ordinary", reason: "operator stopped an ordinary step",
  })).status, 200);
  const acknowledged = await call("POST", `/runner/runs/${run.id}/cancel/acknowledge`, RUNNER, {
    runnerId: RUNNER_ID, fencingToken: run.fencingToken, requestId: "cancel-ordinary",
  });
  assert.equal(acknowledged.status, 200, JSON.stringify(acknowledged.body));
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.CANCELLED);
  assert.deepEqual(releasedChainLeases, []);
});

test("cancelling a merge-tail auxiliary run releases the Regression chain it serves", async () => {
  const chain = await seedChain();
  const auxiliary = await seedAuxiliaryRepair(chain);
  const run = await seedRun(chain, { taskId: auxiliary.id });

  assert.equal((await call("POST", `/runs/${run.id}/cancel`, OPERATOR, {
    requestId: "cancel-auxiliary", reason: "operator stopped the repair",
  })).status, 200);
  const acknowledged = await call("POST", `/runner/runs/${run.id}/cancel/acknowledge`, RUNNER, {
    runnerId: RUNNER_ID, fencingToken: run.fencingToken, requestId: "cancel-auxiliary",
  });
  assert.equal(acknowledged.status, 200, JSON.stringify(acknowledged.body));
  // The auxiliary task has no chain of its own; the lease is the Regression's.
  assert.deepEqual(releasedChainLeases, [chain.chainId]);
});

test("reconciliation terminalizing a cancellation after runner loss releases the lease", async () => {
  const now = new Date();
  const chain = await seedChain();
  const run = await seedRun(chain, { leaseExpiresAt: new Date(now.getTime() - 60_000) });
  await db.run.update({ where: { id: run.id }, data: {
    cancelRequestId: "cancel-lost-runner",
    cancelReason: "operator stopped the regression",
    cancelRequestedAt: new Date(now.getTime() - 120_000),
  } });

  assert.equal(await reconcileDatabaseRuns(db, now, collectRelease), 1);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.CANCELLED);
  assert.deepEqual(releasedChainLeases, [chain.chainId]);
});

test("a lost Regression run that still has an attempt left keeps the lease for its retry", async () => {
  const now = new Date();
  const chain = await seedChain();
  const run = await seedRun(chain, {
    runNumber: 1, maxRunsPerTask: 3, leaseExpiresAt: new Date(now.getTime() - 60_000), heartbeatAt: null,
  });

  assert.equal(await reconcileDatabaseRuns(db, now, collectRelease), 1);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.LOST);
  const retry = await db.run.findFirst({ where: { taskId: chain.task.id, runNumber: 2 } });
  assert.ok(retry, "the lost run bought a retry");
  // The retry re-enters `acquire --task <chain>` and is handed the same lease.
  assert.deepEqual(releasedChainLeases, []);
});

test("a lost Regression run with no attempts left releases the lease", async () => {
  const now = new Date();
  const chain = await seedChain();
  const run = await seedRun(chain, {
    runNumber: 2, maxRunsPerTask: 1, leaseExpiresAt: new Date(now.getTime() - 60_000), heartbeatAt: null,
  });

  assert.equal(await reconcileDatabaseRuns(db, now, collectRelease), 1);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.LOST);
  assert.equal(await db.run.count({ where: { taskId: chain.task.id, runNumber: 3 } }), 0);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.task.id } })).status, TaskStatus.REVIEW);
  assert.deepEqual(releasedChainLeases, [chain.chainId]);
});

test("a lost ordinary step with no attempts left never touches the lease", async () => {
  const now = new Date();
  const chain = await seedChain({ outputKind: "implementation" });
  const run = await seedRun(chain, {
    runNumber: 2, maxRunsPerTask: 1, leaseExpiresAt: new Date(now.getTime() - 60_000), heartbeatAt: null,
  });

  assert.equal(await reconcileDatabaseRuns(db, now, collectRelease), 1);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.LOST);
  assert.deepEqual(releasedChainLeases, []);
});
