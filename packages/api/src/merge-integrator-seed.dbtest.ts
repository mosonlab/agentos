/**
 * Step 7 / SF-3 — the seeded ten-step template, and the verifier that guards it.
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
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_OUTPUT_KIND,
  INTEGRATOR_SENTINEL_MODEL,
  INTEGRATOR_STEP_INDEX,
  INTEGRATOR_TEMPLATE_NAME,
  PrismaClient,
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

test("a fresh seed writes a ten-step template whose step 10 publishes nothing", async () => {
  const seeded = await seed();
  assert.equal(seeded.code, 0, seeded.output);

  // Read directly. Not through the verifier, not through the contract module —
  // this is the assertion the verifier's own correctness is allowed to rest on.
  const step = await integratorStep();
  assert.equal(step.taskTemplate.steps.length, 10, "the template has ten steps");
  assert.equal(step.opensPullRequest, false, "SF-3: the seeded step-10 row must not open a pull request");
  assert.equal(step.approvalGate, false);
  assert.equal(step.outputKind, INTEGRATOR_OUTPUT_KIND);
  assert.equal(step.assigneeAgent?.name, INTEGRATOR_AGENT_NAME);
  assert.equal(step.assigneeAgent?.model, INTEGRATOR_SENTINEL_MODEL);
  assert.equal(step.spawnPolicy, null);

  // And the nine steps before it are unchanged in the property SF-3 is about.
  const others = step.taskTemplate.steps.filter((candidate) => candidate.stepIndex !== INTEGRATOR_STEP_INDEX);
  assert.deepEqual([...new Set(others.map((candidate) => candidate.opensPullRequest))], [true]);
});

test("the verifier passes on a freshly seeded database, and says how many steps it saw", async () => {
  assert.equal((await seed()).code, 0);
  const verified = await verify();
  assert.equal(verified.code, 0, verified.output);
  assert.match(verified.output, /10 steps/u);
});

test("re-seeding is idempotent and does not flip step 10 back", async () => {
  assert.equal((await seed()).code, 0);
  assert.equal((await seed()).code, 0);
  const step = await integratorStep();
  assert.equal(step.opensPullRequest, false, "the update branch of the upsert sets it too, not only create");
  assert.equal(step.taskTemplate.steps.length, 10);
});

/* ------------------------------------------------------- the verifier negatives */

/** Each of these is a way the contract could be violated in the database while
 *  the source still looks right. A verifier that passes any of them is not a
 *  verifier. */
const negatives: Array<{ name: string; break: () => Promise<void>; expect: RegExp }> = [
  {
    name: "step 10 opening a pull request",
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
    name: "a non-null spawn policy on step 10",
    break: async () => {
      const step = await integratorStep();
      await db.taskTemplateStep.update({ where: { id: step.id }, data: { spawnPolicy: { maxChildren: 1 } } });
    },
    expect: /spawnPolicy/u,
  },
  {
    name: "a nine-step template",
    break: async () => {
      const step = await integratorStep();
      await db.taskTemplateStep.delete({ where: { id: step.id } });
    },
    expect: /step/iu,
  },
  {
    name: "an eleventh step",
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

/* ---------------------------------------------------------- A4: in-flight chains */

test("a chain instantiated before the tenth step exists keeps its nine tasks", async () => {
  assert.equal((await seed()).code, 0);
  const step = await integratorStep();
  const templateId = step.taskTemplateId;
  const projectId = step.taskTemplate.projectId;

  // Stand the world back up as it was before this change: a nine-step template.
  await db.taskTemplateStep.delete({ where: { id: step.id } });
  const nineStepSteps = await db.taskTemplateStep.findMany({ where: { taskTemplateId: templateId }, orderBy: { stepIndex: "asc" } });
  assert.equal(nineStepSteps.length, 9);

  const chainId = `in-flight-${process.pid}`;
  for (const templateStep of nineStepSteps) {
    await db.task.create({ data: {
      projectId, templateId, templateStepId: templateStep.id, name: templateStep.name,
      description: templateStep.prompt, assigneeType: templateStep.assigneeType,
      assigneeAgentId: templateStep.assigneeAgentId, approvalGate: templateStep.approvalGate,
      opensPullRequest: templateStep.opensPullRequest, chainId, chainIndex: templateStep.stepIndex,
    } });
  }
  const before = await db.task.findMany({ where: { chainId }, orderBy: { chainIndex: "asc" } });

  // Now seed the ten-step template on top, exactly as an upgrade would.
  assert.equal((await seed()).code, 0);
  assert.equal((await db.taskTemplateStep.count({ where: { taskTemplateId: templateId } })), 10);

  // `templates.ts` materializes task rows at creation time and the task row is
  // the runtime authority, so an in-flight chain is not rewritten by a template
  // that grew a step under it.
  const after = await db.task.findMany({ where: { chainId }, orderBy: { chainIndex: "asc" } });
  assert.equal(after.length, 9, "the in-flight chain still has nine tasks");
  assert.deepEqual(
    after.map((task) => ({ index: task.chainIndex, step: task.templateStepId, opens: task.opensPullRequest })),
    before.map((task) => ({ index: task.chainIndex, step: task.templateStepId, opens: task.opensPullRequest })),
  );
});
