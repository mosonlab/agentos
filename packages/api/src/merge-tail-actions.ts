import { createHash } from "node:crypto";

import {
  AUTHORITY_RESIGN_DEDUPE_PREFIX,
  AUTHORITY_RESIGN_OPEN_PREFIX,
  enqueueTaskRun,
  type IndependentReviewFinding,
  lockAgentRepoGrant,
  lockAgentRow,
  MAX_AUTHORITY_RESIGN_ROUNDS,
  MAX_MERGE_TAIL_REPAIR_ATTEMPTS,
  MergeRecoveryStatus,
  parseRegressionVerdict,
  Prisma,
  readMarkerHistory,
  type RecoveryContext,
  recoveryContext,
  RELEASE_AUTHORITY_FILE,
  TaskStatus,
  writeMarker,
} from "@agentos/db";

import { FAILURE_REASON_LIMIT, truncateFailureReason } from "./failure-reason.js";

/**
 * The autonomous merge tail's own actions: the base-drift recovery aggregate,
 * the repair and follow-up cards it opens, the notices it writes when it stops,
 * and the regression completion that decides between them.
 *
 * They live here rather than in `app.ts` because both `run-completion.ts` and
 * `app.ts` call them, and importing them back out of `app.ts` would be a cycle.
 */

type DbTx = Prisma.TransactionClient;

/**
 * The notice the tail writes when it stops, keyed by task and reason.
 *
 * Stopping twice for the same reason is a legitimate event: an operator retry
 * re-queues the run, the claim path judges the same handoff invalid again, and
 * the stop path runs again. Under `create` that repeat raised P2002 inside the
 * caller's transaction, which rolled the whole stop back -- and in the claim
 * path took every other queued run's claim down with it. The notice is a
 * digest, not a log: one row per (task, reason) is the intended state, so a
 * repeat leaves the existing row alone.
 */
export const openMergeTailStopNotice = async (
  tx: DbTx,
  input: { taskId: string; agentId: string; sessionId?: string; reason: string },
): Promise<void> => {
  const dedupeKey = `merge-tail-stop:${input.taskId}:${createHash("sha256").update(input.reason).digest("hex")}`;
  await tx.inboxMessage.upsert({ where: { dedupeKey }, create: {
    from: "AGENT",
    agentId: input.agentId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    taskId: input.taskId,
    kind: "TEXT",
    body: `Autonomous merge tail stopped: ${input.reason}`,
    dedupeKey,
  }, update: {} });
};

export const baseDriftRecoveryContext = async (
  tx: DbTx,
  regressionTaskId: string,
  recoveryRunId?: string,
  sourceStopId?: string,
): Promise<RecoveryContext | null> => {
  const row = await tx.mergeRecoveryAttempt.findFirst({
    where: {
      regressionTaskId,
      status: { in: [MergeRecoveryStatus.REPAIRING, MergeRecoveryStatus.AWAITING_AUTHORIZATION] },
      ...(recoveryRunId ? { recoveryRunId } : {}),
      ...(sourceStopId ? { sourceStopId } : {}),
    },
    orderBy: [{ attempt: "desc" }, { id: "desc" }],
  });
  return recoveryContext(row);
};

export const stopBaseDriftRecoveryTail = async (
  tx: DbTx,
  context: RecoveryContext,
  phase: "regression" | "independent-review",
  reason: string,
): Promise<void> => {
  const body = `Automatic base-drift recovery ${context.attempt} stopped at ${phase}: ${reason}`;
  await tx.mergeRecoveryAttempt.update({ where: { id: context.aggregateId }, data: {
    status: MergeRecoveryStatus.BLOCKED_DOWNSTREAM,
    failureReason: reason,
    endedAt: new Date(),
  } });
  await tx.task.updateMany({
    where: { id: { in: [context.regressionTaskId, context.readinessTaskId, context.integratorTaskId] } },
    data: { status: TaskStatus.REVIEW, failureReason: body },
  });
  const dedupeKey = `merge-base-drift-recovery-tail-stop:${context.sourceStopId}:${phase}`;
  await tx.inboxMessage.upsert({ where: { dedupeKey }, create: {
    from: "AGENT", taskId: context.regressionTaskId, kind: "TEXT", body, dedupeKey,
  }, update: {} });
  const metadata = { ...context, state: "tail-stopped", phase, reason, dedupeKey };
  for (const taskId of [context.integratorTaskId, context.regressionTaskId]) {
    await writeMarker(tx, taskId, "baseDriftRecovery", { actorType: "control-plane", body, metadata });
  }
};

/**
 * Resolves the agent that repairs what this chain's independent review found:
 * the chain's own fix step assignee, or `senior-dev` when the chain has none.
 */
export const mergeTailFixAgentName = async (
  tx: DbTx,
  regression: { projectId: string; chainId: string | null; templateId: string | null } | null,
): Promise<string> => {
  if (!regression) return "senior-dev";
  const fixTask = await tx.task.findFirst({
    where: {
      projectId: regression.projectId,
      chainId: regression.chainId,
      templateId: regression.templateId,
      templateStep: { outputKind: "fixed-implementation" },
    },
    select: { assigneeAgent: { select: { name: true } } },
  });
  return fixTask?.assigneeAgent?.name ?? "senior-dev";
};

/**
 * Parks one follow-up finding as a backlog card.
 *
 * A follow-up is by contract not a reachable behavioural defect, so it never
 * holds the merge; the card is what keeps it from being lost instead.
 */
export const createReviewFollowUpCard = async (
  tx: DbTx,
  input: {
    projectId: string;
    repoId: string | null;
    agentName: string;
    reviewTaskId: string;
    headSha: string;
    finding: IndependentReviewFinding;
  },
): Promise<{ taskId: string } | { refusal: string }> => {
  if (!input.repoId) return { refusal: "independent review task has no repository" };
  const named = await tx.agent.findFirst({
    where: { projectId: input.projectId, name: input.agentName },
    select: { id: true },
  });
  if (!named) return { refusal: `follow-up agent ${input.agentName} is absent` };
  // A card assigned to an agent archived a moment later, or pointing at a
  // revoked grant, is a card nothing can ever run. Both facts are therefore
  // taken under the same mutexes the archive and revoke paths take.
  const agent = await lockAgentRow(tx, named.id);
  if (!agent || agent.archivedAt) return { refusal: `follow-up agent ${input.agentName} is absent or archived` };
  const grant = await lockAgentRepoGrant(tx, {
    projectId: input.projectId, agentId: agent.id, repoId: input.repoId,
  });
  if (!grant) return { refusal: `follow-up agent ${input.agentName} has no repository grant` };
  const task = await tx.task.create({ data: {
    projectId: input.projectId,
    repoId: input.repoId,
    name: `Merge tail follow-up: ${input.finding.title}`,
    description: [
      input.finding.detail,
      `Raised as a follow-up by the autonomous merge tail independent review ${input.reviewTaskId} at exact head ${input.headSha}. It did not block that merge.`,
    ].join("\n\n"),
    assigneeType: "AGENT",
    assigneeAgentId: agent.id,
    approvalGate: false,
    opensPullRequest: false,
    status: TaskStatus.BACKLOG,
  } });
  await writeMarker(tx, task.id, "reviewObligation", {
    actorType: "control-plane",
    body: `Follow-up finding from independent review ${input.reviewTaskId} at ${input.headSha}`,
    metadata: {
      state: "follow-up",
      reviewTaskId: input.reviewTaskId,
      headSha: input.headSha,
      title: input.finding.title,
    },
  });
  return { taskId: task.id };
};

/**
 * The one operator action the autonomous merge tail asks for, and the reason it
 * cannot ask an agent instead: `release-authority.json` is signed with a key
 * that lives outside every checkout, so a chain that moves an attested
 * release-path file can only be unblocked by whoever holds it.
 *
 * The message is written to be run, not interpreted: the two recorded SHAs come
 * out of the attestation already in the checkout, so nothing here has to be
 * filled in by hand. Nothing else in the chain is blocked while it waits, and
 * the resign worker resumes this step on its own once the signature is pushed.
 */
/**
 * A branch name may legally contain `$`, a backtick or a semicolon, and this
 * message is written to be pasted into a shell that will be holding the release
 * signing key. Every interpolated value is quoted, including the embedded single
 * quote a refname may also carry.
 */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export const openAuthorityResignNotice = async (
  tx: DbTx,
  input: {
    taskId: string;
    agentId: string;
    sessionId?: string;
    branch: string;
    headSha: string;
    summary: string;
    round: number;
  },
): Promise<void> => {
  const body = [
    `Autonomous merge tail: ${RELEASE_AUTHORITY_FILE} must be re-signed before this chain can merge.`,
    `Branch ${input.branch} moved attested release-path files at head ${input.headSha}, so the migration preflight refuses this tree and the merge gate cannot pass. The signing key never enters a chain, so this is yours to run (request ${input.round} of ${MAX_AUTHORITY_RESIGN_ROUNDS}).`,
    `What moved:\n${input.summary}`,
    [
      "Run this in the checkout that holds the private revalidation document, with the signing key at hand:",
      "",
      `  git fetch origin ${shellQuote(input.branch)}`,
      `  git switch --detach ${shellQuote(input.headSha)}`,
      "  RELEASE_AUTHORITY_KEY=~/.agentos-keys/release-authority.ed25519 \\",
      `  GOAL5A0_MASTER_SHA="$(node -p "require('./${RELEASE_AUTHORITY_FILE}').masterSha")" \\`,
      `  GOAL5A0_CONTROL_PLANE_A_SHA="$(node -p "require('./${RELEASE_AUTHORITY_FILE}').controlPlaneASha")" \\`,
      "    npm run snapshot:authority",
      `  npm run db:authority-check -w @agentos/db`,
      `  git add ${RELEASE_AUTHORITY_FILE}`,
      `  git commit -m ${shellQuote(`chore(release): re-sign the release authority for ${input.branch}`)}`,
      `  git push origin ${shellQuote(`HEAD:${input.branch}`)}`,
    ].join("\n"),
    `Nothing else is needed. The server watches the pull request and re-runs regression verification as soon as the re-signed ${RELEASE_AUTHORITY_FILE} is on ${input.branch}.`,
  ].join("\n\n");
  await tx.inboxMessage.upsert({
    where: { dedupeKey: `${AUTHORITY_RESIGN_DEDUPE_PREFIX}${input.taskId}:${input.headSha}` },
    create: {
      from: "AGENT",
      agentId: input.agentId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      taskId: input.taskId,
      kind: "TEXT",
      body,
      dedupeKey: `${AUTHORITY_RESIGN_DEDUPE_PREFIX}${input.taskId}:${input.headSha}`,
    },
    update: {},
  });
};

export const createMergeTailRepairTask = async (
  tx: DbTx,
  input: {
    regressionTask: { id: string; projectId: string; repoId: string | null; templateId: string | null; chainId: string | null; chainIndex: number | null; targetBranch: string | null };
    sourceRun: { id: string; branch: string | null };
    agentName: string;
    repairKind: "refresh-conflict" | "gate-fix" | "review-fix";
    headSha: string;
    baseHeadSha: string;
    summary: string;
    now: Date;
  },
): Promise<{ taskId: string } | { refusal: string }> => {
  const { regressionTask } = input;
  if (
    !regressionTask.repoId || !regressionTask.chainId || regressionTask.chainIndex === null
    || !regressionTask.templateId || !input.sourceRun.branch
  ) {
    return { refusal: "repair task cannot resolve its chain position, repository, and shared branch" };
  }
  const agent = await tx.agent.findFirst({
    where: { projectId: regressionTask.projectId, name: input.agentName, archivedAt: null },
  });
  if (!agent) return { refusal: `required repair agent ${input.agentName} is absent or archived` };
  const grant = await tx.agentRepoAccess.findFirst({
    where: { projectId: regressionTask.projectId, agentId: agent.id, repoId: regressionTask.repoId },
  });
  if (!grant) return { refusal: `required repair agent ${input.agentName} has no repository grant` };

  // A repair task is deliberately chain-detached, so the claim path's own
  // prior-output lookup (which keys off chainId and chainIndex) never fires for
  // it. Without this the repair agent sees only the verdict summary and no
  // Feature brief, acceptance criteria, or review reports, and the narrowest
  // reading of that summary is the whole job it can do. Same query, ordering,
  // and rendering as a chain step's: what the chain steps could see, the repair
  // for those steps sees too.
  const priorOutputs = await tx.taskStepOutput.findMany({
    where: { task: {
      projectId: regressionTask.projectId,
      chainId: regressionTask.chainId,
      chainIndex: { lt: regressionTask.chainIndex },
    } },
    select: { kind: true, body: true, task: { select: { name: true, chainIndex: true } } },
    orderBy: { task: { chainIndex: "asc" } },
  });
  const chainContext = priorOutputs.length > 0
    ? [
      "Persisted outputs from prior template steps:",
      ...priorOutputs.map((output) => `## ${output.task.name} (${output.kind})\n${output.body}`),
    ].join("\n\n")
    : null;
  const prompt = [
    ...(input.repairKind === "refresh-conflict"
      ? [
        `Resolve the refresh conflict between chain head ${input.headSha} and target head ${input.baseHeadSha}.`,
        input.summary,
        `Re-run the merge, preserve both intents under the merge-resolver role contract, commit the resolution, and persist the role's versioned JSON bound to start ${input.headSha} and target ${input.baseHeadSha}.`,
      ]
      : [
        `Repair the autonomous merge tail failure at ${input.headSha} against target ${input.baseHeadSha}.`,
        input.summary,
        "Make exactly the changes needed to close this failure, run affected suites, commit, and persist the result as task output. Before changing any shared type, schema, or route contract, enumerate its callers across every workspace, including apps/web, and update or test each one in the same change.",
      ]),
    ...(chainContext ? [chainContext] : []),
  ].join("\n\n");
  const task = await tx.task.create({ data: {
    projectId: regressionTask.projectId,
    repoId: regressionTask.repoId,
    name: `Autonomous merge tail: ${input.repairKind}`,
    description: prompt,
    assigneeType: "AGENT",
    assigneeAgentId: agent.id,
    approvalGate: false,
    opensPullRequest: false,
    status: TaskStatus.TODO,
    targetBranch: input.sourceRun.branch,
    maxSessionsPerTask: 1,
  } });
  const repairRun = await enqueueTaskRun(tx, task.id, input.now);
  await tx.run.update({
    where: { id: repairRun.id },
    data: { branch: input.sourceRun.branch, targetBranch: input.sourceRun.branch },
  });
  await writeMarker(tx, regressionTask.id, "repairAttempt", {
    actorType: "control-plane",
    body: `Automatic ${input.repairKind} attempt queued at chain head ${input.headSha} against ${input.baseHeadSha}`,
    metadata: {
      repairKind: input.repairKind,
      repairTaskId: task.id,
      headSha: input.headSha,
      baseHeadSha: input.baseHeadSha,
    },
  });
  await writeMarker(tx, task.id, "repairAttempt", {
    actorType: "control-plane",
    body: `Automatic ${input.repairKind} attempt for regression task ${regressionTask.id}`,
    metadata: {
      repairKind: input.repairKind,
      regressionTaskId: regressionTask.id,
      headSha: input.headSha,
      baseHeadSha: input.baseHeadSha,
    },
  });
  await tx.task.update({
    where: { id: regressionTask.id },
    data: { status: TaskStatus.REVIEW, failureReason: `${input.repairKind}: automatic repair ${task.id} queued at ${input.headSha}` },
  });
  return { taskId: task.id };
};

export const handleRegressionCompletion = async (
  tx: DbTx,
  input: {
    task: { id: string; projectId: string; repoId: string | null; templateId: string | null; chainId: string | null; chainIndex: number | null; targetBranch: string | null };
    run: { id: string; agentId: string; branch: string | null; headSha: string | null; sessionId: string };
    now: Date;
  },
): Promise<"advance" | "handled"> => {
  const persistedOutput = await tx.taskStepOutput.findUnique({ where: { taskId: input.task.id } });
  // Regression evidence is run-scoped even though TaskStepOutput is not yet.
  // An earlier attempt's explicit verdict is not this attempt's output and must
  // not be reused when the current agent finishes without calling task_output.
  const output = persistedOutput?.runId === input.run.id ? persistedOutput : null;
  const recovery = await baseDriftRecoveryContext(tx, input.task.id, input.run.id);
  const parsed = parseRegressionVerdict(output?.body);
  const stop = async (reason: string): Promise<"handled"> => {
    if (recovery) {
      await stopBaseDriftRecoveryTail(tx, recovery, "regression", reason);
      return "handled";
    }
    await tx.task.update({ where: { id: input.task.id }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
    await writeMarker(tx, input.task.id, "regression", {
      actorType: "control-plane",
      body: `Regression did not advance: ${reason}`,
      metadata: { state: "stopped", reason },
    });
    await openMergeTailStopNotice(tx, { taskId: input.task.id, agentId: input.run.agentId, sessionId: input.run.sessionId, reason });
    return "handled";
  };
  if (parsed.status === "invalid") return stop(parsed.reason);
  const verdict = parsed.verdict;
  const effectiveHead = input.run.headSha ?? output?.commitSha ?? null;
  if (effectiveHead !== verdict.headSha || output?.commitSha !== verdict.headSha) {
    return stop(`stale regression evidence: verdict ${verdict.headSha}, output ${output?.commitSha ?? "missing"}, run ${effectiveHead ?? "missing"}`);
  }
  await writeMarker(tx, input.task.id, "regression", {
    actorType: "control-plane",
    body: `Regression ${verdict.outcome} recorded for chain head ${verdict.headSha} against target ${verdict.baseHeadSha}`,
    metadata: { ...verdict },
  });
  if (verdict.outcome === "pass") {
    if (recovery) {
      await tx.mergeRecoveryAttempt.update({ where: { id: recovery.aggregateId }, data: {
        status: MergeRecoveryStatus.AWAITING_AUTHORIZATION,
        failureReason: null,
      } });
    }
    return "advance";
  }

  if (verdict.outcome === "authority-resign") {
    // Rounds are counted from the notices this function itself wrote, not from
    // the activity log: `actorType` and `metadata` are caller-supplied on the
    // activity route, and an inbox `dedupeKey` is written nowhere else. The
    // bound is anti-thrash — a repeat means the last signature did not cover
    // this tree, and a chain that keeps asking is not progressing.
    const round = await tx.inboxMessage.count({
      where: { taskId: input.task.id, dedupeKey: { startsWith: `${AUTHORITY_RESIGN_DEDUPE_PREFIX}${input.task.id}:` } },
    }) + 1;
    const exhausted = round > MAX_AUTHORITY_RESIGN_ROUNDS;
    const branch = input.run.branch;
    if (exhausted || !branch) {
      const reason = exhausted
        ? `release authority re-signature round ${round} exceeds ${MAX_AUTHORITY_RESIGN_ROUNDS} at ${verdict.headSha}: ${verdict.summary}`
        : `release authority re-signature is required at ${verdict.headSha} but this run names no chain branch`;
      const bounded = truncateFailureReason(reason, FAILURE_REASON_LIMIT);
      if (recovery) {
        await stopBaseDriftRecoveryTail(tx, recovery, "regression", bounded);
        return "handled";
      }
      return stop(bounded);
    }
    // A step an operator has already taken over is not re-parked under it: the
    // completion holds the chain mutex only from here, so the row is claimed
    // rather than overwritten.
    const parked = await tx.task.updateMany({
      where: { id: input.task.id, status: { in: [TaskStatus.TODO, TaskStatus.DOING] } },
      data: { status: TaskStatus.REVIEW, failureReason: `${AUTHORITY_RESIGN_OPEN_PREFIX}${verdict.headSha}` },
    });
    if (parked.count !== 1) {
      await writeMarker(tx, input.task.id, "authorityResign", {
        actorType: "control-plane",
        body: `Release authority re-signature is required at ${verdict.headSha} but this step is no longer the tail's to park`,
        metadata: {
          state: "park-skipped",
          headSha: verdict.headSha,
          summary: verdict.summary,
        },
      });
      return "handled";
    }
    await writeMarker(tx, input.task.id, "authorityResign", {
      actorType: "control-plane",
      body: `Release authority re-signature requested at ${verdict.headSha}: ${verdict.summary}`,
      metadata: {
        state: "open",
        headSha: verdict.headSha,
        baseHeadSha: verdict.baseHeadSha,
        branch,
        round,
        summary: verdict.summary,
      },
    });
    await openAuthorityResignNotice(tx, {
      taskId: input.task.id,
      agentId: input.run.agentId,
      sessionId: input.run.sessionId,
      branch,
      headSha: verdict.headSha,
      summary: verdict.summary,
      round,
    });
    // A base-drift recovery that reaches this needs the same signature as any
    // other chain, and the resign worker resumes the same step for it. The
    // recovery aggregate keeps its own state; nothing about it is decided here.
    return "handled";
  }

  if (recovery) {
    await stopBaseDriftRecoveryTail(
      tx,
      recovery,
      "regression",
      truncateFailureReason(
        verdict.outcome === "refresh-conflict"
          ? `refresh conflict at ${verdict.headSha} against ${verdict.baseHeadSha}: ${verdict.summary}`
          : verdict.outcome === "review-fail"
            ? `semantic regression FAIL at ${verdict.headSha} against ${verdict.baseHeadSha}: ${verdict.summary}`
            : `merge gate FAIL at ${verdict.headSha} against ${verdict.baseHeadSha}: ${verdict.summary}`,
        FAILURE_REASON_LIMIT,
      ),
    );
    return "handled";
  }

  // The whole history, not the recent-state window: the automatic attempt
  // budget per repair kind is the rule, and an attempt pushed past the window
  // by later activity would license an extra one. The count includes the
  // review-fix repairs the independent-review rejection path opened on this
  // task, which is what makes a chain that has already been repaired reach this
  // ceiling sooner; that path keeps its own separate round ceiling.
  const attempts = await readMarkerHistory(tx, input.task.id);
  const repairKind = verdict.outcome === "refresh-conflict"
    ? "refresh-conflict"
    : verdict.outcome === "review-fail" ? "review-fix" : "gate-fix";
  const priorAttempts = attempts.filter((marker) => (
    marker.kind === "repairAttempt"
    && marker.repairKind === repairKind
    && (repairKind !== "refresh-conflict" || marker.headSha === verdict.headSha)
  )).length;
  // A refresh conflict is a merge of two fixed trees: a second resolver run on
  // the same head has nothing new to work with. A semantic or gate FAIL does —
  // the first repair moved the tree, and the verdict it now fails on is a
  // different one — so those get a second attempt before the tail stops.
  const attemptLimit = repairKind === "refresh-conflict" ? 1 : MAX_MERGE_TAIL_REPAIR_ATTEMPTS;
  if (priorAttempts >= attemptLimit) {
    return stop(repairKind === "refresh-conflict"
      ? `second refresh conflict on chain head ${verdict.headSha}`
      : repairKind === "review-fix"
        ? `semantic regression FAIL on chain head ${verdict.headSha} after ${priorAttempts} automatic repair attempts`
        : `merge gate FAIL on chain head ${verdict.headSha} after ${priorAttempts} automatic repair attempts`);
  }
  let agentName = "merge-resolver";
  if (repairKind === "gate-fix" || repairKind === "review-fix") {
    const fixTask = await tx.task.findFirst({
      where: {
        projectId: input.task.projectId,
        chainId: input.task.chainId,
        templateId: input.task.templateId,
        templateStep: { outputKind: "fixed-implementation" },
      },
      select: { assigneeAgent: { select: { name: true } } },
    });
    agentName = fixTask?.assigneeAgent?.name ?? "senior-dev";
  }
  const repair = await createMergeTailRepairTask(tx, {
    regressionTask: input.task,
    sourceRun: input.run,
    agentName,
    repairKind,
    headSha: verdict.headSha,
    baseHeadSha: verdict.baseHeadSha,
    summary: verdict.summary,
    now: input.now,
  });
  if ("refusal" in repair) return stop(repair.refusal);
  return "handled";
};
