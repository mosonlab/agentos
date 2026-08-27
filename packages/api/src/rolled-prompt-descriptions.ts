import {
  LEGACY_TEMPLATE_GENERATIONS,
  legacyGenerationMarkerForTemplateName,
  TaskStatus,
  type Prisma,
  type PrismaClient,
} from "@agentos/db";

import { lockTaskMutationRows } from "./task-write.js";
import {
  composeTemplateTaskDescription,
  featureBriefFromTaskDescription,
  interpolate,
} from "./templates.js";

/**
 * Refresh the frozen prompt copy carried by tasks a prompt-only rollover left
 * behind.
 *
 * A task's `description` is composed once, at instantiation, from its template
 * step's prompt. That copy is the whole point for a task that has already run:
 * it keeps the contract the work was dispatched under. It is a liability for a
 * task that has *not* run yet, because a rollover happens precisely when the
 * old prompt stopped being true -- after the blind-review retirement, the frozen
 * copy tells a regression run to invoke `db:authority-check`, which no longer
 * exists, and permits an `authority-resign` verdict the parser no longer takes.
 *
 * So this sweep recomposes the description of not-yet-started tasks from the
 * current canonical step, and leaves every started task alone.
 *
 * It is restricted to prompt-only rollovers on purpose. Those are the
 * generations registered with a `promptDigest`, and they are structure
 * identical by construction, so a step ordinal on the retired graph means the
 * same node on the current one. A structural rollover has no such guarantee --
 * a step may have been inserted or removed -- and copying across it could hand
 * a task the wrong node's prompt, which is worse than a stale one.
 */

/**
 * "Not yet started" means no Run at all, not merely no *started* Run.
 *
 * A queued Run has already been opened against the description as it stood, and
 * the run's prompt hash was taken from it. Rewriting the text under a queued run
 * would leave the two disagreeing, so a task that has been enqueued is out of
 * scope even though nothing has claimed it yet.
 */
const NOT_YET_STARTED_TASK_STATUSES = [TaskStatus.TODO, TaskStatus.BACKLOG] as const;

const UNRESOLVED_VARIABLE = /\{\{\s*[A-Za-z][A-Za-z0-9_]*\s*\}\}/u;

export type RolledPromptDescriptionReconciliation = {
  /** Descriptions recomposed from the current canonical step. */
  rewritten: number;
  /** Tasks already carrying the current text, so nothing was written. */
  alreadyCurrent: number;
  /**
   * Tasks skipped because the current prompt still carries a template variable
   * no persisted task field supplies. Recomposing would bake a literal
   * `{{name}}` into the description, so the copy is left for an operator and the
   * reason is said out loud rather than written badly.
   */
  unresolvedVariables: number;
  /** Tasks a runner or another instance moved between the scan and the write. */
  startedBeforeRewrite: number;
};

/** The canonical template name a legacy rollover name was minted from. */
export const canonicalNameFromLegacyName = (legacyName: string): string | null => {
  const marker = legacyGenerationMarkerForTemplateName(legacyName);
  if (marker === null) return null;
  const separator = legacyName.indexOf(`-legacy-${marker}-`);
  return separator > 0 ? legacyName.slice(0, separator) : null;
};

/** Whether a legacy generation retired prompts only, leaving the shape intact. */
const isPromptOnlyGeneration = (canonicalName: string, marker: string): boolean =>
  LEGACY_TEMPLATE_GENERATIONS[canonicalName]
    ?.some((generation) => generation.marker === marker && generation.promptDigest !== undefined)
  ?? false;

/**
 * The interpolation a task can be rebuilt from, out of what the task row itself
 * persists.
 *
 * Instantiation interpolates from the caller's variables, and those are not
 * stored. Both variables the canonical prompts actually use do survive on the
 * task: `chainId` directly, and `branchName` as `targetBranch`, which every
 * non-first step of a chain carries. Reading them from the row rather than
 * guessing is what lets a regression step -- the step this sweep exists for,
 * and the one prompt that names `{{branchName}}` -- be rebuilt at all.
 */
export const persistedPromptVariables = (task: {
  chainId: string | null;
  targetBranch: string | null;
}): Record<string, string> => ({
  ...(task.chainId ? { chainId: task.chainId } : {}),
  ...(task.targetBranch ? { branchName: task.targetBranch } : {}),
});

type Tx = Prisma.TransactionClient;

const noteOnce = async (tx: Tx, taskId: string, body: string): Promise<void> => {
  const existing = await tx.taskActivity.count({ where: { taskId, actorType: "control-plane", body } });
  if (existing > 0) return;
  await tx.taskActivity.create({ data: { taskId, actorType: "control-plane", body } });
};

const UNRESOLVED_NOTE = "This step's canonical prompt was rolled over, but refreshing this task's copy would leave an unresolved template variable in it, so the copy is left as it is for an operator to replace.";
const REWRITTEN_NOTE = "This step's canonical prompt was rolled over before this task started, so its frozen copy was refreshed from the current prompt. No task that had already started was touched.";

export const reconcileRolledPromptDescriptions = async (
  db: PrismaClient,
): Promise<RolledPromptDescriptionReconciliation> => {
  const result: RolledPromptDescriptionReconciliation = {
    rewritten: 0,
    alreadyCurrent: 0,
    unresolvedVariables: 0,
    startedBeforeRewrite: 0,
  };

  const legacyTemplates = await db.taskTemplate.findMany({
    where: { name: { contains: "-legacy-" } },
    select: { id: true, name: true, projectId: true },
    orderBy: { id: "asc" },
  });

  for (const legacy of legacyTemplates) {
    const marker = legacyGenerationMarkerForTemplateName(legacy.name);
    const canonicalName = canonicalNameFromLegacyName(legacy.name);
    if (marker === null || canonicalName === null) continue;
    if (!isPromptOnlyGeneration(canonicalName, marker)) continue;

    const canonical = await db.taskTemplate.findFirst({
      where: { projectId: legacy.projectId, name: canonicalName },
      select: { steps: { select: { stepIndex: true, prompt: true, outputKind: true, attachmentsFromPrevious: true } } },
    });
    // The rollover creates the successor in the same transaction that renames
    // the outgoing row, so its absence is a broken invariant, not a state to
    // paper over.
    if (!canonical) {
      throw new Error(`Legacy template ${legacy.id} has no canonical ${canonicalName} in its project to refresh prompts from`);
    }
    const currentByIndex = new Map(canonical.steps.map((step) => [step.stepIndex, step]));

    // Discovery only; every decision is retaken under the lock below.
    const candidates = await db.task.findMany({
      where: {
        templateId: legacy.id,
        archivedAt: null,
        status: { in: [...NOT_YET_STARTED_TASK_STATUSES] },
        runs: { none: {} },
      },
      select: { id: true, chainIndex: true },
      orderBy: { id: "asc" },
    });

    for (const candidate of candidates) {
      if (candidate.chainIndex === null) continue;
      const current = currentByIndex.get(candidate.chainIndex);
      if (!current) {
        throw new Error(`Task ${candidate.id} sits at step ${String(candidate.chainIndex)} with no matching step on ${canonicalName}`);
      }
      const outcome = await db.$transaction(async (tx) => {
        await lockTaskMutationRows(tx, candidate.id);
        const task = await tx.task.findUnique({
          where: { id: candidate.id },
          select: {
            description: true,
            chainId: true,
            targetBranch: true,
            status: true,
            archivedAt: true,
            _count: { select: { runs: true } },
          },
        });
        // A runner may have opened or claimed a run between the scan and this
        // write. Rewriting now would leave a run's prompt hash disagreeing with
        // the text it was taken from.
        if (!task || task.archivedAt !== null) return "moved" as const;
        if (task._count.runs > 0) return "moved" as const;
        if (!NOT_YET_STARTED_TASK_STATUSES.some((status) => status === task.status)) return "moved" as const;

        const prompt = interpolate(current.prompt, persistedPromptVariables(task));
        if (UNRESOLVED_VARIABLE.test(prompt)) {
          await noteOnce(tx, candidate.id, UNRESOLVED_NOTE);
          return "unresolved" as const;
        }
        const description = composeTemplateTaskDescription({
          prompt,
          featureBrief: featureBriefFromTaskDescription(task.description, current.attachmentsFromPrevious) ?? undefined,
          attachmentsFromPrevious: current.attachmentsFromPrevious,
          outputKind: current.outputKind,
        });
        if (description === task.description) return "current" as const;
        await tx.task.update({ where: { id: candidate.id }, data: { description } });
        await tx.taskActivity.create({ data: {
          taskId: candidate.id,
          actorType: "control-plane",
          body: REWRITTEN_NOTE,
        } });
        return "rewritten" as const;
      });
      if (outcome === "rewritten") result.rewritten += 1;
      else if (outcome === "current") result.alreadyCurrent += 1;
      else if (outcome === "unresolved") result.unresolvedVariables += 1;
      else result.startedBeforeRewrite += 1;
    }
  }

  return result;
};
