import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";

import {
  Prisma, PrismaClient, sessionUsageCost,
} from "@anneal/db";

import { resetTestDb, setupTestDb } from "./testdb.js";

/**
 * The migration is normally applied to an empty scratch schema before this
 * file starts. The fixture deliberately executes that exact committed SQL a
 * second time after inserting legacy rows, which proves its data operation
 * rather than a hand-transcribed equivalent.
 */
const migrationSql = readFileSync(fileURLToPath(new URL(
  "../../db/prisma/migrations/20260828120000_session_usage_cached_input/migration.sql",
  import.meta.url,
)), "utf8");

const MAX_INT4 = 2_147_483_647;
const WINDOW_START = new Date("2026-08-28T00:00:00.000Z");
const WINDOW_END = new Date("2026-08-29T00:00:00.000Z");

type Runner = "CLAUDE" | "CODEX" | "PI";

type LegacySpec = {
  label: string;
  runner: Runner;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: string | null;
  startedAt?: Date;
};

type UsageRow = {
  id: string;
  runner: Runner;
  model: string;
  startedAt: Date | null;
  costUsd: Prisma.Decimal | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const seedLegacyRows = async (specs: LegacySpec[]): Promise<{ projectId: string; sessionIds: string[] }> => {
  const unique = `${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const project = await db.project.create({ data: { name: "Usage migration", slug: `usage-migration-${unique}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: "agent", title: "Agent", model: "gpt-5.6-luna",
    foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id, name: "repo", remoteUrl: "https://example.test/repo.git", mountPath: "/repo",
  } });
  const sessionIds: string[] = [];

  for (const [index, spec] of specs.entries()) {
    const task = await db.task.create({ data: {
      projectId: project.id, name: spec.label, description: "usage migration", assigneeAgentId: agent.id, repoId: repo.id,
    } });
    const startedAt = spec.startedAt ?? WINDOW_START;
    const run = await db.run.create({ data: {
      projectId: project.id, taskId: task.id, agentId: agent.id, repoId: repo.id, runNumber: 1,
      dedupeKey: `usage-migration:${unique}:${index}`, runner: spec.runner, status: "SUCCEEDED",
      model: "gpt-5.6-luna", promptHash: `usage-migration-${index}`, startedAt,
    } });
    const session = await db.session.create({ data: {
      runId: run.id, projectId: project.id, agentId: agent.id, taskId: task.id, runner: spec.runner,
      executionStatus: "SUCCEEDED", startedAt,
      costUsd: spec.costUsd,
      inputTokens: spec.inputTokens,
      cachedInputTokens: spec.cachedInputTokens,
      outputTokens: spec.outputTokens,
      totalTokens: spec.totalTokens,
    } });
    sessionIds.push(session.id);
  }
  return { projectId: project.id, sessionIds };
};

const readRows = async (sessionIds: readonly string[]): Promise<UsageRow[]> => db.session.findMany({
  where: { id: { in: [...sessionIds] } },
  select: {
    id: true, runner: true, costUsd: true, inputTokens: true, cachedInputTokens: true, outputTokens: true,
    totalTokens: true, startedAt: true, run: { select: { model: true } },
  },
}).then((rows) => rows.map((row) => ({
  id: row.id,
  runner: row.runner,
  model: row.run.model,
  startedAt: row.startedAt,
  costUsd: row.costUsd,
  inputTokens: row.inputTokens,
  cachedInputTokens: row.cachedInputTokens,
  cacheCreationInputTokens: null,
  outputTokens: row.outputTokens,
  totalTokens: row.totalTokens,
})));

const inWindow = (row: UsageRow): boolean => (
  row.startedAt !== null && row.startedAt >= WINDOW_START && row.startedAt < WINDOW_END
);

/** The Costs read-side projection before this migration: Claude and PI input
 * was expanded to the cached-inclusive shape before pricing; Codex was already
 * in that shape. Provider cost, when present, remains authoritative. */
const legacyCost = (row: UsageRow) => sessionUsageCost(row.model, {
  costUsd: row.costUsd,
  inputTokens: row.runner === "CODEX" || row.costUsd !== null || row.inputTokens === null || row.cachedInputTokens === null
    ? row.inputTokens
    : row.inputTokens + row.cachedInputTokens,
  cachedInputTokens: row.cachedInputTokens,
  cacheCreationInputTokens: null,
  outputTokens: row.outputTokens,
});

/** The canonical projection after conversion: every runner stores cached-
 * inclusive input, so no runner-specific adjustment is made at read time. */
const canonicalCost = (row: UsageRow) => sessionUsageCost(row.model, {
  costUsd: row.costUsd,
  inputTokens: row.inputTokens,
  cachedInputTokens: row.cachedInputTokens,
  cacheCreationInputTokens: null,
  outputTokens: row.outputTokens,
});

const settledTotal = (rows: readonly UsageRow[], costFor: (row: UsageRow) => ReturnType<typeof sessionUsageCost>): Prisma.Decimal => (
  rows.filter(inWindow).reduce(
    (total, row) => total.plus(costFor(row).costUsd ?? 0),
    new Prisma.Decimal(0),
  )
);

const unavailableCount = (rows: readonly UsageRow[], costFor: (row: UsageRow) => ReturnType<typeof sessionUsageCost>): number => (
  rows.filter(inWindow).filter((row) => costFor(row).costUsd === null).length
);

test("the exact migration preserves fixed-window pricing while canonicalizing Claude and PI", async () => {
  const seeded = await seedLegacyRows([
    // The old Claude/PI values exclude their cached subsets.
    { label: "Claude estimated", runner: "CLAUDE", inputTokens: 100, cachedInputTokens: 25, outputTokens: 10, totalTokens: 110, costUsd: null },
    { label: "PI estimated", runner: "PI", inputTokens: 200, cachedInputTokens: 40, outputTokens: 20, totalTokens: 220, costUsd: null },
    // Codex is already cached-inclusive and must not change.
    { label: "Codex estimated", runner: "CODEX", inputTokens: 325, cachedInputTokens: 75, outputTokens: 30, totalTokens: 355, costUsd: null },
    // Provider-reported cost is authoritative and must survive byte-for-byte.
    { label: "Claude reported", runner: "CLAUDE", inputTokens: 10, cachedInputTokens: 3, outputTokens: 4, totalTokens: 14, costUsd: "1.2345" },
    // Zero-cache rows need no rewrite.
    { label: "PI no cache", runner: "PI", inputTokens: 8, cachedInputTokens: 0, outputTokens: 2, totalTokens: 10, costUsd: null },
    // The fixed window excludes this row even though the migration sees it.
    { label: "Outside window", runner: "CLAUDE", inputTokens: 50, cachedInputTokens: 5, outputTokens: 5, totalTokens: 55, costUsd: null, startedAt: new Date("2026-08-27T23:59:59.999Z") },
  ]);
  const before = await readRows(seeded.sessionIds);
  const beforeTotal = settledTotal(before, legacyCost);
  const beforeUnavailable = unavailableCount(before, legacyCost);
  assert.equal(before.filter(inWindow).length, 5);

  await db.$executeRawUnsafe(migrationSql);

  const after = await readRows(seeded.sessionIds);
  const afterTotal = settledTotal(after, canonicalCost);
  const afterUnavailable = unavailableCount(after, canonicalCost);
  assert.equal(afterTotal.toString(), beforeTotal.toString());
  assert.equal(afterUnavailable, beforeUnavailable);
  assert.equal(after.filter(inWindow).length, 5);

  const byLabel = new Map((await db.session.findMany({
    where: { id: { in: seeded.sessionIds } },
    select: { id: true, task: { select: { name: true } } },
  })).map((row) => [row.task?.name, row.id]));
  const rowsByLabel = new Map(after.map((row) => [
    [...byLabel.entries()].find(([, id]) => id === row.id)?.[0] ?? row.id,
    row,
  ]));

  assert.deepEqual(
    ["Claude estimated", "PI estimated", "Codex estimated", "Claude reported", "PI no cache"].map((label) => {
      const row = rowsByLabel.get(label);
      return [label, row?.inputTokens, row?.cachedInputTokens, row?.outputTokens, row?.totalTokens, row?.costUsd?.toString() ?? null];
    }),
    [
      ["Claude estimated", 125, 25, 10, 135, null],
      ["PI estimated", 240, 40, 20, 260, null],
      ["Codex estimated", 325, 75, 30, 355, null],
      ["Claude reported", 13, 3, 4, 17, "1.2345"],
      ["PI no cache", 8, 0, 2, 10, null],
    ],
  );
});

test("the exact migration leaves a nonzero cached row without input untouched", async () => {
  const seeded = await seedLegacyRows([
    { label: "Missing input", runner: "CLAUDE", inputTokens: null, cachedInputTokens: 5, outputTokens: 1, totalTokens: null, costUsd: null },
  ]);
  await db.$executeRawUnsafe(migrationSql);
  const [row] = await readRows(seeded.sessionIds);
  assert.equal(row?.inputTokens, null);
  assert.equal(row?.cachedInputTokens, 5);
  assert.equal(row?.totalTokens, null);
});

test("the exact migration refuses converted INTEGER overflow and rolls back", async () => {
  const seeded = await seedLegacyRows([
    { label: "Input overflow", runner: "PI", inputTokens: MAX_INT4, cachedInputTokens: 1, outputTokens: 1, totalTokens: MAX_INT4, costUsd: null },
  ]);
  await assert.rejects(
    db.$executeRawUnsafe(migrationSql),
    /converted inputTokens or totalTokens exceeds INTEGER range/u,
  );
  const [row] = await readRows(seeded.sessionIds);
  assert.equal(row?.inputTokens, MAX_INT4);
  assert.equal(row?.cachedInputTokens, 1);
  assert.equal(row?.totalTokens, MAX_INT4);
});
