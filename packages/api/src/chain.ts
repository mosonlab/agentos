import {
  ACTIVE_RUN_STATUSES,
  AssigneeType,
  isMergeReadinessStep,
  lockAgentRepoGrant,
  Prisma,
  TaskStatus,
} from "@anneal/db";

import { runBudgetCeiling } from "./execution.js";
import type { Refusal } from "./refusal.js";

/**
 * The chain columns every consumer of this module needs, as a plain object.
 *
 * Deliberately not a Prisma payload type: `GET /tasks`, `GET /tasks/:id/chain`
 * and `GET /triggers/:id/fires` all assemble progress from differently-shaped
 * queries, and keeping the signature structural is what lets one implementation
 * serve all three — and be unit-tested without a database.
 */
export type ChainRow = {
  id: string;
  projectId: string;
  chainId: string | null;
  chainIndex: number | null;
  /** Stored execution layer. During the expand phase this may still be null
   *  on legacy fixtures; progress falls back to chainIndex for those rows. */
  chainLayer: number | null;
  name: string;
  status: TaskStatus;
  archivedAt: Date | null;
  templateStep: { name: string; stepIndex?: number; outputKind?: string } | null;
  /** A bound first task carries the predecessor id. The predecessor relation
   * is fetched only by the chain-detail route when that id is present; making
   * both fields optional keeps legacy board/progress callers unchanged. */
  dispatchAfterTaskId?: string | null;
  dispatchAfter?: Pick<DispatchPredecessor, "status"> | null;
};

export type DispatchPredecessor = {
  id: string;
  name: string;
  status: TaskStatus;
};

export type ChainProgress = {
  chainId: string;
  done: number;
  total: number;
  activeStepName: string;
  activeStatus: string;
  /** Dense one-based ordinal of the active stored layer. */
  currentLayer: number;
  /** Number of distinct execution layers in the chain. */
  layerCount: number;
};

/** The step's own name when it came from a template, else the task's. */
export const stepName = (row: Pick<ChainRow, "name" | "templateStep">): string => row.templateStep?.name ?? row.name;

const byChainIndex = (left: ChainRow, right: ChainRow): number => (left.chainIndex ?? 0) - (right.chainIndex ?? 0);

/** A missing layer can only occur during the nullable expand migration (or in
 * old API fixtures). Treating the node ordinal as its layer preserves the
 * legacy linear contract without reintroducing a linked-list successor. */
const executionLayer = (row: { chainLayer?: number | null; chainIndex: number | null }): number | null => (
  row.chainLayer ?? row.chainIndex
);

const byExecutionPosition = <T extends { chainLayer?: number | null; chainIndex: number | null; id: string }>(
  left: T,
  right: T,
): number => (
  (executionLayer(left) ?? 0) - (executionLayer(right) ?? 0)
    || (left.chainIndex ?? 0) - (right.chainIndex ?? 0)
    || left.id.localeCompare(right.id)
);

/**
 * `n/m` plus the step the chain is currently sitting on.
 *
 * `total` is the row count, not `max(chainIndex) + 1`: a template with sparse
 * step indices would otherwise read "step 9 of 3". Archived rows count toward
 * both numbers — a step that was done and then archived is still done.
 */
export const chainProgress = (rows: ChainRow[]): Omit<ChainProgress, "chainId"> | null => {
  if (rows.length === 0) return null;
  const ordered = [...rows].sort(byChainIndex);
  const done = ordered.filter((row) => row.status === TaskStatus.DONE).length;
  const active = ordered.find((row) => row.status !== TaskStatus.DONE) ?? ordered[ordered.length - 1]!;
  // The expand migration backfills every legacy row, but keeping the
  // chainIndex fallback makes progress safe for rows read while that migration
  // is staged and for malformed one-row fixtures. Stored layers may be sparse,
  // zero-based, or one-based; the board presents their dense rank instead.
  const effectiveLayer = (row: ChainRow, index: number): number => row.chainLayer ?? row.chainIndex ?? index;
  const layerValues = ordered.map(effectiveLayer);
  const distinctLayers = [...new Set(layerValues)].sort((left, right) => left - right);
  const denseLayer = new Map(distinctLayers.map((layer, index) => [layer, index + 1]));
  return {
    done,
    total: ordered.length,
    activeStepName: stepName(active),
    activeStatus: active.status.toLowerCase(),
    currentLayer: denseLayer.get(effectiveLayer(active, ordered.indexOf(active))) ?? 1,
    layerCount: distinctLayers.length,
  };
};

/**
 * `GET /tasks` is callable globally, with no projectId (the Projects page does
 * exactly that), and `chainId` is unique per project only by convention — no
 * constraint enforces it. Keying by the pair is what stops a task reading a
 * chain that belongs to another project.
 */
export const chainKey = (row: { projectId: string; chainId: string }): string => `${row.projectId}:${row.chainId}`;

export const chainProgressByChain = (rows: ChainRow[]): Map<string, ChainProgress> => {
  const groups = new Map<string, ChainRow[]>();
  for (const row of rows) {
    if (!row.chainId) continue;
    const key = chainKey({ projectId: row.projectId, chainId: row.chainId });
    const group = groups.get(key);
    if (group) group.push(row); else groups.set(key, [row]);
  }
  const progress = new Map<string, ChainProgress>();
  for (const [key, group] of groups) {
    const computed = chainProgress(group);
    if (computed) progress.set(key, { chainId: group[0]!.chainId!, ...computed });
  }
  return progress;
};

/** 1-based ordinal within the chain, by chainIndex ascending. Not chainIndex
 *  itself, which is sparse whenever a template skips step numbers. */
export const positions = (rows: ChainRow[]): Map<string, number> => {
  const ordered = [...rows].sort(byChainIndex);
  return new Map(ordered.map((row, index) => [row.id, index + 1]));
};

/** What the route knows about a task's runs, in the facts `startable` needs.
 *  `total` is a count, not the latest run number: `Run` is genuinely one-to-many
 *  and a task at its ceiling whose last run is terminal must not look startable. */
export type RunFacts = {
  total: number;
  active: boolean;
  /** The highest `budgetGrants` any of the task's runs carries: attempts granted
   *  on top of the configured budget, refunds and human re-authorizations alike.
   *  Deliberately not `maxRunsPerTask`, which is the two added together and so
   *  cannot tell a refund from a budget an operator has since lowered. Null (or
   *  absent) means nothing granted, which is also what a caller that does not
   *  supply it gets — and that direction fails closed. */
  budgetGrants?: number | null;
};

export type StartableRow = {
  status: TaskStatus;
  assigneeType: AssigneeType;
  assigneeAgentId: string | null;
  repoId: string | null;
  archivedAt: Date | null;
  assigneeAgent: { archivedAt: Date | null } | null;
  /** The exact AgentRepoAccess row exists at decision time. */
  hasRepoGrant: boolean;
  /** Optional binding facts. Omitted means this is a historical/unbound row. */
  dispatchAfterTaskId?: string | null;
  dispatchAfter?: Pick<DispatchPredecessor, "status"> | null;
};

export type StartabilityChecklist = {
  repoBound: boolean;
  agentAssignee: boolean;
  repoAccessGrant: boolean;
  budgetRemaining: boolean;
  noActiveRun: boolean;
  predecessorsDone: boolean;
};

export type TaskStartability = {
  startable: boolean;
  checklist: StartabilityChecklist;
};

/** A binding is resolved only after its predecessor is durably DONE. A caller
 * that knows a row is bound but did not load the relation fails closed. */
export const dispatchBindingResolved = (
  row: Pick<StartableRow, "dispatchAfterTaskId" | "dispatchAfter">,
): boolean => row.dispatchAfterTaskId == null || row.dispatchAfter?.status === TaskStatus.DONE;

/** One verdict shared by every read surface and the authoritative start guard.
 *  The checklist is intentionally the operator-configurable subset requested by
 *  the board contract; task archive/status and archived-agent guards still
 *  participate in `startable` without pretending to be configuration items. */
export const taskStartability = (
  row: StartableRow,
  facts: RunFacts,
  maxSessionsPerTask: number,
  predecessorsDone: boolean,
): TaskStartability => {
  const bindingResolved = dispatchBindingResolved(row);
  const checklist = {
    repoBound: row.repoId !== null,
    agentAssignee: row.assigneeType === AssigneeType.AGENT && row.assigneeAgentId !== null,
    repoAccessGrant: row.hasRepoGrant,
    budgetRemaining: facts.total < runBudgetCeiling(maxSessionsPerTask, facts.budgetGrants),
    noActiveRun: !facts.active,
    predecessorsDone: predecessorsDone && bindingResolved,
  };
  return {
    checklist,
    startable: Object.values(checklist).every(Boolean)
      && row.assigneeAgent?.archivedAt !== undefined
      && row.assigneeAgent?.archivedAt === null
      && row.archivedAt === null
      && (row.status === TaskStatus.TODO || row.status === TaskStatus.BACKLOG),
  };
};

/** The first unfinished surviving row before target, or null when the ordered
 * prefix is complete. This is the predecessor named by the 409 response. */
export const blockingPredecessor = <T extends Pick<ChainRow, "chainIndex" | "id" | "name" | "status"> & { chainLayer?: number | null }>(
  rows: T[],
  targetId: string,
): T | null => {
  const ordered = [...rows].sort(byExecutionPosition);
  const target = ordered.find((item) => item.id === targetId);
  if (!target) return null;
  const targetLayer = executionLayer(target);
  return ordered.find((item) => {
    const itemLayer = executionLayer(item);
    return itemLayer !== null && targetLayer !== null
      ? itemLayer < targetLayer && item.status !== TaskStatus.DONE
      : item.id !== target.id && item.status !== TaskStatus.DONE;
  }) ?? null;
};

/** One grouped run query → per-task facts. Constant in task count, which is what
 *  makes "no N+1" a property of this function rather than a rule three routes
 *  have to remember. */
export const runFactsByTask = (
  // `taskId` is nullable in Prisma's groupBy output even though Run.taskId is
  // not; rows without one are skipped rather than cast away.
  rows: Array<{
    taskId: string | null;
    status: string;
    _count: { _all: number };
    _max?: { budgetGrants: number | null };
  }>,
  activeStatuses: readonly string[],
): Map<string, RunFacts> => {
  const facts = new Map<string, RunFacts>();
  for (const row of rows) {
    if (row.taskId === null) continue;
    const current = facts.get(row.taskId) ?? { total: 0, active: false, budgetGrants: null };
    facts.set(row.taskId, {
      total: current.total + row._count._all,
      active: current.active || activeStatuses.includes(row.status),
      // A max across the status groups, not the newest run's value: the groupBy
      // is unordered, and grants only ever grow, so the two agree.
      budgetGrants: Math.max(current.budgetGrants ?? 0, row._max?.budgetGrants ?? 0) || null,
    });
  }
  return facts;
};

const admissionTaskInclude = {
  assigneeAgent: { select: { id: true, name: true, title: true, archivedAt: true } },
  repo: { select: { id: true, name: true, defaultBranch: true } },
  dispatchAfter: { select: { id: true, name: true, status: true } },
  templateStep: {
    select: {
      stepIndex: true,
      outputKind: true,
      taskTemplate: { select: { name: true } },
    },
  },
} as const satisfies Prisma.TaskInclude;

export type StepAdmissionTask = Prisma.TaskGetPayload<{ include: typeof admissionTaskInclude }>;

export type FoundStepAdmission = {
  task: StepAdmissionTask;
  facts: RunFacts;
  verdict: TaskStartability;
  blocker: { id: string; name: string } | null;
  refusal: Refusal | null;
};

export type StepAdmission =
  | FoundStepAdmission
  | {
    task: null;
    facts: null;
    verdict: null;
    blocker: null;
    refusal: Refusal;
  };

type ReadStepAdmissionOptions = { locked: boolean };

const grantKey = (input: { projectId: string; agentId: string; repoId: string }): string => (
  `${input.projectId}:${input.agentId}:${input.repoId}`
);

const refusalForStepAdmission = (
  task: StepAdmissionTask,
  verdict: TaskStartability,
  blocker: { id: string; name: string } | null,
): Refusal | null => {
  if (!verdict.checklist.predecessorsDone) {
    if (blocker) {
      return { reason: "conflict", message: `Cannot start ${task.name}; predecessor ${blocker.name} is not done` };
    }
    const predecessorName = task.dispatchAfter?.name ?? task.dispatchAfterTaskId;
    return {
      reason: "conflict",
      message: `Cannot start ${task.name}; bound predecessor ${predecessorName ?? "unknown"} is not done`,
    };
  }
  if (task.archivedAt !== null) return { reason: "conflict", message: "Cannot start an archived task" };
  if (task.status === TaskStatus.DONE) return { reason: "conflict", message: "Task is already done" };
  if (task.assigneeType !== AssigneeType.AGENT) {
    return { reason: "conflict", message: "Human steps cannot be started" };
  }
  if (isMergeReadinessStep(task.templateStep)) {
    return { reason: "conflict", message: "Merge readiness is server-owned and cannot be started as a model run" };
  }
  if (!verdict.checklist.noActiveRun) {
    return { reason: "conflict", message: "Task already has an active run" };
  }
  if (!verdict.checklist.budgetRemaining) return { reason: "conflict", message: "Run budget exhausted" };
  if (task.status !== TaskStatus.TODO && task.status !== TaskStatus.BACKLOG) {
    return { reason: "conflict", message: "Only Todo and Backlog steps can be started" };
  }
  if (!verdict.checklist.repoBound) return { reason: "invalid-request", message: "This task has no repository" };
  if (!verdict.checklist.agentAssignee) return { reason: "invalid-request", message: "This task has no assignee" };
  if (!verdict.checklist.repoAccessGrant) {
    return { reason: "invalid-request", message: "Assignee has no grant for this Repo" };
  }
  if (task.assigneeAgent?.archivedAt) {
    return {
      reason: "archived-assignee",
      message: `Task ${task.name} assignee ${task.assigneeAgent.name} is archived; unarchive the agent to queue this step`,
    };
  }
  if (!verdict.startable) return { reason: "conflict", message: "This step cannot be started" };
  return null;
};

/**
 * Reads every fact that decides whether a Step may start and names the first
 * refusal from the same checklist. Mutation callers hold the Task/Chain mutex
 * before requesting `locked`; that mode also holds the exact Repo grant through
 * Run creation, while read callers use an ordinary grant read.
 */
export const readStepAdmissions = async (
  tx: Prisma.TransactionClient,
  taskIds: string[],
  options: ReadStepAdmissionOptions,
): Promise<Map<string, FoundStepAdmission>> => {
  const ids = [...new Set(taskIds)];
  if (ids.length === 0) return new Map();
  if (options.locked && ids.length !== 1) {
    throw new Error("Locked Step admission reads exactly one Step");
  }
  const tasks = await tx.task.findMany({ where: { id: { in: ids } }, include: admissionTaskInclude });
  const grantInputs = tasks.flatMap((task) => (
    task.assigneeAgentId !== null && task.repoId !== null
      ? [{ projectId: task.projectId, agentId: task.assigneeAgentId, repoId: task.repoId }]
      : []
  ));
  const chainInputs = [...new Map(tasks.flatMap((task) => (
    task.chainId !== null && task.chainIndex !== null
      ? [[chainKey({ projectId: task.projectId, chainId: task.chainId }), {
        projectId: task.projectId,
        chainId: task.chainId,
      }] as const]
      : []
  ))).values()];
  const [runGroups, chainRows, grantRows] = await Promise.all([
    tx.run.groupBy({
      by: ["taskId", "status"],
      where: { taskId: { in: ids } },
      _count: { _all: true },
      _max: { budgetGrants: true },
    }),
    chainInputs.length > 0
      ? tx.task.findMany({
        where: { OR: chainInputs },
        select: { id: true, projectId: true, chainId: true, name: true, status: true, chainIndex: true, chainLayer: true },
      })
      : [],
    grantInputs.length === 0
      ? []
      : options.locked
        ? Promise.all(grantInputs.map(async (input) => (
          await lockAgentRepoGrant(tx, input) ? input : null
        ))).then((rows) => rows.filter((row): row is (typeof grantInputs)[number] => row !== null))
        : tx.agentRepoAccess.findMany({
          where: { OR: grantInputs },
          select: { projectId: true, agentId: true, repoId: true },
        }),
  ]);
  const factsByTask = runFactsByTask(runGroups, ACTIVE_RUN_STATUSES);
  const granted = new Set(grantRows.map(grantKey));
  const rowsByChain = new Map<string, Array<(typeof chainRows)[number]>>();
  for (const row of chainRows) {
    if (row.chainId === null) continue;
    const key = chainKey({ projectId: row.projectId, chainId: row.chainId });
    const rows = rowsByChain.get(key);
    if (rows) rows.push(row); else rowsByChain.set(key, [row]);
  }
  return new Map(tasks.map((task): [string, FoundStepAdmission] => {
    const facts = factsByTask.get(task.id) ?? { total: 0, active: false, budgetGrants: null };
    const hasRepoGrant = task.assigneeAgentId !== null && task.repoId !== null
      && granted.has(grantKey({ projectId: task.projectId, agentId: task.assigneeAgentId, repoId: task.repoId }));
    const chain = task.chainId !== null && task.chainIndex !== null
      ? rowsByChain.get(chainKey({ projectId: task.projectId, chainId: task.chainId })) ?? []
      : [];
    const blocker = blockingPredecessor(chain, task.id);
    const baseVerdict = taskStartability(
      { ...task, hasRepoGrant },
      facts,
      task.maxSessionsPerTask,
      blocker === null,
    );
    const refused = refusalForStepAdmission(task, baseVerdict, blocker);
    return [task.id, {
      task,
      facts,
      verdict: { ...baseVerdict, startable: baseVerdict.startable && refused === null },
      blocker: blocker ? { id: blocker.id, name: blocker.name } : null,
      refusal: refused,
    }];
  }));
};

export const readStepAdmission = async (
  tx: Prisma.TransactionClient,
  taskId: string,
  options: ReadStepAdmissionOptions,
): Promise<StepAdmission> => (
  await readStepAdmissions(tx, [taskId], options)
).get(taskId) ?? {
  task: null,
  facts: null,
  verdict: null,
  blocker: null,
  refusal: { reason: "not-found", message: "Task not found" },
};
