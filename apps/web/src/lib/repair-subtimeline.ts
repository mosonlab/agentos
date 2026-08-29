import type { ChainStep, TaskActivity } from "./types";

/** The activity payload is JSON at runtime, so it is deliberately narrower
 * than TaskActivity: callers may pass the API rows while tests and versioned
 * responses can still contain missing or malformed fields. */
export type RepairActivity = Pick<TaskActivity, "metadata"> & Partial<Pick<TaskActivity, "id">>;

export type RepairCycleOutcome = "pending" | "succeeded" | "failed" | "unknown" | (string & {});

/** A paired repairAttempt/repairResult view of one merge-tail repair task. */
export type RepairCycleViewModel = {
  /** Dense one-based order in which repair cycles were first observed. */
  ordinal: number;
  repairKind: string;
  repairTaskId: string;
  startHeadSha: string | null;
  /** The delivered head, when a repair result has one; null while pending or failed. */
  endHeadSha: string | null;
  /** A stable display value: pending, a persisted result state, or a safe inference. */
  outcome: RepairCycleOutcome;
  taskHref: string;
};

type RepairMarkerPhase = "queued" | "result";

type RepairMarker = {
  phase: RepairMarkerPhase;
  repairKind: string;
  repairTaskId: string;
  startHeadSha: string;
  resolvedHeadSha?: string | null;
  state?: string;
};

type MutableRepairCycle = {
  ordinal: number;
  queued: RepairMarker | null;
  result: RepairMarker | null;
};

const QUEUED_KIND = "mergeTail.repairAttempt";
const RESULT_KIND = "mergeTail.repairResult";

const objectRecord = (value: unknown): Record<string, unknown> | null => (
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const requiredString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

/** `undefined` means absent or malformed; explicit JSON null is meaningful for
 * result.resolvedHeadSha because it records a failed attempt with no delivery. */
const optionalNullableString = (value: unknown): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return requiredString(value) ?? undefined;
};

const head = (metadata: Record<string, unknown>, primary: string, alternate: string): string | null => (
  requiredString(metadata[primary]) ?? requiredString(metadata[alternate])
);

const markerPhase = (metadata: Record<string, unknown>): RepairMarkerPhase | null => {
  const kind = requiredString(metadata.kind);
  if (kind === null) return null;
  if (kind === QUEUED_KIND) return "queued";
  if (kind === RESULT_KIND) return "result";
  return null;
};

const parseMarker = (activity: RepairActivity): RepairMarker | null => {
  const metadata = objectRecord(activity.metadata);
  if (metadata === null) return null;
  const phase = markerPhase(metadata);
  if (phase === null) return null;

  const repairKind = requiredString(metadata.repairKind);
  const repairTaskId = requiredString(metadata.repairTaskId);
  // repairAttempt writes headSha/baseHeadSha; repairResult writes
  // startHeadSha/targetHeadSha. Both are current control-plane field names.
  const startHeadSha = head(metadata, "startHeadSha", "headSha");
  const targetHeadSha = head(metadata, "targetHeadSha", "baseHeadSha");
  // A marker without its binding tuple cannot identify a repair cycle safely.
  // In particular, this filters the handoff-invalid marker, which intentionally
  // carries only a run id and reason.
  if (repairKind === null || repairTaskId === null || startHeadSha === null || targetHeadSha === null) return null;

  const resolvedHeadSha = optionalNullableString(metadata.resolvedHeadSha);
  const state = requiredString(metadata.state);
  return {
    phase,
    repairKind,
    repairTaskId,
    startHeadSha,
    ...(resolvedHeadSha !== undefined ? { resolvedHeadSha } : {}),
    ...(state !== null ? { state } : {}),
  };
};

const resultOutcome = (result: RepairMarker | null): RepairCycleOutcome => {
  if (result === null) return "pending";
  if (result.state !== undefined) return result.state;
  if (result.resolvedHeadSha) return "succeeded";
  return "unknown";
};

/** The canonical templates call this node "Regression verification". Matching
 * the visible step name keeps the read path compatible with both direct and
 * full-assurance chains without adding a new API-only field. */
export const isRegressionStep = (step: Pick<ChainStep, "name" | "stepName">): boolean =>
  /\bregression\b/iu.test(`${step.stepName} ${step.name}`);

/**
 * Parse Regression TaskActivity rows into the ordered repair sub-timeline.
 *
 * The API currently returns activity oldest-first. The function intentionally
 * uses the input order rather than sorting timestamps: this preserves the
 * server's tie-break order and also keeps the helper deterministic for callers
 * holding a projected activity list. A result-only cycle is accepted when its
 * full binding tuple is present; this keeps the timeline useful across partial
 * polling/version skew while still rejecting malformed markers.
 */
export const parseRepairCycles = (activities: readonly RepairActivity[]): RepairCycleViewModel[] => {
  const cycles = new Map<string, MutableRepairCycle>();
  for (const activity of activities) {
    const marker = parseMarker(activity);
    if (marker === null) continue;
    let cycle = cycles.get(marker.repairTaskId);
    if (cycle === undefined) {
      cycle = { ordinal: cycles.size + 1, queued: null, result: null };
      cycles.set(marker.repairTaskId, cycle);
    }
    if (marker.phase === "queued") {
      // Keep the first queue marker as the cycle's canonical start. A duplicate
      // queued event is not a new repair cycle and should not renumber later
      // rows.
      cycle.queued ??= marker;
    } else {
      // A retry/result correction for the same repair task is still one cycle;
      // the latest result is the most useful state for the detail page.
      cycle.result = marker;
    }
  }

  const rendered: RepairCycleViewModel[] = [];
  for (const { ordinal, queued, result } of cycles.values()) {
    const source = queued ?? result!;
    const endHeadSha = result?.resolvedHeadSha ?? null;
    rendered.push({
      ordinal,
      repairKind: queued?.repairKind ?? result!.repairKind,
      repairTaskId: source.repairTaskId,
      startHeadSha: queued?.startHeadSha ?? result!.startHeadSha,
      endHeadSha,
      outcome: resultOutcome(result),
      taskHref: `/tasks/${encodeURIComponent(source.repairTaskId)}`,
    });
  }
  return rendered;
};
