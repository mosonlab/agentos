import { Prisma } from "@prisma/client";

import {
  INTEGRATOR_OUTPUT_KIND,
  isCanonicalIntegratorStep,
  isTerminalDisposition,
  MERGE_INTEGRATOR_KIND,
} from "./merge-integrator.js";
import * as mergeIntegratorDb from "./merge-integrator-db.js";
import {
  latestRecordedStop,
  loadIntegratorTask,
  openStopQuestion,
  stopAnswerDispositions,
  stopQuestionKey,
  taskIsIntegratorStep,
} from "./merge-integrator-db.js";
import { lockTaskRow } from "./locks.js";

type Tx = Prisma.TransactionClient;

/**
 * The maintenance script deliberately accepts the smallest database surface
 * it needs. The real Prisma client is cast to this shape by the thin CLI;
 * keeping the scan/repair logic behind this boundary also lets tests run
 * without constructing a client or connecting to a database.
 */
export type MergeStopQuestionBackfillDatabase = {
  task: {
    findMany(args: unknown): Promise<Array<{ id: string }>>;
  };
  $transaction<T>(operation: (tx: Tx) => Promise<T>): Promise<T>;
};

export type MergeStopQuestionBackfillResult = {
  /** Integrator Task rows with at least one recorded result considered. */
  scanned: number;
  /** Missing questions successfully created in this pass. */
  created: number;
  /** A question for the current stop already existed. */
  alreadyPresent: number;
  /** Canonical ordinary base-drift remains owned by its recovery worker. */
  deferredOrdinaryBaseDrift: number;
  /** Archived Tasks, terminally answered stops, and no-longer-current stops. */
  skipped: number;
  /** Candidate transactions that could not be repaired. */
  failed: number;
};

export type MergeStopQuestionBackfillFailure = {
  taskId: string;
  message: string;
};

export type MergeStopQuestionBackfillOptions = {
  onFailure?: (failure: MergeStopQuestionBackfillFailure) => void;
};

type RepairOutcome =
  | "created"
  | "already-present"
  | "deferred-ordinary-base-drift"
  | "skipped";

type SharedStopLanding = (
  tx: Tx,
  input: { integratorTaskId: string; resultActivityId?: string | null },
) => Promise<{ questionId?: string | null } | unknown>;

/**
 * Repair one Task while holding the same Task-row mutex as stop landing and
 * task archival. The latest result and its dispositions are read after the
 * lock, so a completion/answer that wins the race before this transaction
 * commits is observed rather than resurrected. The final write goes through
 * `landIntegratorStop`, the shared stop-landing operation used by production
 * writers, so this maintenance path cannot drift from the transaction and
 * identity rules of completion/session ingestion.
 */
const repairTask = async (tx: Tx, taskId: string): Promise<RepairOutcome> => {
  const locked = await lockTaskRow(tx, taskId);
  if (!locked || locked.archivedAt !== null) return "skipped";

  const task = await loadIntegratorTask(tx, taskId);
  if (!task || !taskIsIntegratorStep(task) || task.archivedAt !== null) return "skipped";

  const stop = await latestRecordedStop(tx, taskId);
  if (!stop) return "skipped";

  const dispositions = await stopAnswerDispositions(tx, taskId, stop.stopId);
  if (dispositions.some((disposition) => isTerminalDisposition(disposition))) return "skipped";

  const dedupeKey = stopQuestionKey(stop.stopId);
  const existing = await tx.inboxMessage.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (existing) return "already-present";

  // This is the one intentional handoff to the existing automatic recovery
  // worker. A canonical ordinary base-drift stop must remain question-less
  // until that worker exhausts or loses eligibility, at which point it opens
  // the abandon-only question itself.
  if (stop.condition === "base-drift" && isCanonicalIntegratorStep(task.templateStep)) {
    return "deferred-ordinary-base-drift";
  }

  // The starting commit predates the shared landing operation. Keep this
  // narrow compatibility branch only so the maintenance module remains
  // type-checkable on that commit; integrated production code always resolves
  // `landIntegratorStop` and therefore shares its identity/transaction rules.
  const sharedLanding = (mergeIntegratorDb as unknown as { landIntegratorStop?: SharedStopLanding }).landIntegratorStop;
  if (sharedLanding) {
    const landed = await sharedLanding(tx, { integratorTaskId: taskId, resultActivityId: stop.stopId });
    // A second writer that already won the Inbox dedupe race is a successful
    // no-op, not a newly-created card. The Task lock normally makes this
    // branch unreachable, but the result contract keeps the counter truthful
    // if another legacy writer is still draining during a deployment.
    if (typeof landed === "object" && landed !== null && "questionId" in landed && landed.questionId === null) {
      return "already-present";
    }
  } else {
    const sourceRun = stop.sourceRunId
      ? await tx.run.findUnique({
        where: { id: stop.sourceRunId },
        select: { agentId: true, session: { select: { id: true } } },
      })
      : null;
    const agentId = sourceRun?.agentId ?? task.assigneeAgentId;
    if (!agentId) throw new Error(`Cannot repair merge stop ${stop.stopId}: no Agent identity is available`);
    const question = await openStopQuestion(tx, {
      integratorTaskId: taskId,
      stopId: stop.stopId,
      condition: stop.condition,
      evidence: stop.evidence,
      agentId,
      sessionId: sourceRun?.session?.id ?? null,
    });
    if (!question) return "already-present";
  }
  return "created";
};

const emptyResult = (): MergeStopQuestionBackfillResult => ({
  scanned: 0,
  created: 0,
  alreadyPresent: 0,
  deferredOrdinaryBaseDrift: 0,
  skipped: 0,
  failed: 0,
});

/**
 * Repair every current, unresolved, question-eligible recorded stop. Each
 * candidate has its own transaction: one bad identity or Inbox write must not
 * starve later candidates, and a failed transaction leaves no partial Inbox or
 * Task-side state behind. Stable id order gives operators deterministic
 * progress and diagnostics across reruns.
 */
export const backfillMergeStopQuestions = async (
  db: MergeStopQuestionBackfillDatabase,
  options: MergeStopQuestionBackfillOptions = {},
): Promise<MergeStopQuestionBackfillResult> => {
  const result = emptyResult();
  const candidates = await db.task.findMany({
    where: {
      templateStep: { outputKind: INTEGRATOR_OUTPUT_KIND },
      activity: { some: { metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.result } } },
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });

  for (const candidate of candidates) {
    result.scanned += 1;
    try {
      const outcome = await db.$transaction((tx) => repairTask(tx, candidate.id));
      if (outcome === "created") result.created += 1;
      else if (outcome === "already-present") result.alreadyPresent += 1;
      else if (outcome === "deferred-ordinary-base-drift") result.deferredOrdinaryBaseDrift += 1;
      else result.skipped += 1;
    } catch (error) {
      result.failed += 1;
      options.onFailure?.({
        taskId: candidate.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
};

const summary = (result: MergeStopQuestionBackfillResult): string => [
  `scanned ${result.scanned}`,
  `created ${result.created}`,
  `already-present ${result.alreadyPresent}`,
  `deferred-ordinary-base-drift ${result.deferredOrdinaryBaseDrift}`,
  `skipped ${result.skipped}`,
  `failed ${result.failed}`,
].join(", ");

export type MergeStopQuestionBackfillCliDeps = {
  db: MergeStopQuestionBackfillDatabase;
  log?: (line: string) => void;
  error?: (line: string) => void;
};

/** Run the committed CLI body and return its process exit code. */
export const runBackfillMergeStopQuestionsCli = async (
  { db, log = console.log, error = console.error }: MergeStopQuestionBackfillCliDeps,
): Promise<number> => {
  const failures: MergeStopQuestionBackfillFailure[] = [];
  const result = await backfillMergeStopQuestions(db, { onFailure: (failure) => failures.push(failure) });
  log(summary(result));
  for (const failure of failures) error(`  ${failure.taskId}: ${failure.message}`);
  return result.failed === 0 ? 0 : 1;
};
