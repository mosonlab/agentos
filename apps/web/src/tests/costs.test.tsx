import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ChartLegend, DailySpendChart, SERIES_SLOTS, axisDates, chartSegments, seriesColor,
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
  const markup = renderToStaticMarkup(<ChartLegend order={order} colors={colorsFor(order)} />);
  for (const agent of order) assert.ok(markup.includes(agent), agent);
  assert.equal(markup.match(/var\(--series-\d\)/g)?.length, 3);
});
