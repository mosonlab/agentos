/**
 * Step 7 / SF-3 — the seeded thirteen-step template, and the verifier that guards it.
 *
 * The prior plan left this as "edit the seed wherever it is" and relied on
 * `verify-agent-template.ts` to catch a mistake. That is circular: the verifier
 * is code in the same change, and a verifier that never checked
 * `opensPullRequest` would pass a seed that never set it. So the fresh-seed
 * assertion below reads the seeded row **directly**, and only then is the
 * verifier's verdict relied on for anything.
 *
 * Both the seed and the verifier are top-level scripts with their own Prisma
 * client, so they run here as child processes against this suite's scratch
 * schema — which is also the only way to test them as an operator invokes them.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  activateChainSuccessor,
  AssigneeType,
  DIRECT_TEMPLATE_NAME,
  executionModeFor,
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_OUTPUT_KIND,
  INTEGRATOR_SENTINEL_MODEL,
  INTEGRATOR_STEP_INDEX,
  INTEGRATOR_TEMPLATE_NAME,
  legacyNineStepTemplateName,
  legacyChainLeaseTemplateName,
  legacyRegressionFirstThirteenStepTemplateName,
  legacyTenStepTemplateName,
  loadAgentSources,
  loadTemplateStepSources,
  previousChainLeasePrompt,
  PrismaClient,
  type Task,
  TaskStatus,
} from "@agentos/db";

import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";

const execFileAsync = promisify(execFile);

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const DB_DIRECTORY = fileURLToPath(new URL("../../db", import.meta.url));

const runScript = async (script: string): Promise<{ code: number; output: string }> => {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath, ["--import", "tsx", `prisma/${script}`],
      { cwd: DB_DIRECTORY, env: { ...process.env, DATABASE_URL: testDatabaseUrl }, maxBuffer: 8 * 1024 * 1024 },
    );
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error: any) {
    return { code: error.code ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? ""}` };
  }
};

const seed = () => runScript("seed.ts");
const sync = () => runScript("sync-canonical-prompts.ts");
const verify = () => runScript("verify-agent-template.ts");

const integratorStep = async () => db.taskTemplateStep.findFirstOrThrow({
  where: { stepIndex: INTEGRATOR_STEP_INDEX, taskTemplate: { name: INTEGRATOR_TEMPLATE_NAME } },
  include: { assigneeAgent: true, taskTemplate: { include: { steps: true } } },
});

const directTemplate = async () => db.taskTemplate.findUniqueOrThrow({
  where: { projectId_name: { projectId: (await db.project.findUniqueOrThrow({ where: { slug: "agentos-example" } })).id, name: DIRECT_TEMPLATE_NAME } },
  include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
});

/* ------------------------------------------------------ the fresh-seed negative */

test("a fresh seed writes the thirteen-step and eight-step autonomous merge templates", async () => {
  const seeded = await seed();
  assert.equal(seeded.code, 0, seeded.output);

  // Read directly. Not through the verifier, not through the contract module —
  // this is the assertion the verifier's own correctness is allowed to rest on.
  const step = await integratorStep();
  assert.equal(step.taskTemplate.steps.length, 13, "the template has thirteen steps");
  assert.equal(step.opensPullRequest, false, "SF-3: the seeded step-13 row must not open a pull request");
  assert.equal(step.approvalGate, false);
  assert.equal(step.outputKind, INTEGRATOR_OUTPUT_KIND);
  assert.equal(step.assigneeAgent?.name, INTEGRATOR_AGENT_NAME);
  assert.equal(step.assigneeAgent?.model, INTEGRATOR_SENTINEL_MODEL);
  assert.equal(step.spawnPolicy, null);
  assert.equal(step.taskTemplate.steps.find((candidate) => candidate.stepIndex === 7)?.attachmentsFromPrevious, false);
  assert.equal(step.taskTemplate.steps.find((candidate) => candidate.stepIndex === 10)?.assigneeAgentId,
    (await db.agent.findFirstOrThrow({ where: { name: "librarian" } })).id);
  assert.equal(step.taskTemplate.steps.find((candidate) => candidate.stepIndex === 11)?.attachmentsFromPrevious, true);
  assert.match(step.taskTemplate.steps.find((candidate) => candidate.stepIndex === 11)?.prompt ?? "", /merge-lease\.sh acquire --task \{\{chainId\}\}/u);
  assert.match(step.taskTemplate.steps.find((candidate) => candidate.stepIndex === 11)?.prompt ?? "", /exits 75 or 76[\s\S]*up to two[\s\S]*more times/u);
  assert.match(
    step.taskTemplate.steps.find((candidate) => candidate.stepIndex === 3)?.prompt ?? "",
    /vertical slice[\s\S]*blocked_by[\s\S]*expand-migrate-contract[\s\S]*fail at base/iu,
  );

  const opening = step.taskTemplate.steps.filter((candidate) => candidate.opensPullRequest).map((candidate) => candidate.stepIndex);
  assert.deepEqual(opening, [5], "only implementation opens the chain pull request");

  const direct = await directTemplate();
  assert.equal(direct.steps.length, 8);
  assert.equal(direct.steps[0]?.assigneeAgent?.name, "senior-dev-luna");
  assert.equal(direct.steps[0]?.opensPullRequest, true);
  assert.match(direct.steps[0]?.prompt ?? "", /brief is the specification of record/u);
  assert.equal(direct.steps[2]?.attachmentsFromPrevious, false);
  assert.equal(direct.steps[6]?.assigneeType, AssigneeType.AGENT);
  assert.equal(direct.steps[6]?.approvalGate, false);
  assert.equal(direct.steps[6]?.outputKind, "merge-authorization");
  assert.equal(direct.steps[7]?.assigneeAgent?.name, INTEGRATOR_AGENT_NAME);
  assert.equal(direct.steps[7]?.outputKind, INTEGRATOR_OUTPUT_KIND);
  assert.match(direct.steps[5]?.prompt ?? "", /retry it up to three times/u);
  const resolver = await db.agent.findFirstOrThrow({ where: { projectId: step.taskTemplate.projectId, name: "merge-resolver" } });
  assert.equal(resolver.model, "gpt-5.6-sol:high");
  assert.equal(resolver.runnerPreference, "CODEX");
});

test("the verifier passes on a freshly seeded database, and says how many steps it saw", async () => {
  assert.equal((await seed()).code, 0);
  const verified = await verify();
  assert.equal(verified.code, 0, verified.output);
  assert.match(verified.output, /21 steps across 2 templates/u);
});

test("re-seeding is idempotent and does not flip step 13 back", async () => {
  assert.equal((await seed()).code, 0);
  assert.equal((await seed()).code, 0);
  const step = await integratorStep();
  assert.equal(step.opensPullRequest, false, "the update branch of the upsert sets it too, not only create");
  assert.equal(step.taskTemplate.steps.length, 13);
});

test("re-seeding preserves an operator-selected model and runner", async () => {
  assert.equal((await seed()).code, 0);
  const project = await db.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  await db.agent.update({
    where: { projectId_name: { projectId: project.id, name: "spec" } },
    data: { model: "claude-opus-5:medium", runnerPreference: "CLAUDE", runtimeConfigCustomized: true },
  });

  const reseeded = await seed();
  assert.equal(reseeded.code, 0, reseeded.output);
  const spec = await db.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "spec" } },
    select: { model: true, runnerPreference: true, runtimeConfigCustomized: true },
  });
  assert.deepEqual(spec, { model: "claude-opus-5:medium", runnerPreference: "CLAUDE", runtimeConfigCustomized: true });
});

test("canonical sync restores step, merge-resolver role, and foundational prompts when structure matches", async () => {
  assert.equal((await seed()).code, 0);
  const direct = await directTemplate();
  const step = direct.steps[0]!;
  const agent = await db.agent.findFirstOrThrow({ where: { name: "merge-resolver" } });
  await Promise.all([
    db.taskTemplateStep.update({ where: { id: step.id }, data: { prompt: "step prompt drift" } }),
    db.agent.update({ where: { id: agent.id }, data: { foundationalPrompt: "foundation drift", rolePrompt: "role drift" } }),
  ]);

  const synced = await sync();
  assert.equal(synced.code, 0, synced.output);
  const expectedStep = (await loadTemplateStepSources(DIRECT_TEMPLATE_NAME))[0]!;
  const sources = await loadAgentSources();
  const expectedRole = sources.roles.find(({ name }) => name === "merge-resolver")!;
  const [persistedStep, persistedAgent] = await Promise.all([
    db.taskTemplateStep.findUniqueOrThrow({ where: { id: step.id } }),
    db.agent.findUniqueOrThrow({ where: { id: agent.id } }),
  ]);
  assert.equal(persistedStep.prompt, expectedStep.prompt);
  assert.equal(persistedAgent.foundationalPrompt, sources.foundationalPrompt);
  assert.equal(persistedAgent.rolePrompt, expectedRole.rolePrompt);
});

test("canonical sync rolls the regression-first thirteen-step template without rewriting task history", async () => {
  assert.equal((await seed()).code, 0);
  const current = await db.taskTemplate.findFirstOrThrow({
    where: { name: INTEGRATOR_TEMPLATE_NAME },
    include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
  });
  const librarian = current.steps.find((step) => step.stepIndex === 10)!;
  const regression = current.steps.find((step) => step.stepIndex === 11)!;
  await db.taskTemplateStep.update({ where: { id: librarian.id }, data: { stepIndex: 99 } });
  await db.taskTemplateStep.update({ where: { id: regression.id }, data: { stepIndex: 10, layer: 9 } });
  await db.taskTemplateStep.update({ where: { id: librarian.id }, data: { stepIndex: 11, layer: 10 } });

  const oldRegressionTask = await db.task.create({ data: {
    projectId: current.projectId,
    templateId: current.id,
    templateStepId: regression.id,
    name: "Existing regression-first task",
    description: regression.prompt,
    assigneeType: regression.assigneeType,
    assigneeAgentId: regression.assigneeAgentId,
    status: TaskStatus.TODO,
    chainId: `regression-first-rollover-${process.pid}`,
    chainIndex: 10,
    chainLayer: 9,
  } });

  const refused = await sync();
  assert.notEqual(refused.code, 0, refused.output);
  assert.match(refused.output, /still has 1 unfinished tasks/u);
  assert.equal((await db.taskTemplate.findUniqueOrThrow({ where: { id: current.id } })).name, INTEGRATOR_TEMPLATE_NAME);

  await db.task.update({ where: { id: oldRegressionTask.id }, data: { status: TaskStatus.DONE } });
  const synced = await sync();
  assert.equal(synced.code, 0, synced.output);
  assert.match(synced.output, /"createdCanonicalTemplates":1/u);

  const legacy = await db.taskTemplate.findUniqueOrThrow({
    where: { id: current.id },
    include: { steps: { include: { taskTemplate: true }, orderBy: { stepIndex: "asc" } } },
  });
  assert.equal(legacy.name, legacyRegressionFirstThirteenStepTemplateName(current.id));
  assert.equal(legacy.steps[9]?.id, regression.id);
  assert.equal(legacy.steps[9]?.outputKind, "regression-verification");
  assert.equal(legacy.steps[10]?.id, librarian.id);
  assert.equal(legacy.steps[10]?.outputKind, "documentation");
  assert.equal(executionModeFor(legacy.steps[12]), "mechanical");

  const replacement = await db.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: current.projectId, name: INTEGRATOR_TEMPLATE_NAME } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  assert.notEqual(replacement.id, current.id);
  assert.equal(replacement.steps[9]?.outputKind, "documentation");
  assert.equal(replacement.steps[10]?.outputKind, "regression-verification");
  const preserved = await db.task.findUniqueOrThrow({
    where: { id: oldRegressionTask.id },
    include: { templateStep: { include: { taskTemplate: true } } },
  });
  assert.equal(preserved.templateStepId, regression.id);
  assert.equal(preserved.templateStep?.outputKind, "regression-verification");
  assert.equal(preserved.templateStep?.taskTemplate.name, legacy.name);
});

test("canonical sync rolls both pre-lease prompts only after their old tasks finish", async () => {
  assert.equal((await seed()).code, 0);
  const direct = await directTemplate();
  const compound = await db.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: direct.projectId, name: INTEGRATOR_TEMPLATE_NAME } },
    include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
  });
  const oldTemplates = [direct, compound];
  const oldTasks = [];
  for (const template of oldTemplates) {
    const regression = template.steps.find((step) => step.outputKind === "regression-verification")!;
    const oldPrompt = previousChainLeasePrompt(regression.prompt);
    assert.notEqual(oldPrompt, regression.prompt);
    await db.taskTemplateStep.update({ where: { id: regression.id }, data: { prompt: oldPrompt } });
    oldTasks.push(await db.task.create({ data: {
      projectId: template.projectId,
      templateId: template.id,
      templateStepId: regression.id,
      name: `Pre-lease ${template.name}`,
      description: oldPrompt,
      assigneeType: regression.assigneeType,
      assigneeAgentId: regression.assigneeAgentId,
      status: TaskStatus.TODO,
      chainId: `pre-lease-${template.name}-${process.pid}`,
      chainIndex: regression.stepIndex,
      chainLayer: regression.layer,
    } }));
  }

  const refused = await sync();
  assert.notEqual(refused.code, 0, refused.output);
  assert.match(refused.output, /still has 1 unfinished tasks/u);
  for (const task of oldTasks) {
    await db.task.update({ where: { id: task.id }, data: { status: TaskStatus.DONE } });
  }

  const synced = await sync();
  assert.equal(synced.code, 0, synced.output);
  assert.match(synced.output, /"createdCanonicalTemplates":2/u);
  for (const oldTemplate of oldTemplates) {
    const preserved = await db.taskTemplate.findUniqueOrThrow({
      where: { id: oldTemplate.id },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    });
    assert.equal(preserved.name, legacyChainLeaseTemplateName(oldTemplate.name, oldTemplate.id));
    const replacement = await db.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: oldTemplate.projectId, name: oldTemplate.name } },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    });
    assert.notEqual(replacement.id, oldTemplate.id);
    assert.match(replacement.steps.find((step) => step.outputKind === "regression-verification")?.prompt ?? "", /merge-lease\.sh acquire/u);
  }
});

test("canonical sync refuses to mutate instantiated canonical steps", async () => {
  assert.equal((await seed()).code, 0);
  const direct = await directTemplate();
  const compound = await db.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: direct.projectId, name: INTEGRATOR_TEMPLATE_NAME } },
    include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
  });
  const regressionSteps = [
    direct.steps.find(({ stepIndex }) => stepIndex === 6)!,
    compound.steps.find(({ stepIndex }) => stepIndex === 11)!,
  ];
  const opus = await db.agent.findFirstOrThrow({
    where: { projectId: direct.projectId, name: "review-coordinator-opus" },
  });
  await Promise.all(regressionSteps.map((step) => db.taskTemplateStep.update({
    where: { id: step.id }, data: { assigneeAgentId: opus.id, prompt: "previous release prompt" },
  })));
  const existingTasks = await Promise.all(regressionSteps.map((step, index) => db.task.create({ data: {
    projectId: direct.projectId,
    templateId: step.taskTemplateId,
    templateStepId: step.id,
    name: `Already instantiated regression ${index + 1}`,
    description: "legacy assignment",
    assigneeType: "AGENT",
    assigneeAgentId: opus.id,
    status: "TODO",
    chainId: `legacy-chain-${index + 1}`,
    chainIndex: step.stepIndex,
    chainLayer: step.layer,
  } })));

  const synced = await sync();
  assert.notEqual(synced.code, 0, synced.output);
  assert.match(synced.output, /referenced by instantiated tasks/u);
  const [adoptedSteps, migratedTasks] = await Promise.all([
    db.taskTemplateStep.findMany({ where: { id: { in: regressionSteps.map(({ id }) => id) } }, include: { assigneeAgent: true } }),
    db.task.findMany({ where: { id: { in: existingTasks.map(({ id }) => id) } }, include: { assigneeAgent: true } }),
  ]);
  assert.deepEqual(adoptedSteps.map(({ assigneeAgent }) => assigneeAgent?.name), ["review-coordinator-opus", "review-coordinator-opus"]);
  assert.deepEqual(migratedTasks.map(({ assigneeAgent }) => assigneeAgent?.name), ["review-coordinator-opus", "review-coordinator-opus"]);
});

test("canonical sync rejects template structure drift without applying its prompt", async () => {
  assert.equal((await seed()).code, 0);
  const direct = await directTemplate();
  const step = direct.steps[0]!;
  await db.taskTemplateStep.update({
    where: { id: step.id },
    data: { attachmentsFromPrevious: !step.attachmentsFromPrevious, prompt: "step prompt drift" },
  });

  const synced = await sync();
  assert.notEqual(synced.code, 0, synced.output);
  assert.match(synced.output, /attachmentsFromPrevious/u);
  assert.equal((await db.taskTemplateStep.findUniqueOrThrow({ where: { id: step.id } })).prompt, "step prompt drift");
});

test("canonical sync rejects role structure drift without applying its prompts", async () => {
  assert.equal((await seed()).code, 0);
  const agent = await db.agent.findFirstOrThrow({ where: { name: "librarian" } });
  await db.agent.update({
    where: { id: agent.id },
    data: { inboxAccess: !agent.inboxAccess, foundationalPrompt: "foundation drift", rolePrompt: "role drift" },
  });

  const synced = await sync();
  assert.notEqual(synced.code, 0, synced.output);
  assert.match(synced.output, /inboxAccess/u);
  const persisted = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
  assert.equal(persisted.foundationalPrompt, "foundation drift");
  assert.equal(persisted.rolePrompt, "role drift");
});

test("canonical sync ignores a customized same-name agent outside the canonical project", async () => {
  assert.equal((await seed()).code, 0);
  const canonical = await db.agent.findFirstOrThrow({
    where: { name: "default", project: { slug: "agentos-example" } },
  });
  const customProject = await db.project.create({
    data: { name: "Custom", slug: "custom", yamlDocument: "# custom\n" },
  });
  const customEnvironment = await db.environment.create({
    data: { projectId: customProject.id, name: "local", networking: "OPEN", allowedHosts: [] },
  });
  const custom = await db.agent.create({
    data: {
      projectId: customProject.id,
      environmentId: customEnvironment.id,
      name: "default",
      title: "Custom Default",
      model: "custom-model",
      runnerPreference: "CODEX",
      inboxAccess: false,
      foundationalPrompt: "custom foundation",
      rolePrompt: "custom role",
    },
  });
  await db.agent.update({ where: { id: canonical.id }, data: { rolePrompt: "canonical role drift" } });

  const synced = await sync();
  assert.equal(synced.code, 0, synced.output);
  const expected = (await loadAgentSources()).roles.find(({ name }) => name === "default")!;
  const [persistedCanonical, persistedCustom] = await Promise.all([
    db.agent.findUniqueOrThrow({ where: { id: canonical.id } }),
    db.agent.findUniqueOrThrow({ where: { id: custom.id } }),
  ]);
  assert.equal(persistedCanonical.rolePrompt, expected.rolePrompt);
  assert.equal(persistedCustom.title, "Custom Default");
  assert.equal(persistedCustom.foundationalPrompt, "custom foundation");
  assert.equal(persistedCustom.rolePrompt, "custom role");
});

/* ------------------------------------------------------- the verifier negatives */

/** Each of these is a way the contract could be violated in the database while
 *  the source still looks right. A verifier that passes any of them is not a
 *  verifier. */
const negatives: Array<{ name: string; break: () => Promise<void>; expect: RegExp }> = [
  {
    name: "step 13 opening a pull request",
    break: async () => {
      const step = await integratorStep();
      await db.taskTemplateStep.update({ where: { id: step.id }, data: { opensPullRequest: true } });
    },
    expect: /opensPullRequest/u,
  },
  {
    name: "an LLM model on the integrator agent",
    break: async () => {
      await db.agent.updateMany({ where: { name: INTEGRATOR_AGENT_NAME }, data: { model: "claude-opus-5:high" } });
    },
    expect: /model|runner/iu,
  },
  {
    name: "a non-null spawn policy on step 13",
    break: async () => {
      const step = await integratorStep();
      await db.taskTemplateStep.update({ where: { id: step.id }, data: { spawnPolicy: { maxChildren: 1 } } });
    },
    expect: /spawnPolicy/u,
  },
  {
    name: "an eleven-step template",
    break: async () => {
      const step = await integratorStep();
      await db.taskTemplateStep.delete({ where: { id: step.id } });
    },
    expect: /step/iu,
  },
  {
    name: "a thirteenth step",
    break: async () => {
      const step = await integratorStep();
      await db.taskTemplateStep.create({ data: {
        taskTemplateId: step.taskTemplateId, stepIndex: INTEGRATOR_STEP_INDEX + 1, layer: INTEGRATOR_STEP_INDEX + 1, name: "Extra",
        assigneeType: step.assigneeType, assigneeAgentId: step.assigneeAgentId, prompt: "extra",
        approvalGate: false, outputKind: "notes", opensPullRequest: true,
      } });
    },
    expect: /step/iu,
  },
  {
    name: "an upstream attachment on blind-review step 7",
    break: async () => {
      const step = await integratorStep();
      const blind = step.taskTemplate.steps.find((candidate) => candidate.stepIndex === 7)!;
      await db.taskTemplateStep.update({ where: { id: blind.id }, data: { attachmentsFromPrevious: true } });
    },
    expect: /attachmentsFromPrevious/u,
  },
  {
    name: "role frontmatter drift",
    break: async () => {
      const agent = await db.agent.findFirstOrThrow({ where: { name: "librarian" } });
      await db.agent.update({ where: { id: agent.id }, data: { inboxAccess: !agent.inboxAccess } });
    },
    expect: /inboxAccess/u,
  },
  {
    name: "foundational prompt drift",
    break: async () => {
      await db.agent.updateMany({ where: { name: "librarian" }, data: { foundationalPrompt: "drift" } });
    },
    expect: /foundational prompt/u,
  },
  {
    name: "role prompt drift",
    break: async () => {
      await db.agent.updateMany({ where: { name: "librarian" }, data: { rolePrompt: "drift" } });
    },
    expect: /role prompt/u,
  },
];

for (const negative of negatives) {
  test(`the verifier fails on ${negative.name}`, async () => {
    assert.equal((await seed()).code, 0);
    assert.equal((await verify()).code, 0, "the verifier passes before the contract is broken");
    await negative.break();
    const broken = await verify();
    assert.notEqual(broken.code, 0, `the verifier passed with ${negative.name}: ${broken.output}`);
    assert.match(broken.output, negative.expect);
  });
}

/* -------------------------------------------- 10 -> 13: in-flight continuation */

test("re-seeding a historical ten-step template preserves and queues its in-flight integrator", async () => {
  assert.equal((await seed()).code, 0);
  const fresh = await integratorStep();
  const templateId = fresh.taskTemplateId;
  const projectId = fresh.taskTemplate.projectId;
  const agents = new Map((await db.agent.findMany({ where: { projectId } })).map((agent) => [agent.name, agent]));

  // Reconstruct the historical 10-row shape exactly where the routing changed:
  // review, fix, docs, human approval, then physical step-10 mechanical merge.
  await db.taskTemplateStep.deleteMany({ where: { taskTemplateId: templateId, stepIndex: { in: [11, 12, 13] } } });
  const historicalTail = [
    [6, "review-coordinator", AssigneeType.AGENT, "code-review"],
    [7, "senior-dev", AssigneeType.AGENT, "fixed-implementation"],
    [8, "librarian", AssigneeType.AGENT, "documentation"],
    [9, null, AssigneeType.HUMAN, "approval"],
    [10, INTEGRATOR_AGENT_NAME, AssigneeType.AGENT, INTEGRATOR_OUTPUT_KIND],
  ] as const;
  for (const [stepIndex, agentName, assigneeType, outputKind] of historicalTail) {
    const assigneeAgentId = agentName ? agents.get(agentName)!.id : null;
    await db.taskTemplateStep.update({
      where: { taskTemplateId_stepIndex: { taskTemplateId: templateId, stepIndex } },
      data: {
        name: `Historical step ${stepIndex}`,
        assigneeType,
        assigneeAgentId,
        approvalGate: stepIndex === 9,
        outputKind,
        opensPullRequest: false,
      },
    });
  }
  const historicalSteps = await db.taskTemplateStep.findMany({
    where: { taskTemplateId: templateId }, orderBy: { stepIndex: "asc" },
  });
  assert.equal(historicalSteps.length, 10);

  const repo = await db.repo.create({ data: {
    projectId, name: "legacy-upgrade", remoteUrl: "https://github.com/acme/legacy-upgrade.git",
    mountPath: "/scratch/legacy-upgrade", defaultBranch: "main",
  } });
  const integratorAgent = agents.get(INTEGRATOR_AGENT_NAME)!;
  await db.agentRepoAccess.create({ data: {
    projectId, agentId: integratorAgent.id, repoId: repo.id,
    mountPath: "/scratch/legacy-upgrade", permissions: "GIT_WRITE",
  } });

  const chainId = `in-flight-ten-${process.pid}`;
  const tasks: Task[] = [];
  for (const templateStep of historicalSteps) {
    tasks.push(await db.task.create({ data: {
      projectId, repoId: repo.id, templateId, templateStepId: templateStep.id,
      name: templateStep.name, description: templateStep.prompt,
      assigneeType: templateStep.assigneeType, assigneeAgentId: templateStep.assigneeAgentId,
      approvalGate: templateStep.approvalGate, opensPullRequest: templateStep.opensPullRequest,
      chainId, chainIndex: templateStep.stepIndex,
      chainLayer: templateStep.layer,
      status: templateStep.stepIndex < 10 ? TaskStatus.DONE : TaskStatus.TODO,
      targetBranch: "agentos/chain/legacy-upgrade",
    } }));
  }

  // New code re-seeds: the historical template is retained under a deterministic
  // marker and the canonical name is assigned to a different 13-row template.
  assert.equal((await seed()).code, 0);
  const legacy = await db.taskTemplate.findUniqueOrThrow({
    where: { id: templateId }, include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  assert.equal(legacy.name, legacyTenStepTemplateName(templateId));
  assert.equal(legacy.steps.length, 10);
  const canonical = await db.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId, name: INTEGRATOR_TEMPLATE_NAME } },
    include: { steps: true },
  });
  assert.notEqual(canonical.id, templateId);
  assert.equal(canonical.steps.length, 13);

  const oldIntegrator = await db.task.findUniqueOrThrow({
    where: { id: tasks[9]!.id },
    include: { templateStep: { include: { taskTemplate: { select: { name: true } } } } },
  });
  assert.equal(executionModeFor(oldIntegrator.templateStep), "mechanical");

  // The real chain successor path must accept the preserved binding and enqueue
  // the old physical step 10 after its human predecessor completes.
  const advanced = await db.$transaction((tx) => activateChainSuccessor(tx, tasks[8]!));
  assert.deepEqual(advanced, { nextTaskId: oldIntegrator.id, gated: false });
  const queued = await db.run.findFirst({ where: { taskId: oldIntegrator.id }, orderBy: { runNumber: "desc" } });
  assert.ok(queued, "the historical integrator receives a run after re-seed");
  assert.equal(queued.status, "QUEUED");
});

/* ---------------------------------------------- 9 -> 13: foreign-key preservation */

test("re-seeding a historical nine-step template preserves its in-flight task semantics", async () => {
  assert.equal((await seed()).code, 0);
  const fresh = await integratorStep();
  const templateId = fresh.taskTemplateId;
  const projectId = fresh.taskTemplate.projectId;
  const agents = new Map((await db.agent.findMany({ where: { projectId } })).map((agent) => [agent.name, agent]));

  await db.taskTemplateStep.deleteMany({
    where: { taskTemplateId: templateId, stepIndex: { in: [10, 11, 12, 13] } },
  });
  const historicalContract = [
    [1, "Write a spec", "spec", AssigneeType.AGENT, "spec", true],
    [2, "Plan", "plan", AssigneeType.AGENT, "plan", false],
    [3, "Plan review", "review-coordinator", AssigneeType.AGENT, "plan-review", false],
    [4, "Revise plan", "plan-reviser", AssigneeType.AGENT, "revised-plan", true],
    [5, "Implementation", "implementation-plan-executioner", AssigneeType.AGENT, "implementation", false],
    [6, "Code review", "review-coordinator", AssigneeType.AGENT, "code-review", false],
    [7, "Apply review fixes", "senior-dev", AssigneeType.AGENT, "fixed-implementation", false],
    [8, "Librarian", "librarian", AssigneeType.AGENT, "documentation", false],
    [9, "Human PR review", null, AssigneeType.HUMAN, "approval", true],
  ] as const;
  for (const [stepIndex, name, agentName, assigneeType, outputKind, approvalGate] of historicalContract) {
    await db.taskTemplateStep.update({
      where: { taskTemplateId_stepIndex: { taskTemplateId: templateId, stepIndex } },
      data: {
        name,
        assigneeType,
        assigneeAgentId: agentName ? agents.get(agentName)!.id : null,
        approvalGate,
        outputKind,
      },
    });
  }
  const historicalSteps = await db.taskTemplateStep.findMany({
    where: { taskTemplateId: templateId }, orderBy: { stepIndex: "asc" },
  });
  assert.deepEqual(historicalSteps.map((step) => step.stepIndex), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const beforeSemantics = historicalSteps.map((step) => ({
    id: step.id,
    stepIndex: step.stepIndex,
    name: step.name,
    assigneeType: step.assigneeType,
    assigneeAgentId: step.assigneeAgentId,
    approvalGate: step.approvalGate,
    outputKind: step.outputKind,
  }));

  const reviewStep = historicalSteps[5]!;
  const repo = await db.repo.create({ data: {
    projectId, name: "legacy-nine-upgrade", remoteUrl: "https://github.com/acme/legacy-nine-upgrade.git",
    mountPath: "/scratch/legacy-nine-upgrade", defaultBranch: "main",
  } });
  const inFlight = await db.task.create({ data: {
    projectId, repoId: repo.id, templateId, templateStepId: reviewStep.id,
    name: reviewStep.name, description: reviewStep.prompt,
    assigneeType: reviewStep.assigneeType, assigneeAgentId: reviewStep.assigneeAgentId,
    approvalGate: reviewStep.approvalGate, opensPullRequest: reviewStep.opensPullRequest,
    chainId: `in-flight-nine-${process.pid}`, chainIndex: reviewStep.stepIndex,
    chainLayer: reviewStep.layer,
    status: TaskStatus.DOING, targetBranch: "agentos/chain/legacy-nine-upgrade",
  } });
  await db.taskStepOutput.create({ data: {
    taskId: inFlight.id, kind: reviewStep.outputKind, body: "historical review",
  } });

  assert.equal((await seed()).code, 0);
  const legacy = await db.taskTemplate.findUniqueOrThrow({
    where: { id: templateId }, include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  assert.equal(legacy.name, legacyNineStepTemplateName(templateId));
  assert.deepEqual(legacy.steps.map((step) => ({
    id: step.id,
    stepIndex: step.stepIndex,
    name: step.name,
    assigneeType: step.assigneeType,
    assigneeAgentId: step.assigneeAgentId,
    approvalGate: step.approvalGate,
    outputKind: step.outputKind,
  })), beforeSemantics);

  const canonical = await db.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId, name: INTEGRATOR_TEMPLATE_NAME } },
    include: { steps: true },
  });
  assert.notEqual(canonical.id, templateId);
  assert.equal(canonical.steps.length, 13);

  const preserved = await db.task.findUniqueOrThrow({
    where: { id: inFlight.id },
    include: {
      stepOutput: true,
      templateStep: { include: { assigneeAgent: true, taskTemplate: true } },
    },
  });
  assert.equal(preserved.templateId, templateId);
  assert.equal(preserved.templateStepId, reviewStep.id);
  assert.equal(preserved.templateStep?.taskTemplate.name, legacyNineStepTemplateName(templateId));
  assert.equal(preserved.templateStep?.name, "Code review");
  assert.equal(preserved.templateStep?.assigneeAgent?.name, "review-coordinator");
  assert.equal(preserved.templateStep?.outputKind, "code-review");
  assert.equal(preserved.stepOutput?.kind, "code-review");
});
