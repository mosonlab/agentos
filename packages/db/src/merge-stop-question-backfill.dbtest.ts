/**
 * Acceptance coverage for the one-off merge-stop question repair. This test
 * deliberately goes through PostgreSQL: the candidate relation filter, Task
 * lock, JSON activity history, Inbox dedupe constraint, and transaction
 * rollback are all database behavior that an in-memory fake cannot witness.
 *
 * Requires a scratch PostgreSQL URL. The test owns a uniquely named schema and
 * drops it on exit.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { AssigneeType, PrismaClient, TaskStatus } from "@prisma/client";

import {
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_OUTPUT_KIND,
  INTEGRATOR_SENTINEL_MODEL,
  MERGE_INTEGRATOR_KIND,
  MERGE_INTEGRATOR_SCHEMA_VERSION,
} from "./merge-integrator.js";
import { landIntegratorStop } from "./merge-integrator-db.js";
import {
  backfillMergeStopQuestions,
  type MergeStopQuestionBackfillDatabase,
} from "./merge-stop-question-backfill.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/+$/u, "");

const scratchServer = (): URL => {
  if (process.env["AGENTOS_ALLOW_SCRATCH_DATABASES"] !== "1") throw new Error("scratch-database-opt-in-required");
  const raw = process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
  if (!raw) throw new Error("scratch-test-database-url-required");
  const url = new URL(raw);
  if (!url.protocol.startsWith("postgres")) throw new Error("scratch-database-postgresql-required");
  if ((url.port || "5432") === "5432") throw new Error("scratch-database-refuses-port-5432");
  return url;
};

const server = scratchServer();
const schema = `merge_stop_backfill_${randomBytes(4).toString("hex")}`;
const databaseUrl = (() => {
  const url = new URL(server.href);
  url.searchParams.set("schema", schema);
  return url.href;
})();

const migrate = (): void => {
  const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  assert.equal(result.status, 0, `${result.stdout ?? ""}${result.stderr ?? ""}`);
};

let db: PrismaClient;
let projectId: string;
let stepId: string;
let agentId: string;

before(async () => {
  migrate();
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await db.$connect();
  const project = await db.project.create({ data: {
    name: "Merge-stop backfill",
    slug: `merge-stop-backfill-${schema}`,
  } });
  projectId = project.id;
  const environment = await db.environment.create({ data: {
    projectId,
    name: "local",
    allowedHosts: [],
  } });
  const agent = await db.agent.create({ data: {
    projectId,
    environmentId: environment.id,
    name: INTEGRATOR_AGENT_NAME,
    title: "Merge integrator",
    model: INTEGRATOR_SENTINEL_MODEL,
    foundationalPrompt: "foundation",
    rolePrompt: "mechanical",
  } });
  agentId = agent.id;
  const template = await db.taskTemplate.create({ data: {
    projectId,
    name: "compound-engineer-workflow",
    description: "merge stop backfill fixture",
    variables: [],
  } });
  const step = await db.taskTemplateStep.create({ data: {
    taskTemplateId: template.id,
    stepIndex: 12,
    layer: 12,
    name: "Merge",
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: agent.id,
    prompt: "merge",
    outputKind: INTEGRATOR_OUTPUT_KIND,
    opensPullRequest: false,
  } });
  stepId = step.id;
});

after(async () => {
  await db?.$disconnect();
  const admin = new PrismaClient({ datasources: { db: { url: server.href } } });
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema.replaceAll('"', '""')}" CASCADE`);
  } finally {
    await admin.$disconnect();
  }
});

const createStop = async (input: {
  label: string;
  condition: string;
  archived?: boolean;
  terminal?: boolean;
}) => {
  const task = await db.task.create({ data: {
    projectId,
    templateId: (await db.taskTemplate.findFirstOrThrow({ where: { projectId } })).id,
    templateStepId: stepId,
    name: input.label,
    description: input.label,
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: agentId,
    status: TaskStatus.REVIEW,
    archivedAt: input.archived ? new Date() : null,
  } });
  const run = await db.run.create({ data: {
    projectId,
    taskId: task.id,
    agentId,
    runNumber: 1,
    dedupeKey: `merge-stop-backfill:${task.id}:run:1`,
    runner: "CLAUDE",
    model: INTEGRATOR_SENTINEL_MODEL,
    status: "SUCCEEDED",
  } });
  const session = await db.session.create({ data: {
    runId: run.id,
    projectId,
    taskId: task.id,
    agentId,
    runner: "CLAUDE",
    executionStatus: "SUCCEEDED",
  } });
  const stop = await db.taskActivity.create({ data: {
    taskId: task.id,
    actorType: "session",
    actorId: "merge-executor-1",
    body: `Mechanical merge stopped: ${input.condition}`,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    metadata: {
      kind: MERGE_INTEGRATOR_KIND.result,
      schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
      outcome: "stopped",
      condition: input.condition,
      evidence: `${input.label} evidence`,
      sourceRunId: run.id,
    },
  } });
  if (input.terminal) await db.taskActivity.create({ data: {
    taskId: task.id,
    actorType: "operator",
    body: "accepted",
    createdAt: new Date("2026-09-01T00:01:00.000Z"),
    metadata: {
      kind: MERGE_INTEGRATOR_KIND.stopAnswer,
      schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
      stopId: stop.id,
      condition: input.condition,
      choice: "accept",
      disposition: "terminal-done",
    },
  } });
  return { task, run, session, stop };
};

test("repairs one active incident, then remains idempotent while skipping protected history", async () => {
  const active = await createStop({ label: "active incident", condition: "base-drift-post-merge" });
  const terminal = await createStop({ label: "answered incident", condition: "base-drift-post-merge", terminal: true });
  const archived = await createStop({ label: "archived incident", condition: "base-drift-post-merge", archived: true });
  const ordinary = await createStop({ label: "ordinary base drift", condition: "base-drift" });

  const first = await backfillMergeStopQuestions(db as unknown as MergeStopQuestionBackfillDatabase);
  assert.deepEqual(first, {
    scanned: 4,
    created: 1,
    alreadyPresent: 0,
    deferredOrdinaryBaseDrift: 1,
    skipped: 2,
    failed: 0,
  });

  const activeCard = await db.inboxMessage.findUniqueOrThrow({
    where: { dedupeKey: `merge-stop:${active.stop.id}` },
  });
  assert.equal(activeCard.status, "OPEN");
  assert.equal(activeCard.kind, "MULTIPLE_CHOICE");
  assert.deepEqual((activeCard.choices as Array<{ id: string }>).map((choice) => choice.id), ["accept", "revert"]);
  assert.equal(activeCard.agentId, agentId);
  assert.equal(activeCard.sessionId, active.session.id);
  assert.equal(await db.inboxMessage.count({ where: { taskId: { in: [terminal.task.id, archived.task.id, ordinary.task.id] } } }), 0);

  const second = await backfillMergeStopQuestions(db as unknown as MergeStopQuestionBackfillDatabase);
  assert.deepEqual(second, {
    scanned: 4,
    created: 0,
    alreadyPresent: 1,
    deferredOrdinaryBaseDrift: 1,
    skipped: 2,
    failed: 0,
  });
  assert.equal(await db.inboxMessage.count({ where: { dedupeKey: `merge-stop:${active.stop.id}` } }), 1);
});

test("stop landing rolls back an Inbox failure and concurrent replay observes one winner", async () => {
  const fixture = await createStop({ label: "transaction boundary", condition: "base-drift-post-merge" });
  await db.taskActivity.delete({ where: { id: fixture.stop.id } });
  await db.task.update({
    where: { id: fixture.task.id },
    data: { status: TaskStatus.TODO, failureReason: null },
  });

  await assert.rejects(
    db.$transaction(async (tx) => {
      const failingInbox = new Proxy(tx.inboxMessage, {
        get(target, property, receiver) {
          if (property === "create") return async () => { throw new Error("forced Inbox insert failure"); };
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const failingTx = new Proxy(tx, {
        get(target, property, receiver) {
          if (property === "inboxMessage") return failingInbox;
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return landIntegratorStop(failingTx, {
        integratorTaskId: fixture.task.id,
        condition: "base-drift-post-merge",
        evidence: "merge commit 8bfa2f08 landed",
        sourceRunId: fixture.run.id,
      });
    }),
    /forced Inbox insert failure/u,
  );
  assert.equal(await db.taskActivity.count({ where: { taskId: fixture.task.id } }), 0);
  const rolledBackTask = await db.task.findUniqueOrThrow({ where: { id: fixture.task.id } });
  assert.equal(rolledBackTask.status, TaskStatus.TODO);
  assert.equal(rolledBackTask.failureReason, null);

  const landed = await db.$transaction((tx) => landIntegratorStop(tx, {
    integratorTaskId: fixture.task.id,
    condition: "base-drift-post-merge",
    evidence: "merge commit 8bfa2f08 landed",
    sourceRunId: fixture.run.id,
  }));
  assert.ok(landed.questionId);
  assert.equal(await db.taskActivity.count({ where: { taskId: fixture.task.id } }), 1);
  assert.equal(await db.inboxMessage.count({ where: { dedupeKey: `merge-stop:${landed.stopId}` } }), 1);

  await db.inboxMessage.delete({ where: { dedupeKey: `merge-stop:${landed.stopId}` } });
  const concurrent = await Promise.all(Array.from({ length: 6 }, () =>
    db.$transaction((tx) => landIntegratorStop(tx, {
      integratorTaskId: fixture.task.id,
      resultActivityId: landed.stopId,
    })),
  ));
  assert.equal(concurrent.filter((result) => result.questionId !== null).length, 1);
  assert.equal(await db.inboxMessage.count({ where: { dedupeKey: `merge-stop:${landed.stopId}` } }), 1);
  assert.equal(await db.taskActivity.count({ where: { taskId: fixture.task.id } }), 1);
});
