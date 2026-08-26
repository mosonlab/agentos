/**
 * Merge Integrator v1.1 — the database-touching half of the shared module.
 *
 * Separate from `merge-integrator.ts` so that file stays pure and importable
 * from anywhere. Everything here takes a transaction client and performs *no*
 * network I/O: §D-P3's whole point is that reads of GitHub happen outside every
 * transaction, so a function in this file that called out would defeat it.
 */

import { randomUUID } from "node:crypto";

import {
  InboxDeliveryStatus,
  InboxSender,
  InboxStatus,
  Prisma,
  RunnerKind,
  TaskStatus,
} from "@prisma/client";

import {
  EVIDENCE_PLACEHOLDER_BODY,
  INTEGRATOR_OUTPUT_KIND,
  INTEGRATOR_STEP_INDEX,
  MERGE_INTEGRATOR_KIND,
  MERGE_INTEGRATOR_SCHEMA_VERSION,
  FOLLOW_UP_CHOICES,
  STOP_CHOICES,
  type Disposition,
  type IntegratorStepShape,
  type StopCondition,
  dispositionFor,
  followUpDispositionFor,
  githubRepositoryFromRemote,
  integratorBindingRefusal,
  stopChoicePayload,
  isCanonicalIntegratorStep,
  isIntegratorStep,
  isStopCondition,
  isTerminalDisposition,
  parseStopAnswerMetadata,
} from "./merge-integrator.js";

type Tx = Prisma.TransactionClient;

/** How long a Phase-A card is withheld from the outbox while Phase B fills it. */
export const evidenceDeadlineMs = (): number => {
  const raw = Number(process.env.EVIDENCE_DEADLINE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
};

const asRecord = (value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

// ---------------------------------------------------------------------------
// Locating the integrator step of a chain
// ---------------------------------------------------------------------------

const INTEGRATOR_INCLUDE = { templateStep: { include: { taskTemplate: { select: { name: true } } } } } as const;

export type IntegratorTask = Prisma.TaskGetPayload<{ include: typeof INTEGRATOR_INCLUDE }>;

/** True when this task row owns the Chain's integrator role. */
export const taskIsIntegratorStep = (task: IntegratorTask | null | undefined): boolean =>
  isIntegratorStep(task?.templateStep ?? null);

export const loadIntegratorTask = async (tx: Tx, taskId: string): Promise<IntegratorTask | null> =>
  tx.task.findUnique({ where: { id: taskId }, include: INTEGRATOR_INCLUDE });

/** The Chain's integrator task, or null when the Chain has no mechanical continuation. */
export const findChainIntegratorTask = async (
  tx: Tx,
  projectId: string,
  chainId: string | null,
): Promise<IntegratorTask | null> => {
  if (!chainId) return null;
  const candidates = await tx.task.findMany({
    where: { projectId, chainId },
    include: INTEGRATOR_INCLUDE,
    orderBy: { chainIndex: "asc" },
  });
  return candidates.find((task) => taskIsIntegratorStep(task)) ?? null;
};

/**
 * Does the successor of this gate task run mechanically? This is what turns the
 * two-phase evidence protocol on: an ordinary gate without that successor is
 * byte-for-byte unchanged.
 */
export const gateFeedsIntegratorStep = async (
  tx: Tx,
  gateTask: { projectId: string; chainId: string | null; chainIndex: number | null },
): Promise<IntegratorTask | null> => {
  if (!gateTask.chainId || gateTask.chainIndex === null) return null;
  const successor = await tx.task.findFirst({
    where: { projectId: gateTask.projectId, chainId: gateTask.chainId, chainIndex: { gt: gateTask.chainIndex } },
    include: INTEGRATOR_INCLUDE,
    orderBy: { chainIndex: "asc" },
  });
  return taskIsIntegratorStep(successor) ? successor : null;
};

// ---------------------------------------------------------------------------
// §D-P8 rule 3 — the chain target identity
// ---------------------------------------------------------------------------

export type ChainTarget =
  | { resolved: true; repository: string; prNumber: number; observed: number[]; correctionActivityId: string | null }
  | { resolved: false; unresolvable: "none" | "ambiguous" | "repository"; observed: number[] };

export type TargetCorrection = { activityId: string; prNumber: number; createdAt: Date };

/**
 * Every distinct non-null `Run.pullRequestNumber` this chain's own runs
 * recorded. Immutable history, so a client cannot move it — which is exactly
 * why MF-8 needed a separate, authenticated correction record rather than a
 * re-authorization.
 */
export const observedChainPullRequests = async (
  tx: Tx,
  projectId: string,
  chainId: string,
): Promise<number[]> => {
  const rows = await tx.run.findMany({
    where: { task: { projectId, chainId }, pullRequestNumber: { not: null } },
    select: { pullRequestNumber: true },
    distinct: ["pullRequestNumber"],
  });
  return [...new Set(rows.map((row) => row.pullRequestNumber!))].sort((left, right) => left - right);
};

export const latestTargetCorrection = async (
  tx: Tx,
  integratorTaskId: string,
): Promise<TargetCorrection | null> => {
  const rows = await tx.taskActivity.findMany({
    where: { taskId: integratorTaskId },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true, metadata: true },
  });
  for (const row of rows) {
    const metadata = asRecord(row.metadata);
    if (metadata?.kind !== MERGE_INTEGRATOR_KIND.targetCorrection) continue;
    if (typeof metadata.prNumber !== "number") continue;
    return { activityId: row.id, prNumber: metadata.prNumber, createdAt: row.createdAt };
  }
  return null;
};

/**
 * Resolution rule (§D-P8 rule 3): exactly one observed value wins outright;
 * otherwise a correction may select among the observed set; anything else is
 * unresolvable. A correction whose PR has since left the observed set is
 * ignored rather than honoured, so a correction can never introduce a foreign
 * pull request.
 */
export const resolveChainTarget = async (
  tx: Tx,
  task: { projectId: string; chainId: string | null; repoId: string | null },
): Promise<ChainTarget> => {
  if (!task.chainId) return { resolved: false, unresolvable: "none", observed: [] };
  const observed = await observedChainPullRequests(tx, task.projectId, task.chainId);
  const repo = task.repoId ? await tx.repo.findUnique({ where: { id: task.repoId }, select: { remoteUrl: true } }) : null;
  const repository = repo ? githubRepositoryFromRemote(repo.remoteUrl) : null;
  if (!repository) return { resolved: false, unresolvable: "repository", observed };
  if (observed.length === 1) {
    return { resolved: true, repository, prNumber: observed[0]!, observed, correctionActivityId: null };
  }
  const integrator = await findChainIntegratorTask(tx, task.projectId, task.chainId);
  const correction = integrator ? await latestTargetCorrection(tx, integrator.id) : null;
  if (correction && observed.includes(correction.prNumber)) {
    return {
      resolved: true,
      repository,
      prNumber: correction.prNumber,
      observed,
      correctionActivityId: correction.activityId,
    };
  }
  return { resolved: false, unresolvable: observed.length === 0 ? "none" : "ambiguous", observed };
};

// ---------------------------------------------------------------------------
// §D-P7 — the stop state, keyed on terminal dispositions
// ---------------------------------------------------------------------------

export type RecordedStop = {
  stopId: string;
  condition: StopCondition;
  evidence: string;
  sourceRunId: string | null;
  createdAt: Date;
};

/**
 * The latest entry of the append-only `mergeIntegrator.result` history, but
 * only when it is a stop. Reading the history rather than the replaceable
 * `TaskStepOutput` is what stops a re-authorized run from erasing the stop the
 * guard is keyed on (Y1).
 */
export const latestRecordedStop = async (tx: Tx, integratorTaskId: string): Promise<RecordedStop | null> => {
  const rows = await tx.taskActivity.findMany({
    where: { taskId: integratorTaskId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, createdAt: true, metadata: true },
  });
  for (const row of rows) {
    const metadata = asRecord(row.metadata);
    if (metadata?.kind !== MERGE_INTEGRATOR_KIND.result) continue;
    // The newest result decides. A later `merged` closes the chain even though
    // an older stop is still in the history.
    if (metadata.outcome !== "stopped") return null;
    if (!isStopCondition(metadata.condition)) return null;
    return {
      stopId: row.id,
      condition: metadata.condition,
      evidence: typeof metadata.evidence === "string" ? metadata.evidence : "",
      sourceRunId: typeof metadata.sourceRunId === "string" ? metadata.sourceRunId : null,
      createdAt: row.createdAt,
    };
  }
  return null;
};

export const stopAnswerDispositions = async (
  tx: Tx,
  integratorTaskId: string,
  stopId: string,
): Promise<Disposition[]> => {
  const rows = await tx.taskActivity.findMany({
    where: { taskId: integratorTaskId },
    orderBy: { createdAt: "asc" },
    select: { metadata: true },
  });
  const found: Disposition[] = [];
  for (const row of rows) {
    const answer = parseStopAnswerMetadata(row.metadata);
    if (answer && answer.stopId === stopId) found.push(answer.disposition);
  }
  return found;
};

export type StopState = { stop: RecordedStop; dispositions: Disposition[] } | null;

/**
 * The one predicate every generic route composes (Step 5). It is a function of
 * the task row and its template step rather than of a route name, so a route
 * added later inherits the guard instead of quietly bypassing it.
 */
export const stopStateFor = async (tx: Tx, taskId: string): Promise<StopState> => {
  const task = await loadIntegratorTask(tx, taskId);
  if (!taskIsIntegratorStep(task)) return null;
  const stop = await latestRecordedStop(tx, taskId);
  if (!stop) return null;
  const dispositions = await stopAnswerDispositions(tx, taskId, stop.stopId);
  if (dispositions.some((disposition) => isTerminalDisposition(disposition))) return null;
  return { stop, dispositions };
};

export const inStopState = async (tx: Tx, taskId: string): Promise<boolean> =>
  (await stopStateFor(tx, taskId)) !== null;

export const stopStateRefusal = (state: NonNullable<StopState>): string =>
  `Merge integrator stopped on ${state.stop.condition}; answer the stop question before changing this task`;

// ---------------------------------------------------------------------------
// §D-P3 Phase A — request evidence and open a placeholder card
// ---------------------------------------------------------------------------

export type EvidencePurpose = "gate" | "confirmation";

export type EvidenceRequestResult = { cardId: string; nonce: string; activityId: string };

/**
 * Phase A. A pure database write in whichever process happens to be running:
 * `gateQuestion` runs inside `applyInboxDecisionTx` in the @agentos/inbox
 * process, which can reach neither the API's GitHub client nor its
 * configuration — MF-3's topology finding, which applies to the initial gate
 * exactly as it does to a renewal.
 *
 * The card is born OPEN with a placeholder body and a `nextDeliveryAt` in the
 * future, so the inbox outbox (`delivery.ts`, which selects `nextDeliveryAt <=
 * now`) cannot ship a card that says nothing yet.
 */
export const requestMergeEvidence = async (
  tx: Tx,
  input: {
    gateTaskId: string;
    integratorTaskId: string;
    sourceRunId: string;
    agentId: string;
    sessionId: string;
    threadId?: string | null;
    purpose: EvidencePurpose;
    repository: string;
    prNumber: number;
    dedupeKey: string;
  },
  now = new Date(),
): Promise<EvidenceRequestResult> => {
  const nonce = randomUUID();
  const card = await tx.inboxMessage.create({ data: {
    from: InboxSender.AGENT,
    agentId: input.agentId,
    sessionId: input.sessionId,
    taskId: input.gateTaskId,
    gateTaskId: input.gateTaskId,
    threadId: input.threadId ?? null,
    kind: "MULTIPLE_CHOICE",
    body: EVIDENCE_PLACEHOLDER_BODY,
    choices: [{ id: "approve", label: "批准并合并" }, { id: "reject", label: "打回上一步" }],
    dedupeKey: input.dedupeKey,
    deliveryStatus: InboxDeliveryStatus.PENDING,
    nextDeliveryAt: new Date(now.getTime() + evidenceDeadlineMs()),
  } });
  const activity = await tx.taskActivity.create({ data: {
    taskId: input.gateTaskId,
    // Not client-producible: POST /tasks/:taskId/activity forces "operator" and
    // the fenced session write stamps the principal kind. Only server-internal
    // code writes control-plane rows.
    actorType: "control-plane",
    body: `Merge evidence requested for PR #${input.prNumber} (${input.purpose})`,
    metadata: {
      kind: MERGE_INTEGRATOR_KIND.evidenceRequest,
      schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
      nonce,
      gateTaskId: input.gateTaskId,
      integratorTaskId: input.integratorTaskId,
      repository: input.repository,
      prNumber: input.prNumber,
      cardId: card.id,
      purpose: input.purpose,
      requestedAt: now.toISOString(),
      sourceRunId: input.sourceRunId,
    },
  } });
  return { cardId: card.id, nonce, activityId: activity.id };
};

export type PendingEvidenceRequest = {
  activityId: string;
  gateTaskId: string;
  integratorTaskId: string;
  cardId: string;
  nonce: string;
  repository: string;
  prNumber: number;
  purpose: EvidencePurpose;
};

export const parseEvidenceRequest = (
  row: { id: string; taskId: string; metadata: Prisma.JsonValue | null },
): PendingEvidenceRequest | null => {
  const metadata = asRecord(row.metadata);
  if (metadata?.kind !== MERGE_INTEGRATOR_KIND.evidenceRequest) return null;
  if (metadata.schemaVersion !== MERGE_INTEGRATOR_SCHEMA_VERSION) return null;
  const { nonce, cardId, repository, prNumber, purpose, integratorTaskId } = metadata;
  if (typeof nonce !== "string" || typeof cardId !== "string" || typeof repository !== "string") return null;
  if (typeof prNumber !== "number" || typeof integratorTaskId !== "string") return null;
  if (purpose !== "gate" && purpose !== "confirmation") return null;
  return {
    activityId: row.id,
    gateTaskId: row.taskId,
    integratorTaskId,
    cardId,
    nonce,
    repository,
    prNumber,
    purpose,
  };
};

/** The evidence request whose nonce a filled card carries. Resolves a card's purpose durably. */
export const findEvidenceRequestByNonce = async (
  tx: Tx,
  gateTaskId: string,
  nonce: string,
): Promise<PendingEvidenceRequest | null> => {
  const rows = await tx.taskActivity.findMany({
    where: { taskId: gateTaskId },
    orderBy: { createdAt: "desc" },
    select: { id: true, taskId: true, metadata: true },
  });
  for (const row of rows) {
    const request = parseEvidenceRequest(row);
    if (request?.nonce === nonce) return request;
  }
  return null;
};

// ---------------------------------------------------------------------------
// §D-P5 — the budget-exempt run an answer creates
// ---------------------------------------------------------------------------

/**
 * The only writer of a `maxRunsPerTask` above the task's original ceiling.
 * `runner.ts` refuses at claim when `runNumber > maxRunsPerTask`, so a renewed
 * authorization has to raise the ceiling on the row it creates — and completion
 * is separately prevented (Step 4) from raising it on any other path, which is
 * what makes "only a human answer may exceed the ceiling" true rather than
 * merely claimed.
 */
export const createAuthorizedIntegratorRun = async (
  tx: Tx,
  integratorTaskId: string,
  now = new Date(),
): Promise<{ id: string; runNumber: number } | null> => {
  const task = await tx.task.findUniqueOrThrow({
    where: { id: integratorTaskId },
    include: {
      assigneeAgent: true,
      repo: true,
      templateStep: { include: { taskTemplate: { select: { name: true } } } },
      runs: { orderBy: { runNumber: "desc" }, take: 1 },
    },
  });
  if (!isIntegratorStep(task.templateStep)) throw new Error("Not an integrator step");
  if (!task.assigneeAgent || !task.repo) throw new Error("Integrator step has no assignee or repo");
  const prior = task.runs[0];
  const runNumber = (prior?.runNumber ?? 0) + 1;
  const ceiling = Math.max(prior?.maxRunsPerTask ?? task.maxSessionsPerTask, runNumber);
  // The same authorization expressed as a grant rather than an absolute
  // ceiling, so the operator-facing budget gates can tell it apart from the
  // task's configured budget — including after that budget is edited. This is a
  // human re-authorization, so it must survive exactly as a refund does.
  const budgetGrants = Math.max(prior?.budgetGrants ?? 0, ceiling - task.maxSessionsPerTask);
  const run = await tx.run.create({ data: {
    projectId: task.projectId,
    taskId: task.id,
    agentId: task.assigneeAgent.id,
    repoId: task.repo.id,
    runNumber,
    dedupeKey: `task:${task.id}:run:${runNumber}`,
    // Inert. The sentinel Agent's runner is never used to spawn anything: the
    // merge executor claims by runnerId allowlist and the ordinary runner
    // refuses a mechanical claim outright (§D-P1 rules 3-4). The column is
    // non-nullable, so it carries the prior row's value or a fixed default.
    runner: prior?.runner ?? RunnerKind.CLAUDE,
    model: task.assigneeAgent.model,
    targetBranch: prior?.targetBranch ?? task.targetBranch,
    branch: prior?.branch ?? null,
    // Step 10 publishes nothing. The row-level flag is the second half of the
    // §6.1 non-publication guarantee; the first is that the executor process
    // contains no delivery code at all.
    opensPullRequest: false,
    promptHash: prior?.promptHash ?? "mechanical",
    maxDurationMin: task.maxDurationMin,
    stallTimeoutMin: task.stallTimeoutMin,
    maxRunsPerTask: ceiling,
    budgetGrants,
    readyAt: now,
  } });
  await tx.task.updateMany({
    where: { id: task.id, status: { in: [TaskStatus.REVIEW, TaskStatus.TODO, TaskStatus.DOING] } },
    data: { status: TaskStatus.TODO, failureReason: null },
  });
  return { id: run.id, runNumber: run.runNumber };
};

/** Marks every still-OPEN question on the integrator task closed. Used when a disposition is terminal. */
export const closeIntegratorQuestions = async (tx: Tx, integratorTaskId: string): Promise<void> => {
  await tx.inboxMessage.updateMany({
    where: { taskId: integratorTaskId, status: InboxStatus.OPEN },
    data: { status: InboxStatus.CLOSED },
  });
};

export const INTEGRATOR_OUTPUT = INTEGRATOR_OUTPUT_KIND;

// ---------------------------------------------------------------------------
// §D-P7 — stop questions, follow-ups, and the answer transaction
// ---------------------------------------------------------------------------

/**
 * A stop question is identified by the `mergeIntegrator.result` activity that
 * recorded the stop. `InboxMessage` has no metadata column, so the binding
 * rides in `dedupeKey` — a server-written column with a unique constraint,
 * which additionally makes opening the same stop's question twice impossible
 * rather than merely unlikely.
 */
export const STOP_QUESTION_PREFIX = "merge-stop";
export const FOLLOW_UP_QUESTION_PREFIX = "merge-stop-followup";

export const stopQuestionKey = (stopId: string): string => `${STOP_QUESTION_PREFIX}:${stopId}`;
export const followUpQuestionKey = (stopId: string): string => `${FOLLOW_UP_QUESTION_PREFIX}:${stopId}`;

export type StopQuestionBinding = { stopId: string; followUp: boolean };

export const parseStopQuestionKey = (dedupeKey: string | null | undefined): StopQuestionBinding | null => {
  if (!dedupeKey) return null;
  if (dedupeKey.startsWith(`${FOLLOW_UP_QUESTION_PREFIX}:`)) {
    return { stopId: dedupeKey.slice(FOLLOW_UP_QUESTION_PREFIX.length + 1), followUp: true };
  }
  if (dedupeKey.startsWith(`${STOP_QUESTION_PREFIX}:`)) {
    return { stopId: dedupeKey.slice(STOP_QUESTION_PREFIX.length + 1), followUp: false };
  }
  return null;
};

const stopQuestionBody = (condition: StopCondition, evidence: string, followUp: boolean): string => [
  followUp ? `合并事故待结案：${condition}` : `机械合并已停止：${condition}`,
  "",
  evidence.trim() || "（执行器未记录额外证据）",
  "",
  followUp
    ? "这一步仍未结案。接受他人已完成的合并，或放弃本链。"
    : "在你回答之前，这个任务不会重试、不会推进，也不会被改状态。",
].join("\n");

/**
 * Opens the question a recorded stop lands in. Returns null when one already
 * exists for this stop, which is what makes a replayed completion idempotent.
 */
export const openStopQuestion = async (
  tx: Tx,
  input: {
    integratorTaskId: string;
    stopId: string;
    condition: StopCondition;
    evidence: string;
    agentId: string;
    sessionId: string | null;
    followUp?: boolean;
  },
): Promise<{ id: string } | null> => {
  const followUp = input.followUp ?? false;
  const dedupeKey = followUp ? followUpQuestionKey(input.stopId) : stopQuestionKey(input.stopId);
  const existing = await tx.inboxMessage.findFirst({ where: { dedupeKey } });
  if (existing) return null;
  const choices = followUp ? FOLLOW_UP_CHOICES : STOP_CHOICES[input.condition];
  const card = await tx.inboxMessage.create({ data: {
    from: InboxSender.AGENT,
    agentId: input.agentId,
    sessionId: input.sessionId,
    taskId: input.integratorTaskId,
    kind: "MULTIPLE_CHOICE",
    body: stopQuestionBody(input.condition, input.evidence, followUp),
    choices: stopChoicePayload(choices),
    dedupeKey,
  } });
  return { id: card.id };
};

export type StopAnswerOutcome = {
  disposition: Disposition;
  condition: StopCondition;
  stopId: string;
  integratorTaskId: string;
  followUpQuestionId?: string | null;
  confirmationCardId?: string | null;
};

/**
 * §D-P7's answer transaction. Every exit from a stop runs through here, and the
 * guard downstream keys on the *disposition* this writes rather than on the
 * answer merely existing — which is the whole of C3: `flag-incident` records an
 * answer and still leaves the chain guarded.
 */
export const applyStopAnswer = async (
  tx: Tx,
  input: {
    question: { id: string; taskId: string | null; dedupeKey: string | null; agentId: string | null; sessionId: string | null };
    choice: string;
    now?: Date;
  },
): Promise<StopAnswerOutcome | null> => {
  const binding = parseStopQuestionKey(input.question.dedupeKey);
  if (!binding || !input.question.taskId) return null;
  const now = input.now ?? new Date();
  const task = await loadIntegratorTask(tx, input.question.taskId);
  if (!task || !taskIsIntegratorStep(task)) return null;
  const stop = await tx.taskActivity.findUnique({ where: { id: binding.stopId }, select: { metadata: true } });
  const stopMetadata = asRecord(stop?.metadata);
  const condition = stopMetadata?.condition;
  if (!isStopCondition(condition)) return null;
  const disposition = binding.followUp
    ? followUpDispositionFor(input.choice)
    : dispositionFor(condition, input.choice);
  if (!disposition) throw new Error(`Choice ${input.choice} is not offered for stop condition ${condition}`);

  await tx.taskActivity.create({ data: {
    taskId: task.id,
    actorType: "operator",
    body: `Merge stop ${condition} answered: ${input.choice}`,
    metadata: {
      kind: MERGE_INTEGRATOR_KIND.stopAnswer,
      schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
      stopId: binding.stopId,
      condition,
      choice: input.choice,
      disposition,
      followUp: binding.followUp,
      answeredAt: now.toISOString(),
    },
  } });

  const outcome: StopAnswerOutcome = {
    disposition, condition, stopId: binding.stopId, integratorTaskId: task.id,
    followUpQuestionId: null, confirmationCardId: null,
  };

  if (disposition === "nonterminal") {
    // C3's resolution: the incident stays open, and the later exits the SPEC
    // promised are actually offered rather than merely described.
    const followUp = await openStopQuestion(tx, {
      integratorTaskId: task.id,
      stopId: binding.stopId,
      condition,
      evidence: `已标记为事故（${condition}）。本链仍未结案。`,
      agentId: input.question.agentId ?? task.assigneeAgentId!,
      sessionId: input.question.sessionId,
      followUp: true,
    });
    outcome.followUpQuestionId = followUp?.id ?? null;
    return outcome;
  }

  if (disposition === "refresh-requested") {
    // Evidence precedes judgment (C2): this creates no run and writes no
    // authorization. It asks for a card the human will read and then approve.
    outcome.confirmationCardId = await requestConfirmationCard(tx, task, binding.stopId, now);
    return outcome;
  }

  if (disposition === "repair-requested") {
    // Nothing further until POST /tasks/:taskId/merge-target lands a correction.
    return outcome;
  }

  await closeIntegratorQuestions(tx, task.id);
  const abandoned = disposition === "terminal-abandoned";
  const body = abandoned
    ? `Chain abandoned after merge stop ${condition}. No merge was performed by this contract.`
    : `Merge stop ${condition} closed by operator decision: ${input.choice}.`;
  await tx.taskStepOutput.upsert({
    where: { taskId: task.id },
    create: { taskId: task.id, kind: INTEGRATOR_OUTPUT_KIND, body },
    update: { body },
  });
  await tx.task.update({ where: { id: task.id }, data: { status: TaskStatus.DONE, failureReason: null } });
  await tx.taskActivity.create({ data: {
    taskId: task.id,
    actorType: "control-plane",
    body: abandoned
      ? `Chain abandoned; step ${INTEGRATOR_STEP_INDEX} closed without a merge (${condition})`
      : `Chain complete; step ${INTEGRATOR_STEP_INDEX} closed by operator decision (${condition})`,
  } });
  return outcome;
};

/** Refusals raised while resolving the gate, target, or source of confirmation evidence. */
export class MergeConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeConfirmationError";
  }
}

export const isMergeConfirmationError = (error: unknown): error is MergeConfirmationError =>
  error instanceof Error && error.name === "MergeConfirmationError";

/**
 * The confirmation card a renewal or repair asks for. The card is bound to the
 * immediate same-chain predecessor that feeds the integrator, while its agent,
 * Session and source Run come from the newest eligible same-chain predecessor.
 * Keeping those identities separate lets server-owned readiness steps share the
 * normal authorization path without pretending they executed an agent Run.
 */
export const requestConfirmationCard = async (
  tx: Tx,
  integratorTask: IntegratorTask,
  stopId: string,
  now = new Date(),
): Promise<string> => {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Task" WHERE "id" = ${integratorTask.id} FOR UPDATE
  `;
  if (!locked[0]) throw new MergeConfirmationError(`Merge integrator task ${integratorTask.id} no longer exists`);
  return ensureConfirmationCard(tx, integratorTask, stopId, now);
};

const confirmationKey = (integratorTaskId: string, stopId: string): string =>
  `confirmation:${integratorTaskId}:${stopId}`;

/**
 * The integrator Task mutex serializes the initial request and every replay or
 * control-plane repair. The Inbox card's unique dedupe key is the durable backstop;
 * taking the lock also lets every successful caller return the winner instead
 * of surfacing a uniqueness race.
 */
const ensureConfirmationCard = async (
  tx: Tx,
  integratorTask: IntegratorTask,
  stopId: string,
  now: Date,
): Promise<string> => {
  if (!integratorTask.chainId || integratorTask.chainIndex === null) {
    throw new MergeConfirmationError(
      `Merge integrator task ${integratorTask.id} has no chain identity for confirmation evidence`,
    );
  }
  const dedupeKey = confirmationKey(integratorTask.id, stopId);
  const existing = await tx.inboxMessage.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (existing) return existing.id;

  const target = await resolveChainTarget(tx, integratorTask);
  if (!target.resolved) {
    throw new MergeConfirmationError(
      `Merge confirmation target for task ${integratorTask.id} is ${target.unresolvable}; refusing unrelated evidence`,
    );
  }
  const predecessors = await tx.task.findMany({
    where: {
      projectId: integratorTask.projectId,
      chainId: integratorTask.chainId,
      chainIndex: { lt: integratorTask.chainIndex },
    },
    include: {
      templateStep: { include: { taskTemplate: { select: { name: true } } } },
      runs: {
        where: { session: { isNot: null } },
        include: { session: { select: { id: true } } },
        orderBy: [{ runNumber: "desc" }, { createdAt: "desc" }],
        take: 1,
      },
    },
    orderBy: { chainIndex: "desc" },
  });
  const gate = predecessors[0];
  if (!gate) {
    throw new MergeConfirmationError(
      `Merge confirmation for task ${integratorTask.id} has no immediate same-chain predecessor`,
    );
  }
  const sourceTask = predecessors.find(
    (candidate) => !taskIsIntegratorStep(candidate) && candidate.runs[0]?.session,
  );
  const source = sourceTask?.runs[0];
  if (!sourceTask || !source?.session) {
    throw new MergeConfirmationError(
      `Merge confirmation for task ${integratorTask.id} has no preceding same-chain Run with a Session`,
    );
  }
  const requested = await requestMergeEvidence(tx, {
    gateTaskId: gate.id,
    integratorTaskId: integratorTask.id,
    sourceRunId: source.id,
    agentId: source.agentId,
    sessionId: source.session.id,
    purpose: "confirmation",
    repository: target.repository,
    prNumber: target.prNumber,
    dedupeKey,
  }, now);
  return requested.cardId;
};

/**
 * Repairs the historical state in which the append-only stop answer says
 * refresh-requested but its Phase-A confirmation request is absent. This is
 * deliberately a no-op for every other stop disposition and for a request
 * that already exists.
 */
export const recoverRefreshRequestedConfirmationCard = async (
  tx: Tx,
  integratorTaskId: string,
  now = new Date(),
): Promise<string | null> => {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Task" WHERE "id" = ${integratorTaskId} FOR UPDATE
  `;
  if (!locked[0]) throw new Error(`Merge integrator task ${integratorTaskId} no longer exists`);
  const task = await loadIntegratorTask(tx, integratorTaskId);
  if (!task || !taskIsIntegratorStep(task)) {
    throw new Error(`Task ${integratorTaskId} is not a merge integrator step`);
  }
  const state = await stopStateFor(tx, integratorTaskId);
  if (!state || !state.dispositions.includes("refresh-requested")) return null;
  return ensureConfirmationCard(tx, task, state.stop.stopId, now);
};

/**
 * Records a stop the executor reported and lands the control-plane stop state.
 * Ordinary base drift is left for the server recovery worker; every other stop
 * opens the evidence-backed question its condition supports.
 */
export const recordIntegratorStop = async (
  tx: Tx,
  input: {
    integratorTaskId: string;
    condition: StopCondition;
    evidence: string;
    agentId: string;
    sessionId: string | null;
    sourceRunId: string;
  },
): Promise<{ stopId: string; questionId: string | null }> => {
  const stop = await tx.taskActivity.create({ data: {
    taskId: input.integratorTaskId,
    actorType: "control-plane",
    body: `Mechanical merge stopped: ${input.condition}`,
    metadata: {
      kind: MERGE_INTEGRATOR_KIND.result,
      schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
      outcome: "stopped",
      condition: input.condition,
      evidence: input.evidence,
      sourceRunId: input.sourceRunId,
    },
  } });
  await tx.task.update({
    where: { id: input.integratorTaskId },
    data: { status: TaskStatus.REVIEW, failureReason: `Mechanical merge stopped: ${input.condition}` },
  });
  const task = await loadIntegratorTask(tx, input.integratorTaskId);
  const automaticBaseDriftCandidate = input.condition === "base-drift"
    && isCanonicalIntegratorStep(task?.templateStep);
  const question = automaticBaseDriftCandidate ? null : await openStopQuestion(tx, {
    integratorTaskId: input.integratorTaskId,
    stopId: stop.id,
    condition: input.condition,
    evidence: input.evidence,
    agentId: input.agentId,
    sessionId: input.sessionId,
  });
  return { stopId: stop.id, questionId: question?.id ?? null };
};

// ---------------------------------------------------------------------------
// §D-P4 — the binding invariant, enforced at every surface that binds an Agent
// to a step
// ---------------------------------------------------------------------------

/**
 * Thrown rather than returned, because the callers that need this most are the
 * ones inside a transaction (`enqueueTaskRun`, template instantiation): a
 * returned refusal there is a value someone can forget to check, and a forgotten
 * check here means the sentinel Agent becomes dispatchable as a model agent.
 */
export class IntegratorBindingError extends Error {
  constructor(readonly refusal: string) {
    super(refusal);
    this.name = "IntegratorBindingError";
  }
}

export const isIntegratorBindingError = (error: unknown): error is IntegratorBindingError =>
  error instanceof Error && error.name === "IntegratorBindingError";

type BindingSubject = {
  assigneeAgentId?: string | null;
  assigneeAgentName?: string | null;
  templateStepId?: string | null;
  templateStep?: { stepIndex: number; outputKind: string; taskTemplate?: { name: string } | null } | null;
};

/**
 * Resolve whatever the caller has — ids, rows, or a mix — into the (agent name,
 * template step) pair the pure predicate needs, then apply it. Reads only; the
 * caller decides whether to refuse with a 400 or to throw.
 */
export const integratorBindingRefusalFor = async (
  tx: Tx,
  subject: BindingSubject,
): Promise<string | null> => {
  const agentName = subject.assigneeAgentName !== undefined
    ? subject.assigneeAgentName
    : subject.assigneeAgentId
      ? (await tx.agent.findUnique({ where: { id: subject.assigneeAgentId }, select: { name: true } }))?.name ?? null
      : null;
  const step = subject.templateStep !== undefined
    ? subject.templateStep
    : subject.templateStepId
      ? await tx.taskTemplateStep.findUnique({
        where: { id: subject.templateStepId },
        select: { stepIndex: true, outputKind: true, taskTemplate: { select: { name: true } } },
      })
      : null;
  return integratorBindingRefusal(agentName, step);
};

export const assertIntegratorBinding = async (tx: Tx, subject: BindingSubject): Promise<void> => {
  const refusal = await integratorBindingRefusalFor(tx, subject);
  if (refusal) throw new IntegratorBindingError(refusal);
};

/**
 * What the claim route hands the caller, and what the ordinary runner refuses.
 * Derived from the template step alone: nothing a client sends participates.
 */
export type ExecutionMode = "mechanical" | "agent";

export const executionModeFor = (step: IntegratorStepShape): ExecutionMode =>
  isIntegratorStep(step) ? "mechanical" : "agent";

/**
 * The runner ids permitted to claim integrator runs — and, symmetrically,
 * permitted to claim nothing else. Empty by default, so an unconfigured
 * deployment hands out no integrator run at all rather than handing one to the
 * ordinary runner.
 */
export const mergeExecutorRunnerIds = (raw = process.env.MERGE_EXECUTOR_RUNNER_IDS): string[] =>
  (raw ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);

export const isMergeExecutorRunnerId = (runnerId: string, allowlist = mergeExecutorRunnerIds()): boolean =>
  allowlist.includes(runnerId);

/**
 * The authenticated class of a caller on the runner protocol. This is derived
 * from the bearer the caller presented, never from anything in a request body:
 * `runnerId` is a self-reported label and carries no authority.
 */
export type ClaimantClass = "merge-executor" | "runner";

/**
 * §D-P1 rule 3, as one predicate both directions of the rule share. A claim is
 * offered a candidate only when the candidate's execution mode and the claiming
 * principal's class agree; either mismatch skips the candidate rather than
 * rejecting the claim, so an ordinary runner polling while an integrator run
 * waits simply sees nothing.
 *
 * The principal decides. The `MERGE_EXECUTOR_RUNNER_IDS` allowlist is kept as a
 * second, independent condition on mechanical work — an executor credential
 * carried into a process that the deployment has not published as an executor
 * still takes no integrator run — and, in the other direction, an id the
 * deployment *has* published may not be borrowed by an ordinary runner. With
 * the allowlist empty (the shipped default) no integrator run is claimable by
 * anyone, whatever credential is presented.
 */
export const claimantMayTake = (
  mode: ExecutionMode,
  claimant: ClaimantClass,
  runnerId: string,
  allowlist = mergeExecutorRunnerIds(),
): boolean => {
  if ((mode === "mechanical") !== (claimant === "merge-executor")) return false;
  return (mode === "mechanical") === isMergeExecutorRunnerId(runnerId, allowlist);
};

/**
 * Why a caller may not act on a run of this execution mode, or `null` when it
 * may. Shared by every runner-protocol route that finishes mechanical work, so
 * that "the executor claimed it" and "the executor completed it" are the same
 * fact about the same credential rather than two independent string checks.
 */
export const mechanicalPrincipalRefusal = (
  mode: ExecutionMode,
  claimant: ClaimantClass,
  runnerId: string,
  allowlist = mergeExecutorRunnerIds(),
): string | null => {
  if (mode === "mechanical" && claimant !== "merge-executor") {
    return "A mechanical run may only be acted on by the merge-executor principal";
  }
  if (mode !== "mechanical" && claimant === "merge-executor") {
    return "The merge-executor principal may only act on mechanical runs";
  }
  if (mode === "mechanical" && !isMergeExecutorRunnerId(runnerId, allowlist)) {
    return "Runner id is not an allowlisted merge executor";
  }
  return null;
};
