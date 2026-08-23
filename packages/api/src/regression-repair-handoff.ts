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
 * Selects the only evidence that may cross the fresh-session boundary after an
 * automatic regression repair. Activities are accepted only from the control
 * plane, then rebound to the persisted repair output, successful Run and exact
 * published branch. The model receives the resulting projection as evidence;
 * it never inherits either provider conversation.
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
  if (parsed.status === "invalid" || parsed.verdict.outcome === "pass") return { status: "none" };
  const verdict = parsed.verdict;
  const repairKind: RegressionRepairKind = verdict.outcome === "review-fail"
    ? "review-fix"
    : verdict.outcome === "gate-fail" ? "gate-fix" : "refresh-conflict";
  const invalid = (reason: string): RegressionRepairHandoffSelection => ({
    status: "invalid",
    previousRunId: priorOutput.runId!,
    reason: `regression repair handoff is invalid: ${reason}`,
  });

  const resultRows = await tx.taskActivity.findMany({
    where: {
      taskId: input.taskId,
      actorType: "control-plane",
      metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.repairResult },
      createdAt: { gte: priorOutput.updatedAt },
    },
    select: { metadata: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 20,
  });
  const result = resultRows.map((row) => asJsonObject(row.metadata)).find((metadata) => (
    metadata?.repairKind === repairKind
    && metadata.startHeadSha === verdict.headSha
    && metadata.targetHeadSha === verdict.baseHeadSha
    && metadata.state === undefined
  ));
  if (!result) return invalid(`no successful ${repairKind} result binds ${verdict.headSha} to ${verdict.baseHeadSha}`);
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
  const previousVerdict: RegressionRepairHandoff["previousVerdict"] = verdict.outcome === "gate-fail"
    ? {
      schemaVersion: 1,
      outcome: verdict.outcome,
      headSha: verdict.headSha,
      baseHeadSha: verdict.baseHeadSha,
      gateVerdict: "FAIL",
      summary: verdict.summary,
    }
    : {
      schemaVersion: 1,
      outcome: verdict.outcome,
      headSha: verdict.headSha,
      baseHeadSha: verdict.baseHeadSha,
      summary: verdict.summary,
    };
  return {
    status: "ok",
    handoff: {
      schemaVersion: 1,
      previousVerdict,
      repair: {
        kind: repairKind,
        taskId: repairTaskId,
        startHeadSha: verdict.headSha,
        targetHeadSha: verdict.baseHeadSha,
        resolvedHeadSha,
        outputKind: output.kind,
        outputBody: output.body,
      },
    },
  };
};
