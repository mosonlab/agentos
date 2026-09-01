import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  PrismaClient,
  runBackfillSessionCacheUsageCli,
  type SessionCacheBackfillDatabase,
} from "@anneal/db";

import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const seedSession = async (label: string, sessionId?: string) => {
  const unique = `${label}-${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const project = await db.project.create({ data: { name: "Usage backfill", slug: `usage-backfill-${unique}` } });
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
    name: `Task ${unique}`,
    description: "usage backfill",
    assigneeAgentId: agent.id,
    repoId: repo.id,
  } });
  const run = await db.run.create({ data: {
    projectId: project.id,
    taskId: task.id,
    agentId: agent.id,
    repoId: repo.id,
    runNumber: 1,
    dedupeKey: `task:${task.id}:run:1`,
    runner: "CLAUDE",
    status: "RUNNING",
    model: "claude",
    promptHash: "hash",
  } });
  const session = await db.session.create({ data: {
    ...(sessionId ? { id: sessionId } : {}),
    runId: run.id,
    projectId: project.id,
    agentId: agent.id,
    taskId: task.id,
    runner: "CLAUDE",
    executionStatus: "RUNNING",
  } });
  return { session, run };
};

const addFinalOutput = async (
  target: { session: { id: string }; run: { id: string } },
  payload: unknown,
): Promise<void> => {
  await db.sessionEvent.create({ data: {
    sessionId: target.session.id,
    runId: target.run.id,
    seq: 1,
    source: "CLAUDE",
    type: "FINAL_OUTPUT",
    payload: payload as never,
  } });
};

const storedSplit = async (sessionId: string) => {
  const [row] = await db.$queryRaw<Array<{
    cachedInputTokens: number | null;
    cacheCreationInputTokens: number | null;
  }>>`
    SELECT "cachedInputTokens", "cacheCreationInputTokens"
    FROM "Session"
    WHERE "id" = ${sessionId}
  `;
  return row;
};

test("the cache split backfill rewrites known rows once and reports stable totals", async () => {
  const known = await seedSession("known");
  const unknown = await seedSession("unknown");
  await addFinalOutput(known, {
    type: "result",
    usage: { input_tokens: 160, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
  });
  await addFinalOutput(unknown, { type: "agent_settled" });

  const firstLines: string[] = [];
  const first = await runBackfillSessionCacheUsageCli({
    db: db as unknown as SessionCacheBackfillDatabase,
    log: (line: string) => firstLines.push(line),
    error: (line: string) => firstLines.push(line),
  });
  assert.equal(first, 0);
  assert.deepEqual(await storedSplit(known.session.id), {
    cachedInputTokens: 100,
    cacheCreationInputTokens: 50,
  });
  assert.deepEqual(await storedSplit(unknown.session.id), {
    cachedInputTokens: null,
    cacheCreationInputTokens: null,
  });

  const secondLines: string[] = [];
  const second = await runBackfillSessionCacheUsageCli({
    db: db as unknown as SessionCacheBackfillDatabase,
    log: (line: string) => secondLines.push(line),
    error: (line: string) => secondLines.push(line),
  });
  assert.equal(second, 0);
  assert.deepEqual(secondLines, firstLines);
  assert.deepEqual(await storedSplit(known.session.id), {
    cachedInputTokens: 100,
    cacheCreationInputTokens: 50,
  });
});

test("a malformed retained payload stops with the session id", async () => {
  const malformed = await seedSession("malformed", "000-malformed-session");
  await addFinalOutput(malformed, { type: "result", usage: "not-an-object" });

  const lines: string[] = [];
  const errors: string[] = [];
  const exit = await runBackfillSessionCacheUsageCli({
    db: db as unknown as SessionCacheBackfillDatabase,
    log: (line: string) => lines.push(line),
    error: (line: string) => errors.push(line),
  });

  assert.equal(exit, 1);
  assert.equal(lines[0], "scanned 1, updated 0, failed 1, unknown 0");
  assert.match(errors[0] ?? "", new RegExp(`session ${malformed.session.id}`));
  assert.deepEqual(await storedSplit(malformed.session.id), {
    cachedInputTokens: null,
    cacheCreationInputTokens: null,
  });
});
