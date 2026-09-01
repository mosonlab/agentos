import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  PR_TEMPLATE_NAME,
  RepoPermission,
  type PrismaClient,
} from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const OPERATOR = "pr-engineer-workflow-operator";
const RUNNER = "pr-engineer-workflow-runner";
const IMPLEMENTATION_BASE = "1".repeat(40);
const IMPLEMENTATION_HEAD = "2".repeat(40);
const BRANCH = "feature/pr-workflow";
const BRIEF = [
  "Implement the pull-request workflow acceptance fixture.",
  "",
  "Route: implementation=senior-dev - this line is ordinary PR-workflow specification text.",
].join("\n");

let db: PrismaClient;
let priorOperatorToken: string | undefined;
let priorRunnerToken: string | undefined;

before(() => {
  priorOperatorToken = process.env.OPERATOR_TOKEN;
  priorRunnerToken = process.env.RUNNER_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  process.env.RUNNER_TOKEN = RUNNER;
  db = setupTestDb();
});

beforeEach(async () => { await resetTestDb(db); });

after(async () => {
  await db.$disconnect();
  if (priorOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = priorOperatorToken;
  if (priorRunnerToken === undefined) delete process.env.RUNNER_TOKEN;
  else process.env.RUNNER_TOKEN = priorRunnerToken;
});

const request = async (
  method: string,
  path: string,
  body?: unknown,
  options: Parameters<typeof createApp>[1] = {},
  token = OPERATOR,
): Promise<{ status: number; body: any }> => {
  const response = await createApp(db, options).request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
};

const bootstrap = async () => {
  const created = await request("POST", "/projects", {
    name: "PR Workflow Project",
    slug: "pr-workflow-project",
    yamlDocument: "",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const projectId = String(created.body.id);
  const template = await db.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId, name: PR_TEMPLATE_NAME } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  return { projectId, template };
};

const addRepoAndGrants = async (projectId: string) => {
  const repo = await db.repo.create({
    data: {
      projectId,
      name: "app",
      remoteUrl: "https://github.com/example/pr-workflow.git",
      defaultBranch: "main",
      mountPath: "repo",
    },
  });
  const agents = await db.agent.findMany({ where: { projectId }, select: { id: true } });
  assert.equal(agents.length, 4);
  await db.agentRepoAccess.createMany({
    data: agents.map(({ id: agentId }) => ({
      projectId,
      agentId,
      repoId: repo.id,
      mountPath: "repo",
      permissions: RepoPermission.GIT_WRITE,
    })),
  });
  return repo;
};

const instantiate = async (
  projectId: string,
  templateId: string,
  repoId: string,
  variables: Record<string, string>,
  autoStart = false,
) => request(
  "POST",
  `/projects/${projectId}/task-templates/${templateId}/instantiate`,
  { repoId, variables, autoStart, description: BRIEF },
);

test("the bootstrapped PR workflow instantiates four direct tasks and enforces its variable contract", async () => {
  const { projectId, template } = await bootstrap();
  const repo = await addRepoAndGrants(projectId);

  const missing = await instantiate(projectId, template.id, repo.id, {});
  assert.equal(missing.status, 400, JSON.stringify(missing.body));
  assert.equal(missing.body.code, "template_variables_missing");

  const unknown = await instantiate(projectId, template.id, repo.id, {
    branchName: BRANCH,
    extra: "x",
  });
  assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
  assert.equal(unknown.body.code, "template_variables_unknown");

  const created = await instantiate(projectId, template.id, repo.id, { branchName: BRANCH });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const tasks = await db.task.findMany({
    where: { chainId: created.body.chainId },
    orderBy: { chainIndex: "asc" },
  });
  assert.deepEqual(tasks.map(({ chainIndex }) => chainIndex), [1, 2, 3, 4]);
  assert.equal(tasks.some(({ name }) => name.toLowerCase().includes("revalidat")), false);
  assert.equal(tasks[0]!.assigneeAgentId, template.steps[0]!.assigneeAgentId);
  assert.match(tasks[0]!.description, /Route: implementation=senior-dev/u);
});

type Claim = {
  task: { id: string; chainIndex: number | null };
  run: {
    id: string;
    taskId: string;
    branch: string | null;
    subagentModel: string | null;
    subagentMaxConcurrent: number | null;
    implementationBaseSha: string | null;
    implementationHeadSha: string | null;
  };
  specificationMaterialization: { kind: string; path: string; body: string } | null;
  fencingToken: string;
  sessionToken: string;
};

test("PR implementation materializes the brief and both reviews verify the implementation head", async () => {
  const { projectId, template } = await bootstrap();
  const repo = await addRepoAndGrants(projectId);
  const created = await instantiate(projectId, template.id, repo.id, { branchName: BRANCH }, true);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const tasks = await db.task.findMany({
    where: { chainId: created.body.chainId },
    orderBy: { chainIndex: "asc" },
  });
  assert.equal(tasks.length, 4);

  const reads: Array<{ repository: string; path: string; commitSha: string; bytes: Uint8Array }> = [];
  const authoritativeBytes = new TextEncoder().encode(BRIEF);
  const options: Parameters<typeof createApp>[1] = {
    specificationReader: {
      readFileAtCommit: async (repository, path, commitSha) => {
        const bytes = authoritativeBytes.slice();
        reads.push({ repository, path, commitSha, bytes });
        return bytes;
      },
    },
  };
  const claim = async (runnerId: string): Promise<Claim> => {
    const claimed = await request(
      "POST",
      "/runner/tasks/claim",
      { runnerId, leaseSeconds: 120 },
      options,
      RUNNER,
    );
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    return claimed.body as Claim;
  };

  const implementation = await claim("pr-implementation");
  assert.equal(implementation.task.id, tasks[0]!.id);
  assert.equal(implementation.run.subagentModel, null);
  assert.equal(implementation.run.subagentMaxConcurrent, null);
  assert.deepEqual(implementation.specificationMaterialization, {
    kind: "direct-implementation",
    path: `.chain/${BRANCH}/spec.md`,
    body: BRIEF,
  });

  const output = await request(
    "PUT",
    `/session/runs/${implementation.run.id}/output`,
    {
      fencingToken: implementation.fencingToken,
      kind: "implementation",
      body: JSON.stringify({
        schemaVersion: 1,
        headSha: IMPLEMENTATION_HEAD,
        baseSha: IMPLEMENTATION_BASE,
        summary: "PR workflow fixture implementation",
        testsRun: ["npm test -- pr workflow"],
      }),
      commitSha: IMPLEMENTATION_HEAD,
    },
    {},
    implementation.sessionToken,
  );
  assert.equal(output.status, 200, JSON.stringify(output.body));

  const completed = await request(
    "POST",
    `/runner/runs/${implementation.run.id}/complete`,
    {
      runnerId: "pr-implementation",
      fencingToken: implementation.fencingToken,
      exitCode: 0,
      terminalEventSeen: true,
      terminalSuccess: true,
      branch: BRANCH,
      pushedBranch: BRANCH,
      baseSha: IMPLEMENTATION_BASE,
      headSha: IMPLEMENTATION_HEAD,
      pushStatus: "SUCCEEDED",
      cleanupStatus: "SUCCEEDED",
      workspaceRetained: false,
    },
    {},
    RUNNER,
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));

  const firstReview = await claim("pr-review-one");
  const secondReview = await claim("pr-review-two");
  assert.deepEqual(
    new Set([firstReview.task.id, secondReview.task.id]),
    new Set([tasks[1]!.id, tasks[2]!.id]),
  );
  for (const review of [firstReview, secondReview]) {
    assert.equal(review.run.implementationBaseSha, IMPLEMENTATION_BASE);
    assert.equal(review.run.implementationHeadSha, IMPLEMENTATION_HEAD);
  }
  assert.equal(reads.length, 2);
  assert.ok(reads.every(({ path, commitSha }) => (
    path === `.chain/${BRANCH}/spec.md` && commitSha === IMPLEMENTATION_HEAD
  )));
  assert.deepEqual(reads[0]!.bytes, authoritativeBytes);
  assert.deepEqual(reads[1]!.bytes, authoritativeBytes);
});

test("the canonical PR workflow refuses Step replacement and remains cloneable", async () => {
  const { projectId, template } = await bootstrap();
  const replaced = await request(
    "PUT",
    `/projects/${projectId}/task-templates/${template.id}/steps`,
    { steps: [] },
  );
  assert.equal(replaced.status, 409, JSON.stringify(replaced.body));
  assert.equal(replaced.body.code, "template_canonical");

  const cloned = await request(
    "POST",
    `/projects/${projectId}/task-templates/${template.id}/clone`,
    { name: "pr-workflow-copy" },
  );
  assert.equal(cloned.status, 201, JSON.stringify(cloned.body));
  assert.equal(cloned.body.name, "pr-workflow-copy");
  assert.equal(cloned.body.steps.length, 4);
});
