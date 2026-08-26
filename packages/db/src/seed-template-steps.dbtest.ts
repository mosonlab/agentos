/**
 * The internal seed's template graphs are installed atomically.
 *
 * Requires a scratch PostgreSQL server. It creates and drops its own schema
 * and never touches an existing one.
 *
 *   AGENTOS_ALLOW_SCRATCH_DATABASES=1 \
 *   TEST_DATABASE_URL=postgresql://...:55777/...?schema=... \
 *     npm run test:db -w @agentos/db -- src/seed-template-steps.dbtest.ts
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { PrismaClient, TaskStatus } from "@prisma/client";

const packageRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/+$/u, "");

const scratchServer = (): URL => {
  if (process.env["AGENTOS_ALLOW_SCRATCH_DATABASES"] !== "1") throw new Error("scratch-database-opt-in-required");
  const raw = process.env["TEST_DATABASE_URL"];
  if (!raw) throw new Error("scratch-test-database-url-required");
  const url = new URL(raw);
  if (!url.protocol.startsWith("postgres")) throw new Error("scratch-database-postgresql-required");
  if ((url.port || "5432") === "5432") throw new Error("scratch-database-refuses-port-5432");
  return url;
};

const server = scratchServer();
const schema = `seed_template_steps_${randomBytes(4).toString("hex")}`;
const databaseUrl = (() => {
  const url = new URL(server.href);
  url.searchParams.set("schema", schema);
  return url.href;
})();
const command = (args: string[]) => {
  const result = spawnSync("npx", args, {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

const commandAsync = (args: string[]): Promise<{ status: number | null; output: string }> => new Promise((resolve, reject) => {
  const child = spawn("npx", args, {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.once("error", reject);
  child.once("close", (status) => resolve({ status, output }));
});

let prisma: PrismaClient;

before(async () => {
  const migrated = command(["prisma", "migrate", "deploy"]);
  assert.equal(migrated.status, 0, migrated.output);
  const seeded = command(["tsx", "prisma/seed.ts"]);
  assert.equal(seeded.status, 0, seeded.output);
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.$connect();
});

after(async () => {
  await prisma?.$disconnect();
  const admin = new PrismaClient({ datasources: { db: { url: server.href } } });
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await admin.$disconnect();
  }
});

test("seed rolls back template creation and earlier steps when a later step fails", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const direct = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "direct-engineer-workflow" } },
    select: { id: true },
  });
  await prisma.taskTemplate.delete({ where: { id: direct.id } });

  const suffix = randomBytes(4).toString("hex");
  const functionName = `seed_template_steps_fail_${suffix}`;
  const triggerName = `seed_template_steps_fail_${suffix}`;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."stepIndex" = 4 AND EXISTS (
          SELECT 1 FROM "TaskTemplate"
          WHERE "id" = NEW."taskTemplateId"
            AND "name" = 'direct-engineer-workflow'
        ) THEN
          RAISE EXCEPTION 'injected template-step seed failure';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT OR UPDATE ON "TaskTemplateStep"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"();
    `);

    const failed = command(["tsx", "prisma/seed.ts"]);
    assert.notEqual(failed.status, 0, failed.output);
    assert.match(failed.output, /injected template-step seed failure/u);

    const rolledBack = await prisma.taskTemplate.findUnique({
      where: { projectId_name: { projectId: project.id, name: "direct-engineer-workflow" } },
      include: { steps: true },
    });
    assert.equal(rolledBack, null);
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "TaskTemplateStep"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    const restored = command(["tsx", "prisma/seed.ts"]);
    assert.equal(restored.status, 0, restored.output);
  }
});

test("seed locks a legacy template row before counting a concurrent task insert", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const template = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "direct-engineer-workflow" } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  const source = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "review-coordinator-opus" } },
  });
  const adjudicator = await prisma.agent.create({ data: {
    projectId: project.id,
    environmentId: source.environmentId,
    name: "review-adjudicator-opus",
    title: "Review Adjudicator (Opus)",
    model: source.model,
    foundationalPrompt: source.foundationalPrompt,
    rolePrompt: source.rolePrompt,
    runnerPreference: source.runnerPreference,
  } });
  for (const step of [...template.steps].reverse()) {
    if (step.stepIndex < 4) continue;
    await prisma.taskTemplateStep.update({
      where: { id: step.id },
      data: { stepIndex: step.stepIndex + 1, layer: step.layer + 1 },
    });
  }
  const adjudicationStep = await prisma.taskTemplateStep.create({ data: {
    taskTemplateId: template.id,
    stepIndex: 4,
    layer: 3,
    name: "Opus adjudication",
    assigneeAgentId: adjudicator.id,
    assigneeType: "AGENT",
    approvalGate: false,
    outputKind: "must-fix",
    attachmentsFromPrevious: true,
    opensPullRequest: false,
    baseFromStepIndex: 1,
    prompt: "Adjudicate the two review reports for direct-engineer-workflow.",
  } });

  let releaseTransaction!: () => void;
  const transactionReleased = new Promise<void>((resolve) => { releaseTransaction = resolve; });
  let taskInserted!: () => void;
  const taskInsertedPromise = new Promise<void>((resolve) => { taskInserted = resolve; });
  const heldTransaction = prisma.$transaction(async (tx) => {
    const task = await tx.task.create({ data: {
      projectId: project.id,
      templateId: template.id,
      templateStepId: adjudicationStep.id,
      name: "Concurrent seed rollover task",
      description: "The insert holds the template foreign-key key-share lock.",
      assigneeType: adjudicationStep.assigneeType,
      assigneeAgentId: adjudicationStep.assigneeAgentId,
      status: TaskStatus.TODO,
      chainId: `concurrent-seed-rollover-${template.id}`,
      chainIndex: adjudicationStep.stepIndex,
      chainLayer: adjudicationStep.layer,
    } });
    taskInserted();
    await transactionReleased;
    return task.id;
  }, { timeout: 30_000 });

  await taskInsertedPromise;
  const seeding = commandAsync(["tsx", "prisma/seed.ts"]);
  try {
    let observed = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiters = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS "count"
        FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND query ILIKE '%TaskTemplate%'
          AND query ILIKE '%FOR UPDATE%'
      `;
      if (Number(waiters[0]?.count ?? 0) > 0) {
        observed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(observed, true, "seed must lock the template row before it counts unfinished tasks");
  } finally {
    releaseTransaction();
  }

  const taskId = await heldTransaction;
  const refused = await seeding;
  assert.notEqual(refused.status, 0, refused.output);
  assert.match(refused.output, /canonical-rollover-refused:unfinished-tasks/u);
  assert.equal((await prisma.taskTemplate.findUniqueOrThrow({ where: { id: template.id } })).name, "direct-engineer-workflow");
  await prisma.task.update({ where: { id: taskId }, data: { status: TaskStatus.DONE } });
  const seeded = command(["tsx", "prisma/seed.ts"]);
  assert.equal(seeded.status, 0, seeded.output);
});
