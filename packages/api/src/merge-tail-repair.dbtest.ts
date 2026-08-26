import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { promisify } from "node:util";

import {
  AssigneeType,
  AUTHORITY_RESIGN_DEDUPE_PREFIX,
  AUTHORITY_RESIGN_OPEN_PREFIX,
  InboxStatus,
  MAX_AUTHORITY_RESIGN_ROUNDS,
  MERGE_TAIL_KIND,
  PrismaClient,
  TaskStatus,
} from "@agentos/db";

import { handleRegressionCompletion } from "./app.js";
import { authorityResignTick } from "./authority-resign-worker.js";
import type { GitHubReader, PullRequestSnapshot } from "./github-read.js";
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

let seedCounter = 0;

const seedRegression = async (options: { withLibrarian?: boolean } = {}) => {
  // A test may seed several chains in one millisecond, and both the slug and the
  // chain id have to stay distinct across them.
  const seedId = `${Date.now()}-${(seedCounter += 1)}`;
  const project = await db.project.create({ data: { name: "Repair", slug: `repair-${seedId}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const makeAgent = (name: string) => db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name, title: name,
    model: "gpt-5.6-sol:high", runnerPreference: "CODEX", foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const [regressionAgent, resolverAgent, fixAgent, reviewAgent, librarianAgent] = await Promise.all([
    makeAgent("review-coordinator-sol"), makeAgent("merge-resolver"), makeAgent("senior-dev"),
    makeAgent("review-coordinator"), makeAgent("librarian"),
  ]);
  const repo = await db.repo.create({ data: {
    projectId: project.id, name: "widgets", remoteUrl: "https://github.com/acme/widgets.git",
    mountPath: "/repo", defaultBranch: "main",
  } });
  for (const agent of [regressionAgent, resolverAgent, fixAgent, reviewAgent, librarianAgent]) {
    await db.agentRepoAccess.create({ data: {
      projectId: project.id, agentId: agent.id, repoId: repo.id, mountPath: "/repo", permissions: "GIT_WRITE",
    } });
  }
  const template = await db.taskTemplate.create({ data: {
    projectId: project.id, name: options.withLibrarian ? "compound-engineer-workflow" : "direct-engineer-workflow",
    description: "tail", variables: [],
  } });
  const fixIndex = options.withLibrarian ? 8 : 4;
  const fixLayer = options.withLibrarian ? 7 : 3;
  const librarianIndex = 9;
  const librarianLayer = 8;
  const regressionIndex = options.withLibrarian ? 10 : 5;
  const regressionLayer = options.withLibrarian ? 9 : 4;
  const readinessIndex = options.withLibrarian ? 11 : 6;
  const readinessLayer = options.withLibrarian ? 10 : 5;
  const [fixStep, regressionStep, readinessStep, librarianStep] = await Promise.all([
    db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id, stepIndex: fixIndex, layer: fixLayer, name: "Fix", assigneeType: AssigneeType.AGENT,
      assigneeAgentId: fixAgent.id, prompt: "fix", approvalGate: false, outputKind: "fixed-implementation",
    } }),
    db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id, stepIndex: regressionIndex, layer: regressionLayer, name: "Regression", assigneeType: AssigneeType.AGENT,
      assigneeAgentId: regressionAgent.id, prompt: "verify", approvalGate: false, outputKind: "regression-verification",
    } }),
    db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id, stepIndex: readinessIndex, layer: readinessLayer, name: "Readiness", assigneeType: AssigneeType.AGENT,
      assigneeAgentId: reviewAgent.id, prompt: "authorize", approvalGate: false, outputKind: "merge-authorization",
    } }),
    options.withLibrarian ? db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id, stepIndex: librarianIndex, layer: librarianLayer, name: "Librarian", assigneeType: AssigneeType.AGENT,
      assigneeAgentId: librarianAgent.id, prompt: "document", approvalGate: false, outputKind: "documentation",
    } }) : null,
  ]);
  const chainId = `chain-${seedId}`;
  const fix = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: fixStep.id,
    name: "Fix", description: "fix", assigneeType: AssigneeType.AGENT, assigneeAgentId: fixAgent.id,
    status: TaskStatus.DONE, chainId, chainIndex: fixIndex, chainLayer: fixLayer, targetBranch: "main",
  } });
  const librarian = librarianStep ? await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: librarianStep.id,
    name: "Librarian", description: "document", assigneeType: AssigneeType.AGENT, assigneeAgentId: librarianAgent.id,
    status: TaskStatus.DONE, chainId, chainIndex: librarianIndex, chainLayer: librarianLayer, targetBranch: "main",
  } }) : null;
  const regression = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: regressionStep.id,
    name: "Regression", description: "verify", assigneeType: AssigneeType.AGENT, assigneeAgentId: regressionAgent.id,
    status: TaskStatus.DOING, chainId, chainIndex: regressionIndex, chainLayer: regressionLayer, targetBranch: "main",
  } });
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
  return { project, template, repo, regressionAgent, reviewAgent, readinessStep, regression, librarian, fix, run, session };
};

const RESIGN_SUMMARY = "added packages/db/prisma/migrations/20260826000000_probe/migration.sql";

const verdict = (outcome: RegressionOutcome) => JSON.stringify(outcome === "refresh-conflict"
  ? { schemaVersion: 1, outcome, headSha: HEAD, baseHeadSha: BASE, summary: "merge conflict" }
  : outcome === "review-fail"
    ? { schemaVersion: 1, outcome, headSha: HEAD, baseHeadSha: BASE, summary: "MF-2 remains open" }
    : outcome === "authority-resign"
      ? { schemaVersion: 1, outcome, headSha: HEAD, baseHeadSha: BASE, summary: RESIGN_SUMMARY }
      : { schemaVersion: 1, outcome, headSha: HEAD, baseHeadSha: BASE, gateVerdict: "FAIL", summary: "suite failed" });

type RegressionOutcome = "refresh-conflict" | "review-fail" | "gate-fail" | "authority-resign";

const exercise = async (
  outcome: RegressionOutcome,
  options: { withLibrarian?: boolean; priorResignRounds?: number; branch?: string } = {},
) => {
  const seeded = await seedRegression(options);
  // Rounds are counted from the notices themselves, so a prior round is seeded
  // as the notice it was, dedupe key and all.
  for (let round = 1; round <= (options.priorResignRounds ?? 0); round += 1) {
    await db.inboxMessage.create({ data: {
      from: "AGENT",
      agentId: seeded.regressionAgent.id,
      taskId: seeded.regression.id,
      kind: "TEXT",
      body: `Release authority re-signature requested (round ${round})`,
      dedupeKey: `${AUTHORITY_RESIGN_DEDUPE_PREFIX}${seeded.regression.id}:${"e".repeat(39)}${round}`,
    } });
  }
  await db.taskStepOutput.create({ data: {
    taskId: seeded.regression.id, runId: seeded.run.id, kind: "regression-verification",
    body: verdict(outcome), commitSha: HEAD,
  } });
  const input = {
    task: seeded.regression,
    run: {
      id: seeded.run.id, agentId: seeded.regressionAgent.id,
      branch: options.branch ?? BRANCH, headSha: HEAD, sessionId: seeded.session.id,
    },
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
  seeded: Awaited<ReturnType<typeof seedRegression>>,
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
        cleanupStatus: "SUCCEEDED", branch: BRANCH, pushedBranch: BRANCH,
        pushStatus: "SUCCEEDED", headSha,
      }),
    });
    assert.equal(response.status, 200, await response.text());
  } finally {
    if (prior === undefined) delete process.env.RUNNER_TOKEN;
    else process.env.RUNNER_TOKEN = prior;
  }
};

const claimNext = async () => {
  const prior = process.env.RUNNER_TOKEN;
  process.env.RUNNER_TOKEN = "merge-tail-claim-token";
  try {
    const response = await createApp(db).request("/runner/tasks/claim", {
      method: "POST",
      headers: { Authorization: "Bearer merge-tail-claim-token", "Content-Type": "application/json" },
      body: JSON.stringify({ runnerId: "merge-tail-claim-runner", leaseSeconds: 60 }),
    });
    return { status: response.status, body: response.status === 200 ? await response.json() : null };
  } finally {
    if (prior === undefined) delete process.env.RUNNER_TOKEN;
    else process.env.RUNNER_TOKEN = prior;
  }
};

test("successful auxiliary repair completion preserves success when its chain target or target assignee is archived", async () => {
  for (const mode of ["task", "assignee"] as const) {
    await resetTestDb(db);
    const seeded = await exercise("gate-fail");
    const repair = await repairFor(seeded, "gate-fix");
    if (mode === "task") {
      await db.task.update({ where: { id: seeded.regression.id }, data: { archivedAt: new Date() } });
    } else {
      await db.task.update({ where: { id: seeded.regression.id }, data: { status: TaskStatus.BACKLOG } });
      await db.agent.update({ where: { id: seeded.regressionAgent.id }, data: { archivedAt: new Date() } });
      await db.task.update({ where: { id: seeded.regression.id }, data: { status: TaskStatus.TODO } });
    }

    await completeRepair(seeded, repair.id, "repair completed", HEAD);
    const completedRun = await db.run.findFirstOrThrow({ where: { taskId: repair.id }, orderBy: { runNumber: "desc" } });
    assert.equal(completedRun.status, "SUCCEEDED", mode);
    assert.equal(await db.run.count({ where: { taskId: seeded.regression.id, status: "QUEUED" } }), 0, mode);
    const target = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
    if (mode === "assignee") {
      assert.equal(target.status, TaskStatus.REVIEW);
      assert.match(target.failureReason ?? "", /archived/u);
    }
    assert.equal(await db.taskActivity.count({
      where: { taskId: seeded.regression.id, body: { contains: mode === "task" ? "target is archived" : "assignee" } },
    }), 1, mode);
  }
});

const BLOCKING_FINDING = {
  severity: "blocking",
  title: "defense-list change lacks a fail-closed regression",
  detail: "the new merge-tail branch has no test that fails when it regresses",
  reachability: "every merge that touches the defense list reaches it",
};
const FOLLOW_UP_FINDING = {
  severity: "follow-up",
  title: "comment names a field no caller reads",
  detail: "the doc comment above the parser describes a retired shape",
};
const blockingSummary = `${BLOCKING_FINDING.title}: ${BLOCKING_FINDING.detail}`;

const rejectIndependentReviewAfterPass = async (
  seeded: Awaited<ReturnType<typeof seedRegression>>,
  findings: unknown[] = [BLOCKING_FINDING],
  priorBlockingRounds = 0,
  beforeCompletion: (input: { readinessId: string; reviewTaskId: string; reviewRunId: string }) => Promise<void> = async () => {},
) => {
  const pass = JSON.stringify({
    schemaVersion: 1, outcome: "pass", headSha: HEAD, baseHeadSha: BASE, gateVerdict: "PASS",
  });
  await db.taskStepOutput.create({ data: {
    taskId: seeded.regression.id,
    runId: seeded.run.id,
    kind: "regression-verification",
    body: pass,
    commitSha: HEAD,
  } });
  await db.task.update({ where: { id: seeded.regression.id }, data: { status: TaskStatus.DONE } });
  const readiness = await db.task.create({ data: {
    projectId: seeded.project.id,
    repoId: seeded.repo.id,
    templateId: seeded.template.id,
    templateStepId: seeded.readinessStep.id,
    name: "Readiness",
    description: "authorize",
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: seeded.reviewAgent.id,
    status: TaskStatus.REVIEW,
    failureReason: "independent-review-open:pending",
    chainId: seeded.regression.chainId,
    chainIndex: seeded.readinessStep.stepIndex,
    chainLayer: seeded.readinessStep.layer,
    targetBranch: "main",
  } });
  const review = await db.task.create({ data: {
    projectId: seeded.project.id,
    repoId: seeded.repo.id,
    name: "Autonomous merge tail: independent review",
    description: "review exact head",
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: seeded.reviewAgent.id,
    status: TaskStatus.DOING,
    targetBranch: BRANCH,
    opensPullRequest: false,
    maxSessionsPerTask: 1,
  } });
  const runnerId = "independent-review-runner";
  const fencingToken = `review:${review.id}:1`;
  const reviewRun = await db.run.create({ data: {
    projectId: seeded.project.id,
    taskId: review.id,
    agentId: seeded.reviewAgent.id,
    repoId: seeded.repo.id,
    runNumber: 1,
    dedupeKey: `task:${review.id}:run:1`,
    runner: "CODEX",
    model: seeded.reviewAgent.model,
    promptHash: "review",
    status: "RUNNING",
    runnerId,
    fencingToken,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    branch: BRANCH,
    targetBranch: BRANCH,
  } });
  await db.session.create({ data: {
    runId: reviewRun.id,
    projectId: seeded.project.id,
    agentId: seeded.reviewAgent.id,
    taskId: review.id,
    runner: "CODEX",
    executionStatus: "RUNNING",
  } });
  const outputBody = JSON.stringify({ schemaVersion: 1, headSha: HEAD, findings });
  await db.taskStepOutput.create({ data: {
    taskId: review.id,
    runId: reviewRun.id,
    kind: "result",
    body: outputBody,
    commitSha: HEAD,
  } });
  await db.taskActivity.createMany({ data: [
    {
      taskId: readiness.id,
      actorType: "control-plane",
      body: `Independent review obligation opened for ${HEAD}`,
      metadata: {
        kind: "mergeTail.reviewObligation", schemaVersion: 1, state: "open",
        reviewTaskId: review.id, headSha: HEAD, baseSha: BASE,
      },
    },
    {
      taskId: review.id,
      actorType: "control-plane",
      body: `Blind review obligation for readiness task ${readiness.id}`,
      metadata: {
        kind: "mergeTail.reviewObligation", schemaVersion: 1, state: "open",
        readinessTaskId: readiness.id, regressionTaskId: seeded.regression.id,
        headSha: HEAD, baseSha: BASE,
      },
    },
  ] });
  if (priorBlockingRounds > 0) await db.taskActivity.createMany({ data:
    Array.from({ length: priorBlockingRounds }, (_unused, index) => ({
      taskId: readiness.id,
      actorType: "control-plane",
      body: `Independent review rejected exact head ${HEAD} on blocking round ${String(index + 1)}`,
      metadata: {
        kind: "mergeTail.reviewObligation", schemaVersion: 1, state: "rejected",
        headSha: HEAD, baseSha: BASE, summary: blockingSummary, blockingRound: index + 1,
      },
    })) });
  await beforeCompletion({ readinessId: readiness.id, reviewTaskId: review.id, reviewRunId: reviewRun.id });
  const prior = process.env.RUNNER_TOKEN;
  process.env.RUNNER_TOKEN = "merge-tail-review-token";
  try {
    const response = await createApp(db).request(`/runner/runs/${reviewRun.id}/complete`, {
      method: "POST",
      headers: { Authorization: "Bearer merge-tail-review-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId,
        fencingToken,
        exitCode: 0,
        signal: null,
        terminalEventSeen: true,
        terminalSuccess: true,
        cleanupStatus: "SUCCEEDED",
        branch: BRANCH,
        pushStatus: "NOT_REQUESTED",
        headSha: HEAD,
        workspaceRetained: false,
      }),
    });
    assert.equal(response.status, 200, await response.text());
  } finally {
    if (prior === undefined) delete process.env.RUNNER_TOKEN;
    else process.env.RUNNER_TOKEN = prior;
  }
  return { readiness, review, summary: blockingSummary, outputBody };
};

test("a refresh conflict creates exactly one resolver and its completion re-runs regression", async () => {
  const seeded = await exercise("refresh-conflict");
  const repair = await repairFor(seeded, "refresh-conflict");
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
  assert.equal((await db.agent.findUniqueOrThrow({ where: { id: repair.assigneeAgentId! } })).name, "senior-dev");
  assert.match(repair.description, /MF-2 remains open/u);
  await completeRepair(seeded, repair.id, "Closed MF-2 and reran its focused regression.");
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 2);
  assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, seeded.input)), "handled");
  assert.equal(await repairCount(seeded), 1);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 1);
});

test("a Full Assurance repair revalidates documentation before Regression", async () => {
  const seeded = await exercise("review-fail", { withLibrarian: true });
  const repair = await repairFor(seeded, "review-fix");
  await completeRepair(seeded, repair.id, "Closed MF-2 and reran its focused regression.");
  assert.ok(seeded.librarian);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.librarian.id } })).status, TaskStatus.TODO);
  assert.equal(await db.run.count({ where: { taskId: seeded.librarian.id } }), 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } })).status, TaskStatus.REVIEW);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 1);
});

test("invalid Regression output opens a stop notice with no unusable operator choices", async () => {
  const seeded = await seedRegression();
  assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, {
    task: seeded.regression,
    run: { id: seeded.run.id, agentId: seeded.regressionAgent.id, branch: BRANCH, headSha: HEAD, sessionId: seeded.session.id },
    now: new Date(),
  })), "handled");
  const card = await db.inboxMessage.findFirstOrThrow({ where: { taskId: seeded.regression.id } });
  assert.equal(card.kind, "TEXT");
  assert.equal(card.choices, null);
  assert.match(card.dedupeKey ?? "", /^merge-tail-stop:/u);
});

test("a fresh Regression claim carries the prior verdict and exact published repair without resuming context", async () => {
  const seeded = await exercise("review-fail");
  const repair = await repairFor(seeded, "review-fix");
  const repairOutput = "Closed MF-2 and reran its focused regression.";
  await completeRepair(seeded, repair.id, repairOutput);
  const run2 = await db.run.findFirstOrThrow({ where: { taskId: seeded.regression.id, runNumber: 2 } });

  const claimed = await claimNext();
  assert.equal(claimed.status, 200);
  const body = claimed.body as {
    run: { id: string };
    resume: unknown;
    regressionRepairHandoff: {
      trigger: { kind: string; verdict: { outcome: string; headSha: string; baseHeadSha: string; summary: string } };
      repair: { kind: string; taskId: string; startHeadSha: string; targetHeadSha: string; resolvedHeadSha: string; outputBody: string };
    };
  };
  assert.equal(body.run.id, run2.id);
  assert.equal(body.resume, null);
  assert.deepEqual(body.regressionRepairHandoff.trigger, {
    kind: "regression-verdict",
    verdict: { schemaVersion: 1, outcome: "review-fail", headSha: HEAD, baseHeadSha: BASE, summary: "MF-2 remains open" },
  });
  assert.deepEqual(body.regressionRepairHandoff.repair, {
    kind: "review-fix", taskId: repair.id, startHeadSha: HEAD, targetHeadSha: BASE,
    resolvedHeadSha: RESOLVED, outputKind: "result", outputBody: repairOutput,
  });
});

test("a repaired Regression retry pins the prior same-task published head without rewriting repair evidence", async () => {
  const seeded = await exercise("review-fail");
  const repair = await repairFor(seeded, "review-fix");
  await completeRepair(seeded, repair.id, "Closed MF-2 and reran its focused regression.");
  const firstClaim = await claimNext();
  assert.equal(firstClaim.status, 200);
  const firstBody = firstClaim.body as {
    run: { id: string };
    regressionRepairHandoff: { retry?: unknown };
  };
  assert.equal(firstBody.regressionRepairHandoff.retry, undefined);

  const continuationHead = "d".repeat(40);
  await db.run.update({
    where: { id: firstBody.run.id },
    data: {
      status: "SUCCEEDED",
      headSha: continuationHead,
      pushedBranch: BRANCH,
      pushStatus: "SUCCEEDED",
      endedAt: new Date(),
    },
  });
  await db.task.update({
    where: { id: seeded.regression.id },
    data: { status: TaskStatus.REVIEW, failureReason: "gate formed no verdict" },
  });

  const priorOperator = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "merge-tail-operator-token";
  try {
    const retried = await createApp(db).request(`/tasks/${seeded.regression.id}/retry`, {
      method: "POST",
      headers: { Authorization: "Bearer merge-tail-operator-token" },
    });
    assert.equal(retried.status, 201, await retried.text());
  } finally {
    if (priorOperator === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = priorOperator;
  }

  const retryClaim = await claimNext();
  assert.equal(retryClaim.status, 200);
  const retryBody = retryClaim.body as {
    regressionRepairHandoff: {
      repair: { resolvedHeadSha: string };
      retry: { previousRunId: string; startHeadSha: string };
    };
  };
  assert.equal(retryBody.regressionRepairHandoff.repair.resolvedHeadSha, RESOLVED);
  assert.deepEqual(retryBody.regressionRepairHandoff.retry, {
    previousRunId: firstBody.run.id,
    startHeadSha: continuationHead,
  });
});

test("a blocking independent-review rejection repairs itself and hands the rejection to the fresh Regression", async () => {
  const seeded = await seedRegression();
  const rejected = await rejectIndependentReviewAfterPass(seeded);
  const repair = await db.task.findFirstOrThrow({ where: {
    projectId: seeded.project.id,
    name: "Autonomous merge tail: review-fix",
  } });
  assert.equal((await db.agent.findUniqueOrThrow({ where: { id: repair.assigneeAgentId! } })).name, "senior-dev");
  // The rejection is repaired, not asked about: no operator card is opened.
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id, kind: "MULTIPLE_CHOICE" } }), 0);
  const repairOutput = "Added the fail-closed regression and verified the defense-list path.";
  await completeRepair(seeded, repair.id, repairOutput);

  const claimed = await claimNext();
  assert.equal(claimed.status, 200);
  const body = claimed.body as {
    resume: unknown;
    regressionRepairHandoff: {
      trigger: {
        kind: string;
        verdict: { outcome: string; headSha: string; baseHeadSha: string };
        review: { taskId: string; headSha: string; baseHeadSha: string; summary: string; outputBody: string };
      };
      repair: { taskId: string; resolvedHeadSha: string; outputBody: string };
    };
  };
  assert.equal(body.resume, null);
  assert.deepEqual(body.regressionRepairHandoff.trigger, {
    kind: "independent-review-rejection",
    verdict: { schemaVersion: 1, outcome: "pass", headSha: HEAD, baseHeadSha: BASE, gateVerdict: "PASS" },
    review: {
      taskId: rejected.review.id,
      headSha: HEAD,
      baseHeadSha: BASE,
      summary: rejected.summary,
      outputKind: "result",
      outputBody: rejected.outputBody,
    },
  });
  assert.deepEqual(body.regressionRepairHandoff.repair, {
    kind: "review-fix",
    taskId: repair.id,
    startHeadSha: HEAD,
    targetHeadSha: BASE,
    resolvedHeadSha: RESOLVED,
    outputKind: "result",
    outputBody: repairOutput,
  });
});

test("follow-up findings alone become backlog cards and hand readiness back to the server worker", async () => {
  const seeded = await seedRegression();
  const accepted = await rejectIndependentReviewAfterPass(seeded, [FOLLOW_UP_FINDING, FOLLOW_UP_FINDING]);
  assert.equal(await db.task.count({ where: {
    projectId: seeded.project.id, name: "Autonomous merge tail: review-fix",
  } }), 0);
  const cards = await db.task.findMany({ where: {
    projectId: seeded.project.id, name: `Merge tail follow-up: ${FOLLOW_UP_FINDING.title}`,
  } });
  assert.equal(cards.length, 2);
  assert.deepEqual([...new Set(cards.map((card) => card.status))], [TaskStatus.BACKLOG]);
  const readiness = await db.task.findUniqueOrThrow({ where: { id: accepted.readiness.id } });
  assert.equal(readiness.status, TaskStatus.TODO);
  assert.equal(readiness.failureReason, null);
  const obligation = await db.taskActivity.findFirstOrThrow({ where: {
    taskId: accepted.readiness.id,
    metadata: { path: ["state"], equals: "accepted-with-followups" },
  } });
  assert.match(obligation.body, /accepted exact head/u);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 0);
});

test("an empty findings array approves the head and no follow-up card is created", async () => {
  const seeded = await seedRegression();
  const approved = await rejectIndependentReviewAfterPass(seeded, []);
  assert.equal(await db.task.count({ where: {
    projectId: seeded.project.id, name: { startsWith: "Merge tail follow-up:" },
  } }), 0);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: approved.readiness.id } })).status, TaskStatus.TODO);
  await db.taskActivity.findFirstOrThrow({ where: {
    taskId: approved.readiness.id,
    metadata: { path: ["state"], equals: "approved" },
  } });
});

test("the third blocking round stops the tail with a notice instead of a fourth repair", async () => {
  const seeded = await seedRegression();
  const stopped = await rejectIndependentReviewAfterPass(seeded, [BLOCKING_FINDING], 2);
  assert.equal(await db.task.count({ where: {
    projectId: seeded.project.id, name: "Autonomous merge tail: review-fix",
  } }), 0);
  const [readiness, regression] = await Promise.all([
    db.task.findUniqueOrThrow({ where: { id: stopped.readiness.id } }),
    db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } }),
  ]);
  assert.equal(readiness.status, TaskStatus.REVIEW);
  assert.equal(regression.status, TaskStatus.REVIEW);
  assert.match(readiness.failureReason ?? "", /blocking round 3 of 3; automatic repair is exhausted/u);
  const notice = await db.inboxMessage.findFirstOrThrow({ where: { taskId: seeded.regression.id } });
  assert.equal(notice.kind, "TEXT");
  assert.match(notice.body, /automatic repair is exhausted/u);
});

test("a second blocking round still repairs itself", async () => {
  const seeded = await seedRegression();
  await rejectIndependentReviewAfterPass(seeded, [BLOCKING_FINDING], 1);
  assert.equal(await db.task.count({ where: {
    projectId: seeded.project.id, name: "Autonomous merge tail: review-fix",
  } }), 1);
});

test("a decision left behind by an earlier review run is not evidence about this one", async () => {
  const seeded = await seedRegression();
  const stopped = await rejectIndependentReviewAfterPass(seeded, [], 0, async ({ reviewTaskId }) => {
    const other = await db.run.create({ data: {
      projectId: seeded.project.id, taskId: reviewTaskId, agentId: seeded.reviewAgent.id, repoId: seeded.repo.id,
      runNumber: 2, dedupeKey: `task:${reviewTaskId}:run:2`, runner: "CODEX", model: seeded.reviewAgent.model,
      promptHash: "stale", status: "FAILED",
    } });
    await db.taskStepOutput.update({ where: { taskId: reviewTaskId }, data: { runId: other.id } });
  });
  const readiness = await db.task.findUniqueOrThrow({ where: { id: stopped.readiness.id } });
  assert.equal(readiness.status, TaskStatus.REVIEW);
  assert.match(readiness.failureReason ?? "", /unusable decision/u);
  const notice = await db.inboxMessage.findFirstOrThrow({ where: { taskId: seeded.regression.id } });
  assert.equal(notice.kind, "TEXT");
});

test("a blocking rejection does not restart work an operator parked while the review ran", async () => {
  const seeded = await seedRegression();
  await rejectIndependentReviewAfterPass(seeded, [BLOCKING_FINDING], 0, async ({ readinessId }) => {
    await db.task.update({ where: { id: readinessId }, data: { status: TaskStatus.BACKLOG, failureReason: null } });
  });
  assert.equal(await db.task.count({ where: {
    projectId: seeded.project.id, name: "Autonomous merge tail: review-fix",
  } }), 0);
  const parked = await db.task.findFirstOrThrow({ where: { projectId: seeded.project.id, name: "Readiness" } });
  assert.equal(parked.status, TaskStatus.BACKLOG);
  assert.equal(parked.failureReason, null);
  await db.taskActivity.findFirstOrThrow({ where: {
    taskId: parked.id, metadata: { path: ["state"], equals: "repair-skipped" },
  } });
});

test("a stale repair output stops the queued Regression Run before a provider session starts", async () => {
  const seeded = await exercise("review-fail");
  const repair = await repairFor(seeded, "review-fix");
  await completeRepair(seeded, repair.id, "Closed MF-2.");
  await db.taskStepOutput.update({ where: { taskId: repair.id }, data: { commitSha: "d".repeat(40) } });
  const run2 = await db.run.findFirstOrThrow({ where: { taskId: seeded.regression.id, runNumber: 2 } });

  const claimed = await claimNext();
  assert.equal(claimed.status, 204);
  const stopped = await db.run.findUniqueOrThrow({ where: { id: run2.id } });
  assert.equal(stopped.status, "FAILED");
  assert.match(stopped.failureReason ?? "", /output and Run do not bind resolved head/u);
  const task = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
  assert.equal(task.status, TaskStatus.REVIEW);
  assert.equal(await db.session.count({ where: { runId: run2.id } }), 0);
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

test("an authority re-signature request parks the step and opens one runnable inbox message", async () => {
  const seeded = await exercise("authority-resign");

  const regression = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
  assert.equal(regression.status, TaskStatus.REVIEW);
  assert.equal(regression.failureReason, `${AUTHORITY_RESIGN_OPEN_PREFIX}${HEAD}`);
  // No agent can close this, so no agent is asked to.
  assert.equal(await repairCount(seeded), 0);

  const messages = await db.inboxMessage.findMany({ where: { taskId: seeded.regression.id } });
  assert.equal(messages.length, 1);
  const message = messages[0]!;
  assert.equal(message.kind, "TEXT");
  assert.equal(message.status, InboxStatus.OPEN);
  assert.equal(message.dedupeKey, `${AUTHORITY_RESIGN_DEDUPE_PREFIX}${seeded.regression.id}:${HEAD}`);
  for (const fragment of [
    RESIGN_SUMMARY,
    `git switch --detach '${HEAD}'`,
    "npm run snapshot:authority",
    "npm run db:authority-check -w @agentos/db",
    `git push origin 'HEAD:${BRANCH}'`,
    "release-authority.json",
  ]) assert.ok(message.body.includes(fragment), `${fragment} is missing from the inbox message`);
  // The one-liner must be runnable, so nothing in it may be a placeholder.
  assert.equal(/<[a-z-]+>/u.test(message.body), false, message.body);

  const opened = await db.taskActivity.findMany({ where: { taskId: seeded.regression.id } });
  const request = opened.map((row) => row.metadata as Record<string, unknown> | null)
    .filter((metadata) => metadata?.kind === MERGE_TAIL_KIND.authorityResign && metadata.state === "open");
  assert.equal(request.length, 1);
  assert.deepEqual(
    { headSha: request[0]!.headSha, branch: request[0]!.branch, round: request[0]!.round },
    { headSha: HEAD, branch: BRANCH, round: 1 },
  );
});

test("a re-signature request past the round ceiling stops the tail instead of asking again", async () => {
  const seeded = await exercise("authority-resign", { priorResignRounds: MAX_AUTHORITY_RESIGN_ROUNDS });

  const regression = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
  assert.equal(regression.status, TaskStatus.REVIEW);
  assert.equal(regression.failureReason?.startsWith(AUTHORITY_RESIGN_OPEN_PREFIX), false);
  assert.match(regression.failureReason ?? "", /re-signature round 4 exceeds 3/u);
  const notices = await db.inboxMessage.findMany({ where: { taskId: seeded.regression.id } });
  // The three prior rounds and one stop notice: no fourth request was written.
  assert.equal(notices.length, MAX_AUTHORITY_RESIGN_ROUNDS + 1);
  assert.equal(notices.filter((notice) => /Autonomous merge tail stopped/u.test(notice.body)).length, 1);
  assert.equal(notices.filter((notice) => /must be re-signed/u.test(notice.body)).length, 0);
});

test("a repair completion does not restart a step parked for a re-signature", async () => {
  const seeded = await exercise("gate-fail");
  const repair = await repairFor(seeded, "gate-fix");
  await db.task.update({ where: { id: seeded.regression.id }, data: {
    status: TaskStatus.REVIEW, failureReason: `${AUTHORITY_RESIGN_OPEN_PREFIX}${HEAD}`,
  } });

  await completeRepair(seeded, repair.id, "repair completed", HEAD);

  const regression = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
  assert.equal(regression.status, TaskStatus.REVIEW);
  assert.equal(regression.failureReason, `${AUTHORITY_RESIGN_OPEN_PREFIX}${HEAD}`);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id, status: "QUEUED" } }), 0);
  assert.equal(await db.taskActivity.count({
    where: { taskId: seeded.regression.id, body: { contains: "held by an open release authority re-signature" } },
  }), 1);
});

const PR_NUMBER = 41;
const RESIGNED = "d".repeat(40);

type ResignReader = GitHubReader & { comparisons: Array<{ base: string; head: string }> };

const resignReader = (
  headRefOid: string,
  filenames: string[],
  status: "ahead" | "behind" | "diverged" | "identical" = "ahead",
): ResignReader => {
  const pullRequest: PullRequestSnapshot = {
    repository: "acme/widgets",
    number: PR_NUMBER,
    state: "OPEN",
    isDraft: false,
    merged: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    baseRefName: "main",
    headRefOid,
    baseSha: BASE,
    autoMergeRequest: null,
    mergeQueueEntry: null,
    repositoryMergeQueue: null,
    mergedBy: null,
    mergeCommit: null,
    requiredCheckNames: [],
    checkContexts: [],
    headCommitOid: headRefOid,
    readAt: new Date().toISOString(),
  };
  const comparisons: Array<{ base: string; head: string }> = [];
  return {
    comparisons,
    readPullRequest: async () => pullRequest,
    compareCommits: async (_repository, base, head) => {
      comparisons.push({ base, head });
      return {
        status,
        behindBy: 0,
        filesComplete: true,
        files: filenames.map((filename) => ({ filename, previousFilename: null, patch: null })),
      };
    },
  };
};

const parkedForResign = async () => {
  const seeded = await exercise("authority-resign");
  await db.run.update({
    where: { id: seeded.run.id },
    data: {
      pullRequestNumber: PR_NUMBER,
      pullRequestUrl: `https://github.com/acme/widgets/pull/${PR_NUMBER}`,
    },
  });
  return seeded;
};

test("the resign worker returns the step once the re-signed attestation is on the branch", async () => {
  const seeded = await parkedForResign();

  const result = await authorityResignTick(db, resignReader(RESIGNED, ["release-authority.json", "packages/db/prisma/migrations/20260826000000_probe/migration.sql"]));

  assert.deepEqual(result, { resumed: 1, waiting: 0, unwatchable: 0 });
  const regression = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
  assert.equal(regression.status, TaskStatus.TODO);
  assert.equal(regression.failureReason, null);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id, status: "QUEUED" } }), 1);
  const resumedActivity = (await db.taskActivity.findMany({ where: { taskId: seeded.regression.id } }))
    .map((row) => row.metadata as Record<string, unknown> | null)
    .filter((metadata) => metadata?.kind === MERGE_TAIL_KIND.authorityResign && metadata.state === "resumed");
  assert.equal(resumedActivity.length, 1);
  assert.equal(resumedActivity[0]!.headSha, RESIGNED);
  const message = await db.inboxMessage.findFirstOrThrow({ where: { taskId: seeded.regression.id } });
  assert.equal(message.status, InboxStatus.CLOSED);
});

test("a push that does not carry the attestation leaves the park exactly as it was", async () => {
  const seeded = await parkedForResign();

  const result = await authorityResignTick(db, resignReader(RESIGNED, ["packages/api/src/app.ts"]));

  assert.deepEqual(result, { resumed: 0, waiting: 1, unwatchable: 0 });
  const regression = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
  assert.equal(regression.status, TaskStatus.REVIEW);
  assert.equal(regression.failureReason, `${AUTHORITY_RESIGN_OPEN_PREFIX}${HEAD}`);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id, status: "QUEUED" } }), 0);
  const message = await db.inboxMessage.findFirstOrThrow({ where: { taskId: seeded.regression.id } });
  assert.equal(message.status, InboxStatus.OPEN);
});

test("the head that was parked is never mistaken for the re-signed one", async () => {
  await parkedForResign();

  // The attestation is in the range because the branch has always carried one;
  // only a head that actually moved can be the operator's signature.
  const result = await authorityResignTick(db, resignReader(HEAD, ["release-authority.json"]));

  assert.deepEqual(result, { resumed: 0, waiting: 1, unwatchable: 0 });
});

test("the re-signature is looked for after the parked head, not after the pull request base", async () => {
  await parkedForResign();
  const reader = resignReader(RESIGNED, ["release-authority.json"]);

  assert.deepEqual(await authorityResignTick(db, reader), { resumed: 1, waiting: 0, unwatchable: 0 });
  // A base-anchored comparison would also match a re-signature from an earlier
  // round, and would resume a step whose own migration is still unattested.
  assert.deepEqual(reader.comparisons, [{ base: HEAD, head: RESIGNED }]);
});

test("a branch that no longer descends from the parked head is not read as a re-signature", async () => {
  const seeded = await parkedForResign();

  const result = await authorityResignTick(db, resignReader(RESIGNED, ["release-authority.json"], "diverged"));

  assert.deepEqual(result, { resumed: 0, waiting: 1, unwatchable: 0 });
  const regression = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
  assert.equal(regression.failureReason, `${AUTHORITY_RESIGN_OPEN_PREFIX}${HEAD}`);
});

test("every park is scanned, not just the oldest few", async () => {
  const parks = [];
  for (let index = 0; index < 6; index += 1) parks.push(await parkedForResign());

  const result = await authorityResignTick(db, resignReader(RESIGNED, ["release-authority.json"]));

  assert.deepEqual(result, { resumed: 6, waiting: 0, unwatchable: 0 });
  for (const seeded of parks) {
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } })).status, TaskStatus.TODO);
  }
});

test("a hostile branch name cannot escape the shell command the operator is asked to run", async () => {
  const branch = "feat/'; rm -rf $HOME #";
  const seeded = await exercise("authority-resign", { branch });

  const message = await db.inboxMessage.findFirstOrThrow({ where: { taskId: seeded.regression.id } });
  assert.ok(message.body.includes(`git fetch origin 'feat/'\\''; rm -rf $HOME #'`), message.body);
  assert.ok(message.body.includes(`git push origin 'HEAD:feat/'\\''; rm -rf $HOME #'`), message.body);
  // Every argument is one single-quoted word, with the branch's own quote escaped.
  assert.ok(message.body.includes(`git commit -m 'chore(release): re-sign the release authority for feat/'\\''; rm -rf $HOME #'`), message.body);
});

test("a step that is no longer the tail's to park is reported instead of overwritten", async () => {
  const seeded = await seedRegression();
  await db.taskStepOutput.create({ data: {
    taskId: seeded.regression.id, runId: seeded.run.id, kind: "regression-verification",
    body: verdict("authority-resign"), commitSha: HEAD,
  } });
  // An operator took the step over between the run finishing and this handler
  // reaching the row.
  await db.task.update({ where: { id: seeded.regression.id }, data: {
    status: TaskStatus.REVIEW, failureReason: "operator holds this step",
  } });

  assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, {
    task: seeded.regression,
    run: { id: seeded.run.id, agentId: seeded.regressionAgent.id, branch: BRANCH, headSha: HEAD, sessionId: seeded.session.id },
    now: new Date(),
  })), "handled");

  const regression = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
  assert.equal(regression.failureReason, "operator holds this step");
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 0);
  assert.equal(await db.taskActivity.count({
    where: { taskId: seeded.regression.id, metadata: { path: ["state"], equals: "park-skipped" } },
  }), 1);
});

test("a park whose pull request cannot be resolved is reported, not resumed and not lost", async () => {
  const seeded = await exercise("authority-resign");

  const result = await authorityResignTick(db, resignReader(RESIGNED, ["release-authority.json"]));

  assert.deepEqual(result, { resumed: 0, waiting: 0, unwatchable: 1 });
  const regression = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
  assert.equal(regression.failureReason, `${AUTHORITY_RESIGN_OPEN_PREFIX}${HEAD}`);
});
