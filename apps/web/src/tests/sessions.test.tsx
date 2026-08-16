import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DebugEvents, FilesTouched, SessionRow, StreamItemView, lifecycleStat, sessionPill, truncateBlock,
} from "../pages/Sessions";
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
  const markup = renderToStaticMarkup(<StreamItemView item={{
    kind: "tool", id: "t1", at: "2026-08-16T00:00:00.000Z", name: "Read",
    primaryArg: "/Users/leohe/repo/src/adapters.ts", filePath: "/Users/leohe/repo/src/adapters.ts",
    args: { file_path: "/Users/leohe/repo/src/adapters.ts" }, result: "ok", state: "ok",
  }} />);
  assert.match(markup, /Read/);
  assert.match(markup, /\/Users\/leohe\/repo\/src\/adapters\.ts/);
  assert.doesNotMatch(markup, />Arguments</);
  assert.doesNotMatch(markup, />Result</);
});

test("Files touched and Debug events render collapsed by default", () => {
  const files = renderToStaticMarkup(<FilesTouched files={[{ path: "/a.ts", count: 2 }]} hint={null} />);
  assert.match(files, /Files touched/);
  assert.doesNotMatch(files, /\/a\.ts/, "body is absent while collapsed");

  const debug = renderToStaticMarkup(<DebugEvents events={[event()]} />);
  assert.match(debug, /Debug events/);
  assert.doesNotMatch(debug, /PROCESS_STARTED/, "body is absent while collapsed");
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
    root.render(<StreamItemView item={{
      kind: "tool", id: "t1", at: "2026-08-16T00:00:00.000Z", name: "Bash", primaryArg: "printf 3",
      filePath: null, args: { command: "printf 3" }, result: "3", state: "ok",
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
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) } as unknown as Response;
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
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) } as unknown as Response;
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
