import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { AssigneeType, Prisma, RunStatus } from "@prisma/client";

import { PR_TEMPLATE_NAME } from "./agent-contract.js";
import { stepRole, type StepRole } from "./step-role.js";

export type LegacyStepRecord = Readonly<{
  name: string;
  agentName: string | null;
  assigneeType: AssigneeType;
  approvalGate: boolean;
  outputKind: string;
  attachmentsFromPrevious: boolean;
  opensPullRequest: boolean;
  baseFromStepIndex: number | null;
  layer: number;
  spawnPolicy: Prisma.JsonValue;
}>;

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
 * `pre-platform-spec-materialization`: the direct graph whose implementation
 * prompt still delegated exact specification transcription to the model.
 * `pre-internal-npm-scope-rename`: the graphs whose merge prompts still named
 * the retired first-party npm scope.
 * `pre-revalidate-step`: the direct graph before bound chains gained their
 * read-only revalidation node.
 * `pre-product-rename-anneal`: the graphs whose prompts still called the
 * platform by its former product name. Prompt-only in both templates.
 * `pre-pr-handover-quality`: the pull-request graph whose prompts still used
 * the placeholder delivery body and left chain bookkeeping in the published
 * tree.
 */
export type LegacyTemplateGeneration = Readonly<{
  marker: string;
  shape: readonly LegacyStepRecord[];
  /**
   * Structural successor ordinals for a generation whose replacement graph
   * has a different shape. Prompt-only transitions derive current ordinals
   * from their own shape; structural transitions state the replacement
   * explicitly so routing never reuses retired positions.
   */
  successorStepOrdinals?: CanonicalStepOrdinals;
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

const legacyTemplateGenerations = {
  "direct-engineer-workflow": [
    {
      marker: "pre-narrow-regression-lease",
      shape: [
        { name: "Implementation", agentName: "senior-dev-luna", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, opensPullRequest: true, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Code review (Sol)", agentName: "review-coordinator-sol", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Code review (Opus blind)", agentName: "review-coordinator-opus", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Apply review fixes", agentName: "senior-dev", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Regression verification", agentName: "regression-verifier", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Merge authorization", agentName: "review-coordinator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Merge execution", agentName: "merge-integrator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 6, spawnPolicy: null },
      ],
    },
    {
      marker: "pre-adjudication",
      shape: [
        { name: "Implementation", agentName: "senior-dev-luna", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, opensPullRequest: true, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Code review (Sol)", agentName: "review-coordinator-sol", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Code review (Opus blind)", agentName: "review-coordinator-opus", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Opus adjudication", agentName: "review-adjudicator-opus", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "must-fix", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 1, layer: 3, spawnPolicy: null },
        { name: "Apply review fixes", agentName: "senior-dev", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Regression verification", agentName: "regression-verifier", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Merge authorization", agentName: "review-coordinator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 6, spawnPolicy: null },
        { name: "Merge execution", agentName: "merge-integrator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
      ],
    },
    {
      marker: "pre-blind-review-retirement",
      // Structurally identical to the current graph on purpose: this transition
      // changed prompts only. `promptDigest` is what tells the two apart.
      promptDigest: "1b2447559a77e28added3509a6f6b17bce8a8cd7db9113bdaaa17d581d874165",
      successorPromptDigest: "c0ec5acb70b82b85bc3f3aff5840029a303d31e6098b7171a2bef35f105f3371",
      shape: [
        { name: "Implementation", agentName: "senior-dev-luna", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, opensPullRequest: true, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Code review (Sol)", agentName: "review-coordinator-sol", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Code review (Opus blind)", agentName: "review-coordinator-opus", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Apply review fixes", agentName: "senior-dev", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Regression verification", agentName: "regression-verifier", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Merge authorization", agentName: "review-coordinator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Merge execution", agentName: "merge-integrator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 6, spawnPolicy: null },
      ],
    },
    {
      marker: "pre-platform-spec-materialization",
      promptDigest: "c1a9ec1f8e783c3c814c0d0f5f4a9b91d5759b9dc39473dc200447aeb96677c5",
      successorPromptDigest: "c0ec5acb70b82b85bc3f3aff5840029a303d31e6098b7171a2bef35f105f3371",
      shape: [
        { name: "Implementation", agentName: "senior-dev-luna", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, opensPullRequest: true, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Code review (Sol)", agentName: "review-coordinator-sol", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Code review (Opus blind)", agentName: "review-coordinator-opus", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Apply review fixes", agentName: "senior-dev", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Regression verification", agentName: "regression-verifier", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Merge authorization", agentName: "review-coordinator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Merge execution", agentName: "merge-integrator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 6, spawnPolicy: null },
      ],
    },
    {
      // Prompt-only rollover: regression now delegates mechanical work to the
      // platform script while keeping the template graph unchanged.
      marker: "pre-regression-step-split",
      promptDigest: "a760a6ca04bc047b47831fc4a4064cf2157487142f32a480223d6b5d8187c4a1",
      successorPromptDigest: "c0ec5acb70b82b85bc3f3aff5840029a303d31e6098b7171a2bef35f105f3371",
      shape: [
        { name: "Implementation", agentName: "senior-dev-luna", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, opensPullRequest: true, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Code review (Sol)", agentName: "review-coordinator-sol", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Code review (Opus blind)", agentName: "review-coordinator-opus", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Apply review fixes", agentName: "senior-dev", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Regression verification", agentName: "regression-verifier", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Merge authorization", agentName: "review-coordinator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Merge execution", agentName: "merge-integrator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 6, spawnPolicy: null },
      ],
    },
    {
      marker: "pre-internal-npm-scope-rename",
      promptDigest: "3b50afcdd5aef2d0f06b00b7644cc67fac3ffbd29414e44564dc6aeb9757580d",
      successorPromptDigest: "c0ec5acb70b82b85bc3f3aff5840029a303d31e6098b7171a2bef35f105f3371",
      shape: [
        { name: "Implementation", agentName: "senior-dev-luna", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, opensPullRequest: true, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Code review (Sol)", agentName: "review-coordinator-sol", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Code review (Opus blind)", agentName: "review-coordinator-opus", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Apply review fixes", agentName: "senior-dev", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Regression verification", agentName: "regression-verifier", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Merge authorization", agentName: "review-coordinator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Merge execution", agentName: "merge-integrator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 6, spawnPolicy: null },
      ],
    },
    {
      // Structural rollover: the bound direct graph adds a read-only
      // revalidation node ahead of the historical seven-step graph. Existing
      // task and step rows stay under the renamed legacy template; only new
      // bound chains use the successor ordinals below.
      marker: "pre-revalidate-step",
      successorStepOrdinals: {
        revalidation: 1,
        implementation: 2,
        "sol-findings": 3,
        "blind-findings": 4,
        "fixed-implementation": 5,
        regression: 6,
        readiness: 7,
        integrator: 8,
      },
      shape: [
        { name: "Implementation", agentName: "senior-dev-luna", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, opensPullRequest: true, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Code review (Sol)", agentName: "review-coordinator-sol", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Code review (Opus blind)", agentName: "review-coordinator-opus", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Apply review fixes", agentName: "senior-dev", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Regression verification", agentName: "regression-verifier", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Merge authorization", agentName: "review-coordinator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Merge execution", agentName: "merge-integrator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 6, spawnPolicy: null },
      ],
    },
    {
      // Prompt-only, and the first direct entry to carry the bound eight-step
      // shape: the graphs it retires are the ones that already materialized the
      // revalidation node, so an unbound seven-step row still matches
      // `pre-revalidate-step` above and rolls over structurally as before.
      marker: "pre-product-rename-anneal",
      promptDigest: "0aa379a51d722ec9b8b5d91bc6158d9dd9a1f5d380b50695613d5aece9afda46",
      successorPromptDigest: "c0ec5acb70b82b85bc3f3aff5840029a303d31e6098b7171a2bef35f105f3371",
      shape: [
        { name: "Revalidate specification", agentName: "spec-revalidator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "revalidation", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Implementation", agentName: "senior-dev-luna", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, opensPullRequest: true, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Code review (Sol)", agentName: "review-coordinator-sol", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 2, layer: 3, spawnPolicy: null },
        { name: "Code review (Opus blind)", agentName: "review-coordinator-opus", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 2, layer: 3, spawnPolicy: null },
        { name: "Apply review fixes", agentName: "senior-dev", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Regression verification", agentName: "regression-verifier", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Merge authorization", agentName: "review-coordinator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 6, spawnPolicy: null },
        { name: "Merge execution", agentName: "merge-integrator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
      ],
    },
  ],
  "compound-engineer-workflow": [
    {
      marker: "pre-narrow-regression-lease",
      shape: [
        { name: "Write a spec", agentName: "spec", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "spec", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Plan", agentName: "plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Plan review", agentName: "review-coordinator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan-review", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Revise plan", agentName: "plan-reviser", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "revised-plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Implementation", agentName: "implementation-plan-executioner", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: true, opensPullRequest: true, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Code review (Sol)", agentName: "review-coordinator-sol", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Code review (Opus blind)", agentName: "review-coordinator-opus", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Apply review fixes", agentName: "senior-dev", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
        { name: "Librarian", agentName: "librarian", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "documentation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 8, spawnPolicy: null },
        { name: "Regression verification", agentName: "regression-verifier", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 9, spawnPolicy: null },
        { name: "Merge authorization", agentName: "review-coordinator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 10, spawnPolicy: null },
        { name: "Merge execution", agentName: "merge-integrator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 11, spawnPolicy: null },
      ],
    },
    {
      marker: "pre-adjudication",
      shape: [
        { name: "Write a spec", agentName: "spec", assigneeType: AssigneeType.AGENT, approvalGate: true, outputKind: "spec", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Plan", agentName: "plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Plan review", agentName: "review-coordinator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan-review", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Revise plan", agentName: "plan-reviser", assigneeType: AssigneeType.AGENT, approvalGate: true, outputKind: "revised-plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Implementation", agentName: "implementation-plan-executioner", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: true, opensPullRequest: true, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Code review (Sol)", agentName: "review-coordinator-sol", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Code review (Opus blind)", agentName: "review-coordinator-opus", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Opus adjudication", agentName: "review-adjudicator-opus", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "must-fix", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 5, layer: 7, spawnPolicy: null },
        { name: "Apply review fixes", agentName: "senior-dev", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 8, spawnPolicy: null },
        { name: "Librarian", agentName: "librarian", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "documentation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 9, spawnPolicy: null },
        { name: "Regression verification", agentName: "regression-verifier", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 10, spawnPolicy: null },
        { name: "Merge authorization", agentName: "review-coordinator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 11, spawnPolicy: null },
        { name: "Merge execution", agentName: "merge-integrator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 12, spawnPolicy: null },
      ],
    },
    {
      marker: "pre-zero-gate",
      shape: [
        { name: "Write a spec", agentName: "spec", assigneeType: AssigneeType.AGENT, approvalGate: true, outputKind: "spec", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Plan", agentName: "plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Plan review", agentName: "review-coordinator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan-review", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Revise plan", agentName: "plan-reviser", assigneeType: AssigneeType.AGENT, approvalGate: true, outputKind: "revised-plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Implementation", agentName: "implementation-plan-executioner", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: true, opensPullRequest: true, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Code review (Sol)", agentName: "review-coordinator-sol", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Code review (Opus blind)", agentName: "review-coordinator-opus", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Apply review fixes", agentName: "senior-dev", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
        { name: "Librarian", agentName: "librarian", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "documentation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 8, spawnPolicy: null },
        { name: "Regression verification", agentName: "regression-verifier", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 9, spawnPolicy: null },
        { name: "Merge authorization", agentName: "review-coordinator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 10, spawnPolicy: null },
        { name: "Merge execution", agentName: "merge-integrator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 11, spawnPolicy: null },
      ],
    },
    {
      marker: "pre-blind-review-retirement",
      // Structurally identical to the current graph on purpose: this transition
      // changed prompts only. `promptDigest` is what tells the two apart.
      promptDigest: "a9994d131d1cf2667c6d61cc7161f5653cf9903a6aae77ed55c18b1db6fb3cf2",
      successorPromptDigest: "f7635395085052a8f613a65a7e7c11f1389abd950fa624409eb52cac3133fa14",
      shape: [
        { name: "Write a spec", agentName: "spec", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "spec", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Plan", agentName: "plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Plan review", agentName: "review-coordinator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan-review", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Revise plan", agentName: "plan-reviser", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "revised-plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Implementation", agentName: "implementation-plan-executioner", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: true, opensPullRequest: true, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Code review (Sol)", agentName: "review-coordinator-sol", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Code review (Opus blind)", agentName: "review-coordinator-opus", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Apply review fixes", agentName: "senior-dev", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
        { name: "Librarian", agentName: "librarian", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "documentation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 8, spawnPolicy: null },
        { name: "Regression verification", agentName: "regression-verifier", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 9, spawnPolicy: null },
        { name: "Merge authorization", agentName: "review-coordinator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 10, spawnPolicy: null },
        { name: "Merge execution", agentName: "merge-integrator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 11, spawnPolicy: null },
      ],
    },
    {
      // Prompt-only rollover: regression now delegates mechanical work to the
      // platform script while keeping the template graph unchanged.
      marker: "pre-regression-step-split",
      promptDigest: "74fe9add0789494efce82d477ea472ce2a16132fe105e6f12c87223c18dbabf8",
      successorPromptDigest: "27d552a220439bc091956173bc5ee12e5e7158b160fb015443a68f2e744e85d8",
      shape: [
        { name: "Write a spec", agentName: "spec", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "spec", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Plan", agentName: "plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Plan review", agentName: "review-coordinator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan-review", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Revise plan", agentName: "plan-reviser", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "revised-plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Implementation", agentName: "implementation-plan-executioner", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: true, opensPullRequest: true, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Code review (Sol)", agentName: "review-coordinator-sol", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Code review (Opus blind)", agentName: "review-coordinator-opus", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Apply review fixes", agentName: "senior-dev", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
        { name: "Librarian", agentName: "librarian", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "documentation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 8, spawnPolicy: null },
        { name: "Regression verification", agentName: "regression-verifier", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 9, spawnPolicy: null },
        { name: "Merge authorization", agentName: "review-coordinator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 10, spawnPolicy: null },
        { name: "Merge execution", agentName: "merge-integrator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 11, spawnPolicy: null },
      ],
    },
    {
      marker: "pre-internal-npm-scope-rename",
      promptDigest: "79845a3badc75200d30ac22cb4fb10c6efa38308c31156e7b15f4c8475e9f7ff",
      successorPromptDigest: "27d552a220439bc091956173bc5ee12e5e7158b160fb015443a68f2e744e85d8",
      shape: [
        { name: "Write a spec", agentName: "spec", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "spec", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Plan", agentName: "plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Plan review", agentName: "review-coordinator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan-review", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Revise plan", agentName: "plan-reviser", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "revised-plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Implementation", agentName: "implementation-plan-executioner", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: true, opensPullRequest: true, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Code review (Sol)", agentName: "review-coordinator-sol", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Code review (Opus blind)", agentName: "review-coordinator-opus", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Apply review fixes", agentName: "senior-dev", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
        { name: "Librarian", agentName: "librarian", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "documentation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 8, spawnPolicy: null },
        { name: "Regression verification", agentName: "regression-verifier", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 9, spawnPolicy: null },
        { name: "Merge authorization", agentName: "review-coordinator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 10, spawnPolicy: null },
        { name: "Merge execution", agentName: "merge-integrator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 11, spawnPolicy: null },
      ],
    },
    {
      marker: "pre-product-rename-anneal",
      promptDigest: "606f9b5a667781cde3400d114cc7f2ebf00bada6995eee07a7019b63e7dd8424",
      successorPromptDigest: "27d552a220439bc091956173bc5ee12e5e7158b160fb015443a68f2e744e85d8",
      shape: [
        { name: "Write a spec", agentName: "spec", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "spec", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Plan", agentName: "plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Plan review", agentName: "review-coordinator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan-review", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Revise plan", agentName: "plan-reviser", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "revised-plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Implementation", agentName: "implementation-plan-executioner", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: true, opensPullRequest: true, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Code review (Sol)", agentName: "review-coordinator-sol", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Code review (Opus blind)", agentName: "review-coordinator-opus", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Apply review fixes", agentName: "senior-dev", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
        { name: "Librarian", agentName: "librarian", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "documentation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 8, spawnPolicy: null },
        { name: "Regression verification", agentName: "regression-verifier", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 9, spawnPolicy: null },
        { name: "Merge authorization", agentName: "review-coordinator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 10, spawnPolicy: null },
        { name: "Merge execution", agentName: "merge-integrator", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 11, spawnPolicy: null },
      ],
    },
  ],
  [PR_TEMPLATE_NAME]: [
    {
      // Prompt-only rollover: PR delivery now publishes the implementation
      // evidence and cleans the tracked chain bookkeeping in the fix step.
      // The graph is unchanged, so both prompt digests authenticate the
      // outgoing and successor generations.
      marker: "pre-pr-handover-quality",
      promptDigest: "93a72d354876a6c26020e8638b6c365fb15e4ca4a400a2d6ca80084994f249d6",
      successorPromptDigest: "805b9e911be94c84e451cdbf4d1cdb93ab10031c031c6854947f56d306fb1906",
      shape: [
        { name: "Implementation", agentName: "senior-dev-luna", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, opensPullRequest: true, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Code review (Sol)", agentName: "review-coordinator-sol", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Code review (Opus blind)", agentName: "review-coordinator-opus", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Apply review fixes", agentName: "senior-dev", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
      ],
    },
  ],
} as const satisfies Readonly<Record<string, readonly LegacyTemplateGeneration[]>>;

export type CanonicalTemplateRegistryName = keyof typeof legacyTemplateGenerations;

export const LEGACY_TEMPLATE_GENERATIONS: Readonly<
  Record<CanonicalTemplateRegistryName, readonly LegacyTemplateGeneration[]>
> = legacyTemplateGenerations;

export type CanonicalTemplateIdentity = Readonly<{
  canonicalName: CanonicalTemplateRegistryName;
  generation: string | null;
}>;

export type CanonicalStepOrdinals = Readonly<Partial<Record<StepRole, number>>>;

/**
 * Current graphs are deliberately kept apart from retired generations. A
 * canonical template may be introduced with no history at all, so deriving
 * its ordinals from `LEGACY_TEMPLATE_GENERATIONS` would incorrectly make it
 * unaddressable by repair routing.
 */
export const CURRENT_CANONICAL_STEP_ORDINALS: Readonly<
  Partial<Record<CanonicalTemplateRegistryName, CanonicalStepOrdinals>>
> = {
  [PR_TEMPLATE_NAME]: {
    implementation: 1,
    "sol-findings": 2,
    "blind-findings": 3,
    "fixed-implementation": 4,
  },
};

const registeredGenerations = (canonicalName: string): readonly LegacyTemplateGeneration[] | null =>
  Object.hasOwn(LEGACY_TEMPLATE_GENERATIONS, canonicalName)
    ? LEGACY_TEMPLATE_GENERATIONS[canonicalName as CanonicalTemplateRegistryName]
    : null;

/**
 * Resolve a current or registered retired canonical template name through the
 * registry. Legacy names include a row id after the generation marker; a bare
 * prefix is not an identity minted by `legacyTemplateName`.
 */
export const canonicalTemplateIdentity = (templateName: string): CanonicalTemplateIdentity | null => {
  for (const canonicalName of Object.keys(LEGACY_TEMPLATE_GENERATIONS) as CanonicalTemplateRegistryName[]) {
    if (templateName === canonicalName) return { canonicalName, generation: null };
    for (const generation of LEGACY_TEMPLATE_GENERATIONS[canonicalName]) {
      const prefix = `${canonicalName}-legacy-${generation.marker}-`;
      if (templateName.startsWith(prefix) && templateName.length > prefix.length) {
        return { canonicalName, generation: generation.marker };
      }
    }
  }
  return null;
};

/**
 * Derive Step role ordinals from one registered graph. Prompt-only current
 * graphs derive their ordinals from the latest entry's shape. A structural
 * transition carries explicit successor ordinals so the current graph can
 * advance without silently reusing retired positions.
 */
export const canonicalStepOrdinals = (
  canonicalName: CanonicalTemplateRegistryName,
  generation: string | null,
): CanonicalStepOrdinals | null => {
  const generations = LEGACY_TEMPLATE_GENERATIONS[canonicalName];
  const registered = generation === null
    ? generations.at(-1)
    : generations.find((candidate) => candidate.marker === generation);
  if (!registered) {
    return generation === null ? CURRENT_CANONICAL_STEP_ORDINALS[canonicalName] ?? null : null;
  }
  if (generation === null && registered.successorStepOrdinals !== undefined) return registered.successorStepOrdinals;
  if (generation === null && (registered.promptDigest === undefined || registered.successorPromptDigest === undefined)) {
    throw new Error(`Current ${canonicalName} Step ordinals are not derivable from its latest structural transition`);
  }

  const ordinals: Partial<Record<StepRole, number>> = {};
  for (const [index, step] of registered.shape.entries()) {
    const role = stepRole({ outputKind: step.outputKind });
    if (role === null) throw new Error(`Registered ${canonicalName} generation ${registered.marker} has unknown outputKind ${step.outputKind}`);
    if (ordinals[role] !== undefined) throw new Error(`Registered ${canonicalName} generation ${registered.marker} repeats Step role ${role}`);
    ordinals[role] = index + 1;
  }
  return ordinals;
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

export const legacyGenerationMarkerForTemplateName = (templateName: string): string | null =>
  canonicalTemplateIdentity(templateName)?.generation ?? null;

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
  requiresCommit: boolean;
  baseFromStepIndex: number | null;
  spawnPolicy: Prisma.JsonValue;
  prompt: string;
  _count?: { tasks: number };
};

const shapeMatches = (
  steps: readonly PersistedTransitionStep[],
  expected: readonly LegacyStepRecord[],
): boolean => {
  if (steps.length !== expected.length) return false;
  const ordered = [...steps].sort((left, right) => left.stepIndex - right.stepIndex);
  if (ordered.some((step, index) => step.stepIndex !== index + 1)) return false;
  for (const [index, step] of ordered.entries()) {
    const expectedStep = expected[index]!;
    if (step.name !== expectedStep.name
      || (step.assigneeAgent?.name ?? null) !== expectedStep.agentName
      || step.assigneeType !== expectedStep.assigneeType
      || step.approvalGate !== expectedStep.approvalGate
      || step.outputKind !== expectedStep.outputKind
      || step.attachmentsFromPrevious !== expectedStep.attachmentsFromPrevious
      || step.opensPullRequest !== expectedStep.opensPullRequest
      || step.requiresCommit !== (expectedStep.outputKind === "plan" || expectedStep.outputKind === "implementation")
      || step.baseFromStepIndex !== expectedStep.baseFromStepIndex
      || step.layer !== expectedStep.layer
      || !isDeepStrictEqual(step.spawnPolicy, expectedStep.spawnPolicy)) {
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
  const generation = registeredGenerations(templateName)?.find((candidate) => candidate.marker === marker);
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
  registeredGenerations(templateName)
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
  if (!registeredGenerations(templateName)) return `unknown canonical template ${templateName}`;
  return matchedLegacyGeneration(templateName, steps) === null ? null : "legacy";
};
