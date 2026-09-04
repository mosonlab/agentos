import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  DependencyProvisioning,
  DIRECT_TEMPLATE_NAME,
  INTEGRATOR_TEMPLATE_NAME,
  pinnedImplementationRange,
  PrismaClient,
  RepoPermission,
  TaskStatus,
} from "@anneal/db";

import { chainProgress } from "./chain.js";
import { runDbScript } from "./test-db-script.js";
import { resetTestDb, setupTestDb } from "./testdb.js";
import { instantiateTemplate } from "./templates.js";

let db: PrismaClient;

before(() => { db = setupTestDb(); });
beforeEach(async () => {
  await resetTestDb(db);
  await runDbScript("seed.ts");
});
after(async () => { await db.$disconnect(); });

const install = async () => {
  const project = await db.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const [direct, compound] = await Promise.all([
    db.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: DIRECT_TEMPLATE_NAME } },
      select: { id: true, variables: true },
    }),
    db.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: INTEGRATOR_TEMPLATE_NAME } },
      select: { id: true, variables: true },
    }),
  ]);
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: `optional-step-${randomUUID()}`,
    remoteUrl: "https://example.test/optional-step.git",
    mountPath: "/repo",
    defaultBranch: "main",
    dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  const agents = await db.agent.findMany({ where: { projectId: project.id }, select: { id: true } });
  await db.agentRepoAccess.createMany({ data: agents.map(({ id: agentId }) => ({
    projectId: project.id,
    agentId,
    repoId: repo.id,
    mountPath: "/repo",
    permissions: RepoPermission.GIT_WRITE,
  })) });
  return { project, repo, direct, compound };
};

const variablesFor = (template: { variables: string[] }, label: string) => Object.fromEntries(
  template.variables.map((name) => [name, name === "branchName" ? `optional/${label}-${randomUUID()}` : `value-${name}`]),
);

const predecessorFor = async (projectId: string, repoId: string) => db.task.create({ data: {
  projectId,
  repoId,
  name: "Optional-step dispatch predecessor",
  description: "Terminal predecessor for a bound direct chain",
  assigneeType: "HUMAN",
  status: TaskStatus.TODO,
  chainId: `optional-predecessor-${randomUUID()}`,
  chainIndex: 1,
  chainLayer: 1,
} });

const coordinates = (tasks: Array<{ chainIndex: number | null; chainLayer: number | null }>) => ({
  indexes: tasks.map(({ chainIndex }) => chainIndex),
  layers: tasks.map(({ chainLayer }) => chainLayer),
});

test("direct instantiation snapshots optional omission and preserves sparse template ordinals", async () => {
  const seed = await install();
  const instantiateDirect = async (skipOptionalSteps: boolean, bound: boolean) => {
    await db.project.update({ where: { id: seed.project.id }, data: { skipOptionalSteps } });
    const predecessor = bound ? await predecessorFor(seed.project.id, seed.repo.id) : null;
    return instantiateTemplate(db, seed.project.id, seed.direct.id, {
      repoId: seed.repo.id,
      variables: variablesFor(seed.direct, `${skipOptionalSteps ? "skip" : "keep"}-${bound ? "bound" : "unbound"}`),
      name: `direct ${skipOptionalSteps ? "skip" : "keep"} ${bound ? "bound" : "unbound"}`,
      ...(predecessor ? { afterTaskId: predecessor.id } : {}),
    });
  };

  const keptUnbound = await instantiateDirect(false, false);
  assert.equal(keptUnbound.tasks.length, 7);
  assert.deepEqual(coordinates(keptUnbound.tasks), {
    indexes: [1, 2, 3, 4, 5, 6, 7],
    layers: [1, 2, 2, 3, 4, 5, 6],
  });
  const keptBound = await instantiateDirect(false, true);
  assert.equal(keptBound.tasks.length, 8);
  assert.deepEqual(coordinates(keptBound.tasks), {
    indexes: [1, 2, 3, 4, 5, 6, 7, 8],
    layers: [1, 2, 3, 3, 4, 5, 6, 7],
  });

  const skippedUnbound = await instantiateDirect(true, false);
  assert.equal(skippedUnbound.tasks.length, 6);
  assert.deepEqual(coordinates(skippedUnbound.tasks), {
    indexes: [1, 2, 4, 5, 6, 7],
    layers: [1, 2, 3, 4, 5, 6],
  });
  assert.equal(await db.task.count({
    where: { chainId: skippedUnbound.chainId, templateStep: { outputKind: "blind-findings" } },
  }), 0);
  const progress = chainProgress(skippedUnbound.tasks.map((task) => ({
    id: task.id,
    status: task.status,
    chainIndex: task.chainIndex,
    chainLayer: task.chainLayer,
  })));
  assert.deepEqual(progress, { total: 6, done: 0, position: 1, currentLayer: 1, layerCount: 6 });

  const skippedBound = await instantiateDirect(true, true);
  assert.equal(skippedBound.tasks.length, 7);
  assert.deepEqual(coordinates(skippedBound.tasks), {
    indexes: [1, 2, 3, 5, 6, 7, 8],
    layers: [1, 2, 3, 4, 5, 6, 7],
  });

  await db.project.update({ where: { id: seed.project.id }, data: { skipOptionalSteps: false } });
  assert.equal(await db.task.count({ where: { chainId: skippedUnbound.chainId } }), 6);
});

test("compound omission preserves exact-ordinal merge predecessors and retained base references", async () => {
  const seed = await install();
  await db.project.update({ where: { id: seed.project.id }, data: { skipOptionalSteps: true } });
  const chain = await instantiateTemplate(db, seed.project.id, seed.compound.id, {
    repoId: seed.repo.id,
    variables: variablesFor(seed.compound, "compound"),
    name: "compound optional omission",
  });
  assert.equal(chain.tasks.length, 11);
  assert.equal(await db.task.count({
    where: { chainId: chain.chainId, templateStep: { outputKind: "blind-findings" } },
  }), 0);
  const tasks = await db.task.findMany({
    where: { chainId: chain.chainId },
    include: { templateStep: true },
    orderBy: { chainIndex: "asc" },
  });
  assert.ok(tasks.every((task) => task.chainIndex === task.templateStep?.stepIndex));
  for (const kind of ["merge-authorization", "merge-result"]) {
    const tail = tasks.find((task) => task.templateStep?.outputKind === kind)!;
    assert.ok(tasks.some((task) => task.chainIndex === tail.chainIndex! - 1), `${kind} predecessor remains addressable`);
  }

  const implementation = tasks.find((task) => task.templateStep?.stepIndex === 5)!;
  const review = tasks.find((task) => task.templateStep?.stepIndex === 6)!;
  const baseSha = "1".repeat(40);
  const headSha = "2".repeat(40);
  await db.taskStepOutput.create({ data: {
    taskId: implementation.id,
    kind: "implementation",
    body: JSON.stringify({ schemaVersion: 1, baseSha, headSha, summary: "fixture", testsRun: [] }),
    commitSha: headSha,
  } });
  assert.deepEqual(await pinnedImplementationRange(db, review), {
    implementationBaseSha: baseSha,
    implementationHeadSha: headSha,
  });
});
