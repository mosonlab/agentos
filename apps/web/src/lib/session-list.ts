import type { Session } from "./types";

/** The number of rows that keep a busy calendar day from hiding later days. */
export const SESSION_DAY_PAGE_SIZE = 5;

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

export type SessionDayLabelKind = "today" | "yesterday" | "date";

/** Resolve the semantic heading at render time, rather than caching Today. */
export const sessionDayLabelKind = (key: string, now = new Date()): SessionDayLabelKind => {
  const today = localDayKey(now.toISOString());
  if (key === today) return "today";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return key === localDayKey(yesterday.toISOString()) ? "yesterday" : "date";
};
