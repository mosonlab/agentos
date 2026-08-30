/**
 * Operator cancellation and the merge lease.
 *
 * Readiness acquires `refs/merge-lease/holder` before handing authorization to
 * the queued mechanical merge, and the control plane releases it when the
 * final consumer settles. An operator's cancellation is also a terminal
 * outcome — settlement creates no retry and no successor — so a cancelled
 * chain-tail run that retained the lease would strand the merge window until a
 * machine stole it 45 minutes later.
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

import {
  DIRECT_TEMPLATE_NAME,
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_SENTINEL_MODEL,
  MERGE_TAIL_KIND,
  PrismaClient,
  recordLeaseHandoff,
  RunStatus,
  settleLeaseEvent,
  TaskStatus,
} from "@anneal/db";

import type { ReleaseMergeLease } from "./merge-lease.js";
import { recordMergeLeaseHold } from "./merge-lease-hold.js";
import { ReconciliationMaintenanceError, reconcileDatabaseRuns } from "./reconcile.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
const releasedChainLeases: string[] = [];
const releasedLeaseTargets: Array<{ chainId: string; projectId: string }> = [];
beforeEach(async () => {
  releasedChainLeases.length = 0;
  releasedLeaseTargets.length = 0;
  await resetTestDb(db);
});
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-cancel-release";
const RUNNER = "runner-cancel-release";
const RUNNER_ID = "cancel-release-runner";
const CONFIRMED_RELEASED_AT = new Date("2026-08-27T12:01:02.999Z");
const CONFIRMED_RELEASE = {
  outcome: "released" as const,
  ref: "refs/merge-lease/holder",
  sha: "cancellation-lease",
  acquiredAt: "2026-08-27T12:00:00.250Z",
};

const call = async (method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const prior = [
    ["OPERATOR_TOKEN", process.env.OPERATOR_TOKEN],
    ["RUNNER_TOKEN", process.env.RUNNER_TOKEN],
  ] as const;
  process.env.OPERATOR_TOKEN = OPERATOR;
  process.env.RUNNER_TOKEN = RUNNER;
  try {
    const response = await createApp(db, {
      releaseMergeLease: collectRelease,
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

const collectRelease: ReleaseMergeLease = async (target, database) => {
  if (!target) return;
  releasedChainLeases.push(target.chainId);
  releasedLeaseTargets.push(target);
  await recordMergeLeaseHold(database, target, CONFIRMED_RELEASE, CONFIRMED_RELEASED_AT);
};

const assertConfirmedHold = async (taskId: string): Promise<void> => {
  const hold = await db.taskActivity.findFirstOrThrow({
    where: { taskId, metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseHold } },
  });
  assert.deepEqual(hold.metadata, {
    kind: MERGE_TAIL_KIND.leaseHold,
    schemaVersion: 1,
    ledgerId: (hold.metadata as Record<string, unknown>).ledgerId,
    chainId: (hold.metadata as Record<string, unknown>).chainId,
    leaseRef: CONFIRMED_RELEASE.ref,
    leaseSha: CONFIRMED_RELEASE.sha,
    acquiredAt: CONFIRMED_RELEASE.acquiredAt,
    releasedAt: CONFIRMED_RELEASED_AT.toISOString(),
    heldForSeconds: 62,
  });
};

let sequence = 0;

/** One chain whose merge-tail tasks share the readiness-owned lease identity. */
const seedChain = async (options: { outputKind?: string; chainId?: string; chainIndex?: number } = {}) => {
  sequence += 1;
  const suffix = `${process.pid}-${sequence}`;
  const project = await db.project.create({ data: { name: "Cancel release", slug: `cancel-release-${suffix}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const mechanical = options.outputKind === "merge-result";
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: mechanical ? INTEGRATOR_AGENT_NAME : `agent-${suffix}`,
    title: mechanical ? "Merge Integrator" : "Agent",
    model: mechanical ? INTEGRATOR_SENTINEL_MODEL : "claude-opus-5:high",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id, name: "repo", remoteUrl: "https://github.com/acme/widgets.git",
    mountPath: "/repo", defaultBranch: "master",
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: project.id,
    agentId: agent.id,
    repoId: repo.id,
    mountPath: "/repo",
    permissions: "GIT_WRITE",
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
    chainId: options.chainId ?? `chain-${suffix}`,
    chainIndex: options.chainIndex ?? 6,
    chainLayer: options.chainIndex ?? 6,
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
    createdAt?: Date;
    readyAt?: Date;
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
    ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    ...(options.readyAt ? { readyAt: options.readyAt } : {}),
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

const seedLeaseHandoff = async (
  chain: Awaited<ReturnType<typeof seedChain>>,
  runId: string,
  at: Date,
) => db.$transaction((tx) => recordLeaseHandoff(tx, {
  target: { projectId: chain.project.id, chainId: chain.chainId },
  toRunId: runId,
  at,
}));

test("acknowledging an operator cancellation releases the merge-tail chain lease", async () => {
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
  assert.deepEqual(releasedLeaseTargets, [{ chainId: chain.chainId, projectId: chain.project.id }]);

  // The acknowledgement is idempotent, and repeating it must not release again.
  const repeated = await call("POST", `/runner/runs/${run.id}/cancel/acknowledge`, RUNNER, {
    runnerId: RUNNER_ID, fencingToken: run.fencingToken, requestId: "cancel-running",
  });
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.deepEqual(releasedChainLeases, [chain.chainId]);
});

test("stopping and parking a queued merge-tail run releases the lease at once", async () => {
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
  assert.deepEqual(releasedLeaseTargets, [{ chainId: chain.chainId, projectId: chain.project.id }]);
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

test("cancelling a merge-tail auxiliary run releases the chain it serves", async () => {
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
  // The auxiliary task has no chain of its own; resolve the served chain's
  // project-scoped lease identity through its repair marker.
  assert.deepEqual(releasedChainLeases, [chain.chainId]);
  assert.deepEqual(releasedLeaseTargets, [{ chainId: chain.chainId, projectId: chain.project.id }]);
});

test("reconciliation terminalizing a cancellation after runner loss releases the lease", async () => {
  const now = new Date();
  const chain = await seedChain({ outputKind: "merge-result", chainIndex: 7 });
  const run = await seedRun(chain, { leaseExpiresAt: new Date(now.getTime() - 60_000) });
  await db.run.update({ where: { id: run.id }, data: {
    cancelRequestId: "cancel-lost-runner",
    cancelReason: "operator stopped the regression",
    cancelRequestedAt: new Date(now.getTime() - 120_000),
  } });

  assert.equal(await reconcileDatabaseRuns(db, now, collectRelease), 1);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.CANCELLED);
  assert.deepEqual(releasedChainLeases, [chain.chainId]);
  assert.deepEqual(releasedLeaseTargets, [{ chainId: chain.chainId, projectId: chain.project.id }]);
  await assertConfirmedHold(chain.task.id);
});

test("a lost mechanical run that still has an attempt left keeps the lease for its retry", async () => {
  const now = new Date();
  const chain = await seedChain({ outputKind: "merge-result", chainIndex: 7 });
  const run = await seedRun(chain, {
    runNumber: 1, maxRunsPerTask: 3, leaseExpiresAt: new Date(now.getTime() - 60_000), heartbeatAt: null,
  });

  assert.equal(await reconcileDatabaseRuns(db, now, collectRelease), 1);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.LOST);
  const retry = await db.run.findFirst({ where: { taskId: chain.task.id, runNumber: 2 } });
  assert.ok(retry, "the lost run bought a retry");
  // This retry inherits the already-held Lease. Only readiness authorization
  // creates a recoverable handoff marker; retry scheduling does not shorten
  // the original mechanical holding window.
  assert.deepEqual(releasedChainLeases, []);
  assert.equal(await db.taskActivity.count({ where: {
    taskId: chain.task.id,
    metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseHandoff },
  } }), 0);
});

test("a lost merge-tail run with no attempts left releases the lease", async () => {
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
  assert.deepEqual(releasedLeaseTargets, [{ chainId: chain.chainId, projectId: chain.project.id }]);
});

test("reconciliation releases same-named chain leases independently per project", async () => {
  const now = new Date();
  const chainId = "shared-chain-id";
  const first = await seedChain({ chainId });
  // Task's legacy uniqueness still covers (chainId, chainIndex) globally, so
  // use another valid tail ordinal to model a cross-project chain-id collision.
  const second = await seedChain({ chainId, chainIndex: 7 });
  await seedRun(first, {
    runNumber: 2,
    maxRunsPerTask: 1,
    leaseExpiresAt: new Date(now.getTime() - 60_000),
    heartbeatAt: null,
  });
  await seedRun(second, {
    runNumber: 2,
    maxRunsPerTask: 1,
    leaseExpiresAt: new Date(now.getTime() - 60_000),
    heartbeatAt: null,
  });

  assert.equal(await reconcileDatabaseRuns(db, now, collectRelease), 2);
  assert.deepEqual(
    releasedLeaseTargets.sort((left, right) => left.projectId.localeCompare(right.projectId)),
    [first, second]
      .map((chain) => ({ chainId, projectId: chain.project.id }))
      .sort((left, right) => left.projectId.localeCompare(right.projectId)),
  );
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

test("a stranded queued handoff releases once and records settlement after release", async () => {
  const now = new Date();
  const chain = await seedChain();
  const stale = new Date(now.getTime() - 180_000);
  const run = await seedRun(chain, { status: RunStatus.QUEUED, createdAt: stale, readyAt: stale });
  await seedLeaseHandoff(chain, run.id, new Date(now.getTime() - 120_000));

  assert.equal(await reconcileDatabaseRuns(db, now, collectRelease), 1);
  assert.deepEqual(releasedChainLeases, [chain.chainId]);
  assert.deepEqual(releasedLeaseTargets, [{ chainId: chain.chainId, projectId: chain.project.id }]);
  const settled = await db.taskActivity.findFirstOrThrow({
    where: { taskId: chain.task.id, metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseHandoff } },
    orderBy: { createdAt: "desc" },
  });
  assert.equal((settled.metadata as Record<string, unknown>).state, "released");
  assert.equal((await db.mergeLeaseEvent.findFirstOrThrow({
    where: { projectId: chain.project.id, chainId: chain.chainId },
  })).state, "RELEASED");
  await assertConfirmedHold(chain.task.id);

  assert.equal(await reconcileDatabaseRuns(db, new Date(now.getTime() + 1_000), collectRelease), 0);
  assert.deepEqual(releasedChainLeases, [chain.chainId]);
});

test("an old queued Run with a fresh handoff waits for the handoff grace clock", async () => {
  const now = new Date();
  const chain = await seedChain();
  const old = new Date(now.getTime() - (9 * 24 * 60 * 60 * 1_000));
  const freshHandoff = new Date(now.getTime() - 30_000);
  const run = await seedRun(chain, { status: RunStatus.QUEUED, createdAt: old, readyAt: old });
  await seedLeaseHandoff(chain, run.id, freshHandoff);

  assert.equal(await reconcileDatabaseRuns(db, now, collectRelease), 0);
  assert.deepEqual(releasedChainLeases, []);
  assert.equal(await reconcileDatabaseRuns(db, new Date(freshHandoff.getTime() + 61_000), collectRelease), 1);
  assert.deepEqual(releasedChainLeases, [chain.chainId]);
});

test("an old active handoff remains discoverable while released and claimed consumers stay excluded", async () => {
  const now = new Date();
  const old = await seedChain();
  const released = await seedChain();
  const claimed = await seedChain();
  const nineDaysAgo = new Date(now.getTime() - (9 * 24 * 60 * 60 * 1_000));
  const eightDaysAgo = new Date(now.getTime() - (8 * 24 * 60 * 60 * 1_000));
  const stale = new Date(now.getTime() - 180_000);
  const oldRun = await seedRun(old, {
    status: RunStatus.QUEUED, createdAt: nineDaysAgo, readyAt: nineDaysAgo,
  });
  const releasedRun = await seedRun(released, {
    status: RunStatus.QUEUED, createdAt: stale, readyAt: stale,
  });
  const claimedRun = await seedRun(claimed, {
    status: RunStatus.CLAIMED, createdAt: stale, readyAt: stale,
  });
  await seedLeaseHandoff(old, oldRun.id, eightDaysAgo);
  const releasedHandoff = await seedLeaseHandoff(released, releasedRun.id, new Date(now.getTime() - 120_000));
  await db.$transaction((tx) => settleLeaseEvent(tx, {
    eventId: releasedHandoff.event.id,
    state: "released",
    at: new Date(now.getTime() - 90_000),
  }));
  await seedLeaseHandoff(claimed, claimedRun.id, new Date(now.getTime() - 120_000));

  assert.equal(await reconcileDatabaseRuns(db, now, collectRelease), 1);
  assert.deepEqual(releasedLeaseTargets, [{ chainId: old.chainId, projectId: old.project.id }]);
  assert.equal(await db.taskActivity.count({ where: {
    taskId: old.task.id,
    metadata: { path: ["state"], equals: "released" },
  } }), 1);
  assert.equal(await db.taskActivity.count({ where: {
    taskId: claimed.task.id,
    metadata: { path: ["state"], equals: "released" },
  } }), 0);
});

test("a malformed handoff is durably invalidated without blocking a valid batch sibling", async () => {
  const now = new Date();
  const valid = await seedChain();
  const malformed = await seedChain({ outputKind: "implementation" });
  const stale = new Date(now.getTime() - 180_000);
  const validRun = await seedRun(valid, { status: RunStatus.QUEUED, createdAt: stale, readyAt: stale });
  const malformedRun = await seedRun(malformed, { status: RunStatus.QUEUED, createdAt: stale, readyAt: stale });
  for (const [chain, run] of [[valid, validRun], [malformed, malformedRun]] as const) {
    await seedLeaseHandoff(chain, run.id, new Date(now.getTime() - 120_000));
  }

  assert.equal(await reconcileDatabaseRuns(db, now, collectRelease), 2);
  assert.deepEqual(releasedLeaseTargets, [{ chainId: valid.chainId, projectId: valid.project.id }]);
  const invalid = await db.taskActivity.findFirstOrThrow({ where: {
    taskId: malformed.task.id,
    metadata: { path: ["state"], equals: "invalid" },
  } });
  assert.match(invalid.body, /does not resolve to a Merge Lease holder/u);
  assert.equal((invalid.metadata as Record<string, unknown>).toRunId, malformedRun.id);
  assert.equal(await reconcileDatabaseRuns(db, new Date(now.getTime() + 1_000), collectRelease), 0);
});

test("runner claim reports post-commit reconciliation maintenance failure and still claims", async (t) => {
  const now = new Date();
  const chain = await seedChain();
  const stale = new Date(now.getTime() - 180_000);
  const run = await seedRun(chain, { status: RunStatus.QUEUED, createdAt: stale, readyAt: stale });
  await seedLeaseHandoff(chain, run.id, new Date(now.getTime() - 120_000));
  const failure = new Error("release helper unavailable after reconciliation commit");
  const reports: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { reports.push(args); });
  const priorRunnerToken = process.env.RUNNER_TOKEN;
  process.env.RUNNER_TOKEN = RUNNER;
  try {
    const response = await createApp(db, {
      releaseMergeLease: async () => { throw failure; },
    }).request("/runner/tasks/claim", {
      method: "POST",
      headers: { Authorization: `Bearer ${RUNNER}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runnerId: "claim-after-maintenance-failure", leaseSeconds: 60 }),
    });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    assert.equal((JSON.parse(responseText) as { run: { id: string } }).run.id, run.id);
  } finally {
    if (priorRunnerToken === undefined) delete process.env.RUNNER_TOKEN;
    else process.env.RUNNER_TOKEN = priorRunnerToken;
  }
  const report = reports.find(([message]) => message === "Runner claim reconciliation maintenance failed after commit");
  assert.ok(report, "the typed maintenance failure is reported at the claim boundary");
  const context = report[1] as {
    reconciledAt: string;
    failures: Array<{ target: { chainId: string; projectId: string }; phase: string; error: string }>;
  };
  assert.match(context.reconciledAt, /^\d{4}-/u);
  assert.deepEqual(context.failures, [{
    target: { chainId: chain.chainId, projectId: chain.project.id },
    phase: "release",
    error: failure.message,
  }]);
});

test("one hold-recording failure does not block other stranded lease releases or settlements", async () => {
  const now = new Date();
  const first = await seedChain();
  const second = await seedChain();
  const stale = new Date(now.getTime() - 180_000);
  const firstRun = await seedRun(first, { status: RunStatus.QUEUED, createdAt: stale, readyAt: stale });
  const secondRun = await seedRun(second, { status: RunStatus.QUEUED, createdAt: stale, readyAt: stale });
  for (const [chain, run] of [[first, firstRun], [second, secondRun]] as const) {
    await seedLeaseHandoff(chain, run.id, new Date(now.getTime() - 120_000));
  }
  const attempted: string[] = [];
  const recordingFailure = new Error("first project's hold marker failed");
  const releaseAll: ReleaseMergeLease = async (target, database) => {
    if (!target) return;
    attempted.push(target.projectId);
    if (target.projectId === first.project.id) throw recordingFailure;
    await collectRelease(target, database);
  };

  await assert.rejects(
    reconcileDatabaseRuns(db, now, releaseAll),
    (error: unknown) => error instanceof ReconciliationMaintenanceError
      && error.failures.some((failure) => failure.phase === "release" && failure.error === recordingFailure),
  );
  assert.deepEqual(new Set(attempted), new Set([first.project.id, second.project.id]));
  assert.equal(await db.taskActivity.count({ where: {
    taskId: first.task.id,
    metadata: { path: ["state"], equals: "released" },
  } }), 0, "a failed release remains pending for a later reconciliation");
  const settlement = await db.taskActivity.findFirstOrThrow({
    where: {
      taskId: second.task.id,
      metadata: { path: ["state"], equals: "released" },
    },
  });
  assert.equal((settlement.metadata as Record<string, unknown>).kind, MERGE_TAIL_KIND.leaseHandoff);
  assert.equal(await db.taskActivity.count({
    where: { taskId: first.task.id, metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseHold } },
  }), 0);
  await assertConfirmedHold(second.task.id);
});
