import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ROUTES } from "../App";
import { LocaleProvider } from "../lib/i18n";
import { CostsPage, costDateLabel, costNumber, DailyCostChart, type CostByAgent, type CostDaily } from "../pages/Costs";

const byAgent: CostByAgent[] = [
  { agent: "alpha", usd: "3.50", runs: 2, avgUsd: "1.75" },
  { agent: "beta", usd: 1, runs: 1, avgUsd: 1 },
];

const daily: CostDaily[] = [
  { date: "2026-08-24", byAgent: { alpha: "2.50", beta: 1 } },
  { date: "2026-08-25", byAgent: { alpha: "1.00" } },
];

test("the costs route resolves to the Costs page", () => {
  const route = ROUTES.find((candidate) => candidate.pattern === "/costs");
  assert.ok(route);
  assert.equal((route.render({}) as { type: unknown }).type, CostsPage);
});

test("the daily chart stacks agent segments and exposes an accessible title", () => {
  const markup = renderToStaticMarkup(
    <LocaleProvider initialLocale="en"><DailyCostChart daily={daily} byAgent={byAgent} /></LocaleProvider>,
  );
  assert.match(markup, /<svg[^>]+role="img"/u);
  assert.match(markup, /Daily spend by agent/u);
  assert.equal((markup.match(/data-agent="alpha"/gu) ?? []).length, 2);
  assert.equal((markup.match(/data-agent="beta"/gu) ?? []).length, 1);
  assert.match(markup, /Aug 24/u);
  assert.match(markup, /Aug 25/u);
});

test("cost helpers preserve valid amounts and avoid invalid chart geometry", () => {
  assert.equal(costNumber("0.0012"), 0.0012);
  assert.equal(costNumber("not-a-number"), 0);
  assert.equal(costDateLabel("2026-08-24", "en"), "Aug 24");
});

