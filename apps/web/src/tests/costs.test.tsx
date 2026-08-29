import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { installDom, reactDom } from "./dom-harness";

import {
  COSTS_COLUMNS, COSTS_RANGES, ChartLegend, DailySpendChart, ModelBar, SERIES_SLOTS, axisDates,
  chartSegments, chartSeries, modelShare, percent, seriesColor, wasteShare,
} from "../pages/Costs";
import type { CostsReport } from "../lib/types";

const bucket = (date: string, byAgent: Record<string, string>): CostsReport["daily"][number] => ({ date, byAgent });

const colorsFor = (order: readonly string[]) => {
  const assigned = new Map(order.map((agent, rank) => [agent, seriesColor(rank)]));
  return (agent: string): string => assigned.get(agent) ?? "var(--series-other)";
};

/* ---------------------------------------------------------- series identity */

test("series slots are assigned in fixed order and never cycled", () => {
  const slots = Array.from({ length: SERIES_SLOTS }, (_, rank) => seriesColor(rank));
  assert.deepEqual(slots, ["var(--series-1)", "var(--series-2)", "var(--series-3)",
    "var(--series-4)", "var(--series-5)", "var(--series-6)"]);
  assert.equal(seriesColor(SERIES_SLOTS), "hsl(104.7 64% 43%)");
  assert.notEqual(seriesColor(SERIES_SLOTS), seriesColor(SERIES_SLOTS + 40));
  assert.equal(new Set(slots).size, SERIES_SLOTS);
});

/* -------------------------------------------------------------- geometry */

test("segments stack from the baseline and only the top one is capped", () => {
  const daily = [bucket("2026-08-26", { Dev: "3", Reviewer: "1" })];
  const segments = chartSegments(daily, ["Dev", "Reviewer"], 4);
  assert.deepEqual(segments.map((segment) => segment.agent), ["Dev", "Reviewer"]);
  assert.deepEqual(segments.map((segment) => segment.capped), [false, true]);
  const [dev, reviewer] = segments;
  assert.ok(dev && reviewer);
  // Dev is three quarters of the day and sits under Reviewer's quarter.
  assert.ok(dev.y > reviewer.y);
  assert.ok(dev.height > reviewer.height * 2);
  assert.equal(dev.x, reviewer.x);
});

test("a full-height day reaches the top of the plot and rests on the baseline", () => {
  const [only] = chartSegments([bucket("2026-08-26", { Dev: "5" })], ["Dev"], 5);
  assert.ok(only);
  const bottom = only.y + only.height;
  assert.equal(only.y, 12);
  assert.equal(bottom, 216);
});

test("a sliver keeps its full height rather than being erased by the fill gap", () => {
  const daily = [bucket("2026-08-26", { Dev: "1000", Tiny: "0.4" })];
  const segments = chartSegments(daily, ["Dev", "Tiny"], 1000.4);
  const tiny = segments.find((segment) => segment.agent === "Tiny");
  assert.ok(tiny);
  assert.ok(tiny.height > 0, "a positive amount must still be drawn");
});

test("agents with nothing on a day contribute no segment", () => {
  const daily = [bucket("2026-08-26", { Dev: "2" }), bucket("2026-08-27", {})];
  const segments = chartSegments(daily, ["Dev", "Reviewer"], 2);
  assert.deepEqual(segments.map((segment) => segment.key), ["2026-08-26:Dev"]);
});

test("an empty window produces no geometry at all", () => {
  assert.deepEqual(chartSegments([bucket("2026-08-26", {})], ["Dev"], 0), []);
  assert.deepEqual(chartSegments([], ["Dev"], 5), []);
});

test("the date axis shows three labels however long the window is", () => {
  assert.deepEqual(axisDates(Array.from({ length: 90 }, (_, index) => bucket(`d${index}`, {}))), [0, 44, 89]);
  assert.deepEqual(axisDates(Array.from({ length: 7 }, (_, index) => bucket(`d${index}`, {}))), [0, 3, 6]);
  // Short windows must not repeat an index and render the same date twice.
  assert.deepEqual(axisDates([bucket("only", {})]), [0]);
  assert.deepEqual(axisDates([]), []);
});

/* ---------------------------------------------------------------- rendering */

test("the chart renders one fill per segment, each with a readable tooltip", () => {
  const daily = [bucket("2026-08-26", { Dev: "3", Reviewer: "1" })];
  const markup = renderToStaticMarkup(
    <DailySpendChart daily={daily} order={["Dev", "Reviewer"]} colors={colorsFor(["Dev", "Reviewer"])} />,
  );
  assert.equal(markup.match(/<path /g)?.length, 2);
  assert.ok(markup.includes('fill="var(--series-1)"'));
  assert.ok(markup.includes('fill="var(--series-2)"'));
  assert.ok(markup.includes("Dev · 2026-08-26 · $3.00"));
  assert.ok(markup.includes('role="img"'));
  // Ink stays on text tokens; only the fills carry series colour.
  assert.ok(markup.includes('fill="var(--faint)"'));
});

test("a window with no spend says so instead of drawing an empty box", () => {
  const markup = renderToStaticMarkup(
    <DailySpendChart daily={[bucket("2026-08-26", {})]} order={[]} colors={colorsFor([])} />,
  );
  assert.ok(!markup.includes("<svg"));
  assert.ok(markup.includes("Nothing was spent"));
});

test("the legend names every series, so identity is never colour alone", () => {
  const order = ["Dev", "Reviewer", "Integrator"];
  const markup = renderToStaticMarkup(<ChartLegend order={order} colors={colorsFor(order)} />);
  for (const agent of order) assert.ok(markup.includes(agent), agent);
  assert.equal(markup.match(/var\(--series-\d\)/g)?.length, 3);
});

/* ---------------------------------------------------------- all agents */

const agents = (count: number): CostsReport["byAgent"] =>
  Array.from({ length: count }, (_, index) => ({
    agent: `Agent ${index}`, usd: String(count - index), runs: 1, costUnavailableRuns: 0,
    avgUsd: String(count - index), cachePct: null, wastedUsd: "0",
  }));

test("six agents or fewer are each their own series", () => {
  const series = chartSeries(agents(SERIES_SLOTS));
  assert.equal(series.length, SERIES_SLOTS);
});

test("past six agents every agent remains an individual, distinguishable series", () => {
  const series = chartSeries(agents(19));
  assert.deepEqual(series, agents(19).map((entry) => entry.agent));
  assert.equal(new Set(series.map((_, rank) => seriesColor(rank))).size, 19);
});

test("a day with more than six agents retains every segment and its exact total", () => {
  const daily = [bucket("2026-08-26", {
    "Agent 0": "6", "Agent 1": "5", "Agent 2": "4", "Agent 3": "3",
    "Agent 4": "2", "Agent 5": "1", "Agent 6": "0.5", "Agent 7": "0.25",
  })];
  const series = chartSeries(agents(8));
  const segments = chartSegments(daily, series, 21.75);
  assert.deepEqual(segments.map((entry) => entry.agent), series);
  assert.equal(segments.reduce((total, entry) => total + entry.usd, 0), 21.75);
});

/* ---------------------------------------------------------------- the page */

const report = (overrides: Partial<CostsReport> = {}): CostsReport => ({
  days: 30,
  since: "2026-07-29T00:00:00.000Z",
  totalUsd: "2489.211742",
  estimatedUsd: "1321.851742",
  runCount: 688,
  costUnavailableRuns: 153,
  avgUsd: "4.653387",
  wastedUsd: "180",
  daily: [bucket("2026-08-26", { "Senior Developer": "600", Planner: "45.87" })],
  byAgent: [
    {
      agent: "Senior Developer", usd: "1800", runs: 400, costUnavailableRuns: 100, avgUsd: "6",
      cachePct: 72.5, wastedUsd: "180",
    },
    {
      agent: "Planner", usd: "689.211742", runs: 288, costUnavailableRuns: 53, avgUsd: "2.932816",
      cachePct: null, wastedUsd: "0",
    },
  ],
  byModel: [
    { model: "openai-codex/gpt-5.6-luna:max", usd: "1800", runs: 400, costUnavailableRuns: 100 },
    { model: "mixed", usd: "689.211742", runs: 288, costUnavailableRuns: 53 },
  ],
  topRuns: [{
    runId: "run-1", taskName: "Costs dashboard page: Implementation", agent: "Senior Developer",
    model: "openai-codex/gpt-5.6-sol", usd: "36.5", estimated: true, startedAt: "2026-08-26T09:00:00.000Z",
  }],
  ...overrides,
});

const settle = async (): Promise<void> => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
};

/** Mounts the page against a scripted control plane, reads it, and unmounts.
 *  The unmount is not tidiness: `usePoll` holds a `setInterval`, and a root left
 *  mounted keeps the test process alive forever. */
const readPage = async (body: CostsReport): Promise<{ text: string; html: string; requested: string[] }> => {
  const { container } = installDom("http://127.0.0.1:5173/costs");
  const [{ createRoot }, { CostsPage }, { ProjectProvider }] = await Promise.all([
    reactDom(), import("../pages/Costs"), import("../lib/project"),
  ]);
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input).replace(/^.*\/api/, "");
    requested.push(url);
    if (url === "/projects") {
      return new Response(JSON.stringify([{ id: "p1", name: "AgentOS Example", slug: "agentos" }]), { status: 200 });
    }
    if (url.startsWith("/projects/p1/costs")) return new Response(JSON.stringify(body), { status: 200 });
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  const root = createRoot(container);
  try {
    act(() => root.render(<ProjectProvider><CostsPage /></ProjectProvider>));
    // Two settles: the first resolves `/projects`, which is what gives the page
    // a project id to ask for costs with.
    await settle();
    await settle();
    return { text: container.textContent ?? "", html: container.innerHTML, requested };
  } finally {
    act(() => root.unmount());
  }
};

test("the page reads the default window in the browser timezone", async () => {
  const { requested } = await readPage(report());
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // The control plane refuses a costs request without a timezone, so the page
  // that omitted one would render an error rather than a window.
  assert.ok(
    requested.some((url) => url === `/projects/p1/costs?days=30&tz=${encodeURIComponent(timeZone)}`),
    requested.join(" "),
  );
});

test("one summary row carries the total, the runs, the average and the waste", async () => {
  const { text, html } = await readPage(report());
  assert.match(text, /Total spend/);
  assert.match(text, /\$2489\.21/);
  assert.match(text, /Runs/);
  assert.match(text, /688/);
  assert.match(text, /Avg per priced run/);
  assert.match(text, /\$4\.65/);
  assert.match(text, /Wasted spend/);
  assert.match(text, /\$180\.00/);
  // One row, not four tiles: the four figures share a single container.
  assert.equal(html.split("Total spend").length - 1, 1);
  assert.equal(html.match(/repeat\(auto-fit,minmax\(140px,1fr\)\)/g)?.length, 1);
});

test("the range control offers Today alongside the day windows", async () => {
  assert.deepEqual([...COSTS_RANGES], [1, 7, 30, 90]);
  const { text } = await readPage(report());
  assert.match(text, /Today/);
  assert.match(text, /7d/);
  assert.match(text, /90d/);
});

test("the dashboard is two columns that collapse to one at narrow widths", async () => {
  // The single-column default is the mobile state; the second column only
  // appears where both are still wide enough to read.
  assert.match(COSTS_COLUMNS, /^grid grid-cols-\[minmax\(0,1fr\)\]/);
  assert.match(COSTS_COLUMNS, /\[@media\(min-width:1100px\)\]:grid-cols-\[minmax\(0,1\.6fr\)_minmax\(0,1fr\)\]/);
  const { html } = await readPage(report());
  assert.ok(html.includes(COSTS_COLUMNS), "the page renders the two-column grid");
  // Chart above top runs on the left; by agent above by model on the right.
  const order = ["Daily spend", "Top runs", "By agent", "By model"];
  assert.deepEqual([...order].sort((left, right) => html.indexOf(left) - html.indexOf(right)), order);
});

test("the tiles never imply the total is complete when it is not", async () => {
  const { text } = await readPage(report());
  // Both caveats are on screen: what was priced by us, and what could not be
  // priced at all. Without them the tiles read as a full ledger.
  assert.match(text, /\$1321\.85 of this total is priced from token counts/);
  assert.match(text, /153 settled runs reported no cost/);
});

test("a window where every run reported a cost says so instead of staying silent", async () => {
  const { text } = await readPage(report({ costUnavailableRuns: 0, estimatedUsd: "0" }));
  assert.match(text, /Every settled run in this window reported a cost/);
  assert.ok(!/priced from token counts/.test(text));
});

test("both tables render, and an estimated run cost is labelled as one", async () => {
  const { text } = await readPage(report());
  assert.match(text, /By agent/);
  assert.match(text, /Senior Developer/);
  assert.match(text, /Top runs/);
  assert.match(text, /Costs dashboard page: Implementation/);
  assert.match(text, /\$36\.50 est\./);
});

test("an agent with no priced runs shows unavailable cost instead of zero spend", async () => {
  const { text } = await readPage(report({
    totalUsd: "0", estimatedUsd: "0", runCount: 3, costUnavailableRuns: 3, avgUsd: "0", wastedUsd: "0",
    daily: [], topRuns: [], byModel: [],
    byAgent: [{
      agent: "codex", usd: "0", runs: 3, costUnavailableRuns: 3, avgUsd: "0", cachePct: null, wastedUsd: "0",
    }],
  }));
  assert.match(text, /codex/);
  assert.match(text, /3 costs unavailable/);
  // Spend, average, cache and waste are all unknown here, and every one of them
  // says so rather than reporting a zero nobody measured.
  assert.match(text, /codex3 costs unavailable—3———/);
});

/* --------------------------------------------------------- cache and waste */

test("a percentage is one decimal, and a missing figure is an em dash", () => {
  assert.equal(percent(72.5), "72.5%");
  assert.equal(percent(0), "0.0%");
  assert.equal(percent(null), "—");
});

test("a share is taken from the wire amounts, and is null when there is no total", () => {
  assert.equal(modelShare("25", "200"), 12.5);
  assert.equal(modelShare("1", "0"), null);
  assert.equal(modelShare("0", "3"), 0);
});

test("waste is a share of the agent's own spend, and null when it has none", () => {
  assert.equal(wasteShare({
    agent: "dev", usd: "200", runs: 4, costUnavailableRuns: 0, avgUsd: "50",
    cachePct: null, wastedUsd: "50",
  }), 25);
  assert.equal(wasteShare({
    agent: "dev", usd: "0", runs: 2, costUnavailableRuns: 2, avgUsd: "0",
    cachePct: null, wastedUsd: "0",
  }), null);
});

test("the by-agent table states a cache rate and a waste rate per agent", async () => {
  const { text } = await readPage(report());
  assert.match(text, /Cache %/);
  assert.match(text, /Waste %/);
  // Senior Developer: 72.5% cached, $180 wasted of $1800 spent.
  assert.match(text, /72\.5%/);
  assert.match(text, /10\.0%/);
  // Planner reported no cache columns at all, and reports an em dash for it —
  // not the 0% that would claim it never hit a cache.
  assert.match(text, /Planner.*—/s);
  assert.ok(!/0\.0%\s*0\.0%/.test(text));
});

/* ------------------------------------------------------------------ by model */

test("the by-model card names every model verbatim, with its share of the total", async () => {
  const { text } = await readPage(report());
  assert.match(text, /By model/);
  // Provider prefix and effort suffix included: two efforts are two prices.
  assert.match(text, /openai-codex\/gpt-5\.6-luna:max/);
  // A run whose session used native children is a blend of two model rates and
  // is reported as such rather than filed under its root model.
  assert.match(text, /mixed/);
  assert.match(text, /72\.3%/);
  assert.match(text, /27\.7%/);
});

test("the model bar draws one segment per model and names it on hover", () => {
  const byModel: CostsReport["byModel"] = [
    { model: "claude-opus-5", usd: "75", runs: 3, costUnavailableRuns: 0 },
    { model: "mixed", usd: "25", runs: 1, costUnavailableRuns: 0 },
  ];
  const markup = renderToStaticMarkup(
    <ModelBar byModel={byModel} totalUsd="100" colors={colorsFor(["claude-opus-5", "mixed"])} />,
  );
  assert.equal(markup.match(/<span /g)?.length, 2);
  assert.ok(markup.includes("width:75%"));
  assert.ok(markup.includes("width:25%"));
  assert.ok(markup.includes("claude-opus-5 · $75.00 · 75.0%"));
  assert.ok(markup.includes('role="img"'));
});

test("a window with no priced spend draws no bar rather than an empty one", () => {
  const byModel: CostsReport["byModel"] = [{ model: "claude-opus-5", usd: "0", runs: 2, costUnavailableRuns: 2 }];
  assert.equal(renderToStaticMarkup(<ModelBar byModel={byModel} totalUsd="0" colors={colorsFor([])} />), "");
});
