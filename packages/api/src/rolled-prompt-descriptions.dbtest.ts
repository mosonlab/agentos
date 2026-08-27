import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { enqueueTaskRun, PrismaClient, RunStatus, TaskStatus } from "@agentos/db";

import { reconcileRolledPromptDescriptions } from "./rolled-prompt-descriptions.js";
import { composeTemplateTaskDescription } from "./templates.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const CANONICAL = "direct-engineer-workflow";
const RETIRED_PROMPT = "Run `npm run db:authority-check -w @agentos/db` before the gate.";
const CURRENT_PROMPT = "Acquire the chain merge lease for {{chainId}} and dispatch the gate.";
const BRIEF = "the operator's own brief";
const OUTPUT_KIND = "regression-verification-v2";

let seedCounter = 0;

/**
 * A project holding both sides of a prompt-only rollover: the outgoing graph
 * under its legacy name, still carrying the retired prompt, and the canonical
 * successor carrying the current one.
 */
const seedRollover = async () => {
  const seedId = `${Date.now()}-${(seedCounter += 1)}`;
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

  const makeTemplate = async (name: string, prompt: string) => db.taskTemplate.create({ data: {
    projectId: project.id,
    name,
    description: "a canonical chain",
    steps: { create: [{
      stepIndex: 1,
      layer: 1,
      name: "regression verification",
      prompt,
      assigneeType: "AGENT",
      assigneeAgentId: agent.id,
      approvalGate: false,
      outputKind: OUTPUT_KIND,
      attachmentsFromPrevious: true,
      opensPullRequest: false,
      baseFromStepIndex: null,
    }] },
  }, include: { steps: true } });

  // The rollover has already happened: the outgoing row is renamed and the
  // canonical name now carries the successor graph.
  const legacy = await makeTemplate(
    `${CANONICAL}-legacy-pre-blind-review-retirement-tmpl${seedId.replace(/\D/gu, "")}`,
    RETIRED_PROMPT,
  );
  const canonical = await makeTemplate(CANONICAL, CURRENT_PROMPT);
  return { project, agent, repo, legacy, canonical };
};

const retiredDescription = (): string => composeTemplateTaskDescription({
  prompt: RETIRED_PROMPT,
  featureBrief: BRIEF,
  attachmentsFromPrevious: true,
  outputKind: OUTPUT_KIND,
});

const makeTask = async (
  seed: Awaited<ReturnType<typeof seedRollover>>,
  chainId: string,
  status: TaskStatus,
) => db.task.create({ data: {
  projectId: seed.project.id,
  repoId: seed.repo.id,
  templateId: seed.legacy.id,
  templateStepId: seed.legacy.steps[0]!.id,
  name: "Regression verification",
  description: retiredDescription(),
  assigneeType: "AGENT",
  assigneeAgentId: seed.agent.id,
  status,
  chainId,
  chainIndex: 1,
  chainLayer: 1,
} });

test("a not-yet-started task gets the rolled prompt, brief and interpolation intact", async () => {
  const seed = await seedRollover();
  const task = await makeTask(seed, "chain-not-started", TaskStatus.TODO);

  const result = await reconcileRolledPromptDescriptions(db);
  assert.equal(result.rewritten, 1);
  assert.equal(result.unresolvedVariables, 0);

  const refreshed = await db.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.match(refreshed.description, /Acquire the chain merge lease for chain-not-started/u);
  assert.doesNotMatch(refreshed.description, /db:authority-check/u);
  // The operator's brief survives the recomposition rather than being dropped.
  assert.match(refreshed.description, new RegExp(BRIEF, "u"));
  assert.match(refreshed.description, /Read the prior template steps/u);
  assert.match(refreshed.description, new RegExp(`Persist the final ${OUTPUT_KIND} output`, "u"));

  const activity = await db.taskActivity.findFirst({ where: { taskId: task.id } });
  assert.match(activity?.body ?? "", /frozen copy was refreshed/u);
});

test("a task whose run already started keeps the prompt it was dispatched under", async () => {
  const seed = await seedRollover();
  const task = await makeTask(seed, "chain-started", TaskStatus.DOING);
  const run = await enqueueTaskRun(db, task.id);
  await db.run.update({ where: { id: run.id }, data: { status: RunStatus.RUNNING } });

  const result = await reconcileRolledPromptDescriptions(db);
  assert.equal(result.rewritten, 0);

  const untouched = await db.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(untouched.description, task.description);
  assert.match(untouched.description, /db:authority-check/u);
});

test("the sweep is idempotent: a second pass rewrites nothing", async () => {
  const seed = await seedRollover();
  await makeTask(seed, "chain-idempotent", TaskStatus.TODO);

  assert.equal((await reconcileRolledPromptDescriptions(db)).rewritten, 1);
  const second = await reconcileRolledPromptDescriptions(db);
  assert.equal(second.rewritten, 0);
  assert.equal(second.alreadyCurrent, 1);
});

test("a structural rollover is left alone, because its step ordinals may not correspond", async () => {
  const seed = await seedRollover();
  // Same shape of upgrade, but registered as a structural generation, so no
  // prompt digest and no safe ordinal mapping.
  await db.taskTemplate.update({
    where: { id: seed.legacy.id },
    data: { name: `${CANONICAL}-legacy-pre-adjudication-tmplstructural` },
  });
  const task = await makeTask(seed, "chain-structural", TaskStatus.TODO);

  const result = await reconcileRolledPromptDescriptions(db);
  assert.equal(result.rewritten, 0);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).description, task.description);
});
