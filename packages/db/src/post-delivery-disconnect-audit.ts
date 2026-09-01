/**
 * Read-only audit for the post-delivery disconnect recovery introduced by PR
 * #345. That recovery briefly treated an explicit provider terminal failure as
 * a disconnect when the provider exited with code zero. A promoted Run has no
 * failure envelope (successful completion deliberately clears it), so the
 * durable evidence for this audit is the provider's SessionEvent history and
 * the TaskActivity line the recovery appended before completion.
 */

export const POST_DELIVERY_DISCONNECT_FIX_COMMIT =
  "0ea0a58f4a5fea910fe26338bfe252e76e201725";

/** Git commit time for PR #345's exact merge commit, in UTC. */
export const POST_DELIVERY_DISCONNECT_FIX_MERGED_AT = "2026-08-31T16:52:56.000Z";

export const POST_DELIVERY_DISCONNECT_ACTIVITY_PREFIX =
  "A provider disconnect after delivery was tolerated:";

type AuditDate = Date | string;

export type PostDeliveryDisconnectAuditEvent = {
  seq: number;
  at: AuditDate;
  type: string;
  payload: unknown;
};

export type PostDeliveryDisconnectAuditActivity = {
  body: string;
  createdAt: AuditDate;
};

export type PostDeliveryDisconnectAuditRun = {
  id: string;
  taskId: string | null;
  endedAt: AuditDate | null;
  task: {
    chainId: string | null;
    activity: PostDeliveryDisconnectAuditActivity[];
  } | null;
  session: {
    events: PostDeliveryDisconnectAuditEvent[];
  } | null;
};

export type PostDeliveryDisconnectAuditDatabase = {
  run: {
    findMany(args: unknown): Promise<PostDeliveryDisconnectAuditRun[]>;
  };
};

export type PostDeliveryDisconnectAuditRow = {
  runId: string;
  taskId: string | null;
  chainId: string | null;
  providerError: string | null;
};

export type PostDeliveryDisconnectAuditCliDeps = {
  db: PostDeliveryDisconnectAuditDatabase;
  log?: (line: string) => void;
};

const providerEvent = (payload: unknown): Record<string, unknown> | null => (
  typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null
);

const stringField = (payload: Record<string, unknown> | null, field: string): string | null => (
  typeof payload?.[field] === "string" ? payload[field] as string : null
);

const nonEmptyStringField = (payload: Record<string, unknown> | null, field: string): string | null => {
  const value = stringField(payload, field)?.trim() ?? "";
  return value ? value : null;
};

const boolField = (payload: Record<string, unknown> | null, field: string): boolean | null => (
  typeof payload?.[field] === "boolean" ? payload[field] as boolean : null
);

const isReconnectMessage = (message: string | null): boolean =>
  /^Reconnecting\.\.\. \d+\/\d+$/u.test(message?.trim() ?? "");

const eventType = (event: PostDeliveryDisconnectAuditEvent): string | null =>
  stringField(providerEvent(event.payload), "type");

const eventError = (event: PostDeliveryDisconnectAuditEvent): string | null => {
  const payload = providerEvent(event.payload);
  return nonEmptyStringField(payload, "providerError")
    ?? nonEmptyStringField(payload, "message")
    ?? nonEmptyStringField(payload, "error")
    ?? nonEmptyStringField(providerEvent(payload?.error), "message");
};

const itemFailure = (payload: Record<string, unknown> | null): boolean => {
  const item = providerEvent(payload?.item);
  if (!item) return false;
  if (item.error !== undefined && item.error !== null && item.error !== false) return true;
  return stringField(item, "status") === "failed";
};

const codexFailureBeforeTerminal = (
  events: readonly PostDeliveryDisconnectAuditEvent[],
): boolean => events.some((event) => {
  const payload = providerEvent(event.payload);
  const type = eventType(event);
  if (type === "error") return !isReconnectMessage(eventError(event));
  return itemFailure(payload);
});

const piFinalAttemptFailed = (payload: Record<string, unknown> | null): boolean => {
  if (!payload || stringField(payload, "type") !== "agent_end") return false;
  // `willRetry: true` describes an intermediate failed provider attempt. It
  // must not make a later successful `agent_settled` look like a promoted
  // failure.
  if (boolField(payload, "willRetry") === true) return false;
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const finalMessage = providerEvent(messages.at(-1));
  return stringField(finalMessage, "stopReason") === "error"
    || nonEmptyStringField(finalMessage, "errorMessage") !== null
    || nonEmptyStringField(payload, "errorMessage") !== null;
};

const terminalFailureFor = (
  events: readonly PostDeliveryDisconnectAuditEvent[],
  terminalIndex: number,
): boolean => {
  const terminal = events[terminalIndex];
  if (!terminal || terminal.type !== "FINAL_OUTPUT") return false;

  const payload = providerEvent(terminal.payload);
  const providerType = stringField(payload, "type");
  const priorTerminalIndex = (() => {
    for (let index = terminalIndex - 1; index >= 0; index -= 1) {
      if (events[index]?.type === "FINAL_OUTPUT") return index;
    }
    return -1;
  })();
  const preceding = events.slice(priorTerminalIndex + 1, terminalIndex);

  // The three adapters expose their terminal verdicts in different provider
  // payloads. Keep this classifier tied to those existing wire shapes rather
  // than guessing from the Run's eventual status (which is the bug under
  // investigation).
  if (providerType === "result") {
    return boolField(payload, "is_error") === true
      || (stringField(payload, "terminal_reason") !== null
        && stringField(payload, "terminal_reason") !== "completed");
  }
  if (providerType === "turn.completed") {
    return boolField(payload, "success") === false
      || ["failed", "error", "incomplete"].includes(stringField(payload, "status") ?? "")
      || nonEmptyStringField(payload, "error") !== null
      || codexFailureBeforeTerminal(preceding);
  }
  if (providerType === "agent_settled") {
    return boolField(payload, "success") === false
      || boolField(payload, "finalAttemptFailed") === true
      || nonEmptyStringField(payload, "error") !== null
      || preceding.some((event) => piFinalAttemptFailed(providerEvent(event.payload)));
  }

  // Keep the fallback narrow: these are explicit failure fields, not absent or
  // malformed evidence. Unknown terminal payloads therefore stay unlisted.
  return boolField(payload, "terminalSuccess") === false
    || boolField(payload, "success") === false
    || boolField(payload, "is_error") === true
    || nonEmptyStringField(payload, "error") !== null;
};

const dateMillis = (value: AuditDate | null): number | null => {
  if (value === null) return null;
  const millis = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
};

const activityProviderError = (body: string): string | null => {
  if (!body.startsWith(POST_DELIVERY_DISCONNECT_ACTIVITY_PREFIX)) return null;
  const value = body.slice(POST_DELIVERY_DISCONNECT_ACTIVITY_PREFIX.length).trim();
  return value || null;
};

const sortedEvents = (events: readonly PostDeliveryDisconnectAuditEvent[]): PostDeliveryDisconnectAuditEvent[] =>
  [...events].sort((left, right) => left.seq - right.seq);

const promotedFailureFor = (
  run: PostDeliveryDisconnectAuditRun,
): PostDeliveryDisconnectAuditRow | null => {
  const endedAt = dateMillis(run.endedAt);
  if (endedAt === null || !run.task || !run.session) return null;
  const events = sortedEvents(run.session.events);
  if (events.length === 0) return null;

  const activities = [...run.task.activity]
    .map((activity) => ({ ...activity, providerError: activityProviderError(activity.body) }))
    .filter((activity): activity is PostDeliveryDisconnectAuditActivity & { providerError: string | null } =>
      activity.providerError !== null || activity.body.startsWith(POST_DELIVERY_DISCONNECT_ACTIVITY_PREFIX))
    .sort((left, right) => (dateMillis(left.createdAt) ?? Number.MAX_SAFE_INTEGER)
      - (dateMillis(right.createdAt) ?? Number.MAX_SAFE_INTEGER));

  for (const activity of activities) {
    const activityAt = dateMillis(activity.createdAt);
    if (activityAt === null || activityAt > endedAt) continue;
    // The activity is written after the event queue drains and before terminal
    // completion. A timestamped ordering keeps another Run's line on the same
    // Task from qualifying this one.
    const terminalIndex = events.reduce((latest, event, index) => {
      const eventAt = dateMillis(event.at);
      return event.type === "FINAL_OUTPUT" && eventAt !== null && eventAt <= activityAt ? index : latest;
    }, -1);
    if (terminalIndex < 0 || !terminalFailureFor(events, terminalIndex)) continue;
    return {
      runId: run.id,
      taskId: run.taskId,
      chainId: run.task.chainId,
      providerError: activity.providerError,
    };
  }
  return null;
};

/** Find promoted explicit failures without changing any persisted row. */
export const auditPostDeliveryDisconnects = async (
  db: PostDeliveryDisconnectAuditDatabase,
): Promise<PostDeliveryDisconnectAuditRow[]> => {
  const runs = await db.run.findMany({
    where: {
      status: "SUCCEEDED",
      endedAt: { gte: new Date(POST_DELIVERY_DISCONNECT_FIX_MERGED_AT) },
      session: { events: { some: { type: "FINAL_OUTPUT" } } },
      task: { activity: { some: { body: { startsWith: POST_DELIVERY_DISCONNECT_ACTIVITY_PREFIX } } } },
    },
    select: {
      id: true,
      taskId: true,
      endedAt: true,
      task: {
        select: {
          chainId: true,
          activity: {
            where: { body: { startsWith: POST_DELIVERY_DISCONNECT_ACTIVITY_PREFIX } },
            orderBy: { createdAt: "asc" },
            select: { body: true, createdAt: true },
          },
        },
      },
      session: {
        select: {
          events: {
            where: { type: { in: ["FINAL_OUTPUT", "ADAPTER_ERROR", "MODEL_DELTA", "PROVIDER_RAW", "PROVIDER_STATUS"] } },
            orderBy: { seq: "asc" },
            select: { seq: true, at: true, type: true, payload: true },
          },
        },
      },
    },
    orderBy: { id: "asc" },
  });
  return runs.flatMap((run) => {
    const finding = promotedFailureFor(run);
    return finding ? [finding] : [];
  });
};

const tableValue = (value: string | null): string => value ?? "null";

/** Stable tab-separated table output: one header row, then one row per finding. */
export const formatPostDeliveryDisconnectAudit = (
  rows: readonly PostDeliveryDisconnectAuditRow[],
): string[] => [
  ["runId", "taskId", "chainId", "providerError"].join("\t"),
  ...rows.map((row) => [
    row.runId,
    tableValue(row.taskId),
    tableValue(row.chainId),
    tableValue(row.providerError)?.replaceAll("\t", " ").replaceAll("\r", "\\r").replaceAll("\n", "\\n"),
  ].join("\t")),
];

export const runAuditPostDeliveryDisconnectCli = async (
  { db, log = console.log }: PostDeliveryDisconnectAuditCliDeps,
): Promise<number> => {
  const rows = await auditPostDeliveryDisconnects(db);
  for (const line of formatPostDeliveryDisconnectAudit(rows)) log(line);
  return 0;
};
