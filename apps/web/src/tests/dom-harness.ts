import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/**
 * A jsdom the React DOM client believes in, and the client loaded against it.
 *
 * The order matters more than the contents. React DOM feature-detects the
 * `input` event once, when its module first loads, and when it decides it is not
 * running in a browser it falls back to a keyboard-and-selection polyfill. A
 * test file that imports `react-dom/client` at the top has already spent that
 * detection on an empty global scope, and every `input` event it dispatches
 * afterwards is dropped: the DOM node's value changes and the controlled
 * component's state does not, which reads exactly like a broken page. So the
 * globals go up first and `reactDom()` loads the client afterwards.
 */
export const installDom = (url = "http://127.0.0.1:5173/"): { dom: JSDOM; container: Element } => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url });
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLFormElement: dom.window.HTMLFormElement, HTMLInputElement: dom.window.HTMLInputElement,
    Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
    // React compares dispatched events against the *global* constructors, so a
    // window whose Event/InputEvent/MouseEvent are not the global ones has its
    // events silently ignored by the reconciler.
    Event: dom.window.Event, InputEvent: dom.window.InputEvent, MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  // jsdom has no scroll box, and `navigate` scrolls to the top of every new
  // route. Without this the router's ordinary behaviour prints a jsdom
  // not-implemented error over the test output.
  Object.defineProperty(dom.window, "scrollTo", { configurable: true, value: () => undefined });
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  return { dom, container };
};

let client: Promise<typeof import("react-dom/client")> | null = null;

/** The React DOM client, loaded no earlier than the first `installDom`. */
export const reactDom = async (): Promise<typeof import("react-dom/client")> => {
  assert.ok(globalThis.document !== undefined, "installDom() runs before reactDom()");
  client ??= import("react-dom/client");
  return await client;
};
