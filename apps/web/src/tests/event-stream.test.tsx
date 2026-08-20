import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { BACKOFF_CEILING_MS, EVENT_PAGE_CEILING, nextIntervalMs, toEnvelope } from "../lib/use-event-stream";
import type { SessionEvent } from "../lib/types";

const row = (seq: number): SessionEvent => ({
  id: `e${seq}`, sessionId: "s1", runId: "r1", seq, at: "2026-08-16T00:00:00.000Z",
  source: "CLAUDE", type: "PROVIDER_RAW", toolCallId: null, payload: {},
});

/* ------------------------------------------------------------ pure halves */

test("nextIntervalMs holds 2.5s, then doubles per empty poll up to the ceiling", () => {
  for (const empty of [0, 1, 2, 3]) assert.equal(nextIntervalMs(empty), 2_500, String(empty));
  assert.equal(nextIntervalMs(4), 5_000);
  assert.equal(nextIntervalMs(5), 10_000);
  assert.equal(nextIntervalMs(6), BACKOFF_CEILING_MS);
  assert.equal(nextIntervalMs(20), BACKOFF_CEILING_MS);
});

test("toEnvelope passes an envelope through and filters a bare array by afterSeq", () => {
  const envelope = { events: [row(1)], nextAfterSeq: 1, hasMore: true, total: 9 };
  assert.equal(toEnvelope(envelope, null), envelope);

  const all = Array.from({ length: 10 }, (_, index) => row(index + 1));
  const wrapped = toEnvelope(all, null);
  assert.equal(wrapped.events.length, 10);
  assert.equal(wrapped.hasMore, false);
  assert.equal(wrapped.total, 10);

  // The old endpoint ignores afterSeq and returns everything; without this
  // filter every 2.5s poll would re-append the whole history.
  const filtered = toEnvelope(all, 7);
  assert.deepEqual(filtered.events.map((event) => event.seq), [8, 9, 10]);
  assert.equal(filtered.total, 10);
});

/* ------------------------------------------------------------- the hook */

type Responder = (path: string) => unknown;

const withHook = async (
  respond: Responder,
  body: (context: {
    dom: JSDOM;
    requests: string[];
    latest: () => { events: SessionEvent[]; total: number; capped: boolean; error: unknown; reload: () => void };
    advance: (ms: number) => Promise<void>;
    flush: () => Promise<void>;
    setTerminal: (value: boolean) => Promise<void>;
  }) => Promise<void>,
): Promise<void> => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
  };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string) => {
      const path = String(input);
      requests.push(path);
      const result = respond(path);
      if (result instanceof Error) throw result;
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(result) } as unknown as Response;
    },
  });

  // A tiny hand-rolled clock: node:test's mock timers do not survive React's
  // scheduler, and no new dependency is allowed this batch.
  let now = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  let handle = 0;
  const realSetTimeout = dom.window.setTimeout;
  Object.defineProperty(dom.window, "setTimeout", {
    configurable: true,
    value: (run: () => void, delay = 0) => { handle += 1; pending.set(handle, { at: now + delay, run }); return handle; },
  });
  Object.defineProperty(dom.window, "clearTimeout", { configurable: true, value: (id: number) => { pending.delete(id); } });

  const { useEventStream } = await import("../lib/use-event-stream");
  let snapshot: ReturnType<typeof useEventStream> | null = null;
  let terminal = false;
  let rerender: (() => void) | null = null;

  const Probe = ({ isTerminal }: { isTerminal: boolean }) => {
    snapshot = useEventStream("r1", isTerminal);
    return null;
  };

  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  rerender = () => root.render(<Probe isTerminal={terminal} />);

  // Let every microtask-resolved fetch settle before asserting.
  const flush = async (): Promise<void> => {
    await act(async () => { for (let turn = 0; turn < 12; turn += 1) await Promise.resolve(); });
  };
  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    for (let guard = 0; guard < 200; guard += 1) {
      const due = [...pending.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      now = Math.max(now, due[1].at);
      await act(async () => { due[1].run(); });
      await flush();
    }
    now = target;
  };

  await act(async () => { rerender?.(); });
  await flush();
  // The initial drain chains through zero-delay timers, so let them run.
  await advance(0);

  try {
    await body({
      dom, requests,
      latest: () => {
        assert.ok(snapshot);
        return snapshot;
      },
      advance, flush,
      setTerminal: async (value: boolean) => { terminal = value; await act(async () => { rerender?.(); }); await flush(); },
    });
  } finally {
    await act(async () => root.unmount());
    Object.defineProperty(dom.window, "setTimeout", { configurable: true, value: realSetTimeout });
    if (originalFetch) Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    dom.window.close();
  }
};

const page = (events: SessionEvent[], hasMore: boolean, total: number) =>
  ({ events, nextAfterSeq: events.at(-1)?.seq ?? null, hasMore, total });

test("the initial drain follows hasMore and carries afterSeq forward", async () => {
  const pages = [page([row(1), row(2)], true, 5), page([row(3), row(4)], true, 5), page([row(5)], false, 5)];
  let index = 0;
  await withHook(() => pages[Math.min(index++, pages.length - 1)], async ({ requests, latest }) => {
    assert.deepEqual(latest().events.map((event) => event.seq), [1, 2, 3, 4, 5]);
    assert.equal(requests.length, 3);
    assert.doesNotMatch(requests[0] ?? "", /afterSeq/);
    assert.match(requests[1] ?? "", /afterSeq=2/);
    assert.match(requests[2] ?? "", /afterSeq=4/);
    assert.equal(latest().total, 5);
  });
});

test("a live poll appends only what is new and asks from the highest seq held", async () => {
  const pages = [page([row(1)], false, 1), page([row(2)], false, 2)];
  let index = 0;
  await withHook(() => pages[Math.min(index++, pages.length - 1)], async ({ requests, latest, advance }) => {
    assert.equal(latest().events.length, 1);
    await advance(2_500);
    assert.deepEqual(latest().events.map((event) => event.seq), [1, 2]);
    assert.match(requests[1] ?? "", /afterSeq=1/);
  });
});

test("an old-shape response returned twice does not duplicate the history", async () => {
  const all = [row(1), row(2), row(3)];
  await withHook(() => all, async ({ latest, advance }) => {
    assert.equal(latest().events.length, 3);
    await advance(2_500);
    await advance(2_500);
    assert.equal(latest().events.length, 3);
  });
});

test("four empty polls stretch the delay to the ceiling and one event resets it", async () => {
  let live = true;
  let seq = 0;
  await withHook(() => (live ? page([row(seq += 1)], false, seq) : page([], false, seq)), async ({ requests, latest, advance }) => {
    live = false;
    const at = () => requests.length;
    const before = at();
    for (const delay of [2_500, 2_500, 2_500, 2_500]) await advance(delay);
    assert.equal(at(), before + 4, "four polls at the base interval");

    // Now empties 4, 5, 6 stretch to 5s, 10s and 15s.
    await advance(2_499);
    assert.equal(at(), before + 4, "no poll before 5s");
    await advance(2_501);
    assert.equal(at(), before + 5);
    await advance(10_000);
    assert.equal(at(), before + 6);
    await advance(BACKOFF_CEILING_MS);
    assert.equal(at(), before + 7);

    live = true;
    await advance(BACKOFF_CEILING_MS);
    assert.equal(latest().events.length, 2, "the reset poll delivered a new event");
    live = false;
    const afterReset = at();
    await advance(2_500);
    assert.equal(at(), afterReset + 1, "back to the base interval");
  });
});

test("the render ceiling stops the drain and reports capped", async () => {
  let seq = 0;
  await withHook(() => { seq += 1; return page([row(seq)], true, 100_000); }, async ({ requests, latest }) => {
    assert.equal(latest().capped, true);
    assert.equal(requests.length, EVENT_PAGE_CEILING);
  });
});

test("a hidden tab issues no request and resumes without losing the accumulated array", async () => {
  const pages = [page([row(1)], false, 1), page([row(2)], false, 2)];
  let index = 0;
  await withHook(() => pages[Math.min(index++, pages.length - 1)], async ({ dom, requests, latest, advance }) => {
    const before = requests.length;
    Object.defineProperty(dom.window.document, "hidden", { configurable: true, value: true });
    await advance(2_500);
    assert.equal(requests.length, before, "no fetch while hidden");
    assert.equal(latest().events.length, 1, "the accumulated array survives");

    Object.defineProperty(dom.window.document, "hidden", { configurable: true, value: false });
    await advance(2_500);
    assert.equal(requests.length, before + 1);
    assert.deepEqual(latest().events.map((event) => event.seq), [1, 2]);
  });
});

test("a failed poll keeps every event held and keeps polling", async () => {
  let fail = false;
  await withHook(() => (fail ? new Error("network down") : page([row(1)], false, 1)), async ({ requests, latest, advance }) => {
    fail = true;
    await advance(2_500);
    assert.ok(latest().error, "the error surfaces");
    assert.equal(latest().events.length, 1, "events are retained");
    const after = requests.length;
    await advance(2_500);
    assert.equal(requests.length, after + 1, "polling continues");
  });
});

test("a terminal session with nothing more stops dead, and reload issues one more cycle", async () => {
  let calls = 0;
  await withHook(() => { calls += 1; return calls === 1 ? page([row(1)], false, 1) : page([], false, 1); },
    async ({ requests, latest, advance, setTerminal }) => {
      await setTerminal(true);
      await advance(2_500);
      const frozen = requests.length;
      await advance(60_000);
      assert.equal(requests.length, frozen, "no further polls after the terminal stop");

      await act(async () => latest().reload());
      await advance(0);
      assert.equal(requests.length, frozen + 1, "reload issues exactly one more cycle");
      assert.equal(latest().events.length, 1, "and does not re-download the history");
    });
});
