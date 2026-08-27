import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DebugEvents, FilesTouched, SessionRow, StreamNodeView, WaitingNotice, fileTrackingHint, lifecycleStat,
  sessionPill, truncateBlock,
} from "../pages/Sessions";
import { setFormatLocale } from "../lib/format";
import { LocaleProvider } from "../lib/i18n";
import { translate } from "../lib/i18n-core";
import { TEXT_NODE_MAX_LINES, TOOL_OUTPUT_MAX_LINES } from "../lib/session-stream";
import type { Session, SessionEvent, SessionExecutionStatus } from "../lib/types";

const STATUSES: SessionExecutionStatus[] = [
  "REQUESTED", "PROVISIONING", "RUNNING", "WAITING_INBOX", "SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED", "LOST",
];

const session = (overrides: Partial<Session> = {}): Session => ({
  id: "session-1", runId: "run-1", projectId: "p1", agentId: "agent-1", taskId: "task-1", goalId: null,
  runner: "CLAUDE", executionStatus: "RUNNING", cleanupStatus: "PENDING", providerConversationId: null,
  waitingOnMessageId: null, resumeAttempt: 0, requestedAt: "2026-08-16T00:00:00.000Z",
  startedAt: "2026-08-16T00:00:01.000Z", endedAt: null, terminationReason: null, exitCode: null,
  costUsd: null, inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null,
  failureReason: null, agent: { id: "agent-1", title: "Frontend Dev" }, task: { id: "task-1", name: "Batch 4" },
  goal: null, run: { id: "run-1", runNumber: 3, model: "claude-opus-5", branch: "feat/x", pullRequestUrl: null, workspacePath: "/tmp/w", repo: null },
  ...overrides,
});

const event = (overrides: Partial<SessionEvent> = {}): SessionEvent => ({
  id: "e1", sessionId: "session-1", runId: "run-1", seq: 1, at: "2026-08-16T00:00:00.000Z",
  source: "RUNNER", type: "PROCESS_STARTED", toolCallId: null, payload: {}, ...overrides,
});

const CLAUDE_TEXT_ASSISTANT = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "3" }] } };

/* ------------------------------------------------------------ pure mappings */

test("the status pill uses only tones that already exist", () => {
  const expected: Record<SessionExecutionStatus, { tone: string; label: string }> = {
    REQUESTED: { tone: "grey", label: "queued" },
    PROVISIONING: { tone: "grey", label: "queued" },
    RUNNING: { tone: "green", label: "running" },
    WAITING_INBOX: { tone: "amber", label: "waiting" },
    SUCCEEDED: { tone: "green", label: "done" },
    FAILED: { tone: "red", label: "failed" },
    TIMED_OUT: { tone: "red", label: "timed out" },
    LOST: { tone: "red", label: "lost" },
    CANCELLED: { tone: "grey", label: "cancelled" },
  };
  const tones = new Set(["green", "amber", "violet", "red", "grey", "accent"]);
  for (const status of STATUSES) {
    assert.deepEqual(sessionPill(status), expected[status], status);
    assert.ok(tones.has(sessionPill(status).tone), status);
  }
});

test("the stat bar's lifecycle slot reads Live, Done or Failed", () => {
  // Driven off the same status list as the pill mapping so the two cannot drift.
  for (const status of STATUSES) {
    const expected = ["REQUESTED", "PROVISIONING", "RUNNING", "WAITING_INBOX"].includes(status)
      ? { label: "Live", tone: "green" }
      : status === "SUCCEEDED" ? { label: "Done", tone: "green" } : { label: "Failed", tone: "red" };
    assert.deepEqual(lifecycleStat(status), expected, status);
  }
});

test("blocks truncate at 8 000 characters and say how much is left", () => {
  assert.equal(truncateBlock("short"), "short");
  const long = truncateBlock("x".repeat(9_000));
  assert.match(long, /… truncated, 1000 more characters$/);
  assert.equal(long.split("\n")[0]?.length, 8_000);
});

/* --------------------------------------------------------- initial markup */

test("a collapsed tool row is one line and hides its Arguments and Result", () => {
  const markup = renderToStaticMarkup(<StreamNodeView node={{
    kind: "tools", id: "group-0", at: "2026-08-16T00:00:00.000Z", calls: [{
      kind: "tool", id: "t1", at: "2026-08-16T00:00:00.000Z", name: "Read",
      primaryArg: "/Users/dev/repo/src/adapters.ts", filePath: "/Users/dev/repo/src/adapters.ts",
      args: { file_path: "/Users/dev/repo/src/adapters.ts" }, result: "ok", state: "ok",
    }],
  }} />);
  assert.match(markup, /Read/);
  assert.match(markup, /\/Users\/dev\/repo\/src\/adapters\.ts/);
  assert.doesNotMatch(markup, />Arguments</);
  assert.doesNotMatch(markup, />Result</);
});

const toolNode = {
  kind: "tools" as const,
  id: "group-1",
  at: "2026-08-16T00:00:00.000Z",
  calls: [
    {
      kind: "tool" as const, id: "read-1", at: "2026-08-16T00:00:00.000Z", name: "Read",
      primaryArg: "/repo/a.ts", filePath: "/repo/a.ts", args: { file_path: "/repo/a.ts" }, result: "READ_RESULT_UNIQUE", state: "ok" as const,
    },
    {
      kind: "tool" as const, id: "run-1", at: "2026-08-16T00:00:01.000Z", name: "Bash",
      primaryArg: "npm test", filePath: null, args: { command: "npm test" }, result: "RUN_RESULT_UNIQUE", state: "running" as const,
    },
  ],
};

test("a tools node is one card of collapsed one-line calls", () => {
  const markup = renderToStaticMarkup(<StreamNodeView node={toolNode} />);
  assert.match(markup, /Tool calls/);
  assert.equal((markup.match(/data-tool-line=/g) ?? []).length, 2);
  assert.match(markup, /Read/);
  assert.match(markup, /Bash/);
  assert.match(markup, /\/repo\/a\.ts/);
  assert.match(markup, /npm test/);
  assert.doesNotMatch(markup, /READ_RESULT_UNIQUE|RUN_RESULT_UNIQUE/);
  assert.doesNotMatch(markup, />Arguments</);
  assert.doesNotMatch(markup, />Result</);
});

test("a failed tool line shows the first result line in the destructive tone", () => {
  const failed = {
    ...toolNode,
    calls: [{ ...toolNode.calls[0]!, state: "error" as const, result: "first failure line\nsecond failure line" }],
  };
  const markup = renderToStaticMarkup(<StreamNodeView node={failed} />);
  assert.match(markup, /first failure line/);
  assert.doesNotMatch(markup, /second failure line/);
  assert.match(markup, /text-destructive/);
});

test("text nodes keep the existing Agent and Result message headings", () => {
  const agent = renderToStaticMarkup(<StreamNodeView node={{ kind: "text", id: "m1", at: "2026-08-16T00:00:00.000Z", text: "agent prose", final: false }} />);
  const result = renderToStaticMarkup(<StreamNodeView node={{ kind: "text", id: "m2", at: "2026-08-16T00:00:00.000Z", text: "final prose", final: true }} />);
  assert.match(agent, />Agent</);
  assert.match(agent, /agent prose/);
  assert.match(result, />Result</);
  assert.match(result, /final prose/);
});

test("text nodes clamp at the named line limit behind Show more", () => {
  const text = Array.from({ length: TEXT_NODE_MAX_LINES + 2 }, (_, index) => `prose line ${index + 1}`).join("\n");
  const markup = renderToStaticMarkup(<StreamNodeView node={{ kind: "text", id: "long", at: "2026-08-16T00:00:00.000Z", text, final: false }} />);
  assert.match(markup, /Show more/);
  assert.match(markup, /prose line 12/);
  assert.doesNotMatch(markup, /prose line 13/);
});

test("stream markers render muted resume copy in both locales and errors through ErrorNotice", () => {
  const info = { kind: "marker" as const, id: "resume-1", at: "2026-08-16T00:00:00.000Z", variant: "info" as const, text: "sessions.stream.resumed" };
  const error = { kind: "marker" as const, id: "error-1", at: "2026-08-16T00:00:00.000Z", variant: "error" as const, text: "stream disconnected" };

  const english = renderToStaticMarkup(<LocaleProvider initialLocale="en"><StreamNodeView node={info} /></LocaleProvider>);
  const chinese = renderToStaticMarkup(<LocaleProvider initialLocale="zh"><StreamNodeView node={info} /></LocaleProvider>);
  const errorMarkup = renderToStaticMarkup(<StreamNodeView node={error} />);
  assert.match(english, /Session resumed/);
  assert.match(chinese, /会话已恢复/);
  assert.match(english, /text-muted-foreground/);
  assert.match(errorMarkup, /stream disconnected/);
  assert.match(errorMarkup, /var\(--destructive-bg\)/);
});

test("operator input renders in the message card under a translated Operator heading", () => {
  const input = { kind: "input" as const, id: "input-1", at: "2026-08-16T00:00:00.000Z", text: "continue with the repair" };
  const english = renderToStaticMarkup(<LocaleProvider initialLocale="en"><StreamNodeView node={input} /></LocaleProvider>);
  const chinese = renderToStaticMarkup(<LocaleProvider initialLocale="zh"><StreamNodeView node={input} /></LocaleProvider>);
  assert.match(english, /Operator/);
  assert.match(english, /continue with the repair/);
  assert.match(english, /rounded-xl border border-border bg-card/);
  assert.match(chinese, /操作员/);
  assert.match(chinese, /continue with the repair/);
});

test("tool groups and text node headings are translated in English and Chinese", () => {
  try {
    const english = renderToStaticMarkup(<LocaleProvider initialLocale="en"><StreamNodeView node={toolNode} /></LocaleProvider>);
    const chinese = renderToStaticMarkup(<LocaleProvider initialLocale="zh"><StreamNodeView node={toolNode} /></LocaleProvider>);
    const englishText = renderToStaticMarkup(<LocaleProvider initialLocale="en"><StreamNodeView node={{ kind: "text", id: "m1", at: toolNode.at, text: "agent prose", final: false }} /></LocaleProvider>);
    const chineseText = renderToStaticMarkup(<LocaleProvider initialLocale="zh"><StreamNodeView node={{ kind: "text", id: "m1", at: toolNode.at, text: "agent prose", final: false }} /></LocaleProvider>);
    assert.match(english, /Tool calls/);
    assert.match(chinese, /工具调用/);
    assert.match(englishText, />Agent</);
    assert.match(chineseText, />Agent</);
  } finally {
    setFormatLocale("en", (key, vars) => translate("en", key, vars));
  }
});

test("Files touched and Debug events render collapsed by default", () => {
  const files = renderToStaticMarkup(<FilesTouched files={[{ path: "/a.ts", count: 2 }]} hint={null} />);
  assert.match(files, /Files touched/);
  assert.doesNotMatch(files, /\/a\.ts/, "body is absent while collapsed");

  const debug = renderToStaticMarkup(<DebugEvents events={[event()]} />);
  assert.match(debug, /Debug events/);
  assert.doesNotMatch(debug, /PROCESS_STARTED/, "body is absent while collapsed");
});

test("the file-tracking hint fires for every runner whose path keys are inferred", () => {
  // CLAUDE's extraction is verified against real captured stdout, so a zero
  // there is a fact about the session and must not be explained away.
  assert.equal(fileTrackingHint("CLAUDE", 0, 12), null);
  for (const runner of ["CODEX", "PI"] as const) {
    assert.equal(fileTrackingHint(runner, 0, 12), `File tracking is not available for ${runner} sessions.`);
    // Nothing to explain when paths were found, or when no tool ever ran.
    assert.equal(fileTrackingHint(runner, 3, 12), null);
    assert.equal(fileTrackingHint(runner, 0, 0), null);
  }
});

test("a WAITING_INBOX session always says why, with or without a message id", () => {
  const linked = renderToStaticMarkup(<WaitingNotice status="WAITING_INBOX" messageId="inb-1" />);
  assert.match(linked, /Waiting on an Inbox decision\./);
  assert.match(linked, /#\/inbox\/inb-1/);

  // The id has not landed yet: the notice still renders, unlinked. This is the
  // state where an operator most needs to be told why nothing is happening.
  const bare = renderToStaticMarkup(<WaitingNotice status="WAITING_INBOX" messageId={null} />);
  assert.match(bare, /Waiting on an Inbox decision\./);
  assert.doesNotMatch(bare, /<a/);

  for (const status of STATUSES.filter((candidate) => candidate !== "WAITING_INBOX")) {
    assert.equal(renderToStaticMarkup(<WaitingNotice status={status} messageId="inb-1" />), "", status);
  }
});

test("session durations identify wall-clock spans that include Inbox wait", () => {
  const waiting = renderToStaticMarkup(<table><tbody><SessionRow session={session({ executionStatus: "WAITING_INBOX" })} /></tbody></table>);
  assert.match(waiting, /wall-clock \(includes Inbox wait\)/);

  const resumed = renderToStaticMarkup(<table><tbody><SessionRow session={session({
    executionStatus: "SUCCEEDED",
    resumeAttempt: 1,
    endedAt: "2026-08-16T00:05:01.000Z",
  })} /></tbody></table>);
  assert.match(resumed, /5m 0s wall-clock \(includes Inbox wait\)/);

  const uninterrupted = renderToStaticMarkup(<table><tbody><SessionRow session={session({
    executionStatus: "SUCCEEDED",
    endedAt: "2026-08-16T00:05:01.000Z",
  })} /></tbody></table>);
  assert.doesNotMatch(uninterrupted, /wall-clock|Inbox wait/);
});

test("Sessions.tsx uses design tokens, never a hard-coded hex colour", () => {
  const source = readFileSync(fileURLToPath(new URL("../pages/Sessions.tsx", import.meta.url)), "utf8");
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(source), false);
});

/* ------------------------------------------------------------ interaction */

const jsdom = (): JSDOM => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  return dom;
};

const click = async (dom: JSDOM, node: Element): Promise<void> => {
  await act(async () => { node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0 })); });
};

test("clicking the nested Task link opens the task, not the session", async () => {
  const dom = jsdom();
  dom.window.location.hash = "#/sessions";
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => { root.render(<table><tbody><SessionRow session={session()} /></tbody></table>); });

  const link = dom.window.document.querySelector<HTMLAnchorElement>("a[href='#/tasks/task-1']");
  assert.ok(link, container.innerHTML);
  await click(dom, link);
  // Link prevents the default but does not stop propagation; the row handler
  // must yield to it or the operator lands on the session they did not click.
  assert.equal(dom.window.location.hash, "#/tasks/task-1");

  await act(async () => root.unmount());
  dom.window.close();
});

test("clicking a row anywhere else opens the session", async () => {
  const dom = jsdom();
  dom.window.location.hash = "#/sessions";
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => { root.render(<table><tbody><SessionRow session={session()} /></tbody></table>); });

  const cell = dom.window.document.querySelectorAll("td")[4];
  assert.ok(cell);
  await click(dom, cell);
  assert.equal(dom.window.location.hash, "#/sessions/session-1");

  await act(async () => root.unmount());
  dom.window.close();
});

test("clicking a collapsed tool row reveals Arguments and Result", async () => {
  const dom = jsdom();
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<StreamNodeView node={{
      kind: "tools", id: "group-0", at: "2026-08-16T00:00:00.000Z", calls: [{
        kind: "tool", id: "t1", at: "2026-08-16T00:00:00.000Z", name: "Bash", primaryArg: "printf 3",
        filePath: null, args: { command: "printf 3" }, result: "3", state: "ok",
      }],
    }} />);
  });
  assert.doesNotMatch(container.innerHTML, />Arguments</);

  const toggle = dom.window.document.querySelector("button");
  assert.ok(toggle);
  await click(dom, toggle);
  assert.match(container.innerHTML, />Arguments</);
  assert.match(container.innerHTML, />Result</);

  await act(async () => root.unmount());
  dom.window.close();
});

test("clicking one tool line expands only that call", async () => {
  const dom = jsdom();
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => { root.render(<StreamNodeView node={toolNode} />); });

  const lines = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button[data-tool-line]")];
  assert.equal(lines.length, 2);
  assert.doesNotMatch(container.innerHTML, /READ_RESULT_UNIQUE|RUN_RESULT_UNIQUE/);
  await click(dom, lines[0]!);
  assert.match(container.innerHTML, /READ_RESULT_UNIQUE/);
  assert.doesNotMatch(container.innerHTML, /RUN_RESULT_UNIQUE/);

  await act(async () => root.unmount());
  dom.window.close();
});

const oversizedToolNode = {
  kind: "tools" as const,
  id: "oversized-group",
  at: "2026-08-16T00:00:00.000Z",
  calls: [{
    kind: "tool" as const,
    id: "oversized-call",
    at: "2026-08-16T00:00:00.000Z",
    name: "Bash",
    primaryArg: "printf output",
    filePath: null,
    args: Array.from({ length: TOOL_OUTPUT_MAX_LINES + 3 }, (_, index) => `argument ${index + 1}`),
    result: Array.from({ length: TOOL_OUTPUT_MAX_LINES + 5 }, (_, index) => `result ${index + 1}`).join("\n"),
    state: "ok" as const,
  }],
};

test("expanded tool arguments and results clamp at 40 lines and show what was withheld", async () => {
  const dom = jsdom();
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => { root.render(<StreamNodeView node={oversizedToolNode} />); });
  const toggle = dom.window.document.querySelector<HTMLButtonElement>("button[data-tool-line]");
  assert.ok(toggle);
  await click(dom, toggle);

  const body = container.textContent ?? "";
  assert.match(body, /argument 1/);
  assert.match(body, /result 1/);
  assert.doesNotMatch(body, /argument 43/);
  assert.doesNotMatch(body, /result 45/);
  assert.equal((body.match(/5 more lines withheld/gu) ?? []).length, 2);
  assert.match(container.innerHTML, /max-h-\[460px\]/);

  await act(async () => root.unmount());
  dom.window.close();
});

test("a one-line result still reaches the 8 000-character byte backstop after line clamping", async () => {
  const dom = jsdom();
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<StreamNodeView node={{
      kind: "tools", id: "byte-group", at: "2026-08-16T00:00:00.000Z", calls: [{
        kind: "tool", id: "byte-call", at: "2026-08-16T00:00:00.000Z", name: "Bash", primaryArg: "printf",
        filePath: null, args: null, result: "x".repeat(9_000), state: "ok",
      }],
    }} />);
  });
  const toggle = dom.window.document.querySelector<HTMLButtonElement>("button[data-tool-line]");
  assert.ok(toggle);
  await click(dom, toggle);
  assert.match(container.textContent ?? "", /… truncated, 1000 more characters/);
  assert.doesNotMatch(container.textContent ?? "", /more lines withheld/);

  await act(async () => root.unmount());
  dom.window.close();
});

test("withheld-line wording is translated with its count in English and Chinese", async () => {
  const renderExpanded = async (locale: "en" | "zh"): Promise<{ dom: JSDOM; root: ReturnType<typeof createRoot>; container: Element }> => {
    const dom = jsdom();
    const container = dom.window.document.querySelector("#root");
    assert.ok(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<LocaleProvider initialLocale={locale}><StreamNodeView node={oversizedToolNode} /></LocaleProvider>);
    });
    const toggle = dom.window.document.querySelector<HTMLButtonElement>("button[data-tool-line]");
    assert.ok(toggle);
    await click(dom, toggle);
    return { dom, root, container };
  };

  try {
    const english = await renderExpanded("en");
    assert.match(english.container.textContent ?? "", /5 more lines withheld/);
    await act(async () => english.root.unmount());
    english.dom.window.close();

    const chinese = await renderExpanded("zh");
    assert.match(chinese.container.textContent ?? "", /还有 5 行未显示/);
    await act(async () => chinese.root.unmount());
    chinese.dom.window.close();
  } finally {
    setFormatLocale("en", (key, vars) => translate("en", key, vars));
  }
});

test("clicking Show more reveals the rest of a long text node", async () => {
  const dom = jsdom();
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  const text = Array.from({ length: TEXT_NODE_MAX_LINES + 2 }, (_, index) => `full prose ${index + 1}`).join("\n");
  await act(async () => { root.render(<StreamNodeView node={{ kind: "text", id: "long-interactive", at: "2026-08-16T00:00:00.000Z", text, final: false }} />); });
  assert.doesNotMatch(container.textContent ?? "", /full prose 14/);
  const more = [...dom.window.document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Show more");
  assert.ok(more);
  await click(dom, more);
  assert.match(container.textContent ?? "", /full prose 14/);
  assert.match(container.textContent ?? "", /Show less/);

  await act(async () => root.unmount());
  dom.window.close();
});

test("the Debug events filter switches between all, provider and runner rows", async () => {
  const dom = jsdom();
  const events = [event(), event({ id: "e2", seq: 2, source: "CLAUDE", type: "PROVIDER_RAW" })];
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => { root.render(<DebugEvents events={events} />); });

  const byLabel = async (label: string): Promise<void> => {
    const button = [...dom.window.document.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
    assert.ok(button, `${label} not found in ${container.innerHTML}`);
    await click(dom, button);
  };

  await byLabel("Debug events");
  assert.match(container.innerHTML, /PROCESS_STARTED/);
  assert.match(container.innerHTML, /PROVIDER_RAW/);

  await byLabel("Runner");
  assert.match(container.innerHTML, /PROCESS_STARTED/);
  assert.doesNotMatch(container.innerHTML, /PROVIDER_RAW/);

  await byLabel("Provider");
  assert.doesNotMatch(container.innerHTML, /PROCESS_STARTED/);
  assert.match(container.innerHTML, /PROVIDER_RAW/);

  await act(async () => root.unmount());
  dom.window.close();
});

test("Load more keeps page one and dedupes it against the live head", async () => {
  // No localStorage stub: jsdom's default about:blank origin is opaque and the
  // getter throws, which lib/storage.ts already degrades to its in-memory map.
  const dom = jsdom();

  const head = (ids: string[]) => ids.map((id, index) =>
    session({ id, requestedAt: `2026-08-16T02:${String(index).padStart(2, "0")}:00.000Z` }));
  const older = Array.from({ length: 50 }, (_, index) =>
    session({ id: `old-${index}`, requestedAt: `2026-08-15T01:${String(index).padStart(2, "0")}:00.000Z` }));

  let headRows = head(Array.from({ length: 50 }, (_, index) => `new-${index}`));
  const requests: string[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string) => {
      const path = String(input);
      requests.push(path);
      const payload = path.includes("/projects") ? [{ id: "p1", name: "Demo" }]
        : path.includes("before=") ? older
          : headRows;
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(payload) } as unknown as Response;
    },
  });

  const { ProjectProvider } = await import("../lib/project");
  const { SessionsPage } = await import("../pages/Sessions");
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  const flush = async (): Promise<void> => {
    await act(async () => { for (let turn = 0; turn < 20; turn += 1) await Promise.resolve(); });
  };
  await act(async () => { root.render(<ProjectProvider><SessionsPage /></ProjectProvider>); });
  await flush();

  const rows = (): number => dom.window.document.querySelectorAll("tbody tr").length;
  assert.equal(rows(), 50);

  const more = [...dom.window.document.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Load more");
  assert.ok(more, container.innerHTML);
  await click(dom, more);
  await flush();
  assert.equal(rows(), 100, "page one is retained under page two");
  assert.ok(requests.some((path) => path.includes("before=")));

  // A head poll that now overlaps an older row must not double it: 50 + 50 with
  // one shared id is 100 rows, not the 101 a naive concatenation would produce.
  headRows = [...head(Array.from({ length: 50 }, (_, index) => `new-${index}`)), older[0] as Session];
  await act(async () => {
    const refresh = [...dom.window.document.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Refresh");
    assert.ok(refresh);
    refresh.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0 }));
  });
  await flush();
  assert.equal(rows(), 100, "the id dedup holds");

  await act(async () => root.unmount());
  dom.window.close();
});

test("the detail page does not call the initial drain `N new`", async () => {
  // Caught in a real browser against a 771-event session: every historical
  // event was counted as unseen, so the page opened offering `98 new ↓`.
  const dom = jsdom();
  // JSDOM has no layout, so every scroll metric is 0 and the stream always reads
  // as "already at the bottom" — which is the one branch that never counts.
  // Stub the two metrics so the scrolled-up branch is the one under test.
  Object.defineProperty(dom.window.Element.prototype, "scrollHeight", { configurable: true, get: () => 5_000 });
  Object.defineProperty(dom.window.Element.prototype, "clientHeight", { configurable: true, get: () => 400 });

  const events = Array.from({ length: 12 }, (_, index) => event({
    id: `e${index}`, seq: index + 1, source: "CLAUDE", type: "MODEL_DELTA",
    payload: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `line ${index}` }] } },
  }));
  const detail = session({ executionStatus: "SUCCEEDED", endedAt: "2026-08-16T00:10:00.000Z" });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string) => {
      const path = String(input);
      // Two pages, so the flag has to survive an intermediate render.
      const payload = path.includes("/events")
        ? path.includes("afterSeq=6")
          ? { events: events.slice(6), nextAfterSeq: 12, hasMore: false, total: 12 }
          : { events: events.slice(0, 6), nextAfterSeq: 6, hasMore: true, total: 12 }
        : detail;
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(payload) } as unknown as Response;
    },
  });

  const { SessionDetailPage } = await import("../pages/Sessions");
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<SessionDetailPage sessionId="session-1" />); });
    for (let turn = 0; turn < 6; turn += 1) {
      await act(async () => { for (let inner = 0; inner < 20; inner += 1) await Promise.resolve(); });
      await act(async () => { await new Promise((resolve) => dom.window.setTimeout(resolve, 0)); });
    }
    assert.match(container.innerHTML, /line 11/, "both pages drained");
    assert.doesNotMatch(container.innerHTML, /new ↓/, "history is not news");
  } finally {
    // The page polls forever on real timers; without an unmount on the failure
    // path the runner never sees the event loop drain and the file hangs.
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("the live stream counts a newly arrived tool group as one new node", async () => {
  const dom = jsdom();
  Object.defineProperty(dom.window, "scrollTo", { configurable: true, value: () => undefined });
  Object.defineProperty(dom.window.Element.prototype, "scrollHeight", { configurable: true, get: () => 5_000 });
  Object.defineProperty(dom.window.Element.prototype, "clientHeight", { configurable: true, get: () => 400 });

  const initial = event({
    id: "initial", seq: 1, source: "CLAUDE", type: "MODEL_DELTA",
    payload: CLAUDE_TEXT_ASSISTANT,
  });
  const calls = [
    event({ id: "tool-1-start", seq: 2, source: "CLAUDE", type: "TOOL_STARTED", toolCallId: "tool-1", payload: { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/a.ts" } } }),
    event({ id: "tool-1-end", seq: 3, source: "CLAUDE", type: "TOOL_COMPLETED", toolCallId: "tool-1", payload: { tool_use_id: "tool-1", content: "a", is_error: false } }),
    event({ id: "tool-2-start", seq: 4, source: "CLAUDE", type: "TOOL_STARTED", toolCallId: "tool-2", payload: { type: "tool_use", id: "tool-2", name: "Bash", input: { command: "npm test" } } }),
    event({ id: "tool-2-end", seq: 5, source: "CLAUDE", type: "TOOL_COMPLETED", toolCallId: "tool-2", payload: { tool_use_id: "tool-2", content: "ok", is_error: false } }),
  ];
  let current = [initial];
  const detail = session({ executionStatus: "RUNNING" });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string) => {
      const path = String(input);
      const payload = path.includes("/runs/")
        ? path.includes("afterSeq=1")
          ? { events: calls, nextAfterSeq: 5, hasMore: false, total: 5 }
          : { events: current, nextAfterSeq: current.at(-1)?.seq ?? null, hasMore: false, total: current.length }
        : detail;
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(payload) } as unknown as Response;
    },
  });

  const { SessionDetailPage } = await import("../pages/Sessions");
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  const flush = async (): Promise<void> => {
    await act(async () => { for (let turn = 0; turn < 30; turn += 1) await Promise.resolve(); });
  };
  try {
    await act(async () => { root.render(<SessionDetailPage sessionId="session-1" />); });
    await flush();
    const scroller = container.querySelector<HTMLElement>('div[class*="max-h-[720px]"]');
    assert.ok(scroller, container.innerHTML);
    scroller.scrollTop = 0;
    current = [initial, ...calls];
    const refresh = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Refresh");
    assert.ok(refresh, container.innerHTML);
    await click(dom, refresh);
    await flush();

    assert.match(container.textContent ?? "", /1 new ↓/u, "one projected tools node is new");
    assert.equal((container.textContent?.match(/Tool calls/gu) ?? []).length, 1);
    const news = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "1 new ↓");
    assert.ok(news, container.innerHTML);
    await click(dom, news);
    assert.equal(scroller.scrollTop, 5_000);
    assert.doesNotMatch(container.textContent ?? "", /1 new ↓/u);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("a live stream at the bottom auto-scrolls after its initial drain", async () => {
  const dom = jsdom();
  Object.defineProperty(dom.window, "scrollTo", { configurable: true, value: () => undefined });
  Object.defineProperty(dom.window.Element.prototype, "scrollHeight", { configurable: true, get: () => 5_000 });
  Object.defineProperty(dom.window.Element.prototype, "clientHeight", { configurable: true, get: () => 400 });
  const initial = event({
    id: "initial-bottom", seq: 1, source: "CLAUDE", type: "MODEL_DELTA", payload: CLAUDE_TEXT_ASSISTANT,
  });
  let current = [initial];
  const detail = session({ executionStatus: "RUNNING" });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string) => {
      const path = String(input);
      const payload = path.includes("/runs/")
        ? { events: current, nextAfterSeq: current.at(-1)?.seq ?? null, hasMore: false, total: current.length }
        : detail;
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(payload) } as unknown as Response;
    },
  });

  const { SessionDetailPage } = await import("../pages/Sessions");
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  const flush = async (): Promise<void> => {
    await act(async () => { for (let turn = 0; turn < 30; turn += 1) await Promise.resolve(); });
  };
  try {
    await act(async () => { root.render(<SessionDetailPage sessionId="session-1" />); });
    await flush();
    const scroller = container.querySelector<HTMLElement>('div[class*="max-h-[720px]"]');
    assert.ok(scroller, container.innerHTML);
    assert.equal(scroller.scrollTop, 5_000);
    current = [initial, event({ id: "new-bottom", seq: 2, source: "CLAUDE", type: "MODEL_DELTA", payload: CLAUDE_TEXT_ASSISTANT })];
    const refresh = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Refresh");
    assert.ok(refresh, container.innerHTML);
    await click(dom, refresh);
    await flush();
    assert.equal(scroller.scrollTop, 5_000);
    assert.doesNotMatch(container.textContent ?? "", /new ↓/u);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("a capped stream keeps the visible event-cap notice", async () => {
  const dom = jsdom();
  Object.defineProperty(dom.window, "scrollTo", { configurable: true, value: () => undefined });
  const detail = session({ executionStatus: "SUCCEEDED", endedAt: "2026-08-16T00:10:00.000Z" });
  let seq = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string) => {
      const path = String(input);
      if (!path.includes("/runs/")) {
        return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(detail) } as unknown as Response;
      }
      seq += 1;
      const row = event({
        id: `capped-${seq}`, seq, source: "CLAUDE", type: "MODEL_DELTA",
        payload: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `event ${seq}` }] } },
      });
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({
        events: [row], nextAfterSeq: seq, hasMore: true, total: 100,
      }) } as unknown as Response;
    },
  });

  const { SessionDetailPage } = await import("../pages/Sessions");
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<SessionDetailPage sessionId="session-1" />); });
    for (let turn = 0; turn < 100 && seq < 40; turn += 1) {
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await new Promise((resolve) => dom.window.setTimeout(resolve, 0)); });
    }
    assert.equal(seq, 40);
    assert.match(container.textContent ?? "", /Showing the first 40 of 100 events/u);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("a failed Load more tells the operator instead of vanishing into the console", async () => {
  const dom = jsdom();
  const headRows = Array.from({ length: 50 }, (_, index) =>
    session({ id: `new-${index}`, requestedAt: `2026-08-16T02:${String(index).padStart(2, "0")}:00.000Z` }));

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string) => {
      const path = String(input);
      if (path.includes("/projects")) {
        return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify([{ id: "p1", name: "Demo" }]) } as unknown as Response;
      }
      // Only the older page fails, so the live head stays on screen.
      if (path.includes("before=")) {
        return { ok: false, status: 503, headers: new Headers(), text: async () => JSON.stringify({ error: "Service unavailable" }) } as unknown as Response;
      }
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(headRows) } as unknown as Response;
    },
  });

  const { ProjectProvider } = await import("../lib/project");
  const { SessionsPage } = await import("../pages/Sessions");
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  const flush = async (): Promise<void> => {
    await act(async () => { for (let turn = 0; turn < 20; turn += 1) await Promise.resolve(); });
  };
  await act(async () => { root.render(<ProjectProvider><SessionsPage /></ProjectProvider>); });
  await flush();

  const more = [...dom.window.document.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Load more");
  assert.ok(more, container.innerHTML);
  await click(dom, more);
  await flush();

  assert.match(container.textContent ?? "", /503/, "the failure is on the page, not only in the console");
  assert.equal(dom.window.document.querySelectorAll("tbody tr").length, 50, "page one survives a failed page two");
  const retry = [...dom.window.document.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Load more");
  assert.ok(retry, "the button stays available as the retry");
  assert.equal(retry.hasAttribute("disabled"), false);

  await act(async () => root.unmount());
  dom.window.close();
});
