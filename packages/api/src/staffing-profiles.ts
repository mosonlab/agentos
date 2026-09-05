/**
 * Staffing profiles: named, per-template plans for who runs each step and
 * which optional steps a chain keeps.
 *
 * A profile is an opinion layered over a template graph, never a copy of it.
 * Entries key on the step's *exact* `outputKind`, because that is the only key
 * that survives step reordering and still distinguishes `foo` from `foo-v2` in
 * a custom graph. A step the profile does not name keeps its canonical binding,
 * so a template with no profile at all instantiates exactly as it did before
 * profiles existed.
 *
 * Every write takes the Agent-row mutex (`lockAgentRows`) that archive and
 * instantiation take, after the template row. Without it an archive committing
 * between the validity read and the profile write would leave a saved profile
 * pointing at an agent no runner will ever claim.
 */

import {
  AssigneeType,
  catalogRunnerForModel,
  integratorBindingRefusal,
  isCompoundImplementationStep,
  lockAgentRows,
  lockTemplateRow,
  Prisma,
  RunnerKind,
  RunnerPreference,
  runnerFor,
  stepRole,
  type PrismaClient,
} from "@anneal/db";
import type {
  StaffingProfile as StaffingProfileContract,
  StaffingProfileEntry as StaffingProfileEntryContract,
  StaffingProfileWarning,
} from "@anneal/db/console-contract";

import { StaffingProfileRefusal } from "./staffing-profile-errors.js";
import { serializable } from "./transaction.js";

type Tx = Prisma.TransactionClient;

/** The name a bootstrap- or clone-installed profile is created under. */
export const DEFAULT_STAFFING_PROFILE_NAME = "Default";

export type StaffingProfileEntryInput = {
  outputKind: string;
  assigneeAgentId?: string | null | undefined;
  include?: boolean | null | undefined;
};

export type CreateStaffingProfileInput = {
  name: string;
  entries: StaffingProfileEntryInput[];
  isDefault?: boolean | undefined;
};

export type ReplaceStaffingProfileInput = {
  name: string;
  entries: StaffingProfileEntryInput[];
};

export type StaffingProfileResult = {
  profile: StaffingProfileContract<Date>;
  warnings: StaffingProfileWarning[];
};

const refuse = (
  code: ConstructorParameters<typeof StaffingProfileRefusal>[0],
  message: string,
  outputKind?: string,
): StaffingProfileRefusal => new StaffingProfileRefusal(code, message, outputKind);

const profileSelect = {
  id: true,
  projectId: true,
  taskTemplateId: true,
  name: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
  entries: {
    select: { outputKind: true, assigneeAgentId: true, include: true },
    orderBy: { outputKind: "asc" },
  },
} as const satisfies Prisma.StaffingProfileSelect;

type ProfileRow = {
  id: string;
  projectId: string;
  taskTemplateId: string;
  name: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  entries: StaffingProfileEntryContract[];
};

const readProfile = async (tx: Tx, profileId: string): Promise<ProfileRow> =>
  tx.staffingProfile.findUniqueOrThrow({ where: { id: profileId }, select: profileSelect });

/** The template graph facts a profile is validated against. */
type ValidationStep = {
  stepIndex: number;
  name: string;
  outputKind: string;
  optional: boolean;
  assigneeType: AssigneeType;
  assigneeAgentId: string | null;
  runner: RunnerKind | null;
};

type ValidationAgent = {
  id: string;
  name: string;
  projectId: string;
  archivedAt: Date | null;
  model: string;
  runnerPreference: RunnerPreference;
};

/**
 * R14 as a capability predicate rather than a name: the compound
 * implementation root is the one step whose subprocess protocol only the Codex
 * CLI speaks, so what it requires of an assignee is a Codex runner and a
 * `gpt-*` model — not one particular agent slug.
 */
export const compoundImplementationCapable = (
  agent: Pick<ValidationAgent, "model" | "runnerPreference">,
  step: Pick<ValidationStep, "runner">,
): boolean => {
  const runner = step.runner ?? runnerFor(agent.runnerPreference, agent.model);
  return runner === RunnerKind.CODEX && catalogRunnerForModel(agent.model) === RunnerPreference.CODEX;
};

/**
 * Validate one profile's entries against a template graph and the Agent rows
 * already read under the Agent mutex. Pure: it opens no transaction and reads
 * nothing, so the caller decides what is locked before it runs.
 *
 * The first failing rule is the only refusal, in the fixed order below.
 */
export const validateStaffingEntries = (
  entries: readonly StaffingProfileEntryInput[],
  steps: readonly ValidationStep[],
  agents: ReadonlyMap<string, ValidationAgent>,
  context: { projectId: string; templateName: string },
): { entries: StaffingProfileEntryContract[]; warnings: StaffingProfileWarning[] } => {
  const stepsByKind = new Map(steps.map((step) => [step.outputKind, step]));
  const seen = new Set<string>();
  const normalized: StaffingProfileEntryContract[] = [];

  for (const entry of entries) {
    if (seen.has(entry.outputKind)) {
      throw refuse(
        "staffing_profile_entry_duplicate",
        `Staffing profile names output kind ${entry.outputKind} more than once`,
        entry.outputKind,
      );
    }
    seen.add(entry.outputKind);

    const step = stepsByKind.get(entry.outputKind);
    if (!step) {
      throw refuse(
        "staffing_profile_unknown_output_kind",
        `Template ${context.templateName} has no step producing output kind ${entry.outputKind}`,
        entry.outputKind,
      );
    }
    const assigneeAgentId = entry.assigneeAgentId ?? null;
    const include = entry.include ?? null;

    if (include !== null && !step.optional) {
      throw refuse(
        "staffing_profile_include_not_optional",
        `Step ${step.name} (${entry.outputKind}) is not optional, so it cannot carry an include flag`,
        entry.outputKind,
      );
    }
    if (assigneeAgentId !== null) {
      if (step.assigneeType !== AssigneeType.AGENT) {
        throw refuse(
          "staffing_profile_step_not_agent",
          `Step ${step.name} (${entry.outputKind}) has assigneeType ${step.assigneeType}; only AGENT steps may be staffed`,
          entry.outputKind,
        );
      }
      const agent = agents.get(assigneeAgentId);
      if (!agent || agent.projectId !== context.projectId) {
        throw refuse(
          "staffing_profile_agent_not_found",
          `Agent ${assigneeAgentId} for output kind ${entry.outputKind} was not found in this project`,
          entry.outputKind,
        );
      }
      if (agent.archivedAt !== null) {
        throw refuse(
          "staffing_profile_agent_archived",
          `Agent ${agent.name} for output kind ${entry.outputKind} is archived`,
          entry.outputKind,
        );
      }
      // Two-sided, as the platform predicate defines it: the sentinel binds
      // only a merge-execution step, and a merge-execution step binds only the
      // sentinel. Checked for every step the profile takes responsibility for,
      // so neither half can be introduced one entry at a time.
      const bindingRefusal = integratorBindingRefusal(agent.name, {
        stepIndex: step.stepIndex,
        outputKind: step.outputKind,
        taskTemplateName: context.templateName,
      });
      if (bindingRefusal) {
        throw refuse(
          "staffing_profile_integrator_binding",
          `Step ${step.name} (${entry.outputKind}): ${bindingRefusal}`,
          entry.outputKind,
        );
      }
      const compoundRoot = isCompoundImplementationStep({
        stepIndex: step.stepIndex,
        outputKind: step.outputKind,
        taskTemplate: { name: context.templateName },
      });
      if (compoundRoot && !compoundImplementationCapable(agent, step)) {
        throw refuse(
          "staffing_profile_compound_implementation",
          `Step ${step.name} (${entry.outputKind}) is the compound implementation root and requires a Codex runner with a gpt-* model; ${agent.name} runs ${agent.model}`,
          entry.outputKind,
        );
      }
    }
    normalized.push({ outputKind: entry.outputKind, assigneeAgentId, include });
  }

  // A warning describes the plan being saved and never blocks it.
  const warnings: StaffingProfileWarning[] = [];
  const effective = new Map<string, string | null>(steps.map((step) => [step.outputKind, step.assigneeAgentId]));
  for (const entry of normalized) {
    if (entry.assigneeAgentId !== null) effective.set(entry.outputKind, entry.assigneeAgentId);
  }
  const agentsFor = (roles: ReadonlySet<string>): Set<string> => new Set(
    steps
      .filter((step) => {
        const role = stepRole({ outputKind: step.outputKind });
        return role !== null && roles.has(role);
      })
      .flatMap((step) => {
        const agentId = effective.get(step.outputKind) ?? null;
        return agentId === null ? [] : [agentId];
      }),
  );
  const implementers = agentsFor(new Set(["implementation", "fixed-implementation"]));
  const reviewers = agentsFor(new Set(["plan-review", "sol-findings", "blind-findings"]));
  if ([...reviewers].some((agentId) => implementers.has(agentId))) {
    warnings.push({
      code: "same_agent_implements_and_reviews",
      message: "One Agent implements and reviews under this staffing profile",
    });
  }
  return { entries: normalized, warnings };
};

/** The canonical plan: every step's own binding, and every optional step kept. */
export const canonicalStaffingEntries = (
  steps: readonly ValidationStep[],
): StaffingProfileEntryContract[] => steps.map((step) => ({
  outputKind: step.outputKind,
  assigneeAgentId: step.assigneeAgentId,
  include: step.optional ? true : null,
}));

const stepSelect = {
  stepIndex: true,
  name: true,
  outputKind: true,
  optional: true,
  assigneeType: true,
  assigneeAgentId: true,
  runner: true,
} as const satisfies Prisma.TaskTemplateStepSelect;

const agentSelect = {
  id: true,
  name: true,
  projectId: true,
  archivedAt: true,
  model: true,
  runnerPreference: true,
} as const satisfies Prisma.AgentSelect;

const readSteps = async (tx: Tx, taskTemplateId: string): Promise<ValidationStep[]> =>
  tx.taskTemplateStep.findMany({
    where: { taskTemplateId },
    orderBy: { stepIndex: "asc" },
    select: stepSelect,
  });

/**
 * Takes the two mutexes a profile write shares with the rest of the platform,
 * in the platform's lock order: the template row (shared with authoring and
 * instantiation), then the Agent rows (shared with archive).
 *
 * `lockAgentRows` returns only identity fields, so the model and runner
 * preference the capability predicate needs are re-read under the lock it took.
 */
const lockedAgents = async (
  tx: Tx,
  agentIds: readonly string[],
): Promise<Map<string, ValidationAgent>> => {
  const unique = [...new Set(agentIds)].sort();
  if (unique.length === 0) return new Map();
  await lockAgentRows(tx, unique);
  const rows = await tx.agent.findMany({ where: { id: { in: unique } }, select: agentSelect });
  return new Map(rows.map((row) => [row.id, row]));
};

const requireTemplate = async (
  tx: Tx,
  projectId: string,
  templateId: string,
): Promise<{ id: string; name: string }> => {
  const locked = await lockTemplateRow(tx, templateId);
  if (!locked || locked.projectId !== projectId) {
    throw refuse(
      "staffing_profile_template_not_found",
      `Template ${templateId} is not in project ${projectId}`,
    );
  }
  return { id: locked.id, name: locked.name };
};

const requireProfile = async (
  tx: Tx,
  profileId: string,
): Promise<{ id: string; projectId: string; taskTemplateId: string; name: string; isDefault: boolean }> => {
  const profile = await tx.staffingProfile.findUnique({
    where: { id: profileId },
    select: { id: true, projectId: true, taskTemplateId: true, name: true, isDefault: true },
  });
  if (!profile) throw refuse("staffing_profile_not_found", `Staffing profile ${profileId} was not found`);
  return profile;
};

const assertNameFree = async (
  tx: Tx,
  taskTemplateId: string,
  name: string,
  exceptProfileId?: string,
): Promise<void> => {
  const existing = await tx.staffingProfile.findUnique({
    where: { taskTemplateId_name: { taskTemplateId, name } },
    select: { id: true },
  });
  if (existing && existing.id !== exceptProfileId) {
    throw refuse(
      "staffing_profile_name_taken",
      `Staffing profile name ${name} is already used by this template`,
    );
  }
};

/** Promote one profile and demote every sibling in the same statement pair. */
const promoteDefault = async (tx: Tx, profile: { id: string; taskTemplateId: string }): Promise<void> => {
  await tx.staffingProfile.updateMany({
    where: { taskTemplateId: profile.taskTemplateId, id: { not: profile.id }, isDefault: true },
    data: { isDefault: false },
  });
  await tx.staffingProfile.update({ where: { id: profile.id }, data: { isDefault: true } });
};

const writeEntries = async (
  tx: Tx,
  profileId: string,
  entries: readonly StaffingProfileEntryContract[],
): Promise<void> => {
  await tx.staffingProfileEntry.deleteMany({ where: { profileId } });
  if (entries.length === 0) return;
  await tx.staffingProfileEntry.createMany({
    data: entries.map((entry) => ({ profileId, ...entry })),
  });
};

export const listStaffingProfiles = async (
  db: PrismaClient,
  projectId: string,
  templateId: string,
): Promise<StaffingProfileContract<Date>[]> => {
  const template = await db.taskTemplate.findFirst({
    where: { id: templateId, projectId },
    select: { id: true },
  });
  if (!template) {
    throw refuse(
      "staffing_profile_template_not_found",
      `Template ${templateId} is not in project ${projectId}`,
    );
  }
  return db.staffingProfile.findMany({
    where: { taskTemplateId: templateId },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    select: profileSelect,
  });
};

export const createStaffingProfile = async (
  db: PrismaClient,
  projectId: string,
  templateId: string,
  input: CreateStaffingProfileInput,
): Promise<StaffingProfileResult> => serializable(db, async (tx) => {
  const template = await requireTemplate(tx, projectId, templateId);
  const name = input.name.trim();
  await assertNameFree(tx, template.id, name);
  const steps = await readSteps(tx, template.id);
  const agents = await lockedAgents(tx, input.entries.flatMap((entry) => (
    entry.assigneeAgentId ? [entry.assigneeAgentId] : []
  )));
  const validated = validateStaffingEntries(input.entries, steps, agents, {
    projectId,
    templateName: template.name,
  });

  // The first profile of a template is always its default: a template with
  // profiles but no default would silently instantiate from canonical.
  const siblingCount = await tx.staffingProfile.count({ where: { taskTemplateId: template.id } });
  const created = await tx.staffingProfile.create({
    data: { projectId, taskTemplateId: template.id, name, isDefault: false },
    select: { id: true, taskTemplateId: true },
  });
  await writeEntries(tx, created.id, validated.entries);
  if (siblingCount === 0 || (input.isDefault ?? false)) await promoteDefault(tx, created);
  return { profile: await readProfile(tx, created.id), warnings: validated.warnings };
});

export const replaceStaffingProfile = async (
  db: PrismaClient,
  profileId: string,
  input: ReplaceStaffingProfileInput,
): Promise<StaffingProfileResult> => serializable(db, async (tx) => {
  const existing = await requireProfile(tx, profileId);
  const template = await requireTemplate(tx, existing.projectId, existing.taskTemplateId);
  const name = input.name.trim();
  await assertNameFree(tx, template.id, name, existing.id);
  const steps = await readSteps(tx, template.id);
  const agents = await lockedAgents(tx, input.entries.flatMap((entry) => (
    entry.assigneeAgentId ? [entry.assigneeAgentId] : []
  )));
  const validated = validateStaffingEntries(input.entries, steps, agents, {
    projectId: existing.projectId,
    templateName: template.name,
  });
  await tx.staffingProfile.update({ where: { id: existing.id }, data: { name } });
  await writeEntries(tx, existing.id, validated.entries);
  return { profile: await readProfile(tx, existing.id), warnings: validated.warnings };
});

/** Reset one profile's entries to the template's canonical bindings. */
export const resetStaffingProfile = async (
  db: PrismaClient,
  profileId: string,
): Promise<StaffingProfileResult> => serializable(db, async (tx) => {
  const existing = await requireProfile(tx, profileId);
  const template = await requireTemplate(tx, existing.projectId, existing.taskTemplateId);
  const steps = await readSteps(tx, template.id);
  const entries = canonicalStaffingEntries(steps);
  const agents = await lockedAgents(tx, entries.flatMap((entry) => (
    entry.assigneeAgentId ? [entry.assigneeAgentId] : []
  )));
  const validated = validateStaffingEntries(entries, steps, agents, {
    projectId: existing.projectId,
    templateName: template.name,
  });
  await writeEntries(tx, existing.id, validated.entries);
  return { profile: await readProfile(tx, existing.id), warnings: validated.warnings };
});

export const setStaffingProfileDefault = async (
  db: PrismaClient,
  profileId: string,
): Promise<StaffingProfileContract<Date>> => serializable(db, async (tx) => {
  const existing = await requireProfile(tx, profileId);
  await requireTemplate(tx, existing.projectId, existing.taskTemplateId);
  await promoteDefault(tx, existing);
  return readProfile(tx, existing.id);
});

export const deleteStaffingProfile = async (
  db: PrismaClient,
  profileId: string,
): Promise<void> => serializable(db, async (tx) => {
  const existing = await requireProfile(tx, profileId);
  await requireTemplate(tx, existing.projectId, existing.taskTemplateId);
  const siblingCount = await tx.staffingProfile.count({
    where: { taskTemplateId: existing.taskTemplateId, id: { not: existing.id } },
  });
  // Deleting the last profile is allowed and instantiation falls back to the
  // canonical bindings. Deleting the default while alternatives remain is not:
  // it would leave the template with profiles and no default.
  if (existing.isDefault && siblingCount > 0) {
    throw refuse(
      "staffing_profile_default_delete_refused",
      `Staffing profile ${existing.name} is this template's default; make another profile the default before deleting it`,
    );
  }
  await tx.staffingProfile.delete({ where: { id: existing.id } });
});

/**
 * Every profile that names one Agent. Read inside the caller's transaction,
 * which must already hold that Agent's row mutex, so archive can refuse with
 * the exact list rather than a count that may already be stale (R6).
 */
export const profilesReferencingAgent = async (
  tx: Tx,
  agentId: string,
): Promise<Array<{ id: string; name: string; taskTemplateId: string }>> => {
  const entries = await tx.staffingProfileEntry.findMany({
    where: { assigneeAgentId: agentId },
    select: { profile: { select: { id: true, name: true, taskTemplateId: true } } },
    orderBy: [{ profileId: "asc" }, { outputKind: "asc" }],
  });
  const byId = new Map(entries.map(({ profile }) => [profile.id, profile]));
  return [...byId.values()];
};

/**
 * Install the "Default" profile for a template that has none, from its own
 * step bindings. Used by project bootstrap and by template clone; both already
 * hold their own transaction, so this takes no lock of its own.
 */
export const installDefaultStaffingProfile = async (
  tx: Tx,
  input: { projectId: string; taskTemplateId: string },
): Promise<void> => {
  const existing = await tx.staffingProfile.count({ where: { taskTemplateId: input.taskTemplateId } });
  if (existing > 0) return;
  const steps = await readSteps(tx, input.taskTemplateId);
  const profile = await tx.staffingProfile.create({
    data: {
      projectId: input.projectId,
      taskTemplateId: input.taskTemplateId,
      name: DEFAULT_STAFFING_PROFILE_NAME,
      isDefault: true,
    },
    select: { id: true },
  });
  await writeEntries(tx, profile.id, canonicalStaffingEntries(steps));
};


/**
 * Copy every profile of one template onto another, preserving names, default
 * membership and entries. Both templates are assumed to have the same output
 * kinds, which is what a clone guarantees.
 */
export const copyStaffingProfiles = async (
  tx: Tx,
  input: { projectId: string; fromTaskTemplateId: string; toTaskTemplateId: string },
): Promise<void> => {
  const sources = await tx.staffingProfile.findMany({
    where: { taskTemplateId: input.fromTaskTemplateId },
    orderBy: { name: "asc" },
    select: profileSelect,
  });
  for (const source of sources) {
    const created = await tx.staffingProfile.create({
      data: {
        projectId: input.projectId,
        taskTemplateId: input.toTaskTemplateId,
        name: source.name,
        isDefault: source.isDefault,
      },
      select: { id: true },
    });
    await writeEntries(tx, created.id, source.entries);
  }
};

/**
 * Remap every profile of a template after its step graph was replaced.
 *
 * Entries survive by exact output kind only — a replacement is an operator
 * rewriting the graph, not a protocol version moving underneath it — and an
 * entry with no surviving step is dropped rather than reassigned. Each drop is
 * returned as a warning so the replace response says what was lost.
 */
export const remapStaffingProfiles = async (
  tx: Tx,
  input: { taskTemplateId: string; outputKinds: readonly string[]; optionalOutputKinds: readonly string[] },
): Promise<Array<{ profileName: string; outputKind: string }>> => {
  const kinds = new Set(input.outputKinds);
  const optional = new Set(input.optionalOutputKinds);
  const profiles = await tx.staffingProfile.findMany({
    where: { taskTemplateId: input.taskTemplateId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, entries: { select: { outputKind: true }, orderBy: { outputKind: "asc" } } },
  });
  const dropped: Array<{ profileName: string; outputKind: string }> = [];
  for (const profile of profiles) {
    const orphans = profile.entries
      .map((entry) => entry.outputKind)
      .filter((outputKind) => !kinds.has(outputKind));
    if (orphans.length > 0) {
      await tx.staffingProfileEntry.deleteMany({
        where: { profileId: profile.id, outputKind: { in: orphans } },
      });
      for (const outputKind of orphans) dropped.push({ profileName: profile.name, outputKind });
    }
    // A step that stopped being optional cannot keep an include flag, and one
    // that became optional has no opinion yet; both are corrected in place so
    // the saved profile stays a valid one.
    await tx.staffingProfileEntry.updateMany({
      where: { profileId: profile.id, outputKind: { notIn: [...optional] }, include: { not: null } },
      data: { include: null },
    });
  }
  return dropped;
};
