import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  InboxKind,
  InboxSender,
  InboxStatus,
  PrismaClient,
  RunnerKind,
} from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";
import { withTokens } from "./routes/test-support.js";

let db: PrismaClient;
let seedCounter = 0;

before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const request = async (path: string): Promise<Response> => createApp(db).request(path, {
  headers: { Authorization: "Bearer operator-unit-token" },
});

const seedInboxScope = async () => {
  const suffix = `${Date.now()}-${seedCounter += 1}`;
  const project = await db.project.create({ data: { name: `Inbox scope ${suffix}`, slug: `inbox-scope-${suffix}` } });
  const foreignProject = await db.project.create({ data: {
    name: `Foreign inbox scope ${suffix}`,
    slug: `foreign-inbox-scope-${suffix}`,
  } });
  const environment = await db.environment.create({ data: {
    projectId: project.id, name: "local", allowedHosts: [],
  } });
  const foreignEnvironment = await db.environment.create({ data: {
    projectId: foreignProject.id, name: "local", allowedHosts: [],
  } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: "scope-agent",
    title: "Scope agent",
    model: "claude",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const foreignAgent = await db.agent.create({ data: {
    projectId: foreignProject.id,
    environmentId: foreignEnvironment.id,
    name: "foreign-scope-agent",
    title: "Foreign scope agent",
    model: "claude",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const task = await db.task.create({ data: {
    projectId: project.id,
    assigneeAgentId: agent.id,
    name: "Scope task",
    description: "Inbox scope task",
  } });
  const deletedTask = await db.task.create({ data: {
    projectId: project.id,
    name: "Deleted scope task",
    description: "Inbox scope task whose relation is removed",
  } });
  const goal = await db.goal.create({ data: {
    projectId: project.id,
    title: "Scope goal",
    spec: "Inbox scope goal",
  } });
  const run = await db.run.create({ data: {
    projectId: project.id,
    agentId: agent.id,
    runNumber: 1,
    dedupeKey: `inbox-scope:${suffix}`,
    runner: RunnerKind.CLAUDE,
    model: "claude",
  } });
  const session = await db.session.create({ data: {
    runId: run.id,
    projectId: project.id,
    agentId: agent.id,
    runner: RunnerKind.CLAUDE,
  } });

  const message = (data: {
    from: InboxSender;
    kind: InboxKind;
    body: string;
    agentId?: string;
    taskId?: string;
    goalId?: string;
    sessionId?: string;
    replyToMessageId?: string;
  }) => db.inboxMessage.create({
    data: { ...data, status: InboxStatus.OPEN },
  });

  // One top-level row through each of the four supported project relations.
  const throughAgent = await message({
    from: InboxSender.HUMAN,
    kind: InboxKind.TEXT,
    body: "through agent",
    agentId: agent.id,
  });
  const throughTask = await message({
    from: InboxSender.AGENT,
    kind: InboxKind.MULTIPLE_CHOICE,
    body: "through task",
    taskId: task.id,
  });
  const throughGoal = await message({
    from: InboxSender.AGENT,
    kind: InboxKind.TEXT,
    body: "through goal",
    goalId: goal.id,
  });
  const throughSession = await message({
    from: InboxSender.AGENT,
    kind: InboxKind.TEXT,
    body: "through session",
    sessionId: session.id,
  });
  // This row is already global, and must be included for every project.
  const explicitGlobal = await message({
    from: InboxSender.AGENT,
    kind: InboxKind.TEXT,
    body: "global notification",
  });
  // SetNull on InboxMessage.taskId preserves this historical row when its
  // nullable relation is deleted. It must remain global after the deletion.
  const deletedRelation = await message({
    from: InboxSender.HUMAN,
    kind: InboxKind.TEXT,
    body: "history made global by deletion",
    taskId: deletedTask.id,
  });
  await db.task.delete({ where: { id: deletedTask.id } });

  const reply = await message({
    from: InboxSender.AGENT,
    kind: InboxKind.TEXT,
    body: "reply excluded from top-level list",
    replyToMessageId: throughAgent.id,
  });
  const foreign = await message({
    from: InboxSender.HUMAN,
    kind: InboxKind.TEXT,
    body: "foreign project message",
    agentId: foreignAgent.id,
  });

  return {
    project,
    ids: {
      throughAgent: throughAgent.id,
      throughTask: throughTask.id,
      throughGoal: throughGoal.id,
      throughSession: throughSession.id,
      explicitGlobal: explicitGlobal.id,
      deletedRelation: deletedRelation.id,
      reply: reply.id,
      foreign: foreign.id,
    },
  };
};

const messageIds = async (response: Response): Promise<string[]> => {
  assert.equal(response.status, 200);
  return (await response.json() as Array<{ id: string }>).map((message) => message.id);
};

test("project-scoped Inbox list includes each relation and both kinds of global history", async () => {
  await withTokens(async () => {
    const seeded = await seedInboxScope();
    const scopedIds = await messageIds(await request(`/inbox/messages?projectId=${seeded.project.id}`));
    assert.deepEqual(new Set(scopedIds), new Set([
      seeded.ids.throughAgent,
      seeded.ids.throughTask,
      seeded.ids.throughGoal,
      seeded.ids.throughSession,
      seeded.ids.explicitGlobal,
      seeded.ids.deletedRelation,
    ]));
    assert.ok(!scopedIds.includes(seeded.ids.reply), "replies remain excluded from the top-level list");
    assert.ok(!scopedIds.includes(seeded.ids.foreign), "foreign project rows remain excluded");

    const unfilteredIds = await messageIds(await request("/inbox/messages"));
    assert.deepEqual(new Set(unfilteredIds), new Set([
      ...scopedIds,
      seeded.ids.foreign,
    ]));
  });
});

test("project-scoped Inbox summary applies needs-reply to the same project-plus-global set", async () => {
  await withTokens(async () => {
    const seeded = await seedInboxScope();
    const scoped = await request(`/inbox/messages/summary?projectId=${seeded.project.id}`);
    assert.equal(scoped.status, 200);
    // throughAgent, throughTask, and the deleted relation are human/choice
    // cards that need a reply; the agent text notices are dismissible.
    assert.deepEqual(await scoped.json(), { needsReply: 3 });

    const unfiltered = await request("/inbox/messages/summary");
    assert.equal(unfiltered.status, 200);
    assert.deepEqual(await unfiltered.json(), { needsReply: 4 });
  });
});

