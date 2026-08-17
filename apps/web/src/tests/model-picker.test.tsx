import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { ModelLabel, ModelPicker, modelForSave } from "../components/model-picker";
import { LocaleProvider } from "../lib/i18n";
import type { Agent } from "../lib/types";
import { AgentDetailPage, NewAgent } from "../pages/Agents";
import { NewGoal } from "../pages/Goals";

const installDom = (url = "http://localhost/agents/a"): { dom: JSDOM; container: Element } => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url });
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLSelectElement: dom.window.HTMLSelectElement, HTMLFormElement: dom.window.HTMLFormElement,
    Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
  })) Object.defineProperty(globalThis, key, { configurable: true, value });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  return { dom, container };
};

test("catalog models render a default effort without rewriting a bare stored value", () => {
  let changes = 0;
  const markup = renderToStaticMarkup(
    <ModelPicker model="claude-opus-5" runnerPreference="CLAUDE" onChange={() => { changes += 1; }} />,
  );
  assert.equal(changes, 0);
  assert.match(markup, /Claude Opus 5/);
  assert.match(markup, /<option value="high" selected="">high<\/option>/);
  assert.match(markup, /<select[^>]*disabled=""[^>]*>[\s\S]*?<option value="CLAUDE" selected="">Claude<\/option>/);
  assert.equal(modelForSave("claude-opus-5"), "claude-opus-5:high");
  assert.equal(modelForSave("private/model:turbo"), "private/model:turbo");
});

test("catalog selection retains a supported effort, falls back otherwise, and writes a concrete runner", async () => {
  const { dom, container } = installDom();
  const root = createRoot(container);
  const seen: Array<{ model: string; runnerPreference: string }> = [];
  try {
    await act(async () => root.render(
      <ModelPicker model="gpt-5.6-luna:max" runnerPreference="CODEX" onChange={(next) => seen.push(next)} />,
    ));
    const model = dom.window.document.querySelector("select");
    assert.ok(model);
    model.value = "gpt-5.6-sol";
    await act(async () => model.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
    assert.deepEqual(seen.pop(), { model: "gpt-5.6-sol:max", runnerPreference: "CODEX" });

    await act(async () => root.render(
      <ModelPicker model="gpt-5.6-luna:none" runnerPreference="CODEX" onChange={(next) => seen.push(next)} />,
    ));
    const nextModel = dom.window.document.querySelector("select");
    assert.ok(nextModel);
    nextModel.value = "claude-sonnet-5";
    await act(async () => nextModel.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
    assert.deepEqual(seen.pop(), { model: "claude-sonnet-5:high", runnerPreference: "CLAUDE" });

    await act(async () => root.render(
      <ModelPicker model="openai-codex/gpt-5.6-luna:xhigh" runnerPreference="PI" onChange={() => undefined} />,
    ));
    assert.match(dom.window.document.body.textContent ?? "", /GPT-5.6 Luna \(pi\)/);
    assert.match(renderToStaticMarkup(<ModelLabel model="openai-codex/gpt-5.6-luna:xhigh" />), /GPT-5.6 Luna \(pi\)[\s\S]*xhigh/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("Custom keeps exact model text and exposes all runner preferences", () => {
  const markup = renderToStaticMarkup(
    <ModelPicker model="private/provider:model:turbo" runnerPreference="AUTO" onChange={() => undefined} />,
  );
  assert.match(markup, /Custom…/);
  assert.match(markup, /value="private\/provider:model:turbo"/);
  for (const runner of ["INHERIT", "AUTO", "CLAUDE", "CODEX", "PI"]) assert.match(markup, new RegExp(`value="${runner}"`));
  assert.match(markup, /Custom models use the selected runner/);
});

test("Chinese custom-model and goal forms render translated runner preference labels", () => {
  const picker = renderToStaticMarkup(
    <LocaleProvider initialLocale="zh"><ModelPicker model="private/model" runnerPreference="AUTO" onChange={() => undefined} /></LocaleProvider>,
  );
  assert.match(picker, />继承<\/option>/u);
  assert.match(picker, />自动<\/option>/u);
  assert.doesNotMatch(picker, />inherit<\/option>|>auto<\/option>/iu);

  const goal = renderToStaticMarkup(
    <LocaleProvider initialLocale="zh"><NewGoal projectId="p" onClose={() => undefined} onCreated={() => undefined} /></LocaleProvider>,
  );
  assert.match(goal, /<option value="AUTO" selected="">自动<\/option>/u);
  assert.doesNotMatch(goal, />auto<\/option>/iu);
});

test("the real Create button blocks a contradictory model and runner pair", () => {
  const common = { projectId: "p", onClose: () => undefined, onCreated: () => undefined };
  const mismatch = renderToStaticMarkup(
    <NewAgent {...common} initial={{ name: "senior-dev", environmentId: "e", model: "gpt-5.6-luna:high", runnerPreference: "CLAUDE" }} />,
  );
  assert.match(mismatch, /<button[^>]*disabled=""[^>]*>[^<]*Create/);
  assert.match(mismatch, /requires CODEX, but this agent stores CLAUDE/);

  const valid = renderToStaticMarkup(
    <NewAgent {...common} initial={{ name: "senior-dev", environmentId: "e", model: "gpt-5.6-luna:high", runnerPreference: "CODEX" }} />,
  );
  assert.doesNotMatch(valid, /<button[^>]*disabled=""[^>]*>[^<]*Create/);
});

test("the real detail Save button blocks a stored contradiction until the picker repairs it", async () => {
  const { dom, container } = installDom();
  const root = createRoot(container);
  const agent: Agent = {
    id: "a", projectId: "p", environmentId: "e", name: "senior-dev", title: "Senior Developer",
    model: "gpt-5.6-luna:high", runnerPreference: "CLAUDE", inboxAccess: false, disabledTools: [],
    foundationalPrompt: "foundation", rolePrompt: "role", createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), archivedAt: null,
  };
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: string | URL | Request) => {
    const path = String(input);
    const body = path.endsWith("/agents/a") ? agent : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  } });
  try {
    await act(async () => {
      root.render(<AgentDetailPage agentId="a" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const edit = [...dom.window.document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Edit");
    assert.ok(edit);
    await act(async () => edit.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    const save = [...dom.window.document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save") as HTMLButtonElement | undefined;
    assert.ok(save);
    assert.equal(save.disabled, true);

    const model = dom.window.document.querySelector("select");
    assert.ok(model);
    model.value = "gpt-5.6-sol";
    await act(async () => model.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
    assert.equal(save.disabled, false);
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    await act(async () => root.unmount());
    dom.window.close();
  }
});
