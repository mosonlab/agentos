import { AssigneeType, Prisma } from "@prisma/client";

/**
 * The two graphs that existed immediately before the layered review split.
 * These are intentionally a closed contract: a row with the canonical name
 * is either one of these exact legacy graphs or the current source graph. It
 * is never guessed at and it is never linearized as a fallback.
 */
const LEGACY_TEMPLATE_SHAPES = {
  "direct-engineer-workflow": [
    ["senior-dev-luna", AssigneeType.AGENT, false, "implementation", false, true, null, 1],
    ["review-coordinator-sol", AssigneeType.AGENT, false, "sol-findings", true, false, 1, 2],
    ["review-coordinator-opus", AssigneeType.AGENT, false, "must-fix", false, false, 1, 3],
    ["senior-dev", AssigneeType.AGENT, false, "fixed-implementation", true, false, null, 4],
    ["regression-verifier", AssigneeType.AGENT, false, "regression-verification", true, false, null, 5],
    ["review-coordinator", AssigneeType.AGENT, false, "merge-authorization", true, false, null, 6],
    ["merge-integrator", AssigneeType.AGENT, false, "merge-result", true, false, null, 7],
  ],
  "compound-engineer-workflow": [
    ["spec", AssigneeType.AGENT, true, "spec", false, false, null, 1],
    ["plan", AssigneeType.AGENT, false, "plan", true, false, null, 2],
    ["review-coordinator", AssigneeType.AGENT, false, "plan-review", true, false, null, 3],
    ["plan-reviser", AssigneeType.AGENT, true, "revised-plan", true, false, null, 4],
    ["implementation-plan-executioner", AssigneeType.AGENT, false, "implementation", true, true, null, 5],
    ["review-coordinator-sol", AssigneeType.AGENT, false, "sol-findings", true, false, 5, 6],
    ["review-coordinator-opus", AssigneeType.AGENT, false, "must-fix", false, false, 5, 7],
    ["senior-dev", AssigneeType.AGENT, false, "fixed-implementation", true, false, null, 8],
    ["regression-verifier", AssigneeType.AGENT, false, "regression-verification", true, false, null, 9],
    ["librarian", AssigneeType.AGENT, false, "documentation", true, false, null, 10],
    ["review-coordinator", AssigneeType.AGENT, false, "merge-authorization", true, false, null, 11],
    ["merge-integrator", AssigneeType.AGENT, false, "merge-result", true, false, null, 12],
  ],
} as const;

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

const legacyShapeFor = (templateName: string): readonly (readonly [
  string,
  AssigneeType,
  boolean,
  string,
  boolean,
  boolean,
  number | null,
  number,
])[] | null => {
  if (templateName === "direct-engineer-workflow" || templateName === "compound-engineer-workflow") {
    return LEGACY_TEMPLATE_SHAPES[templateName];
  }
  return null;
};

/**
 * Return a named refusal reason when a canonical row is neither the exact old
 * graph nor the exact current graph. The caller runs this for every row before
 * renaming or creating anything, so a refusal rolls back as an all-or-none
 * transition and cannot leave a half-installed template set.
 */
export const legacyTemplateShapeRefusal = (
  templateName: string,
  steps: readonly PersistedTransitionStep[],
): string | null => {
  const expected = legacyShapeFor(templateName);
  if (!expected) return `unknown canonical template ${templateName}`;
  if (steps.length !== expected.length) return null;
  const ordered = [...steps].sort((left, right) => left.stepIndex - right.stepIndex);
  if (ordered.some((step, index) => step.stepIndex !== index + 1)) return null;
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
      return null;
    }
  }
  return "legacy";
};
