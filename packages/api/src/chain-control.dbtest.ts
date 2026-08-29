import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  ChainControlState,
  holdChain,
  MERGE_TAIL_KIND,
  PrismaClient,
  readChainControls,
  RunStatus,
  TaskStatus,
} from "@anneal/db";

import { recordMergeLeaseHold } from "./merge-lease-hold.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "chain-control-operator";

const call = async (path: string, body: unknown, token = OPERATOR) => {
  const previous = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    const response = await createApp(db).request(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previous;
  }
};

const patchTask = async (path: string, body: unknown) => {
  const previous = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    const response = await createApp(db).request(path, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previous;
  }
};

const getTasks = async (projectId: string) => {
  const previous = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    const response = await createApp(db).request(`/tasks?projectId=${projectId}`,
      { headers: { Authorization: `Bearer ${OPERATOR}` } });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previous;
  }
};

let sequence = 0;
const createChainTasks = async (options: {
  projectId: string;
  repoId: string;
  agentId: string;
  chainId: string;
  chainIndexOffset?: number;
  allDone?: boolean;
}) => {
  const chainIndexOffset = options.chainIndexOffset ?? 0;
  const first = await db.task.create({ data: {
    projectId: options.projectId,
    repoId: options.repoId,
    assigneeAgentId: options.agentId,
    name: "First",
    description: "first",
    chainId: options.chainId,
    chainIndex: chainIndexOffset,
    chainLayer: 1,
    status: options.allDone ? TaskStatus.DONE : TaskStatus.DOING,
  } });
  const second = await db.task.create({ data: {
    projectId: options.projectId,
    repoId: options.repoId,
    assigneeAgentId: options.agentId,
    name: "Second",
    description: "second",
    chainId: options.chainId,
    chainIndex: chainIndexOffset + 1,
    chainLayer: 2,
    status: options.allDone ? TaskStatus.DONE : TaskStatus.TODO,
  } });
  const third = await db.task.create({ data: {
    projectId: options.projectId,
    repoId: options.repoId,
    assigneeAgentId: options.agentId,
    name: "Third",
    description: "third",
    chainId: options.chainId,
    chainIndex: chainIndexOffset + 2,
    chainLayer: 3,
    status: options.allDone ? TaskStatus.DONE : TaskStatus.TODO,
  } });
  return { chainId: options.chainId, first, second, third };
};

const seedChain = async (options: { allDone?: boolean; chainId?: string; chainIndexOffset?: number } = {}) => {
  sequence += 1;
  const suffix = `${process.pid}-${sequence}`;
  const project = await db.project.create({ data: { name: "Chain control", slug: `chain-control-${suffix}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: `agent-${suffix}`,
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
  await db.agentRepoAccess.create({ data: {
    projectId: project.id,
    agentId: agent.id,
    repoId: repo.id,
    mountPath: "/repo",
    permissions: "GIT_WRITE",
  } });
  const chainId = options.chainId ?? `chain-${suffix}`;
  const chain = await createChainTasks({
    projectId: project.id,
    repoId: repo.id,
    agentId: agent.id,
    chainId,
    chainIndexOffset: options.chainIndexOffset ?? 0,
    allDone: options.allDone ?? false,
  });
  return { project, agent, repo, ...chain };
};

const holdDirect = async (
  chain: Awaited<ReturnType<typeof seedChain>>,
  taskId: string,
  requestId: string,
  reason?: string,
) => {
  const body = await db.$transaction((tx) => holdChain(tx, {
    projectId: chain.project.id,
    chainId: chain.chainId,
    taskId,
    requestId,
    reason,
  }));
  if ("message" in body) assert.fail(body.message);
  return { status: 200, body };
};

test("the shared reader treats absent and released controls as not held", async () => {
  const chain = await seedChain();
  const released = await db.chainControl.create({
    data: { projectId: chain.project.id, chainId: "released-chain", state: ChainControlState.RELEASED },
  });
  const values = await db.$transaction((tx) => readChainControls(tx, [
    { projectId: chain.project.id, chainId: chain.chainId },
    { projectId: chain.project.id, chainId: released.chainId },
  ]));
  assert.equal(values.get(`${chain.project.id}:${chain.chainId}`)?.held, false);
  assert.equal(values.get(`${chain.project.id}:${chain.chainId}`)?.state, ChainControlState.RELEASED);
  assert.equal(values.get(`${chain.project.id}:${released.chainId}`)?.held, false);
  assert.equal(values.get(`${chain.project.id}:${released.chainId}`)?.state, ChainControlState.RELEASED);

  await db.chainControl.update({ where: { id: released.id }, data: {
    state: ChainControlState.HELD,
    heldLayer: 2,
    holdGeneration: 4,
  } });
  const held = await db.$transaction((tx) => readChainControls(tx, [{ projectId: chain.project.id, chainId: released.chainId }]));
  assert.equal(held.get(`${chain.project.id}:${released.chainId}`)?.held, true);
  assert.equal(held.get(`${chain.project.id}:${released.chainId}`)?.heldLayer, 2);
  assert.equal(held.get(`${chain.project.id}:${released.chainId}`)?.holdGeneration, 4);
});

test("the database rejects a HELD authority without a held layer", async () => {
  const chain = await seedChain();
  await assert.rejects(
    db.chainControl.create({ data: {
      projectId: chain.project.id,
      chainId: "invalid-null-held-layer",
      state: ChainControlState.HELD,
      heldLayer: null,
    } }),
    /ChainControl_held_requires_layer_check|check constraint/iu,
  );
  const released = await db.chainControl.create({ data: {
    projectId: chain.project.id,
    chainId: "released-null-held-layer",
    state: ChainControlState.RELEASED,
    heldLayer: null,
  } });
  assert.equal(released.heldLayer, null);
});

test("Hold creates one authority and one audit event without touching Runs or Tasks", async () => {
  const chain = await seedChain();
  const queued = await db.run.create({ data: {
    projectId: chain.project.id,
    taskId: chain.first.id,
    agentId: chain.agent.id,
    repoId: chain.repo.id,
    runNumber: 1,
    dedupeKey: `task:${chain.first.id}:run:1`,
    status: RunStatus.QUEUED,
    runner: "CLAUDE",
    model: "claude",
  } });
  assert.equal(await recordMergeLeaseHold(db, {
    projectId: chain.project.id,
    chainId: chain.chainId,
  }, {
    outcome: "released",
    ref: "refs/merge-lease/holder",
    sha: "slice-01-merge-lease",
    acquiredAt: "2026-08-27T12:00:00.250Z",
  }, new Date("2026-08-27T12:01:02.999Z")), "recorded");
  const mergeLeaseActivityBefore = await db.taskActivity.findMany({
    where: { taskId: chain.third.id, metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseHold } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const statusesBefore = await db.task.findMany({ where: { projectId: chain.project.id, chainId: chain.chainId }, select: { id: true, status: true } });
  const held = await holdDirect(chain, chain.second.id, "hold-1", "review the current output");
  assert.equal(held.status, 200);
  assert.equal(held.body.control.state, "held");
  assert.equal(held.body.control.heldLayer, 1);
  assert.equal(held.body.control.holdRequestId, "hold-1");
  assert.equal(held.body.control.holdReason, "review the current output");
  assert.equal(held.body.control.holdGeneration, 1);
  assert.equal(held.body.duplicate, false);

  const control = await db.chainControl.findUniqueOrThrow({ where: { projectId_chainId: {
    projectId: chain.project.id,
    chainId: chain.chainId,
  } } });
  const events = await db.chainControlEvent.findMany({ where: { chainControlId: control.id } });
  assert.equal(control.state, ChainControlState.HELD);
  assert.equal(control.heldLayer, 1);
  assert.equal(control.holdRequestId, "hold-1");
  assert.equal(control.holdReason, "review the current output");
  assert.ok(control.heldAt instanceof Date);
  assert.equal(control.releasedAt, null);
  assert.equal(control.releaseRequestId, null);
  assert.equal(control.holdGeneration, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, ChainControlState.HELD);
  assert.equal(events[0]?.layer, 1);
  assert.equal(events[0]?.actorType, "operator");
  assert.equal(events[0]?.actorId, null);
  assert.equal(events[0]?.requestId, "hold-1");
  assert.equal(events[0]?.reason, "review the current output");
  assert.equal(events[0]?.holdGeneration, 1);
  assert.ok(events[0]?.createdAt instanceof Date);
  assert.equal(await db.run.count({ where: { id: queued.id } }), 1);
  assert.deepEqual(
    await db.task.findMany({ where: { projectId: chain.project.id, chainId: chain.chainId }, select: { id: true, status: true } }),
    statusesBefore,
  );
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: queued.id } })).cancelRequestId, null);
  const mergeLeaseActivityAfter = await db.taskActivity.findMany({
    where: { taskId: chain.third.id, metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseHold } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  assert.equal(JSON.stringify(mergeLeaseActivityAfter), JSON.stringify(mergeLeaseActivityBefore));
});

test("repeated Hold is an idempotent success and does not append history", async () => {
  const chain = await seedChain();
  const first = await holdDirect(chain, chain.first.id, "hold-original", "first reason");
  assert.equal(first.status, 200);
  const repeatedSame = await holdDirect(chain, chain.second.id, "hold-original", "ignored same-request reason");
  assert.equal(repeatedSame.status, 200);
  assert.equal(repeatedSame.body.duplicate, true);
  assert.equal(repeatedSame.body.control.holdRequestId, "hold-original");
  const repeated = await holdDirect(chain, chain.second.id, "hold-retry", "ignored reason");
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.duplicate, true);
  assert.equal(repeated.body.control.holdRequestId, "hold-original");
  assert.equal(repeated.body.control.holdReason, "first reason");
  const control = await db.chainControl.findUniqueOrThrow({ where: { projectId_chainId: {
    projectId: chain.project.id,
    chainId: chain.chainId,
  } } });
  assert.equal(await db.chainControlEvent.count({ where: { chainControlId: control.id } }), 1);
  assert.equal(control.holdGeneration, 1);
});

test("Hold refuses unknown, chainless, and complete Tasks", async () => {
  const chain = await seedChain({ allDone: true });
  const standalone = await db.task.create({ data: {
    projectId: chain.project.id,
    name: "Standalone",
    description: "not a Chain",
    status: TaskStatus.TODO,
  } });
  const chainless = await call(`/tasks/${standalone.id}/chain/hold`, { requestId: "hold-standalone" });
  assert.equal(chainless.status, 409);
  assert.match(chainless.body.error, /does not belong to a Chain/u);
  const complete = await call(`/tasks/${chain.first.id}/chain/hold`, { requestId: "hold-complete" });
  assert.equal(complete.status, 409);
  assert.match(complete.body.error, /nothing left|every Task is done/u);
  const missing = await call("/tasks/missing-task/chain/hold", { requestId: "hold-missing" });
  assert.equal(missing.status, 404);
});

test("the authority is scoped by project and accepted request ids are unique per transition kind", async () => {
  const left = await seedChain({ chainId: "same-chain", chainIndexOffset: 0 });
  // Task's legacy `(chainId, chainIndex)` uniqueness is global, so a second
  // project can reuse the chain id only at disjoint indices. The authority
  // itself is still keyed by the full project/Chain pair.
  const right = await seedChain({ chainId: left.chainId, chainIndexOffset: 11 });
  const sibling = await createChainTasks({
    projectId: left.project.id,
    repoId: left.repo.id,
    agentId: left.agent.id,
    chainId: "different-chain-in-same-project",
    chainIndexOffset: 21,
  });
  assert.notEqual(left.project.id, right.project.id);
  const rightTasksBefore = await db.task.findMany({
    where: { projectId: right.project.id, chainId: right.chainId },
    orderBy: { chainIndex: "asc" },
    select: { id: true, status: true, chainId: true, chainIndex: true, chainLayer: true },
  });
  const siblingTasksBefore = await db.task.findMany({
    where: { projectId: left.project.id, chainId: sibling.chainId },
    orderBy: { chainIndex: "asc" },
    select: { id: true, status: true, chainId: true, chainIndex: true, chainLayer: true },
  });
  assert.equal((await call(`/tasks/${left.first.id}/chain/hold`, { requestId: "same-request" })).status, 200);
  assert.equal(await db.chainControl.count({ where: { projectId: right.project.id } }), 0);
  assert.deepEqual(
    await db.task.findMany({
      where: { projectId: right.project.id, chainId: right.chainId },
      orderBy: { chainIndex: "asc" },
      select: { id: true, status: true, chainId: true, chainIndex: true, chainLayer: true },
    }),
    rightTasksBefore,
  );
  assert.equal(await db.chainControl.count({ where: { projectId: left.project.id, chainId: sibling.chainId } }), 0);
  assert.deepEqual(
    await db.task.findMany({
      where: { projectId: left.project.id, chainId: sibling.chainId },
      orderBy: { chainIndex: "asc" },
      select: { id: true, status: true, chainId: true, chainIndex: true, chainLayer: true },
    }),
    siblingTasksBefore,
  );
  assert.equal((await call(`/tasks/${right.first.id}/chain/hold`, { requestId: "same-request" })).status, 200);
  const leftControl = await db.chainControl.findUniqueOrThrow({ where: { projectId_chainId: { projectId: left.project.id, chainId: left.chainId } } });
  const rightControl = await db.chainControl.findUniqueOrThrow({ where: { projectId_chainId: { projectId: right.project.id, chainId: right.chainId } } });
  await assert.rejects(db.chainControlEvent.create({ data: {
    chainControlId: leftControl.id,
    kind: ChainControlState.HELD,
    layer: 1,
    actorType: "operator",
    requestId: "same-request",
    holdGeneration: 1,
  } }));
  assert.equal(await db.chainControlEvent.count({ where: { chainControlId: leftControl.id } }), 1);
  assert.equal(await db.chainControlEvent.count({ where: { chainControlId: rightControl.id } }), 1);
});

test("Hold records the next non-DONE layer even when no Run is active", async () => {
  const chain = await seedChain();
  await db.task.update({ where: { id: chain.first.id }, data: { status: TaskStatus.DONE } });
  assert.equal(await db.run.count(), 0);

  const held = await holdDirect(chain, chain.first.id, "hold-without-run");
  assert.equal(held.status, 200);
  assert.equal(held.body.control.heldLayer, 2);
  const control = await db.chainControl.findUniqueOrThrow({ where: { projectId_chainId: {
    projectId: chain.project.id,
    chainId: chain.chainId,
  } } });
  assert.equal(control.heldLayer, 2);
  assert.equal(control.state, ChainControlState.HELD);
});

test("operator cannot move AGENT chain steps to Backlog or change ChainControl", async () => {
  const unheld = await seedChain();
  const beforeUnheld = await getTasks(unheld.project.id);
  const unheldProgress = beforeUnheld.body.find((task: any) => task.id === unheld.first.id).chainProgress;
  const parked = await patchTask(`/tasks/${unheld.second.id}`, { status: TaskStatus.BACKLOG });
  assert.equal(parked.status, 409, JSON.stringify(parked.body));
  assert.equal(await db.chainControl.count({ where: { projectId: unheld.project.id, chainId: unheld.chainId } }), 0);
  const afterUnheld = await getTasks(unheld.project.id);
  assert.deepEqual(afterUnheld.body.find((task: any) => task.id === unheld.first.id).chainProgress, unheldProgress);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: unheld.second.id } })).status, TaskStatus.TODO);

  const held = await seedChain();
  assert.equal((await call(`/tasks/${held.first.id}/chain/hold`, { requestId: "hold-before-move" })).status, 200);
  const beforeControl = await db.chainControl.findUniqueOrThrow({ where: { projectId_chainId: {
    projectId: held.project.id,
    chainId: held.chainId,
  } } });
  const beforeHeld = await getTasks(held.project.id);
  const heldProgress = beforeHeld.body.find((task: any) => task.id === held.first.id).chainProgress;
  const heldParked = await patchTask(`/tasks/${held.third.id}`, { status: TaskStatus.BACKLOG });
  assert.equal(heldParked.status, 409, JSON.stringify(heldParked.body));
  const afterControl = await db.chainControl.findUniqueOrThrow({ where: { projectId_chainId: {
    projectId: held.project.id,
    chainId: held.chainId,
  } } });
  assert.deepEqual(afterControl, beforeControl);
  const afterHeld = await getTasks(held.project.id);
  assert.deepEqual(afterHeld.body.find((task: any) => task.id === held.first.id).chainProgress, heldProgress);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: held.third.id } })).status, TaskStatus.TODO);
});
