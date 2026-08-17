import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentToolsCard, BindingToggle } from "../pages/Agents";
import { ENFORCED_BY, TOOL_KEYS } from "../lib/tools";
import type { Agent, RunnerPreference } from "../lib/types";

const agent = (overrides: Partial<Agent> = {}): Agent => ({
  id: "a", projectId: "p", environmentId: "e", name: "senior-dev", title: "Senior Developer",
  model: "claude-opus-5:high", runnerPreference: "CLAUDE", inboxAccess: false, disabledTools: [],
  foundationalPrompt: "foundation", rolePrompt: "role", createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z", archivedAt: null, ...overrides,
});

const cardDom = (value: Agent): JSDOM => new JSDOM(renderToStaticMarkup(<AgentToolsCard agent={value} onSaved={() => undefined} />));
const switches = (dom: JSDOM): Element[] => [...dom.window.document.querySelectorAll('[role="switch"]')];

test("the eight tool toggles render in canonical order and reflect the denied set", () => {
  const allOn = cardDom(agent());
  const buttons = switches(allOn);
  assert.equal(buttons.length, 8);
  assert.deepEqual(buttons.map((button) => button.getAttribute("aria-label")), [
    "Enable Bash", "Enable Read", "Enable Write", "Enable Edit", "Enable Glob", "Enable Grep", "Enable Web fetch", "Enable Web search",
  ]);
  assert.ok(buttons.every((button) => button.getAttribute("data-state") === "checked"));

  const bashOff = switches(cardDom(agent({ disabledTools: ["BASH"] })));
  assert.equal(bashOff[0]?.getAttribute("data-state"), "unchecked");
  assert.ok(bashOff.slice(1).every((button) => button.getAttribute("data-state") === "checked"));
});

test("honesty tags name exactly what each concrete runner enforces", () => {
  const codex = cardDom(agent({ model: "gpt-5.6-sol:high", runnerPreference: "CODEX" }));
  assert.match(codex.window.document.body.textContent ?? "", /codex has no per-tool switch/);
  assert.equal((codex.window.document.body.textContent?.match(/not enforced on codex/gu) ?? []).length, 8);

  const pi = cardDom(agent({ model: "openai-codex\/gpt-5.6-luna:xhigh", runnerPreference: "PI" }));
  const tagged = switches(pi).filter((button) => button.parentElement?.textContent?.includes("not enforced on pi"));
  assert.deepEqual(tagged.map((button) => button.getAttribute("aria-label")), ["Enable Glob", "Enable Grep", "Enable Web fetch", "Enable Web search"]);
  assert.equal(pi.window.document.querySelector('[title*="pi-help.stdout:177-178"]')?.textContent, "Glob");

  const claude = cardDom(agent());
  assert.doesNotMatch(claude.window.document.body.textContent ?? "", /not enforced/);
});

test("Custom model preferences always resolve to a concrete honesty answer", () => {
  const cases: Array<[string, RunnerPreference, string]> = [
    ["my-model", "PI", "Resolves to pi."],
    ["some-codex-build", "INHERIT", "Resolves to codex (from the model name)."],
    ["my-model", "AUTO", "Resolves to claude (from the model name)."],
  ];
  for (const [model, runnerPreference, expected] of cases) {
    const copy = cardDom(agent({ model, runnerPreference })).window.document.body.textContent ?? "";
    assert.match(copy, new RegExp(expected.replace(/[().]/gu, "\\$&")));
    assert.doesNotMatch(copy, /Resolves to (?:inherit|auto|undefined)/iu);
  }
});

test("the web honesty map stays aligned with the two adapter maps", () => {
  // Hand-copied intentionally: this fails review visibly if either side changes.
  assert.deepEqual(ENFORCED_BY, {
    CLAUDE: ["BASH", "READ", "WRITE", "EDIT", "GLOB", "GREP", "WEB_FETCH", "WEB_SEARCH"],
    CODEX: [],
    PI: ["BASH", "READ", "WRITE", "EDIT"],
  });
  const source = readFileSync(new URL("../../../../packages/runner/src/adapters.ts", import.meta.url), "utf8");
  assert.match(source, /const TOOL_ORDER: ToolKey\[\] = \["BASH", "READ", "WRITE", "EDIT", "GLOB", "GREP", "WEB_FETCH", "WEB_SEARCH"\]/u);
  assert.match(source, /const PI_TOOL_NAMES:[\s\S]*?BASH: "bash", READ: "read", WRITE: "write", EDIT: "edit"/u);
});

test("BindingToggle keeps its switch in a flex wrapper to prevent the 3px baseline drift", () => {
  const markup = renderToStaticMarkup(<BindingToggle on label="binding" add={async () => undefined} remove={async () => undefined} onDone={() => undefined} />);
  assert.match(markup, /^<div class="[^"]*flex[^"]*items-center[^"]*">/u);
  assert.match(markup, /border-\[3px\]/u);
});

test("rapid tool toggles serialize union writes and ignore a stale poll in flight", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "http://localhost/agents/a" });
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement, HTMLFormElement: dom.window.HTMLFormElement,
    Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
  })) Object.defineProperty(globalThis, key, { configurable: true, value });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  const calls: RequestInit[] = [];
  const releases: Array<(response: Response) => void> = [];
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    return await new Promise<Response>((resolve) => releases.push(resolve));
  } });
  let saved = 0;
  const stale = agent();
  const state = (label: string): string | null => dom.window.document.querySelector(`[aria-label="${label}"]`)?.getAttribute("data-state") ?? null;
  try {
    await act(async () => root.render(<AgentToolsCard agent={stale} onSaved={() => { saved += 1; }} />));
    const click = async (label: string): Promise<void> => {
      const button = dom.window.document.querySelector(`[aria-label="${label}"]`);
      assert.ok(button);
      await act(async () => button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    };
    await click("Enable Bash");
    await click("Enable Web search");
    assert.equal(state("Enable Bash"), "unchecked");
    assert.equal(state("Enable Web search"), "unchecked");
    await act(async () => root.render(<AgentToolsCard agent={{ ...stale, disabledTools: [] }} onSaved={() => { saved += 1; }} />));
    assert.equal(state("Enable Bash"), "unchecked");
    assert.equal(state("Enable Web search"), "unchecked");
    assert.equal(calls.length, 1, "the second PATCH waits for the first");
    assert.deepEqual(JSON.parse(String(calls[0]?.body)), { disabledTools: ["BASH"] });

    await act(async () => {
      releases[0]?.(new Response(JSON.stringify(stale), { status: 200 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(JSON.parse(String(calls[1]?.body)), { disabledTools: ["BASH", "WEB_SEARCH"] });
    assert.equal(state("Enable Bash"), "unchecked");
    assert.equal(state("Enable Web search"), "unchecked");
    await act(async () => {
      releases[1]?.(new Response(JSON.stringify(stale), { status: 200 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(saved, 1);
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("all eight tools may be disabled without a validation barrier", () => {
  const dom = cardDom(agent({ disabledTools: [...TOOL_KEYS] }));
  assert.match(dom.window.document.body.textContent ?? "", /This agent will have no tools/);
  assert.ok(switches(dom).every((button) => button.getAttribute("data-state") === "unchecked"));
});
