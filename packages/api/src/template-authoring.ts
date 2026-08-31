import {
  canonicalTemplateIdentity,
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
