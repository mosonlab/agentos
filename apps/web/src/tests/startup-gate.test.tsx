import assert from "node:assert/strict";
import test from "node:test";
import type { JSDOM } from "jsdom";
import type { ReactNode } from "react";
import { StrictMode, act } from "react";

import { App } from "../App";
import { StartupGate } from "../components/startup-gate";
import { LocaleProvider } from "../lib/i18n";
import { ThemeProvider } from "../lib/theme";
import { installDom, reactDom } from "./dom-harness";

/**
 * The first-load contract (plan Step 5, evidence row E6).
 *
 * The property under test is not "an error is displayed" — the retired banner
 * did that, above a fully mounted application. It is that a refused or
 * unanswered first request leaves *nothing else mounted*: no routed page, no
 * Shell, no runner provider, and therefore no repeating protected request behind
 * the message. So every assertion here counts requests as well as reading
 * markup.
 */
type Scripted = { status: number; body?: string } | { throws: true };

/** A recorded request. `polling` separates the pollers that mount after the gate
 *  succeeds — they alone send `cache: "no-store"` — from the gate's own
 *  bootstrap request, which is the one this file counts. */
type Call = { path: string; polling: boolean };

/**
 * Mounts a subject against a scripted control plane.
 *
 * `bootstrap` answers `/projects` in order; every other path answers 404, which
 * is the shape the application already degrades on and keeps this file's
 * assertions about the *gate* rather than about a fixture for every poll.
 */
const mounted = async (
  subject: () => ReactNode,
  bootstrap: Scripted[],
  drive: (dom: JSDOM, settle: () => Promise<void>) => Promise<void> = async () => undefined,
  /** Mount the way `main.tsx` does. Development runs the whole application
   *  inside `<StrictMode>`, which mounts, unmounts and remounts every effect
   *  before the first request can answer, so a gate that is correct only
   *  without it is a gate no developer can get past. */
  strict = false,
): Promise<{ calls: Call[]; markup: string }> => {
  const { dom, container } = installDom();
  const calls: Call[] = [];
  const original = globalThis.fetch;
  let index = 0;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string, init?: RequestInit) => {
    const path = String(url);
    calls.push({ path, polling: init?.cache === "no-store" });
    if (path !== "/api/projects") return new Response("[]", { status: 404 });
    // A poll repeats whatever the bootstrap last answered rather than advancing
    // the script: the provider that mounts after the gate is polling the same
    // control plane, and answering it differently would be a fixture artefact.
    const at = init?.cache === "no-store" ? Math.max(0, index - 1) : index++;
    const scripted = bootstrap[Math.min(at, bootstrap.length - 1)] ?? { status: 500 };
    if ("throws" in scripted) throw new TypeError("Failed to fetch");
    return new Response(scripted.body ?? "", { status: scripted.status, headers: { "Content-Type": "application/json" } });
  } });
  const root = (await reactDom()).createRoot(container);
  try {
    const tree = <ThemeProvider><LocaleProvider initialLocale="en">{subject()}</LocaleProvider></ThemeProvider>;
    await act(async () => root.render(strict ? <StrictMode>{tree}</StrictMode> : tree));
    const settle = async (): Promise<void> => {
      // Twice: one tick lets the request resolve, the next lets whatever mounted
      // because of it run its own first effect.
      for (let round = 0; round < 2; round += 1) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      }
    };
    await settle();
    await drive(dom, settle);
    return { calls, markup: dom.window.document.body.innerHTML };
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: original });
    await act(async () => root.unmount());
    dom.window.close();
  }
};

const bootstrapCalls = (calls: Call[]): string[] => calls.filter((call) => !call.polling).map((call) => call.path);

const clickText = async (dom: JSDOM, label: string, settle: () => Promise<void>): Promise<void> => {
  const button = [...dom.window.document.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label));
  assert.ok(button, `no button labelled ${label}`);
  await act(async () => button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
  await settle();
};

test("a 401 first load is one request, one blocking screen, and nothing else mounted", async () => {
  const { calls, markup } = await mounted(() => <App />, [{ status: 401, body: '{"error":"Unauthorized"}' }]);
  assert.deepEqual(calls.map((call) => call.path), ["/api/projects"], "exactly one protected request, of any kind");
  assert.match(markup, /data-startup-state="refused"/u);
  assert.match(markup, /Local configuration refused/u);
  // No routed page, no Shell, no runner provider: their polls are the reason the
  // request list above has exactly one entry.
  assert.doesNotMatch(markup, /data-runner-state=|Runner/u);
  assert.doesNotMatch(markup, /Set up AgentOS/u);
});

test("a 403 is the same blocking state as a 401, since both are local configuration", async () => {
  const { calls, markup } = await mounted(() => <App />, [{ status: 403, body: '{"error":"Forbidden for principal"}' }]);
  assert.deepEqual(calls.map((call) => call.path), ["/api/projects"]);
  assert.match(markup, /data-startup-state="refused"/u);
});

test("the refusal screen names files and commands, never a credential or a route to retry by hand", async () => {
  const { markup } = await mounted(() => <App />, [{ status: 401, body: '{"error":"Unauthorized"}' }]);
  assert.match(markup, /\.env/u);
  assert.match(markup, /npm run setup:local/u);
  assert.doesNotMatch(markup, /OPERATOR_TOKEN|Bearer|token=|curl/u);
  // The proxy's own path is not an instruction: an operator being refused has
  // nothing useful to do with it.
  assert.doesNotMatch(markup, /\/api\/projects/u);
});

test("retry re-runs exactly one bootstrap request and mounts the application on success", async () => {
  const { calls, markup } = await mounted(
    () => <App />,
    [{ status: 401, body: '{"error":"Unauthorized"}' }, { status: 200, body: '[{"id":"p1","name":"Vibeville","slug":"vibeville"}]' }],
    async (dom, settle) => { await clickText(dom, "Try again", settle); },
  );
  assert.deepEqual(bootstrapCalls(calls), ["/api/projects", "/api/projects"], "one bootstrap request per attempt");
  assert.doesNotMatch(markup, /data-startup-state="refused"/u);
  assert.match(markup, /Vibeville/u);
});

test("an unanswered control plane is its own state, with the start command and no token guidance", async () => {
  const { calls, markup } = await mounted(() => <App />, [{ throws: true }]);
  assert.deepEqual(calls.map((call) => call.path), ["/api/projects"]);
  assert.match(markup, /data-startup-state="unreachable"/u);
  assert.match(markup, /npm run dev:api/u);
  assert.doesNotMatch(markup, /\.env/u);
});

test("a 500 is neither a refusal nor an outage, and says so without inventing a cause", async () => {
  const { markup } = await mounted(() => <App />, [{ status: 500, body: '{"error":"boom"}' }]);
  assert.match(markup, /data-startup-state="failed"/u);
  assert.match(markup, /500/u);
  assert.doesNotMatch(markup, /\.env|setup:local/u);
});

test("the pending state renders loading only, and never the application", async () => {
  const { dom, container } = installDom();
  const original = globalThis.fetch;
  let calls = 0;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => {
    calls += 1;
    return await new Promise<Response>(() => undefined);
  } });
  const root = (await reactDom()).createRoot(container);
  try {
    await act(async () => root.render(<ThemeProvider><LocaleProvider initialLocale="en"><App /></LocaleProvider></ThemeProvider>));
    const markup = dom.window.document.body.innerHTML;
    assert.equal(calls, 1);
    assert.match(markup, /data-startup-state="pending"/u);
    assert.doesNotMatch(markup, /data-runner-state=|Set up AgentOS/u);
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: original });
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("a populated control plane mounts the application and no wizard", async () => {
  const { calls, markup } = await mounted(
    () => <App />,
    [{ status: 200, body: '[{"id":"p1","name":"Vibeville","slug":"vibeville"}]' }],
  );
  assert.deepEqual(bootstrapCalls(calls), ["/api/projects"]);
  assert.match(markup, /Vibeville/u);
  assert.doesNotMatch(markup, /Set up AgentOS/u);
});

test("the gate hands its children the projects it already fetched", async () => {
  let seen: string[] = [];
  const { calls } = await mounted(
    () => <StartupGate>{(gate) => { seen = gate.projects.map((project) => project.name); return null; }}</StartupGate>,
    [{ status: 200, body: '[{"id":"p1","name":"Vibeville","slug":"vibeville"}]' }],
  );
  assert.deepEqual(seen, ["Vibeville"]);
  assert.deepEqual(calls.map((call) => call.path), ["/api/projects"]);
});

/* --------------------------------------------------------- the real entry point */

/**
 * `main.tsx` renders `<StrictMode>`, and StrictMode is not a stricter version of
 * the same lifecycle — it is a different one. Every effect is set up, torn down
 * and set up again before anything asynchronous can answer, which is precisely
 * the window the bootstrap request lives in. A gate whose request is owned by
 * one effect and cancelled by its cleanup passes every test that mounts the
 * application bare and hangs on `pending` for every developer who runs it.
 */
test("under the entry point's StrictMode a successful bootstrap still mounts the application", async () => {
  const { calls, markup } = await mounted(
    () => <App />,
    [{ status: 200, body: '[{"id":"p1","name":"Vibeville","slug":"vibeville"}]' }],
    async () => undefined,
    true,
  );
  assert.deepEqual(bootstrapCalls(calls), ["/api/projects"], "the remount subscribes to the answer, it does not ask again");
  assert.doesNotMatch(markup, /data-startup-state="pending"/u);
  assert.match(markup, /Vibeville/u);
});

test("under StrictMode a 401 reaches the blocking refusal screen rather than sitting on loading", async () => {
  const { calls, markup } = await mounted(
    () => <App />,
    [{ status: 401, body: '{"error":"Unauthorized"}' }],
    async () => undefined,
    true,
  );
  assert.deepEqual(calls.map((call) => call.path), ["/api/projects"]);
  assert.match(markup, /data-startup-state="refused"/u);
  assert.match(markup, /Local configuration refused/u);
});

test("under StrictMode an empty control plane opens the wizard", async () => {
  const { calls, markup } = await mounted(
    () => <App />,
    [{ status: 200, body: "[]" }],
    async () => undefined,
    true,
  );
  // The wizard's own `GET /onboarding` is in this list too; what is being
  // counted is the bootstrap, which happens once.
  assert.deepEqual(bootstrapCalls(calls).filter((path) => path === "/api/projects"), ["/api/projects"]);
  assert.doesNotMatch(markup, /data-startup-state="pending"/u);
  assert.match(markup, /Set up AgentOS/u);
});

test("under StrictMode retry is still one request per attempt", async () => {
  const { calls, markup } = await mounted(
    () => <App />,
    [{ status: 401, body: '{"error":"Unauthorized"}' }, { status: 200, body: '[{"id":"p1","name":"Vibeville","slug":"vibeville"}]' }],
    async (dom, settle) => { await clickText(dom, "Try again", settle); },
    true,
  );
  assert.deepEqual(bootstrapCalls(calls), ["/api/projects", "/api/projects"]);
  assert.match(markup, /Vibeville/u);
});
