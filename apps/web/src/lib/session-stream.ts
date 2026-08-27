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

/** A completed tool call as it appears in the normalized stream. The
 * projection keeps this shape intact and only changes its container: a
 * maximal run of these calls becomes one `tools` node. */
export type ToolCall = Extract<StreamItem, { kind: "tool" }>;

/** The stable vocabulary consumed by the Session stream renderer. `input` and
 * `marker` are declared here even though their producers arrive in later
 * slices; adding those producers must not widen the renderer's contract. */
export type StreamNode =
  | { kind: "input"; id: string; at: string; text: string }
  | { kind: "text"; id: string; at: string; text: string; final: boolean }
  | { kind: "tools"; id: string; at: string; calls: ToolCall[] }
  | { kind: "marker"; id: string; at: string; variant: "info" | "error"; text: string };

export type FileTouch = { path: string; count: number };
export type StreamCounts = { messages: number; toolCalls: number; files: number };
export type StreamProjection = { nodes: StreamNode[]; files: FileTouch[]; counts: StreamCounts };

/** The line budgets keep an expanded tool call or a prose card from taking over
 *  the page. They live with the stream contract so the renderer and its tests
 *  cannot drift to different defaults. */
export const TOOL_OUTPUT_MAX_LINES = 40;
export const TEXT_NODE_MAX_LINES = 12;

export type LineClamp = { text: string; dropped: number };

/** Keep the first `maxLines` lines and report what was withheld. A short value
 *  is returned byte-for-byte so callers can compose this with other caps. */
export const clampLines = (text: string, maxLines: number): LineClamp => {
  const lines = text.split(/\r?\n/u);
  if (lines.length <= maxLines) return { text, dropped: 0 };
  return { text: lines.slice(0, maxLines).join("\n"), dropped: lines.length - maxLines };
};

/** The node carries a translation key rather than locale-bound copy: the
 * projection remains a pure function of the event stream, while the renderer
 * can use the active locale when it paints the resume boundary. */
export const RESUME_MARKER_TEXT = "sessions.stream.resumed";

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

/**
 * Projects normalized stream items into the small set of things the operator
 * should read. Normalization remains the payload-mapping contract: this pass
 * deliberately does not inspect provider payloads a second time. It only
 * turns text/final items into text nodes and folds adjacent tool items into a
 * single group. Error and process-boundary items become marker nodes here, and
 * the declared input variant keeps the type stable for its later producer.
 *
 * The result is intentionally pure. In particular, counts are calculated from
 * the returned nodes, so any grouping or future projection rule cannot make
 * the stat bar disagree with the stream that is actually rendered.
 */
export const projectStream = (
  events: SessionEvent[],
  runner: RunnerKind,
  terminal: boolean,
): StreamProjection => {
  const normalized = normalize(events, runner, terminal);
  const nodes: StreamNode[] = [];
  let tools: ToolCall[] = [];

  type ProjectionEntry =
    | { index: number; item: StreamItem }
    | { index: number; marker: Extract<StreamNode, { kind: "marker" }> }
    | { index: number; input: Extract<StreamNode, { kind: "input" }> };

  const eventIndexes = new Map<string, number>();
  const toolIndexes = new Map<string, number>();
  for (const [index, event] of events.entries()) {
    if (!eventIndexes.has(event.id)) eventIndexes.set(event.id, index);
    if (event.type === "TOOL_STARTED" || event.type === "TOOL_COMPLETED") {
      const toolId = event.toolCallId ?? event.id;
      if (!toolIndexes.has(toolId)) toolIndexes.set(toolId, index);
    }
  }

  const eventIndexForItem = (item: StreamItem): number => {
    // Tool ids are call ids rather than event ids, so anchor them at their
    // first start/completion event. Other normalized items retain their source
    // event id. Keeping this association here lets markers be interleaved in
    // the original stream without making the normalizer carry presentation
    // metadata.
    if (item.kind === "tool") {
      const toolIndex = toolIndexes.get(item.id);
      if (toolIndex !== undefined) return toolIndex;
    }
    return eventIndexes.get(item.id) ?? events.length;
  };

  const entries: ProjectionEntry[] = normalized.items
    // `error` is represented by the marker entry below. Leaving it in this
    // list would duplicate the marker or make malformed payloads observable.
    .filter((item) => item.kind !== "error")
    .map((item) => ({ index: eventIndexForItem(item), item }));

  let processStarts = 0;
  for (const [index, event] of events.entries()) {
    if (asRecord(event.payload) === null) continue;
    if (event.type === "ADAPTER_ERROR" || event.type === "PROMPT_DELIVERY_FAILED") {
      entries.push({
        index,
        marker: { kind: "marker", id: event.id, at: event.at, variant: "error", text: adapterErrorMessage(event.payload) },
      });
    } else if (event.type === "PROCESS_STARTED") {
      processStarts += 1;
      if (processStarts > 1) {
        entries.push({
          index,
          marker: { kind: "marker", id: event.id, at: event.at, variant: "info", text: RESUME_MARKER_TEXT },
        });
      }
    }
  }
  const piInputSeen = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (runner !== "PI" || event.type !== "MODEL_COMPLETED") continue;
    const message = asRecord(asRecord(event.payload)?.message);
    if (asString(message?.role) !== "user") continue;
    const content = message?.content;
    const text = Array.isArray(content) ? contentText(content) : asString(content) ?? "";
    if (text.trim().length === 0) continue;

    // PI may repeat a completed message on `turn_end`, just as it repeats
    // assistant messages. Use its provider identity where available, while
    // preserving anonymous user messages rather than guessing they are dupes.
    const timestamp = message?.timestamp;
    const identity = typeof timestamp === "number" || typeof timestamp === "string"
      ? String(timestamp)
      : textSignatureId(content);
    if (identity !== null) {
      if (piInputSeen.has(identity)) continue;
      piInputSeen.add(identity);
    }

    entries.push({ index, input: { kind: "input", id: event.id, at: event.at, text } });
  }
  entries.sort((left, right) => left.index - right.index);

  const flushTools = (): void => {
    if (tools.length === 0) return;
    const first = tools[0]!;
    nodes.push({ kind: "tools", id: first.id, at: first.at, calls: tools });
    tools = [];
  };

  const lastTextConstituent = new Map<string, string>();

  const pushTextNode = (item: Extract<StreamItem, { kind: "text" | "final" }>, final: boolean): void => {
    // Empty output is not a message. In particular, ignoring it before
    // flushing tools means a provider's empty delta cannot split a tool run.
    if (item.text.trim().length === 0) return;

    const previous = nodes.at(-1);
    if (final) {
      // CODEX's final output repeats its last agent message. Keep the original
      // node (and its Agent heading) rather than showing the same prose twice.
      if (previous?.kind === "text"
        && (previous.text === item.text || lastTextConstituent.get(previous.id) === item.text)) return;
    } else if (previous?.kind === "text" && !previous.final) {
      // Streaming boundaries are not reader-visible boundaries. The first
      // node owns the id and timestamp, while each message remains separated
      // by a blank line inside the same prose card.
      previous.text = `${previous.text}\n\n${item.text}`;
      lastTextConstituent.set(previous.id, item.text);
      return;
    }

    nodes.push({ kind: "text", id: item.id, at: item.at, text: item.text, final });
    if (!final) lastTextConstituent.set(item.id, item.text);
  };

  for (const entry of entries) {
    if ("marker" in entry) {
      flushTools();
      nodes.push(entry.marker);
      continue;
    }
    if ("input" in entry) {
      flushTools();
      nodes.push(entry.input);
      continue;
    }
    const item = entry.item;
    if (item.kind === "tool") {
      tools.push(item);
      continue;
    }

    if ((item.kind === "text" || item.kind === "final") && item.text.trim().length === 0) continue;

    flushTools();
    if (item.kind === "text") {
      pushTextNode(item, false);
    } else if (item.kind === "final") {
      pushTextNode(item, true);
    }
  }
  flushTools();

  return {
    nodes,
    files: normalized.files,
    counts: {
      messages: nodes.filter((node) => node.kind === "text").length,
      toolCalls: nodes.reduce((count, node) => count + (node.kind === "tools" ? node.calls.length : 0), 0),
      files: normalized.files.length,
    },
  };
};
