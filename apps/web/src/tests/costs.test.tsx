import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { installDom, reactDom } from "./dom-harness";

import {
  ChartLegend, DailySpendChart, OTHER_SERIES, SERIES_SLOTS, axisDates, chartSegments, chartSeries,
  foldDaily, seriesColor,
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
  // The seventh agent folds into the neutral rather than reusing slot 1, which
  // would read as two agents being the same one.
  assert.equal(seriesColor(SERIES_SLOTS), "var(--series-other)");
  assert.equal(seriesColor(SERIES_SLOTS + 40), "var(--series-other)");
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
  // The single segment is the top of its column, so it gives up the gap; the
  // baseline it is measured from is where the stack ends, not where the fill does.
  assert.ok(only.y < 20, `top ${only.y}`);
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
  const markup = renderToStaticMarkup(<ChartLegend order={order} colors={colorsFor(order)} folded={0} />);
  for (const agent of order) assert.ok(markup.includes(agent), agent);
  assert.equal(markup.match(/var\(--series-\d\)/g)?.length, 3);
});

/* -------------------------------------------------------------------- fold */

const agents = (count: number): CostsReport["byAgent"] =>
  Array.from({ length: count }, (_, index) => ({
    agent: `Agent ${index}`, usd: String(count - index), runs: 1, avgUsd: String(count - index),
  }));

test("six agents or fewer are each their own series", () => {
  const series = chartSeries(agents(SERIES_SLOTS));
  assert.equal(series.length, SERIES_SLOTS);
  assert.ok(!series.includes(OTHER_SERIES));
});

test("past six agents the tail becomes one folded series, not repeated colours", () => {
  const series = chartSeries(agents(19));
  assert.equal(series.length, SERIES_SLOTS + 1);
  assert.equal(series.at(-1), OTHER_SERIES);
  // The named six are the six biggest spenders, in rank order.
  assert.deepEqual(series.slice(0, SERIES_SLOTS), agents(19).slice(0, SERIES_SLOTS).map((entry) => entry.agent));
  // Nothing beyond the fold reuses a numbered slot.
  assert.equal(new Set(series.map((_, rank) => seriesColor(rank))).size, SERIES_SLOTS + 1);
});

test("folding sums the tail into one amount per day rather than dropping it", () => {
  const daily = [bucket("2026-08-26", {
    "Agent 0": "6", "Agent 1": "5", "Agent 2": "4", "Agent 3": "3",
    "Agent 4": "2", "Agent 5": "1", "Agent 6": "0.5", "Agent 7": "0.25",
  })];
  const series = chartSeries(agents(8));
  const folded = foldDaily(daily, series);
  assert.equal(folded[0]?.byAgent[OTHER_SERIES], "0.75");
  assert.equal(folded[0]?.byAgent["Agent 0"], "6");
  assert.ok(!("Agent 6" in (folded[0]?.byAgent ?? {})));
  // The day's total survives the fold exactly.
  const sum = (entry: Record<string, string>): number =>
    Object.values(entry).reduce((total, usd) => total + Number(usd), 0);
  assert.equal(sum(folded[0]?.byAgent ?? {}), sum(daily[0]?.byAgent ?? {}));
});

test("an unfolded window is passed through untouched", () => {
  const daily = [bucket("2026-08-26", { Dev: "2" })];
  assert.equal(foldDaily(daily, ["Dev"]), daily);
});

test("the folded series is labelled with how many agents it stands for", () => {
  const order = [...agents(SERIES_SLOTS).map((entry) => entry.agent), OTHER_SERIES];
  const markup = renderToStaticMarkup(<ChartLegend order={order} colors={colorsFor(order)} folded={13} />);
  assert.ok(markup.includes("Other (13 agents)"));
  // The sentinel itself is never shown to a reader.
  assert.ok(!markup.includes(OTHER_SERIES));
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
  daily: [bucket("2026-08-26", { "Senior Developer": "600", Planner: "45.87" })],
  byAgent: [
    { agent: "Senior Developer", usd: "1800", runs: 400, avgUsd: "4.5" },
    { agent: "Planner", usd: "689.211742", runs: 288, avgUsd: "2.393096" },
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
const readPage = async (body: CostsReport): Promise<{ text: string; requested: string[] }> => {
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
    return { text: container.textContent ?? "", requested };
  } finally {
    act(() => root.unmount());
  }
};

test("the page reads the default window and shows the three tiles", async () => {
  const { text, requested } = await readPage(report());
  assert.ok(requested.some((url) => url === "/projects/p1/costs?days=30"), requested.join(" "));
  assert.match(text, /Total spend/);
  assert.match(text, /\$2489\.21/);
  assert.match(text, /Runs/);
  assert.match(text, /688/);
  assert.match(text, /Avg per run/);
  assert.match(text, /\$4\.65/);
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
