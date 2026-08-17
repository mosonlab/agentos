import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { ROUTES } from "../App";
import { ThemeCycleButton } from "../components/Shell";
import { ApiError } from "../lib/api";
import type { Poll } from "../lib/hooks";
import { LocaleProvider } from "../lib/i18n";
import { storage } from "../lib/storage";
import { ThemeProvider } from "../lib/theme";
import type { Health, RunnersResponse } from "../lib/types";
import { SecretsPage } from "../pages/Secrets";
import { SettingsContent, SettingsPage } from "../pages/Settings";

const idle = <T,>(overrides: Partial<Poll<T>> = {}): Poll<T> => ({
  data: null, error: null, loading: false, missing: false, lastSuccessAt: null, reload: () => undefined, ...overrides,
});

const renderSettings = (health: Poll<Health> = idle<Health>()): string => renderToStaticMarkup(
  <ThemeProvider><LocaleProvider initialLocale="en"><SettingsContent runners={idle<RunnersResponse>()} health={health} /></LocaleProvider></ThemeProvider>,
);

const runnerPayload = (diskFreeBytes = 1024 ** 3): RunnersResponse => ({
  checkedAt: new Date().toISOString(), online: 1, total: 1,
  daemons: [{
    runnerId: "runner-a", lastSeenAt: new Date().toISOString(), online: true, busy: true, activeRuns: 1,
    daemonVersion: "0.0.0", diskFreeBytes, pollIntervalMs: 5_000, workspaceRoot: "/tmp/runs",
  }],
  backends: [],
});

test("settings and secrets resolve to distinct pages", () => {
  const settings = ROUTES.find((route) => route.pattern === "/settings");
  const secrets = ROUTES.find((route) => route.pattern === "/secrets");
  assert.ok(settings && secrets);
  assert.equal((settings.render({}) as { type: unknown }).type, SettingsPage);
  assert.equal((secrets.render({}) as { type: unknown }).type, SecretsPage);
});

test("the three settings cards render complete missing states", () => {
  const markup = renderSettings();
  for (const title of ["Appearance", "Runner", "Control plane"]) assert.match(markup, new RegExp(`>${title}<`));
  for (const field of ["Daemon version", "Disk free", "Workspace root", "CLI version", "Auth mode", "Last preflight", "Circuit reason"]) assert.match(markup, new RegExp(field));
  assert.ok((markup.match(/—/gu) ?? []).length >= 10);
});

test("the page never renders operator credentials", () => {
  const markup = renderSettings();
  assert.doesNotMatch(markup, /Bearer|OPERATOR_TOKEN|VITE_API_TOKEN/u);
  assert.match(markup, /<code>\/api<\/code>/);
});

test("a failed health poll keeps and renders its earlier success time", () => {
  const markup = renderSettings(idle<Health>({
    error: new ApiError(503, "/health", "down"),
    lastSuccessAt: new Date().toISOString(),
  }));
  assert.match(markup, /unreachable/);
  assert.match(markup, /Last successful poll[\s\S]*>(?:just )?now</);
});

test("the Settings runner card emphasizes online, Busy, and low disk independently", () => {
  const low = renderToStaticMarkup(
    <ThemeProvider><LocaleProvider initialLocale="en"><SettingsContent runners={idle<RunnersResponse>({ data: runnerPayload() })} health={idle<Health>()} /></LocaleProvider></ThemeProvider>,
  );
  assert.match(low, /data-runner-state="running"[\s\S]*?bg-\[color:var\(--status-green-fg\)\][\s\S]*?>Running</u);
  assert.match(low, /data-runner-busy=""[\s\S]*?>Busy</u);
  assert.match(low, /data-low-disk="" class="text-destructive">1\.0 GB/u);

  const high = renderToStaticMarkup(
    <ThemeProvider><LocaleProvider initialLocale="en"><SettingsContent runners={idle<RunnersResponse>({ data: runnerPayload(8 * 1024 ** 3) })} health={idle<Health>()} /></LocaleProvider></ThemeProvider>,
  );
  assert.doesNotMatch(high, /data-low-disk=""/u);
});

test("appearance controls share locale and theme stores with the sidebar", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "http://localhost/settings" });
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
  })) Object.defineProperty(globalThis, key, { configurable: true, value });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  storage.remove("agentos.locale");
  storage.remove("agentos.theme");

  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <ThemeProvider><LocaleProvider>
        <SettingsContent runners={idle<RunnersResponse>()} health={idle<Health>()} />
        <ThemeCycleButton />
      </LocaleProvider></ThemeProvider>,
    ));
    const button = (label: string): HTMLButtonElement => {
      const match = [...dom.window.document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
      assert.ok(match, label);
      return match as HTMLButtonElement;
    };
    await act(async () => button("Dark").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(dom.window.localStorage.getItem("agentos.theme"), "dark");
    assert.match(dom.window.document.body.textContent ?? "", /Theme: dark/);

    await act(async () => button("中文").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(dom.window.localStorage.getItem("agentos.locale"), "zh");
    assert.match(dom.window.document.body.textContent ?? "", /设置/);
    assert.match(dom.window.document.body.textContent ?? "", /主题：深色/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
