import { AssigneeType, TaskStatus } from "@agentos/db";

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
  name: string;
  status: TaskStatus;
  archivedAt: Date | null;
  templateStep: { name: string } | null;
};

export type ChainProgress = {
  chainId: string;
  done: number;
  total: number;
  activeStepName: string;
  activeStatus: string;
};

/** The step's own name when it came from a template, else the task's. */
export const stepName = (row: Pick<ChainRow, "name" | "templateStep">): string => row.templateStep?.name ?? row.name;

const byChainIndex = (left: ChainRow, right: ChainRow): number => (left.chainIndex ?? 0) - (right.chainIndex ?? 0);
const byChainPosition = <T extends { chainIndex: number | null; id: string }>(left: T, right: T): number => (
  (left.chainIndex ?? 0) - (right.chainIndex ?? 0) || left.id.localeCompare(right.id)
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
  return {
    done,
    total: ordered.length,
    activeStepName: stepName(active),
    activeStatus: active.status.toLowerCase(),
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

/** What the route knows about a task's runs, in the two facts `startable` needs.
 *  `total` is a count, not the latest run number: `Run` is genuinely one-to-many
 *  and a task at its ceiling whose last run is terminal must not look startable. */
export type RunFacts = { total: number; active: boolean };

export type StartableRow = {
  status: TaskStatus;
  assigneeType: AssigneeType;
  assigneeAgentId: string | null;
  repoId: string | null;
  archivedAt: Date | null;
  assigneeAgent: { archivedAt: Date | null } | null;
  /** The exact AgentRepoAccess row exists at decision time. */
  hasRepoGrant: boolean;
};

/**
 * May the operator press `Start now` on this step?
 *
 * The single source for both the API guard and the button's enabled state — the
 * web app reads this boolean rather than re-deriving it, so the two cannot
 * disagree. "Active run" is `ACTIVE_RUN_STATUSES`, which includes WAITING_INBOX.
 */
export const startable = (row: StartableRow, facts: RunFacts, maxSessionsPerTask: number): boolean => {
  if (row.assigneeType !== AssigneeType.AGENT) return false;
  if (!row.assigneeAgentId || !row.repoId) return false;
  if (!row.hasRepoGrant) return false;
  if (row.assigneeAgent?.archivedAt) return false;
  if (row.archivedAt !== null) return false;
  if (row.status !== TaskStatus.TODO && row.status !== TaskStatus.BACKLOG) return false;
  if (facts.active) return false;
  return facts.total < maxSessionsPerTask;
};

export type ChainDecisionRow = ChainRow & StartableRow & { maxSessionsPerTask: number };
export type ChainStartAction = "start" | "recover" | null;
export type ChainStartDecision = {
  startable: boolean;
  startAction: ChainStartAction;
  currentExecution: boolean;
  blockingPredecessor: { id: string; name: string } | null;
};

/** The earliest surviving row that still owns chain progress. Deleted rows are
 * absent; archived rows remain dependencies until they are DONE. */
export const firstUnfinishedStep = <T extends Pick<ChainRow, "chainIndex" | "id" | "status">>(rows: T[]): T | null => (
  [...rows].sort(byChainPosition)
    .find((item) => item.status !== TaskStatus.DONE) ?? null
);

/** The first unfinished surviving row before target, or null when the ordered
 * prefix is complete. This is the predecessor named by the 409 response. */
export const blockingPredecessor = <T extends Pick<ChainRow, "chainIndex" | "id" | "name" | "status">>(
  rows: T[],
  targetId: string,
): T | null => {
  const ordered = [...rows].sort(byChainPosition);
  const targetIndex = ordered.findIndex((item) => item.id === targetId);
  if (targetIndex < 0) return null;
  return ordered.slice(0, targetIndex).find((item) => item.status !== TaskStatus.DONE) ?? null;
};

/** One dependency decision for the whole chain. Row-local capability remains
 * `startable`; chain position narrows it to the sole first-unfinished row. */
export const chainStartDecisions = (
  rows: ChainDecisionRow[],
  factsByTask: ReadonlyMap<string, RunFacts>,
): Map<string, ChainStartDecision> => {
  const ordered = [...rows].sort((left, right) => byChainIndex(left, right) || left.id.localeCompare(right.id));
  const first = firstUnfinishedStep(ordered);
  return new Map(ordered.map((row) => {
    const facts = factsByTask.get(row.id) ?? { total: 0, active: false };
    const isCandidate = first?.id === row.id;
    const allowed = isCandidate && startable(row, facts, row.maxSessionsPerTask);
    const predecessor = blockingPredecessor(ordered, row.id);
    return [row.id, {
      startable: allowed,
      startAction: allowed ? row.status === TaskStatus.BACKLOG ? "recover" : "start" : null,
      currentExecution: facts.active,
      blockingPredecessor: predecessor ? { id: predecessor.id, name: predecessor.name } : null,
    }];
  }));
};

/** One grouped run query → per-task facts. Constant in task count, which is what
 *  makes "no N+1" a property of this function rather than a rule three routes
 *  have to remember. */
export const runFactsByTask = (
  // `taskId` is nullable in Prisma's groupBy output even though Run.taskId is
  // not; rows without one are skipped rather than cast away.
  rows: Array<{ taskId: string | null; status: string; _count: { _all: number } }>,
  activeStatuses: readonly string[],
): Map<string, RunFacts> => {
  const facts = new Map<string, RunFacts>();
  for (const row of rows) {
    if (row.taskId === null) continue;
    const current = facts.get(row.taskId) ?? { total: 0, active: false };
    facts.set(row.taskId, {
      total: current.total + row._count._all,
      active: current.active || activeStatuses.includes(row.status),
    });
  }
  return facts;
};
