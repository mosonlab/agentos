import {
  LEGACY_TEMPLATE_GENERATIONS,
  legacyGenerationMarkerForTemplateName,
  RunStatus,
  TaskStatus,
  type PrismaClient,
} from "@agentos/db";

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

const STARTED_RUN_STATUSES = [
  RunStatus.CLAIMED,
  RunStatus.PROVISIONING,
  RunStatus.RUNNING,
  RunStatus.WAITING_INBOX,
  RunStatus.SUCCEEDED,
  RunStatus.FAILED,
  RunStatus.TIMED_OUT,
  RunStatus.CANCELLED,
  RunStatus.LOST,
] as const;

const NOT_YET_STARTED_TASK_STATUSES = [TaskStatus.TODO, TaskStatus.BACKLOG] as const;

const UNRESOLVED_VARIABLE = /\{\{\s*[A-Za-z][A-Za-z0-9_]*\s*\}\}/u;

export type RolledPromptDescriptionReconciliation = {
  /** Descriptions recomposed from the current canonical step. */
  rewritten: number;
  /** Tasks already carrying the current text, so nothing was written. */
  alreadyCurrent: number;
  /**
   * Tasks skipped because the current prompt still carries a template variable
   * this sweep cannot resolve. Instantiation-time variables are not persisted,
   * so recomposing would bake a literal `{{name}}` into the description. Left
   * for an operator, and said out loud rather than written badly.
   */
  unresolvedVariables: number;
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

export const reconcileRolledPromptDescriptions = async (
  db: PrismaClient,
): Promise<RolledPromptDescriptionReconciliation> => {
  const result: RolledPromptDescriptionReconciliation = {
    rewritten: 0,
    alreadyCurrent: 0,
    unresolvedVariables: 0,
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

    const candidates = await db.task.findMany({
      where: {
        templateId: legacy.id,
        archivedAt: null,
        status: { in: [...NOT_YET_STARTED_TASK_STATUSES] },
        runs: { none: { status: { in: [...STARTED_RUN_STATUSES] } } },
      },
      select: { id: true, description: true, chainId: true, chainIndex: true },
      orderBy: { id: "asc" },
    });

    for (const task of candidates) {
      if (task.chainIndex === null) continue;
      const current = currentByIndex.get(task.chainIndex);
      if (!current) {
        throw new Error(`Task ${task.id} sits at step ${String(task.chainIndex)} with no matching step on ${canonicalName}`);
      }
      const prompt = interpolate(current.prompt, task.chainId ? { chainId: task.chainId } : {});
      if (UNRESOLVED_VARIABLE.test(prompt)) {
        result.unresolvedVariables += 1;
        await db.taskActivity.create({ data: {
          taskId: task.id,
          actorType: "control-plane",
          body: "This step's canonical prompt was rolled over, but refreshing this task's copy would leave an unresolved template variable in it, so the copy is left as it is for an operator to replace.",
        } });
        continue;
      }
      const description = composeTemplateTaskDescription({
        prompt,
        featureBrief: featureBriefFromTaskDescription(task.description, current.attachmentsFromPrevious) ?? undefined,
        attachmentsFromPrevious: current.attachmentsFromPrevious,
        outputKind: current.outputKind,
      });
      if (description === task.description) {
        result.alreadyCurrent += 1;
        continue;
      }
      await db.task.update({ where: { id: task.id }, data: { description } });
      await db.taskActivity.create({ data: {
        taskId: task.id,
        actorType: "control-plane",
        body: "This step's canonical prompt was rolled over before this task started, so its frozen copy was refreshed from the current prompt. No task that had already started was touched.",
      } });
      result.rewritten += 1;
    }
  }

  return result;
};
