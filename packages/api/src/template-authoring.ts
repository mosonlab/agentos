import {
  canonicalTemplateIdentity,
  lockTemplateRow,
  lockTemplateStepRows,
  Prisma,
  type PrismaClient,
} from "@anneal/db";

import {
  TemplateAuthoringRefusal,
  type TemplateAuthoringRefusalCode,
} from "./template-authoring-errors.js";
import { serializable } from "./transaction.js";

export type CloneTemplateInput = {
  name: string;
  description?: string | undefined;
};

/** The fields an operator may submit for one replacement Step. */
export type ReplaceTemplateStepInput = {
  name: string;
  assigneeType: "AGENT" | "HUMAN";
  assigneeAgentId: string | null;
  prompt: string;
  approvalGate: boolean;
  attachmentsFromPrevious: boolean;
  priorOutputKinds: string[];
  spawnPolicy: unknown | null;
  runner: "CLAUDE" | "CODEX" | "PI" | null;
  outputKind: string;
  opensPullRequest: boolean;
  requiresCommit: boolean;
  baseFromStepIndex: number | null;
  layer: number;
};

/** A normalized graph Step, after the server assigns its dense index. */
export type TemplateAuthoringStep = Omit<ReplaceTemplateStepInput, "spawnPolicy"> & {
  stepIndex: number;
  spawnPolicy: Prisma.JsonValue;
};

export type ReplaceTemplateStepsInput = {
  steps: ReplaceTemplateStepInput[];
};

export type TemplateAuthoringAgent = {
  id: string;
  name: string;
  projectId: string;
  archivedAt: Date | null;
};

export type TemplateAuthoringWarningCode =
  | "no_review_step"
  | "same_agent_implements_and_reviews"
  | "pull_request_without_regression";

export type TemplateAuthoringWarning = {
  code: TemplateAuthoringWarningCode;
  message: string;
  stepIndex?: number;
};

export type TemplateGraphValidation = {
  refusal: TemplateAuthoringRefusal | null;
  warnings: TemplateAuthoringWarning[];
};

const authoringRefusal = (
  code: TemplateAuthoringRefusalCode,
  message: string,
): TemplateAuthoringRefusal => new TemplateAuthoringRefusal(code, message);

const isUniqueConstraintError = (error: unknown): boolean => (
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
);

/** Prisma represents a nullable JSON column's null as JsonNull on writes. */
const cloneJson = (value: Prisma.JsonValue | null): Prisma.InputJsonValue | typeof Prisma.JsonNull => (
  value === null ? Prisma.JsonNull : value as Prisma.InputJsonValue
);

/**
 * Pure graph validation frame. The order is part of the authoring contract:
 * later validator slices append checks after `graph_empty`, and the first
 * refusal remains the only refusal returned for a graph. Agent facts are read
 * by the transaction caller so this function never opens a transaction.
 */
export const validateTemplateGraph = (
  steps: readonly TemplateAuthoringStep[],
  _agents: ReadonlyMap<string, TemplateAuthoringAgent>,
): TemplateGraphValidation => {
  // 1. graph_empty. The remaining fixed positions are intentionally empty in
  // this slice; later slices own their checks and warning computation.
  if (steps.length === 0) {
    return {
      refusal: authoringRefusal("graph_empty", "Template graph must contain at least one step"),
      warnings: [],
    };
  }
  return { refusal: null, warnings: [] };
};

/**
 * Clone one project template without copying runtime state.
 *
 * The source and name checks, plus the nested template/step write, share one
 * serializable transaction. This makes a successful response an exact read
 * projection of the rows that were written and turns a concurrent same-name
 * clone into the named authoring conflict rather than a generic Prisma error.
 */
export const cloneTemplate = async (
  db: PrismaClient,
  projectId: string,
  templateId: string,
  input: CloneTemplateInput,
) => {
  const name = input.name.trim();
  try {
    return await serializable(db, async (tx) => {
      const source = await tx.taskTemplate.findFirst({
        where: { id: templateId, projectId },
        include: {
          steps: {
            include: { assigneeAgent: true },
            orderBy: { stepIndex: "asc" },
          },
        },
      });
      if (!source) {
        throw authoringRefusal(
          "template_not_in_project",
          `Template ${templateId} is not in project ${projectId}`,
        );
      }

      // The canonical registry covers current names and every registered
      // legacy identity. Check it before the project uniqueness index so a
      // canonical row cannot be reported as an ordinary name collision.
      if (canonicalTemplateIdentity(name)) {
        throw authoringRefusal(
          "template_name_reserved",
          `Template name ${name} is reserved for a canonical template`,
        );
      }

      const existing = await tx.taskTemplate.findUnique({
        where: { projectId_name: { projectId, name } },
        select: { id: true },
      });
      if (existing) {
        throw authoringRefusal(
          "template_name_taken",
          `Template name ${name} is already taken in project ${projectId}`,
        );
      }

      return tx.taskTemplate.create({
        data: {
          projectId,
          name,
          description: input.description === undefined ? source.description : input.description,
          variables: source.variables,
          // Webhook fields are intentionally omitted. Nullable columns default
          // to null, so no secret, repository, mapping, pause, or replay state
          // can be shared with the source. Tasks and fires are relations on the
          // source only and are never part of a nested create.
          steps: {
            create: source.steps.map((step) => ({
              assigneeAgentId: step.assigneeAgentId,
              stepIndex: step.stepIndex,
              name: step.name,
              assigneeType: step.assigneeType,
              prompt: step.prompt,
              approvalGate: step.approvalGate,
              attachmentsFromPrevious: step.attachmentsFromPrevious,
              priorOutputKinds: step.priorOutputKinds,
              spawnPolicy: cloneJson(step.spawnPolicy),
              runner: step.runner,
              outputKind: step.outputKind,
              opensPullRequest: step.opensPullRequest,
              requiresCommit: step.requiresCommit,
              baseFromStepIndex: step.baseFromStepIndex,
              layer: step.layer,
            })),
          },
        },
        include: {
          steps: {
            include: { assigneeAgent: true },
            orderBy: { stepIndex: "asc" },
          },
        },
      });
    });
  } catch (error: unknown) {
    if (isUniqueConstraintError(error)) {
      throw authoringRefusal(
        "template_name_taken",
        `Template name ${name} is already taken in project ${projectId}`,
      );
    }
    throw error;
  }
};

/**
 * Replace one project's complete editable Step graph atomically.
 *
 * The template row is the first lock in this protocol. Existing Step rows are
 * then locked in deterministic order before the Task reference check, so a
 * concurrent writer cannot observe a graph halfway through deletion. The
 * validator runs on the dense graph before any row mutation.
 */
export const replaceTemplateSteps = async (
  db: PrismaClient,
  projectId: string,
  templateId: string,
  input: ReplaceTemplateStepsInput,
) => serializable(db, async (tx) => {
  const template = await lockTemplateRow(tx, templateId);
  if (!template || template.projectId !== projectId) {
    throw authoringRefusal(
      "template_not_in_project",
      `Template ${templateId} is not in project ${projectId}`,
    );
  }

  // Canonical and registered-legacy names are owned by repository prompt
  // sync. This identity is checked while the row mutex is held so a rollover
  // cannot change the answer between the guard and the mutation.
  if (canonicalTemplateIdentity(template.name)) {
    throw authoringRefusal(
      "template_canonical",
      `Template ${template.name} is canonical and cannot be edited; clone it again to author a replacement`,
    );
  }

  const existingStepIds = await lockTemplateStepRows(tx, templateId);
  const referencedTaskCount = await tx.task.count({
    where: existingStepIds.length === 0
      ? { templateId }
      : { OR: [{ templateId }, { templateStepId: { in: existingStepIds } }] },
  });
  if (referencedTaskCount > 0) {
    throw authoringRefusal(
      "template_in_use",
      `Template ${template.name} is already in use by a Task; clone it again before editing`,
    );
  }

  const normalizedSteps: TemplateAuthoringStep[] = input.steps.map((step, index) => ({
    ...step,
    stepIndex: index + 1,
    spawnPolicy: step.spawnPolicy as Prisma.JsonValue,
  }));
  const assigneeIds = [...new Set(normalizedSteps.flatMap((step) => (
    step.assigneeAgentId === null ? [] : [step.assigneeAgentId]
  )))];
  // Authoring has no Repo context and therefore does not lock or validate
  // Agent rows. It still supplies the pure validator with every referenced
  // fact, including rows outside this project, for its later assignee checks.
  const agentRows = assigneeIds.length === 0
    ? []
    : await tx.agent.findMany({
      where: { id: { in: assigneeIds } },
      select: { id: true, name: true, projectId: true, archivedAt: true },
    });
  const agents = new Map(agentRows.map((agent) => [agent.id, agent]));
  const validation = validateTemplateGraph(normalizedSteps, agents);
  if (validation.refusal) throw validation.refusal;

  await tx.taskTemplateStep.deleteMany({ where: { taskTemplateId: templateId } });
  if (normalizedSteps.length > 0) {
    await tx.taskTemplateStep.createMany({
      data: normalizedSteps.map((step) => ({
        taskTemplateId: templateId,
        stepIndex: step.stepIndex,
        name: step.name,
        assigneeType: step.assigneeType,
        assigneeAgentId: step.assigneeAgentId,
        prompt: step.prompt,
        approvalGate: step.approvalGate,
        attachmentsFromPrevious: step.attachmentsFromPrevious,
        priorOutputKinds: step.priorOutputKinds,
        spawnPolicy: cloneJson(step.spawnPolicy),
        runner: step.runner,
        outputKind: step.outputKind,
        opensPullRequest: step.opensPullRequest,
        requiresCommit: step.requiresCommit,
        baseFromStepIndex: step.baseFromStepIndex,
        layer: step.layer,
      })),
    });
  }

  const savedTemplate = await tx.taskTemplate.findUniqueOrThrow({
    where: { id: templateId },
    include: {
      steps: {
        include: { assigneeAgent: true },
        orderBy: { stepIndex: "asc" },
      },
    },
  });
  return { template: savedTemplate, warnings: validation.warnings };
});
