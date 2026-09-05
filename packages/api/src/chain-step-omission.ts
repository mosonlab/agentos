import { Prisma, stepRole, type StepRole } from "@anneal/db";

type DbTx = Prisma.TransactionClient;

/**
 * Instantiation omits template steps for two unrelated reasons and stores
 * neither: the conditional revalidation step applies only to a Chain bound to
 * a predecessor task, and a project may skip every step the template marks
 * optional. An omitted step is the absence of a Task row, so the Chain's own
 * task rows are the only witness of it.
 *
 * This module owns both sides of that one fact. `templateStepInstantiation`
 * decides the omission; `chainStepPresence` reads it back. Absence stays the
 * truth deliberately: nothing can make a stored omission list disagree with
 * the tasks that actually exist.
 */

/** How a Chain stands with respect to one template step. */
export type ChainStepPresence =
  /** The template declares such a step and this Chain has a task for it. */
  | "instantiated"
  /** The template declares such a step and this Chain instantiated none. */
  | "omitted"
  /** The template declares no such step, so the Chain never could have one. */
  | "undeclared";

/**
 * The presence answer for one Chain, in the two vocabularies its readers hold:
 * a declared prior output kind, and a canonical step role. Readers decide
 * their own tolerance; `omitted` and `undeclared` are not interchangeable.
 */
export type ChainStepPresenceIndex = {
  ofKind(outputKind: string): ChainStepPresence;
  ofRole(role: StepRole): ChainStepPresence;
};

export const chainStepPresence = async (
  tx: DbTx,
  chain: { projectId: string; chainId: string; taskTemplateId: string },
): Promise<ChainStepPresenceIndex> => {
  const steps = await tx.taskTemplateStep.findMany({
    where: { taskTemplateId: chain.taskTemplateId },
    select: {
      outputKind: true,
      tasks: {
        where: { projectId: chain.projectId, chainId: chain.chainId },
        select: { id: true },
        take: 1,
      },
    },
  });
  const presenceOf = (declaring: typeof steps): ChainStepPresence => {
    if (declaring.length === 0) return "undeclared";
    return declaring.some(({ tasks }) => tasks.length > 0) ? "instantiated" : "omitted";
  };
  return {
    ofKind: (outputKind) => presenceOf(steps.filter((step) => step.outputKind === outputKind)),
    ofRole: (role) => presenceOf(steps.filter((step) => stepRole(step) === role)),
  };
};

/** What instantiation knows that decides whether a step is omitted. */
export type TemplateStepOmissionRules = {
  /** The template routes implementation; only that family carries the conditional revalidation step. */
  routesImplementation: boolean;
  /** The Chain dispatches on an existing task's completion (`afterTaskId`). */
  boundToPredecessor: boolean;
  /** The project skips every step its template marks optional. */
  skipOptionalSteps: boolean;
};

export type TemplateStepInstantiation<Step> = {
  /** The steps that get a Task row, in the template order they arrived in. */
  instantiated: Step[];
  /**
   * True when the conditional revalidation step was omitted. It is the first
   * ordinal of its template, so every retained step's chain ordinal shifts
   * down by one.
   */
  omittedConditionalRevalidation: boolean;
};

export const templateStepInstantiation = <Step extends { outputKind: string; optional: boolean }>(
  steps: readonly Step[],
  rules: TemplateStepOmissionRules,
): TemplateStepInstantiation<Step> => {
  // Exactly one step is conditional, so exactly one ordinal can be dropped:
  // the offset the caller applies to every retained ordinal is one, and a
  // template that declared a second revalidation step would need its own rule.
  const conditionalRevalidation = rules.routesImplementation && !rules.boundToPredecessor
    ? steps.find((step) => stepRole(step) === "revalidation") ?? null
    : null;
  return {
    instantiated: steps.filter((step) => {
      if (step === conditionalRevalidation) return false;
      if (rules.skipOptionalSteps && step.optional) return false;
      return true;
    }),
    omittedConditionalRevalidation: conditionalRevalidation !== null,
  };
};
