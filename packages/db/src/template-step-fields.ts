/**
 * The one description of a template step's structural fields.
 *
 * `template-sources.ts` presents the row-vs-source comparison and
 * `canonical-template-transition.ts` matches retired generations; both read the
 * same table from here, so a structural column is described once. This module
 * imports nothing at run time on purpose: `template-sources.ts` evaluates the
 * canonical source specs during module initialization, and a run-time edge back
 * into it from the transition registry deadlocks that initialization.
 */
import { isDeepStrictEqual } from "node:util";

import type { AssigneeType, Prisma } from "@prisma/client";

import type { PersistedTemplateStepStructure, TemplateStepSource } from "./template-sources.js";

/**
 * The Agent bound to a persisted step, as identity is read from it.
 *
 * `canonicalRole` is the role file name and is the Agent's canonical identity;
 * `name` is an operator-editable label that follows canonical until it is
 * edited. Reading identity through one accessor keeps the two apart in one
 * place: a row whose Agent predates the column still compares by name, and
 * every reader moves to the column the moment it carries a value.
 */
export type PersistedStepAgentIdentity = Readonly<{ name: string; canonicalRole?: string | null }>;

/**
 * The canonical identity of the Agent bound to a persisted step: its
 * `canonicalRole` when it has one, its `name` otherwise, and null when the step
 * binds no Agent.
 */
export const persistedStepAgentIdentity = (
  agent: PersistedStepAgentIdentity | null | undefined,
): string | null => (agent === null || agent === undefined ? null : agent.canonicalRole ?? agent.name);

/**
 * One step of a retired canonical graph, as `canonical-template-transition.ts`
 * registers it. A generation states what its deployed rows carried; a field it
 * omits takes the default documented on that field and nothing else. No value
 * is derived from another field inside a comparator.
 */
export type LegacyStepRecord = Readonly<{
  name: string;
  assigneeType: AssigneeType;
  layer: number;
  approvalGate: boolean;
  /**
   * Defaults to false: generations registered before optional steps existed
   * have no optional step, and their deployed rows are all optional = false.
   */
  optional?: boolean;
  outputKind: string;
  attachmentsFromPrevious: boolean;
  opensPullRequest: boolean;
  /** Defaults to false: a generation states this at the steps that committed. */
  requiresCommit?: boolean;
  /**
   * Defaults to true: generations registered before this field existed
   * predate steps that opt out of dependency provisioning.
   */
  provisionDependencies?: boolean;
  baseFromStepIndex: number | null;
  spawnPolicy: Prisma.JsonValue;
}>;

/**
 * One structural field of a template step. Three shapes describe the same
 * step -- the persisted row, the Markdown source, and the record a retired
 * generation registers -- and this table says once how each of them states the
 * field.
 */
type TemplateStepField = Readonly<{
  /** The difference name callers report and `canonical-step-adoption.ts` keys on. */
  field: string;
  /** The frontmatter key that authors this field, or null when the source derives it. */
  frontmatterKey: string | null;
  persisted: (actual: PersistedTemplateStepStructure) => unknown;
  fromSource: (expected: TemplateStepSource) => unknown;
  /**
   * The value a retired generation's record states, or null when the field
   * cannot identify a generation. Two fields are such. `agent` is one: a
   * binding is staffing rather than structure, and a generation that differs
   * from its successor only by one would match the current graph forever.
   * `priorOutputKinds` is the other:
   * the whitelist migration rewrote it independently of any graph transition,
   * so rows of one retired generation legitimately carry either the whitelist
   * or the retired all-outputs marker that `canonical-step-adoption.ts`
   * forgives at every step, and matching it exactly would refuse the rollover
   * of every row the migration has not reached.
   */
  fromRetiredShape: ((expected: LegacyStepRecord) => unknown) | null;
}>;

/**
 * The structural fields of a template step, stated once.
 *
 * Both row-vs-spec comparators are built from this table:
 * `templateStepStructureDifferences` compares a row with its Markdown source,
 * and `retiredStepShapeDifferences` compares a row with the record of a retired
 * generation. A new structural column is one entry here plus one field on each
 * shape it belongs to; it is never a branch inside a comparator.
 *
 * The table is shared, the tolerance is not. Source drift is forgiven per step
 * by `canonical-step-adoption.ts`; a retired shape is exact historical identity
 * and forgives nothing.
 */
const TEMPLATE_STEP_FIELDS: readonly TemplateStepField[] = [
  {
    field: "name",
    frontmatterKey: null,
    persisted: (actual) => actual.name,
    fromSource: (expected) => expected.name,
    fromRetiredShape: (expected) => expected.name,
  },
  {
    /**
     * The canonical role bound to the step, against the role name the source
     * frontmatter states.
     *
     * `fromRetiredShape` is null: which Agent a step binds is staffing, not
     * structure, so it cannot identify a retired generation. A generation that
     * differed from its successor only by a binding would otherwise keep
     * matching the current graph, and every sync would plan a rollover.
     */
    field: "agent",
    frontmatterKey: "agent",
    persisted: (actual) => persistedStepAgentIdentity(actual.assigneeAgent),
    fromSource: (expected) => expected.agentName,
    fromRetiredShape: null,
  },
  {
    field: "assigneeType",
    frontmatterKey: null,
    persisted: (actual) => actual.assigneeType,
    fromSource: (expected) => (expected.agentName === null ? "HUMAN" : "AGENT"),
    fromRetiredShape: (expected) => expected.assigneeType,
  },
  {
    field: "layer",
    frontmatterKey: "layer",
    persisted: (actual) => actual.layer,
    fromSource: (expected) => expected.layer,
    fromRetiredShape: (expected) => expected.layer,
  },
  {
    field: "approvalGate",
    frontmatterKey: "approvalGate",
    persisted: (actual) => actual.approvalGate,
    fromSource: (expected) => expected.approvalGate,
    fromRetiredShape: (expected) => expected.approvalGate,
  },
  {
    field: "optional",
    frontmatterKey: "optional",
    persisted: (actual) => actual.optional,
    fromSource: (expected) => expected.optional,
    fromRetiredShape: (expected) => expected.optional ?? false,
  },
  {
    field: "outputKind",
    frontmatterKey: "outputKind",
    persisted: (actual) => actual.outputKind,
    fromSource: (expected) => expected.outputKind,
    fromRetiredShape: (expected) => expected.outputKind,
  },
  {
    field: "attachmentsFromPrevious",
    frontmatterKey: "attachmentsFromPrevious",
    persisted: (actual) => actual.attachmentsFromPrevious,
    fromSource: (expected) => expected.attachmentsFromPrevious,
    fromRetiredShape: (expected) => expected.attachmentsFromPrevious,
  },
  {
    field: "priorOutputKinds",
    frontmatterKey: "priorOutputKinds",
    persisted: (actual) => actual.priorOutputKinds,
    fromSource: (expected) => expected.priorOutputKinds,
    fromRetiredShape: null,
  },
  {
    field: "opensPullRequest",
    frontmatterKey: "opensPullRequest",
    persisted: (actual) => actual.opensPullRequest,
    fromSource: (expected) => expected.opensPullRequest,
    fromRetiredShape: (expected) => expected.opensPullRequest,
  },
  {
    field: "requiresCommit",
    frontmatterKey: "requiresCommit",
    persisted: (actual) => actual.requiresCommit,
    fromSource: (expected) => expected.requiresCommit,
    fromRetiredShape: (expected) => expected.requiresCommit ?? false,
  },
  {
    field: "provisionDependencies",
    frontmatterKey: "provisionDependencies",
    persisted: (actual) => actual.provisionDependencies,
    fromSource: (expected) => expected.provisionDependencies,
    fromRetiredShape: (expected) => expected.provisionDependencies ?? true,
  },
  {
    field: "baseFromStepIndex",
    frontmatterKey: "baseFromStepIndex",
    persisted: (actual) => actual.baseFromStepIndex,
    fromSource: (expected) => expected.baseFromStepIndex,
    fromRetiredShape: (expected) => expected.baseFromStepIndex,
  },
  {
    field: "spawnPolicy",
    frontmatterKey: "spawnPolicy",
    persisted: (actual) => actual.spawnPolicy,
    fromSource: (expected) => expected.spawnPolicy,
    fromRetiredShape: (expected) => expected.spawnPolicy,
  },
];

/**
 * The exact frontmatter contract of a step prompt: its own index plus every
 * structural field the table says the author writes.
 */
export const TEMPLATE_STEP_FRONTMATTER_KEYS: readonly string[] = [
  "stepIndex",
  ...TEMPLATE_STEP_FIELDS.flatMap(({ frontmatterKey }) => (frontmatterKey === null ? [] : [frontmatterKey])),
];

/**
 * The fields in which a persisted step differs from its Markdown source.
 * Callers decide what to do with each name: `canonical-step-adoption.ts` says
 * which are forgiven at which step, and every other difference is drift.
 */
export const templateStepStructureDifferences = (
  actual: PersistedTemplateStepStructure,
  expected: TemplateStepSource,
): string[] => TEMPLATE_STEP_FIELDS
  .filter((entry) => !isDeepStrictEqual(entry.persisted(actual), entry.fromSource(expected)))
  .map((entry) => entry.field);

/**
 * The fields in which a persisted step differs from the record of the retired
 * generation it is claimed to be. Empty means exact historical identity: this
 * comparison forgives nothing, so a rollover renames only a row that really is
 * the registered graph.
 */
export const retiredStepShapeDifferences = (
  actual: PersistedTemplateStepStructure,
  expected: LegacyStepRecord,
): string[] => TEMPLATE_STEP_FIELDS
  .filter((entry) => entry.fromRetiredShape !== null
    && !isDeepStrictEqual(entry.persisted(actual), entry.fromRetiredShape(expected)))
  .map((entry) => entry.field);
