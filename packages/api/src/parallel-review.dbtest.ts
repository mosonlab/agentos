import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  DIRECT_TEMPLATE_NAME,
  enqueueTaskRun,
  INTEGRATOR_TEMPLATE_NAME,
  PrismaClient,
  RepoPermission,
  RunStatus,
  TaskStatus,
} from "@agentos/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";
import { instantiateTemplate } from "./templates.js";

const execFileAsync = promisify(execFile);
const DB_DIRECTORY = fileURLToPath(new URL("../../db", import.meta.url));
const RUNNER_TOKEN = "parallel-review-runner-token";
const OPERATOR_TOKEN = "parallel-review-operator-token";
const IMPLEMENTATION_BASE = "1".repeat(40);
const IMPLEMENTATION_HEAD = "2".repeat(40);

type Claim = {
  task: {
    id: string;
    chainIndex: number | null;
    chainLayer: number | null;
  };
  run: {
    id: string;
    taskId: string;
    runNumber: number;
    branch: string | null;
    targetBranch: string | null;
    implementationBaseSha: string | null;
    implementationHeadSha: string | null;
    pinnedBaseSha: string | null;
  };
  fencingToken: string;
  sessionToken: string;
};

type CanonicalInstallation = {
  projectId: string;
  directTemplateId: string;
  fullTemplateId: string;
  repoId: string;
};

type DirectFixture = CanonicalInstallation & {
  chainId: string;
  branchName: string;
  implementationTaskId: string;
  solTaskId: string;
  blindTaskId: string;
  fixTaskId: string;
};

type FullFixture = CanonicalInstallation & {
  chainId: string;
  branchName: string;
  implementationTaskId: string;
  solTaskId: string;
  blindTaskId: string;
};

let db: PrismaClient;
const previousEnvironment = {
  runner: process.env.RUNNER_TOKEN,
  operator: process.env.OPERATOR_TOKEN,
};

before(() => {
  process.env.RUNNER_TOKEN = RUNNER_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR_TOKEN;
  db = setupTestDb();
});

beforeEach(async () => {
  await resetTestDb(db);
  await runDbScript("seed.ts");
  await runDbScript("sync-canonical-prompts.ts");
});

after(async () => {
  await db.$disconnect();
  if (previousEnvironment.runner === undefined) delete process.env.RUNNER_TOKEN;
  else process.env.RUNNER_TOKEN = previousEnvironment.runner;
  if (previousEnvironment.operator === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = previousEnvironment.operator;
});

const runDbScript = async (script: string): Promise<void> => {
  try {
    await execFileAsync(
      process.execPath,
      ["--import", "tsx", `prisma/${script}`],
      {
        cwd: DB_DIRECTORY,
        env: { ...process.env, DATABASE_URL: testDatabaseUrl },
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  } catch (error: unknown) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(`canonical ${script} failed\n${failure.stdout ?? ""}${failure.stderr ?? ""}${failure.message ?? ""}`);
  }
};

const request = async (
  path: string,
  method: "GET" | "POST" | "PATCH",
  token: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> => {
  const response = await createApp(db).request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
};

const runnerRequest = (path: string, body: Record<string, unknown>) => request(path, "POST", RUNNER_TOKEN, body);
const operatorRequest = (path: string, method: "POST" | "PATCH", body?: Record<string, unknown>) =>
  request(path, method, OPERATOR_TOKEN, body);

const seedRepoGrants = async (projectId: string): Promise<string> => {
  const repo = await db.repo.create({
    data: {
      projectId,
      name: "parallel-review-repo",
      remoteUrl: "https://example.test/parallel-review.git",
      mountPath: "/repo",
      defaultBranch: "main",
    },
  });
  const agents = await db.agent.findMany({ where: { projectId }, select: { id: true } });
  await db.agentRepoAccess.createMany({
    data: agents.map(({ id: agentId }) => ({
      projectId,
      agentId,
      repoId: repo.id,
      mountPath: "/repo",
      permissions: RepoPermission.GIT_WRITE,
    })),
  });
  return repo.id;
};

const canonicalInstallation = async (): Promise<CanonicalInstallation> => {
  const project = await db.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const [direct, full] = await Promise.all([
    db.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: DIRECT_TEMPLATE_NAME } },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    }),
    db.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: INTEGRATOR_TEMPLATE_NAME } },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    }),
  ]);
  assert.deepEqual(direct.steps.map((step) => step.layer), [1, 2, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(full.steps.map((step) => step.layer), [1, 2, 3, 4, 5, 6, 6, 7, 8, 9, 10, 11, 12]);
  return {
    projectId: project.id,
    directTemplateId: direct.id,
    fullTemplateId: full.id,
    repoId: await seedRepoGrants(project.id),
  };
};

const instantiateDirect = async (): Promise<DirectFixture> => {
  const installation = await canonicalInstallation();
  const branchName = `parallel/direct-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const chain = await instantiateTemplate(db, installation.projectId, installation.directTemplateId, {
    repoId: installation.repoId,
    variables: { branchName },
    autoStart: true,
  });
  const byIndex = new Map(chain.tasks.map((task) => [task.chainIndex, task]));
  return {
    ...installation,
    chainId: chain.chainId,
    branchName,
    implementationTaskId: byIndex.get(1)!.id,
    solTaskId: byIndex.get(2)!.id,
    blindTaskId: byIndex.get(3)!.id,
    fixTaskId: byIndex.get(4)!.id,
  };
};

/** Full Assurance has approval-gated planning nodes. This fixture completes
 * those already-reviewed nodes as historical evidence, then enters the real
 * implementation-to-parallel-review boundary through the runner API. */
const instantiateFullAtReviewFrontier = async (): Promise<FullFixture> => {
  const installation = await canonicalInstallation();
  const branchName = `parallel/full-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const chain = await instantiateTemplate(db, installation.projectId, installation.fullTemplateId, {
    repoId: installation.repoId,
    variables: { branchName },
    autoStart: false,
  });
  const byIndex = new Map(chain.tasks.map((task) => [task.chainIndex, task]));
  const priorIds = chain.tasks.filter((task) => (task.chainIndex ?? 0) < 5).map((task) => task.id);
  await db.task.updateMany({ where: { id: { in: priorIds } }, data: { status: TaskStatus.DONE } });
  const implementation = byIndex.get(5)!;
  await db.$transaction((tx) => enqueueTaskRun(tx, implementation.id));
  return {
    ...installation,
    chainId: chain.chainId,
    branchName,
    implementationTaskId: implementation.id,
    solTaskId: byIndex.get(6)!.id,
    blindTaskId: byIndex.get(7)!.id,
  };
};

const claim = async (runnerId: string): Promise<Claim> => {
  const result = await runnerRequest("/runner/tasks/claim", { runnerId, leaseSeconds: 120 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body as Claim;
};

const persistSessionOutput = async (
  claimed: Claim,
  kind: string,
  body: Record<string, unknown>,
  commitSha: string,
): Promise<void> => {
  const response = await createApp(db).request(`/session/runs/${claimed.run.id}/output`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${claimed.sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fencingToken: claimed.fencingToken,
      kind,
      body: JSON.stringify(body),
      commitSha,
    }),
  });
  const responseBody = await response.json();
  assert.equal(response.status, 200, JSON.stringify(responseBody));
};

const complete = async (
  claimed: Claim,
  runnerId: string,
  options: {
    outputKind?: string;
    output?: Record<string, unknown>;
    headSha?: string;
    baseSha?: string;
    branch?: string;
    failed?: boolean;
  } = {},
): Promise<{ status: number; body: unknown }> => {
  const headSha = options.headSha ?? IMPLEMENTATION_HEAD;
  if (options.output && options.outputKind) {
    await persistSessionOutput(claimed, options.outputKind, options.output, headSha);
  }
  return runnerRequest(`/runner/runs/${claimed.run.id}/complete`, {
    runnerId,
    fencingToken: claimed.fencingToken,
    exitCode: options.failed ? 1 : 0,
    terminalEventSeen: !options.failed,
    terminalSuccess: !options.failed,
    ...(options.failed ? {
      failureClass: "TASK_FAILED",
      retryable: false,
      failureReason: "parallel-review fixture failure",
    } : {}),
    branch: options.branch ?? claimed.run.branch ?? "parallel/review-head",
    pushedBranch: options.branch ?? claimed.run.branch ?? "parallel/review-head",
    baseSha: options.baseSha ?? IMPLEMENTATION_BASE,
    headSha: options.failed ? null : headSha,
    pushStatus: options.failed ? "FAILED" : "SUCCEEDED",
    cleanupStatus: "SUCCEEDED",
    workspaceRetained: false,
  });
};

const implementationOutput = (headSha = IMPLEMENTATION_HEAD) => ({
  schemaVersion: 1,
  headSha,
  baseSha: IMPLEMENTATION_BASE,
  summary: "parallel review integration fixture implementation",
  testsRun: ["npm test -- parallel review"],
});

const reviewOutput = (kind: "sol-findings" | "blind-findings") => ({
  schemaVersion: 1,
  headSha: IMPLEMENTATION_HEAD,
  reviewedBase: IMPLEMENTATION_BASE,
  reviewedHead: IMPLEMENTATION_HEAD,
  findings: [],
  ...(kind === "sol-findings" ? { commandsRun: ["git diff --check"] } : {}),
});

const completeImplementation = async (fixture: DirectFixture | FullFixture, runnerId = "implementation-runner"): Promise<Claim> => {
  const claimed = await claim(runnerId);
  assert.equal(claimed.run.taskId, fixture.implementationTaskId);
  assert.equal(claimed.run.implementationBaseSha, null);
  const result = await complete(claimed, runnerId, {
    outputKind: "implementation",
    output: implementationOutput(),
    baseSha: IMPLEMENTATION_BASE,
    branch: fixture.branchName,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return claimed;
};

const reviewClaims = async (
  fixture: DirectFixture | FullFixture,
  firstRunner = "sol-runner",
  secondRunner = "blind-runner",
) => {
  const first = await claim(firstRunner);
  const second = await claim(secondRunner);
  const reviewTasks = new Set([fixture.solTaskId, fixture.blindTaskId]);
  assert.ok(reviewTasks.has(first.run.taskId));
  assert.ok(reviewTasks.has(second.run.taskId));
  assert.notEqual(first.run.taskId, second.run.taskId);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: first.run.id } })).runnerId, firstRunner);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: second.run.id } })).runnerId, secondRunner);
  for (const claimed of [first, second]) {
    assert.equal(claimed.run.implementationBaseSha, IMPLEMENTATION_BASE);
    assert.equal(claimed.run.implementationHeadSha, IMPLEMENTATION_HEAD);
    assert.equal(claimed.run.pinnedBaseSha, IMPLEMENTATION_HEAD);
    assert.equal(claimed.run.targetBranch, IMPLEMENTATION_HEAD);
  }
  return { first, second };
};

const completeReview = async (claimed: Claim, runnerId: string, kind: "sol-findings" | "blind-findings") => {
  const result = await complete(claimed, runnerId, {
    outputKind: kind,
    output: reviewOutput(kind),
    headSha: IMPLEMENTATION_HEAD,
    baseSha: IMPLEMENTATION_BASE,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
};

const queuedRunsFor = (taskIds: string[]) => db.run.findMany({
  where: { taskId: { in: taskIds }, status: RunStatus.QUEUED },
  select: { id: true, taskId: true, runNumber: true },
});

test("Direct sync instantiates a parallel review frontier claimable by distinct runners with one pinned range", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture);

  const queued = await queuedRunsFor([fixture.solTaskId, fixture.blindTaskId]);
  assert.equal(queued.length, 2);
  const { first, second } = await reviewClaims(fixture);
  assert.notEqual(first.run.id, second.run.id);
  assert.deepEqual(new Set([first.task.chainLayer, second.task.chainLayer]), new Set([2]));
  assert.deepEqual(new Set([first.task.chainIndex, second.task.chainIndex]), new Set([2, 3]));
});

test("the HTTP join stays closed after the first review and creates one fix-step run after the second", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture);
  const { first, second } = await reviewClaims(fixture);
  const firstKind = first.run.taskId === fixture.solTaskId ? "sol-findings" : "blind-findings";
  const secondKind = second.run.taskId === fixture.solTaskId ? "sol-findings" : "blind-findings";

  await completeReview(first, first.run.taskId === fixture.solTaskId ? "sol-runner" : "blind-runner", firstKind);
  assert.equal(await db.run.count({ where: { taskId: fixture.fixTaskId } }), 0);
  await completeReview(second, second.run.taskId === fixture.solTaskId ? "sol-runner" : "blind-runner", secondKind);
  assert.equal(await db.run.count({ where: { taskId: fixture.fixTaskId } }), 1);
  assert.equal(await db.run.count({ where: { taskId: fixture.fixTaskId, status: RunStatus.QUEUED } }), 1);
});

test("simultaneous review completions serialize the join to exactly one fix-step run", { timeout: 20_000 }, async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture);
  const { first, second } = await reviewClaims(fixture, "simultaneous-sol", "simultaneous-blind");
  const firstIsSol = first.run.taskId === fixture.solTaskId;
  await Promise.all([
    completeReview(first, firstIsSol ? "simultaneous-sol" : "simultaneous-blind", firstIsSol ? "sol-findings" : "blind-findings"),
    completeReview(second, firstIsSol ? "simultaneous-blind" : "simultaneous-sol", firstIsSol ? "blind-findings" : "sol-findings"),
  ]);
  assert.equal(await db.run.count({ where: { taskId: fixture.fixTaskId } }), 1);
});

test("failed, parked, and archived-Agent review siblings fail-stop the join until repaired", async () => {
  for (const mode of ["failed", "parked", "archived-agent"] as const) {
    await resetTestDb(db);
    await runDbScript("seed.ts");
    await runDbScript("sync-canonical-prompts.ts");
    const fixture = await instantiateDirect();
    const blindBeforeImplementation = fixture.blindTaskId;

    if (mode === "parked") {
      const parked = await operatorRequest(`/tasks/${blindBeforeImplementation}`, "PATCH", { status: TaskStatus.BACKLOG });
      assert.equal(parked.status, 200, JSON.stringify(parked.body));
    } else if (mode === "archived-agent") {
      const parked = await operatorRequest(`/tasks/${blindBeforeImplementation}`, "PATCH", { status: TaskStatus.BACKLOG });
      assert.equal(parked.status, 200, JSON.stringify(parked.body));
      const blindTask = await db.task.findUniqueOrThrow({
        where: { id: blindBeforeImplementation },
        select: { assigneeAgentId: true },
      });
      assert.ok(blindTask.assigneeAgentId);
      const archived = await operatorRequest(`/agents/${blindTask.assigneeAgentId}/archive`, "POST");
      assert.equal(archived.status, 200, JSON.stringify(archived.body));
      // This models an archived assignee already stored on a runnable chain
      // node, which is reachable from pre-protocol data and concurrent control
      // plane repair. Activation must park it rather than enqueueing work.
      await db.task.update({ where: { id: blindBeforeImplementation }, data: { status: TaskStatus.TODO } });
    }

    await completeImplementation(fixture, `${mode}-implementation`);
    const solClaim = await claim(`${mode}-sol`);
    assert.equal(solClaim.run.taskId, fixture.solTaskId);
    await completeReview(solClaim, `${mode}-sol`, "sol-findings");
    assert.equal(await db.run.count({ where: { taskId: fixture.fixTaskId } }), 0, mode);

    let repairedClaim: Claim;
    if (mode === "failed") {
      const blindClaim = await claim("failed-blind");
      assert.equal(blindClaim.run.taskId, fixture.blindTaskId);
      const failed = await complete(blindClaim, "failed-blind", { failed: true });
      assert.equal(failed.status, 200, JSON.stringify(failed.body));
      assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.blindTaskId } })).status, TaskStatus.REVIEW);
      const retry = await operatorRequest(`/tasks/${fixture.blindTaskId}/retry`, "POST");
      assert.equal(retry.status, 201, JSON.stringify(retry.body));
      repairedClaim = await claim("failed-blind-repair");
    } else if (mode === "parked") {
      const started = await operatorRequest(`/tasks/${fixture.blindTaskId}/start`, "POST");
      assert.equal(started.status, 201, JSON.stringify(started.body));
      repairedClaim = await claim("parked-blind-repair");
    } else {
      const blindTask = await db.task.findUniqueOrThrow({
        where: { id: fixture.blindTaskId },
        select: { assigneeAgentId: true, status: true, failureReason: true },
      });
      assert.equal(blindTask.status, TaskStatus.REVIEW);
      assert.match(blindTask.failureReason ?? "", /Assignee .* is archived/u);
      assert.ok(blindTask.assigneeAgentId);
      const unarchived = await operatorRequest(`/agents/${blindTask.assigneeAgentId}/unarchive`, "POST");
      assert.equal(unarchived.status, 200, JSON.stringify(unarchived.body));
      const parked = await operatorRequest(`/tasks/${fixture.blindTaskId}`, "PATCH", { status: TaskStatus.BACKLOG });
      assert.equal(parked.status, 200, JSON.stringify(parked.body));
      const started = await operatorRequest(`/tasks/${fixture.blindTaskId}/start`, "POST");
      assert.equal(started.status, 201, JSON.stringify(started.body));
      repairedClaim = await claim("archived-agent-blind-repair");
    }

    assert.equal(repairedClaim.run.taskId, fixture.blindTaskId);
    await completeReview(repairedClaim, `${mode}-blind-repair`, "blind-findings");
    assert.equal(await db.run.count({ where: { taskId: fixture.fixTaskId } }), 1, mode);
    assert.equal(await db.run.count({ where: { taskId: fixture.fixTaskId, status: RunStatus.QUEUED } }), 1, mode);
  }
});

test("Full Assurance reaches its layer-6 review pair and one runner can claim both sequentially", async () => {
  const fixture = await instantiateFullAtReviewFrontier();
  await completeImplementation(fixture, "single-runner");
  const { first, second } = await reviewClaims(fixture, "single-runner", "single-runner");
  assert.equal(first.task.chainLayer, 6);
  assert.equal(second.task.chainLayer, 6);
  assert.equal(first.run.implementationBaseSha, IMPLEMENTATION_BASE);
  assert.equal(second.run.implementationHeadSha, IMPLEMENTATION_HEAD);

  const firstIsSol = first.run.taskId === fixture.solTaskId;
  await completeReview(first, "single-runner", firstIsSol ? "sol-findings" : "blind-findings");
  assert.equal(await db.run.count({ where: { taskId: { in: [fixture.solTaskId, fixture.blindTaskId] }, status: RunStatus.QUEUED } }), 0);
  await completeReview(second, "single-runner", firstIsSol ? "blind-findings" : "sol-findings");
  assert.equal(await db.run.count({ where: { task: { chainId: fixture.chainId, chainIndex: 8 } } }), 1);
});
