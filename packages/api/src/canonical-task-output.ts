import {
  ACTIVE_RUN_STATUSES,
  DIRECT_TEMPLATE_NAME,
  INTEGRATOR_TEMPLATE_NAME,
  LEGACY_DIRECT_INTEGRATOR_TEMPLATE_NAME,
  LEGACY_INTEGRATOR_TEMPLATE_NAME,
  lockTaskRow,
  Prisma,
  RunStatus,
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

/**
 * Agent-authored node ranges are intentionally bounded before the
 * server-owned readiness and mechanical merge nodes. Legacy-v1 template
 * names retain the old ranges so output authority for already-instantiated
 * chains does not move when canonical sync installs the new graph.
 */
export const DIRECT_CANONICAL_AGENT_STEP_LAST = 6;
export const FULL_CANONICAL_AGENT_STEP_LAST = 11;
export const DIRECT_LEGACY_AGENT_STEP_LAST = 5;
export const FULL_LEGACY_AGENT_STEP_LAST = 10;

export const DIRECT_BLIND_REVIEW_STEP_INDEX = 3;
export const FULL_BLIND_REVIEW_STEP_INDEX = 7;
export const DIRECT_SOL_REVIEW_STEP_INDEX = 2;
export const FULL_SOL_REVIEW_STEP_INDEX = 6;
export const DIRECT_ADJUDICATION_STEP_INDEX = 4;
export const FULL_ADJUDICATION_STEP_INDEX = 8;

const isNamedStep = (
  step: TemplateStepIdentity | null | undefined,
  templateName: string,
  stepIndex: number,
  outputKind: string,
): boolean => step?.taskTemplate?.name === templateName
  && step.stepIndex === stepIndex
  && step.outputKind === outputKind;

export const isCanonicalAgentStep = (step: TemplateStepIdentity | null | undefined): step is CanonicalTemplateStepIdentity => {
  if (!step?.taskTemplate || step.stepIndex === undefined) return false;
  if (step.taskTemplate.name === DIRECT_TEMPLATE_NAME) {
    return step.stepIndex >= 1 && step.stepIndex <= DIRECT_CANONICAL_AGENT_STEP_LAST;
  }
  if (step.taskTemplate.name === INTEGRATOR_TEMPLATE_NAME) {
    return step.stepIndex >= 1 && step.stepIndex <= FULL_CANONICAL_AGENT_STEP_LAST;
  }
  if (step.taskTemplate.name === LEGACY_DIRECT_INTEGRATOR_TEMPLATE_NAME) {
    return step.stepIndex >= 1 && step.stepIndex <= DIRECT_LEGACY_AGENT_STEP_LAST;
  }
  if (step.taskTemplate.name === LEGACY_INTEGRATOR_TEMPLATE_NAME) {
    return step.stepIndex >= 1 && step.stepIndex <= FULL_LEGACY_AGENT_STEP_LAST;
  }
  return false;
};

/** The old combined review node, recognized only on a renamed legacy graph. */
export const isLegacyCombinedBlindReviewStep = (step: TemplateStepIdentity | null | undefined): boolean => (
  isNamedStep(step, LEGACY_DIRECT_INTEGRATOR_TEMPLATE_NAME, DIRECT_BLIND_REVIEW_STEP_INDEX, "must-fix")
  || isNamedStep(step, LEGACY_INTEGRATOR_TEMPLATE_NAME, FULL_BLIND_REVIEW_STEP_INDEX, "must-fix")
);

export const isCanonicalBlindReviewStep = (step: TemplateStepIdentity | null | undefined): boolean => (
  isNamedStep(step, DIRECT_TEMPLATE_NAME, DIRECT_BLIND_REVIEW_STEP_INDEX, "blind-findings")
  || isNamedStep(step, INTEGRATOR_TEMPLATE_NAME, FULL_BLIND_REVIEW_STEP_INDEX, "blind-findings")
  || isLegacyCombinedBlindReviewStep(step)
);

export const isCanonicalAdjudicationStep = (step: TemplateStepIdentity | null | undefined): boolean => (
  isNamedStep(step, DIRECT_TEMPLATE_NAME, DIRECT_ADJUDICATION_STEP_INDEX, "must-fix")
  || isNamedStep(step, INTEGRATOR_TEMPLATE_NAME, FULL_ADJUDICATION_STEP_INDEX, "must-fix")
);

export const isCanonicalBlindFindingsStep = (step: TemplateStepIdentity | null | undefined): boolean => (
  isNamedStep(step, DIRECT_TEMPLATE_NAME, DIRECT_BLIND_REVIEW_STEP_INDEX, "blind-findings")
  || isNamedStep(step, INTEGRATOR_TEMPLATE_NAME, FULL_BLIND_REVIEW_STEP_INDEX, "blind-findings")
);

export const isCanonicalSolFindingsStep = (step: TemplateStepIdentity | null | undefined): boolean => (
  isNamedStep(step, DIRECT_TEMPLATE_NAME, DIRECT_SOL_REVIEW_STEP_INDEX, "sol-findings")
  || isNamedStep(step, INTEGRATOR_TEMPLATE_NAME, FULL_SOL_REVIEW_STEP_INDEX, "sol-findings")
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

/**
 * The new adjudication node is not a review report. Its body carries only the
 * range and the disposition package; the input finding details remain in the
 * two immutable sibling reports. `findings` is accepted as an optional
 * compatibility field because a few operator-created records predate the
 * split, but the adjudicator contract never requires it.
 */
const adjudicationArtifact = canonicalEnvelope.extend({
  reviewedBase: commitSha,
  reviewedHead: commitSha,
  dispositions: z.array(z.object({
    id: nonEmptyString,
    disposition: z.enum(["ADOPTED", "REJECTED", "MERGED"]),
    reason: nonEmptyString,
  })),
  mustFixIds: stringList,
  findings: z.array(reviewFinding).optional(),
});

type ReviewArtifact = z.infer<typeof reviewArtifact>;
type ClosedReviewArtifact = z.infer<typeof closedReviewArtifact>;
type AdjudicationArtifact = z.infer<typeof adjudicationArtifact>;

const duplicateValues = (values: string[]): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
};

const closedReviewSelfRefusal = (artifact: ClosedReviewArtifact): string | null => {
  const duplicateFindings = duplicateValues(artifact.findings.map((finding) => finding.id));
  if (duplicateFindings.length > 0) {
    return `closed-must-fix findings contain duplicate ids: ${duplicateFindings.join(", ")}`;
  }
  const duplicateDispositions = duplicateValues(artifact.dispositions.map((disposition) => disposition.id));
  if (duplicateDispositions.length > 0) {
    return `closed-must-fix dispositions contain duplicate ids: ${duplicateDispositions.join(", ")}`;
  }
  const duplicateMustFixIds = duplicateValues(artifact.mustFixIds);
  if (duplicateMustFixIds.length > 0) {
    return `closed-must-fix mustFixIds contain duplicates: ${duplicateMustFixIds.join(", ")}`;
  }
  const expectedMustFixIds = new Set(
    artifact.findings.filter((finding) => finding.severity === "P0" || finding.severity === "P1")
      .map((finding) => finding.id),
  );
  const actualMustFixIds = new Set(artifact.mustFixIds);
  const missing = [...expectedMustFixIds].filter((id) => !actualMustFixIds.has(id)).sort();
  const unexpected = [...actualMustFixIds].filter((id) => !expectedMustFixIds.has(id)).sort();
  if (missing.length > 0 || unexpected.length > 0) {
    return `closed-must-fix mustFixIds must exactly equal final P0/P1 finding ids; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`;
  }
  return null;
};

const closedReviewRunRefusal = (
  independent: ReviewArtifact,
  closed: ClosedReviewArtifact,
): string | null => {
  if (closed.headSha !== independent.headSha
    || closed.reviewedBase !== independent.reviewedBase
    || closed.reviewedHead !== independent.reviewedHead) {
    return "closed-must-fix review range must exactly match this Run's independent-findings range";
  }
  const dispositionIds = new Set(closed.dispositions.map((disposition) => disposition.id));
  const missing = independent.findings.map((finding) => finding.id)
    .filter((id) => !dispositionIds.has(id))
    .sort();
  if (missing.length > 0) {
    return `closed-must-fix dispositions must cover every independent finding from this Run; missing: ${missing.join(", ")}`;
  }
  return null;
};

const adjudicationPersistenceRefusal = async (
  tx: DbTx,
  task: AdjudicationClaimTask,
  body: string,
): Promise<string | null> => {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return "must-fix body is not valid JSON";
  }
  const parsed = adjudicationArtifact.safeParse(value);
  if (!parsed.success) return "must-fix body does not satisfy its canonical schema";
  const adjudication: AdjudicationArtifact = parsed.data;
  if (!task.chainId || task.chainLayer === null) {
    return "must-fix adjudication task has no chainId/chainLayer review boundary";
  }
  const predecessor = await tx.task.findFirst({
    where: { projectId: task.projectId, chainId: task.chainId, chainLayer: { lt: task.chainLayer } },
    select: { chainLayer: true },
    orderBy: { chainLayer: "desc" },
  });
  if (predecessor?.chainLayer === null || !predecessor) {
    return "must-fix adjudication task has no predecessor review layer";
  }
  const reviewTasks = await tx.task.findMany({
    where: { projectId: task.projectId, chainId: task.chainId, chainLayer: predecessor.chainLayer },
    select: {
      id: true,
      templateStep: { select: {
        stepIndex: true,
        outputKind: true,
        taskTemplate: { select: { name: true } },
      } },
      stepOutput: { select: { kind: true, body: true, commitSha: true } },
    },
  });
  const expectedKinds = ["sol-findings", "blind-findings"] as const;
  const reports: ReviewArtifact[] = [];
  for (const kind of expectedKinds) {
    const matches = reviewTasks.filter((candidate) => (
      kind === "sol-findings"
        ? isCanonicalSolFindingsStep(candidate.templateStep)
        : isCanonicalBlindFindingsStep(candidate.templateStep)
    ));
    if (matches.length !== 1 || !matches[0]!.stepOutput || matches[0]!.stepOutput!.kind !== kind) {
      return `must-fix adjudication requires exactly one immutable ${kind} sibling output`;
    }
    const output = matches[0]!.stepOutput!;
    let reportValue: unknown;
    try {
      reportValue = JSON.parse(output.body);
    } catch {
      return `must-fix adjudication ${kind} sibling body is not valid JSON`;
    }
    const report = reviewArtifact.safeParse(reportValue);
    if (!report.success) return `must-fix adjudication ${kind} sibling violates its review contract`;
    if (output.commitSha !== adjudication.headSha
      || report.data.headSha !== adjudication.headSha
      || report.data.reviewedBase !== adjudication.reviewedBase
      || report.data.reviewedHead !== adjudication.reviewedHead) {
      return `must-fix adjudication range does not match immutable ${kind} sibling`;
    }
    reports.push(report.data);
  }

  const sourceSeverities = new Map<string, "P0" | "P1" | "P2">();
  const rank = { P0: 0, P1: 1, P2: 2 } as const;
  for (const finding of reports.flatMap((report) => report.findings)) {
    const prior = sourceSeverities.get(finding.id);
    if (!prior || rank[finding.severity] < rank[prior]) sourceSeverities.set(finding.id, finding.severity);
  }
  const duplicateDispositions = duplicateValues(adjudication.dispositions.map(({ id }) => id));
  if (duplicateDispositions.length > 0) {
    return `must-fix dispositions contain duplicate ids: ${duplicateDispositions.join(", ")}`;
  }
  const dispositionIds = new Set(adjudication.dispositions.map(({ id }) => id));
  const missing = [...sourceSeverities.keys()].filter((id) => !dispositionIds.has(id)).sort();
  const unknown = [...dispositionIds].filter((id) => !sourceSeverities.has(id)).sort();
  if (missing.length > 0 || unknown.length > 0) {
    return `must-fix dispositions must exactly cover sibling findings; missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"}`;
  }
  const duplicateMustFixIds = duplicateValues(adjudication.mustFixIds);
  if (duplicateMustFixIds.length > 0) {
    return `must-fix mustFixIds contain duplicates: ${duplicateMustFixIds.join(", ")}`;
  }
  const expectedMustFixIds = adjudication.dispositions
    .filter(({ id, disposition }) => disposition !== "REJECTED" && sourceSeverities.get(id) !== "P2")
    .map(({ id }) => id)
    .sort();
  const actualMustFixIds = [...adjudication.mustFixIds].sort();
  if (JSON.stringify(actualMustFixIds) !== JSON.stringify(expectedMustFixIds)) {
    return `must-fix mustFixIds must exactly equal accepted P0/P1 disposition ids; expected: ${expectedMustFixIds.join(", ") || "none"}; actual: ${actualMustFixIds.join(", ") || "none"}`;
  }
  return null;
};

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
  "blind-findings": reviewArtifact,
  "must-fix": adjudicationArtifact,
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
    : kind === "must-fix"
      && (phase === BLIND_REVIEW_PHASE.independent || phase === BLIND_REVIEW_PHASE.evidenceUnlocked)
      ? reviewArtifact
      : canonicalOutputSchemas[kind];
  if (!schema) return `canonical output kind ${kind} has no versioned JSON contract`;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 8).map((issue) => {
      const location = issue.path.length ? issue.path.join(".") : "body";
      return { location, message: issue.message };
    });
    const [first, ...remaining] = issues;
    const additional = remaining.length > 0
      ? `; additional violations: ${remaining.map((issue) => `${issue.location}: ${issue.message}`).join("; ")}`
      : "";
    return `${kind} task output body violates schemaVersion 1 at ${first?.location ?? "body"}: ${first?.message ?? "invalid value"}${additional}`;
  }
  const bodyHead = (parsed.data as { headSha: string }).headSha;
  if (bodyHead !== authoredHead) {
    return `${kind} task output body headSha ${bodyHead} does not match authored commit ${authoredHead ?? "none"}`;
  }
  if (kind === "must-fix" && phase === BLIND_REVIEW_PHASE.closed) {
    return closedReviewSelfRefusal(parsed.data as ClosedReviewArtifact);
  }
  return null;
};

type AdjudicationClaimTask = {
  id: string;
  projectId: string;
  chainId: string | null;
  chainLayer: number | null;
  templateStep?: TemplateStepIdentity | null;
};

export type AdjudicationClaimInput = {
  task: AdjudicationClaimTask;
  implementationBaseSha: string | null;
  implementationHeadSha: string | null;
};

type ReviewReportKind = "sol-findings" | "blind-findings";

/**
 * Validate the evidence boundary for the fresh adjudication Session.
 *
 * This deliberately has two reads. The first reads only task identity/status
 * and output/run metadata. Report bodies are not selected until both sibling
 * tasks are present, DONE, and backed by a successful run with the expected
 * immutable output kind and pinned head. That ordering keeps an adjudicator
 * from ever receiving a partial report set as if it were authoritative.
 */
export const reviewAdjudicationClaimRefusal = async (
  tx: DbTx,
  input: AdjudicationClaimInput,
): Promise<string | null> => {
  if (!isCanonicalAdjudicationStep(input.task.templateStep)) return null;
  const refusalPrefix = "Adjudication claim refused";
  if (!input.implementationBaseSha || !input.implementationHeadSha) {
    return `${refusalPrefix}: claim has no immutable implementationBaseSha and implementationHeadSha`;
  }
  if (!input.task.chainId || input.task.chainLayer === null) {
    return `${refusalPrefix}: adjudication task has no chainId/chainLayer review boundary`;
  }

  // The adjudication node is in the join layer after the two review siblings,
  // not in the review layer itself. Layer values may be sparse, so derive the
  // immediate predecessor by ordering the existing chain layers rather than
  // subtracting one or searching arbitrary earlier nodes.
  const predecessorLayer = await tx.task.findFirst({
    where: {
      projectId: input.task.projectId,
      chainId: input.task.chainId,
      chainLayer: { lt: input.task.chainLayer },
    },
    select: { chainLayer: true },
    orderBy: { chainLayer: "desc" },
  });
  if (predecessorLayer?.chainLayer === null || predecessorLayer === null) {
    return `${refusalPrefix}: adjudication task has no predecessor review layer before layer ${input.task.chainLayer}`;
  }
  const reviewLayer = predecessorLayer.chainLayer;
  const reviewTasks = await tx.task.findMany({
    where: {
      projectId: input.task.projectId,
      chainId: input.task.chainId,
      chainLayer: reviewLayer,
      id: { not: input.task.id },
    },
    select: {
      id: true,
      status: true,
      templateStep: { select: {
        stepIndex: true,
        outputKind: true,
        taskTemplate: { select: { name: true } },
      } },
    },
  });
  const solTasks = reviewTasks.filter((task) => isCanonicalSolFindingsStep(task.templateStep));
  const blindTasks = reviewTasks.filter((task) => isCanonicalBlindFindingsStep(task.templateStep));
  if (solTasks.length !== 1) {
    return `${refusalPrefix}: expected exactly one sol-findings sibling in layer ${reviewLayer}, found ${solTasks.length}`;
  }
  if (blindTasks.length !== 1) {
    return `${refusalPrefix}: expected exactly one blind-findings sibling in layer ${reviewLayer}, found ${blindTasks.length}`;
  }

  const siblings: Array<{ kind: ReviewReportKind; task: typeof solTasks[number] }> = [
    { kind: "sol-findings", task: solTasks[0]! },
    { kind: "blind-findings", task: blindTasks[0]! },
  ];
  for (const sibling of siblings) {
    if (sibling.task.status !== "DONE") {
      return `${refusalPrefix}: ${sibling.kind} task ${sibling.task.id} is ${sibling.task.status}, not DONE`;
    }
  }

  const outputRows = await tx.taskStepOutput.findMany({
    where: { taskId: { in: siblings.map(({ task }) => task.id) } },
    select: {
      taskId: true,
      runId: true,
      kind: true,
      commitSha: true,
      run: { select: { taskId: true, status: true } },
    },
  });
  const outputByTaskId = new Map(outputRows.map((output) => [output.taskId, output]));
  for (const sibling of siblings) {
    const output = outputByTaskId.get(sibling.task.id);
    if (!output) return `${refusalPrefix}: missing immutable ${sibling.kind} output for task ${sibling.task.id}`;
    if (output.runId === null || output.run?.taskId !== sibling.task.id || output.run.status !== RunStatus.SUCCEEDED) {
      return `${refusalPrefix}: ${sibling.kind} output for task ${sibling.task.id} is not backed by a successful completed Run`;
    }
    if (output.kind !== sibling.kind) {
      return `${refusalPrefix}: ${sibling.kind} output for task ${sibling.task.id} has kind ${output.kind}`;
    }
    if (output.commitSha !== input.implementationHeadSha) {
      return `${refusalPrefix}: ${sibling.kind} output for task ${sibling.task.id} is bound to ${output.commitSha ?? "no commit"}, expected ${input.implementationHeadSha}`;
    }
  }

  // Only now select the report bodies. The two bodies are validated against
  // both the output row and the claim's immutable implementation range.
  const reports = await tx.taskStepOutput.findMany({
    where: { taskId: { in: siblings.map(({ task }) => task.id) } },
    select: { taskId: true, body: true, kind: true, commitSha: true },
  });
  const reportByTaskId = new Map(reports.map((report) => [report.taskId, report]));
  for (const sibling of siblings) {
    const report = reportByTaskId.get(sibling.task.id);
    if (!report) return `${refusalPrefix}: ${sibling.kind} output disappeared before body validation`;
    const bodyRefusal = canonicalBodyRefusal(report.kind, report.body, report.commitSha, null);
    if (bodyRefusal) return `${refusalPrefix}: ${sibling.kind} report ${bodyRefusal}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(report.body);
    } catch {
      return `${refusalPrefix}: ${sibling.kind} report body is not valid JSON`;
    }
    const artifact = reviewArtifact.safeParse(parsed);
    if (!artifact.success) return `${refusalPrefix}: ${sibling.kind} report body violates its review contract`;
    if (artifact.data.reviewedBase !== input.implementationBaseSha
      || artifact.data.reviewedHead !== input.implementationHeadSha
      || artifact.data.headSha !== input.implementationHeadSha) {
      return `${refusalPrefix}: ${sibling.kind} report range does not match implementationBaseSha/implementationHeadSha`;
    }
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
  if (isLegacyCombinedBlindReviewStep(step) && metadataPhase(output.metadata) !== BLIND_REVIEW_PHASE.closed) {
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
  // Run is the cancellation authority. Take its row before Task so every
  // output writer serializes with cancellation/completion and follows the
  // same Run -> Task lock order as those terminal paths.
  await tx.$queryRaw`SELECT "id" FROM "Run" WHERE "id" = ${input.runId} FOR UPDATE`;
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
        chainLayer: true,
        status: true,
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

  const legacyBlind = isLegacyCombinedBlindReviewStep(step);
  const phase = metadataPhase(input.metadata);
  const existing = await tx.taskStepOutput.findUnique({ where: { taskId: input.task.id } });
  const immutableReviewOutput = isCanonicalSolFindingsStep(step)
    || isCanonicalBlindFindingsStep(step)
    || isCanonicalAdjudicationStep(step);
  if (immutableReviewOutput && existing) {
    return { ok: false, reason: `${step?.outputKind ?? input.kind} task output is immutable once persisted` };
  }
  if (isCanonicalAgentStep(step)) {
    const bodyRefusal = canonicalBodyRefusal(input.kind, input.body, input.commitSha, phase);
    if (bodyRefusal) return { ok: false, reason: bodyRefusal };
  }
  if (isCanonicalAdjudicationStep(step)) {
    const refusal = await adjudicationPersistenceRefusal(tx, task, input.body);
    if (refusal) return { ok: false, reason: refusal };
  }
  // The old combined node is retained only for already-instantiated
  // -legacy-v1 chains. New canonical blind nodes never enter this phased
  // predecessor-evidence path.
  if (legacyBlind) {
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
    if (phase === BLIND_REVIEW_PHASE.closed && existing) {
      let independentValue: unknown;
      let closedValue: unknown;
      try {
        independentValue = JSON.parse(existing.body);
        closedValue = JSON.parse(input.body);
      } catch {
        return { ok: false, reason: "blind review output contract could not parse the persisted review sequence" };
      }
      const independent = reviewArtifact.safeParse(independentValue);
      const closed = closedReviewArtifact.safeParse(closedValue);
      if (!independent.success || !closed.success) {
        return { ok: false, reason: "blind review output contract could not validate the persisted review sequence" };
      }
      const refusal = closedReviewRunRefusal(independent.data, closed.data);
      if (refusal) return { ok: false, reason: refusal };
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
  const predecessorOutputs = legacyBlind && phase === BLIND_REVIEW_PHASE.evidenceUnlocked
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
