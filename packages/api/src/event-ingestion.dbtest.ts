import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient } from "@agentos/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const runnerToken = "event-ingestion-dbtest-runner";

const withRunnerToken = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = process.env.RUNNER_TOKEN;
  process.env.RUNNER_TOKEN = runnerToken;
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.RUNNER_TOKEN;
    else process.env.RUNNER_TOKEN = previous;
  }
};

test("mixed literal-NUL events persist in order without PostgreSQL 22P05", async () => {
  await withRunnerToken(async () => {
    const unique = `${Date.now()}-${Math.round(performance.now() * 1000)}`;
    const project = await db.project.create({ data: { name: "Event ingestion", slug: `event-ingestion-${unique}` } });
    const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
    const agent = await db.agent.create({ data: {
      projectId: project.id, environmentId: environment.id, name: "agent", title: "Agent", model: "claude",
      foundationalPrompt: "foundation", rolePrompt: "role",
    } });
    const repo = await db.repo.create({ data: {
      projectId: project.id, name: "repo", remoteUrl: "https://example.test/repo.git", mountPath: "/repo",
    } });
    const task = await db.task.create({ data: {
      projectId: project.id, name: "Event task", description: "event ingestion", assigneeAgentId: agent.id, repoId: repo.id,
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
      runnerId: "runner-1",
      fencingToken: "fence-current",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    } });
    const session = await db.session.create({ data: {
      runId: run.id, projectId: project.id, agentId: agent.id, taskId: task.id, runner: "CLAUDE", executionStatus: "RUNNING",
    } });

    const nul = "\u0000";
    const visibleNul = "\\u0000";
    const response = await createApp(db).request(`/runner/runs/${run.id}/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${runnerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId: "runner-1",
        fencingToken: "fence-current",
        events: [
          { seq: 12, source: "CLAUDE", type: "VALID", payload: { text: "unchanged" } },
          {
            seq: 13,
            source: "CLAUDE",
            type: `NUL${nul}EVENT`,
            providerEventId: `provider${nul}13`,
            toolCallId: `tool${nul}13`,
            payload: { nested: { text: `before${nul}after` }, values: [`one${nul}two`, { text: "plain" }] },
          },
          { seq: 14, source: "CLAUDE", type: "VALID_AFTER", payload: { text: "also unchanged" } },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: 3 });

    const rows = await db.sessionEvent.findMany({ where: { runId: run.id }, orderBy: { seq: "asc" } });
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.seq), [12, 13, 14]);
    assert.equal(rows[0]?.type, "VALID");
    assert.equal(rows[1]?.type, `NUL${visibleNul}EVENT`);
    assert.equal(rows[1]?.providerEventId, `provider${visibleNul}13`);
    assert.equal(rows[1]?.toolCallId, `tool${visibleNul}13`);
    assert.deepEqual(rows[1]?.payload, {
      nested: { text: `before${visibleNul}after` },
      values: [`one${visibleNul}two`, { text: "plain" }],
    });
    assert.equal(JSON.stringify(rows).includes(nul), false);
    assert.deepEqual(rows[2]?.payload, { text: "also unchanged" });
    assert.equal(session.id, rows[0]?.sessionId);
  });
});
