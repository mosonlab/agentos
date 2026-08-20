/**
 * Step 7 / SF-3 — the seeded twelve-step template, and the verifier that guards it.
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
  executionModeFor,
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_OUTPUT_KIND,
  INTEGRATOR_SENTINEL_MODEL,
  INTEGRATOR_STEP_INDEX,
  INTEGRATOR_TEMPLATE_NAME,
  legacyTenStepTemplateName,
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
const verify = () => runScript("verify-agent-template.ts");

const integratorStep = async () => db.taskTemplateStep.findFirstOrThrow({
  where: { stepIndex: INTEGRATOR_STEP_INDEX, taskTemplate: { name: INTEGRATOR_TEMPLATE_NAME } },
  include: { assigneeAgent: true, taskTemplate: { include: { steps: true } } },
});

/* ------------------------------------------------------ the fresh-seed negative */

test("a fresh seed writes a twelve-step template whose step 12 is mechanical", async () => {
  const seeded = await seed();
  assert.equal(seeded.code, 0, seeded.output);

  // Read directly. Not through the verifier, not through the contract module —
  // this is the assertion the verifier's own correctness is allowed to rest on.
  const step = await integratorStep();
  assert.equal(step.taskTemplate.steps.length, 12, "the template has twelve steps");
  assert.equal(step.opensPullRequest, false, "SF-3: the seeded step-12 row must not open a pull request");
  assert.equal(step.approvalGate, false);
  assert.equal(step.outputKind, INTEGRATOR_OUTPUT_KIND);
  assert.equal(step.assigneeAgent?.name, INTEGRATOR_AGENT_NAME);
  assert.equal(step.assigneeAgent?.model, INTEGRATOR_SENTINEL_MODEL);
  assert.equal(step.spawnPolicy, null);
  assert.equal(step.taskTemplate.steps.find((candidate) => candidate.stepIndex === 7)?.attachmentsFromPrevious, false);
  assert.equal(step.taskTemplate.steps.find((candidate) => candidate.stepIndex === 9)?.attachmentsFromPrevious, true);
  assert.match(
    step.taskTemplate.steps.find((candidate) => candidate.stepIndex === 3)?.prompt ?? "",
    /vertical slice[\s\S]*blocked_by[\s\S]*expand-migrate-contract[\s\S]*fail at base/iu,
  );

  const opening = step.taskTemplate.steps.filter((candidate) => candidate.opensPullRequest).map((candidate) => candidate.stepIndex);
  assert.deepEqual(opening, [5], "only implementation opens the chain pull request");
});

test("the verifier passes on a freshly seeded database, and says how many steps it saw", async () => {
  assert.equal((await seed()).code, 0);
  const verified = await verify();
  assert.equal(verified.code, 0, verified.output);
  assert.match(verified.output, /12 steps/u);
});

test("re-seeding is idempotent and does not flip step 12 back", async () => {
  assert.equal((await seed()).code, 0);
  assert.equal((await seed()).code, 0);
  const step = await integratorStep();
  assert.equal(step.opensPullRequest, false, "the update branch of the upsert sets it too, not only create");
  assert.equal(step.taskTemplate.steps.length, 12);
});

/* ------------------------------------------------------- the verifier negatives */

/** Each of these is a way the contract could be violated in the database while
 *  the source still looks right. A verifier that passes any of them is not a
 *  verifier. */
const negatives: Array<{ name: string; break: () => Promise<void>; expect: RegExp }> = [
  {
    name: "step 12 opening a pull request",
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
    name: "a non-null spawn policy on step 12",
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
        taskTemplateId: step.taskTemplateId, stepIndex: INTEGRATOR_STEP_INDEX + 1, name: "Extra",
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

/* -------------------------------------------- 10 -> 12: in-flight continuation */

test("re-seeding a historical ten-step template preserves and queues its in-flight integrator", async () => {
  assert.equal((await seed()).code, 0);
  const fresh = await integratorStep();
  const templateId = fresh.taskTemplateId;
  const projectId = fresh.taskTemplate.projectId;
  const agents = new Map((await db.agent.findMany({ where: { projectId } })).map((agent) => [agent.name, agent]));

  // Reconstruct the historical 10-row shape exactly where the routing changed:
  // review, fix, docs, human approval, then physical step-10 mechanical merge.
  await db.taskTemplateStep.deleteMany({ where: { taskTemplateId: templateId, stepIndex: { in: [11, 12] } } });
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
      status: templateStep.stepIndex < 10 ? TaskStatus.DONE : TaskStatus.TODO,
      targetBranch: "agentos/chain/legacy-upgrade",
    } }));
  }

  // New code re-seeds: the historical template is retained under a deterministic
  // marker and the canonical name is assigned to a different 12-row template.
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
  assert.equal(canonical.steps.length, 12);

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
