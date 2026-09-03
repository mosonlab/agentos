import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  DependencyProvisioning,
  DIRECT_TEMPLATE_NAME,
  INTEGRATOR_TEMPLATE_NAME,
  PR_TEMPLATE_NAME,
  PrismaClient,
  RepoPermission,
  TaskStatus,
} from "@anneal/db";

import { runDbScript } from "./test-db-script.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const OPERATOR_TOKEN = "configurable-gates-operator-token";
const RUNNER_TOKEN = "configurable-gates-runner-token";
const SHA = "02283bb8e9a08426394a5d2dc471b19bbaea22d7";

let db: PrismaClient;
const previousOperatorToken = process.env.OPERATOR_TOKEN;
const previousRunnerToken = process.env.RUNNER_TOKEN;

before(() => {
  process.env.OPERATOR_TOKEN = OPERATOR_TOKEN;
  process.env.RUNNER_TOKEN = RUNNER_TOKEN;
  db = setupTestDb();
});
beforeEach(async () => {
  await resetTestDb(db);
  await runDbScript("seed.ts");
});
after(async () => {
  await db.$disconnect();
  if (previousOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = previousOperatorToken;
  if (previousRunnerToken === undefined) delete process.env.RUNNER_TOKEN;
  else process.env.RUNNER_TOKEN = previousRunnerToken;
});

type Installation = {
  project: { id: string };
  repo: { id: string; defaultBranch: string };
  compound: { id: string; variables: string[] };
  direct: { id: string; variables: string[] };
  pullRequest: { id: string; variables: string[] };
};

const installation = async (): Promise<Installation> => {
  const project = await db.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const [compound, direct, pullRequest] = await Promise.all([
    db.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: INTEGRATOR_TEMPLATE_NAME } },
      select: { id: true, variables: true },
    }),
    db.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: DIRECT_TEMPLATE_NAME } },
      select: { id: true, variables: true },
    }),
    db.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: PR_TEMPLATE_NAME } },
      select: { id: true, variables: true },
    }),
  ]);
  const repo = await db.repo.create({
    data: {
      projectId: project.id,
      name: `configurable-gates-repo-${randomUUID()}`,
      remoteUrl: "https://example.test/configurable-gates.git",
      mountPath: "/repo",
      defaultBranch: "main",
      dependencyProvisioning: DependencyProvisioning.NONE,
    },
  });
  const agents = await db.agent.findMany({ where: { projectId: project.id }, select: { id: true } });
  await db.agentRepoAccess.createMany({
    data: agents.map(({ id: agentId }) => ({
      projectId: project.id,
      agentId,
      repoId: repo.id,
      mountPath: "/repo",
      permissions: RepoPermission.GIT_WRITE,
    })),
  });
  return { project, repo, compound, direct, pullRequest };
};

const variablesFor = (template: { variables: string[] }, label: string): Record<string, string> => (
  Object.fromEntries(template.variables.map((name) => [name, name === "branchName" ? `configurable/${label}-${randomUUID()}` : `value-${name}`]))
);

const request = async (
  path: string,
  method: "POST" | "PUT" | "PATCH",
  body: unknown,
  token = OPERATOR_TOKEN,
): Promise<{ status: number; body: any }> => {
  const response = await createApp(db).request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

const tasksFor = async (chainId: string) => db.task.findMany({
  where: { chainId },
  orderBy: { chainIndex: "asc" },
  select: {
    id: true,
    chainIndex: true,
    approvalGate: true,
    status: true,
    templateStep: { select: { stepIndex: true, outputKind: true } },
  },
});

test("compound, direct, and pull-request instantiation resolve the gate matrix and refuse absent slots", async () => {
  const seed = await installation();
  const matrix: Array<[
    boolean,
    boolean,
    { spec?: boolean; merge?: boolean } | undefined,
    boolean,
    boolean,
  ]> = [
    [false, false, undefined, false, false],
    [false, false, { spec: true, merge: true }, true, true],
    [false, true, undefined, false, true],
    [false, true, { spec: true, merge: false }, true, false],
    [true, false, undefined, true, false],
    [true, false, { spec: false, merge: true }, false, true],
    [true, true, undefined, true, true],
    [true, true, { spec: false, merge: false }, false, false],
  ];
  for (const [specGateDefault, mergeGateDefault, gates, expectedSpec, expectedMerge] of matrix) {
    await db.project.update({ where: { id: seed.project.id }, data: { specGateDefault, mergeGateDefault } });
    const result = await request(
      `/projects/${seed.project.id}/task-templates/${seed.compound.id}/instantiate`,
      "POST",
      { repoId: seed.repo.id, variables: variablesFor(seed.compound, "compound"), name: "compound gate matrix", autoStart: false, ...(gates === undefined ? {} : { gates }) },
    );
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const tasks = await tasksFor(result.body.chainId);
    assert.equal(tasks.find((task) => task.templateStep?.stepIndex === 1)?.approvalGate, expectedSpec);
    assert.equal(tasks.find((task) => task.templateStep?.stepIndex === 11)?.approvalGate, expectedMerge);
    assert.ok(tasks.filter((task) => task.templateStep?.stepIndex !== 1 && task.templateStep?.stepIndex !== 11).every((task) => !task.approvalGate));
  }

  await db.project.update({ where: { id: seed.project.id }, data: { specGateDefault: false, mergeGateDefault: true } });
  const direct = await request(
    `/projects/${seed.project.id}/task-templates/${seed.direct.id}/instantiate`,
    "POST",
    { repoId: seed.repo.id, variables: variablesFor(seed.direct, "direct"), name: "direct gate matrix", autoStart: false },
  );
  assert.equal(direct.status, 201, JSON.stringify(direct.body));
  const directTasks = await tasksFor(direct.body.chainId);
  assert.equal(directTasks.find((task) => task.templateStep?.stepIndex === 7)?.approvalGate, true);
  assert.ok(directTasks.filter((task) => task.templateStep?.stepIndex !== 7).every((task) => !task.approvalGate));

  const beforeAbsent = await db.task.count();
  const directSpec = await request(
    `/projects/${seed.project.id}/task-templates/${seed.direct.id}/instantiate`,
    "POST",
    { repoId: seed.repo.id, variables: variablesFor(seed.direct, "direct-absent"), name: "direct absent gate", gates: { spec: true } },
  );
  assert.equal(directSpec.status, 400, JSON.stringify(directSpec.body));
  assert.equal(directSpec.body.code, "gates_spec_step_absent");
  assert.match(directSpec.body.error, /specification.*direct-engineer-workflow/u);
  assert.equal(await db.task.count(), beforeAbsent);

  const bothAbsent = await request(
    `/projects/${seed.project.id}/task-templates/${seed.pullRequest.id}/instantiate`,
    "POST",
    { repoId: seed.repo.id, variables: variablesFor(seed.pullRequest, "both-absent"), name: "both absent gates", gates: { spec: true, merge: true } },
  );
  assert.equal(bothAbsent.status, 400, JSON.stringify(bothAbsent.body));
  assert.equal(bothAbsent.body.code, "gates_spec_step_absent");
  assert.match(bothAbsent.body.error, /specification.*pr-engineer-workflow/u);
  assert.equal(await db.task.count(), beforeAbsent);

  const mergeAbsent = await request(
    `/projects/${seed.project.id}/task-templates/${seed.pullRequest.id}/instantiate`,
    "POST",
    { repoId: seed.repo.id, variables: variablesFor(seed.pullRequest, "merge-absent"), name: "merge absent gate", gates: { merge: true } },
  );
  assert.equal(mergeAbsent.status, 400, JSON.stringify(mergeAbsent.body));
  assert.equal(mergeAbsent.body.code, "gates_merge_step_absent");
  assert.match(mergeAbsent.body.error, /merge.*pr-engineer-workflow/u);
  assert.equal(await db.task.count(), beforeAbsent);

  const unknownGate = await request(
    `/projects/${seed.project.id}/task-templates/${seed.compound.id}/instantiate`,
    "POST",
    { repoId: seed.repo.id, variables: variablesFor(seed.compound, "unknown"), name: "unknown gate", gates: { spec: true, unknown: false } },
  );
  assert.equal(unknownGate.status, 400, JSON.stringify(unknownGate.body));
  assert.equal(await db.task.count(), beforeAbsent);
});

test("instantiated gate values are snapshots and the specification gate uses the normal lifecycle", async () => {
  const seed = await installation();
  await db.project.update({ where: { id: seed.project.id }, data: { specGateDefault: false, mergeGateDefault: false } });
  const first = await request(
    `/projects/${seed.project.id}/task-templates/${seed.compound.id}/instantiate`,
    "POST",
    { repoId: seed.repo.id, variables: variablesFor(seed.compound, "snapshot-a"), name: "gate snapshot A", autoStart: false },
  );
  assert.equal(first.status, 201, JSON.stringify(first.body));
  await db.project.update({ where: { id: seed.project.id }, data: { specGateDefault: true, mergeGateDefault: true } });
  const second = await request(
    `/projects/${seed.project.id}/task-templates/${seed.compound.id}/instantiate`,
    "POST",
    { repoId: seed.repo.id, variables: variablesFor(seed.compound, "snapshot-b"), name: "gate snapshot B", autoStart: false },
  );
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const firstTasks = await tasksFor(first.body.chainId);
  const secondTasks = await tasksFor(second.body.chainId);
  assert.ok(firstTasks.every((task) => !task.approvalGate));
  assert.equal(secondTasks.find((task) => task.templateStep?.stepIndex === 1)?.approvalGate, true);
  assert.equal(secondTasks.find((task) => task.templateStep?.stepIndex === 11)?.approvalGate, true);

  const gated = await request(
    `/projects/${seed.project.id}/task-templates/${seed.compound.id}/instantiate`,
    "POST",
    { repoId: seed.repo.id, variables: variablesFor(seed.compound, "spec-lifecycle"), name: "spec gate lifecycle", autoStart: true, gates: { spec: true, merge: false } },
  );
  assert.equal(gated.status, 201, JSON.stringify(gated.body));
  const specTask = (await tasksFor(gated.body.chainId)).find((task) => task.templateStep?.stepIndex === 1)!;
  const claimedResponse = await request("/runner/tasks/claim", "POST", { runnerId: "spec-gate-runner", leaseSeconds: 120 }, RUNNER_TOKEN);
  assert.equal(claimedResponse.status, 200, JSON.stringify(claimedResponse.body));
  const claimed = claimedResponse.body as {
    run: { id: string; branch: string | null };
    fencingToken: string;
    sessionToken: string;
  };
  assert.equal(claimed.run.id, (await db.run.findFirstOrThrow({ where: { taskId: specTask.id } })).id);

  const output = await request(`/session/runs/${claimed.run.id}/output`, "PUT", {
    fencingToken: claimed.fencingToken,
    kind: "spec",
    body: JSON.stringify({ schemaVersion: 1, headSha: SHA, spec: "gated specification preview" }),
    commitSha: SHA,
  }, claimed.sessionToken);
  assert.equal(output.status, 200, JSON.stringify(output.body));
  const branch = claimed.run.branch ?? `configurable/spec-${randomUUID()}`;
  const completed = await request(`/runner/runs/${claimed.run.id}/complete`, "POST", {
    runnerId: "spec-gate-runner",
    fencingToken: claimed.fencingToken,
    exitCode: 0,
    outcome: { case: "succeeded" },
    branch,
    pushedBranch: branch,
    baseSha: SHA,
    headSha: SHA,
    pushStatus: "SUCCEEDED",
    cleanupStatus: "SUCCEEDED",
    workspaceRetained: false,
  }, RUNNER_TOKEN);
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const reviewed = await db.task.findUniqueOrThrow({ where: { id: specTask.id } });
  assert.equal(reviewed.status, TaskStatus.REVIEW);
  const card = await db.inboxMessage.findFirstOrThrow({ where: { gateTaskId: specTask.id, status: "OPEN" } });
  assert.match(card.body, /gated specification preview/u);

  const approved = await request(`/inbox/messages/${card.id}/decision`, "POST", { requestId: "spec-approve", decision: "approve" });
  assert.equal(approved.status, 201, JSON.stringify(approved.body));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: specTask.id } })).status, TaskStatus.DONE);
  const plan = await db.task.findFirstOrThrow({ where: { chainId: gated.body.chainId, templateStep: { stepIndex: 2 } } });
  assert.equal(await db.run.count({ where: { taskId: plan.id, status: "QUEUED" } }), 1);
});

test("rejecting an instantiated specification gate requeues that step and spends another run", async () => {
  const seed = await installation();
  const gated = await request(
    `/projects/${seed.project.id}/task-templates/${seed.compound.id}/instantiate`,
    "POST",
    { repoId: seed.repo.id, variables: variablesFor(seed.compound, "spec-reject"), name: "spec gate rejection", autoStart: true, gates: { spec: true } },
  );
  assert.equal(gated.status, 201, JSON.stringify(gated.body));
  const specTask = (await tasksFor(gated.body.chainId)).find((task) => task.templateStep?.stepIndex === 1)!;
  const claimedResponse = await request("/runner/tasks/claim", "POST", { runnerId: "spec-reject-runner", leaseSeconds: 120 }, RUNNER_TOKEN);
  assert.equal(claimedResponse.status, 200, JSON.stringify(claimedResponse.body));
  const claimed = claimedResponse.body as { run: { id: string; branch: string | null }; fencingToken: string; sessionToken: string };
  const output = await request(`/session/runs/${claimed.run.id}/output`, "PUT", {
    fencingToken: claimed.fencingToken,
    kind: "spec",
    body: JSON.stringify({ schemaVersion: 1, headSha: SHA, spec: "rejected specification" }),
    commitSha: SHA,
  }, claimed.sessionToken);
  assert.equal(output.status, 200, JSON.stringify(output.body));
  const branch = claimed.run.branch ?? `configurable/spec-reject-${randomUUID()}`;
  const completed = await request(`/runner/runs/${claimed.run.id}/complete`, "POST", {
    runnerId: "spec-reject-runner",
    fencingToken: claimed.fencingToken,
    exitCode: 0,
    outcome: { case: "succeeded" },
    branch,
    pushedBranch: branch,
    baseSha: SHA,
    headSha: SHA,
    pushStatus: "SUCCEEDED",
    cleanupStatus: "SUCCEEDED",
    workspaceRetained: false,
  }, RUNNER_TOKEN);
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const card = await db.inboxMessage.findFirstOrThrow({ where: { gateTaskId: specTask.id, status: "OPEN" } });
  const rejected = await request(`/inbox/messages/${card.id}/decision`, "POST", { requestId: "spec-reject", decision: "reject" });
  assert.equal(rejected.status, 201, JSON.stringify(rejected.body));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: specTask.id } })).status, TaskStatus.TODO);
  assert.equal(await db.run.count({ where: { taskId: specTask.id } }), 2);
  assert.equal(await db.run.count({ where: { taskId: specTask.id, status: "QUEUED" } }), 1);
  assert.equal(await db.run.count({ where: { taskId: (await db.task.findFirstOrThrow({ where: { chainId: gated.body.chainId, templateStep: { stepIndex: 2 } } })).id } }), 0);
});

test("an explicitly ungated instantiated specification step follows the autonomous path", async () => {
  const seed = await installation();
  const ungated = await request(
    `/projects/${seed.project.id}/task-templates/${seed.compound.id}/instantiate`,
    "POST",
    { repoId: seed.repo.id, variables: variablesFor(seed.compound, "spec-autonomous"), name: "spec gate autonomous", autoStart: true, gates: { spec: false } },
  );
  assert.equal(ungated.status, 201, JSON.stringify(ungated.body));
  const specTask = (await tasksFor(ungated.body.chainId)).find((task) => task.templateStep?.stepIndex === 1)!;
  const claimedResponse = await request("/runner/tasks/claim", "POST", { runnerId: "spec-autonomous-runner", leaseSeconds: 120 }, RUNNER_TOKEN);
  assert.equal(claimedResponse.status, 200, JSON.stringify(claimedResponse.body));
  const claimed = claimedResponse.body as { run: { id: string; branch: string | null }; fencingToken: string; sessionToken: string };
  const output = await request(`/session/runs/${claimed.run.id}/output`, "PUT", {
    fencingToken: claimed.fencingToken,
    kind: "spec",
    body: JSON.stringify({ schemaVersion: 1, headSha: SHA, spec: "autonomous specification" }),
    commitSha: SHA,
  }, claimed.sessionToken);
  assert.equal(output.status, 200, JSON.stringify(output.body));
  const branch = claimed.run.branch ?? `configurable/spec-autonomous-${randomUUID()}`;
  const completed = await request(`/runner/runs/${claimed.run.id}/complete`, "POST", {
    runnerId: "spec-autonomous-runner",
    fencingToken: claimed.fencingToken,
    exitCode: 0,
    outcome: { case: "succeeded" },
    branch,
    pushedBranch: branch,
    baseSha: SHA,
    headSha: SHA,
    pushStatus: "SUCCEEDED",
    cleanupStatus: "SUCCEEDED",
    workspaceRetained: false,
  }, RUNNER_TOKEN);
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: specTask.id } })).status, TaskStatus.DONE);
  assert.equal(await db.inboxMessage.count({ where: { gateTaskId: specTask.id, status: "OPEN" } }), 0);
  const plan = await db.task.findFirstOrThrow({ where: { chainId: ungated.body.chainId, templateStep: { stepIndex: 2 } } });
  assert.equal(await db.run.count({ where: { taskId: plan.id, status: "QUEUED" } }), 1);
});
