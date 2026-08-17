import cronstrue from "cronstrue/i18n";

import { formatDateTime, formatLocale, formatT, timeAgo } from "./format";
import type { Task } from "./types";

/** cronstrue's own locale ids, not BCP 47. Verified against the installed
 *  `cronstrue@3.24.0`: `node_modules/cronstrue/dist/i18n/locales/zh_CN` exists and
 *  `toString("0 9 * * 1", { locale: "zh_CN" })` returns `在上午 09:00, 仅星期一`.
 *  The id matters: an unknown one makes cronstrue throw, and every schedule cell
 *  would silently fall back to the raw expression. */
const CRONSTRUE_LOCALES: Record<string, string> = { en: "en", zh: "zh_CN" };

/**
 * A cron expression as prose in the active locale, falling back to the expression
 * itself.
 *
 * `cronstrue` throws on anything it cannot parse, and the server accepts
 * expressions it has never seen. Rendering the exception string would put
 * `Error: ...` in the Schedule column, so an unparseable expression renders
 * verbatim — which is still exactly what the operator typed. That fallback is
 * locale-independent by construction: the `catch` returns the input.
 */
export const cronProse = (expression: string | null, timezone: string | null): string => {
  if (!expression) return "—";
  let prose: string;
  try {
    prose = cronstrue.toString(expression, {
      throwExceptionOnParseError: true,
      locale: CRONSTRUE_LOCALES[formatLocale()] ?? "en",
    });
  } catch {
    return expression;
  }
  return timezone ? `${prose} (${timezone})` : prose;
};

/** `in 3h` for a future occurrence, `3h ago` for one the scheduler has not yet
 *  caught up with, and the absolute time once it is more than a day out. */
export const nextRunLabel = (runAt: string | null): string => {
  if (!runAt) return "—";
  const delta = new Date(runAt).getTime() - Date.now();
  if (delta < 0) return timeAgo(runAt);
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return formatT("format.inUnderAMinute");
  if (minutes < 60) return formatT("format.inMinutes", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return formatT("format.inHours", { n: hours });
  return formatDateTime(runAt);
};

export type AutomationState = "active" | "paused" | "quarantined";

/**
 * §4.7's three states. `runAt === null` on a live definition is the scheduler's
 * quarantine marker — it clears `runAt` rather than deleting the row when a cron
 * expression stops parsing — so it is a state, not an absence.
 */
export const automationState = (
  task: Pick<Task, "schedulePausedAt" | "runAt">,
): AutomationState => {
  if (task.schedulePausedAt !== null) return "paused";
  if (task.runAt === null) return "quarantined";
  return "active";
};

/**
 * The Schedule cell for one automation row.
 *
 * A quarantined row renders the raw expression, never prose. `cronProse` can
 * only fall back when `cronstrue` *throws*, and `cronstrue` does not throw on
 * everything the control plane rejects — it reinterprets. A seven-field
 * expression is rejected by `cron-parser` as having too many fields and described by
 * `cronstrue` as "Every 5 seconds, only on Sunday, only in 1909". Rendering that
 * beside "Fix the cron expression" tells the operator two contradictory things
 * about the same row, which is the failure spec [A9] exists to prevent.
 *
 * Quarantine is the signal `cronstrue` cannot supply: the scheduler cleared
 * `runAt` precisely because its own parser refused the expression.
 */
export const scheduleLabel = (
  task: Pick<Task, "schedulePausedAt" | "runAt" | "cron" | "timezone">,
): string => (
  automationState(task) === "quarantined"
    ? task.cron ?? "—"
    : cronProse(task.cron, task.timezone)
);
