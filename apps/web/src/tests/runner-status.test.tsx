import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  RunnerRow, RunnersProvider, RunnerStatusDetails, runnerSummary, useRunners,
} from "../components/runner-status";
import { LocaleProvider } from "../lib/i18n";
import type { RunnersResponse } from "../lib/types";

const now = new Date();
const payload = (overrides: Partial<RunnersResponse> = {}): RunnersResponse => ({
  checkedAt: now.toISOString(),
  online: 1,
  total: 1,
  daemons: [{
    runnerId: "runner-b", lastSeenAt: now.toISOString(), online: true, busy: true, activeRuns: 1,
    daemonVersion: "0.0.0", diskFreeBytes: 132.4 * 1024 ** 3, pollIntervalMs: 5_000, workspaceRoot: "/tmp/runs",
  }],
  backends: [
    { runner: "CLAUDE", cliVersion: "2.1.227", authMode: "subscription", lastPreflightAt: now.toISOString(), lastPreflightOk: true, circuitOpen: false, circuitReason: null },
    { runner: "CODEX", cliVersion: "0.147.0", authMode: "chatgpt", lastPreflightAt: now.toISOString(), lastPreflightOk: true, circuitOpen: false, circuitReason: null },
    { runner: "PI", cliVersion: null, authMode: null, lastPreflightAt: null, lastPreflightOk: null, circuitOpen: null, circuitReason: null },
  ],
  ...overrides,
});

const renderDetails = (data: RunnersResponse): string => renderToStaticMarkup(
  <LocaleProvider initialLocale="en"><RunnerStatusDetails payload={data} /></LocaleProvider>,
);

test("the popover renders the seven runner detail gaps", () => {
  const markup = renderDetails(payload());
  for (const expected of ["runner-b", "Busy", "Last heartbeat", "Daemon version 0.0.0", "Claude CLI 2.1.227", "Codex CLI 0.147.0", "Pi CLI —", "Disk free 132.4 GB", "Refreshes every 30s"]) {
    assert.match(markup, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")), expected);
  }
});

test("Busy is present only for a busy daemon", () => {
  assert.match(renderDetails(payload()), />Busy</);
  const idle = payload({ daemons: [{ ...payload().daemons[0]!, busy: false, activeRuns: 0 }] });
  assert.doesNotMatch(renderDetails(idle), />Busy</);
  assert.doesNotMatch(renderDetails(idle), />Idle</);
});

test("never seen and offline are distinct summary states", () => {
  assert.equal(runnerSummary(payload({ online: 0, total: 0, daemons: [] }), now).state, "neverSeen");
  assert.equal(runnerSummary(payload({ online: 0, daemons: [{ ...payload().daemons[0]!, online: false, busy: false }] }), now).state, "offline");
});

test("missing daemon telemetry renders em dashes", () => {
  const markup = renderDetails(payload({ daemons: [{ ...payload().daemons[0]!, daemonVersion: null, diskFreeBytes: null }] }));
  assert.match(markup, /Daemon version —/);
  assert.match(markup, /Disk free —/);
});

test("low disk alone carries the destructive tone", () => {
  const low = renderDetails(payload({ daemons: [{ ...payload().daemons[0]!, diskFreeBytes: 1.2 * 1024 ** 3 }] }));
  const high = renderDetails(payload());
  assert.match(low, /text-destructive[^>]*>Disk free 1.2 GB/);
  assert.doesNotMatch(high, /text-destructive[^>]*>Disk free 132.4 GB/);
});

test("an open backend circuit shows its reason", () => {
  const data = payload({ backends: payload().backends.map((backend) => backend.runner === "CODEX" ? { ...backend, circuitOpen: true, circuitReason: "Login expired; run codex login" } : backend) });
  assert.match(renderDetails(data), /Login expired; run codex login/);
  assert.equal(runnerSummary(data, now).tone, "amber");
});

test("a 90-second-old payload is unknown even when its daemon says online", () => {
  assert.deepEqual(runnerSummary(payload({ checkedAt: new Date(now.getTime() - 90_000).toISOString() }), now), { state: "unknown", tone: "grey" });
});

test("two daemon blocks are sorted and report two of two online", () => {
  const data = payload({
    online: 2, total: 2,
    daemons: [payload().daemons[0]!, { ...payload().daemons[0]!, runnerId: "runner-a", busy: false, activeRuns: 0 }],
  });
  const markup = renderDetails(data);
  assert.match(markup, /2 of 2 runner online/);
  assert.ok(markup.indexOf("runner-a") < markup.indexOf("runner-b"));
});

type Timer = { at: number; every: number | null; run: () => void };
const withProvider = async (
  respond: (path: string, count: number) => { ok: boolean; body: unknown },
  operation: (context: { dom: JSDOM; requests: string[]; advance: (ms: number) => Promise<void>; latest: () => ReturnType<typeof useRunners> }) => Promise<void>,
): Promise<void> => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
  })) Object.defineProperty(globalThis, key, { configurable: true, value });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

  const requests: string[] = [];
  const counts = new Map<string, number>();
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: string) => {
    const path = String(input);
    requests.push(path);
    const count = (counts.get(path) ?? 0) + 1;
    counts.set(path, count);
    const response = respond(path, count);
    return {
      ok: response.ok,
      status: response.ok ? 200 : 503,
      headers: new Headers(),
      text: async () => JSON.stringify(response.body),
    } as Response;
  } });

  let clock = now.getTime();
  let handle = 0;
  const timers = new Map<number, Timer>();
  const originalDateNow = Date.now;
  Object.defineProperty(Date, "now", { configurable: true, value: () => clock });
  Object.defineProperty(dom.window, "setInterval", { configurable: true, value: (run: () => void, every: number) => {
    handle += 1;
    timers.set(handle, { at: clock + every, every, run });
    return handle;
  } });
  Object.defineProperty(dom.window, "clearInterval", { configurable: true, value: (id: number) => timers.delete(id) });
  Object.defineProperty(dom.window, "setTimeout", { configurable: true, value: (run: () => void, delay: number) => {
    handle += 1;
    timers.set(handle, { at: clock + delay, every: null, run });
    return handle;
  } });
  Object.defineProperty(dom.window, "clearTimeout", { configurable: true, value: (id: number) => timers.delete(id) });

  let snapshot: ReturnType<typeof useRunners> | null = null;
  const Probe = () => { snapshot = useRunners(); return null; };
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  const flush = async (): Promise<void> => { await act(async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); }); };
  const advance = async (ms: number): Promise<void> => {
    const target = clock + ms;
    for (let guard = 0; guard < 100; guard += 1) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      clock = due[1].at;
      if (due[1].every === null) timers.delete(due[0]);
      else due[1].at += due[1].every;
      await act(async () => due[1].run());
      await flush();
    }
    clock = target;
  };

  try {
    await act(async () => root.render(<RunnersProvider><Probe /><Probe /><RunnerRow /></RunnersProvider>));
    await flush();
    await operation({ dom, requests, advance, latest: () => { assert.ok(snapshot); return snapshot; } });
  } finally {
    await act(async () => root.unmount());
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    Object.defineProperty(Date, "now", { configurable: true, value: originalDateNow });
    dom.window.close();
  }
};

test("two consumers still create one poll per path", async () => {
  await withProvider((path) => ({ ok: true, body: path.endsWith("/runners") ? payload() : { status: "ok", database: "connected", checkedAt: now.toISOString() } }), async ({ requests, advance }) => {
    await advance(89_999);
    assert.equal(requests.filter((path) => path.endsWith("/runners")).length, 3);
    assert.equal(requests.filter((path) => path.endsWith("/health")).length, 9);
  });
});

test("lastSuccessAt survives a later failed poll", async () => {
  await withProvider((path, count) => path.endsWith("/health") && count > 1
    ? { ok: false, body: { error: "down" } }
    : { ok: true, body: path.endsWith("/runners") ? payload() : { status: "ok", database: "connected", checkedAt: now.toISOString() } }, async ({ advance, latest }) => {
    const first = latest().health.lastSuccessAt;
    assert.ok(first);
    await advance(10_000);
    assert.equal(latest().health.lastSuccessAt, first);
    assert.ok(latest().health.error);
  });
});

test("a mounted runner row ages to Unknown while hidden and stays Unknown when visibility returns", async () => {
  await withProvider((path, count) => {
    if (path.endsWith("/runners") && count > 1) return { ok: false, body: { error: "unreachable" } };
    return { ok: true, body: path.endsWith("/runners") ? payload() : { status: "ok", database: "connected", checkedAt: now.toISOString() } };
  }, async ({ dom, advance }) => {
    const rowState = (): string => dom.window.document.querySelector("button")?.textContent ?? "";
    assert.match(rowState(), /Busy/);
    Object.defineProperty(dom.window.document, "hidden", { configurable: true, value: true });
    await advance(60_001);
    assert.match(rowState(), /Unknown/);
    Object.defineProperty(dom.window.document, "hidden", { configurable: true, value: false });
    await act(async () => dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")));
    assert.match(rowState(), /Unknown/);
  });
});
