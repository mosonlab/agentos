import {
  ACTIVE_RUN_STATUSES,
  DIRECT_TEMPLATE_NAME,
  INTEGRATOR_TEMPLATE_NAME,
  lockTaskRow,
  Prisma,
  type RunStatus,
  type TaskStepOutput,
} from "@agentos/db";
import { z } from "zod";

type DbTx = Prisma.TransactionClient;

export const BLIND_REVIEW_PHASE = {
  independent: "independent-findings",
  evidenceUnlocked: "predecessor-evidence-unlocked",
  closed: "closed-must-fix",
} as const;

type TemplateStepIdentity = {
  stepIndex?: number;
  outputKind: string;
  taskTemplate?: { name: string };
};

type CanonicalTemplateStepIdentity = TemplateStepIdentity & {
  stepIndex: number;
  taskTemplate: { name: string };
};

type OutputTask = {
  id: string;
};

export type PreviousRunHandoff = {
  schemaVersion: 1;
  previousRunId: string;
  status: RunStatus;
  failureReason: string | null;
  retryReason: "approval-rejected-without-feedback" | "automatic-retry" | "operator-retry" | "retry";
  output: {
    kind: string;
    body: string;
    commitSha: string | null;
  } | null;
};

export const isCanonicalAgentStep = (step: TemplateStepIdentity | null | undefined): step is CanonicalTemplateStepIdentity => {
  if (!step?.taskTemplate || step.stepIndex === undefined) return false;
  if (step.taskTemplate.name === DIRECT_TEMPLATE_NAME) return step.stepIndex >= 1 && step.stepIndex <= 5;
  if (step.taskTemplate.name === INTEGRATOR_TEMPLATE_NAME) return step.stepIndex >= 1 && step.stepIndex <= 10;
  return false;
};

export const isCanonicalBlindReviewStep = (step: TemplateStepIdentity | null | undefined): boolean => (
  step?.outputKind === "must-fix"
  && ((step.taskTemplate?.name === DIRECT_TEMPLATE_NAME && step.stepIndex === 3)
    || (step.taskTemplate?.name === INTEGRATOR_TEMPLATE_NAME && step.stepIndex === 7))
);

const metadataPhase = (metadata: Prisma.JsonValue | Prisma.InputJsonValue | undefined): string | null => {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const phase = (metadata as Record<string, unknown>).phase;
  return typeof phase === "string" ? phase : null;
};

const commitSha = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);
const nonEmptyString = z.string().trim().min(1);
const stringList = z.array(nonEmptyString);
const canonicalEnvelope = z.object({ schemaVersion: z.literal(1), headSha: commitSha });
const reviewFinding = z.object({
  id: nonEmptyString,
  severity: z.enum(["P0", "P1", "P2"]),
  file: nonEmptyString,
  line: z.number().int().positive(),
  title: nonEmptyString,
  evidence: nonEmptyString,
  requiredFix: nonEmptyString,
});
const reviewArtifact = canonicalEnvelope.extend({
  reviewedBase: commitSha,
  reviewedHead: commitSha,
  findings: z.array(reviewFinding),
});
const closedReviewArtifact = reviewArtifact.extend({
  dispositions: z.array(z.object({
    id: nonEmptyString,
    disposition: z.enum(["ADOPTED", "REJECTED", "MERGED"]),
    reason: nonEmptyString,
  })),
  mustFixIds: stringList,
});

const canonicalOutputSchemas: Record<string, z.ZodType> = {
  spec: canonicalEnvelope.extend({ spec: nonEmptyString }),
  plan: canonicalEnvelope.extend({ summary: nonEmptyString, sliceIds: stringList }),
  "plan-review": canonicalEnvelope.extend({ findings: z.array(reviewFinding) }),
  "revised-plan": canonicalEnvelope.extend({
    summary: nonEmptyString,
    addressedFindingIds: stringList,
    declinedFindings: z.array(z.object({ id: nonEmptyString, reason: nonEmptyString })),
  }),
  implementation: canonicalEnvelope.extend({
    baseSha: commitSha,
    summary: nonEmptyString,
    testsRun: stringList,
  }),
  "sol-findings": reviewArtifact.extend({ commandsRun: stringList }),
  "must-fix": reviewArtifact,
  "fixed-implementation": canonicalEnvelope.extend({
    sourceHead: commitSha,
    closedFindings: z.array(z.object({
      id: nonEmptyString,
      status: z.literal("CLOSED"),
      codeEvidence: nonEmptyString,
      testEvidence: nonEmptyString,
    })),
    testsRun: stringList,
    residualRisks: z.array(z.string()),
  }),
  "regression-verification": z.discriminatedUnion("outcome", [
    canonicalEnvelope.extend({
      outcome: z.literal("pass"),
      baseHeadSha: commitSha,
      gateVerdict: z.literal("PASS"),
    }),
    canonicalEnvelope.extend({
      outcome: z.literal("review-fail"),
      baseHeadSha: commitSha,
      summary: nonEmptyString,
    }),
    canonicalEnvelope.extend({
      outcome: z.literal("gate-fail"),
      baseHeadSha: commitSha,
      gateVerdict: z.literal("FAIL"),
      summary: nonEmptyString,
    }),
    canonicalEnvelope.extend({
      outcome: z.literal("refresh-conflict"),
      baseHeadSha: commitSha,
      summary: nonEmptyString,
    }),
  ]),
  documentation: canonicalEnvelope.extend({
    summary: nonEmptyString,
    changes: z.array(z.object({ path: nonEmptyString, action: z.enum(["ADDED", "UPDATED", "DELETED"]) })),
  }),
};

const canonicalBodyRefusal = (
  kind: string,
  body: string,
  authoredHead: string | null,
  phase: string | null,
): string | null => {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return `${kind} task output body must be valid JSON`;
  }
  const schema = kind === "must-fix" && phase === BLIND_REVIEW_PHASE.closed
    ? closedReviewArtifact
    : canonicalOutputSchemas[kind];
  if (!schema) return `canonical output kind ${kind} has no versioned JSON contract`;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.length ? issue.path.join(".") : "body";
    return `${kind} task output body violates schemaVersion 1 at ${location}: ${issue?.message ?? "invalid value"}`;
  }
  const bodyHead = (parsed.data as { headSha: string }).headSha;
  if (bodyHead !== authoredHead) {
    return `${kind} task output body headSha ${bodyHead} does not match authored commit ${authoredHead ?? "none"}`;
  }
  return null;
};

export const canonicalOutputRefusal = (
  step: TemplateStepIdentity | null | undefined,
  output: Pick<TaskStepOutput, "runId" | "kind" | "body" | "commitSha" | "metadata"> | null,
  runId: string,
  completionHeadSha: string | null,
): string | null => {
  if (!isCanonicalAgentStep(step)) return null;
  if (!output) return `missing ${step.outputKind} task output for current Run ${runId}`;
  if (output.runId !== runId) return `${step.outputKind} task output belongs to prior Run ${output.runId ?? "none"}, not current Run ${runId}`;
  if (output.kind !== step.outputKind) return `task output kind ${output.kind} does not match canonical kind ${step.outputKind}`;
  if (!completionHeadSha) return `current Run ${runId} completed without an exact head`;
  if (output.commitSha !== completionHeadSha) {
    return `${step.outputKind} task output is bound to ${output.commitSha ?? "no commit"}, not completion head ${completionHeadSha}`;
  }
  const bodyRefusal = canonicalBodyRefusal(
    output.kind,
    output.body,
    output.commitSha,
    metadataPhase(output.metadata),
  );
  if (bodyRefusal) return bodyRefusal;
  if (isCanonicalBlindReviewStep(step) && metadataPhase(output.metadata) !== BLIND_REVIEW_PHASE.closed) {
    return `blind review output is not in required ${BLIND_REVIEW_PHASE.closed} phase`;
  }
  return null;
};

type PersistOutputResult =
  | { ok: false; reason: string }
  | { ok: true; output: TaskStepOutput; predecessorOutputs: Array<{
    kind: string;
    body: string;
    commitSha: string | null;
    task: { name: string; chainIndex: number | null };
  }> };

export const persistSessionTaskOutput = async (
  tx: DbTx,
  input: {
    task: OutputTask;
    runId: string;
    fencingToken: string;
    kind: string;
    body: string;
    commitSha: string | null;
    metadata?: Prisma.InputJsonValue;
  },
): Promise<PersistOutputResult> => {
  await lockTaskRow(tx, input.task.id);
  const authorized = await tx.run.findFirst({
    where: {
      id: input.runId,
      taskId: input.task.id,
      fencingToken: input.fencingToken,
      cancelRequestedAt: null,
      leaseExpiresAt: { gt: new Date() },
      status: { in: ACTIVE_RUN_STATUSES },
    },
    select: {
      task: { select: {
        id: true,
        projectId: true,
        chainId: true,
        chainIndex: true,
        templateStep: { select: {
          stepIndex: true,
          outputKind: true,
          taskTemplate: { select: { name: true } },
        } },
      } },
    },
  });
  if (!authorized?.task) return { ok: false, reason: "Stale fencing token" };
  const task = authorized.task;
  const step = task.templateStep;
  if (isCanonicalAgentStep(step) && input.kind !== step.outputKind) {
    return { ok: false, reason: `task_output kind must be ${step.outputKind} for this canonical step` };
  }

  const blind = isCanonicalBlindReviewStep(step);
  const phase = metadataPhase(input.metadata);
  const existing = await tx.taskStepOutput.findUnique({ where: { taskId: input.task.id } });
  if (isCanonicalAgentStep(step)) {
    const bodyRefusal = canonicalBodyRefusal(input.kind, input.body, input.commitSha, phase);
    if (bodyRefusal) return { ok: false, reason: bodyRefusal };
  }
  if (blind) {
    if (phase !== BLIND_REVIEW_PHASE.independent
      && phase !== BLIND_REVIEW_PHASE.evidenceUnlocked
      && phase !== BLIND_REVIEW_PHASE.closed) {
      return { ok: false, reason: `blind review task_output metadata.phase must be ${BLIND_REVIEW_PHASE.independent}, ${BLIND_REVIEW_PHASE.evidenceUnlocked}, or ${BLIND_REVIEW_PHASE.closed}` };
    }
    if (phase === BLIND_REVIEW_PHASE.evidenceUnlocked
      && (existing?.runId !== input.runId || metadataPhase(existing.metadata) !== BLIND_REVIEW_PHASE.independent)) {
      return { ok: false, reason: `blind review must persist ${BLIND_REVIEW_PHASE.independent} in this Run before unlocking predecessor evidence` };
    }
    if (phase === BLIND_REVIEW_PHASE.evidenceUnlocked && existing?.body !== input.body) {
      return { ok: false, reason: "blind review evidence unlock must repeat the exact independent-findings body" };
    }
    if (phase === BLIND_REVIEW_PHASE.closed
      && (existing?.runId !== input.runId || metadataPhase(existing.metadata) !== BLIND_REVIEW_PHASE.evidenceUnlocked)) {
      return { ok: false, reason: `blind review must unlock predecessor evidence in this Run before ${BLIND_REVIEW_PHASE.closed}` };
    }
    if (phase === BLIND_REVIEW_PHASE.independent
      && existing?.runId === input.runId && metadataPhase(existing.metadata) !== BLIND_REVIEW_PHASE.independent) {
      return { ok: false, reason: "closed blind review output cannot return to independent-findings" };
    }
    if (phase === BLIND_REVIEW_PHASE.evidenceUnlocked && existing) {
      await tx.taskActivity.create({ data: {
        taskId: input.task.id,
        actorType: "control-plane",
        body: existing.body,
        metadata: {
          kind: "canonicalTaskOutput.blindIndependentFindings",
          schemaVersion: 1,
          runId: input.runId,
          outputKind: existing.kind,
          commitSha: existing.commitSha,
          phase: BLIND_REVIEW_PHASE.independent,
        },
      } });
    }
  }

  const output = await tx.taskStepOutput.upsert({
    where: { taskId: input.task.id },
    create: {
      taskId: input.task.id,
      runId: input.runId,
      kind: input.kind,
      body: input.body,
      commitSha: input.commitSha,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
    update: {
      runId: input.runId,
      kind: input.kind,
      body: input.body,
      ...(input.commitSha ? { commitSha: input.commitSha } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
  });
  const predecessorOutputs = blind && phase === BLIND_REVIEW_PHASE.evidenceUnlocked
    && task.chainId && task.chainIndex !== null
    ? await tx.taskStepOutput.findMany({
      where: {
        task: {
          projectId: task.projectId,
          chainId: task.chainId,
          chainIndex: { lt: task.chainIndex },
        },
      },
      select: { kind: true, body: true, commitSha: true, task: { select: { name: true, chainIndex: true } } },
      orderBy: { task: { chainIndex: "asc" } },
    })
    : [];
  return { ok: true, output, predecessorOutputs };
};

export const previousRunHandoffForClaim = async (
  tx: DbTx,
  input: {
    taskId: string;
    runId: string;
    runNumber: number;
    templateStep: TemplateStepIdentity | null;
  },
): Promise<PreviousRunHandoff | null> => {
  if (!isCanonicalAgentStep(input.templateStep) || input.runNumber <= 1) return null;
  const previous = await tx.run.findUnique({
    where: { taskId_runNumber: { taskId: input.taskId, runNumber: input.runNumber - 1 } },
    select: { id: true, status: true, failureReason: true, endedAt: true, updatedAt: true },
  });
  if (!previous || previous.id === input.runId) return null;
  const output = await tx.taskStepOutput.findUnique({
    where: { taskId: input.taskId },
    select: { runId: true, kind: true, body: true, commitSha: true },
  });
  const activity = await tx.taskActivity.findFirst({
    where: {
      taskId: input.taskId,
      actorType: "operator",
      createdAt: { gte: previous.endedAt ?? previous.updatedAt },
      body: { in: ["Approval gate rejected; step queued again", `Run ${input.runNumber} queued by operator retry`] },
    },
    select: { body: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const retryReason = activity?.body === "Approval gate rejected; step queued again"
    ? "approval-rejected-without-feedback"
    : activity?.body === `Run ${input.runNumber} queued by operator retry`
      ? "operator-retry"
      : previous.failureReason ? "automatic-retry" : "retry";
  return {
    schemaVersion: 1,
    previousRunId: previous.id,
    status: previous.status,
    failureReason: previous.failureReason,
    retryReason,
    output: output?.runId === previous.id
      ? { kind: output.kind, body: output.body, commitSha: output.commitSha }
      : null,
  };
};
