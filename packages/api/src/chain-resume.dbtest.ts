import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  AssigneeType,
  ChainControlState,
  holdChain,
  PrismaClient,
  resumeChain,
  RunStatus,
  TaskStatus,
} from "@anneal/db";

import {
  CHAIN_OPERATOR_TOKEN,
  CHAIN_RUNNER_TOKEN,
  chainAuditSnapshot,
  operatorRequest,
  runnerCompletionRequest,
  seedBasicChain,
  seedRun,
} from "./chain-hold-resume-fixture.js";
import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";

let db: PrismaClient;
const priorOperatorToken = process.env.OPERATOR_TOKEN;
const priorRunnerToken = process.env.RUNNER_TOKEN;

before(() => {
  process.env.OPERATOR_TOKEN = CHAIN_OPERATOR_TOKEN;
  process.env.RUNNER_TOKEN = CHAIN_RUNNER_TOKEN;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  if (priorOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = priorOperatorToken;
  if (priorRunnerToken === undefined) delete process.env.RUNNER_TOKEN;
  else process.env.RUNNER_TOKEN = priorRunnerToken;
});

const hold = async (
  chain: Awaited<ReturnType<typeof seedBasicChain>>,
  requestId: string,
  reason = "inspect",
  client = db,
) => {
  const body = await client.$transaction((tx) => holdChain(tx, {
    projectId: chain.project.id,
    chainId: chain.chainId,
    taskId: chain.second.id,
    requestId,
    reason,
  }));
  if ("message" in body) assert.fail(body.message);
  return { status: 200, body };
};

const resume = async (
  taskId: string,
  requestId: string,
  client = db,
): Promise<{ status: number; body: any }> => {
  const task = await client.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { projectId: true, chainId: true },
  });
  const chainId = task.chainId;
  if (!chainId) assert.fail("direct Resume requires a Chain task");
  const body = await client.$transaction((tx) => resumeChain(tx, {
    projectId: task.projectId,
    chainId,
    taskId,
    requestId,
  }, new Date()));
  if ("message" in body) assert.fail(body.message);
  return { status: 200, body };
};

const resumeHttp = (taskId: string, requestId: string, client = db) =>
  operatorRequest(client, `/tasks/${taskId}/chain/resume`, { requestId });

const completion = (run: { id: string; runnerId: string | null; fencingToken: string | null }, output = "completion output", client = db) =>
  runnerCompletionRequest(client, run, output);

const createClient = () => new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });

/** Resolve a callback transaction's first raw lock query while retaining the lock. */
const instrumentTransactions = (
  client: PrismaClient,
  onQuery: (pending: Promise<unknown>, sql: string) => Promise<unknown> | unknown,
): PrismaClient => new Proxy(client, {
  get(target, property, receiver) {
    if (property !== "$transaction") {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return (operation: (tx: any) => Promise<unknown>, options: unknown) => target.$transaction(async (tx) => {
      const instrumentedTx = new Proxy(tx, {
        get(txTarget, txProperty, txReceiver) {
          if (txProperty !== "$queryRaw") return Reflect.get(txTarget, txProperty, txReceiver);
          return (...args: unknown[]) => {
            const query = args[0] as string[] | { strings?: string[] } | undefined;
            const sql = Array.isArray(query) ? query.join(" ") : query?.strings?.join(" ") ?? "";
            return onQuery(Reflect.apply(txTarget.$queryRaw, txTarget, args), sql);
          };
        },
      });
      return operation(instrumentedTx);
    }, options as any);
  },
}) as PrismaClient;

const serialized = (value: unknown): string => JSON.stringify(value, (_key, current) => (
  current instanceof Date ? current.toISOString() : current
));

test("Resume releases a completed held layer and activates only one immediate successor layer", async () => {
  const chain = await seedBasicChain(db);
  const resumed = await resume(chain.second.id, "resume-1");
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(resumed.body.duplicate, false);
  assert.equal(resumed.body.control.state, "released");
  assert.equal(resumed.body.control.releaseRequestId, "resume-1");
  assert.equal(resumed.body.control.holdGeneration, 1);
  assert.equal(await db.run.count({ where: { taskId: chain.second.id, status: RunStatus.QUEUED } }), 1);
  assert.equal(await db.run.count({ where: { taskId: chain.third.id } }), 0);
  assert.equal(await db.chainControlEvent.count({ where: { chainControlId: chain.control!.id } }), 2);
});

test("two concurrent Resume requests have one release, event, and activation", async () => {
  const chain = await seedBasicChain(db);
  const [first, second] = await Promise.all([
    resume(chain.second.id, "resume-concurrent-a"),
    resume(chain.second.id, "resume-concurrent-b"),
  ]);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal([first.body.duplicate, second.body.duplicate].filter((value) => value === false).length, 1);
  assert.equal(await db.chainControlEvent.count({ where: { chainControlId: chain.control!.id, kind: ChainControlState.RELEASED } }), 1);
  assert.equal(await db.run.count({ where: { taskId: chain.second.id, status: RunStatus.QUEUED } }), 1);
  assert.equal(await db.run.count({ where: { taskId: chain.third.id } }), 0);
});

test("a Resume that loses the holdGeneration compare-and-set is an idempotent success", async () => {
  const chain = await seedBasicChain(db);
  const body = await db.$transaction((tx) => {
    const instrumented = new Proxy(tx, {
      get(target, property, receiver) {
        if (property !== "chainControl") return Reflect.get(target, property, receiver);
        return new Proxy(target.chainControl, {
          get(delegate, operation, delegateReceiver) {
            if (operation === "updateMany") return async () => ({ count: 0 });
            const value = Reflect.get(delegate, operation, delegateReceiver);
            return typeof value === "function" ? value.bind(delegate) : value;
          },
        });
      },
    });
    return resumeChain(instrumented, {
      projectId: chain.project.id,
      chainId: chain.chainId,
      taskId: chain.first.id,
      requestId: "resume-cas-loser",
    }, new Date());
  });
  if ("message" in body) assert.fail(body.message);
  assert.equal(body.duplicate, true);
  assert.equal(body.control?.state, "held");
  assert.equal((await db.chainControl.findUniqueOrThrow({ where: { id: chain.control!.id } })).state, ChainControlState.HELD);
  assert.equal(await db.chainControlEvent.count({
    where: { chainControlId: chain.control!.id, kind: ChainControlState.RELEASED },
  }), 0);
});

test("concurrent Resume activates every node in one eligible fan-out layer exactly once", async () => {
  const chain = await seedBasicChain(db, {
    statuses: [TaskStatus.DONE, TaskStatus.TODO, TaskStatus.TODO],
    layers: [1, 2, 2],
  });
  const [first, second] = await Promise.all([
    resume(chain.first.id, "resume-fanout-a"),
    resume(chain.first.id, "resume-fanout-b"),
  ]);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal([first.body.duplicate, second.body.duplicate].filter((value) => value === false).length, 1);
  assert.equal(await db.run.count({ where: { taskId: chain.second.id, status: RunStatus.QUEUED } }), 1);
  assert.equal(await db.run.count({ where: { taskId: chain.third.id, status: RunStatus.QUEUED } }), 1);
  assert.equal(await db.run.count({ where: { taskId: { in: [chain.second.id, chain.third.id] } } }), 2);
});

test("Resume while the held layer runs only releases; ordinary completion then activates the next layer", async () => {
  const chain = await seedBasicChain(db, { statuses: [TaskStatus.DOING, TaskStatus.TODO, TaskStatus.TODO] });
  const running = await seedRun(db, chain, chain.first.id);
  const released = await resume(chain.first.id, "resume-running");
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal(released.body.nextTaskId, null);
  assert.equal(await db.run.count({ where: { taskId: chain.second.id } }), 0);

  const completed = await completion(running.run, "ordinary completion after release");
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.first.id } })).status, TaskStatus.DONE);
  assert.equal(await db.run.count({ where: { taskId: chain.second.id, status: RunStatus.QUEUED } }), 1);
});

test("never-held and already-released Resume are 200 no-ops with byte-stable state", async () => {
  const neverHeld = await seedBasicChain(db, { control: null });
  const beforeNeverHeld = await chainAuditSnapshot(db, neverHeld);
  const neverHeldResponse = await resume(neverHeld.first.id, "resume-never-held");
  assert.equal(neverHeldResponse.status, 200);
  assert.equal(neverHeldResponse.body.duplicate, true);
  assert.equal(serialized(await chainAuditSnapshot(db, neverHeld)), serialized(beforeNeverHeld));

  const released = await seedBasicChain(db, {
    control: {
      state: ChainControlState.RELEASED,
      heldLayer: 1,
      holdGeneration: 4,
      holdRequestId: "hold-old",
      holdReason: "old reason",
      heldAt: new Date("2026-08-28T01:00:00.000Z"),
      releasedAt: new Date("2026-08-28T01:01:00.000Z"),
      releaseRequestId: "resume-old",
    },
  });
  const beforeReleased = await chainAuditSnapshot(db, released);
  const alreadyReleased = await resume(released.first.id, "resume-already-released");
  assert.equal(alreadyReleased.status, 200);
  assert.equal(alreadyReleased.body.duplicate, true);
  assert.equal(serialized(await chainAuditSnapshot(db, released)), serialized(beforeReleased));
});

test("a cancelled Run and provider conversation stay terminal while Resume creates a fresh Run", async () => {
  const chain = await seedBasicChain(db);
  const cancelled = await seedRun(db, chain, chain.second.id, {
    status: RunStatus.CANCELLED,
    providerConversationId: "provider-cancelled",
  });
  const resumed = await resume(chain.first.id, "resume-fresh-run");
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  const oldRun = await db.run.findUniqueOrThrow({ where: { id: cancelled.run.id }, include: { session: true } });
  assert.equal(oldRun.status, RunStatus.CANCELLED);
  assert.equal(oldRun.session?.providerConversationId, "provider-cancelled");
  const fresh = await db.run.findFirstOrThrow({ where: { taskId: chain.second.id, id: { not: oldRun.id } }, include: { session: true } });
  assert.equal(fresh.status, RunStatus.QUEUED);
  assert.equal(fresh.runNumber, oldRun.runNumber + 1);
  assert.equal(fresh.session, null);
  assert.equal(fresh.sessionTokenHash, null);
});

test("Resume opens an approval successor from the succeeded source, never a newer cancelled Run", async () => {
  const chain = await seedBasicChain(db, {
    statuses: [TaskStatus.DONE, TaskStatus.TODO],
    layers: [1, 2],
  });
  await db.task.update({ where: { id: chain.second.id }, data: {
    assigneeType: AssigneeType.HUMAN,
    assigneeAgentId: null,
    repoId: null,
    approvalGate: true,
  } });
  const succeeded = await seedRun(db, chain, chain.first.id, {
    status: RunStatus.SUCCEEDED,
    providerConversationId: "succeeded-source-conversation",
  });
  const cancelled = await seedRun(db, chain, chain.first.id, {
    status: RunStatus.CANCELLED,
    providerConversationId: "cancelled-newer-conversation",
  });

  const resumed = await resume(chain.first.id, "resume-approval-source");
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.second.id } })).status, TaskStatus.REVIEW);
  const gate = await db.inboxMessage.findFirstOrThrow({ where: { gateTaskId: chain.second.id, status: "OPEN" } });
  const succeededSession = await db.session.findUniqueOrThrow({ where: { runId: succeeded.run.id } });
  const cancelledSession = await db.session.findUniqueOrThrow({ where: { runId: cancelled.run.id } });
  assert.equal(gate.sessionId, succeededSession.id);
  assert.notEqual(gate.sessionId, cancelledSession.id);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: cancelled.run.id } })).status, RunStatus.CANCELLED);
});

test("Resume refuses an approval successor when the completed layer has no succeeded source session", async () => {
  const chain = await seedBasicChain(db, {
    statuses: [TaskStatus.DONE, TaskStatus.TODO],
    layers: [1, 2],
  });
  await db.task.update({ where: { id: chain.second.id }, data: {
    assigneeType: AssigneeType.HUMAN,
    assigneeAgentId: null,
    repoId: null,
    approvalGate: true,
  } });
  await seedRun(db, chain, chain.first.id, { status: RunStatus.CANCELLED });
  const resumed = await resumeHttp(chain.first.id, "resume-approval-without-source");
  assert.equal(resumed.status, 409, JSON.stringify(resumed.body));
  assert.equal((await db.chainControl.findUniqueOrThrow({ where: { id: chain.control!.id } })).state, ChainControlState.HELD);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.second.id } })).status, TaskStatus.TODO);
  assert.equal(await db.inboxMessage.count({ where: { gateTaskId: chain.second.id } }), 0);
});

test("Resume leaves a BACKLOG successor parked and preserves the parked-skip narration", async () => {
  const chain = await seedBasicChain(db, { statuses: [TaskStatus.DONE, TaskStatus.BACKLOG, TaskStatus.TODO] });
  const resumed = await resume(chain.first.id, "resume-backlog");
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.second.id } })).status, TaskStatus.BACKLOG);
  assert.equal(await db.run.count({ where: { taskId: chain.second.id } }), 0);
  const activity = await db.taskActivity.findFirst({
    where: { taskId: chain.second.id, body: { contains: "parked in Backlog" } },
    orderBy: { id: "desc" },
  });
  assert.ok(activity, "activation records the existing BACKLOG park narration");
});

test("Resume releases the hold when a human BACKLOG successor needs no source Run", async () => {
  const chain = await seedBasicChain(db, { statuses: [TaskStatus.DONE, TaskStatus.BACKLOG] });
  await db.task.update({ where: { id: chain.second.id }, data: {
    assigneeType: AssigneeType.HUMAN,
    assigneeAgentId: null,
    repoId: null,
    approvalGate: true,
  } });

  const resumed = await resume(chain.first.id, "resume-human-backlog");
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(resumed.body.duplicate, false);
  assert.equal(resumed.body.control.state, "released");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.second.id } })).status, TaskStatus.BACKLOG);
  assert.equal(await db.run.count({ where: { taskId: chain.second.id } }), 0);
  assert.equal(await db.taskActivity.count({
    where: { taskId: chain.second.id, body: { contains: "parked in Backlog" } },
  }), 1);
});

test("chainless and unknown Resume addresses are rejected without creating control state", async () => {
  const chain = await seedBasicChain(db, { control: null });
  const chainless = await db.task.create({
    data: {
      projectId: chain.project.id,
      repoId: chain.repo.id,
      assigneeAgentId: chain.agent.id,
      name: "Chainless",
      description: "chainless",
    },
  });
  const chainlessResponse = await resumeHttp(chainless.id, "resume-chainless");
  assert.equal(chainlessResponse.status, 409);
  const unknownResponse = await resumeHttp("task-does-not-exist", "resume-unknown");
  assert.equal(unknownResponse.status, 404);
  assert.equal(await db.chainControl.count(), 0);
});

test("release writes exact fields and event facts, and a replay leaves every byte unchanged", async () => {
  const chain = await seedBasicChain(db, { label: "exact-release" });
  const before = await db.chainControl.findUniqueOrThrow({ where: { id: chain.control!.id } });
  const result = await resume(chain.first.id, "resume-exact");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const control = await db.chainControl.findUniqueOrThrow({ where: { id: chain.control!.id } });
  assert.equal(control.state, ChainControlState.RELEASED);
  assert.equal(control.heldLayer, before.heldLayer);
  assert.equal(control.holdGeneration, before.holdGeneration);
  assert.equal(control.releaseRequestId, "resume-exact");
  assert.ok(control.releasedAt instanceof Date);
  assert.ok(control.releasedAt!.getTime() >= before.heldAt!.getTime());
  const event = await db.chainControlEvent.findFirstOrThrow({ where: { chainControlId: control.id, kind: ChainControlState.RELEASED } });
  assert.equal(event.layer, before.heldLayer);
  assert.equal(event.actorType, "operator");
  assert.equal(event.actorId, null);
  assert.equal(event.requestId, "resume-exact");
  assert.equal(event.reason, null);
  assert.equal(event.holdGeneration, before.holdGeneration);
  assert.ok(event.createdAt instanceof Date);
  const afterRelease = await chainAuditSnapshot(db, chain);
  const replay = await resume(chain.first.id, "resume-exact");
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);
  assert.equal(serialized(await chainAuditSnapshot(db, chain)), serialized(afterRelease));
});

test("three alternating Hold/Resume cycles append exact events and no-op replays", async () => {
  const chain = await seedBasicChain(db, { statuses: [TaskStatus.DOING, TaskStatus.TODO], control: null });
  const runsBefore = await db.run.count({ where: { taskId: { in: chain.tasks.map((task) => task.id) } } });
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const held = await hold(chain, `hold-cycle-${cycle}`, cycle === 2 ? "second reason" : "cycle reason");
    assert.equal(held.status, 200, JSON.stringify(held.body));
    assert.equal(held.body.duplicate, false);
    const released = await resume(chain.first.id, `resume-cycle-${cycle}`);
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal(released.body.duplicate, false);
    const replayHold = await hold(chain, `hold-cycle-${cycle}`, "ignored replay");
    const replayResume = await resume(chain.first.id, `resume-cycle-${cycle}`);
    assert.equal(replayHold.body.duplicate, true);
    assert.equal(replayResume.body.duplicate, true);
    assert.equal(await db.run.count({ where: { taskId: { in: chain.tasks.map((task) => task.id) } } }), runsBefore);
  }
  const control = await db.chainControl.findUniqueOrThrow({ where: { projectId_chainId: { projectId: chain.project.id, chainId: chain.chainId } } });
  const events = await db.chainControlEvent.findMany({ where: { chainControlId: control.id }, orderBy: { createdAt: "asc" } });
  assert.equal(events.length, 6);
  assert.deepEqual(events.map((event) => event.kind), [
    ChainControlState.HELD, ChainControlState.RELEASED,
    ChainControlState.HELD, ChainControlState.RELEASED,
    ChainControlState.HELD, ChainControlState.RELEASED,
  ]);
  assert.deepEqual(events.map((event) => event.holdGeneration), [1, 1, 2, 2, 3, 3]);
  assert.deepEqual(events.map((event) => event.requestId), [
    "hold-cycle-1", "resume-cycle-1", "hold-cycle-2", "resume-cycle-2",
    "hold-cycle-3", "resume-cycle-3",
  ]);
  assert.deepEqual(events.map((event) => event.layer), [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(events.map((event) => event.actorType), Array.from({ length: 6 }, () => "operator"));
  assert.deepEqual(events.map((event) => event.actorId), Array.from({ length: 6 }, () => null));
  assert.deepEqual(events.map((event) => event.reason), [
    "cycle reason", null, "second reason", null, "cycle reason", null,
  ]);
  assert.ok(events.every((event) => event.createdAt instanceof Date));
  assert.equal(control.holdGeneration, 3);
  assert.equal(control.state, ChainControlState.RELEASED);
});

test("delayed Hold/Resume replays cannot cross an opposite transition or add activity, runs, or events", async () => {
  const chain = await seedBasicChain(db, { statuses: [TaskStatus.DOING, TaskStatus.TODO] });
  const firstResume = await resume(chain.first.id, "resume-delayed-1");
  assert.equal(firstResume.body.duplicate, false);
  const secondHold = await hold(chain, "hold-delayed-2", "second");
  assert.equal(secondHold.body.duplicate, false);
  const before = await chainAuditSnapshot(db, chain);
  const [replayedHold, replayedResume] = await Promise.all([
    hold(chain, "hold-fixture", "stale hold"),
    resume(chain.first.id, "resume-delayed-1"),
  ]);
  assert.equal(replayedHold.status, 200);
  assert.equal(replayedResume.status, 200);
  assert.equal(replayedHold.body.duplicate, true);
  assert.equal(replayedResume.body.duplicate, true);
  const after = await chainAuditSnapshot(db, chain);
  assert.equal(after.events.length, before.events.length);
  assert.equal(after.activities.length, before.activities.length);
  assert.equal(after.runs.length, before.runs.length);
  assert.equal(serialized(after.control), serialized(before.control));
});

test("completion and Resume settle safely when Resume wins the Chain mutex", async () => {
  const chain = await seedBasicChain(db, { statuses: [TaskStatus.DOING, TaskStatus.TODO, TaskStatus.TODO] });
  const running = await seedRun(db, chain, chain.first.id);
  let releaseFirst!: () => void;
  let firstLocked!: () => void;
  let secondAttempted!: () => void;
  let firstObserved = false;
  let secondObserved = false;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstLock = new Promise<void>((resolve) => { firstLocked = resolve; });
  const secondLockAttempt = new Promise<void>((resolve) => { secondAttempted = resolve; });
  const firstDb = instrumentTransactions(createClient(), async (pending, sql) => {
    const result = await pending;
    if (!firstObserved && sql.includes("chainLayer")) {
      firstObserved = true;
      firstLocked();
      await firstGate;
    }
    return result;
  });
  const secondDb = instrumentTransactions(createClient(), (pending, sql) => {
    if (!secondObserved && sql.includes("chainLayer")) {
      secondObserved = true;
      secondAttempted();
    }
    return pending;
  });
  try {
    const resumeRequest = resume(chain.first.id, "resume-race-resume-first", firstDb);
    await firstLock;
    const completionRequest = completion(running.run, "resume won before completion", secondDb);
    await secondLockAttempt;
    releaseFirst();
    const [resumed, completed] = await Promise.all([resumeRequest, completionRequest]);
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.nextTaskId, null);
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
  } finally {
    releaseFirst();
    await Promise.all([firstDb.$disconnect(), secondDb.$disconnect()]);
  }
  assert.equal(await db.chainControlEvent.count({ where: { chainControlId: chain.control!.id, kind: ChainControlState.RELEASED } }), 1);
  assert.equal(await db.run.count({ where: { taskId: chain.second.id, status: RunStatus.QUEUED } }), 1);
  assert.equal(await db.run.count({ where: { taskId: chain.third.id } }), 0);
});

test("completion and Resume settle safely when completion wins the Chain mutex", async () => {
  const chain = await seedBasicChain(db, { statuses: [TaskStatus.DOING, TaskStatus.TODO, TaskStatus.TODO] });
  const running = await seedRun(db, chain, chain.first.id);
  let releaseFirst!: () => void;
  let firstLocked!: () => void;
  let secondAttempted!: () => void;
  let firstObserved = false;
  let secondObserved = false;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstLock = new Promise<void>((resolve) => { firstLocked = resolve; });
  const secondLockAttempt = new Promise<void>((resolve) => { secondAttempted = resolve; });
  const firstDb = instrumentTransactions(createClient(), async (pending, sql) => {
    const result = await pending;
    if (!firstObserved && sql.includes("chainLayer")) {
      firstObserved = true;
      firstLocked();
      await firstGate;
    }
    return result;
  });
  const secondDb = instrumentTransactions(createClient(), (pending, sql) => {
    if (!secondObserved && sql.includes("chainLayer")) {
      secondObserved = true;
      secondAttempted();
    }
    return pending;
  });
  try {
    const completionRequest = completion(running.run, "completion won before Resume", firstDb);
    await firstLock;
    const resumeRequest = resume(chain.first.id, "resume-race-completion-first", secondDb);
    await secondLockAttempt;
    releaseFirst();
    const [completed, resumed] = await Promise.all([completionRequest, resumeRequest]);
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.duplicate, false);
  } finally {
    releaseFirst();
    await Promise.all([firstDb.$disconnect(), secondDb.$disconnect()]);
  }
  assert.equal(await db.run.count({ where: { taskId: chain.second.id } }), 1);
  assert.equal(await db.chainControlEvent.count({ where: { chainControlId: chain.control!.id, kind: ChainControlState.RELEASED } }), 1);
  assert.equal(await db.run.count({ where: { taskId: chain.second.id, status: RunStatus.QUEUED } }), 1);
  assert.equal(await db.run.count({ where: { taskId: chain.third.id } }), 0);
  assert.equal(await db.taskActivity.count({ where: { taskId: chain.first.id, body: { contains: "activation withheld" } } }), 1);
});
