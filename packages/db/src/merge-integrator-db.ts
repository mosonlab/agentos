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
  MERGE_INTEGRATOR_KIND,
  MERGE_INTEGRATOR_SCHEMA_VERSION,
  type Disposition,
  type StopCondition,
  githubRepositoryFromRemote,
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

/** True when this task row *is* the chain's step-10 task. */
export const taskIsIntegratorStep = (task: IntegratorTask | null | undefined): boolean =>
  isIntegratorStep(task?.templateStep ?? null);

export const loadIntegratorTask = async (tx: Tx, taskId: string): Promise<IntegratorTask | null> =>
  tx.task.findUnique({ where: { id: taskId }, include: INTEGRATOR_INCLUDE });

/** The chain's step-10 task, or null for an ordinary nine-step chain. */
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
 * two-phase evidence protocol on: an ordinary nine-step chain's gate is
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

export type RecordedStop = { stopId: string; condition: StopCondition; createdAt: Date };

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
    return { stopId: row.id, condition: metadata.condition, createdAt: row.createdAt };
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
