import { AssigneeType, Prisma, RunStatus, TaskStatus } from "@prisma/client";

import {
  legacyTemplateName,
  LEGACY_TEMPLATE_GENERATIONS,
  matchedLegacyGeneration,
  successorPromptDrift,
  templateRolloverBlockerCount,
  type PersistedTransitionStep,
} from "./canonical-template-transition.js";
import {
  LEGACY_ALL_PRIOR_OUTPUTS,
  canonicalTemplateSourceSpec,
  templateStepStructureDifferences,
  type CanonicalTemplateName,
  type TemplateStepSource,
} from "./template-sources.js";

export type CanonicalInstallationRow = Readonly<{
  id: string;
  projectId: string;
  name: CanonicalTemplateName;
  steps: readonly PersistedTransitionStep[];
  /** Seed-only adapter for predecessor graphs that predate the closed registry. */
  legacyNameOverride?: string;
}>;

export type CanonicalInstallationAction =
  | Readonly<{ kind: "current"; templateName: CanonicalTemplateName; projectId: string; rowId: string }>
  | Readonly<{ kind: "create"; templateName: CanonicalTemplateName; projectId: string }>
  | Readonly<{
    kind: "rollover";
    templateName: CanonicalTemplateName;
    projectId: string;
    rowId: string;
    marker: string;
    legacyName: string;
    successorVerified: boolean;
  }>
  | Readonly<{
    kind: "refused";
    templateName: CanonicalTemplateName;
    projectId: string;
    rowId: string | null;
    reason: string;
  }>;

export type CanonicalInstallationPlan = readonly CanonicalInstallationAction[];
export type CanonicalInstallationSources = ReadonlyMap<CanonicalTemplateName, readonly TemplateStepSource[]>;

const CANONICAL_REVIEW_STEP_IDENTITIES = new Set([
  "compound-engineer-workflow:6",
  "compound-engineer-workflow:7",
  "direct-engineer-workflow:3",
  "direct-engineer-workflow:4",
  "pr-engineer-workflow:2",
  "pr-engineer-workflow:3",
]);

const isCanonicalReviewStep = (templateName: CanonicalTemplateName, stepIndex: number): boolean =>
  CANONICAL_REVIEW_STEP_IDENTITIES.has(`${templateName}:${stepIndex}`);

const adoptionDifferenceAllowed = (
  templateName: CanonicalTemplateName,
  actual: PersistedTransitionStep,
  source: TemplateStepSource,
  difference: string,
): boolean => {
  if (difference === "name") return actual.name === "Merge readiness" && source.name === "Merge authorization";
  if (difference === "priorOutputKinds") {
    return actual.priorOutputKinds.length === 1 && actual.priorOutputKinds[0] === LEGACY_ALL_PRIOR_OUTPUTS;
  }
  if (difference === "agent") {
    const from = actual.assigneeAgent?.name;
    return (source.agentName === "regression-verifier"
      && (from === "review-coordinator-opus" || from === "review-coordinator-sol"))
      || (templateName === "direct-engineer-workflow"
        && actual.stepIndex === 1
        && from === undefined
        && source.agentName === "spec-revalidator");
  }
  if (difference === "baseFromStepIndex") {
    return actual.baseFromStepIndex === null
      && ((templateName === "compound-engineer-workflow" && actual.stepIndex === 6 && source.baseFromStepIndex === 5)
        || (templateName === "direct-engineer-workflow" && actual.stepIndex === 3 && source.baseFromStepIndex === 2));
  }
  if (difference === "provisionDependencies") {
    return isCanonicalReviewStep(templateName, actual.stepIndex)
      && actual.provisionDependencies === true
      && source.provisionDependencies === false;
  }
  return false;
};

const currentGraphRefusal = (
  templateName: CanonicalTemplateName,
  steps: readonly PersistedTransitionStep[],
  sources: readonly TemplateStepSource[],
): string | null => {
  if (steps.length !== sources.length) {
    return `Canonical template ${templateName} has structural drift: expected ${sources.length} steps, found ${steps.length}`;
  }
  const ordered = [...steps].sort((left, right) => left.stepIndex - right.stepIndex);
  if (ordered.some((step, index) => step.stepIndex !== index + 1)) {
    return `Canonical template ${templateName} has structural drift: step indexes are not contiguous`;
  }
  for (const [index, step] of ordered.entries()) {
    const source = sources[index]!;
    const differences = templateStepStructureDifferences(step, source)
      .filter((difference) => !adoptionDifferenceAllowed(templateName, step, source, difference));
    if (differences.length > 0) {
      return `Canonical template ${templateName} has structural drift: step ${step.stepIndex} differs from the canonical source in ${differences.join(", ")}`;
    }
  }
  return null;
};

/**
 * Decide the complete canonical template installation before any row changes.
 * Drivers supply database snapshots and source graphs; the plan is pure and
 * makes refusal, adoption, and registered rollover mutually exclusive.
 */
export const planCanonicalInstallation = (
  rows: readonly CanonicalInstallationRow[],
  sources: CanonicalInstallationSources,
  requiredProjectIds: readonly string[] = [],
): CanonicalInstallationPlan => {
  const plan: CanonicalInstallationAction[] = [];
  for (const [templateName, sourceSteps] of sources) {
    const matchingRows = rows.filter((row) => row.name === templateName);
    for (const projectId of requiredProjectIds) {
      if (!matchingRows.some((row) => row.projectId === projectId)) {
        plan.push({ kind: "create", templateName, projectId });
      }
    }
    for (const row of matchingRows) {
      const marker = matchedLegacyGeneration(templateName, row.steps);
      if (marker !== null) {
        const generation = LEGACY_TEMPLATE_GENERATIONS[templateName]
          .find((candidate) => candidate.marker === marker)!;
        const drift = successorPromptDrift(templateName, marker, sourceSteps);
        plan.push(drift === null
          ? {
            kind: "rollover",
            templateName,
            projectId: row.projectId,
            rowId: row.id,
            marker,
            legacyName: legacyTemplateName(templateName, marker, row.id),
            successorVerified: generation.successorPromptDigest !== undefined,
          }
          : { kind: "refused", templateName, projectId: row.projectId, rowId: row.id, reason: drift });
        continue;
      }
      if (row.legacyNameOverride) {
        plan.push({
          kind: "rollover",
          templateName,
          projectId: row.projectId,
          rowId: row.id,
          marker: "pre-registry-seed",
          legacyName: row.legacyNameOverride,
          successorVerified: false,
        });
        continue;
      }
      const refusal = currentGraphRefusal(templateName, row.steps, sourceSteps);
      plan.push(refusal === null
        ? { kind: "current", templateName, projectId: row.projectId, rowId: row.id }
        : { kind: "refused", templateName, projectId: row.projectId, rowId: row.id, reason: refusal });
    }
  }
  return plan;
};

const writeCanonicalTemplate = async (
  tx: Prisma.TransactionClient,
  projectId: string,
  templateName: CanonicalTemplateName,
  steps: readonly TemplateStepSource[],
  currentRowId: string | null = null,
): Promise<void> => {
  const metadata = canonicalTemplateSourceSpec(templateName);
  const template = currentRowId === null
    ? await tx.taskTemplate.create({
      data: { projectId, name: templateName, description: metadata.description, variables: ["branchName"] },
    })
    : await tx.taskTemplate.update({
      where: { id: currentRowId },
      data: { description: metadata.description, variables: ["branchName"] },
    });
  for (const step of steps) {
    const assigneeAgentId = step.agentName === null
      ? null
      : (await tx.agent.findFirst({
        where: { projectId, name: step.agentName, archivedAt: null },
        select: { id: true },
      }))?.id ?? null;
    if (step.agentName !== null && assigneeAgentId === null) {
      throw new Error(`Canonical template ${templateName} step ${step.stepIndex} cannot bind ${step.agentName}: active Agent was not found in project ${projectId}`);
    }
    const data = {
      layer: step.layer,
      name: step.name,
      assigneeAgentId,
      assigneeType: step.agentName === null ? AssigneeType.HUMAN : AssigneeType.AGENT,
      runner: null,
      approvalGate: step.approvalGate,
      outputKind: step.outputKind,
      prompt: step.prompt,
      opensPullRequest: step.opensPullRequest,
      requiresCommit: step.requiresCommit,
      attachmentsFromPrevious: step.attachmentsFromPrevious,
      priorOutputKinds: step.priorOutputKinds,
      baseFromStepIndex: step.baseFromStepIndex,
      spawnPolicy: step.spawnPolicy ?? Prisma.JsonNull,
      provisionDependencies: step.provisionDependencies,
    } as const;
    await tx.taskTemplateStep.upsert({
      where: { taskTemplateId_stepIndex: { taskTemplateId: template.id, stepIndex: step.stepIndex } },
      update: data,
      create: { taskTemplateId: template.id, stepIndex: step.stepIndex, ...data },
    });
  }
};

/** Apply one precomputed plan inside the caller's transaction. */
export const applyCanonicalInstallation = async (
  tx: Prisma.TransactionClient,
  plan: CanonicalInstallationPlan,
  sources: CanonicalInstallationSources,
  options: Readonly<{ synchronizeCurrent?: boolean }> = {},
): Promise<{ created: number }> => {
  const refusal = plan.find((action) => action.kind === "refused");
  if (refusal?.kind === "refused") throw new Error(refusal.reason);

  let created = 0;
  for (const action of plan) {
    if (action.kind === "refused") continue;
    const sourceSteps = sources.get(action.templateName);
    if (!sourceSteps) throw new Error(`No canonical source is loaded for ${action.templateName}`);
    if (action.kind === "current") {
      if (options.synchronizeCurrent) {
        await writeCanonicalTemplate(tx, action.projectId, action.templateName, sourceSteps, action.rowId);
      }
      continue;
    }
    if (action.kind === "rollover") {
      const tasks = await tx.task.findMany({
        where: { templateId: action.rowId, archivedAt: null, status: { not: TaskStatus.DONE } },
        select: {
          chainId: true,
          _count: { select: { runs: { where: { status: { in: [
            RunStatus.QUEUED,
            RunStatus.CLAIMED,
            RunStatus.PROVISIONING,
            RunStatus.RUNNING,
            RunStatus.WAITING_INBOX,
          ] } } } } },
        },
      });
      const blockers = templateRolloverBlockerCount(tasks.map((task) => ({
        chainId: task.chainId,
        activeRunCount: task._count.runs,
      })));
      if (blockers > 0) {
        throw new Error(`${action.templateName} ${action.rowId} still has ${blockers} tasks with active Runs or no chain identity; canonical rollover requires active Runs to settle first`);
      }
      const row = await tx.taskTemplate.findUniqueOrThrow({ where: { id: action.rowId } });
      if (row.webhookSecretId !== null || row.webhookRepoId !== null
        || row.webhookPayloadMapping !== null || row.webhookPausedAt !== null
        || row.webhookReplayWindowSec !== null) {
        throw new Error(`${action.templateName} ${action.rowId} has webhook configuration; canonical rollover will not move operator-owned trigger state`);
      }
      const collision = await tx.taskTemplate.findUnique({
        where: { projectId_name: { projectId: action.projectId, name: action.legacyName } },
        select: { id: true },
      });
      if (collision) {
        throw new Error(`Canonical template ${action.templateName} on project ${action.projectId} cannot rename to ${action.legacyName}: target already exists`);
      }
      await tx.taskTemplate.update({ where: { id: action.rowId }, data: { name: action.legacyName } });
    }
    await writeCanonicalTemplate(tx, action.projectId, action.templateName, sourceSteps);
    created += 1;
  }
  return { created };
};
