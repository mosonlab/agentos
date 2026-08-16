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

type Tx = Prisma.TransactionClient;

const promptHash = (parts: string[]): string => createHash("sha256").update(parts.join("\n")).digest("hex");

const chooseRunner = (preference: RunnerPreference, model: string): RunnerKind => {
  if (preference === RunnerPreference.CLAUDE) return RunnerKind.CLAUDE;
  if (preference === RunnerPreference.CODEX) return RunnerKind.CODEX;
  if (preference === RunnerPreference.PI) return RunnerKind.PI;
  const normalized = model.toLowerCase();
  if (normalized.includes("codex")) return RunnerKind.CODEX;
  if (normalized.includes("deepseek") || normalized.includes("pi")) return RunnerKind.PI;
  return RunnerKind.CLAUDE;
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
  const prior = task.runs[0];
  const runNumber = (prior?.runNumber ?? 0) + 1;
  const runner = task.templateStep?.runner ?? chooseRunner(task.assigneeAgent.runnerPreference, task.assigneeAgent.model);
  // Template steps after the first one inherit the chain's shared feature branch
  // so every step pushes to the same head and the chain lands in one PR; without
  // this the workspace falls back to a per-run branch and each step opens its own.
  const chainBranch = task.templateId && task.targetBranch && task.targetBranch !== task.repo.defaultBranch
    ? task.targetBranch
    : null;
  return tx.run.create({ data: {
    projectId: task.projectId,
    taskId: task.id,
    agentId: task.assigneeAgent.id,
    repoId: task.repo.id,
    runNumber,
    dedupeKey: `task:${task.id}:run:${runNumber}`,
    runner,
    model: task.assigneeAgent.model,
    targetBranch: prior?.branch ?? task.targetBranch ?? task.repo.defaultBranch,
    branch: prior?.branch ?? chainBranch,
    promptHash: promptHash([
      task.assigneeAgent.foundationalPrompt,
      task.assigneeAgent.rolePrompt,
      task.name,
      task.description,
    ]),
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

const activeSuccessorStatuses: RunStatus[] = [
  RunStatus.QUEUED,
  RunStatus.CLAIMED,
  RunStatus.PROVISIONING,
  RunStatus.RUNNING,
  RunStatus.WAITING_INBOX,
];

const isUniqueConflict = (error: unknown): boolean => (
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
);

/** Activates at most one chain/follow-up successor using the observed updatedAt as a CAS token. */
export const activateChainSuccessor = async (
  tx: Tx,
  task: ChainTask,
  options: { sourceRunId?: string | null; chatId?: string | null } = {},
  now = new Date(),
): Promise<{ nextTaskId: string | null; gated: boolean }> => {
  let successor = null;
  if (task.chainId && task.chainIndex !== null) {
    successor = await tx.task.findFirst({
      where: { projectId: task.projectId, chainId: task.chainId, chainIndex: { gt: task.chainIndex } },
      orderBy: { chainIndex: "asc" },
      include: { runs: { orderBy: { runNumber: "desc" }, take: 1 } },
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
        include: { runs: { orderBy: { runNumber: "desc" }, take: 1 } },
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

  if (successor.runs.some((run) => activeSuccessorStatuses.includes(run.status))) {
    await tx.taskActivity.create({ data: {
      taskId: successor.id,
      actorType: "control-plane",
      body: "Predecessor completed; successor already active",
    } });
    return { nextTaskId: successor.id, gated: false };
  }

  const claimed = await tx.task.updateMany({
    where: { id: successor.id, updatedAt: successor.updatedAt },
    data: { status: TaskStatus.TODO },
  });
  if (claimed.count === 0) return { nextTaskId: successor.id, gated: false };

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
): Promise<{ gated: boolean; nextTaskId: string | null }> => {
  const task = await tx.task.findUniqueOrThrow({
    where: { id: taskId },
  });
  if (!task.templateId) return { gated: false, nextTaskId: null };
  if (task.approvalGate) {
    await tx.task.update({ where: { id: task.id }, data: { status: TaskStatus.REVIEW } });
    await gateQuestion(tx, task.id, sourceRunId, chatId);
    return { gated: true, nextTaskId: task.followUpTaskId };
  }
  await tx.task.update({ where: { id: task.id }, data: { status: TaskStatus.DONE, failureReason: null } });
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
      }, now);
      return { duplicate: false, resumed: false, gateAction: "approved", messageId: reply.id };
    }
    const redo = question.gateTask.assigneeType === AssigneeType.AGENT
      ? question.gateTask
      : question.gateTask.previousTask;
    if (!redo) throw new Error("Approval gate has no executable previous task to reject to");
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
