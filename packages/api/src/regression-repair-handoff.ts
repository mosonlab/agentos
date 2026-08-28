import {
  asJsonObject,
  isRegressionVerificationOutputKind,
  MERGE_TAIL_KIND,
  parseRegressionVerdict,
  Prisma,
  PushStatus,
  type RegressionRepairHandoff,
  RunStatus,
  TaskStatus,
} from "@anneal/db";

type DbTx = Prisma.TransactionClient;
type RegressionRepairKind = RegressionRepairHandoff["repair"]["kind"];

export type RegressionRepairHandoffSelection =
  | { status: "none" }
  | { status: "invalid"; reason: string; previousRunId: string }
  | { status: "ok"; handoff: RegressionRepairHandoff };

const EXACT_SHA = /^[0-9a-f]{40}$/u;

/**
 * Selects the durable evidence that crosses into a fresh Regression Session:
 * the prior negative Regression verdict, and the repair that answered it. The
 * trigger stays explicit so the new verifier does not have to infer why the
 * repair exists.
 */
export const regressionRepairHandoffForClaim = async (
  tx: DbTx,
  input: {
    taskId: string;
    projectId: string;
    repoId: string;
    runId: string;
    runNumber: number;
    branch: string | null;
    outputKind: string | null;
  },
): Promise<RegressionRepairHandoffSelection> => {
  if (!isRegressionVerificationOutputKind(input.outputKind)) return { status: "none" };
  const priorOutput = await tx.taskStepOutput.findUnique({
    where: { taskId: input.taskId },
    select: { body: true, runId: true, updatedAt: true },
  });
  if (!priorOutput?.runId || priorOutput.runId === input.runId) return { status: "none" };
  const parsed = parseRegressionVerdict(priorOutput.body, input.outputKind);
  if (parsed.status === "invalid") return { status: "none" };
  const invalid = (reason: string): RegressionRepairHandoffSelection => ({
    status: "invalid",
    previousRunId: priorOutput.runId!,
    reason: `regression repair handoff is invalid: ${reason}`,
  });

  // A PASS opens no repair task, so a fresh Session has nothing to inherit.
  if (parsed.verdict.outcome === "pass") return { status: "none" };

  const repairKind: RegressionRepairKind = parsed.verdict.outcome === "review-fail"
    ? "review-fix"
    : parsed.verdict.outcome === "gate-fail" ? "gate-fix" : "refresh-conflict";
  const trigger: RegressionRepairHandoff["trigger"] = {
    kind: "regression-verdict",
    verdict: parsed.verdict,
  };
  const evidenceAt = priorOutput.updatedAt;

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
          updatedAt: true,
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
  const retryRun = await tx.run.findFirst({
    where: {
      taskId: input.taskId,
      runNumber: { gt: 1, lt: input.runNumber },
      pushStatus: PushStatus.SUCCEEDED,
      pushedBranch: input.branch,
      headSha: { not: null },
      createdAt: { gte: output.updatedAt },
    },
    select: { id: true, headSha: true },
    orderBy: { runNumber: "desc" },
  });
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
      ...(retryRun?.headSha ? {
        retry: { previousRunId: retryRun.id, startHeadSha: retryRun.headSha },
      } : {}),
    },
  };
};
