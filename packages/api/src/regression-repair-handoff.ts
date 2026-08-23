import {
  asJsonObject,
  MERGE_TAIL_KIND,
  parseRegressionVerdict,
  Prisma,
  PushStatus,
  type RegressionRepairHandoff,
  RunStatus,
  TaskStatus,
} from "@agentos/db";

type DbTx = Prisma.TransactionClient;
type RegressionRepairKind = RegressionRepairHandoff["repair"]["kind"];

export type RegressionRepairHandoffSelection =
  | { status: "none" }
  | { status: "invalid"; reason: string; previousRunId: string }
  | { status: "ok"; handoff: RegressionRepairHandoff };

const EXACT_SHA = /^[0-9a-f]{40}$/u;

/**
 * Selects the durable evidence that crosses into a fresh Regression Session.
 * A prior negative Regression verdict and a later independent-review rejection
 * share the same repair binding, but the trigger remains explicit so the new
 * verifier does not have to infer why the repair exists.
 */
export const regressionRepairHandoffForClaim = async (
  tx: DbTx,
  input: {
    taskId: string;
    projectId: string;
    repoId: string;
    runId: string;
    branch: string | null;
    outputKind: string | null;
  },
): Promise<RegressionRepairHandoffSelection> => {
  if (input.outputKind !== "regression-verification") return { status: "none" };
  const priorOutput = await tx.taskStepOutput.findUnique({
    where: { taskId: input.taskId },
    select: { body: true, runId: true, updatedAt: true },
  });
  if (!priorOutput?.runId || priorOutput.runId === input.runId) return { status: "none" };
  const parsed = parseRegressionVerdict(priorOutput.body);
  if (parsed.status === "invalid") return { status: "none" };
  const invalid = (reason: string): RegressionRepairHandoffSelection => ({
    status: "invalid",
    previousRunId: priorOutput.runId!,
    reason: `regression repair handoff is invalid: ${reason}`,
  });

  let trigger: RegressionRepairHandoff["trigger"];
  let repairKind: RegressionRepairKind;
  let evidenceAt = priorOutput.updatedAt;
  if (parsed.verdict.outcome !== "pass") {
    repairKind = parsed.verdict.outcome === "review-fail"
      ? "review-fix"
      : parsed.verdict.outcome === "gate-fail" ? "gate-fix" : "refresh-conflict";
    trigger = { kind: "regression-verdict", verdict: parsed.verdict };
  } else {
    const regressionTask = await tx.task.findUnique({
      where: { id: input.taskId },
      select: { chainId: true, templateId: true },
    });
    if (!regressionTask?.chainId || !regressionTask.templateId) return { status: "none" };
    const readinessTask = await tx.task.findFirst({
      where: {
        projectId: input.projectId,
        chainId: regressionTask.chainId,
        templateId: regressionTask.templateId,
        templateStep: { outputKind: "merge-authorization" },
      },
      select: { id: true },
    });
    if (!readinessTask) return { status: "none" };
    const reviewRows = await tx.taskActivity.findMany({
      where: {
        taskId: readinessTask.id,
        actorType: "control-plane",
        createdAt: { gte: priorOutput.updatedAt },
        metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.reviewObligation },
      },
      select: { id: true, createdAt: true, metadata: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
    });
    const rejectedRow = reviewRows.find((row) => {
      const metadata = asJsonObject(row.metadata);
      return metadata?.state === "rejected" && metadata.headSha === parsed.verdict.headSha;
    });
    if (!rejectedRow) return { status: "none" };
    const rejected = asJsonObject(rejectedRow.metadata)!;
    const reviewTaskId = typeof rejected.reviewTaskId === "string" ? rejected.reviewTaskId : null;
    const summary = typeof rejected.summary === "string" ? rejected.summary : null;
    const open = reviewRows.map((row) => asJsonObject(row.metadata)).find((metadata) => (
      metadata?.state === "open"
      && metadata.reviewTaskId === reviewTaskId
      && metadata.headSha === parsed.verdict.headSha
    ));
    const baseHeadSha = typeof rejected.baseSha === "string"
      ? rejected.baseSha
      : typeof open?.baseSha === "string" ? open.baseSha : null;
    if (!reviewTaskId || !summary || baseHeadSha !== parsed.verdict.baseHeadSha) {
      return invalid("independent-review rejection lacks an exact task, summary, or Regression-bound base/head");
    }
    const reviewTask = await tx.task.findFirst({
      where: { id: reviewTaskId, projectId: input.projectId, repoId: input.repoId, status: TaskStatus.DONE },
      select: {
        stepOutput: {
          select: {
            kind: true,
            body: true,
            commitSha: true,
            run: { select: { status: true, headSha: true } },
          },
        },
      },
    });
    const reviewOutput = reviewTask?.stepOutput;
    if (!reviewOutput?.run
      || reviewOutput.run.status !== RunStatus.SUCCEEDED
      || reviewOutput.commitSha !== parsed.verdict.headSha
      || reviewOutput.run.headSha !== parsed.verdict.headSha) {
      return invalid(`independent-review task ${reviewTaskId} is not bound to successful head ${parsed.verdict.headSha}`);
    }
    let decision: Record<string, unknown> | null = null;
    try { decision = asJsonObject(JSON.parse(reviewOutput.body) as Prisma.JsonValue); } catch { decision = null; }
    if (decision?.schemaVersion !== 1
      || decision.outcome !== "rejected"
      || decision.headSha !== parsed.verdict.headSha
      || decision.summary !== summary) {
      return invalid(`independent-review task ${reviewTaskId} output does not match its rejection record`);
    }
    const operatorRows = await tx.taskActivity.findMany({
      where: {
        taskId: input.taskId,
        actorType: "operator",
        createdAt: { gte: rejectedRow.createdAt },
        metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.operatorDecision },
      },
      select: { metadata: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20,
    });
    const adopted = operatorRows.map((row) => asJsonObject(row.metadata)).some((metadata) => (
      metadata?.action === "adopt-head"
      && metadata.headSha === parsed.verdict.headSha
      && metadata.baseHeadSha === parsed.verdict.baseHeadSha
      && metadata.reviewTaskId === reviewTaskId
    ));
    // Explicit operator adoption licenses one fresh exact-head Regression run;
    // it does not authorize readiness or merge. The fresh verdict must still
    // bind the head/base pair before the autonomous tail can continue.
    if (adopted) return { status: "none" };
    trigger = {
      kind: "independent-review-rejection",
      verdict: parsed.verdict,
      review: {
        taskId: reviewTaskId,
        headSha: parsed.verdict.headSha,
        baseHeadSha,
        summary,
        outputKind: reviewOutput.kind,
        outputBody: reviewOutput.body,
      },
    };
    repairKind = "review-fix";
    evidenceAt = rejectedRow.createdAt;
  }

  const expectedHeadSha = trigger.verdict.headSha;
  const expectedBaseHeadSha = trigger.verdict.baseHeadSha;
  const resultRows = await tx.taskActivity.findMany({
    where: {
      taskId: input.taskId,
      actorType: "control-plane",
      metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.repairResult },
      createdAt: { gte: evidenceAt },
    },
    select: { metadata: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 20,
  });
  const result = resultRows.map((row) => asJsonObject(row.metadata)).find((metadata) => (
    metadata?.repairKind === repairKind
    && metadata.startHeadSha === expectedHeadSha
    && metadata.targetHeadSha === expectedBaseHeadSha
    && metadata.state === undefined
  ));
  if (!result) return invalid(`no successful ${repairKind} result binds ${expectedHeadSha} to ${expectedBaseHeadSha}`);
  const repairTaskId = typeof result.repairTaskId === "string" ? result.repairTaskId : null;
  const resolvedHeadSha = typeof result.resolvedHeadSha === "string" ? result.resolvedHeadSha : null;
  if (!repairTaskId || !resolvedHeadSha || !EXACT_SHA.test(resolvedHeadSha)) {
    return invalid("repair result lacks its task id or exact resolved head");
  }
  if (!input.branch) return invalid("fresh Regression Run has no shared branch");

  const repairTask = await tx.task.findFirst({
    where: {
      id: repairTaskId,
      projectId: input.projectId,
      repoId: input.repoId,
      status: TaskStatus.DONE,
    },
    select: {
      stepOutput: {
        select: {
          kind: true,
          body: true,
          commitSha: true,
          run: { select: { status: true, headSha: true, pushedBranch: true, pushStatus: true } },
        },
      },
    },
  });
  const output = repairTask?.stepOutput;
  if (!output?.run) return invalid(`repair task ${repairTaskId} has no run-bound output`);
  if (output.commitSha !== resolvedHeadSha || output.run.headSha !== resolvedHeadSha) {
    return invalid(`repair task ${repairTaskId} output and Run do not bind resolved head ${resolvedHeadSha}`);
  }
  if (output.run.status !== RunStatus.SUCCEEDED
    || output.run.pushStatus !== PushStatus.SUCCEEDED
    || output.run.pushedBranch !== input.branch) {
    return invalid(`repair task ${repairTaskId} did not publish ${resolvedHeadSha} to ${input.branch}`);
  }
  return {
    status: "ok",
    handoff: {
      schemaVersion: 1,
      trigger,
      repair: {
        kind: repairKind,
        taskId: repairTaskId,
        startHeadSha: expectedHeadSha,
        targetHeadSha: expectedBaseHeadSha,
        resolvedHeadSha,
        outputKind: output.kind,
        outputBody: output.body,
      },
    },
  };
};
