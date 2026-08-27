import "./test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import { InboxStatus, type PrismaClient } from "@agentos/db";

import { createApp } from "./test-app.js";

const withTokens = async (callback: () => Promise<void>): Promise<void> => {
  const operator = process.env.OPERATOR_TOKEN;
  const runner = process.env.RUNNER_TOKEN;
  process.env.OPERATOR_TOKEN = "operator-superseded-close-token";
  process.env.RUNNER_TOKEN = "runner-superseded-close-token";
  try {
    await callback();
  } finally {
    if (operator === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = operator;
    if (runner === undefined) delete process.env.RUNNER_TOKEN;
    else process.env.RUNNER_TOKEN = runner;
  }
};

type Fixture = {
  database: PrismaClient;
  status: InboxStatus;
  taskArchived: boolean;
  updateCount: number;
  taskLockCount: number;
  taskUpdateCount: number;
  runWriteCount: number;
  activityWriteCount: number;
  activityWrites: Array<Record<string, unknown>>;
  answeredAt: Date | null;
};

const fixture = (options: {
  status?: InboxStatus;
  taskArchived?: boolean;
  taskId?: string | null;
  from?: "AGENT" | "HUMAN";
  gateTaskId?: string | null;
  replyToMessageId?: string | null;
  messageMissing?: boolean;
  loseCas?: boolean;
} = {}): Fixture => {
  const state = {
    status: options.status ?? InboxStatus.OPEN,
    taskArchived: options.taskArchived ?? true,
    taskId: options.taskId === undefined ? "task-1" : options.taskId,
    from: options.from ?? "AGENT",
    gateTaskId: options.gateTaskId ?? null,
    replyToMessageId: options.replyToMessageId ?? null,
    messageMissing: options.messageMissing ?? false,
    loseCas: options.loseCas ?? false,
    updateCount: 0,
    taskLockCount: 0,
    taskUpdateCount: 0,
    runWriteCount: 0,
    activityWriteCount: 0,
    activityWrites: [] as Array<Record<string, unknown>>,
    answeredAt: null as Date | null,
  };
  const task = {
    id: "task-1",
    status: "DONE",
    archivedAt: state.taskArchived ? new Date("2026-08-25T12:00:00.000Z") : null,
    projectId: "project-1",
    chainId: null,
    dispatchAfterTaskId: null,
    dispatchAfter: null,
    assigneeType: "AGENT",
    assigneeAgentId: null,
    templateStep: null,
  };
  const tx = {
    $queryRaw: async () => {
      state.taskLockCount += 1;
      return [{ id: task.id }];
    },
    task: {
      findUnique: async ({ select }: { select?: Record<string, unknown> }) => (
        select && "chainId" in select ? { projectId: task.projectId, chainId: task.chainId } : task
      ),
      findUniqueOrThrow: async () => task,
      update: async () => {
        state.taskUpdateCount += 1;
        throw new Error("supersede must not update a task");
      },
    },
    inboxMessage: {
      findUnique: async ({ select }: { select?: Record<string, unknown> }) => {
        if (state.messageMissing) return null;
        if (select && "status" in select) {
          return {
            status: state.status,
            from: state.from,
            taskId: state.taskId,
            gateTaskId: state.gateTaskId,
            replyToMessageId: state.replyToMessageId,
          };
        }
        return { taskId: state.taskId };
      },
      updateMany: async ({ data }: { data: { status: InboxStatus; answeredAt?: Date } }) => {
        if (state.status !== InboxStatus.OPEN || state.loseCas) return { count: 0 };
        state.status = data.status;
        state.answeredAt = data.answeredAt ?? null;
        state.updateCount += 1;
        return { count: 1 };
      },
    },
    run: {
      update: async () => {
        state.runWriteCount += 1;
        throw new Error("supersede must not update a run");
      },
    },
    taskActivity: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.activityWriteCount += 1;
        state.activityWrites.push(data);
        return data;
      },
    },
  };
  return Object.assign(state, {
    database: {
      ...tx,
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient,
  });
};

const request = (
  database: PrismaClient,
  path: string,
  token: string | null = "operator-superseded-close-token",
  requestId = "supersede-message-1",
) => createApp(database).request(path, {
  method: "POST",
  headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ requestId }),
});

test("supersede requires the operator principal and does not touch the database when refused", async () => {
  await withTokens(async () => {
    const unauthenticated = fixture();
    assert.equal((await request(unauthenticated.database, "/inbox/messages/message-1/supersede", null)).status, 401);
    assert.equal(unauthenticated.taskLockCount, 0);

    const runner = fixture();
    assert.equal((await request(runner.database, "/inbox/messages/message-1/supersede", "runner-superseded-close-token")).status, 403);
    assert.equal(runner.taskLockCount, 0);
  });
});

test("operator supersede closes an open message for an archived task under the task-row lock", async () => {
  await withTokens(async () => {
    const state = fixture();
    const response = await request(state.database, "/inbox/messages/message-1/supersede");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      closed: true,
      duplicate: false,
      requestId: "supersede-message-1",
    });
    assert.equal(state.status, InboxStatus.CLOSED);
    assert.equal(state.answeredAt, null, "superseding is not an answer");
    assert.equal(state.updateCount, 1);
    assert.equal(state.taskLockCount, 1, "archivedAt is checked while the Task row is locked");
    assert.equal(state.taskUpdateCount, 0);
    assert.equal(state.runWriteCount, 0);
    assert.equal(state.activityWriteCount, 1);
    assert.deepEqual(state.activityWrites, [{
      taskId: "task-1",
      actorType: "operator",
      body: "Inbox message superseded",
      metadata: {
        inboxMessageId: "message-1",
        requestId: "supersede-message-1",
      },
    }]);
  });
});

test("supersede refuses an unarchived task without changing the Inbox message", async () => {
  await withTokens(async () => {
    const state = fixture({ taskArchived: false });
    const response = await request(state.database, "/inbox/messages/message-1/supersede");
    assert.equal(response.status, 409);
    assert.match(String((await response.json() as { error: string }).error), /archived task/u);
    assert.equal(state.status, InboxStatus.OPEN);
    assert.equal(state.updateCount, 0);
    assert.equal(state.taskUpdateCount, 0);
    assert.equal(state.runWriteCount, 0);
    assert.equal(state.activityWriteCount, 0);
  });
});

test("supersede refuses human replies and other non-top-level messages", async () => {
  await withTokens(async () => {
    for (const options of [{ from: "HUMAN" as const }, { replyToMessageId: "parent-1" }]) {
      const state = fixture(options);
      const response = await request(state.database, "/inbox/messages/message-1/supersede");
      assert.equal(response.status, 409);
      assert.match(String((await response.json() as { error: string }).error), /top-level agent/u);
      assert.equal(state.updateCount, 0);
      assert.equal(state.taskLockCount, 0);
    }
  });
});

test("supersede refuses approval-gate cards without changing the Inbox message", async () => {
  await withTokens(async () => {
    const state = fixture({ gateTaskId: "task-1" });
    const response = await request(state.database, "/inbox/messages/message-1/supersede");
    assert.equal(response.status, 409);
    assert.match(String((await response.json() as { error: string }).error), /non-gate Inbox message/u);
    assert.equal(state.updateCount, 0);
    assert.equal(state.taskLockCount, 0);
    assert.equal(state.activityWriteCount, 0);
  });
});

test("supersede refuses a missing or detached Inbox message before locking a task", async () => {
  await withTokens(async () => {
    const missing = fixture({ messageMissing: true });
    const missingResponse = await request(missing.database, "/inbox/messages/message-1/supersede");
    assert.equal(missingResponse.status, 404);
    assert.equal((await missingResponse.json() as { error: string }).error, "Inbox message not found");
    assert.equal(missing.taskLockCount, 0);

    const detached = fixture({ taskId: null });
    const detachedResponse = await request(detached.database, "/inbox/messages/message-1/supersede");
    assert.equal(detachedResponse.status, 409);
    assert.match(String((await detachedResponse.json() as { error: string }).error), /task-linked/u);
    assert.equal(detached.taskLockCount, 0);
  });
});

test("supersede reports a lost compare-and-set without recording an activity", async () => {
  await withTokens(async () => {
    const state = fixture({ loseCas: true });
    const response = await request(state.database, "/inbox/messages/message-1/supersede");
    assert.equal(response.status, 409);
    assert.match(String((await response.json() as { error: string }).error), /changed before/u);
    assert.equal(state.updateCount, 0);
    assert.equal(state.activityWriteCount, 0);
  });
});

test("supersede is idempotent on replay, including when the request id changes", async () => {
  await withTokens(async () => {
    const state = fixture();
    const first = await request(state.database, "/inbox/messages/message-1/supersede", "operator-superseded-close-token", "first-request");
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {
      closed: true,
      duplicate: false,
      requestId: "first-request",
    });
    const replay = await request(state.database, "/inbox/messages/message-1/supersede", "operator-superseded-close-token", "retry-with-new-request-id");
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), {
      closed: false,
      duplicate: true,
      requestId: "retry-with-new-request-id",
    });
    assert.equal(state.updateCount, 1);
    assert.equal(state.taskLockCount, 1, "the replay needs no second lifecycle lock");
    assert.equal(state.activityWriteCount, 1, "the replay does not duplicate the audit activity");
  });
});

test("detached notifications retain the original close route contract", async () => {
  await withTokens(async () => {
    const state = fixture();
    const notification = {
      id: "message-1",
      status: InboxStatus.OPEN,
      from: "AGENT",
      kind: "TEXT",
      gateTaskId: null,
      replyToMessageId: null,
    };
    let closed = 0;
    const database = {
      inboxMessage: {
        findUnique: async () => notification,
        updateMany: async () => {
          closed += 1;
          return { count: 1 };
        },
      },
      session: { findMany: async () => [] },
    } as unknown as PrismaClient;
    const response = await request(database, "/inbox/messages/message-1/close");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      closed: true,
      duplicate: false,
      requestId: "supersede-message-1",
    });
    assert.equal(closed, 1);
    assert.equal(state.updateCount, 0);
  });
});
