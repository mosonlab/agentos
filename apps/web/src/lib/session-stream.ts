import type { RunnerKind, SessionEvent } from "./types";

/* Pure normalizer: raw SessionEvent rows in, stream items out. No React, no
 * network, no imports from components/. It feeds both the stat bar and the
 * stream, which is what makes it impossible for a count to disagree with what
 * is rendered.
 *
 * Every payload access is guarded — a payload that is null, a number, a string
 * or an array contributes nothing and nothing throws. Mapping tables were
 * derived from the real captured CLI stdout in spikes/cli-capabilities/samples/;
 * the two CODEX shapes with no capture (command_execution, file_change) are
 * marked inferred and degrade to "no extraction" rather than guessing further.
 */

export type ToolState = "running" | "incomplete" | "ok" | "error";

export type StreamItem =
  | { kind: "text"; id: string; at: string; text: string }
  | {
    kind: "tool"; id: string; at: string; name: string; primaryArg: string | null;
    filePath: string | null; args: unknown; result: string | null; state: ToolState;
  }
  | { kind: "error"; id: string; at: string; message: string }
  | { kind: "final"; id: string; at: string; text: string };

export type FileTouch = { path: string; count: number };
export type StreamCounts = { messages: number; toolCalls: number; files: number };

const PRIMARY_ARG_MAX = 120;
const ERROR_MESSAGE_MAX = 500;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The `text` parts of a content array, joined. Returns "" when there are none —
 *  a tool-only assistant message and PI's `[thinking, toolCall]` turn both land
 *  here, and both must produce no item. */
const contentText = (content: unknown): string =>
  asArray(content)
    .map((part) => asString(asRecord(part)?.text))
    .filter((part): part is string => part !== null)
    .join("\n");

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}…` : value;

/** PI's textSignature is a JSON *string* carrying `{v, id, phase}`. */
const textSignatureId = (content: unknown): string | null => {
  for (const part of asArray(content)) {
    const signature = asString(asRecord(part)?.textSignature);
    if (signature === null) continue;
    try {
      const id = asString(asRecord(JSON.parse(signature) as unknown)?.id);
      if (id !== null) return id;
    } catch {
      // A signature we cannot parse simply yields no identity.
    }
  }
  return null;
};

/** Mirrors the adapter's own eventErrorMessage, so the stream shows the same
 *  text the run's providerError recorded. */
const adapterErrorMessage = (payload: unknown): string => {
  const event = asRecord(payload);
  if (!event) return truncate(JSON.stringify(payload ?? null), ERROR_MESSAGE_MAX);
  return asString(event.message)
    ?? asString(event.error)
    ?? asString(asRecord(event.error)?.message)
    ?? truncate(JSON.stringify(event), ERROR_MESSAGE_MAX);
};

const firstScalar = (args: unknown): string | null => {
  const record = asRecord(args);
  if (!record) return null;
  for (const value of Object.values(record)) {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return null;
};

/* ------------------------------------------------------------ per runner */

type ToolStart = { name: string; args: unknown; filePath: string | null; command: string | null };

/** CLAUDE Glob/Grep take a `path` that is a search root, not a file the agent
 *  touched; only file_path / notebook_path count. */
const claudeFilePath = (input: Record<string, unknown> | null): string | null =>
  asString(input?.file_path) ?? asString(input?.notebook_path);

const toolStart = (runner: RunnerKind, payload: unknown): ToolStart => {
  const event = asRecord(payload);
  if (runner === "CLAUDE") {
    // payload is the tool_use part: {id, name, input}
    const input = asRecord(event?.input);
    return {
      name: asString(event?.name) ?? "tool",
      args: event?.input ?? null,
      filePath: claudeFilePath(input),
      command: asString(input?.command),
    };
  }
  if (runner === "PI") {
    // payload is the whole event: {type, toolCallId, toolName, args}
    const args = asRecord(event?.args);
    return {
      name: asString(event?.toolName) ?? "tool",
      args: event?.args ?? null,
      // Container verified in the capture; the key names are inferred (§11-G2).
      filePath: asString(args?.file_path) ?? asString(args?.path) ?? asString(args?.filePath),
      command: asString(args?.command),
    };
  }
  // CODEX: payload is the command_execution item. Shape inferred (§11-G1).
  return {
    name: asString(event?.type) ?? "tool",
    args: payload ?? null,
    filePath: null,
    command: asString(event?.command),
  };
};

const toolResultText = (runner: RunnerKind, payload: unknown): string | null => {
  const event = asRecord(payload);
  if (!event) return null;
  if (runner === "CLAUDE") {
    const content = asString(event.content);
    if (content !== null) return content;
    const parts = contentText(event.content);
    return parts.length > 0 ? parts : null;
  }
  if (runner === "PI") {
    const result = asRecord(event.result);
    if (!result) return null;
    const parts = contentText(result.content);
    return parts.length > 0 ? parts : JSON.stringify(event.result);
  }
  // CODEX aggregated_output; inferred (§11-G1).
  return asString(event.aggregated_output);
};

const toolFailed = (runner: RunnerKind, payload: unknown): boolean => {
  const event = asRecord(payload);
  if (!event) return false;
  if (runner === "CLAUDE") return event.is_error === true;
  if (runner === "PI") return event.isError === true;
  return typeof event.exit_code === "number" && event.exit_code !== 0;
};

/** CODEX reports edits as a `file_change` item carried on MODEL_DELTA. Inferred
 *  (§11-G1): an unexpected shape extracts nothing rather than throwing. */
const codexChangedPaths = (item: Record<string, unknown> | null): string[] =>
  asArray(item?.changes)
    .map((change) => asString(asRecord(change)?.path))
    .filter((path): path is string => path !== null);

/* ------------------------------------------------------------- normalize */

export const normalize = (
  events: SessionEvent[],
  runner: RunnerKind,
  terminal: boolean,
): { items: StreamItem[]; files: FileTouch[]; counts: StreamCounts } => {
  const items: StreamItem[] = [];
  const fileCounts = new Map<string, number>();
  /** CODEX emits MODEL_DELTA on both item.started and item.completed for the
   *  same item id; the later event replaces the earlier item in place. */
  const codexTextIndex = new Map<string, number>();
  const toolIndex = new Map<string, number>();
  /** PI echoes every assistant message_end as a turn_end. Keyed on message
   *  identity, never on text bytes: two genuine "ok" replies must both survive. */
  const piSeen = new Set<string>();
  let lastAgentText = "";

  const touch = (path: string | null): void => {
    if (path === null) return;
    fileCounts.set(path, (fileCounts.get(path) ?? 0) + 1);
  };

  const pushText = (event: SessionEvent, text: string): void => {
    if (text.length === 0) return;
    lastAgentText = text;
    items.push({ kind: "text", id: event.id, at: event.at, text });
  };

  for (const event of events) {
    const payload = event.payload;
    const record = asRecord(payload);

    if (event.type === "MODEL_DELTA") {
      if (runner === "CLAUDE") {
        pushText(event, contentText(asRecord(record?.message)?.content));
      } else if (runner === "CODEX") {
        const item = asRecord(record?.item);
        const itemType = asString(item?.type);
        if (itemType === "file_change") {
          for (const path of codexChangedPaths(item)) touch(path);
        } else if (itemType === "agent_message") {
          const text = asString(item?.text) ?? "";
          const itemId = asString(item?.id);
          const existing = itemId === null ? undefined : codexTextIndex.get(itemId);
          if (existing !== undefined) {
            if (text.length > 0) {
              items[existing] = { kind: "text", id: event.id, at: event.at, text };
              lastAgentText = text;
            }
          } else if (text.length > 0) {
            if (itemId !== null) codexTextIndex.set(itemId, items.length);
            pushText(event, text);
          }
        }
        // Every other CODEX item (notably `reasoning`) is excluded (A2).
      }
      continue;
    }

    if (event.type === "MODEL_COMPLETED") {
      if (runner !== "PI") continue;
      const message = asRecord(record?.message);
      if (asString(message?.role) !== "assistant") continue;
      const timestamp = message?.timestamp;
      const identity = typeof timestamp === "number" || typeof timestamp === "string"
        ? String(timestamp)
        : textSignatureId(message?.content);
      // No identity means no dedup: rendering a duplicate beats deleting a real
      // message.
      if (identity !== null) {
        if (piSeen.has(identity)) continue;
        piSeen.add(identity);
      }
      pushText(event, contentText(message?.content));
      continue;
    }

    if (event.type === "TOOL_STARTED") {
      const key = event.toolCallId ?? event.id;
      const start = toolStart(runner, payload);
      touch(start.filePath);
      const primaryArg = start.filePath ?? start.command ?? firstScalar(start.args);
      const index = toolIndex.get(key);
      // An unfinished call reads `running` while the session is live and
      // `incomplete` once it is terminal — the run ended without a return.
      const existing = index === undefined ? null : items[index] as Extract<StreamItem, { kind: "tool" }>;
      const item: Extract<StreamItem, { kind: "tool" }> = {
        kind: "tool",
        id: key,
        at: existing?.at ?? event.at,
        name: start.name,
        primaryArg: primaryArg === null ? null : truncate(primaryArg, PRIMARY_ARG_MAX),
        filePath: start.filePath,
        args: start.args,
        result: existing?.result ?? null,
        state: existing?.state ?? (terminal ? "incomplete" : "running"),
      };
      if (index === undefined) { toolIndex.set(key, items.length); items.push(item); }
      else items[index] = item;
      continue;
    }

    if (event.type === "TOOL_COMPLETED") {
      const key = event.toolCallId ?? event.id;
      const index = toolIndex.get(key);
      const state: ToolState = toolFailed(runner, payload) ? "error" : "ok";
      const result = toolResultText(runner, payload);
      if (index === undefined) {
        // Orphan completion: still a tool call, still counted, with no arguments.
        const name = asString(record?.toolName) ?? asString(record?.type) ?? "tool";
        items.push({
          kind: "tool", id: key, at: event.at, name,
          primaryArg: null, filePath: null, args: null, result, state,
        });
        toolIndex.set(key, items.length - 1);
      } else {
        // Duplicate completion for one id resolves last-completed-wins, one item.
        items[index] = { ...(items[index] as Extract<StreamItem, { kind: "tool" }>), result, state };
      }
      continue;
    }

    if (event.type === "ADAPTER_ERROR") {
      items.push({ kind: "error", id: event.id, at: event.at, message: adapterErrorMessage(payload) });
      continue;
    }

    if (event.type === "FINAL_OUTPUT") {
      // CLAUDE carries the text; CODEX's turn.completed does not, so the last
      // agent message stands in; PI's agent_settled is empty, so PI never gets
      // a Result card.
      const text = runner === "CLAUDE" ? (asString(record?.result) ?? "") : runner === "CODEX" ? lastAgentText : "";
      if (text.length > 0) items.push({ kind: "final", id: event.id, at: event.at, text });
      continue;
    }
    // PROVIDER_RAW, PROVIDER_STATUS, STDERR, MODEL_STARTED, TOOL_PROGRESS,
    // PROCESS_STARTED and anything unknown produce no item.
  }

  const files = [...fileCounts.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((left, right) => left.path.localeCompare(right.path));

  // Counts come from the rendered items, never from the raw events, so the stat
  // bar cannot disagree with the stream.
  return {
    items,
    files,
    counts: {
      messages: items.filter((item) => item.kind === "text").length,
      toolCalls: items.filter((item) => item.kind === "tool").length,
      files: files.length,
    },
  };
};
