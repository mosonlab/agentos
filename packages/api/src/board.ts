import { createHash } from "node:crypto";

import {
  asJsonObject,
  MERGE_TAIL_KIND,
  projectMergeOutcome,
  runOwnsMergeOutcome,
  runSessionUsageCost,
  sumUsageCosts,
  TaskStatus,
  type Agent,
  type MergeOutcomeProjection,
  type Prisma,
  type PrismaClient,
  type Repo,
  type Run,
  type ScheduleKind,
  type Session,
  type Task,
  type TaskSource,
  type TaskStatus as TaskStatusType,
  type UsageCost,
} from "@anneal/db";

import { chainExecutionOwner, type ChainExecutionOwner } from "./chain-execution-owner.js";
import { chainKey, chainProgressByChain, positions, type ChainProgress } from "./chain.js";

/**
 * The Tasks board's own wire shape.
 *
 * `GET /tasks` returns the whole Task row plus `assigneeAgent`, `repo` and the
 * latest `Run` *with its Session* — 1.58 MB for 112 cards, of which the board
 * renders about 5%. Every 2.5s poll downloaded, decoded and compared all of it.
 *
 * A projection rather than a second endpoint: the board's card is a *view* of
 * the same list the full response serves, and two routes would let the two
 * drift. `?view=board` is the caller saying which fields it will actually read.
 *
 * Every field here is rendered by `TaskCard`. Adding one is a deliberate act:
 * the point of the shape is that its cost is legible.
 */
export type BoardCard = {
  id: string;
  name: string;
  /** Display-only title with a verified chain prefix removed. */
  displayName: string;
  status: TaskStatusType;
  /** Full text, not a truncation: the card clamps it to three lines but the
   *  card menu's `Copy error` hands the operator the whole thing. */
  failureReason: string | null;
  scheduleKind: ScheduleKind;
  runAt: Date | null;
  cron: string | null;
  timezone: string | null;
  approvalGate: boolean;
  templateId: string | null;
  source: TaskSource;
  chainId: string | null;
  chainIndex: number | null;
  chainName: string | null;
  blockedOn: { taskId: string; taskName: string } | null;
  updatedAt: Date;
  assigneeAgent: { id: string; title: string; model: string } | null;
  chainProgress: (ChainProgress & { position: number | null }) | null;
  latestRun: {
    id: string;
    runNumber: number;
    status: string;
    /** The model snapshot taken when the run was claimed, not the assignee's
     *  current configuration: a re-tiered agent must not relabel a past run. */
    model: string;
    costUsd: string | null;
    startedAt: Date | null;
    endedAt: Date | null;
  } | null;
  taskCost: SerializedUsageCost | null;
  /**
   * §SF-1. Parsed server-side from the task's persisted `merge-result` output,
   * and null for every non-integrator task. A mechanical merge that stopped ends
   * its run SUCCEEDED — correctly, because it executed its contract — so a
   * run-centric card that reads only the protocol status renders a stop or a
   * post-merge incident as a green Done. This is what the card renders instead.
   */
  mergeOutcome: MergeOutcomeProjection | null;
  /**
   * The chain a merge-tail repair task repairs.
   *
   * A repair task is deliberately chain-detached — no `chainId`, `chainIndex` or
   * `templateId` — so its own columns say nothing about where it came from, and
   * the board drew it as a loose card beside the chain that produced it. The
   * `repairAttempt` marker it carries names the regression task, and that task's
   * chain is what this reports. Null for every card that is not a repair task.
   */
  repairOf: RepairBinding | null;
};

/** What a repair card needs to sit with its chain: the chain it belongs to and
 *  which kind of repair it is. */
export type RepairBinding = { chainId: string; chainName: string | null; repairKind: string };

/** The Prisma row shape `boardCard` needs — declared structurally so `readBoard`
 *  can select exactly these columns and nothing else. */
export type BoardRow = {
  id: string;
  projectId: string;
  name: string;
  status: TaskStatusType;
  failureReason: string | null;
  scheduleKind: ScheduleKind;
  runAt: Date | null;
  cron: string | null;
  timezone: string | null;
  approvalGate: boolean;
  templateId: string | null;
  source: TaskSource;
  chainId: string | null;
  chainIndex: number | null;
  chainLayer: number | null;
  dispatchAfterTaskId: string | null;
  updatedAt: Date;
  assigneeAgent: { id: string; title: string; model: string } | null;
  templateStep: { name: string } | null;
  runs: Array<{
    id: string;
    runNumber: number;
    status: string;
    model: string;
    subagentModel?: string | null;
    session: {
      nativeChildUsed: boolean;
      costUsd: NonNullable<Parameters<typeof runSessionUsageCost>[0]["session"]>["costUsd"];
      inputTokens: number | null;
      cachedInputTokens: number | null;
      outputTokens: number | null;
      startedAt: Date | null;
      endedAt: Date | null;
    } | null;
  }>;
  stepOutput?: { kind: string; body: string; runId: string | null } | null;
};

/** The predecessor row resolved in one batch for the current board page. */
export type BoardBlockedOnTask = {
  id: string;
  name: string;
  status: TaskStatusType;
};

/** Decimal columns arrive as Prisma.Decimal; the web client reads them as the
 *  strings JSON already turns them into, so the projection states that. */
const decimal = (value: unknown): string | null =>
  (value === null || value === undefined ? null : String(value));

export type SerializedUsageCost = Omit<UsageCost, "costUsd"> & { costUsd: string | null };

export const serializeUsageCost = (cost: UsageCost | null): SerializedUsageCost | null =>
  cost === null ? null : { ...cost, costUsd: decimal(cost.costUsd) };

/** The instantiated chain name is persisted as the prefix of every task name.
 * The template step is the lossless delimiter: only remove a suffix we can
 * prove was added by instantiation, never guess from punctuation in a manual
 * task name. */
export const taskChainName = (row: Pick<BoardRow, "name" | "chainId" | "templateStep">): string | null => {
  if (row.chainId === null || row.templateStep === null) return null;
  const suffix = `: ${row.templateStep.name}`;
  return row.name.endsWith(suffix) ? row.name.slice(0, -suffix.length) : null;
};

export type ChainDisplay = { chainName: string | null; displayName: string };

/**
 * Derives display-only chain identity once, on the server, for every card in a
 * response. Template-instantiated rows have an exact persisted suffix as proof.
 * Direct API chains need at least two rows and one `name: ` prefix carried by
 * every returned row; punctuation in one task name is never enough to guess.
 */
export const chainDisplayByTask = (rows: readonly Pick<BoardRow, "id" | "projectId" | "name" | "chainId" | "templateStep">[]): Map<string, ChainDisplay> => {
  const result = new Map<string, ChainDisplay>(rows.map((row) => [row.id, { chainName: null, displayName: row.name }]));
  const grouped = new Map<string, typeof rows[number][]>();
  for (const row of rows) {
    if (row.chainId === null) continue;
    const key = `${row.projectId}\u0000${row.chainId}`;
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }
  for (const group of grouped.values()) {
    const exact = group.map(taskChainName);
    const exactName = exact[0] ?? null;
    let chainName: string | null = exactName !== null && exact.every((name) => name === exactName) ? exactName : null;
    if (chainName === null && group.length > 1) {
      const candidates = [...group[0]!.name.matchAll(/: /g)]
        .map((match) => group[0]!.name.slice(0, match.index))
        .filter((candidate) => candidate.length > 0);
      chainName = [...candidates].reverse().find((candidate) => group.every((row) => (
        row.name.startsWith(`${candidate}: `) && row.name.length > candidate.length + 2
      ))) ?? null;
    }
    if (chainName === null) continue;
    const prefix = `${chainName}: `;
    for (const row of group) {
      result.set(row.id, { chainName, displayName: row.name.slice(prefix.length) });
    }
  }
  return result;
};

export const boardCard = (
  row: BoardRow,
  chainProgress: (ChainProgress & { position: number | null }) | null,
  display: ChainDisplay = { chainName: taskChainName(row), displayName: row.name },
  predecessor: BoardBlockedOnTask | null = null,
  repairOf: RepairBinding | null = null,
): BoardCard => {
  const run = row.runs[0];
  const taskCost = sumUsageCosts(row.runs.flatMap((item) => item.session === null
    ? []
    : [runSessionUsageCost(item)!]));
  return {
    id: row.id,
    name: row.name,
    displayName: display.displayName,
    status: row.status,
    failureReason: row.failureReason,
    scheduleKind: row.scheduleKind,
    runAt: row.runAt,
    cron: row.cron,
    timezone: row.timezone,
    approvalGate: row.approvalGate,
    templateId: row.templateId,
    source: row.source,
    chainId: row.chainId,
    chainIndex: row.chainIndex,
    chainName: display.chainName,
    blockedOn: row.dispatchAfterTaskId !== null && predecessor !== null && predecessor.status !== TaskStatus.DONE
      ? { taskId: predecessor.id, taskName: predecessor.name }
      : null,
    updatedAt: row.updatedAt,
    assigneeAgent: row.assigneeAgent === null
      ? null
      : { id: row.assigneeAgent.id, title: row.assigneeAgent.title, model: row.assigneeAgent.model },
    chainProgress,
    latestRun: run === undefined
      ? null
      : {
          id: run.id,
          runNumber: run.runNumber,
          status: run.status,
          model: run.model,
          costUsd: decimal(run.session?.costUsd),
          startedAt: run.session?.startedAt ?? null,
          endedAt: run.session?.endedAt ?? null,
        },
    taskCost: serializeUsageCost(taskCost),
    // Bound to the run the card actually shows: a stop recorded by run 1 is not
    // run 2's outcome, and the card's only run line is the newest run's.
    mergeOutcome: run !== undefined && runOwnsMergeOutcome(row.stepOutput, run.id, run.id)
      ? projectMergeOutcome(row.stepOutput)
      : null,
    repairOf,
  };
};

/**
 * The chain binding a `repairAttempt` marker carries, or null when the marker is
 * not the repair task's own side of one.
 *
 * The same kind is written on both sides of a repair: the regression task names
 * the repair task, and the repair task names the regression task. Only the
 * second names a chain this card can be put under, so a marker without a
 * `regressionTaskId` is not this card's binding rather than a broken one.
 */
export const repairBinding = (
  metadata: Record<string, unknown> | null,
  chainOfRegressionTask: (regressionTaskId: string) => { chainId: string; chainName: string | null } | null,
): RepairBinding | null => {
  const regressionTaskId = typeof metadata?.regressionTaskId === "string" ? metadata.regressionTaskId : null;
  const repairKind = typeof metadata?.repairKind === "string" ? metadata.repairKind : null;
  if (regressionTaskId === null || repairKind === null) return null;
  const chain = chainOfRegressionTask(regressionTaskId);
  return chain === null ? null : { chainId: chain.chainId, chainName: chain.chainName, repairKind };
};

export type TaskReadScope = {
  projectId?: string;
  archived: "false" | "true" | "all";
};

type ChainProgressWire = ChainProgress & { position: number | null };

type ChainSubject = {
  id: string;
  projectId: string;
  chainId: string | null;
  chainIndex: number | null;
  chainLayer: number | null;
  status: TaskStatusType;
  name: string;
  templateStep: { name: string } | null;
};

const taskWhere = (scope: TaskReadScope): Prisma.TaskWhereInput => ({
  ...(scope.projectId ? { projectId: scope.projectId } : {}),
  ...(scope.archived === "false" ? { archivedAt: null }
    : scope.archived === "true" ? { archivedAt: { not: null } }
    : {}),
});

const taskOrderBy = [{ createdAt: "desc" as const }, { id: "asc" as const }];

/**
 * Resolve progress for every chain represented by one task-list page.
 *
 * Progress counts archived siblings even when the page does not show them, and
 * the project participates in every in-memory key because `chainId` alone is
 * not globally unique. An unenriched full list and a page with no indexed chain
 * rows both skip the lookup entirely.
 */
const chainProgressLookup = async (
  db: PrismaClient,
  rows: readonly ChainSubject[],
  scope: TaskReadScope,
  enrich: boolean,
): Promise<(task: ChainSubject) => ChainProgressWire | null> => {
  const chainIds = !enrich ? [] : [...new Set(rows
    .filter((task) => task.chainIndex !== null)
    .map((task) => task.chainId)
    .filter((value): value is string => value !== null))];
  const chainRows = chainIds.length === 0 ? [] : await db.task.findMany({
    where: {
      chainId: { in: chainIds },
      chainIndex: { not: null },
      ...(scope.projectId ? { projectId: scope.projectId } : {}),
    },
    select: {
      id: true, projectId: true, chainId: true, chainIndex: true, status: true,
      chainLayer: true, name: true, archivedAt: true, templateStep: { select: { name: true } },
    },
    orderBy: { chainIndex: "asc" },
  });
  const progressByChain = chainProgressByChain(chainRows);
  const positionsByChain = new Map<string, Map<string, number>>();
  for (const row of chainRows) {
    if (row.chainId === null) continue;
    const key = chainKey({ projectId: row.projectId, chainId: row.chainId });
    if (positionsByChain.has(key)) continue;
    positionsByChain.set(key, positions(chainRows.filter((candidate) => (
      candidate.chainId !== null && chainKey({ projectId: candidate.projectId, chainId: candidate.chainId }) === key
    ))));
  }
  return (task) => {
    if (!enrich || task.chainId === null) return null;
    // Match the chain-detail read model for a malformed one-row chain whose
    // identity survived but whose index did not.
    if (task.chainIndex === null) {
      return {
        chainId: task.chainId,
        done: task.status === TaskStatus.DONE ? 1 : 0,
        total: 1,
        activeStepName: task.templateStep?.name ?? task.name,
        activeStatus: task.status.toLowerCase(),
        currentLayer: 1,
        layerCount: 1,
        position: 1,
      };
    }
    const key = chainKey({ projectId: task.projectId, chainId: task.chainId });
    const progress = progressByChain.get(key) ?? null;
    return progress ? { ...progress, position: positionsByChain.get(key)?.get(task.id) ?? null } : null;
  };
};

/** Read the complete board card model, including every lookup needed to project it. */
export const readBoard = async (db: PrismaClient, scope: TaskReadScope): Promise<BoardCard[]> => {
  const rows: BoardRow[] = await db.task.findMany({
    where: taskWhere(scope),
    orderBy: taskOrderBy,
    select: {
      id: true, projectId: true, name: true, status: true, failureReason: true,
      scheduleKind: true, runAt: true, cron: true, timezone: true, approvalGate: true,
      templateId: true, source: true, chainId: true, chainIndex: true, chainLayer: true, updatedAt: true,
      dispatchAfterTaskId: true,
      assigneeAgent: { select: { id: true, title: true, model: true } },
      templateStep: { select: { name: true } },
      runs: {
        orderBy: { runNumber: "desc" },
        select: {
          id: true, runNumber: true, status: true, model: true, subagentModel: true,
          session: {
            select: {
              nativeChildUsed: true, costUsd: true, inputTokens: true, cachedInputTokens: true, outputTokens: true,
              startedAt: true, endedAt: true,
            },
          },
        },
      },
      // §SF-1: a stopped mechanical merge is not a successful board outcome
      // merely because its protocol Run completed successfully.
      stepOutput: { select: { kind: true, body: true, runId: true } },
    },
  });
  const progressFor = await chainProgressLookup(db, rows, scope, true);
  const displayByTask = chainDisplayByTask(rows);

  const predecessorIds = [...new Set(rows
    .map((row) => row.dispatchAfterTaskId)
    .filter((value): value is string => typeof value === "string" && value.length > 0))];
  const predecessorById = new Map<string, BoardBlockedOnTask>();
  if (predecessorIds.length > 0) {
    const predecessors = await db.task.findMany({
      where: { id: { in: predecessorIds } },
      select: { id: true, name: true, status: true },
    });
    for (const predecessor of predecessors) predecessorById.set(predecessor.id, predecessor);
  }

  const detachedIds = rows.filter((row) => row.chainId === null).map((row) => row.id);
  const repairMarkers = detachedIds.length === 0 ? [] : await db.taskActivity.findMany({
    where: {
      taskId: { in: detachedIds },
      actorType: "control-plane",
      metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.repairAttempt },
    },
    select: { taskId: true, metadata: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const repairByTask = new Map<string, RepairBinding>();
  if (repairMarkers.length > 0) {
    const regressionIds = [...new Set(repairMarkers.flatMap((marker) => {
      const value = asJsonObject(marker.metadata)?.regressionTaskId;
      return typeof value === "string" ? [value] : [];
    }))];
    const regressionTasks = await db.task.findMany({
      where: { id: { in: regressionIds }, ...(scope.projectId ? { projectId: scope.projectId } : {}) },
      select: { id: true, projectId: true, chainId: true },
    });
    const chainOfTask = new Map<string, { key: string; chainId: string }>();
    for (const task of regressionTasks) {
      if (task.chainId === null) continue;
      chainOfTask.set(task.id, {
        key: chainKey({ projectId: task.projectId, chainId: task.chainId }),
        chainId: task.chainId,
      });
    }
    const chainNameByKey = new Map<string, string | null>();
    for (const row of rows) {
      if (row.chainId === null) continue;
      const key = chainKey({ projectId: row.projectId, chainId: row.chainId });
      if (chainNameByKey.has(key)) continue;
      chainNameByKey.set(key, displayByTask.get(row.id)?.chainName ?? null);
    }
    const chainOfRegressionTask = (taskId: string): { chainId: string; chainName: string | null } | null => {
      const chain = chainOfTask.get(taskId);
      return chain === undefined ? null : {
        chainId: chain.chainId,
        chainName: chainNameByKey.get(chain.key) ?? null,
      };
    };
    for (const marker of repairMarkers) {
      if (repairByTask.has(marker.taskId)) continue;
      const binding = repairBinding(asJsonObject(marker.metadata), chainOfRegressionTask);
      if (binding !== null) repairByTask.set(marker.taskId, binding);
    }
  }

  return rows.map((row) => boardCard(
    row,
    progressFor(row),
    displayByTask.get(row.id),
    row.dispatchAfterTaskId === null ? null : predecessorById.get(row.dispatchAfterTaskId) ?? null,
    repairByTask.get(row.id) ?? null,
  ));
};

const taskListInclude = {
  assigneeAgent: true,
  repo: true,
  templateStep: {
    select: {
      name: true,
      stepIndex: true,
      outputKind: true,
      taskTemplate: { select: { name: true } },
    },
  },
  // Run.output is forensic bulk and no list caller reads it.
  runs: {
    orderBy: { runNumber: "desc" },
    take: 1,
    omit: { output: true },
    include: { session: true },
  },
} as const satisfies Prisma.TaskInclude;

export type TaskListRow = Task & {
  assigneeAgent: Agent | null;
  repo: Repo | null;
  templateStep: {
    name: string;
    stepIndex: number;
    outputKind: string;
    taskTemplate: { name: string };
  } | null;
  runs: Array<Omit<Run, "output"> & { session: Session | null }>;
  executionOwner: ChainExecutionOwner;
  chainProgress: ChainProgressWire | null;
  recurringLastFiredAt: Date | null;
  recurringFireCount: number;
};

/** Read the full task list and optionally attach its expensive enrichment. */
export const readTaskList = async (
  db: PrismaClient,
  scope: TaskReadScope,
  options: { enrich: boolean },
): Promise<TaskListRow[]> => {
  const tasks = await db.task.findMany({
    where: taskWhere(scope),
    orderBy: taskOrderBy,
    include: taskListInclude,
  });
  const progressFor = await chainProgressLookup(db, tasks, scope, options.enrich);
  const cronIds = !options.enrich ? [] : tasks
    .filter((task) => task.scheduleKind === "CRON")
    .map((task) => task.id);
  const firedGroups = cronIds.length === 0 ? [] : await db.task.groupBy({
    by: ["recurringSourceTaskId"],
    where: { recurringSourceTaskId: { in: cronIds } },
    _max: { createdAt: true },
    _count: { _all: true },
  });
  const firedByDefinition = new Map(firedGroups.map((group) => [group.recurringSourceTaskId, group]));

  return tasks.map((task) => ({
    ...task,
    executionOwner: chainExecutionOwner(task),
    chainProgress: progressFor(task),
    recurringLastFiredAt: firedByDefinition.get(task.id)?._max.createdAt ?? null,
    recurringFireCount: firedByDefinition.get(task.id)?._count._all ?? 0,
  }));
};

/**
 * A weak ETag over the serialized body.
 *
 * Weak because it is a hash of the representation this process just produced,
 * not a durable resource version: two processes serializing the same rows agree,
 * and nothing downstream may treat it as a byte-range validator.
 *
 * The idle board is the case this exists for. Nothing changed for a minute means
 * 24 polls that each moved 1.58 MB; with a validator they move a header.
 */
export const etagFor = (body: string): string =>
  `W/"${createHash("sha1").update(body).digest("base64url")}"`;

/** RFC 9110 §13.1.2: `If-None-Match` is a list, and `*` matches any current
 *  representation. Compared verbatim otherwise — this route only ever mints weak
 *  tags, so there is no strong/weak normalisation to do. */
export const etagMatches = (header: string | undefined, tag: string): boolean => {
  if (header === undefined) return false;
  const candidates = header.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
  return candidates.includes("*") || candidates.includes(tag);
};
