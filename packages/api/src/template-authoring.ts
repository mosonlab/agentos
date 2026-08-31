import {
  canonicalTemplateIdentity,
  integratorBindingRefusal,
  lockTemplateRow,
  lockTemplateStepRows,
  Prisma,
  stepRole,
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
  stepIndex?: number,
): TemplateAuthoringRefusal => new TemplateAuthoringRefusal(code, message, stepIndex);

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
  agents: ReadonlyMap<string, TemplateAuthoringAgent>,
  projectId?: string,
): TemplateGraphValidation => {
  // 1. graph_empty.
  if (steps.length === 0) {
    return {
      refusal: authoringRefusal("graph_empty", "Template graph must contain at least one step"),
      warnings: [],
    };
  }

  // 2. first_step_not_agent. The first Step is the only one that can be
  // started without a predecessor, so it must be executable by an Agent.
  const first = steps[0]!;
  if (first.assigneeType !== "AGENT") {
    return {
      refusal: authoringRefusal(
        "first_step_not_agent",
        "The first template step must be agent-executable",
        first.stepIndex,
      ),
      warnings: [],
    };
  }

  // 3. first_layer_not_single. A parallel first layer has no unique starting
  // Step and therefore cannot be materialized as a runnable graph.
  const firstLayerSteps = steps.filter((step) => step.layer === first.layer);
  if (firstLayerSteps.length > 1) {
    return {
      refusal: authoringRefusal(
        "first_layer_not_single",
        "The first template layer must contain exactly one step",
        firstLayerSteps[1]!.stepIndex,
      ),
      warnings: [],
    };
  }

  // 4. layer_order_invalid. Step indexes are assigned from array order, so a
  // lower layer after a higher one is the first offending position.
  for (let index = 1; index < steps.length; index += 1) {
    const previous = steps[index - 1]!;
    const current = steps[index]!;
    if (current.layer < previous.layer) {
      return {
        refusal: authoringRefusal(
          "layer_order_invalid",
          `Template step ${current.stepIndex} layer ${current.layer} must not precede layer ${previous.layer}`,
          current.stepIndex,
        ),
        warnings: [],
      };
    }
  }

  // 5. base_step_invalid. A base is a positional reference, but its semantic
  // contract is stricter: it must point to an earlier Step in a lower layer.
  const stepsByIndex = new Map(steps.map((step) => [step.stepIndex, step]));
  for (const step of steps) {
    if (step.baseFromStepIndex === null) continue;
    const base = stepsByIndex.get(step.baseFromStepIndex);
    if (!base || base.stepIndex >= step.stepIndex || base.layer >= step.layer) {
      return {
        refusal: authoringRefusal(
          "base_step_invalid",
          `Template step ${step.stepIndex} baseFromStepIndex must reference an earlier step in a strictly lower layer`,
          step.stepIndex,
        ),
        warnings: [],
      };
    }
  }

  // 6. prior_kind_unproduced. A prior attachment is available only when a
  // producer has completed an earlier layer. Unknown kinds are fine when they
  // are not consumed; this check only rejects a missing producer for a kind a
  // Step explicitly names.
  for (const step of steps) {
    for (const priorKind of step.priorOutputKinds) {
      const producedEarlier = steps.some((candidate) => (
        candidate.outputKind === priorKind && candidate.layer < step.layer
      ));
      if (!producedEarlier) {
        return {
          refusal: authoringRefusal(
            "prior_kind_unproduced",
            `Template step ${step.stepIndex} prior output kind ${priorKind} is not produced in an earlier layer`,
            step.stepIndex,
          ),
          warnings: [],
        };
      }
    }
  }

  // 7. output_kind_duplicate. Output kinds identify the attachment a consumer
  // receives, so one producer must own each kind. The later producer is the
  // offending Step.
  const outputKinds = new Set<string>();
  for (const step of steps) {
    if (outputKinds.has(step.outputKind)) {
      return {
        refusal: authoringRefusal(
          "output_kind_duplicate",
          `Template step ${step.stepIndex} duplicates output kind ${step.outputKind}`,
          step.stepIndex,
        ),
        warnings: [],
      };
    }
    outputKinds.add(step.outputKind);
  }

  // 8. prior_kind_duplicate. A duplicate declaration in one Step is a typo,
  // even if a valid producer exists for that kind.
  for (const step of steps) {
    const priorKinds = new Set<string>();
    for (const priorKind of step.priorOutputKinds) {
      if (priorKinds.has(priorKind)) {
        return {
          refusal: authoringRefusal(
            "prior_kind_duplicate",
            `Template step ${step.stepIndex} declares prior output kind ${priorKind} more than once`,
            step.stepIndex,
          ),
          warnings: [],
        };
      }
      priorKinds.add(priorKind);
    }
  }

  // 9. approval_gate_in_parallel_layer. Approval is a single decision point;
  // placing it alongside another Step would leave the layer with no unique
  // gate owner.
  const layerSizes = new Map<number, number>();
  for (const step of steps) layerSizes.set(step.layer, (layerSizes.get(step.layer) ?? 0) + 1);
  for (const step of steps) {
    if (step.approvalGate && (layerSizes.get(step.layer) ?? 0) > 1) {
      return {
        refusal: authoringRefusal(
          "approval_gate_in_parallel_layer",
          `Template step ${step.stepIndex} cannot carry an approval gate in a parallel layer`,
          step.stepIndex,
        ),
        warnings: [],
      };
    }
  }

  // 10. assignee_invalid. Authoring validates only identity facts that are
  // independent of a Repo. Repo grants remain an instantiation concern.
  for (const step of steps) {
    const agent = step.assigneeAgentId === null ? undefined : agents.get(step.assigneeAgentId);
    const invalid = step.assigneeType === "HUMAN"
      ? step.assigneeAgentId !== null
      : step.assigneeAgentId === null
        || agent === undefined
        || agent.archivedAt !== null
        || (projectId !== undefined && agent.projectId !== projectId);
    if (invalid) {
      return {
        refusal: authoringRefusal(
          "assignee_invalid",
          `Agent assignment for template step ${step.stepIndex} is missing, archived, cross-project, or otherwise invalid`,
          step.stepIndex,
        ),
        warnings: [],
      };
    }
  }

  // 11. integrator_binding_invalid. This delegates the bidirectional sentinel
  // invariant to the platform's canonical predicate; authoring must not grow
  // a second, subtly different interpretation of the merge Step.
  for (const step of steps) {
    const agentName = step.assigneeAgentId === null
      ? null
      : agents.get(step.assigneeAgentId)?.name ?? null;
    const bindingRefusal = integratorBindingRefusal(agentName, {
      stepIndex: step.stepIndex,
      outputKind: step.outputKind,
    });
    if (bindingRefusal) {
      return {
        refusal: authoringRefusal(
          "integrator_binding_invalid",
          `Template step ${step.stepIndex}: ${bindingRefusal}`,
          step.stepIndex,
        ),
        warnings: [],
      };
    }
  }

  // Warnings are deliberately computed only after every blocking check has
  // passed. They describe the graph being saved and are returned in a stable,
  // complete order; the replace transaction never writes them anywhere.
  const reviewSteps = steps.filter((step) => {
    const role = stepRole({ outputKind: step.outputKind });
    return role === "sol-findings" || role === "blind-findings";
  });
  const warnings: TemplateAuthoringWarning[] = [];
  if (reviewSteps.length === 0) {
    warnings.push({
      code: "no_review_step",
      message: "Template graph has no review step",
    });
  }

  const implementationAgentIds = new Set(
    steps
      .filter((step) => {
        const role = stepRole({ outputKind: step.outputKind });
        return role === "implementation" || role === "fixed-implementation";
      })
      .flatMap((step) => step.assigneeAgentId === null ? [] : [step.assigneeAgentId]),
  );
  const selfReview = reviewSteps.some((step) => (
    step.assigneeAgentId !== null && implementationAgentIds.has(step.assigneeAgentId)
  ));
  if (selfReview) {
    warnings.push({
      code: "same_agent_implements_and_reviews",
      message: "One Agent implements and reviews the same template graph",
    });
  }

  const regressionStep = steps.find((step) => stepRole({ outputKind: step.outputKind }) === "regression");
  const pullRequestStep = steps.find((step) => step.opensPullRequest);
  if (pullRequestStep && !regressionStep) {
    warnings.push({
      code: "pull_request_without_regression",
      message: `Template step ${pullRequestStep.stepIndex} opens a pull request but the graph has no regression step`,
      stepIndex: pullRequestStep.stepIndex,
    });
  }

  return { refusal: null, warnings };
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
  const validation = validateTemplateGraph(normalizedSteps, agents, projectId);
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
