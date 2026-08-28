import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";

import { App } from "../App";
import { LocaleProvider } from "../lib/i18n";
import { ThemeProvider } from "../lib/theme";
import { installDom, reactDom } from "./dom-harness";

/**
 * What the sidebar badge costs every page.
 *
 * The badge is one number, and it used to be a by-product of
 * `GET /inbox/messages` — the complete global message collection, measured at
 * 490 KB across 231 messages, polled every 5s from whichever page the operator
 * was on, with no validator on it. This file's property is that the badge is
 * still correct and no longer pays for the history: the Shell asks for the
 * summary, and the message collection is downloaded by the Inbox page or by
 * nobody.
 */
const mounted = async (routes: Record<string, string>): Promise<{ paths: string[]; markup: string }> => {
  const { dom, container } = installDom();
  const paths: string[] = [];
  const original = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string) => {
    const path = String(url);
    paths.push(path);
    const body = routes[path];
    return body === undefined
      ? new Response('{"error":"not found"}', { status: 404 })
      : new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  } });
  const root = (await reactDom()).createRoot(container);
  try {
    await act(async () => root.render(
      <ThemeProvider><LocaleProvider initialLocale="en"><App /></LocaleProvider></ThemeProvider>,
    ));
    // Twice: one tick resolves the bootstrap, the next lets the Shell that
    // mounted because of it run its own first poll.
    for (let round = 0; round < 2; round += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    return { paths, markup: dom.window.document.body.innerHTML };
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: original });
    await act(async () => root.unmount());
    dom.window.close();
  }
};

const PROJECTS = '[{"id":"p1","name":"Vibeville","slug":"vibeville"}]';

test("the badge reads its count from the summary route", async () => {
  const { paths, markup } = await mounted({
    "/api/projects": PROJECTS,
    "/api/inbox/messages/summary": '{"needsReply":3}',
  });
  assert.ok(paths.includes("/api/inbox/messages/summary"));
  assert.match(markup, /aria-label="3 unread[^"]*"/u);
});

test("a page that is not the Inbox never downloads the Inbox message collection", async () => {
  const { paths } = await mounted({
    "/api/projects": PROJECTS,
    "/api/inbox/messages/summary": '{"needsReply":0}',
  });
  assert.deepEqual(
    paths.filter((path) => path.startsWith("/api/inbox/messages") && path !== "/api/inbox/messages/summary"),
    [],
    "the badge must not pull the message history",
  );
});

test("nothing owed is no badge at all, not a zero", async () => {
  const { markup } = await mounted({
    "/api/projects": PROJECTS,
    "/api/inbox/messages/summary": '{"needsReply":0}',
  });
  assert.doesNotMatch(markup, /unread/u);
});

test("a failed summary poll is visible and never poses as a zero count", async () => {
  // The route answers 404 here. The shell remains usable, but a failed count
  // cannot silently claim that nobody is waiting.
  const { markup } = await mounted({ "/api/projects": PROJECTS });
  assert.match(markup, /Vibeville/u);
  assert.doesNotMatch(markup, /unread/u);
  assert.match(markup, /aria-label="Inbox count unavailable"/u);
});
