import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";

import { RunLine } from "../components/run-line";
import { LocaleProvider } from "../lib/i18n";
import type { BoardLatestRun } from "../lib/types";

const run = (overrides: Partial<BoardLatestRun> = {}): BoardLatestRun => ({
  id: "run-1", runNumber: 7, status: "RUNNING", model: "claude-opus-5:high", codexServiceTier: "DEFAULT",
  costUsd: null, startedAt: new Date(Date.now() - 23 * 60_000).toISOString(), endedAt: null, ...overrides,
});

const parse = (markup: string): Element => {
  const body = new JSDOM(`<!doctype html><html><body>${markup}</body></html>`).window.document.body;
  const line = body.querySelector("[data-run-line]");
  assert.ok(line, "the run line renders");
  return line;
};

const visibleText = (node: Element): string => (node.textContent ?? "").replace(/\s+/gu, " ").trim();

test("the aggregate run line renders its full details without an ellipsis or a nowrap ancestor", () => {
  const line = parse(renderToStaticMarkup(
    <LocaleProvider initialLocale="en">
      <RunLine run={run({ model: "claude-opus-5-with-a-very-long-identifier:high" })} showElapsed showModel />
    </LocaleProvider>,
  ));

  // The status and the elapsed time sit at the end of the string: truncation
  // used to drop exactly these two live values. The elapsed clock is live, so
  // the seconds are matched rather than pinned.
  assert.match(
    visibleText(line),
    /^run 7 · claude-opus-5-with-a-very-long-identifier · high · running 2[23]m \d+s$/u,
  );

  const details = line.querySelector("[data-run-line-details]");
  assert.ok(details, "the details span renders");
  assert.doesNotMatch(details.className, /text-ellipsis|overflow-hidden/u);
  assert.match(details.className, /\[overflow-wrap:anywhere\]/u);
  for (let node: Element | null = details; node !== null; node = node.parentElement) {
    assert.doesNotMatch(node.className, /whitespace-nowrap/u, `no nowrap ancestor: ${node.className}`);
    if (node === line) break;
  }

  // The dot and `run N` stay together as the row's leading token.
  const leading = line.firstElementChild;
  assert.ok(leading);
  assert.match(leading.className, /whitespace-nowrap/u);
  assert.equal(visibleText(leading), "run 7");
  assert.equal(leading.firstElementChild?.textContent, "");
});

test("a task-card run line keeps its text and gains no ellipsis", () => {
  const line = parse(renderToStaticMarkup(
    <LocaleProvider initialLocale="en"><RunLine run={run({ status: "SUCCEEDED" })} /></LocaleProvider>,
  ));
  assert.equal(visibleText(line), "run 7 · succeeded");
  assert.doesNotMatch(line.innerHTML, /text-ellipsis/u);
});

test("the zh run line wraps under the same rules", () => {
  const line = parse(renderToStaticMarkup(
    <LocaleProvider initialLocale="zh"><RunLine run={run()} showElapsed showModel /></LocaleProvider>,
  ));
  assert.match(visibleText(line), /claude-opus-5 · high/u);
  const details = line.querySelector("[data-run-line-details]");
  assert.ok(details);
  assert.doesNotMatch(details.className, /text-ellipsis|overflow-hidden/u);
});
