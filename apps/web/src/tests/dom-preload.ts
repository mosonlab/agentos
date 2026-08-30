import { JSDOM } from "jsdom";

/**
 * Browser globals seeded at load, before any component module is imported.
 *
 * Radix decides once — when its module first loads — whether to use
 * `useLayoutEffect` or nothing at all, and a portal whose layout effect never
 * runs mounts no DOM. So a test file that imports a page carrying a `Modal`
 * while `globalThis.document` is still undefined gets a dialog that renders
 * nothing, in a harness that otherwise works. Import this module *first* to
 * make portaled content observable in jsdom exactly as it is in a browser.
 *
 * The seeded window is closed immediately: the decision it exists to influence
 * has already been made by the time a test runs, and `mountPage` installs and
 * restores its own globals around every render.
 */
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const [key, value] of Object.entries({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, NodeFilter: dom.window.NodeFilter,
  PointerEvent: dom.window.MouseEvent, DOMRect: dom.window.DOMRect,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
})) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
dom.window.close();
