import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { enqueueTaskRun, loadAllTemplateStepSources, PrismaClient, TaskStatus } from "@agentos/db";

import { reconcileRolledPromptDescriptions } from "./rolled-prompt-descriptions.js";
import { composeTemplateTaskDescription } from "./templates.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const CANONICAL = "direct-engineer-workflow";
const REGRESSION_STEP_INDEX = 5;
const BRIEF = "the operator's own brief";
const BRANCH = "agentos/rollover-branch";

let seedCounter = 0;

/**
 * The real prompts, not stand-ins.
 *
 * The retired generation is what the current source becomes once the two
 * demolished paragraphs are put back, and that is the point of using it: the
 * live prompt names `{{branchName}}` as well as `{{chainId}}`, and a synthetic
 * prompt that happens to use only `chainId` would let an interpolation gap
 * through unnoticed.
 */
const currentRegressionPrompt = async (): Promise<string> => {
  const sources = await loadAllTemplateStepSources();
  const steps = sources.get(CANONICAL);
  assert.ok(steps, "the direct chain must load from source");
  const step = steps.find((candidate) => candidate.stepIndex === REGRESSION_STEP_INDEX);
  assert.ok(step, "the direct chain must have a regression step at that ordinal");
  assert.match(step.prompt, /\{\{branchName\}\}/u, "the regression prompt must still name branchName");
  assert.match(step.prompt, /\{\{chainId\}\}/u, "the regression prompt must still name chainId");
  return step.prompt;
};

const RETIRED_PROMPT_TAIL = "\n\nBefore the gate, run `npm run db:authority-check -w @agentos/db` once.";

const seedRollover = async () => {
  const seedId = `${Date.now()}-${(seedCounter += 1)}`;
  const digits = seedId.replace(/\D/gu, "");
  const current = await currentRegressionPrompt();
  const retired = `${current}${RETIRED_PROMPT_TAIL}`;

  const project = await db.project.create({ data: { name: "Rollover", slug: `rollover-${seedId}` } });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: "regression-verifier",
    title: "regression-verifier",
    model: "gpt-5.6-sol:high",
    runnerPreference: "CODEX",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: "widgets",
    remoteUrl: "https://github.com/acme/widgets.git",
    mountPath: "/repo",
    defaultBranch: "main",
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: project.id, repoId: repo.id, agentId: agent.id, mountPath: "/repo", permissions: "GIT_WRITE",
  } });

  const makeTemplate = async (name: string, prompt: string) => db.taskTemplate.create({ data: {
    projectId: project.id,
    name,
    description: "a canonical chain",
    steps: { create: [{
      stepIndex: REGRESSION_STEP_INDEX,
      layer: 4,
      name: "regression verification",
      prompt,
      assigneeType: "AGENT",
      assigneeAgentId: agent.id,
      approvalGate: false,
      outputKind: "regression-verification-v2",
      attachmentsFromPrevious: true,
      opensPullRequest: false,
      baseFromStepIndex: null,
    }] },
  }, include: { steps: true } });

  // The rollover has already happened: the outgoing row is renamed and the
  // canonical name now carries the successor graph.
  const legacy = await makeTemplate(`${CANONICAL}-legacy-pre-blind-review-retirement-tmpl${digits}`, retired);
  const canonical = await makeTemplate(CANONICAL, current);
  return { project, agent, repo, legacy, canonical, current, retired };
};

const makeTask = async (
  seed: Awaited<ReturnType<typeof seedRollover>>,
  chainId: string,
  status: TaskStatus = TaskStatus.TODO,
) => db.task.create({ data: {
  projectId: seed.project.id,
  repoId: seed.repo.id,
  templateId: seed.legacy.id,
  templateStepId: seed.legacy.steps[0]!.id,
  name: "Regression verification",
  description: composeTemplateTaskDescription({
    prompt: seed.retired.replaceAll("{{chainId}}", chainId).replaceAll("{{branchName}}", BRANCH),
    featureBrief: BRIEF,
    attachmentsFromPrevious: true,
    outputKind: "regression-verification-v2",
  }),
  assigneeType: "AGENT",
  assigneeAgentId: seed.agent.id,
  status,
  chainId,
  chainIndex: REGRESSION_STEP_INDEX,
  chainLayer: 4,
  targetBranch: BRANCH,
} });

test("the real regression prompt is rewritten with every variable resolved from the task row", async () => {
  const seed = await seedRollover();
  const task = await makeTask(seed, "chain-real");

  const result = await reconcileRolledPromptDescriptions(db);
  assert.equal(result.rewritten, 1);
  // The whole point of this reconciliation: the prompt it exists for must not
  // fall out through the unresolved-variable backstop.
  assert.equal(result.unresolvedVariables, 0);

  const refreshed = await db.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.doesNotMatch(refreshed.description, /db:authority-check/u);
  assert.doesNotMatch(refreshed.description, /\{\{[A-Za-z]/u, "no placeholder survives into the description");
  // branchName comes from targetBranch, chainId from chainId; both are real.
  assert.match(refreshed.description, new RegExp(BRANCH, "u"));
  assert.match(refreshed.description, /chain-real/u);
  assert.match(refreshed.description, new RegExp(BRIEF, "u"));
  assert.match(refreshed.description, /Read the prior template steps/u);
});

test("a task with any run, even merely queued, keeps the text its run was hashed from", async () => {
  const seed = await seedRollover();
  const task = await makeTask(seed, "chain-queued");
  await enqueueTaskRun(db, task.id);

  const result = await reconcileRolledPromptDescriptions(db);
  assert.equal(result.rewritten, 0);

  const untouched = await db.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(untouched.description, task.description);
  assert.match(untouched.description, /db:authority-check/u);
});

test("the sweep is idempotent: a second pass rewrites nothing", async () => {
  const seed = await seedRollover();
  await makeTask(seed, "chain-idempotent");

  assert.equal((await reconcileRolledPromptDescriptions(db)).rewritten, 1);
  const second = await reconcileRolledPromptDescriptions(db);
  assert.equal(second.rewritten, 0);
  assert.equal(second.alreadyCurrent, 1);
});

test("two instances starting at once rewrite a description exactly once", async () => {
  const seed = await seedRollover();
  const task = await makeTask(seed, "chain-concurrent");

  const [left, right] = await Promise.all([
    reconcileRolledPromptDescriptions(db),
    reconcileRolledPromptDescriptions(db),
  ]);
  assert.equal(left.rewritten + right.rewritten, 1);
  assert.equal(await db.taskActivity.count({ where: { taskId: task.id, actorType: "control-plane" } }), 1);
});

test("a task with no chain branch is reported rather than given a literal placeholder", async () => {
  const seed = await seedRollover();
  const task = await makeTask(seed, "chain-no-branch");
  // targetBranch is what supplies branchName; without it the prompt cannot be
  // rebuilt, and baking `{{branchName}}` into the description would be worse
  // than leaving the retired text in place.
  await db.task.update({ where: { id: task.id }, data: { targetBranch: null } });

  const result = await reconcileRolledPromptDescriptions(db);
  assert.equal(result.rewritten, 0);
  assert.equal(result.unresolvedVariables, 1);
  assert.match((await db.task.findUniqueOrThrow({ where: { id: task.id } })).description, /db:authority-check/u);

  // Reported once, not once per restart.
  await reconcileRolledPromptDescriptions(db);
  assert.equal(await db.taskActivity.count({
    where: { taskId: task.id, actorType: "control-plane", body: { contains: "unresolved template variable" } },
  }), 1);
});

test("a structural rollover is left alone, because its step ordinals may not correspond", async () => {
  const seed = await seedRollover();
  await db.taskTemplate.update({
    where: { id: seed.legacy.id },
    data: { name: `${CANONICAL}-legacy-pre-adjudication-tmplstructural` },
  });
  const task = await makeTask(seed, "chain-structural");

  const result = await reconcileRolledPromptDescriptions(db);
  assert.equal(result.rewritten, 0);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).description, task.description);
});
