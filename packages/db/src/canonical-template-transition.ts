import { createHash } from "node:crypto";

import { AssigneeType, Prisma, RunStatus } from "@prisma/client";

export type LegacyStepTuple = readonly [
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
 * `pre-blind-review-retirement`: the graphs that existed immediately before the
 * merge tail's independent blind review and the release-authority signature
 * layer were retired (2026-08-26 ruling). This is the first generation whose
 * structure is identical to its successor's; it is told apart by
 * `promptDigest`, and the note on that field explains why that is sound.
 */
export type LegacyTemplateGeneration = Readonly<{
  marker: string;
  shape: readonly LegacyStepTuple[];
  /**
   * The prompt generation this entry retires, as a digest over its ordered step
   * prompts, or absent when the structure alone identifies it.
   *
   * A structural change is its own evidence that a graph was retired, so the
   * generations that carry one need nothing more. A prompt-only change is not:
   * the outgoing and incoming graphs have identical structure, so without this
   * field the successor would match its own predecessor's entry and every sync
   * would roll the row over again, forever.
   *
   * Registering it stays a deliberate act. This is not "the prompt changed, so
   * roll" -- nothing computes a rollover from drift. An operator writes the
   * outgoing generation's digest here by hand, exactly as they write a shape,
   * and a prompt edit with no entry still refuses the deploy rather than
   * migrating anything on its own.
   */
  promptDigest?: string;
  /**
   * The prompt generation this entry rolls *forward to*, as the same digest
   * over the successor's ordered step prompts.
   *
   * `promptDigest` authenticates the row being retired. On its own that is only
   * half the transition: it says nothing about what the source tree happens to
   * contain when the rollover finally runs. If the prompts were edited again
   * between registering this entry and deploying it, the rename would still
   * fire and would install whatever the tree now holds -- the unregistered edit
   * would ride in on the registered one's authority.
   *
   * Pinning the successor closes that. The rollover verifies the source against
   * this digest before renaming anything, and a mismatch is refused exactly
   * like any other unregistered drift.
   */
  successorPromptDigest?: string;
}>;

export const LEGACY_TEMPLATE_GENERATIONS: Readonly<Record<string, readonly LegacyTemplateGeneration[]>> = {
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
    {
      marker: "pre-blind-review-retirement",
      // Structurally identical to the current graph on purpose: this transition
      // changed prompts only. `promptDigest` is what tells the two apart.
      promptDigest: "1b2447559a77e28added3509a6f6b17bce8a8cd7db9113bdaaa17d581d874165",
      successorPromptDigest: "4bc4d5f6c52945efe767205d1205a3914e50d3d5ef74c85eca05b3704482adf9",
      shape: [
        ["senior-dev-luna", AssigneeType.AGENT, false, "implementation", false, true, null, 1],
        ["review-coordinator-sol", AssigneeType.AGENT, false, "sol-findings", true, false, 1, 2],
        ["review-coordinator-opus", AssigneeType.AGENT, false, "blind-findings", false, false, 1, 2],
        ["senior-dev", AssigneeType.AGENT, false, "fixed-implementation", true, false, null, 3],
        ["regression-verifier", AssigneeType.AGENT, false, "regression-verification-v2", true, false, null, 4],
        ["review-coordinator", AssigneeType.AGENT, false, "merge-authorization", true, false, null, 5],
        ["merge-integrator", AssigneeType.AGENT, false, "merge-result", true, false, null, 6],
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
    {
      marker: "pre-blind-review-retirement",
      // Structurally identical to the current graph on purpose: this transition
      // changed prompts only. `promptDigest` is what tells the two apart.
      promptDigest: "a9994d131d1cf2667c6d61cc7161f5653cf9903a6aae77ed55c18b1db6fb3cf2",
      successorPromptDigest: "f7635395085052a8f613a65a7e7c11f1389abd950fa624409eb52cac3133fa14",
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
        ["regression-verifier", AssigneeType.AGENT, false, "regression-verification-v2", true, false, null, 9],
        ["review-coordinator", AssigneeType.AGENT, false, "merge-authorization", true, false, null, 10],
        ["merge-integrator", AssigneeType.AGENT, false, "merge-result", true, false, null, 11],
      ],
    },
  ],
};

/**
 * The prompt generation of an ordered step set, as one digest.
 *
 * Ordering is by `stepIndex` rather than by array order so a caller cannot
 * change the answer by handing the same graph back in a different order, and
 * each step contributes its index as well as its text so that moving a prompt
 * between two steps is a different generation from leaving it in place. The
 * separators are NUL because a prompt body can contain any printable run,
 * including one that would otherwise let two different step sets serialize to
 * the same bytes.
 */
export const templatePromptGenerationDigest = (
  steps: readonly { stepIndex: number; prompt: string }[],
): string => {
  const hash = createHash("sha256");
  for (const step of [...steps].sort((left, right) => left.stepIndex - right.stepIndex)) {
    hash.update(`${String(step.stepIndex)}\u0000${step.prompt}\u0000`);
  }
  return hash.digest("hex");
};

export const legacyGenerationMarkerForTemplateName = (templateName: string): string | null => {
  for (const [canonicalName, generations] of Object.entries(LEGACY_TEMPLATE_GENERATIONS)) {
    for (const generation of generations) {
      if (templateName.startsWith(`${canonicalName}-legacy-${generation.marker}-`)) return generation.marker;
    }
  }
  return null;
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
  priorOutputKinds: string[];
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
 * graph).
 *
 * Generations never overlap. A generation that changed the shape is told apart
 * by the shape; a generation that changed only the prompts is told apart by
 * `promptDigest`, which its successor by construction does not share. So at
 * most one entry can match, and the current source graph matches none.
 */
/**
 * A named reason the source graph is not the successor a matched generation was
 * registered to roll forward to, or null when it is.
 *
 * Only entries that pin a successor are checked. A structural generation is
 * already authenticated by the shape the source has to match, and entries
 * predating this field keep their previous behaviour.
 */
export const successorPromptDrift = (
  templateName: string,
  marker: string,
  sourceSteps: readonly { stepIndex: number; prompt: string }[],
): string | null => {
  const generation = LEGACY_TEMPLATE_GENERATIONS[templateName]?.find((candidate) => candidate.marker === marker);
  if (!generation?.successorPromptDigest) return null;
  const actual = templatePromptGenerationDigest(sourceSteps);
  if (actual === generation.successorPromptDigest) return null;
  return `${templateName} rollover ${marker} is registered to install prompt generation ${generation.successorPromptDigest}, but the source tree holds ${actual}`;
};

export const legacyGenerationMatches = (
  generation: LegacyTemplateGeneration,
  steps: readonly PersistedTransitionStep[],
): boolean => {
  if (!shapeMatches(steps, generation.shape)) return false;
  // An entry without a digest is identified by its shape alone. An entry with
  // one is a prompt-only transition, whose successor has the same shape, so the
  // digest is the whole difference between "this is the graph we retired" and
  // "this is the graph that replaced it".
  if (generation.promptDigest === undefined) return true;
  return generation.promptDigest === templatePromptGenerationDigest(steps);
};

export const matchedLegacyGeneration = (
  templateName: string,
  steps: readonly PersistedTransitionStep[],
): string | null =>
  LEGACY_TEMPLATE_GENERATIONS[templateName]
    ?.find((generation) => legacyGenerationMatches(generation, steps))?.marker ?? null;

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
