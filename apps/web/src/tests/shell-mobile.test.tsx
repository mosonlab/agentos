// Radix decides at import time whether portals may mount; see dom-preload.ts.
import "./dom-preload";

import assert from "node:assert/strict";
import test from "node:test";

import type { JSDOM } from "jsdom";
import { act } from "react";

import { LocaleProvider } from "../lib/i18n";
import { ProjectProvider } from "../lib/project";
import { storage } from "../lib/storage";
import { ThemeProvider } from "../lib/theme";
import { mountPage, type PageRoutes } from "./dom-harness";

const PROJECT = { id: "p-selected", name: "Selected project", slug: "selected-project" };

const routes = (): PageRoutes => ({
  "/projects": [PROJECT],
  "/projects/p-selected/agents": [],
  "/inbox/messages/summary?projectId=p-selected": { needsReply: 3 },
});

/**
 * The phone chrome only exists below 900px, and jsdom has no `matchMedia`, so
 * every other test renders the desktop sidebar. This one answers the query the
 * way a 390px phone would.
 */
const phone = (dom: JSDOM): void => {
  storage.set("agentos.projectId", PROJECT.id);
  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query === "(max-width: 900px)",
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
};

test("below 900px the shell renders a tab bar, the Inbox count, and a More sheet that reaches the runner, Settings and the theme", async () => {
  const [{ Shell }] = await Promise.all([import("../components/Shell")]);
  const page = await mountPage(
    <ThemeProvider><LocaleProvider initialLocale="en"><ProjectProvider><Shell><div /></Shell></ProjectProvider></LocaleProvider></ThemeProvider>,
    routes(),
    "http://127.0.0.1:5173/#/tasks",
    phone,
  );
  try {
    const { container } = page;
    assert.equal(container.querySelector("aside"), null, "the desktop sidebar must not render on a phone");
    const tabBar = container.querySelector('nav[aria-label="Primary navigation"]');
    assert.ok(tabBar, "phone tab bar missing");
    const tabs = [...tabBar.querySelectorAll("a, button")].map((element) => element.textContent?.trim());
    assert.deepEqual(tabs, ["Inbox3", "Tasks", "Sessions", "Costs", "More"]);
    assert.match(tabBar.querySelector('a[href="#/inbox"] [aria-label]')?.getAttribute("aria-label") ?? "", /3 unread/);

    // The runner row is on the top bar as a link to Settings, never a hover-only button.
    const topBarRunner = container.querySelector('header a[href="#/settings"]');
    assert.ok(topBarRunner, "top bar runner link missing");

    const more = tabBar.querySelector("button");
    assert.ok(more);
    await act(async () => { more.click(); });
    await page.settle();
    const sheet = document.querySelector('[data-slot="dialog-content"]');
    assert.ok(sheet, "More sheet did not open");
    const items = [...sheet.querySelectorAll("a, button")].map((element) => element.textContent?.trim()).filter((text) => text !== "" && text !== "Close");
    assert.deepEqual(items.slice(0, 6), ["Goals", "Agents", "Workflows", "Projects", "Connections", "Secrets"]);
    assert.ok(sheet.querySelector('a[href="#/settings"]'), "sheet runner link missing");
    assert.ok(items.includes("Settings"));
    assert.ok(items.some((text) => text?.startsWith("Theme:")));
  } finally {
    await page.dispose();
  }
});
