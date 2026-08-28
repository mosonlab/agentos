import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient } from "@anneal/db";

import { COSTS_TOP_RUNS } from "./costs.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

/**
 * `GET /projects/:projectId/costs` against a real PostgreSQL.
 *
 * The point of the file is the reconciliation test: provider-reported spend is
 * compared with a raw SQL sum over the same bounded window, while the estimated
 * share is pinned separately. The other tests cover behaviours that one total
 * cannot express — runner-specific token normalization, unavailable costs,
 * stable agent identity, exact range parsing, and UTC window boundaries.
 */

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-db-token";

const call = async (path: string): Promise<{ status: number; body: any }> => {
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    const response = await createApp(db).request(path, {
      headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
    });
    return { status: response.status, body: await response.json() };
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prior;
  }
};

const unique = (label: string): string => `${label}-${Date.now()}-${Math.round(performance.now() * 1000)}`;

const daysAgo = (days: number): Date => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

const seedProject = async (label: string) => {
  const project = await db.project.create({ data: { name: label, slug: unique(label) } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const repo = await db.repo.create({ data: {
    projectId: project.id, name: "repo", remoteUrl: "https://example.test/repo.git", mountPath: "/repo",
  } });
  const agent = async (name: string, title: string) => db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name, title, model: "claude-opus-5",
    foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  return { project, repo, agent };
};

type RunSpec = {
  agentId: string;
  model: string;
  runner: "CLAUDE" | "CODEX" | "PI";
  startedAt: Date;
  status?: "SUCCEEDED" | "FAILED" | "RUNNING";
  subagentModel?: true;
  session?: {
    costUsd?: string | null;
    inputTokens?: number | null;
    cachedInputTokens?: number | null;
    outputTokens?: number | null;
  } | null;
};

let runOrdinal = 0;

const seedRun = async (
  projectId: string,
  repoId: string,
  taskName: string,
  spec: RunSpec,
): Promise<string> => {
  runOrdinal += 1;
  const task = await db.task.create({ data: {
    projectId, name: taskName, description: "costs", assigneeAgentId: spec.agentId, repoId,
  } });
  const run = await db.run.create({ data: {
    projectId, taskId: task.id, agentId: spec.agentId, repoId, runNumber: 1,
    dedupeKey: `task:${task.id}:run:1:${runOrdinal}`, runner: spec.runner, status: spec.status ?? "SUCCEEDED",
    model: spec.model, promptHash: "hash", startedAt: spec.startedAt,
    // `Run_native_subagent_snapshot_check` only accepts the pinned pair, so a
    // mixed-model run is seeded exactly as the control plane writes one.
    ...(spec.subagentModel === true ? { subagentModel: "gpt-5.6-luna:max", subagentMaxConcurrent: 8 } : {}),
  } });
  if (spec.session !== null) {
    await db.session.create({ data: {
      runId: run.id, projectId, agentId: spec.agentId, taskId: task.id, runner: spec.runner,
      executionStatus: "SUCCEEDED", startedAt: spec.startedAt,
      costUsd: spec.session?.costUsd ?? null,
      inputTokens: spec.session?.inputTokens ?? null,
      cachedInputTokens: spec.session?.cachedInputTokens ?? null,
      outputTokens: spec.session?.outputTokens ?? null,
    } });
  }
  return run.id;
};

test("totalUsd reconciles with a raw SQL sum over the same window", async () => {
  const { project, repo, agent } = await seedProject("costs-reconcile");
  const dev = await agent("dev", "Frontend Dev");
  const reviewer = await agent("reviewer", "Reviewer");
  await seedRun(project.id, repo.id, "In window A", {
    agentId: dev.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: daysAgo(1),
    session: { costUsd: "1.2500" },
  });
  await seedRun(project.id, repo.id, "In window B", {
    agentId: reviewer.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: daysAgo(3),
    session: { costUsd: "0.7500" },
  });
  await seedRun(project.id, repo.id, "Estimated in window", {
    agentId: dev.id, model: "openai-codex/gpt-5.6-luna", runner: "CODEX", startedAt: daysAgo(2),
    // 900k uncached + 100k cached input and 500k output = $0.782.
    session: { costUsd: null, inputTokens: 1_000_000, cachedInputTokens: 100_000, outputTokens: 500_000 },
  });
  // Outside the 7-day window, and so outside both the route and the SQL sum.
  await seedRun(project.id, repo.id, "Old", {
    agentId: dev.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: daysAgo(40),
    session: { costUsd: "99.0000" },
  });
  // Still running: usage is still being written, so it is not settled spend.
  await seedRun(project.id, repo.id, "Live", {
    agentId: dev.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: daysAgo(1), status: "RUNNING",
    session: { costUsd: "50.0000" },
  });

  const { status, body } = await call(`/projects/${project.id}/costs?days=7`);
  assert.equal(status, 200);

  const [manual] = await db.$queryRaw<Array<{ sum: unknown }>>`
    SELECT COALESCE(SUM(s."costUsd"), 0) AS sum
    FROM "Session" s
    JOIN "Run" r ON r.id = s."runId"
    WHERE r."projectId" = ${project.id}
      AND r.status IN ('succeeded', 'failed', 'timed-out', 'cancelled', 'lost')
      AND r."startedAt" >= ${new Date(body.since)}
      AND r."startedAt" < ${new Date(new Date(body.since).getTime() + 7 * 24 * 60 * 60 * 1000)}
  `;
  assert.equal(Number(body.totalUsd) - Number(body.estimatedUsd), Number(manual?.sum));
  assert.equal(Number(body.totalUsd), 2.782);
  assert.equal(body.runCount, 3);
  assert.equal(body.costUnavailableRuns, 0);
  assert.equal(Number(body.avgUsd), 0.927333);
  assert.equal(Number(body.estimatedUsd), 0.782);
});

test("a codex session without a reported amount is counted apart, never as zero", async () => {
  const { project, repo, agent } = await seedProject("costs-unpriced");
  const dev = await agent("dev", "Frontend Dev");
  await seedRun(project.id, repo.id, "Priced", {
    agentId: dev.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: daysAgo(1),
    session: { costUsd: "2.0000" },
  });
  // Codex reports no amount and this run's tokens are incomplete, so there is
  // nothing to price and nothing to estimate.
  await seedRun(project.id, repo.id, "Unpriced", {
    agentId: dev.id, model: "openai-codex/gpt-5.6-luna", runner: "CODEX", startedAt: daysAgo(1),
    session: { costUsd: null, inputTokens: 1_000 },
  });
  // A run whose native children used other models: tokens exist, but pricing
  // them at the root model would overstate the spend.
  await seedRun(project.id, repo.id, "Mixed", {
    agentId: dev.id, model: "openai-codex/gpt-5.6-sol", runner: "CODEX", startedAt: daysAgo(2),
    subagentModel: true,
    session: { costUsd: null, inputTokens: 1_000, cachedInputTokens: 100, outputTokens: 50 },
  });
  // A settled run that never produced a session row at all.
  await seedRun(project.id, repo.id, "Sessionless", {
    agentId: dev.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: daysAgo(2), session: null,
  });

  const { body } = await call(`/projects/${project.id}/costs?days=7`);
  assert.equal(body.runCount, 4);
  assert.equal(body.costUnavailableRuns, 3);
  assert.equal(Number(body.totalUsd), 2);
  // The average is over the one run that has a cost, not over all four.
  assert.equal(Number(body.avgUsd), 2);
  assert.equal(body.byAgent.length, 1);
  assert.equal(body.byAgent[0].runs, 4);
  assert.equal(body.byAgent[0].costUnavailableRuns, 3);
  assert.equal(Number(body.byAgent[0].usd), 2);
  assert.equal(Number(body.byAgent[0].avgUsd), 2);
});

test("a complete codex token set is priced and labelled as an estimate", async () => {
  const { project, repo, agent } = await seedProject("costs-estimate");
  const dev = await agent("dev", "Frontend Dev");
  await seedRun(project.id, repo.id, "Estimated", {
    agentId: dev.id, model: "openai-codex/gpt-5.6-luna", runner: "CODEX", startedAt: daysAgo(1),
    // Luna: 0.2 / 0.02 / 1.2 USD per million. 900k uncached input, 100k cached,
    // 500k output = 0.18 + 0.002 + 0.6 = 0.782.
    session: { costUsd: null, inputTokens: 1_000_000, cachedInputTokens: 100_000, outputTokens: 500_000 },
  });

  const { body } = await call(`/projects/${project.id}/costs?days=7`);
  assert.equal(Number(body.totalUsd), 0.782);
  assert.equal(Number(body.estimatedUsd), 0.782);
  assert.equal(body.costUnavailableRuns, 0);
  assert.equal(body.topRuns.length, 1);
  assert.equal(body.topRuns[0].estimated, true);
  assert.equal(body.topRuns[0].taskName, "Estimated");
  assert.equal(body.topRuns[0].agent, "dev");
  assert.equal(body.topRuns[0].model, "openai-codex/gpt-5.6-luna");
});

test("canonical token rows price identically across runners", async () => {
  const { project, repo, agent } = await seedProject("costs-runner-normalization");
  const claude = await agent("claude", "Claude Implementer");
  const codex = await agent("codex", "Implementer");
  const pi = await agent("pi", "PI Implementer");
  // Canonical persisted input includes its cached subset. Every adapter writes
  // this same triple, so Costs must not need the runner to interpret it.
  await seedRun(project.id, repo.id, "Claude estimated", {
    agentId: claude.id, model: "openai-codex/gpt-5.6-luna", runner: "CLAUDE", startedAt: daysAgo(1),
    session: { costUsd: null, inputTokens: 1_000_000, cachedInputTokens: 100_000, outputTokens: 500_000 },
  });
  await seedRun(project.id, repo.id, "Codex estimated", {
    agentId: codex.id, model: "openai-codex/gpt-5.6-luna", runner: "CODEX", startedAt: daysAgo(1),
    session: { costUsd: null, inputTokens: 1_000_000, cachedInputTokens: 100_000, outputTokens: 500_000 },
  });
  await seedRun(project.id, repo.id, "PI estimated", {
    agentId: pi.id, model: "openai-codex/gpt-5.6-luna", runner: "PI", startedAt: daysAgo(1),
    session: { costUsd: null, inputTokens: 1_000_000, cachedInputTokens: 100_000, outputTokens: 500_000 },
  });

  const { body } = await call(`/projects/${project.id}/costs?days=7`);
  assert.equal(Number(body.totalUsd), 2.346);
  assert.equal(Number(body.estimatedUsd), 2.346);
  assert.deepEqual(body.byAgent.map((entry: { agent: string; usd: string }) => [entry.agent, Number(entry.usd)]), [
    ["claude", 0.782],
    ["codex", 0.782],
    ["pi", 0.782],
  ]);
});

test("agents with the same title remain distinct by their unique names", async () => {
  const { project, repo, agent } = await seedProject("costs-agent-identity");
  const first = await agent("frontend-dev", "Developer");
  const second = await agent("backend-dev", "Developer");
  await seedRun(project.id, repo.id, "Frontend", {
    agentId: first.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: daysAgo(1),
    session: { costUsd: "1.0000" },
  });
  await seedRun(project.id, repo.id, "Backend", {
    agentId: second.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: daysAgo(1),
    session: { costUsd: "2.0000" },
  });

  const { body } = await call(`/projects/${project.id}/costs?days=7`);
  assert.deepEqual(
    body.daily.find((entry: { byAgent: Record<string, string> }) => Object.keys(entry.byAgent).length > 0)?.byAgent,
    { "backend-dev": "2", "frontend-dev": "1" },
  );
  assert.deepEqual(body.byAgent.map((entry: { agent: string }) => entry.agent), ["backend-dev", "frontend-dev"]);
  assert.deepEqual(body.topRuns.map((run: { agent: string }) => run.agent), ["backend-dev", "frontend-dev"]);
});

test("an entirely unpriced agent is explicit rather than indistinguishable from free", async () => {
  const { project, repo, agent } = await seedProject("costs-all-unpriced");
  const dev = await agent("codex", "Codex");
  await seedRun(project.id, repo.id, "Unknown", {
    agentId: dev.id, model: "openai-codex/gpt-5.6-luna", runner: "CODEX", startedAt: daysAgo(1),
    session: { costUsd: null, inputTokens: 100 },
  });

  const { body } = await call(`/projects/${project.id}/costs?days=7`);
  assert.deepEqual(body.byAgent, [{ agent: "codex", usd: "0", runs: 1, costUnavailableRuns: 1, avgUsd: "0" }]);
});

test("the window is a whole number of UTC day buckets, and every day is present", async () => {
  const { project, repo, agent } = await seedProject("costs-daily");
  const dev = await agent("dev", "Frontend Dev");
  const reviewer = await agent("reviewer", "Reviewer");
  await seedRun(project.id, repo.id, "Dev today", {
    agentId: dev.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: new Date(),
    session: { costUsd: "3.0000" },
  });
  await seedRun(project.id, repo.id, "Reviewer today", {
    agentId: reviewer.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: new Date(),
    session: { costUsd: "1.0000" },
  });

  const { body } = await call(`/projects/${project.id}/costs?days=7`);
  assert.equal(body.daily.length, 7);
  assert.equal(body.days, 7);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(body.daily.at(-1).date, today);
  assert.deepEqual(body.daily.at(-1).byAgent, { dev: "3", reviewer: "1" });
  // Days nothing ran on are present and empty rather than missing.
  assert.deepEqual(body.daily[0].byAgent, {});
  assert.deepEqual(body.byAgent.map((entry: { agent: string }) => entry.agent), ["dev", "reviewer"]);
});

test("runs beyond the captured UTC window end are excluded", async () => {
  const { project, repo, agent } = await seedProject("costs-future");
  const dev = await agent("dev", "Developer");
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 5, 0, 0);
  await seedRun(project.id, repo.id, "Future", {
    agentId: dev.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: tomorrow,
    session: { costUsd: "9.0000" },
  });

  const { body } = await call(`/projects/${project.id}/costs?days=7`);
  assert.equal(body.runCount, 0);
  assert.equal(Number(body.totalUsd), 0);
});

test("top runs are the ten most expensive, most expensive first", async () => {
  const { project, repo, agent } = await seedProject("costs-top");
  const dev = await agent("dev", "Frontend Dev");
  for (let index = 1; index <= COSTS_TOP_RUNS + 3; index += 1) {
    await seedRun(project.id, repo.id, `Run ${index}`, {
      agentId: dev.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: daysAgo(1),
      session: { costUsd: `${index}.0000` },
    });
  }
  const { body } = await call(`/projects/${project.id}/costs?days=7`);
  assert.equal(body.runCount, COSTS_TOP_RUNS + 3);
  assert.equal(body.topRuns.length, COSTS_TOP_RUNS);
  assert.deepEqual(
    body.topRuns.map((run: { usd: string }) => Number(run.usd)),
    [13, 12, 11, 10, 9, 8, 7, 6, 5, 4],
  );
});

test("the default window is 30 days and unsupported or malformed values are refused", async () => {
  const { project } = await seedProject("costs-range");
  const fallback = await call(`/projects/${project.id}/costs`);
  assert.equal(fallback.status, 200);
  assert.equal(fallback.body.days, 30);
  assert.equal(fallback.body.daily.length, 30);

  const refused = await call(`/projects/${project.id}/costs?days=45`);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /7, 30, 90/);

  for (const malformed of ["7.5", "7junk", "90days"]) {
    const response = await call(`/projects/${project.id}/costs?days=${malformed}`);
    assert.equal(response.status, 400, malformed);
  }
});
