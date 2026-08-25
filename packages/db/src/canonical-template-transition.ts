import { isDeepStrictEqual } from "node:util";

import { AssigneeType, Prisma } from "@prisma/client";

import type { TemplateStepSource } from "./template-sources.js";

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

const LEASE_PROMPT_STEP = new Map([
  ["compound-engineer-workflow", 11],
  ["direct-engineer-workflow", 6],
]);

const LEASE_FETCH_PROMPT = `text. Refresh \`{{branchName}}\` onto it before reviewing: before the first fetch,
acquire the chain merge lease with \`scripts/merge-lease.sh acquire --task {{chainId}} --reason "chain merge tail {{chainId}}"\`.
An acquire timeout (exit 75) or any other acquire error fails the run loudly.
Fetch \`origin/<run.pullRequestBase>\`; if it fails, retry it up to three times
before failing the run loudly. Then record its exact 40-hex head as \`baseHeadSha\` and
merge that commit into the checked-out chain branch with a normal merge commit.
If Git reports a conflict, record both pre-refresh head SHAs,`;

const PRE_LEASE_FETCH_PROMPT = `text. Refresh \`{{branchName}}\` onto it before reviewing: fetch
\`origin/<run.pullRequestBase>\`, record its exact 40-hex head as \`baseHeadSha\`,
then merge that commit into the checked-out chain branch with a normal merge
commit. If Git reports a conflict, record both pre-refresh head SHAs,`;

const DISPATCH_RETRY_PROMPT = `If dispatch exits 75 or 76 without a verdict, retry dispatch in place up to two
more times. If all three attempts return a non-verdict exit, or dispatch returns
any other non-verdict exit, report it through the activity log and fail the run
loudly.
`;

export const previousChainLeasePrompt = (prompt: string): string => prompt
  .replace(LEASE_FETCH_PROMPT, PRE_LEASE_FETCH_PROMPT)
  .replace(DISPATCH_RETRY_PROMPT, "")
  .replace(
    "No other output shape advances the chain. A non-verdict gate exit is neither\nPASS nor FAIL.\n",
    "No other output shape advances the chain. A non-verdict gate exit is neither\nPASS nor FAIL: report it through the activity log and fail the run loudly.\n",
  );

export const legacyChainLeaseTemplateName = (templateName: string, templateId: string): string =>
  `${templateName}-legacy-pre-merge-lease-${templateId}`;

export const isPreChainLeaseTemplate = (
  templateName: string,
  steps: readonly PersistedTransitionStep[],
  canonical: readonly TemplateStepSource[],
): boolean => {
  const transitionIndex = LEASE_PROMPT_STEP.get(templateName);
  if (!transitionIndex || steps.length !== canonical.length) return false;
  const ordered = [...steps].sort((left, right) => left.stepIndex - right.stepIndex);
  return ordered.every((step, index) => {
    const expected = canonical[index];
    if (!expected || step.stepIndex !== expected.stepIndex) return false;
    const expectedPrompt = expected.stepIndex === transitionIndex
      ? previousChainLeasePrompt(expected.prompt)
      : expected.prompt;
    return (step.assigneeAgent?.name ?? null) === expected.agentName
      && step.assigneeType === (expected.agentName === null ? AssigneeType.HUMAN : AssigneeType.AGENT)
      && step.layer === expected.layer
      && step.approvalGate === expected.approvalGate
      && step.outputKind === expected.outputKind
      && step.attachmentsFromPrevious === expected.attachmentsFromPrevious
      && step.opensPullRequest === expected.opensPullRequest
      && step.baseFromStepIndex === expected.baseFromStepIndex
      && isDeepStrictEqual(step.spawnPolicy, expected.spawnPolicy)
      && step.prompt === expectedPrompt;
  });
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
