import { storage } from "./storage";
import type { Session, SessionExecutionStatus } from "./types";

/** The number of rows that keep a busy calendar day from hiding later days. */
export const SESSION_DAY_PAGE_SIZE = 5;

/** The lifecycle states that are still running or waiting on work. Keep this
 *  next to the list predicates so the filter and the page's status vocabulary
 *  cannot drift apart. */
export const LIVE_SESSION_STATUSES: readonly SessionExecutionStatus[] = [
  "REQUESTED", "PROVISIONING", "RUNNING", "WAITING_INBOX",
];

export const isLiveStatus = (status: SessionExecutionStatus): boolean => LIVE_SESSION_STATUSES.includes(status);

export const ALL_SESSION_FILTER = "all" as const;

export const SESSION_STATUS_FILTERS = [
  ALL_SESSION_FILTER, "live", "done", "failed", "cancelled",
] as const;

export type SessionStatusFilter = typeof SESSION_STATUS_FILTERS[number];

export type SessionListFilters = {
  agentId: string;
  status: SessionStatusFilter;
};

export type SessionFilterOption = {
  value: string;
  label: string;
};

export type SessionDayGroup = {
  /** A local YYYY-MM-DD key, suitable for React keys and expansion state. */
  key: string;
  /** The newest row's timestamp, used when an older day needs an absolute label. */
  at: string;
  sessions: Session[];
};

/** The same instant the list uses for its relative time and day membership. */
export const sessionTimestamp = (session: Pick<Session, "startedAt" | "requestedAt">): string =>
  session.startedAt ?? session.requestedAt;

/** Match one execution status against the user-facing lifecycle buckets. */
export const sessionStatusMatches = (status: SessionExecutionStatus, filter: SessionStatusFilter): boolean => {
  if (filter === ALL_SESSION_FILTER) return true;
  if (filter === "live") return isLiveStatus(status);
  if (filter === "done") return status === "SUCCEEDED";
  if (filter === "failed") return status === "FAILED" || status === "TIMED_OUT" || status === "LOST";
  return filter === "cancelled" && status === "CANCELLED";
};

/** Distinct Agent choices from the Sessions that are already loaded. */
export const sessionAgentOptions = (
  sessions: readonly Pick<Session, "agentId" | "agent">[],
  allLabel = "All",
): SessionFilterOption[] => {
  const labels = new Map<string, string>();
  for (const session of sessions) {
    const label = session.agent?.title || session.agentId;
    const current = labels.get(session.agentId);
    // A relation can be absent on a partially-expanded response. Prefer a
    // later title when an earlier row only supplied the id.
    if (current === undefined || current === session.agentId) labels.set(session.agentId, label);
  }
  const options = [...labels.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label) || left.value.localeCompare(right.value));
  return [{ value: ALL_SESSION_FILTER, label: allLabel }, ...options];
};

/** Apply both client-side filters without changing the caller's array. */
export const filterSessions = (
  sessions: readonly Session[],
  filters: SessionListFilters,
): Session[] => sessions.filter((session) => (
  (filters.agentId === ALL_SESSION_FILTER || session.agentId === filters.agentId)
    && sessionStatusMatches(session.executionStatus, filters.status)
));

/** Format an instant as a calendar day in the browser's local timezone. */
export const localDayKey = (value: string): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "invalid";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const timestampValue = (value: string): number => {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

/**
 * Group already-loaded Sessions without mutating the caller's array. Both the
 * rows and the groups are newest-first, and a queued Session still belongs to
 * a day because `sessionTimestamp` falls back to requestedAt.
 */
export const groupSessionsByDay = (sessions: readonly Session[]): SessionDayGroup[] => {
  const ordered = sessions
    .map((session, index) => ({ session, index }))
    .sort((left, right) => {
      const difference = timestampValue(sessionTimestamp(right.session)) - timestampValue(sessionTimestamp(left.session));
      return difference === 0 ? left.index - right.index : difference;
    });

  const groups = new Map<string, SessionDayGroup>();
  for (const { session } of ordered) {
    const at = sessionTimestamp(session);
    const key = localDayKey(at);
    const group = groups.get(key);
    if (group) {
      group.sessions.push(session);
    } else {
      groups.set(key, { key, at, sessions: [session] });
    }
  }
  return [...groups.values()];
};

/** Filtering must happen before day grouping and the group's row cap. */
export const filterAndGroupSessions = (
  sessions: readonly Session[],
  filters: SessionListFilters,
): SessionDayGroup[] => groupSessionsByDay(filterSessions(sessions, filters));

export type SessionDayLabelKind = "today" | "yesterday" | "date";

/** Resolve the semantic heading at render time, rather than caching Today. */
export const sessionDayLabelKind = (key: string, now = new Date()): SessionDayLabelKind => {
  const today = localDayKey(now.toISOString());
  if (key === today) return "today";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return key === localDayKey(yesterday.toISOString()) ? "yesterday" : "date";
};

/* ---------------------------------------------------------- seen sessions */

export type SessionSeenState = {
  since: string;
  opened: Record<string, string>;
};

export const sessionSeenKey = (projectId: string): string => `agentos.sessions.seen.${projectId}`;

/** Kept as a small alias for callers that only need to construct the key. */
export const seenKey = sessionSeenKey;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseSeenState = (raw: string | null): SessionSeenState | null => {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.since !== "string" || !isRecord(parsed.opened)) return null;
    const opened: Record<string, string> = {};
    for (const [id, at] of Object.entries(parsed.opened)) {
      if (typeof at !== "string") return null;
      opened[id] = at;
    }
    return { since: parsed.since, opened };
  } catch {
    return null;
  }
};

const newSeenState = (): SessionSeenState => ({ since: new Date().toISOString(), opened: {} });

const writeSeenState = (projectId: string, state: SessionSeenState): void => {
  storage.set(sessionSeenKey(projectId), JSON.stringify(state));
};

/** Read once per list mount; a missing or malformed local cache starts clean. */
export const readSessionSeenState = (projectId: string): SessionSeenState => {
  const existing = parseSeenState(storage.get(sessionSeenKey(projectId)));
  if (existing !== null) return existing;
  const fresh = newSeenState();
  writeSeenState(projectId, fresh);
  return fresh;
};

const liveStatuses: SessionExecutionStatus[] = ["REQUESTED", "PROVISIONING", "RUNNING", "WAITING_INBOX"];

export const isSessionLive = (status: SessionExecutionStatus): boolean => liveStatuses.includes(status);

const instantValue = (value: string): number => {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

/** A terminal row still has a meaningful finish instant when endedAt is absent. */
export const sessionFinishTimestamp = (
  session: Pick<Session, "endedAt" | "startedAt" | "requestedAt">,
): string => session.endedAt ?? session.startedAt ?? session.requestedAt;

export const isSessionUnseen = (session: Session, state: SessionSeenState): boolean => {
  if (isSessionLive(session.executionStatus)) return false;
  const finish = instantValue(sessionFinishTimestamp(session));
  const seenAt = state.opened[session.id] ?? state.since;
  return finish > instantValue(seenAt);
};

const pruneOpened = (opened: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(opened)
      .map(([id, at], index) => ({ id, at, index }))
      .sort((left, right) => {
        const difference = instantValue(right.at) - instantValue(left.at);
        return difference === 0 ? left.index - right.index : difference;
      })
      .slice(0, 500)
      .map(({ id, at }) => [id, at]),
  );

/** Persist an open timestamp and bound the browser-local record. */
export const markSessionOpened = (
  projectId: string,
  sessionId: string,
  openedAt = new Date().toISOString(),
): SessionSeenState => {
  const current = readSessionSeenState(projectId);
  const next: SessionSeenState = {
    since: current.since,
    opened: pruneOpened({ ...current.opened, [sessionId]: openedAt }),
  };
  writeSeenState(projectId, next);
  return next;
};
