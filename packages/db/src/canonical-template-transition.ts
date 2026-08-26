import { AssigneeType, Prisma, RunStatus } from "@prisma/client";

type LegacyStepTuple = readonly [
  string,
  AssigneeType,
  boolean,
  string,
  boolean,
  boolean,
  number | null,
  number,
];

/**
 * Every retired canonical graph, keyed by the marker its renamed rows carry.
 * These are intentionally a closed contract: a row with the canonical name is
 * either one of these exact graphs or the current source graph. It is never
 * guessed at and it is never linearized as a fallback.
 *
 * `pre-narrow-regression-lease`: the v1 Regression graphs that acquired before
 * semantic verification and let a model share the lease protocol.
 * `pre-adjudication`: the graphs that existed immediately before the
 * adjudication node was removed.
 * `pre-zero-gate`: the compound graph that existed immediately before the
 * spec and revise-plan approval gates were removed (2026-08-26 ruling); the
 * direct graph did not change in that transition.
 */
const LEGACY_TEMPLATE_GENERATIONS: Record<string, ReadonlyArray<{
  marker: string;
  shape: readonly LegacyStepTuple[];
}>> = {
  "direct-engineer-workflow": [
    {
      marker: "pre-narrow-regression-lease",
      shape: [
        ["senior-dev-luna", AssigneeType.AGENT, false, "implementation", false, true, null, 1],
        ["review-coordinator-sol", AssigneeType.AGENT, false, "sol-findings", true, false, 1, 2],
        ["review-coordinator-opus", AssigneeType.AGENT, false, "blind-findings", false, false, 1, 2],
        ["senior-dev", AssigneeType.AGENT, false, "fixed-implementation", true, false, null, 3],
        ["regression-verifier", AssigneeType.AGENT, false, "regression-verification", true, false, null, 4],
        ["review-coordinator", AssigneeType.AGENT, false, "merge-authorization", true, false, null, 5],
        ["merge-integrator", AssigneeType.AGENT, false, "merge-result", true, false, null, 6],
      ],
    },
    {
      marker: "pre-adjudication",
      shape: [
        ["senior-dev-luna", AssigneeType.AGENT, false, "implementation", false, true, null, 1],
        ["review-coordinator-sol", AssigneeType.AGENT, false, "sol-findings", true, false, 1, 2],
        ["review-coordinator-opus", AssigneeType.AGENT, false, "blind-findings", false, false, 1, 2],
        ["review-adjudicator-opus", AssigneeType.AGENT, false, "must-fix", true, false, 1, 3],
        ["senior-dev", AssigneeType.AGENT, false, "fixed-implementation", true, false, null, 4],
        ["regression-verifier", AssigneeType.AGENT, false, "regression-verification", true, false, null, 5],
        ["review-coordinator", AssigneeType.AGENT, false, "merge-authorization", true, false, null, 6],
        ["merge-integrator", AssigneeType.AGENT, false, "merge-result", true, false, null, 7],
      ],
    },
  ],
  "compound-engineer-workflow": [
    {
      marker: "pre-narrow-regression-lease",
      shape: [
        ["spec", AssigneeType.AGENT, false, "spec", false, false, null, 1],
        ["plan", AssigneeType.AGENT, false, "plan", true, false, null, 2],
        ["review-coordinator", AssigneeType.AGENT, false, "plan-review", true, false, null, 3],
        ["plan-reviser", AssigneeType.AGENT, false, "revised-plan", true, false, null, 4],
        ["implementation-plan-executioner", AssigneeType.AGENT, false, "implementation", true, true, null, 5],
        ["review-coordinator-sol", AssigneeType.AGENT, false, "sol-findings", true, false, 5, 6],
        ["review-coordinator-opus", AssigneeType.AGENT, false, "blind-findings", false, false, 5, 6],
        ["senior-dev", AssigneeType.AGENT, false, "fixed-implementation", true, false, null, 7],
        ["librarian", AssigneeType.AGENT, false, "documentation", true, false, null, 8],
        ["regression-verifier", AssigneeType.AGENT, false, "regression-verification", true, false, null, 9],
        ["review-coordinator", AssigneeType.AGENT, false, "merge-authorization", true, false, null, 10],
        ["merge-integrator", AssigneeType.AGENT, false, "merge-result", true, false, null, 11],
      ],
    },
    {
      marker: "pre-adjudication",
      shape: [
        ["spec", AssigneeType.AGENT, true, "spec", false, false, null, 1],
        ["plan", AssigneeType.AGENT, false, "plan", true, false, null, 2],
        ["review-coordinator", AssigneeType.AGENT, false, "plan-review", true, false, null, 3],
        ["plan-reviser", AssigneeType.AGENT, true, "revised-plan", true, false, null, 4],
        ["implementation-plan-executioner", AssigneeType.AGENT, false, "implementation", true, true, null, 5],
        ["review-coordinator-sol", AssigneeType.AGENT, false, "sol-findings", true, false, 5, 6],
        ["review-coordinator-opus", AssigneeType.AGENT, false, "blind-findings", false, false, 5, 6],
        ["review-adjudicator-opus", AssigneeType.AGENT, false, "must-fix", true, false, 5, 7],
        ["senior-dev", AssigneeType.AGENT, false, "fixed-implementation", true, false, null, 8],
        ["librarian", AssigneeType.AGENT, false, "documentation", true, false, null, 9],
        ["regression-verifier", AssigneeType.AGENT, false, "regression-verification", true, false, null, 10],
        ["review-coordinator", AssigneeType.AGENT, false, "merge-authorization", true, false, null, 11],
        ["merge-integrator", AssigneeType.AGENT, false, "merge-result", true, false, null, 12],
      ],
    },
    {
      marker: "pre-zero-gate",
      shape: [
        ["spec", AssigneeType.AGENT, true, "spec", false, false, null, 1],
        ["plan", AssigneeType.AGENT, false, "plan", true, false, null, 2],
        ["review-coordinator", AssigneeType.AGENT, false, "plan-review", true, false, null, 3],
        ["plan-reviser", AssigneeType.AGENT, true, "revised-plan", true, false, null, 4],
        ["implementation-plan-executioner", AssigneeType.AGENT, false, "implementation", true, true, null, 5],
        ["review-coordinator-sol", AssigneeType.AGENT, false, "sol-findings", true, false, 5, 6],
        ["review-coordinator-opus", AssigneeType.AGENT, false, "blind-findings", false, false, 5, 6],
        ["senior-dev", AssigneeType.AGENT, false, "fixed-implementation", true, false, null, 7],
        ["librarian", AssigneeType.AGENT, false, "documentation", true, false, null, 8],
        ["regression-verifier", AssigneeType.AGENT, false, "regression-verification", true, false, null, 9],
        ["review-coordinator", AssigneeType.AGENT, false, "merge-authorization", true, false, null, 10],
        ["merge-integrator", AssigneeType.AGENT, false, "merge-result", true, false, null, 11],
      ],
    },
  ],
};

/**
 * The rename target is minted per row and per generation: fixed identities
 * like `-legacy-v1` are already taken by older graphs, so each retired
 * generation needs an identity of its own to roll over onto.
 */
export const legacyTemplateName = (templateName: string, marker: string, templateId: string): string =>
  `${templateName}-legacy-${marker}-${templateId}`;

export const TEMPLATE_ROLLOVER_ACTIVE_RUN_STATUSES = [
  RunStatus.QUEUED,
  RunStatus.CLAIMED,
  RunStatus.PROVISIONING,
  RunStatus.RUNNING,
  RunStatus.WAITING_INBOX,
] as const;

/**
 * A quiescent chain may move under a legacy template name without changing any
 * task or step identity. Its tasks keep the retired graph and runtime contract;
 * only new chains bind the replacement graph. Active Runs and unfinished work
 * that has no chain identity remain blockers.
 */
export const templateRolloverBlockerCount = (
  tasks: readonly {
    chainId: string | null;
    activeRunCount: number;
  }[],
): number => tasks.filter((task) => task.activeRunCount > 0 || task.chainId === null).length;

/** The adjudication-era rename, kept for the rows and fixtures already carrying it. */
export const legacyAdjudicationTemplateName = (templateName: string, templateId: string): string =>
  legacyTemplateName(templateName, "pre-adjudication", templateId);

export type PersistedTransitionStep = {
  id: string;
  taskTemplateId: string;
  stepIndex: number;
  name: string;
  assigneeAgent: { name: string } | null;
  assigneeType: string;
  layer?: number | null;
  approvalGate: boolean;
  outputKind: string;
  attachmentsFromPrevious: boolean;
  opensPullRequest: boolean;
  baseFromStepIndex: number | null;
  spawnPolicy: Prisma.JsonValue;
  prompt: string;
  _count?: { tasks: number };
};

const shapeMatches = (
  steps: readonly PersistedTransitionStep[],
  expected: readonly LegacyStepTuple[],
): boolean => {
  if (steps.length !== expected.length) return false;
  const ordered = [...steps].sort((left, right) => left.stepIndex - right.stepIndex);
  if (ordered.some((step, index) => step.stepIndex !== index + 1)) return false;
  for (const [index, step] of ordered.entries()) {
    const [agentName, assigneeType, approvalGate, outputKind, attachmentsFromPrevious, opensPullRequest, baseFromStepIndex, layer] = expected[index]!;
    if ((step.assigneeAgent?.name ?? null) !== agentName
      || step.assigneeType !== assigneeType
      || step.approvalGate !== approvalGate
      || step.outputKind !== outputKind
      || step.attachmentsFromPrevious !== attachmentsFromPrevious
      || step.opensPullRequest !== opensPullRequest
      || step.baseFromStepIndex !== baseFromStepIndex
      || step.layer !== layer
      || step.spawnPolicy !== null) {
      return false;
    }
  }
  return true;
};

/**
 * The marker of the retired generation this persisted graph is, or null when
 * it is none of them (the caller then checks it against the current source
 * graph). Generations never overlap: each transition changed at least one
 * compared field, so at most one shape can match.
 */
export const matchedLegacyGeneration = (
  templateName: string,
  steps: readonly PersistedTransitionStep[],
): string | null => {
  const generations = LEGACY_TEMPLATE_GENERATIONS[templateName];
  if (!generations) return null;
  return generations.find((generation) => shapeMatches(steps, generation.shape))?.marker ?? null;
};

/**
 * Return a named refusal reason when a canonical row is neither an exact
 * retired graph nor the exact current graph. The caller runs this for every row before
 * renaming or creating anything, so a refusal rolls back as an all-or-none
 * transition and cannot leave a half-installed template set.
 */
export const legacyTemplateShapeRefusal = (
  templateName: string,
  steps: readonly PersistedTransitionStep[],
): string | null => {
  if (!LEGACY_TEMPLATE_GENERATIONS[templateName]) return `unknown canonical template ${templateName}`;
  return matchedLegacyGeneration(templateName, steps) === null ? null : "legacy";
};
