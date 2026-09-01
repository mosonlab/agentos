import "../test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  Prisma,
  RunStatus,
  type PrismaClient,
} from "@anneal/db";

import { createApp } from "../test-app.js";
import { activeRunStatuses } from "../run-fence.js";
import { withTokens } from "./test-support.js";

test("session output authorization cannot introduce a second fence instant", async () => {
  const fencedPredicates: Prisma.RunWhereInput[] = [];
  const task = {
    id: "task-1",
    projectId: "project-1",
    chainId: null,
    chainIndex: null,
    chainLayer: null,
    status: "IN_PROGRESS",
    templateStep: {
      stepIndex: 1,
      outputKind: "implementation",
      baseFromStepIndex: null,
      taskTemplate: { name: "direct-engineer-workflow" },
    },
  };
  const database: Record<string, unknown> = {
    $queryRaw: async (query: TemplateStringsArray) => query.join("?").includes('FROM "Run"')
      ? [{ id: "run-1" }]
      : [{ id: "task-1", archivedAt: null }],
    run: { findFirst: async ({ where }: { where: Prisma.RunWhereInput }) => {
      if ("sessionTokenHash" in where) return { id: "run-1", leaseGeneration: 1 };
      fencedPredicates.push(where);
      return { taskId: "task-1", runnerId: "runner-1", task };
    } },
  };
  database.$transaction = async (operation: (tx: unknown) => Promise<unknown>) => operation(database);

  const response = await createApp(database as unknown as PrismaClient).request("/session/runs/run-1/output", {
    method: "PUT",
    headers: { Authorization: "Bearer agos_session_current", "Content-Type": "application/json" },
    body: JSON.stringify({
      fencingToken: "1:run-1:current",
      kind: "wrong-kind",
      body: "not persisted",
      commitSha: "a".repeat(40),
    }),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "task_output kind must be implementation for this canonical step" });
  assert.equal(fencedPredicates.length, 4);
  const instants = fencedPredicates.map((where) => (where.leaseExpiresAt as { gt: Date }).gt);
  assert.ok(instants.every((at) => at === instants[0]));
  assert.ok(fencedPredicates.every((where) => (
    where.status as { in: RunStatus[] }
  ).in === activeRunStatuses));
});

test("GET /sessions is project-scoped, clamped, cursored, and reachable by the operator", async () => {
  await withTokens(async () => {
    const calls: Array<Record<string, unknown>> = [];
    const database = {
      session: {
        findMany: async (args: Record<string, unknown>) => { calls.push(args); return []; },
      },
    } as unknown as PrismaClient;
    const app = createApp(database);
    const get = (query: string) => app.request(`/sessions${query}`, { headers: { Authorization: "Bearer operator-unit-token" } });

    // The route is one character from "/session/", which principalMayAccess
    // denies the operator. Pin the 200 so a rename cannot silently 403.
    const scoped = await get("?projectId=p&limit=5&before=2026-08-16T00:00:00.000Z");
    assert.equal(scoped.status, 200);
    const args = calls[0] as { where: { projectId: string; requestedAt: { lt: Date } }; take: number; orderBy: { requestedAt: string }; include: Record<string, unknown> };
    assert.equal(args.where.projectId, "p");
    assert.ok(args.where.requestedAt.lt instanceof Date);
    assert.equal(args.take, 5);
    assert.equal(args.orderBy.requestedAt, "desc");
    assert.deepEqual(Object.keys(args.include).sort(), ["agent", "goal", "run", "task"]);
    // Without remoteUrl the detail page's Branch field could never be a link.
    const run = args.include.run as { select: { repo: { select: Record<string, boolean> } } };
    assert.deepEqual(Object.keys(run.select.repo.select).sort(), ["id", "name", "remoteUrl"]);

    await get("?limit=9999");
    assert.equal((calls[1] as { take: number }).take, 200);
    await get("?limit=abc");
    assert.equal((calls[2] as { take: number }).take, 50);
    await get("?before=not-a-date");
    assert.equal((calls[3] as { where: Record<string, unknown> }).where.requestedAt, undefined);
  });
});

test("GET /sessions/:sessionId 404s cleanly and carries the repo remote URL", async () => {
  await withTokens(async () => {
    const calls: Array<Record<string, unknown>> = [];
    const database = {
      session: { findUnique: async (args: Record<string, unknown>) => { calls.push(args); return null; } },
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/sessions/unknown", { headers: { Authorization: "Bearer operator-unit-token" } });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Session not found" });
    const include = (calls[0] as { include: { run: { select: { repo: { select: Record<string, boolean> } } } } }).include;
    assert.equal(include.run.select.repo.select.remoteUrl, true);
  });
});

test("GET /runs/:runId/events pages by seq and reports hasMore without a second count", async () => {
  await withTokens(async () => {
    const rows = (count: number, from: number) => Array.from({ length: count }, (_, index) => ({ id: `e${from + index}`, seq: from + index }));
    const findManyArgs: Array<Record<string, unknown>> = [];
    const makeApp = (returned: Array<{ seq: number }>) => createApp({
      sessionEvent: {
        findMany: async (args: Record<string, unknown>) => { findManyArgs.push(args); return returned; },
        count: async () => 12,
      },
    } as unknown as PrismaClient);

    const more = await makeApp(rows(3, 8)).request("/runs/r1/events?afterSeq=7&limit=2", { headers: { Authorization: "Bearer operator-unit-token" } });
    const body = await more.json() as { events: Array<{ seq: number }>; hasMore: boolean; nextAfterSeq: number; total: number };
    assert.equal(body.events.length, 2);
    assert.equal(body.hasMore, true);
    assert.equal(body.nextAfterSeq, 9);
    assert.equal(body.total, 12);
    assert.deepEqual((findManyArgs[0] as { where: { seq: { gt: number } } }).where.seq, { gt: 7 });
    assert.equal((findManyArgs[0] as { take: number }).take, 3);

    const done = await makeApp(rows(2, 8)).request("/runs/r1/events?afterSeq=7&limit=2", { headers: { Authorization: "Bearer operator-unit-token" } });
    assert.equal((await done.json() as { hasMore: boolean }).hasMore, false);

    await makeApp([]).request("/runs/r1/events?limit=99999", { headers: { Authorization: "Bearer operator-unit-token" } });
    const clamped = findManyArgs.at(-1) as { take: number; where: Record<string, unknown> };
    assert.equal(clamped.take, 2001);
    assert.equal(clamped.where.seq, undefined);
  });
});
