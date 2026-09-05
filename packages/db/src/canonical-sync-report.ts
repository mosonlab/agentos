/**
 * The canonical prompt sync report.
 *
 * `prisma/sync-canonical-prompts.ts` walks every Project in one transaction
 * each and prints what it changed. That print is a real interface: the
 * multi-project acceptance test reads the JSON line back and asserts on it,
 * and an operator reads it to decide whether a deployment mutated anything.
 * It used to exist only as a `console.log` of an object literal, so the shape,
 * the arithmetic that fills it, and the parse that reads it were three
 * independent restatements of the same contract; three of the four most recent
 * fixes to the sync script were report bugs rather than sync bugs.
 *
 * This module owns all three. The sync script accumulates one
 * `CanonicalSyncCounters` per Project inside its transaction, hands the
 * outcomes to `canonicalSyncSummary`, and prints `canonicalSyncSummaryLine`;
 * the test calls `parseCanonicalSyncSummary`. `updated` is derived here and
 * nowhere else, so a caller cannot report an unfinalised total.
 */

/**
 * The skeleton a report is seeded from: every canonical template's step
 * indexes, and every canonical Agent name. The report needs nothing else about
 * a step or a role, so it does not depend on the source loader's types.
 */
export type CanonicalSyncReportKeys = {
  templateSteps: ReadonlyMap<string, readonly { stepIndex: number }[]>;
  roleNames: readonly string[];
};

/**
 * Every counter that records a write. `templates` counts what was inspected
 * rather than what changed, and `updated` is their sum, so neither is here.
 * `CanonicalAdoptionCounter` in `canonical-step-adoption.ts` names a subset of
 * these; `counters[adoption.counter] += 1` is what keeps the two in step.
 */
const CANONICAL_SYNC_MUTATION_COUNTERS = [
  "createdCanonicalTemplates",
  "createdAgents",
  "createdAgentRepoGrants",
  "adoptedAssignees",
  "adoptedStepBases",
  "adoptedPriorOutputDeclarations",
  "adoptedDependencyProvisioning",
  "adoptedOptionalSteps",
  "renamedSteps",
  "adoptedAgentDefaults",
  "adoptedAgentIdentity",
  "assignedCanonicalRoles",
  "runtimeDriftNotices",
] as const;

export type CanonicalSyncMutationCounter = typeof CANONICAL_SYNC_MUTATION_COUNTERS[number];

/**
 * One Project's sync outcome. `updatedSteps` and `updatedRoles` are keyed by
 * template name then step index, and by Agent name; both key sets are seeded
 * from the canonical sources so a report always names every step and role,
 * including the ones that did not change.
 */
export type CanonicalSyncCounters = Record<CanonicalSyncMutationCounter, number> & {
  templates: number;
  updated: number;
  updatedSteps: Record<string, Record<string, number>>;
  updatedRoles: Record<string, number>;
};

export type CanonicalSyncProjectOutcome =
  | { kind: "synced"; slug: string; counters: CanonicalSyncCounters }
  | { kind: "refused"; slug: string; reason: string };

export type CanonicalSyncSummary = {
  projects: Record<string, CanonicalSyncCounters>;
  refused: Record<string, string>;
  totals: CanonicalSyncCounters;
};

export const emptyCanonicalSyncCounters = (
  keys: CanonicalSyncReportKeys,
): CanonicalSyncCounters => ({
  templates: 0,
  createdCanonicalTemplates: 0,
  createdAgents: 0,
  createdAgentRepoGrants: 0,
  adoptedAssignees: 0,
  adoptedStepBases: 0,
  adoptedPriorOutputDeclarations: 0,
  adoptedDependencyProvisioning: 0,
  adoptedOptionalSteps: 0,
  renamedSteps: 0,
  adoptedAgentDefaults: 0,
  adoptedAgentIdentity: 0,
  assignedCanonicalRoles: 0,
  runtimeDriftNotices: 0,
  updated: 0,
  updatedSteps: Object.fromEntries([...keys.templateSteps].map(([name, steps]) => [
    name,
    Object.fromEntries(steps.map((step) => [String(step.stepIndex), 0])),
  ])),
  updatedRoles: Object.fromEntries(keys.roleNames.map((name) => [name, 0])),
});

/** Count prompt rewrites on one canonical template step. */
export const recordStepPromptUpdate = (
  counters: CanonicalSyncCounters,
  templateName: string,
  stepIndex: number,
  amount: number,
): void => {
  const key = String(stepIndex);
  const byStep = counters.updatedSteps[templateName];
  const current = byStep?.[key];
  if (byStep === undefined || current === undefined) {
    throw new Error(`Canonical sync report has no counter for ${templateName} step ${stepIndex}`);
  }
  byStep[key] = current + amount;
};

/** Count prompt rewrites on one canonical Agent. */
export const recordRolePromptUpdate = (
  counters: CanonicalSyncCounters,
  roleName: string,
  amount: number,
): void => {
  const current = counters.updatedRoles[roleName];
  if (current === undefined) {
    throw new Error(`Canonical sync report has no counter for Agent ${roleName}`);
  }
  counters.updatedRoles[roleName] = current + amount;
};

const withUpdatedTotal = (counters: CanonicalSyncCounters): CanonicalSyncCounters => {
  const scalar = CANONICAL_SYNC_MUTATION_COUNTERS.reduce((sum, name) => sum + counters[name], 0);
  const steps = Object.values(counters.updatedSteps)
    .flatMap((byStep) => Object.values(byStep))
    .reduce((sum, count) => sum + count, 0);
  const roles = Object.values(counters.updatedRoles).reduce((sum, count) => sum + count, 0);
  return { ...counters, updated: scalar + steps + roles };
};

const sumCounters = (
  keys: CanonicalSyncReportKeys,
  perProject: readonly CanonicalSyncCounters[],
): CanonicalSyncCounters => {
  const total = emptyCanonicalSyncCounters(keys);
  for (const counters of perProject) {
    total.templates += counters.templates;
    for (const name of CANONICAL_SYNC_MUTATION_COUNTERS) total[name] += counters[name];
    for (const [templateName, byStep] of Object.entries(counters.updatedSteps)) {
      for (const [stepIndex, count] of Object.entries(byStep)) {
        recordStepPromptUpdate(total, templateName, Number(stepIndex), count);
      }
    }
    for (const [roleName, count] of Object.entries(counters.updatedRoles)) {
      recordRolePromptUpdate(total, roleName, count);
    }
  }
  return total;
};

/**
 * Build the report from the outcomes the fan-out loop accumulated. Projects are
 * ordered by slug rather than by the order they were synced, so the report does
 * not depend on the canonical Project being walked first.
 */
export const canonicalSyncSummary = (
  outcomes: readonly CanonicalSyncProjectOutcome[],
  keys: CanonicalSyncReportKeys,
): CanonicalSyncSummary => {
  const slugs = new Set<string>();
  for (const outcome of outcomes) {
    if (slugs.has(outcome.slug)) throw new Error(`Project ${outcome.slug} reported two sync outcomes`);
    slugs.add(outcome.slug);
  }
  const ordered = [...outcomes].sort((left, right) => (
    left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0
  ));
  const synced = ordered.filter((outcome): outcome is Extract<CanonicalSyncProjectOutcome, { kind: "synced" }> => (
    outcome.kind === "synced"
  ));
  return {
    projects: Object.fromEntries(synced.map((outcome) => [outcome.slug, withUpdatedTotal(outcome.counters)])),
    refused: Object.fromEntries(ordered.flatMap((outcome) => (
      outcome.kind === "refused" ? [[outcome.slug, outcome.reason]] : []
    ))),
    totals: withUpdatedTotal(sumCounters(keys, synced.map((outcome) => outcome.counters))),
  };
};

/** The one line the sync script prints last, and the only machine-read output. */
export const canonicalSyncSummaryLine = (summary: CanonicalSyncSummary): string => JSON.stringify(summary);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

export const parseCanonicalSyncSummary = (output: string): CanonicalSyncSummary => {
  const line = output.trim().split("\n").at(-1);
  if (!line) throw new Error("Canonical sync printed no output to read a summary from");
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`Canonical sync summary line is not JSON: ${line}`);
  }
  if (!isRecord(parsed)) throw new Error(`Canonical sync summary line is not an object: ${line}`);
  for (const field of ["projects", "refused", "totals"] as const) {
    if (!isRecord(parsed[field])) throw new Error(`Canonical sync summary has no ${field}: ${line}`);
  }
  return parsed as unknown as CanonicalSyncSummary;
};
