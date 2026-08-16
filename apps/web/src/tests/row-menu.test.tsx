import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";

test("selecting a portaled RowMenu item does not click its row", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    PointerEvent: dom.window.MouseEvent,
    DOMRect: dom.window.DOMRect,
  };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const { RowMenu } = await import("../components/ui");

  let rowClicks = 0;
  let selected = 0;
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<div onClick={() => { rowClicks += 1; }}><RowMenu items={[{ label: "Delete", onSelect: () => { selected += 1; } }]} /></div>);
  });

  const trigger = dom.window.document.querySelector<HTMLButtonElement>("button[aria-label='More actions']");
  assert.ok(trigger);
  await act(async () => {
    trigger.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  });
  assert.equal(rowClicks, 0);

  const item = dom.window.document.querySelector<HTMLElement>("[role='menuitem']");
  assert.ok(item, dom.window.document.body.innerHTML);
  await act(async () => item.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0 })));
  assert.equal(selected, 1);
  assert.equal(rowClicks, 0);

  await act(async () => root.unmount());
  dom.window.close();
});
