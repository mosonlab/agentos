import { createHash } from "node:crypto";

import {
  AssigneeType,
  InboxDeliveryStatus,
  InboxKind,
  InboxSender,
  InboxStatus,
  Prisma,
  RunStatus,
  RunnerKind,
  RunnerPreference,
  SessionExecutionStatus,
  TaskStatus,
  type PrismaClient,
} from "@prisma/client";

import { sharedChainBranch } from "./chain-branch.js";

type Tx = Prisma.TransactionClient;

const promptHash = (parts: string[]): string => createHash("sha256").update(parts.join("\n")).digest("hex");

export const runnerFor = (preference: RunnerPreference, model: string): RunnerKind => {
  if (preference === RunnerPreference.CLAUDE) return RunnerKind.CLAUDE;
  if (preference === RunnerPreference.CODEX) return RunnerKind.CODEX;
  if (preference === RunnerPreference.PI) return RunnerKind.PI;
  const normalized = model.toLowerCase();
  if (normalized.includes("codex")) return RunnerKind.CODEX;
  if (normalized.includes("deepseek") || normalized.split(/[\/:_-]+/u).includes("pi")) return RunnerKind.PI;
  return RunnerKind.CLAUDE;
};

export const deriveRunConfig = (
  agent: {
    runnerPreference: RunnerPreference;
    model: string;
    foundationalPrompt: string;
    rolePrompt: string;
  },
  templateStep: { runner: RunnerKind | null } | null,
  task: { name: string; description: string },
): { runner: RunnerKind; model: string; promptHash: string } => ({
  runner: templateStep?.runner ?? runnerFor(agent.runnerPreference, agent.model),
  model: agent.model,
  promptHash: promptHash([
    agent.foundationalPrompt,
    agent.rolePrompt,
    task.name,
    task.description,
  ]),
});

export class ArchivedAssigneeError extends Error {
  constructor(readonly taskId: string, readonly taskName: string, readonly agentName: string) {
    super(`Task ${taskName} assignee ${agentName} is archived; unarchive the agent to queue this step`);
    this.name = "ArchivedAssigneeError";
  }
}

export const isArchivedAssigneeError = (error: unknown): error is ArchivedAssigneeError =>
  error instanceof Error && error.name === "ArchivedAssigneeError";

/** An archived Task must not gain a run. Thrown from `enqueueTaskRun` itself
 *  rather than from each caller: this function is the single place a Run comes
 *  into existence, so guarding here closes the class instead of one path. */
export class ArchivedTaskError extends Error {
  constructor(readonly taskId: string, readonly taskName: string) {
    super(`Task ${taskName} is archived; unarchive it before queueing a run`);
    this.name = "ArchivedTaskError";
  }
}

export const isArchivedTaskError = (error: unknown): error is ArchivedTaskError =>
  error instanceof Error && error.name === "ArchivedTaskError";

/**
 * Takes the Task-row mutex the archive/start/retry/cron writers all take.
 *
 * `SELECT … FOR UPDATE` and not a plain read: under ReadCommitted a read of one
 * table is not re-evaluated when another transaction commits, so "no active run"
 * observed without the lock can be stale by the time the run is inserted.
 */
export const lockTaskRow = async (
  tx: Tx,
  taskId: string,
): Promise<{ id: string; archivedAt: Date | null } | null> => {
  const rows = await tx.$queryRaw<Array<{ id: string; archivedAt: Date | null }>>`
    SELECT "id", "archivedAt" FROM "Task" WHERE "id" = ${taskId} FOR UPDATE
  `;
  return rows[0] ?? null;
};

/** The shape `resolveRunBranches` needs. Structural rather than a Prisma payload
 *  type, so the five call sites can pass rows from five differently-shaped
 *  queries — the same reason `packages/api/src/chain.ts` keeps `ChainRow` plain. */
export type RunBranchTask = {
  id: string;
  projectId: string;
  repoId: string | null;
  chainId: string | null;
  chainIndex: number | null;
  templateId: string | null;
  targetBranch: string | null;
  repo: { defaultBranch: string };
};

/**
 * Decides a new Run's head (`branch`) and base (`targetBranch`). The only place
 * that decision is made; `enqueueTaskRun`, `POST /tasks`, the operator retry
 * route, the automatic retry in the completion transaction and the lost-lease
 * requeue all call this, because five copies of the expression is how step ①
 * ended up on a different branch from steps ②–⑨.
 *
 * Writes at most one TaskActivity row (see the chain branch below), so it takes
 * the caller's transaction.
 */
export const resolveRunBranches = async (
  tx: Tx,
  task: RunBranchTask,
  prior: { branch: string | null } | null,
): Promise<{ branch: string | null; targetBranch: string }> => {
  // Template chains are frozen. This early return is the whole guarantee: the
  // expression below is the pre-existing one, byte for byte, and nothing after
  // this point runs for a template task. `targetBranch !== defaultBranch` is
  // what keeps a template's step ① — whose targetBranch *is* the default
  // (templates.ts) — from trying to clone a branch that does not exist yet.
  if (task.templateId) {
    const chainBranch = task.targetBranch && task.targetBranch !== task.repo.defaultBranch
      ? task.targetBranch
      : null;
    return {
      branch: prior?.branch ?? chainBranch,
      targetBranch: prior?.branch ?? task.targetBranch ?? task.repo.defaultBranch,
    };
  }
  // A chainId with no index is a malformed one-row "chain" in the public API
  // and UI. It must remain isolated from indexed siblings that happen to carry
  // the same chainId (chain.dbtest.ts E1); treating it as an indexed chain here
  // would let it clone and publish those siblings' shared tree.
  if (!task.chainId || task.chainIndex === null) {
    return {
      branch: prior?.branch ?? null,
      targetBranch: prior?.branch ?? task.targetBranch ?? task.repo.defaultBranch,
    };
  }

  const shared = sharedChainBranch({ projectId: task.projectId, chainId: task.chainId });
  // "Has any step of this chain actually published the shared branch *on this
  // repo*?"
  //
  // Read `pushedBranch` and nothing else. It is written only after `git push`
  // returns, with the ref that was actually given to it, on both delivery paths
  // (delivery.ts). Do not "simplify" this into `branch` + `pushStatus` +
  // `status`: those three lie in both directions, and each direction breaks a
  // chain in a way no retry clears.
  //   - `branch` + `pushStatus`: a *failed* run whose WIP salvage push succeeded
  //     records pushStatus SUCCEEDED with `branch` still set to the workspace
  //     branch — the shared branch — while deliverFailedWorkspace actually
  //     pushed `agentos/<taskId>/run-<n>` (delivery.ts; runner.ts spreads the
  //     workspace result first). The next step would clone a ref nobody created.
  //   - adding `status`/`pushStatus = SUCCEEDED` to compensate: a run that
  //     pushed the branch and then hit any `gh` error is recorded FAILED and
  //     non-retryable (delivery.ts's catch; runner.ts's `succeeded`) even though
  //     the ref exists. The next step would base on the default branch, recreate
  //     the shared name locally, and be rejected non-fast-forward. Wedged for
  //     good — no retry clears it.
  //
  // Scoped by repo (spec R2: the same name on two remotes is two unrelated
  // refs) and restricted to indexed tasks. A chainIndex-null row is the API's
  // isolated 1/1 malformed-chain case and must neither contribute nor consume
  // publication evidence for an indexed chain with the same chainId.
  const published = task.repoId
    ? await tx.run.findFirst({
      where: {
        pushedBranch: shared,
        repoId: task.repoId,
        task: { projectId: task.projectId, chainId: task.chainId, chainIndex: { not: null } },
      },
      select: { id: true },
    })
    : null;
  // `prior?.branch` is deliberately not consulted here. Post-change it is always
  // `shared`, so it would give the same answer; pre-change (a chain that spans
  // the restart) it is a per-task branch, and honouring it would quietly keep a
  // mixed chain mixed instead of falling through to the operator's targetBranch,
  // which the rollback runbook names as the manual repair lever.
  const targetBranch = published
    ? shared
    : task.targetBranch ?? task.repo.defaultBranch;

  // targetBranch stays writable for chain steps but no longer routes them.
  // Silently ignoring an operator's value is a footgun, so say so once per run —
  // this is how the operator learns hand-repointing is unnecessary.
  if (task.targetBranch && task.targetBranch !== targetBranch) {
    await tx.taskActivity.create({ data: {
      taskId: task.id,
      actorType: "control-plane",
      body: `targetBranch '${task.targetBranch}' is not used for chain steps; this run is based on '${targetBranch}' and pushes to '${shared}'`,
    } });
  }
  return { branch: shared, targetBranch };
};

export const enqueueTaskRun = async (tx: Tx, taskId: string, now = new Date()) => {
  const task = await tx.task.findUniqueOrThrow({
    where: { id: taskId },
    include: {
      assigneeAgent: true,
      repo: true,
      templateStep: true,
      runs: { orderBy: { runNumber: "desc" }, take: 1 },
    },
  });
  if (task.assigneeType !== AssigneeType.AGENT || !task.assigneeAgent || !task.repo) {
    throw new Error(`Task ${task.id} cannot be queued without an agent and repo`);
  }
  // Checked before the assignee, because an archived task is archived whoever
  // it is assigned to. The runner claims only `TODO|DOING` and unarchived tasks,
  // so a run queued here would never be claimed and never complete.
  if (task.archivedAt) {
    throw new ArchivedTaskError(task.id, task.name);
  }
  if (task.assigneeAgent.archivedAt) {
    throw new ArchivedAssigneeError(task.id, task.name, task.assigneeAgent.name);
  }
  const prior = task.runs[0];
  const runNumber = (prior?.runNumber ?? 0) + 1;
  const derived = deriveRunConfig(task.assigneeAgent, task.templateStep, task);
  const branches = await resolveRunBranches(tx, { ...task, repo: task.repo }, prior ?? null);
  return tx.run.create({ data: {
    projectId: task.projectId,
    taskId: task.id,
    agentId: task.assigneeAgent.id,
    repoId: task.repo.id,
    runNumber,
    dedupeKey: `task:${task.id}:run:${runNumber}`,
    runner: derived.runner,
    model: derived.model,
    targetBranch: branches.targetBranch,
    branch: branches.branch,
    opensPullRequest: task.opensPullRequest,
    promptHash: derived.promptHash,
    maxDurationMin: task.maxDurationMin,
    stallTimeoutMin: task.stallTimeoutMin,
    maxRunsPerTask: task.maxSessionsPerTask,
    readyAt: now,
  } });
};

const GATE_OUTPUT_PREVIEW = 1_000;

const outputPreview = async (tx: Tx, taskId: string | null): Promise<string> => {
  if (!taskId) return "";
  const output = await tx.taskStepOutput.findUnique({ where: { taskId }, select: { kind: true, body: true } });
  if (!output) return "";
  const body = output.body.trim();
  const shown = body.length > GATE_OUTPUT_PREVIEW ? `${body.slice(0, GATE_OUTPUT_PREVIEW)}\n…（已截断，完整产物见 Tasks 页）` : body;
  return `\n\n产物（${output.kind}）：\n${shown}`;
};

export const gateQuestion = async (tx: Tx, gateTaskId: string, sourceRunId: string, chatId: string | null) => {
  const [task, run] = await Promise.all([
    tx.task.findUniqueOrThrow({ where: { id: gateTaskId } }),
    tx.run.findUniqueOrThrow({ where: { id: sourceRunId }, include: { session: true } }),
  ]);
  if (!run.session) throw new Error(`Run ${sourceRunId} has no session for approval gate`);
  const thread = chatId ? await tx.inboxThread.upsert({
    where: { channel_externalChatId_sessionId: { channel: "FEISHU", externalChatId: chatId, sessionId: run.session.id } },
    create: { channel: "FEISHU", externalChatId: chatId, sessionId: run.session.id, taskId: task.id },
    update: { taskId: task.id },
  }) : null;
  const delivery = run.pullRequestUrl
    ? `\n\nPull request: ${run.pullRequestUrl}`
    : run.deliveryInstructions ? `\n\n${run.deliveryInstructions}` : "";
  // The approver decides from the card; the produced artifact rides along so
  // they do not have to open the Tasks page for the common case.
  const preview = await outputPreview(tx, run.taskId);
  return tx.inboxMessage.create({ data: {
    from: InboxSender.AGENT,
    agentId: run.agentId,
    sessionId: run.session.id,
    taskId: task.id,
    gateTaskId: task.id,
    threadId: thread?.id ?? null,
    kind: "MULTIPLE_CHOICE",
    body: `审批闸门：${task.name}\n\n请确认本步骤产出。批准后继续；打回后重新执行产出步骤。${delivery}${preview}`,
    choices: [{ id: "approve", label: "批准并继续" }, { id: "reject", label: "打回上一步" }],
    dedupeKey: `gate:task:${task.id}:run:${sourceRunId}`,
    deliveryStatus: InboxDeliveryStatus.PENDING,
  } });
};

type ChainTask = {
  id: string;
  projectId: string;
  name: string;
  chainId: string | null;
  chainIndex: number | null;
  followUpTaskId: string | null;
};

type ChainSuccessor = Prisma.TaskGetPayload<{ include: { runs: true; assigneeAgent: true } }>;

/**
 * "This task already has a run that is alive." WAITING_INBOX belongs here: such
 * a run resumes the moment the operator answers, so a task holding one must not
 * gain a second run, be archived, or be parked in Backlog.
 *
 * This is the definition every guard added by batch 2.5 shares. `app.ts`'s
 * `activeRunStatuses` is a different concept (a run holding a lease) and the
 * retry route's narrower set is pre-existing; neither is this.
 */
export const ACTIVE_RUN_STATUSES: RunStatus[] = [
  RunStatus.QUEUED,
  RunStatus.CLAIMED,
  RunStatus.PROVISIONING,
  RunStatus.RUNNING,
  RunStatus.WAITING_INBOX,
];

const isUniqueConflict = (error: unknown): boolean => (
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
);

/**
 * Why this successor must not be claimed, or null if it may be.
 *
 * The CAS below only matches TODO/DOING/REVIEW. A successor outside that set
 * and not DONE — archived, or parked in BACKLOG — makes `updateMany` match zero
 * rows forever while the re-read keeps returning the same row, so the loop spins
 * inside the caller's transaction and run completion never returns. Returning
 * early is what makes Backlog a place a chain step can sit.
 */
const parkedReason = (successor: { status: TaskStatus; archivedAt?: Date | null }): string | null => {
  if (successor.archivedAt) return "successor is archived and was not queued";
  if (successor.status === TaskStatus.BACKLOG) return "successor is parked in Backlog — use Start now";
  return null;
};

/** Activates at most one chain/follow-up successor using the observed updatedAt as a CAS token. */
export const activateChainSuccessor = async (
  tx: Tx,
  task: ChainTask,
  options: { sourceRunId?: string | null; chatId?: string | null; archivedAssignee?: "park" | "throw" } = {},
  now = new Date(),
): Promise<{ nextTaskId: string | null; gated: boolean }> => {
  let successor: ChainSuccessor | null = null;
  if (task.chainId && task.chainIndex !== null) {
    successor = await tx.task.findFirst({
      where: { projectId: task.projectId, chainId: task.chainId, chainIndex: { gt: task.chainIndex } },
      orderBy: { chainIndex: "asc" },
      include: { runs: { orderBy: { runNumber: "desc" }, take: 1 }, assigneeAgent: true },
    });
  } else {
    if (task.chainId) {
      await tx.taskActivity.create({ data: {
        taskId: task.id,
        actorType: "control-plane",
        body: "Chain row missing chainIndex; auto-advance skipped",
      } });
    }
    if (task.followUpTaskId) {
      successor = await tx.task.findUnique({
        where: { id: task.followUpTaskId },
        include: { runs: { orderBy: { runNumber: "desc" }, take: 1 }, assigneeAgent: true },
      });
    }
  }

  if (!successor) {
    if (task.chainId && task.chainIndex !== null) {
      await tx.taskActivity.create({ data: {
        taskId: task.id,
        actorType: "control-plane",
        body: "Chain complete",
      } });
    }
    return { nextTaskId: null, gated: false };
  }

  if (successor.runs.some((run) => ACTIVE_RUN_STATUSES.includes(run.status))) {
    await tx.taskActivity.create({ data: {
      taskId: successor.id,
      actorType: "control-plane",
      body: "Predecessor completed; successor already active",
    } });
    return { nextTaskId: successor.id, gated: false };
  }

  const parked = parkedReason(successor);
  if (parked) {
    await tx.taskActivity.create({ data: {
      taskId: successor.id,
      actorType: "control-plane",
      body: `Predecessor ${task.name} completed; ${parked}`,
    } });
    return { nextTaskId: successor.id, gated: false };
  }

  // A lost updatedAt CAS can mean either another advancer won or an unrelated
  // operator edit landed between the read and claim. Re-read and retry the
  // latter instead of silently stalling the chain. The status predicate is a
  // second idempotency boundary: a completed successor is never resurrected.
  for (;;) {
    const claimed = await tx.task.updateMany({
      where: {
        id: successor.id,
        updatedAt: successor.updatedAt,
        status: { in: [TaskStatus.TODO, TaskStatus.DOING, TaskStatus.REVIEW] },
      },
      data: { status: TaskStatus.TODO },
    });
    if (claimed.count === 1) break;
    const current: ChainSuccessor | null = await tx.task.findUnique({
      where: { id: successor.id },
      include: { runs: { orderBy: { runNumber: "desc" }, take: 1 }, assigneeAgent: true },
    });
    if (!current || current.status === TaskStatus.DONE) {
      return { nextTaskId: current?.id ?? null, gated: false };
    }
    if (current.runs.some((run) => ACTIVE_RUN_STATUSES.includes(run.status))) {
      await tx.taskActivity.create({ data: {
        taskId: current.id,
        actorType: "control-plane",
        body: "Predecessor completed; successor already active",
      } });
      return { nextTaskId: current.id, gated: false };
    }
    // The same guard as above, because the operator can park the successor
    // *between* the read and the claim. Without this branch the loop re-enters
    // with a parked row, the CAS keeps matching zero rows, and it spins forever
    // inside the caller's transaction.
    const parkedNow = parkedReason(current);
    if (parkedNow) {
      await tx.taskActivity.create({ data: {
        taskId: current.id,
        actorType: "control-plane",
        body: `Predecessor ${task.name} completed; ${parkedNow}`,
      } });
      return { nextTaskId: current.id, gated: false };
    }
    successor = current;
  }

  if (successor.assigneeType !== AssigneeType.AGENT || !successor.assigneeAgentId || !successor.repoId) {
    if (options.sourceRunId) {
      await tx.task.update({ where: { id: successor.id }, data: { status: TaskStatus.REVIEW } });
      await gateQuestion(tx, successor.id, options.sourceRunId, options.chatId ?? null);
      return { nextTaskId: successor.id, gated: true };
    }
    await tx.taskActivity.create({ data: {
      taskId: successor.id,
      actorType: "control-plane",
      body: "Predecessor completed; successor awaits operator",
    } });
    return { nextTaskId: successor.id, gated: false };
  }

  // An archived assignee parks the successor instead of throwing. enqueueTaskRun
  // raises ArchivedAssigneeError, which is not a P2002 and would escape the
  // savepoint catch below and roll back the caller's whole transaction — for
  // completeRun that means discarding a run that actually succeeded.
  //
  // Interactive callers pass archivedAssignee: "throw" instead: a human is
  // waiting on the response, so they get a named 409 rather than a silent park
  // they would have to go hunting for.
  if (successor.assigneeAgent?.archivedAt) {
    if (options.archivedAssignee === "throw") {
      throw new ArchivedAssigneeError(successor.id, successor.name, successor.assigneeAgent.name);
    }
    await tx.task.update({
      where: { id: successor.id },
      data: {
        status: TaskStatus.REVIEW,
        failureReason: `Assignee ${successor.assigneeAgent.name} is archived; unarchive the agent and retry to queue this step`,
      },
    });
    await tx.taskActivity.create({
      data: {
        taskId: successor.id,
        actorType: "control-plane",
        body: `Predecessor ${task.name} completed but assignee ${successor.assigneeAgent.name} is archived; step not queued`,
      },
    });
    return { nextTaskId: successor.id, gated: false };
  }

  const rawTx = tx as Tx & { $executeRawUnsafe?: (query: string) => Promise<number> };
  const hasSavepoint = typeof rawTx.$executeRawUnsafe === "function";
  if (hasSavepoint) await rawTx.$executeRawUnsafe!("SAVEPOINT chain_successor_enqueue");
  try {
    await enqueueTaskRun(tx, successor.id, now);
    if (hasSavepoint) await rawTx.$executeRawUnsafe!("RELEASE SAVEPOINT chain_successor_enqueue");
  } catch (error: unknown) {
    if (!isUniqueConflict(error)) throw error;
    if (hasSavepoint) {
      await rawTx.$executeRawUnsafe!("ROLLBACK TO SAVEPOINT chain_successor_enqueue");
      await rawTx.$executeRawUnsafe!("RELEASE SAVEPOINT chain_successor_enqueue");
    }
    return { nextTaskId: successor.id, gated: false };
  }
  await tx.taskActivity.create({ data: {
    taskId: successor.id,
    actorType: "control-plane",
    body: `Predecessor ${task.name} completed; step queued`,
  } });
  return { nextTaskId: successor.id, gated: false };
};

/** Marks a completed template task done and activates exactly one successor or gate. */
export const advanceTemplateTask = async (
  tx: Tx,
  taskId: string,
  sourceRunId: string,
  chatId: string | null,
  now = new Date(),
  expectedStatus?: TaskStatus,
): Promise<{ gated: boolean; nextTaskId: string | null }> => {
  const task = await tx.task.findUniqueOrThrow({
    where: { id: taskId },
  });
  if (!task.templateId) return { gated: false, nextTaskId: null };
  if (task.approvalGate) {
    if (expectedStatus) {
      const claimed = await tx.task.updateMany({ where: { id: task.id, status: expectedStatus }, data: { status: TaskStatus.REVIEW } });
      if (claimed.count !== 1) return { gated: false, nextTaskId: null };
    } else {
      await tx.task.update({ where: { id: task.id }, data: { status: TaskStatus.REVIEW } });
    }
    await gateQuestion(tx, task.id, sourceRunId, chatId);
    return { gated: true, nextTaskId: task.followUpTaskId };
  }
  if (expectedStatus) {
    const claimed = await tx.task.updateMany({ where: { id: task.id, status: expectedStatus }, data: { status: TaskStatus.DONE, failureReason: null } });
    if (claimed.count !== 1) return { gated: false, nextTaskId: null };
  } else {
    await tx.task.update({ where: { id: task.id }, data: { status: TaskStatus.DONE, failureReason: null } });
  }
  return activateChainSuccessor(tx, task, { sourceRunId, chatId }, now);
};

export type InboxDecisionInput = {
  inboxMessageId: string;
  externalEventId: string;
  decision: string;
  actorOpenId?: string | null;
  externalMessageId?: string | null;
  allowFreeText?: boolean;
};

export type InboxDecisionResult = {
  duplicate: boolean;
  resumed: boolean;
  gateAction?: "approved" | "rejected";
  messageId?: string;
};

/** Shared transaction body for Feishu and Web decisions. OPEN is the cross-channel compare-and-set. */
export const applyInboxDecisionTx = async (
  tx: Tx,
  input: InboxDecisionInput,
  now = new Date(),
): Promise<InboxDecisionResult> => {
  const question = await tx.inboxMessage.findUnique({
    where: { id: input.inboxMessageId },
    include: {
      session: { include: { run: true } },
      gateTask: { include: { previousTask: true } },
      thread: true,
    },
  });
  if (!question?.session?.run) throw new Error("No matching Inbox question");
  const gateDecision = Boolean(question.gateTaskId);
  if (gateDecision && input.decision !== "approve" && input.decision !== "reject") {
    throw new Error("Approval gate decision must be approve or reject");
  }
  if (!gateDecision && question.kind === InboxKind.MULTIPLE_CHOICE && !input.allowFreeText) {
    const choices = Array.isArray(question.choices) ? question.choices : [];
    const matchesChoice = choices.some((choice) => (
      typeof choice === "object" && choice !== null && "id" in choice && choice.id === input.decision
    ));
    if (!matchesChoice) throw new Error("Decision must match an Inbox choice id");
  }
  if (!gateDecision && question.session.run.status !== RunStatus.WAITING_INBOX) {
    throw new Error("No matching waiting Inbox question");
  }
  const claimed = await tx.inboxMessage.updateMany({
    where: { id: question.id, status: InboxStatus.OPEN },
    data: { status: InboxStatus.ANSWERED, selectedChoiceId: input.decision, answeredAt: now },
  });
  if (claimed.count !== 1) return { duplicate: true, resumed: false };
  const reply = await tx.inboxMessage.create({ data: {
    from: InboxSender.HUMAN,
    agentId: question.agentId,
    sessionId: question.sessionId,
    taskId: question.taskId,
    goalId: question.goalId,
    threadId: question.threadId,
    replyToMessageId: question.id,
    kind: "TEXT",
    body: input.decision,
    selectedChoiceId: input.decision,
    status: InboxStatus.CLOSED,
    dedupeKey: `decision:${input.externalEventId}:reply`,
    externalMessageId: input.externalMessageId ?? null,
    deliveryStatus: InboxDeliveryStatus.DELIVERED,
    deliveredAt: now,
  } });
  await tx.inboxDecision.create({ data: {
    inboxMessageId: question.id,
    runId: question.session.run.id,
    externalEventId: input.externalEventId,
    decision: input.decision,
    actorOpenId: input.actorOpenId ?? null,
  } });

  if (gateDecision && question.gateTask) {
    if (input.decision === "approve") {
      await tx.task.update({ where: { id: question.gateTask.id }, data: { status: TaskStatus.DONE, failureReason: null } });
      await tx.taskActivity.create({ data: { taskId: question.gateTask.id, actorType: "operator", body: "Approval gate approved" } });
      await activateChainSuccessor(tx, question.gateTask, {
        sourceRunId: question.session.run.id,
        chatId: question.thread?.externalChatId ?? null,
        archivedAssignee: "throw",
      }, now);
      return { duplicate: false, resumed: false, gateAction: "approved", messageId: reply.id };
    }
    let redo = question.gateTask.assigneeType === AssigneeType.AGENT
      ? question.gateTask
      : question.gateTask.previousTask;
    if (!redo && question.gateTask.chainId && question.gateTask.chainIndex !== null) {
      redo = await tx.task.findFirst({
        where: {
          projectId: question.gateTask.projectId,
          chainId: question.gateTask.chainId,
          chainIndex: { lt: question.gateTask.chainIndex },
          assigneeType: AssigneeType.AGENT,
          assigneeAgentId: { not: null },
          repoId: { not: null },
        },
        orderBy: { chainIndex: "desc" },
      });
    }
    if (!redo) throw new Error("Approval gate has no executable previous task to reject to");
    // Rejection is the one gate path that queues work on a task the operator
    // never named, so it joins the Task-row mutex here rather than trusting the
    // row loaded with the Inbox message. Refusing by throwing rolls the whole
    // transaction back, which leaves the decision OPEN — the human unarchives
    // the step and decides again, instead of the gate silently closing onto a
    // run the runner will never claim.
    const lockedRedo = await lockTaskRow(tx, redo.id);
    if (lockedRedo?.archivedAt) {
      throw new ArchivedTaskError(redo.id, redo.name);
    }
    await tx.task.update({ where: { id: redo.id }, data: { status: TaskStatus.TODO, failureReason: null } });
    if (redo.id !== question.gateTask.id) {
      await tx.task.update({ where: { id: question.gateTask.id }, data: { status: TaskStatus.TODO } });
    }
    await tx.taskActivity.create({ data: { taskId: redo.id, actorType: "operator", body: "Approval gate rejected; step queued again" } });
    await enqueueTaskRun(tx, redo.id, now);
    return { duplicate: false, resumed: false, gateAction: "rejected", messageId: reply.id };
  }

  const queued = await tx.run.updateMany({
    where: { id: question.session.run.id, status: RunStatus.WAITING_INBOX },
    data: { status: RunStatus.QUEUED, readyAt: now, runnerId: null, fencingToken: null, leaseExpiresAt: null },
  });
  if (queued.count !== 1) throw new Error("Waiting Run changed while applying Inbox decision");
  await tx.session.update({ where: { id: question.session.id }, data: {
    executionStatus: SessionExecutionStatus.REQUESTED,
    waitingOnMessageId: null,
    resumeInput: input.decision,
    resumeAttempt: { increment: 1 },
  } });
  return { duplicate: false, resumed: true, messageId: reply.id };
};

export const applyInboxDecision = async (
  db: PrismaClient,
  input: InboxDecisionInput,
  now = new Date(),
): Promise<InboxDecisionResult> => db.$transaction(
  (tx) => applyInboxDecisionTx(tx, input, now),
  // PostgreSQL re-checks the OPEN predicate after a concurrent row lock is
  // released, so the loser observes count=0 instead of a serialization error.
  { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
);
