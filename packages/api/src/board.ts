import { createHash } from "node:crypto";

import { projectMergeOutcome, runOwnsMergeOutcome, sessionUsageCost, sumUsageCosts, type MergeOutcomeProjection, type ScheduleKind, type TaskSource, type TaskStatus, type UsageCost } from "@agentos/db";

import type { ChainProgress } from "./chain.js";

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
  status: TaskStatus;
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
  updatedAt: Date;
  assigneeAgent: { id: string; title: string; model: string } | null;
  chainProgress: (ChainProgress & { position: number | null }) | null;
  latestRun: {
    id: string;
    runNumber: number;
    status: string;
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
};

/** The Prisma row shape `boardCard` needs — declared structurally so the route
 *  can `select` exactly these columns and nothing else. */
export type BoardRow = {
  id: string;
  projectId: string;
  name: string;
  status: TaskStatus;
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
  updatedAt: Date;
  assigneeAgent: { id: string; title: string; model: string } | null;
  templateStep: { name: string } | null;
  runs: Array<{
    id: string;
    runNumber: number;
    status: string;
    model: string;
    session: {
      costUsd: Parameters<typeof sessionUsageCost>[1]["costUsd"];
      inputTokens: number | null;
      cachedInputTokens: number | null;
      outputTokens: number | null;
      startedAt: Date | null;
      endedAt: Date | null;
    } | null;
  }>;
  stepOutput?: { kind: string; body: string; runId: string | null } | null;
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
): BoardCard => {
  const run = row.runs[0];
  const taskCost = sumUsageCosts(row.runs.flatMap((item) => item.session === null
    ? []
    : [sessionUsageCost(item.model, item.session)]));
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
  };
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
