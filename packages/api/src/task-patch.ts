import {
  activateChainSuccessor,
  CompoundImplementationAssigneeError,
  compoundImplementationAssigneeValid,
  InboxStatus,
  integratorBindingRefusalFor,
  Prisma,
  type PrismaClient,
  produceMergeAuthorization,
  ScheduleKind,
  stopStateFor,
  stopStateRefusal,
  type Task,
  TaskStatus,
} from "@anneal/db";

import type { TaskPatchInput } from "./app.js";
import { blockingPredecessor } from "./chain.js";
import { type Refusal, refusalFor } from "./refusal.js";
import { validateSchedule } from "./scheduler.js";
import { rewriteBrief, stepHasTaskBrief } from "./task-brief.js";
import {
  hasActiveRun,
  isLiveStatus,
  reactivationBlocked,
  type TaskActivityInput,
  writeTask,
  type TaskWriteRefusal,
} from "./task-write.js";
import { withoutUndefined } from "./without-undefined.js";

export type TaskPatchRefusal = Refusal;

export type TaskPatchResult = { task: Task } | TaskPatchRefusal;

export const taskStatusChangedActivity = (
  previousStatus: TaskStatus,
  status: TaskStatus,
): TaskActivityInput => ({
  actorType: "operator",
  body: `Status changed: ${previousStatus} → ${status}`,
});

/** What the status write plans under the lock: a refusal this action owns, a
 *  replay of an already-decided gate, or the write itself. */
type StatusWritePlan =
  | Refusal
  | { replay: true }
  | { gate: GateWinner; previousStatus: TaskStatus };

type GateWinner = {
  card: { id: string; body: string; gateTaskId: string | null; sessionId: string | null };
  runId: string;
} | null;

/**
 * The status transitions owned by the board operator.
 *
 * Execution code does not call this action: runners and the chain control
 * plane write their machine-owned states through their own fenced paths.  A
 * board PATCH may therefore only move standalone work between its two queue
 * states, or record the one terminal decision a Human owns.  Chain state is a
 * projection of chain execution, with that Human completion as its sole
 * operator-owned exception.
 */
export const operatorStatusTransitionRefusal = (
  task: Pick<Task, "assigneeType" | "chainId" | "status">,
  next: TaskStatus,
): string | null => {
  if (next === task.status) return null;
  if (task.assigneeType === "HUMAN" && next === TaskStatus.DONE) return null;
  if (task.chainId !== null) return "Chain task statuses are controlled by chain execution";
  const queueTransition = (
    (task.status === TaskStatus.BACKLOG && next === TaskStatus.TODO)
    || (task.status === TaskStatus.TODO && next === TaskStatus.BACKLOG)
  );
  if (queueTransition) return null;
  return task.assigneeType === "AGENT"
    ? "Doing, Review, and Done for agent tasks are controlled by execution"
    : "Human tasks may move between Backlog and Todo or be marked Done";
};

/** A refusal from `writeTask` in this action's terms: the task is gone, or the
 *  assignee the request named may not be written onto it. */
const taskWriteRefusal = (refusal: TaskWriteRefusal): Refusal => (
  refusal.kind === "absent"
    ? { reason: "not-found", message: "Task not found" }
    : { reason: "invalid-request", message: refusal.reason }
);

/**
 * Patch a task. The action owns its preflight refusals and all four of its
 * transactions, including their isolation level; the caller supplies a parsed
 * patch and maps the returned refusal onto a response.
 *
 * The four transactions stay four. Three of them are guarded by different
 * conditions and fire on different requests, so merging them would change
 * which writes happen together.
 */
export const patchTask = async (
  db: PrismaClient,
  taskId: string,
  body: TaskPatchInput,
): Promise<TaskPatchResult> => {
  const before = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  if (before.chainId !== null && body.approvalGate !== undefined && body.approvalGate !== before.approvalGate) {
    return { reason: "conflict", message: "Approval gates on dispatched chain tasks are controlled by the chain" };
  }
  // Held for the whole route: whichever of the three write paths below runs
  // re-reads this assignee under the Agent-row mutex before it commits.
  const assignee = body.assigneeAgentId
    ? await db.agent.findFirst({ where: { id: body.assigneeAgentId, projectId: before.projectId } })
    : null;
  const effectiveAgentId = body.assigneeAgentId === undefined ? before.assigneeAgentId : body.assigneeAgentId;
  const effectiveAssigneeType = body.assigneeType ?? before.assigneeType;
  if (before.archivedAt === null
    && (body.assigneeType !== undefined || body.assigneeAgentId !== undefined)) {
    const [effectiveAgent, templateStep] = await Promise.all([
      effectiveAgentId
        ? db.agent.findFirst({ where: { id: effectiveAgentId, projectId: before.projectId } })
        : null,
      before.templateStepId
        ? db.taskTemplateStep.findUnique({
          where: { id: before.templateStepId },
          select: { stepIndex: true, outputKind: true, taskTemplate: { select: { name: true } } },
        })
        : null,
    ]);
    if (!compoundImplementationAssigneeValid(
      before.projectId,
      effectiveAssigneeType,
      effectiveAgent,
      templateStep,
    )) {
      const error = new CompoundImplementationAssigneeError();
      const refusal = refusalFor(error);
      if (!refusal) throw error;
      return refusal;
    }
  }
  if (body.assigneeAgentId) {
    if (!assignee) return { reason: "invalid-request", message: "Assignee does not belong to this project" };
    if (assignee.archivedAt) return { reason: "invalid-request", message: `Assignee ${assignee.name} is archived` };
  }
  if (body.repoId) {
    const repo = await db.repo.findFirst({ where: { id: body.repoId, projectId: before.projectId } });
    if (!repo) return { reason: "invalid-request", message: "Repo does not belong to this project" };
  }
  const effectiveRepoId = body.repoId === undefined ? before.repoId : body.repoId;
  if (effectiveAgentId && effectiveRepoId) {
    const access = await db.agentRepoAccess.findFirst({
      where: { agentId: effectiveAgentId, repoId: effectiveRepoId, projectId: before.projectId },
    });
    if (!access) return { reason: "invalid-request", message: "Assignee has no grant for this Repo" };
  }
  // §D-P4 on reassignment. `templateStepId` is not a patchable field, so the
  // step half of the pair cannot move under this check; the assignee half is
  // exactly what this route can move, in either direction — an ordinary task
  // onto the sentinel, or the integrator step off it onto a model agent.
  const reassignmentRefusal = await integratorBindingRefusalFor(db, {
    assigneeAgentName: effectiveAgentId
      ? (await db.agent.findUnique({ where: { id: effectiveAgentId }, select: { name: true } }))?.name ?? null
      : null,
    templateStepId: before.templateStepId,
  });
  if (reassignmentRefusal) return { reason: "invalid-request", message: reassignmentRefusal };
  const scheduleTouched = body.scheduleKind !== undefined || body.runAt !== undefined || body.cron !== undefined || body.timezone !== undefined;
  const atExecutorTouched = before.scheduleKind === ScheduleKind.AT
    && (body.assigneeType !== undefined || body.assigneeAgentId !== undefined || body.repoId !== undefined);
  let schedule;
  if (scheduleTouched || atExecutorTouched) {
    try {
      schedule = validateSchedule({
        scheduleKind: body.scheduleKind ?? before.scheduleKind ?? ScheduleKind.NOW,
        runAt: body.runAt === undefined ? before.runAt ?? null : body.runAt,
        cron: body.cron === undefined ? before.cron ?? null : body.cron,
        timezone: body.timezone === undefined ? before.timezone ?? null : body.timezone,
        assigneeType: effectiveAssigneeType,
        assigneeAgentId: effectiveAgentId,
        repoId: effectiveRepoId,
      });
    } catch (error: unknown) {
      return { reason: "invalid-request", message: error instanceof Error ? error.message : "Invalid schedule" };
    }
  }
  let patch = body;
  if (body.description !== undefined
    && before.templateId != null
    && before.chainId != null) {
    const templateStep = before.templateStepId
      ? await db.taskTemplateStep.findUnique({
        where: { id: before.templateStepId },
        select: { outputKind: true, priorOutputKinds: true },
      })
      : null;
    if (!templateStep) {
      return { reason: "invalid-request", message: "Cannot rewrite task brief: template Step metadata is missing" };
    }
    if (stepHasTaskBrief(templateStep.outputKind)) {
      const rewritten = rewriteBrief(before.description, body.description, {
        legacyAttachmentsFromPrevious: templateStep.priorOutputKinds.length > 0,
      });
      if (typeof rewritten !== "string") {
        return {
          reason: "invalid-request",
          message: `Cannot rewrite task brief: ${rewritten.unparseable}`,
        };
      }
      patch = { ...body, description: rewritten };
    }
  }
  const updateData = {
    ...withoutUndefined(patch),
    ...(scheduleTouched ? schedule : {}),
  } as Prisma.TaskUncheckedUpdateInput;
  // A status write joins the Task-row mutex, like start / retry / archive /
  // the scheduler's claims. Two reasons, both proven by regression tests:
  //
  //  - Parking in Backlog must be atomic with `Start now`. Counting active
  //    runs outside a transaction and writing later loses the race, and the
  //    loss does not "resolve on completion": the runner claims only
  //    `TODO|DOING`, so a QUEUED run left on a BACKLOG task is never claimed
  //    and never completes.
  //  - Without the lock a status write can land *after* `archive-done`
  //    committed and drag an archived task back onto a board that does not
  //    show it — a guard set in which one writer ignores `archivedAt`
  //    excludes nothing.
  //
  // One rule, no exceptions: an archived task's status is frozen until it is
  // unarchived, whether or not the transition also advances a chain. Splitting
  // that by `advances` would let an archived chained task be marked DONE while
  // an archived standalone one could not.
  //
  // Every request that names a status takes this path, not only the ones that
  // look like a change against the unlocked `before` read. `before` is stale
  // by definition, so "status: TODO on a task that is already TODO" can land
  // on a row another writer has since parked or archived — and outside the
  // transaction it wrote that TODO back with no lock and no guard at all.
  if (body.status !== undefined) {
    const written = await db.$transaction(async (tx) => {
      const result = await writeTask<StatusWritePlan>(tx, taskId, async (locked) => {
        const refuse = (message: string) => ({
          update: null,
          activity: null,
          value: { reason: "conflict" as const, message },
        });
        if (locked.archivedAt !== null) {
          return refuse("Cannot change the status of an archived task; unarchive it first");
        }
        if (typeof locked.dispatchAfterTaskId === "string"
          && locked.dispatchAfter?.status !== TaskStatus.DONE
          && body.status !== locked.status) {
          const predecessorName = locked.dispatchAfter?.name ?? locked.dispatchAfterTaskId;
          return refuse(`Cannot change bound task status before predecessor ${predecessorName} is done`);
        }
        // Promoting BACKLOG or DONE history into TODO|DOING|REVIEW gives the
        // task back to whoever it is *already* assigned to, and that assignee is
        // in no request field for the module's assignment guard to have checked.
        // So the stored one joins the same protocol here, read under the
        // Agent-row mutex the locked Task row already ordered us into. `locked`
        // is the authority on it, not the pre-transaction `before` read.
        //
        // 409, not the 400 the module answers with: nothing in the request is
        // malformed — the conflict is in the state of the assignee, which the
        // operator can fix and retry, exactly like Retry's archived-assignee
        // refusal.
        if (body.assigneeAgentId === undefined
          && !isLiveStatus(locked.status)
          && body.status !== undefined
          && isLiveStatus(body.status)) {
          const blockedReactivation = await reactivationBlocked(tx, locked);
          if (blockedReactivation) return refuse(blockedReactivation);
        }
        // Against `locked`, not `before`: a park is a park whenever the row this
        // transaction holds is not already in Backlog.
        if (body.status === TaskStatus.BACKLOG
          && locked.status !== TaskStatus.BACKLOG
          && await hasActiveRun(tx, taskId)) {
          return refuse("Cannot move a task with an active run to Backlog");
        }
        // §D-P7 / Step 5. The exclusivity guard, composed rather than
        // duplicated: while a recorded stop has no terminal-disposition answer,
        // this task does not move. Keyed on the disposition, not on an answer
        // existing, because `flag-incident` writes an answer and must still
        // hold the chain.
        const stopped = await stopStateFor(tx, taskId);
        if (stopped && body.status !== undefined && body.status !== locked.status) {
          return refuse(stopStateRefusal(stopped));
        }
        // Ownership is the generic boundary. A forbidden board move must not
        // hide the more actionable reason that this same write is impossible
        // anyway. The shared guards are above; DONE's active-run and chain-
        // predecessor guards run below before its ownership refusal.
        const operatorRefusal = operatorStatusTransitionRefusal(locked, body.status!);
        if (body.status !== TaskStatus.DONE && operatorRefusal !== null) return refuse(operatorRefusal);
        let gate: GateWinner = null;
        if (body.status === TaskStatus.DONE) {
          if (await hasActiveRun(tx, taskId)) {
            return refuse("Cannot mark a task done while it has an active run");
          }
          if (locked.chainId) {
            const chainRows = await tx.task.findMany({
              where: {
                projectId: locked.projectId,
                chainId: locked.chainId,
              },
              orderBy: [{ chainLayer: "asc" }, { chainIndex: "asc" }, { id: "asc" }],
              select: { id: true, name: true, status: true, chainIndex: true, chainLayer: true },
            });
            const blocker = blockingPredecessor(chainRows, taskId);
            if (blocker) {
              return refuse(`Cannot complete ${before.name}; predecessor ${blocker.name} is not done`);
            }
          }
          if (operatorRefusal !== null) return refuse(operatorRefusal);
          // A Human approval has one durable decision identity on both API
          // channels. The earliest OPEN card is the deterministic winner; the
          // gate Task lock the module took makes this selection and the Inbox
          // route's OPEN claim one compare-and-set rather than two competing
          // decisions. Selecting is a read; the CAS that writes it runs below,
          // once the module has accepted the status write — a refusal after
          // the CAS would commit a decision the request was refused.
          const winningGateCard = await tx.inboxMessage.findFirst({
            where: { gateTaskId: taskId, status: InboxStatus.OPEN },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { id: true, body: true, gateTaskId: true, sessionId: true },
          });
          if (winningGateCard) {
            const session = winningGateCard.sessionId
              ? await tx.session.findUnique({ where: { id: winningGateCard.sessionId }, select: { runId: true } })
              : null;
            if (!session?.runId) {
              return refuse("Gate card has no session run to bind a decision to");
            }
            gate = { card: winningGateCard, runId: session.runId };
          } else {
            // A gate exists but none is OPEN only after another channel won or
            // this request is a replay. Do not overwrite a concurrent reject
            // or activate the successor a second time. No decision row is
            // created on this branch, and no authorization: the SPEC's
            // fail-closed resolution (missing-authorization) is preserved.
            //
            // The OPEN rows are counted rather than inferred from the CAS: the
            // CAS is a write, and it now runs only once the status write has
            // been accepted, so the replay decision cannot be taken from it.
            const openGates = await tx.inboxMessage.count({
              where: { gateTaskId: taskId, status: InboxStatus.OPEN },
            });
            if (openGates === 0) {
              const decidedGate = await tx.inboxMessage.count({ where: { gateTaskId: taskId } });
              if (decidedGate > 0) return { update: null, activity: null, value: { replay: true as const } };
            }
          }
        }
        const statusChanged = body.status !== undefined && body.status !== locked.status;
        return {
          update: updateData,
          activity: statusChanged
            ? taskStatusChangedActivity(locked.status, body.status!)
            : null,
          value: { gate, previousStatus: locked.status },
        };
      });
      if (!result.ok) return taskWriteRefusal(result.refusal);
      const plan = result.value;
      if ("message" in plan) return plan;
      // The replay branch wrote nothing, so what the caller gets back is the
      // row the gate was already decided on.
      if ("replay" in plan) return { task: await tx.task.findUniqueOrThrow({ where: { id: taskId } }) };
      const updated = result.written!;
      // This OPEN row is the gate-decision CAS. It deliberately depends on
      // neither templateId nor approvalGate: gate creation records the
      // relationship in gateTaskId, and that is the only authority here.
      if (body.status === TaskStatus.DONE) {
        if (plan.gate) {
          await tx.inboxMessage.update({
            where: { id: plan.gate.card.id },
            data: { status: InboxStatus.ANSWERED, selectedChoiceId: "approve", answeredAt: new Date() },
          });
        }
        await tx.inboxMessage.updateMany({
          where: { gateTaskId: taskId, status: InboxStatus.OPEN },
          data: { status: InboxStatus.CLOSED },
        });
      }
      let authorization: Awaited<ReturnType<typeof produceMergeAuthorization>> = null;
      if (plan.gate) {
        const decisionRow = await tx.inboxDecision.create({ data: {
          inboxMessageId: plan.gate.card.id,
          runId: plan.gate.runId,
          externalEventId: `patch:${taskId}:${result.activityId ?? plan.gate.card.id}`,
          decision: "approve",
          actorOpenId: "patch-operator",
        } });
        authorization = await produceMergeAuthorization(tx, {
          card: plan.gate.card,
          inboxDecisionId: decisionRow.id,
          channel: "patch",
        }, new Date());
      }
      if (plan.previousStatus !== TaskStatus.DONE
        && body.status === TaskStatus.DONE
        && Boolean(updated.chainId)
        && authorization?.purpose !== "confirmation") {
        await activateChainSuccessor(tx, updated, { sourceRunId: null }, new Date());
      }
      return { task: updated };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    if ("message" in written) return written;
    return { task: written.task };
  }
  if (body.opensPullRequest !== undefined) {
    // The flag defines the next Run snapshot. PATCH must therefore share the
    // same Task-row serialization point as completion retries and lost-lease
    // requeues; otherwise a request that commits first can still be missed by
    // a creator holding a stale task relation.
    const updated = await db.$transaction(
      async (tx) => writeTask(tx, taskId, async () => ({ update: updateData, activity: null, value: null })),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    if (!updated.ok) {
      return taskWriteRefusal(updated.refusal);
    }
    return { task: updated.written! };
  }
  // A plain field edit that hands the task to an agent is still an assignment
  // writer, so it joins the same protocol: Task row first, Agent row second.
  if (assignee) {
    const written = await db.$transaction(
      async (tx) => writeTask(tx, taskId, async () => ({ update: updateData, activity: null, value: null })),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    if (!written.ok) {
      return taskWriteRefusal(written.refusal);
    }
    return { task: written.written! };
  }
  const written = await db.$transaction(
    async (tx) => writeTask(tx, taskId, async () => ({ update: updateData, activity: null, value: null })),
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
  if (!written.ok) {
    return taskWriteRefusal(written.refusal);
  }
  return { task: written.written! };
};
