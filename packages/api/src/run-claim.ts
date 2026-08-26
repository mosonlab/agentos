import {
  AssigneeType,
  CleanupStatus,
  claimantMayTake,
  deployBarrierAllowsClaim,
  executionModeFor,
  FailureClass,
  integratorBindingRefusal,
  isMergeReadinessStep,
  isPinnedBaseCommitError,
  MERGE_TAIL_KIND,
  mergeExecutorRunnerIds,
  PinnedBaseCommitError,
  pinnedImplementationRange,
  Prisma,
  type PrismaClient,
  RunStatus,
  SessionExecutionStatus,
  taskIsIntegratorStep,
  TaskStatus,
} from "@agentos/db";

import type { ClaimInput } from "./app.js";
import { issueSessionToken } from "./auth.js";
import { isCanonicalBlindFindingsStep, previousRunHandoffForClaim } from "./canonical-task-output.js";
import { makeFencingToken } from "./execution.js";
import { openMergeTailStopNotice } from "./merge-tail-actions.js";
import { regressionRepairHandoffForClaim } from "./regression-repair-handoff.js";
import { activeRunStatuses } from "./run-fence.js";
import { readStoredCliAvailability } from "./runner-cli-availability.js";
import { decryptSecret } from "./secrets.js";
import { isSerializationConflict, serializationRetryDelay } from "./serialization-retry.js";
import { lockTaskMutationRows, writeTask } from "./task-write.js";

class PinnedRunTargetError extends Error {
  constructor(readonly runId: string, targetBranch: string | null, implementationHeadSha: string) {
    super(`Pinned run ${runId} targets ${targetBranch ?? "no commit"}, but its source step now records ${implementationHeadSha}`);
    this.name = "PinnedRunTargetError";
  }
}

type CandidateActivationFailure = PinnedBaseCommitError | PinnedRunTargetError;

const isCandidateActivationFailure = (error: unknown): error is CandidateActivationFailure =>
  isPinnedBaseCommitError(error) || error instanceof PinnedRunTargetError;

const namedFailureReason = (error: CandidateActivationFailure): string => `${error.name}: ${error.message}`;

/** §D-P1 rule 3. The bearer the caller presented, not the `runnerId` label it
 *  writes about itself: only the former can carry mechanical authority. */
export type ClaimantClass = "merge-executor" | "runner";

export type ClaimRunInput = {
  body: ClaimInput;
  claimantClass: ClaimantClass;
  /** The instant the whole claim is decided at, including the caller's
   *  pre-claim reconciliation. */
  now: Date;
};

/**
 * Claim one queued run, or answer that nothing was claimable.
 *
 * The action owns the Serializable transaction and the six-attempt retry
 * around it. Both are invariants of claiming, not of HTTP: a caller that had
 * to restate the isolation level or re-implement the retry would be restating
 * the reason this transaction can lose a race it did not cause.
 */
export const claimRun = async (db: PrismaClient, input: ClaimRunInput) => {
  const { body, claimantClass, now } = input;
  const claimOnce = () => db.$transaction(async (tx) => {
    // This is the shared half of the production deploy barrier. It is the
    // first statement in the claim transaction: an in-flight claim finishes
    // before a deploy can acquire the exclusive half, and claims arriving
    // during a deploy return no work without observing candidates.
    if (!await deployBarrierAllowsClaim(tx)) return null;
    const candidates = await tx.run.findMany({
      where: {
        status: RunStatus.QUEUED,
        readyAt: { lte: now },
        agent: { archivedAt: null },
        // `archivedAt: null` is defense in depth: `enqueueTaskRun` already
        // refuses an archived task, and archive already refuses a task with an
        // active run, so a queued run on an archived task should be
        // unreachable. If one ever exists it must not be handed to a runner.
        task: {
          status: { in: [TaskStatus.TODO, TaskStatus.DOING] },
          assigneeType: AssigneeType.AGENT,
          archivedAt: null,
        },
        OR: [{ blockedByRunId: null }, { blockedBy: { status: RunStatus.SUCCEEDED } }],
      },
      include: {
        // templateStep travels with the claim so delivery can title the PR
        // after the chain rather than the step it happens to be running.
        // §D-P4 / §D-P1 rule 3 need all four identity facts of the step, not
        // only its display name: the claim transaction is where
        // `executionMode` is computed and where a mis-bound candidate is
        // skipped rather than handed out.
        task: { include: { templateStep: { include: { taskTemplate: { select: { name: true } } } } } },
        repo: true,
        session: true,
        agent: {
          include: {
            secretGrants: { include: { secret: true } },
            environment: { include: { secrets: { include: { secret: true } } } },
            repoAccess: true,
          },
        },
      },
      orderBy: [{ readyAt: "asc" }, { createdAt: "asc" }],
      take: 20,
    });
    const executorRunnerIds = mergeExecutorRunnerIds();
    for (const candidate of candidates) {
      if (!candidate.task || !candidate.repo) continue;
      if (!candidate.agent.repoAccess.some((grant) => grant.repoId === candidate.repoId && grant.projectId === candidate.projectId)) {
        const reason = "repository-grant-missing: restore the agent Repo grant, then retry this run";
        const stranded = await tx.run.updateMany({
          where: { id: candidate.id, status: RunStatus.QUEUED, leaseGeneration: candidate.leaseGeneration },
          data: {
            status: RunStatus.FAILED,
            failureClass: FailureClass.TASK_FAILED,
            failureReason: reason,
            retryable: false,
            endedAt: now,
          },
        });
        if (stranded.count === 1) {
          const parked = await writeTask(tx, candidate.task.id, async () => ({
            update: { status: TaskStatus.BACKLOG, failureReason: reason },
            activity: {
              actorType: "control-plane",
              body: "Queued run stopped because its repository grant is missing; restore the grant and retry",
              metadata: { runId: candidate.id, condition: "repository-grant-missing" },
            },
            value: null,
          }));
          // A chained park expands the lock order from this Run to every Task
          // in the chain. End the transaction here: scanning another
          // candidate could next wait on a sibling Run while its claimant
          // already holds that Run and waits for this chain mutex.
          if (parked.ok && parked.chainLocked) return null;
        }
        continue;
      }
      // §D-P4. A candidate whose (agent, step) binding is invalid is *skipped*,
      // not claimed: a mis-bound step-12 row must never be handed to anything,
      // and the sentinel Agent on an ordinary step must never reach an adapter.
      if (integratorBindingRefusal(candidate.agent.name, candidate.task.templateStep)) continue;
      // Readiness is server-owned. Even if an old/manual path materializes a
      // Run row for it, no model runner or merge executor may claim it; the
      // readiness worker consumes the TODO task row directly.
      if (isMergeReadinessStep(candidate.task.templateStep)) continue;
      const executionMode = executionModeFor(candidate.task.templateStep);
      // §D-P1 rule 3, symmetric and fail-closed: only the independently
      // authenticated merge-executor principal is offered an integrator run,
      // and it is offered nothing else. With `MERGE_EXECUTOR_RUNNER_IDS`
      // empty — the shipped default — or with `MERGE_EXECUTOR_TOKEN` unset or
      // aliased onto the runner token, no integrator run is claimable at all.
      if (!claimantMayTake(executionMode, claimantClass, body.runnerId, executorRunnerIds)) continue;
      // The backend circuit breaker tracks model-CLI health. A mechanical run
      // spawns no CLI, so an open CLI circuit is not evidence about it; the
      // `runner` on its row is an inert artifact of the sentinel Agent.
      if (executionMode === "agent") {
        const backend = await tx.runnerBackendState.findUnique({ where: { runner: candidate.runner } });
        if (readStoredCliAvailability(backend?.capabilities)?.available === false || backend?.circuitOpen) continue;
      }
      if (executionMode === "mechanical") {
        const targetBranch = candidate.task.targetBranch ?? candidate.repo.defaultBranch;
        // Serialize only the claim transition for one repository target. The
        // lock is transaction-scoped: the committed active Run is the durable
        // exclusion fact, while later work remains QUEUED. Different targets
        // take different keys and do not participate in one another's lock.
        const lockKey = `merge-integrator:${candidate.repoId}:${targetBranch}`;
        const [targetLock] = await tx.$queryRaw<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0)) AS "locked"
        `;
        if (targetLock?.locked !== true) continue;
        const activePeers = await tx.run.findMany({
          where: {
            id: { not: candidate.id },
            repoId: candidate.repoId,
            status: { in: activeRunStatuses },
            task: { targetBranch },
          },
          select: {
            task: { include: {
              templateStep: { include: { taskTemplate: { select: { name: true } } } },
            } },
          },
        });
        if (activePeers.some((peer) => taskIsIntegratorStep(peer.task))) continue;
      }
      const regressionRepairHandoff = await regressionRepairHandoffForClaim(tx, {
        taskId: candidate.task.id,
        projectId: candidate.projectId,
        repoId: candidate.repo.id,
        runId: candidate.id,
        runNumber: candidate.runNumber,
        branch: candidate.branch,
        outputKind: candidate.task.templateStep?.outputKind ?? null,
      });
      if (regressionRepairHandoff.status === "invalid") {
        const stopped = await tx.run.updateMany({
          where: { id: candidate.id, status: RunStatus.QUEUED, leaseGeneration: candidate.leaseGeneration },
          data: {
            status: RunStatus.FAILED,
            failureClass: FailureClass.TASK_FAILED,
            failureReason: regressionRepairHandoff.reason,
            retryable: false,
            endedAt: now,
          },
        });
        if (stopped.count === 1) {
          const parked = await writeTask(tx, candidate.task.id, async () => ({
            update: { status: TaskStatus.REVIEW, failureReason: regressionRepairHandoff.reason },
            activity: {
              actorType: "control-plane",
              body: `Fresh Regression Run stopped: ${regressionRepairHandoff.reason}`,
              metadata: {
                kind: MERGE_TAIL_KIND.repairResult,
                schemaVersion: 1,
                state: "handoff-invalid",
                runId: candidate.id,
                previousRunId: regressionRepairHandoff.previousRunId,
                reason: regressionRepairHandoff.reason,
              },
            },
            value: null,
          }));
          const sourceSession = await tx.session.findUnique({
            where: { runId: regressionRepairHandoff.previousRunId },
            select: { id: true },
          });
          await openMergeTailStopNotice(tx, {
            taskId: candidate.task.id,
            agentId: candidate.agentId,
            ...(sourceSession ? { sessionId: sourceSession.id } : {}),
            reason: regressionRepairHandoff.reason,
          });
          if (parked.ok && parked.chainLocked) return null;
        }
        continue;
      }
      const grants = [
        ...candidate.agent.environment.secrets,
        ...candidate.agent.secretGrants,
      ].filter(({ secret }) => !secret.disabledAt);
      const grantedEnvironmentVariables = new Set<string>();
      for (const { envVar } of grants) {
        if (["OPERATOR_TOKEN", "RUNNER_TOKEN", "AGENTOS_API_TOKEN", "AGENTOS_SESSION_TOKEN", "AGENTOS_FENCING_TOKEN"].includes(envVar)) {
          throw new Error(`Secret grant may not override reserved principal variable ${envVar}`);
        }
        if (grantedEnvironmentVariables.has(envVar)) throw new Error(`Duplicate effective secret envVar ${envVar}`);
        grantedEnvironmentVariables.add(envVar);
      }
      let implementationRange: Awaited<ReturnType<typeof pinnedImplementationRange>>;
      try {
        implementationRange = await pinnedImplementationRange(tx, candidate.task);
        if (implementationRange && implementationRange.implementationHeadSha !== candidate.targetBranch) {
          throw new PinnedRunTargetError(
            candidate.id,
            candidate.targetBranch,
            implementationRange.implementationHeadSha,
          );
        }
      } catch (error: unknown) {
        if (!isCandidateActivationFailure(error)) throw error;
        const reason = namedFailureReason(error);
        const stopped = await tx.run.updateMany({
          where: { id: candidate.id, status: RunStatus.QUEUED, leaseGeneration: candidate.leaseGeneration },
          data: {
            status: RunStatus.FAILED,
            failureClass: FailureClass.TASK_FAILED,
            failureReason: reason,
            retryable: false,
            endedAt: now,
          },
        });
        if (stopped.count === 1) {
          const parked = await writeTask(tx, candidate.task.id, async () => ({
            update: { status: TaskStatus.BACKLOG, failureReason: reason },
            activity: {
              actorType: "control-plane",
              body: `Queued run activation failed: ${reason}`,
              metadata: {
                runId: candidate.id,
                condition: "candidate-activation-failed",
                failureType: error.name,
                reason,
              },
            },
            value: null,
          }));
          const dedupeKey = `candidate-activation-failed:${candidate.id}`;
          await tx.inboxMessage.upsert({
            where: { dedupeKey },
            create: {
              from: "AGENT",
              agentId: candidate.agentId,
              taskId: candidate.task.id,
              kind: "TEXT",
              body: `Queued run activation failed and the task was parked in Backlog: ${reason}`,
              dedupeKey,
            },
            update: {},
          });
          if (parked.ok && parked.chainLocked) return null;
        }
        continue;
      }
      const generation = candidate.leaseGeneration + 1;
      const fencingToken = makeFencingToken(candidate.id, generation);
      const sessionCredential = issueSessionToken();
      const leaseExpiresAt = new Date(now.getTime() + body.leaseSeconds * 1000);
      const won = await tx.run.updateMany({
        where: { id: candidate.id, status: RunStatus.QUEUED, leaseGeneration: candidate.leaseGeneration },
        data: {
          status: RunStatus.CLAIMED,
          runnerId: body.runnerId,
          leaseGeneration: generation,
          fencingToken,
          heartbeatAt: now,
          lastProcessAliveAt: now,
          leaseExpiresAt,
          claimedAt: now,
          sessionTokenHash: sessionCredential.hash,
          sessionTokenExpiresAt: new Date(now.getTime() + candidate.maxDurationMin * 60_000),
          sessionTokenRevokedAt: null,
        },
      });
      if (won.count !== 1) continue;
      await lockTaskMutationRows(tx, candidate.task.id);
      const priorResume = candidate.session?.resumeInput && candidate.session.providerConversationId ? {
        providerConversationId: candidate.session.providerConversationId,
        input: candidate.session.resumeInput,
      } : null;
      const session = candidate.session ? await tx.session.update({
        where: { id: candidate.session.id },
        data: {
          executionStatus: SessionExecutionStatus.PROVISIONING,
          cleanupStatus: CleanupStatus.PENDING,
          requestedAt: now,
          endedAt: null,
          failureReason: null,
        },
      }) : await tx.session.create({ data: {
          runId: candidate.id,
          projectId: candidate.projectId,
          agentId: candidate.agentId,
          taskId: candidate.taskId,
          goalId: candidate.goalId,
          runner: candidate.runner,
          executionStatus: SessionExecutionStatus.PROVISIONING,
          maxDurationMin: candidate.maxDurationMin,
          stallTimeoutMin: candidate.stallTimeoutMin,
        } });
      const latestEvent = await tx.sessionEvent.aggregate({ where: { sessionId: session.id }, _max: { seq: true } });
      await tx.task.update({ where: { id: candidate.task.id }, data: { status: TaskStatus.DOING, failureReason: null } });
      await tx.taskActivity.create({
        data: {
          taskId: candidate.task.id,
          actorType: "runner",
          actorId: body.runnerId,
          body: `Run ${candidate.runNumber} claimed with fencing generation ${generation}`,
        },
      });
      const secrets: Record<string, string> = {};
      for (const { envVar, secret } of grants) {
        secrets[envVar] = decryptSecret(secret.encryptedValue, secret.ciphertextVersion);
      }
      const run = await tx.run.findUniqueOrThrow({ where: { id: candidate.id } });
      const previousRunHandoff = await previousRunHandoffForClaim(tx, {
        taskId: candidate.task.id,
        runId: candidate.id,
        runNumber: candidate.runNumber,
        templateStep: candidate.task.templateStep,
      });
      const chainFirstRun = candidate.task.chainId && candidate.task.chainIndex !== null
        ? await tx.run.findFirst({
          where: {
            repoId: candidate.repo.id,
            task: {
              projectId: candidate.task.projectId,
              chainId: candidate.task.chainId,
              chainIndex: { not: null },
            },
          },
          select: { targetBranch: true },
          orderBy: [{ task: { chainIndex: "asc" } }, { runNumber: "asc" }],
        })
        : null;
      const blindReviewTask = isCanonicalBlindFindingsStep(candidate.task.templateStep);
      const priorOutputsRaw = !blindReviewTask
        && candidate.task.chainId && candidate.task.chainIndex !== null
        && (candidate.task.templateStepId === null || candidate.task.templateStep?.attachmentsFromPrevious !== false)
        ? await tx.taskStepOutput.findMany({
          where: { task: {
            projectId: candidate.task.projectId,
            chainId: candidate.task.chainId,
            chainIndex: { lt: candidate.task.chainIndex },
          } },
          select: { kind: true, body: true, task: { select: { name: true, chainIndex: true } } },
          orderBy: { task: { chainIndex: "asc" } },
        })
        : [];
      // Persisted outputs are chain authority, not activity previews. A
      // silent tail slice can remove schemas, state machines, and approval
      // assumptions while still presenting the remainder as complete. The
      // write endpoint already caps each artifact at 500k; pass the durable
      // body verbatim until artifact references replace prompt embedding.
      const priorOutputs = priorOutputsRaw;
      const targetBranchPublished = run.targetBranch !== null && await tx.run.findFirst({
        where: {
          repoId: candidate.repo.id,
          pushedBranch: run.targetBranch,
          task: candidate.task.chainId && candidate.task.chainIndex !== null
            ? {
              projectId: candidate.task.projectId,
              chainId: candidate.task.chainId,
              chainIndex: { not: null },
            }
            : { id: candidate.task.id },
        },
        select: { id: true },
      }) !== null;
      return {
        task: candidate.task,
        agent: candidate.agent,
        repo: candidate.repo,
        // Server-computed from the template step. Nothing a client sends
        // participates, and the ordinary runner refuses `mechanical` before it
        // constructs a workspace, a prompt, or a child environment.
        executionMode,
        // A later chain run targets the shared head, so its own targetBranch
        // cannot tell delivery which integration line the chain started
        // from. Carry the first run's durable base separately for PR create.
        run: {
          ...run,
          targetBranchPublished,
          pullRequestBase: chainFirstRun?.targetBranch ?? candidate.repo.defaultBranch,
          pinnedBaseSha: candidate.task.templateStep?.baseFromStepIndex == null ? null : run.targetBranch,
          implementationBaseSha: implementationRange?.implementationBaseSha ?? null,
          implementationHeadSha: implementationRange?.implementationHeadSha ?? null,
        },
        session,
        runner: candidate.runner,
        fencingToken,
        sessionToken: sessionCredential.token,
        secrets,
        priorOutputs,
        previousRunHandoff,
        regressionRepairHandoff: regressionRepairHandoff.status === "ok"
          ? regressionRepairHandoff.handoff
          : null,
        resume: priorResume,
        nextEventSeq: (latestEvent._max.seq ?? -1) + 1,
      };
    }
    return null;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  let claimed: Awaited<ReturnType<typeof claimOnce>> = null;
  // Two runners claiming independent chains still touch the same Task pages
  // through the `FOR UPDATE` chain mutex, and Serializable can abort either
  // one on a read/write dependency it cannot order. Losing that race is not a
  // claim failure -- the work is still queued -- so retry the whole
  // transaction. Matching only P2034 missed the raw-statement half, which
  // arrives as P2010 carrying SQLSTATE 40001, and that escaped as a 500.
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      claimed = await claimOnce();
      break;
    } catch (error: unknown) {
      if (!isSerializationConflict(error) || attempt === 6) throw error;
      await serializationRetryDelay(attempt);
    }
  }
  return claimed;
};

export type ClaimedRun = NonNullable<Awaited<ReturnType<typeof claimRun>>>;
