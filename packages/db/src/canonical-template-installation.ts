import { AssigneeType, Prisma, RunStatus, TaskStatus } from "@prisma/client";

import { canonicalStepDrift } from "./canonical-step-adoption.js";
import {
  legacyTemplateName,
  matchedLegacyGeneration,
  sourcePromptGenerationDrift,
  templateRolloverBlockerCount,
  type PersistedTransitionStep,
} from "./canonical-template-transition.js";
import {
  canonicalTemplateSourceSpec,
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

const currentGraphRefusal = (
  templateName: CanonicalTemplateName,
  templateId: string,
  steps: readonly PersistedTransitionStep[],
  sources: readonly TemplateStepSource[],
): string | null => {
  if (steps.length !== sources.length) {
    return `Template ${templateName} (${templateId}) has structural drift: expected ${sources.length} steps, found ${steps.length}`;
  }
  const ordered = [...steps].sort((left, right) => left.stepIndex - right.stepIndex);
  const noncontiguous = ordered.find((step, index) => step.stepIndex !== index + 1);
  if (noncontiguous) {
    return `Template ${templateName} (${templateId}), ${templateName} step ${noncontiguous.stepIndex} (${noncontiguous.id}) has structural drift: step indexes are not contiguous`;
  }
  for (const [index, step] of ordered.entries()) {
    const source = sources[index]!;
    const differences = canonicalStepDrift(templateName, step, source, "adopt");
    if (differences.length > 0) {
      return `Template ${templateName} (${templateId}), ${templateName} step ${step.stepIndex} (${step.id}) differs from the canonical source in ${differences.join(", ")}`;
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
    // Every rollover of this template installs the same graph, so the source
    // is authenticated once, before any row decides what to do.
    const sourceDrift = sourcePromptGenerationDrift(templateName, sourceSteps);
    for (const projectId of requiredProjectIds) {
      if (!matchingRows.some((row) => row.projectId === projectId)) {
        plan.push({ kind: "create", templateName, projectId });
      }
    }
    for (const row of matchingRows) {
      const marker = matchedLegacyGeneration(templateName, row.steps);
      if (marker !== null) {
        plan.push(sourceDrift === null
          ? {
            kind: "rollover",
            templateName,
            projectId: row.projectId,
            rowId: row.id,
            marker,
            legacyName: legacyTemplateName(templateName, marker, row.id),
          }
          : { kind: "refused", templateName, projectId: row.projectId, rowId: row.id, reason: sourceDrift });
        continue;
      }
      if (row.legacyNameOverride) {
        plan.push(sourceDrift === null
          ? {
            kind: "rollover",
            templateName,
            projectId: row.projectId,
            rowId: row.id,
            marker: "pre-registry-seed",
            legacyName: row.legacyNameOverride,
          }
          : { kind: "refused", templateName, projectId: row.projectId, rowId: row.id, reason: sourceDrift });
        continue;
      }
      const refusal = currentGraphRefusal(templateName, row.id, row.steps, sourceSteps);
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
  scopedError: (projectId: string, message: string) => Error = (_projectId, message) => new Error(message),
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
      throw scopedError(projectId, `Canonical template ${templateName} step ${step.stepIndex} cannot bind ${step.agentName}: active Agent was not found`);
    }
    const data = {
      layer: step.layer,
      name: step.name,
      assigneeAgentId,
      assigneeType: step.agentName === null ? AssigneeType.HUMAN : AssigneeType.AGENT,
      runner: null,
      approvalGate: step.approvalGate,
      optional: step.optional,
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
  options: Readonly<{
    synchronizeCurrent?: boolean;
    projectLabel?: (projectId: string) => string | undefined;
  }> = {},
): Promise<{ created: number }> => {
  const scopedError = (projectId: string, message: string): Error => {
    const slug = options.projectLabel?.(projectId);
    return new Error(slug ? `Project ${slug}: ${message}` : message);
  };
  const refusal = plan.find((action) => action.kind === "refused");
  if (refusal?.kind === "refused") {
    throw scopedError(refusal.projectId, refusal.reason);
  }

  let created = 0;
  for (const action of plan) {
    if (action.kind === "refused") continue;
    const sourceSteps = sources.get(action.templateName);
    if (!sourceSteps) {
      throw scopedError(action.projectId, `No canonical source is loaded for ${action.templateName}`);
    }
    if (action.kind === "current") {
      if (options.synchronizeCurrent) {
        await writeCanonicalTemplate(tx, action.projectId, action.templateName, sourceSteps, action.rowId, scopedError);
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
        throw scopedError(action.projectId, `Template ${action.templateName} (${action.rowId}) still has ${blockers} tasks with active Runs or no chain identity; canonical rollover requires active Runs to settle first`);
      }
      const row = await tx.taskTemplate.findUnique({ where: { id: action.rowId } });
      if (!row) {
        throw scopedError(action.projectId, `Template ${action.templateName} (${action.rowId}) was not found`);
      }
      if (row.webhookSecretId !== null || row.webhookRepoId !== null
        || row.webhookPayloadMapping !== null || row.webhookPausedAt !== null
        || row.webhookReplayWindowSec !== null) {
        throw scopedError(action.projectId, `Template ${action.templateName} (${action.rowId}) has webhook configuration; canonical rollover will not move operator-owned trigger state`);
      }
      const collision = await tx.taskTemplate.findUnique({
        where: { projectId_name: { projectId: action.projectId, name: action.legacyName } },
        select: { id: true },
      });
      if (collision) {
        throw scopedError(action.projectId, `Template ${action.templateName} (${action.rowId}) cannot rename to ${action.legacyName}: target template already exists (${collision.id})`);
      }
      await tx.taskTemplate.update({ where: { id: action.rowId }, data: { name: action.legacyName } });
    }
    await writeCanonicalTemplate(tx, action.projectId, action.templateName, sourceSteps, null, scopedError);
    created += 1;
  }
  return { created };
};
