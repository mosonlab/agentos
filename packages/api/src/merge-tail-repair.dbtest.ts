import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { promisify } from "node:util";

import {
  AssigneeType,
  INTEGRATOR_TEMPLATE_NAME,
  legacyTemplateName,
  PrismaClient,
  TaskStatus,
  latestMarker,
  readMarkers,
} from "@anneal/db";

import { handleRegressionCompletion } from "./merge-tail-actions.js";
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
const REPAIRED = "d".repeat(40);
const exec = promisify(execFile);

let seedCounter = 0;

// A real chain reaches Regression with the brief, the acceptance criteria, and
// both review reports already persisted. The repair task is chain-detached, so
// these are the bodies it can only see if the repair prompt carries them.
const IMPLEMENTATION_BODY = "Feature brief: reject unregistered graphs at every entry point. Acceptance: the webhook and manual fire paths refuse them too.";
const SOL_FINDINGS_BODY = "sol-findings: MF-2 the HTTP layer validates but the webhook path calls the executor directly.";
const BLIND_FINDINGS_BODY = "blind-findings: the manual fire path repeats the same bypass and the board reads the retired field.";

type RegressionSeedOptions = { withLibrarian?: boolean; templateName?: string };

const seedRegression = async (options: RegressionSeedOptions = {}) => {
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
    projectId: project.id,
    name: options.templateName ?? (options.withLibrarian ? INTEGRATOR_TEMPLATE_NAME : "direct-engineer-workflow"),
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
  for (const prior of options.withLibrarian
    ? [
      { index: 4, name: "Implementation", kind: "implementation", body: IMPLEMENTATION_BODY },
      { index: 5, name: "Sol review", kind: "sol-findings", body: SOL_FINDINGS_BODY },
      { index: 6, name: "Blind review", kind: "blind-findings", body: BLIND_FINDINGS_BODY },
    ]
    : [
      { index: 0, name: "Implementation", kind: "implementation", body: IMPLEMENTATION_BODY },
      { index: 1, name: "Sol review", kind: "sol-findings", body: SOL_FINDINGS_BODY },
      { index: 2, name: "Blind review", kind: "blind-findings", body: BLIND_FINDINGS_BODY },
    ]) {
    const step = await db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id, stepIndex: prior.index, layer: prior.index, name: prior.name,
      assigneeType: AssigneeType.AGENT, assigneeAgentId: fixAgent.id, prompt: prior.name.toLowerCase(),
      approvalGate: false, outputKind: prior.kind,
    } });
    const priorTask = await db.task.create({ data: {
      projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: step.id,
      name: prior.name, description: prior.name, assigneeType: AssigneeType.AGENT, assigneeAgentId: fixAgent.id,
      status: TaskStatus.DONE, chainId, chainIndex: prior.index, chainLayer: prior.index, targetBranch: "main",
    } });
    const priorRun = await db.run.create({ data: {
      projectId: project.id, taskId: priorTask.id, agentId: fixAgent.id, repoId: repo.id,
      runNumber: 1, dedupeKey: `task:${priorTask.id}:run:1`, runner: "CODEX", model: fixAgent.model,
      promptHash: "hash", status: "SUCCEEDED", branch: BRANCH, pushedBranch: BRANCH,
      targetBranch: "main", headSha: HEAD,
    } });
    await db.taskStepOutput.create({ data: {
      taskId: priorTask.id, runId: priorRun.id, kind: prior.kind, body: prior.body, commitSha: HEAD,
    } });
  }
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

const verdict = (outcome: RegressionOutcome, headSha: string = HEAD) => JSON.stringify(outcome === "refresh-conflict"
  ? { schemaVersion: 1, outcome, headSha, baseHeadSha: BASE, summary: "merge conflict" }
  : outcome === "review-fail"
    ? { schemaVersion: 1, outcome, headSha, baseHeadSha: BASE, summary: "MF-2 remains open" }
    : { schemaVersion: 1, outcome, headSha, baseHeadSha: BASE, gateVerdict: "FAIL", summary: "suite failed" });

type RegressionOutcome = "refresh-conflict" | "review-fail" | "gate-fail";

const exercise = async (
  outcome: RegressionOutcome,
  options: RegressionSeedOptions & { branch?: string } = {},
) => {
  const seeded = await seedRegression(options);
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

/**
 * The next turn of the repair loop, as the tail actually runs it: the queued
 * Regression Run the last repair completion created publishes its own verdict,
 * bound to that Run and to the head the repair produced, and completes.
 *
 * Re-invoking the first completion would exercise the attempt counter without
 * exercising the loop it bounds.
 */
const failRegressionAgain = async (
  seeded: Awaited<ReturnType<typeof exercise>>,
  outcome: RegressionOutcome,
  runNumber: number,
  headSha: string,
) => {
  const run = await db.run.findFirstOrThrow({ where: { taskId: seeded.regression.id, runNumber } });
  await db.run.update({ where: { id: run.id }, data: {
    status: "SUCCEEDED", branch: BRANCH, pushedBranch: BRANCH, targetBranch: "main", headSha,
  } });
  const session = await db.session.create({ data: {
    runId: run.id, projectId: seeded.project.id, agentId: seeded.regressionAgent.id, taskId: seeded.regression.id,
    runner: "CODEX", executionStatus: "SUCCEEDED",
  } });
  await db.taskStepOutput.update({ where: { taskId: seeded.regression.id }, data: {
    runId: run.id, body: verdict(outcome, headSha), commitSha: headSha,
  } });
  return db.$transaction((tx) => handleRegressionCompletion(tx, {
    task: seeded.regression,
    run: { id: run.id, agentId: seeded.regressionAgent.id, branch: BRANCH, headSha, sessionId: session.id },
    now: new Date(),
  }));
};

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
  const result = latestMarker(await readMarkers(db, seeded.regression.id), "repairResult");
  assert.equal(result?.startHeadSha, HEAD);
  assert.equal(result?.resolvedHeadSha, RESOLVED);

  assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, seeded.input)), "handled");
  assert.equal(await repairCount(seeded), 1);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 0);
});

test("a gate FAIL is repaired twice and the third FAIL escalates with both heads in activity", async () => {
  const seeded = await exercise("gate-fail");
  const first = await repairFor(seeded, "gate-fix");
  assert.equal((await db.agent.findUniqueOrThrow({ where: { id: first.assigneeAgentId! } })).name, "senior-dev");
  await completeRepair(seeded, first.id, "Fixed the failing regression and reran the affected suite.", RESOLVED);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 2);
  // The first repair moved the tree, so this FAIL is a verdict on a different
  // head and buys one more automatic attempt rather than a stop.
  assert.equal(await failRegressionAgain(seeded, "gate-fail", 2, RESOLVED), "handled");
  assert.equal(await repairCount(seeded), 2);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 0);
  const second = await db.task.findFirstOrThrow({
    where: { projectId: seeded.project.id, name: "Autonomous merge tail: gate-fix" },
    orderBy: { createdAt: "desc" },
  });
  await completeRepair(seeded, second.id, "Fixed the remaining failure and reran the affected suite.", REPAIRED);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 3);
  assert.equal(await failRegressionAgain(seeded, "gate-fail", 3, REPAIRED), "handled");
  assert.equal(await repairCount(seeded), 2);
  const notice = await db.inboxMessage.findFirstOrThrow({ where: { taskId: seeded.regression.id } });
  assert.match(notice.body, /after 2 automatic repair attempts/u);
  const trail = await db.taskActivity.findMany({ where: { taskId: seeded.regression.id }, select: { body: true } });
  assert.match(trail.map(({ body }) => body).join("\n"), new RegExp(`${HEAD}.*${BASE}`, "s"));
});

test("a semantic FAIL skips the gate path and is repaired twice before it escalates", async () => {
  const seeded = await exercise("review-fail");
  const first = await repairFor(seeded, "review-fix");
  assert.equal((await db.agent.findUniqueOrThrow({ where: { id: first.assigneeAgentId! } })).name, "senior-dev");
  assert.match(first.description, /MF-2 remains open/u);
  await completeRepair(seeded, first.id, "Closed MF-2 and reran its focused regression.", RESOLVED);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 2);
  assert.equal(await failRegressionAgain(seeded, "review-fail", 2, RESOLVED), "handled");
  assert.equal(await repairCount(seeded), 2);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 0);
  const second = await db.task.findFirstOrThrow({
    where: { projectId: seeded.project.id, name: "Autonomous merge tail: review-fix" },
    orderBy: { createdAt: "desc" },
  });
  // The second repair carries the chain's context too, not only the first one.
  assert.ok(second.description.includes(SOL_FINDINGS_BODY));
  await completeRepair(seeded, second.id, "Closed the remaining finding and reran its focused regression.", REPAIRED);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 3);
  assert.equal(await failRegressionAgain(seeded, "review-fail", 3, REPAIRED), "handled");
  assert.equal(await repairCount(seeded), 2);
  const notice = await db.inboxMessage.findFirstOrThrow({ where: { taskId: seeded.regression.id } });
  assert.match(notice.body, /after 2 automatic repair attempts/u);
});

test("a repair task carries only the chain outputs its repair kind reads", async () => {
  for (const outcome of ["review-fail", "gate-fail", "refresh-conflict"] as const) {
    await resetTestDb(db);
    const seeded = await exercise(outcome);
    const repairKind = outcome === "review-fail" ? "review-fix" : outcome === "gate-fail" ? "gate-fix" : "refresh-conflict";
    const repair = await repairFor(seeded, repairKind);
    // Chain-detached by design: the claim path's prior-output lookup cannot
    // fire for this row, so the prompt is the only carrier.
    assert.equal(repair.chainId, null, outcome);
    assert.equal(repair.chainIndex, null, outcome);
    assert.match(repair.description, /Persisted outputs from prior template steps:/u, outcome);
    assert.ok(repair.description.includes(IMPLEMENTATION_BODY), outcome);
    if (repairKind === "review-fix") {
      // Only the repair that traces finding ids reads the review reports,
      // still in chain order.
      assert.ok(repair.description.includes(SOL_FINDINGS_BODY), outcome);
      assert.ok(repair.description.includes(BLIND_FINDINGS_BODY), outcome);
      assert.ok(
        repair.description.indexOf(IMPLEMENTATION_BODY) < repair.description.indexOf(SOL_FINDINGS_BODY),
        outcome,
      );
    } else {
      assert.ok(!repair.description.includes(SOL_FINDINGS_BODY), outcome);
      assert.ok(!repair.description.includes(BLIND_FINDINGS_BODY), outcome);
    }
    // Nothing from the Regression step that opened the repair.
    assert.ok(!repair.description.includes("regression-verification"), outcome);
  }
});

test("a review-fix prompt names the blast radius a summary-literal repair would miss", async () => {
  const seeded = await exercise("review-fail");
  const repair = await repairFor(seeded, "review-fix");
  assert.match(repair.description, /enumerate its callers across every workspace, including apps\/web/u);
  const conflict = await exercise("refresh-conflict");
  const resolver = await repairFor(conflict, "refresh-conflict");
  assert.doesNotMatch(resolver.description, /enumerate its callers/u);
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

test("repairs on every previously omitted legacy generation reopen the Librarian Step", async () => {
  for (const marker of [
    "pre-narrow-regression-lease",
    "pre-blind-review-retirement",
    "pre-regression-step-split",
  ]) {
    const seeded = await exercise("review-fail", {
      withLibrarian: true,
      templateName: legacyTemplateName(INTEGRATOR_TEMPLATE_NAME, marker, `template-${marker}`),
    });
    const repair = await repairFor(seeded, "review-fix");
    await completeRepair(seeded, repair.id, `Closed ${marker} findings.`);
    assert.ok(seeded.librarian, marker);
    assert.equal(
      (await db.task.findUniqueOrThrow({ where: { id: seeded.librarian.id } })).status,
      TaskStatus.TODO,
      marker,
    );
    assert.equal(await db.run.count({ where: { taskId: seeded.librarian.id } }), 1, marker);
    assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 1, marker);
  }
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

test("a repaired Regression retry pins a failed prior Run's published head without rewriting repair evidence", async () => {
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
  const retryBranch = "agentos/regression/retry-run-2";
  await db.run.update({
    where: { id: firstBody.run.id },
    data: {
      status: "FAILED",
      failureReason: "mechanical output handoff failed after the verdict was published",
      headSha: continuationHead,
      pushedBranch: retryBranch,
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

test("a completed repair permanently consumes its source Regression verdict", async () => {
  for (const outcome of ["refresh-conflict", "review-fail", "gate-fail"] as const) {
    const seeded = await exercise(outcome);
    const repair = await repairFor(
      seeded,
      outcome === "gate-fail" ? "gate-fix" : outcome === "review-fail" ? "review-fix" : outcome,
    );
    const output = outcome === "refresh-conflict"
      ? JSON.stringify({
        schemaVersion: 1,
        outcome: "resolved",
        startHeadSha: HEAD,
        targetHeadSha: BASE,
        resolvedHeadSha: RESOLVED,
        tradeOffs: [],
        changedTestExpectations: [],
      })
      : "fixed regression verdict";
    await completeRepair(seeded, repair.id, output);
    const before = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
    const noticesBefore = await db.inboxMessage.count({ where: { taskId: seeded.regression.id } });

    assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, seeded.input)), "handled", outcome);
    assert.equal(await repairCount(seeded), 1, `${outcome} opened a second repair from the same source Run`);
    const after = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
    assert.equal(after.status, before.status, outcome);
    assert.equal(after.failureReason, before.failureReason, outcome);
    assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), noticesBefore, outcome);
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
