import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  auditPostDeliveryDisconnects,
  formatPostDeliveryDisconnectAudit,
  PrismaClient,
  POST_DELIVERY_DISCONNECT_FIX_MERGED_AT,
  runAuditPostDeliveryDisconnectCli,
  type PostDeliveryDisconnectAuditDatabase,
} from "@anneal/db";

import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const seedRun = async (label: string, terminalPayload: Record<string, unknown> | null, providerError: string) => {
  const project = await db.project.create({ data: {
    name: `Disconnect audit ${label}`,
    slug: `disconnect-audit-${label}-${Date.now()}-${Math.round(performance.now() * 1000)}`,
  } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: "agent",
    title: "Agent",
    model: "claude",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: "repo",
    remoteUrl: "https://example.test/repo.git",
    mountPath: "/repo",
  } });
  const task = await db.task.create({ data: {
    projectId: project.id,
    name: `Task ${label}`,
    description: "disconnect audit",
    assigneeAgentId: agent.id,
    repoId: repo.id,
    chainId: `chain-${label}`,
    chainIndex: 0,
    chainLayer: 0,
    status: "DONE",
  } });
  const completedAt = new Date("2026-08-31T17:00:03.000Z");
  const run = await db.run.create({ data: {
    projectId: project.id,
    taskId: task.id,
    agentId: agent.id,
    repoId: repo.id,
    runNumber: 1,
    dedupeKey: `task:${task.id}:run:1`,
    runner: "CLAUDE",
    status: "SUCCEEDED",
    model: "claude",
    promptHash: "hash",
    startedAt: new Date("2026-08-31T17:00:00.000Z"),
    endedAt: completedAt,
  } });
  const session = await db.session.create({ data: {
    runId: run.id,
    projectId: project.id,
    agentId: agent.id,
    taskId: task.id,
    runner: "CLAUDE",
    executionStatus: "SUCCEEDED",
    startedAt: new Date("2026-08-31T17:00:00.000Z"),
    endedAt: completedAt,
  } });
  if (terminalPayload) await db.sessionEvent.create({ data: {
    sessionId: session.id,
    runId: run.id,
    seq: 1,
    at: new Date("2026-08-31T17:00:01.000Z"),
    source: "CLAUDE",
    type: "FINAL_OUTPUT",
    payload: terminalPayload as never,
  } });
  await db.taskActivity.create({ data: {
    taskId: task.id,
    actorType: "runner",
    body: `A provider disconnect after delivery was tolerated: ${providerError}`,
    metadata: { stream: "runner" },
    createdAt: new Date("2026-08-31T17:00:02.000Z"),
  } });
  return { run, task };
};

test("the audit lists a promoted explicit failure and skips a genuine recovery", async () => {
  const promoted = await seedRun(
    "promoted-failure",
    { type: "result", is_error: true, terminal_reason: "error", result: "provider failed" },
    "provider failed",
  );
  await seedRun("genuine-recovery", null, "Reconnecting... 2/5");

  const before = await db.$queryRaw<Array<{ runs: bigint; activities: bigint }>>`
    SELECT
      (SELECT count(*) FROM "Run") AS runs,
      (SELECT count(*) FROM "TaskActivity") AS activities
  `;
  const rows = await auditPostDeliveryDisconnects(db as unknown as PostDeliveryDisconnectAuditDatabase);
  const after = await db.$queryRaw<Array<{ runs: bigint; activities: bigint }>>`
    SELECT
      (SELECT count(*) FROM "Run") AS runs,
      (SELECT count(*) FROM "TaskActivity") AS activities
  `;

  assert.deepEqual(rows, [{
    runId: promoted.run.id,
    taskId: promoted.task.id,
    chainId: "chain-promoted-failure",
    providerError: "provider failed",
  }]);
  assert.deepEqual(after, before, "the audit is read-only");

  const lines: string[] = [];
  assert.equal(await runAuditPostDeliveryDisconnectCli({
    db: db as unknown as PostDeliveryDisconnectAuditDatabase,
    log: (line) => lines.push(line),
  }), 0);
  assert.deepEqual(lines, formatPostDeliveryDisconnectAudit(rows));
  assert.match(lines[0] ?? "", /^runId\ttaskId\tchainId\tproviderError$/u);
  assert.match(lines[1] ?? "", new RegExp(`^${promoted.run.id}\\t${promoted.task.id}\\tchain-promoted-failure\\tprovider failed$`, "u"));
  assert.equal(POST_DELIVERY_DISCONNECT_FIX_MERGED_AT, "2026-08-31T16:52:56.000Z");
});
