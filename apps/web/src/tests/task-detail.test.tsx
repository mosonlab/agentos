import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

import { StepOutput, TaskPrompt, branchUrl, pullRequestLabel } from "../pages/TaskDetail";
import { partitionTaskPrompt } from "../lib/task-prompt";
import type { TaskStepOutput } from "../lib/types";

const source = readFileSync(fileURLToPath(new URL("../pages/TaskDetail.tsx", import.meta.url)), "utf8");

const output = (body: string): TaskStepOutput => ({
  id: "o1", taskId: "t1", runId: "r1", kind: "review", body,
  createdAt: "2026-08-16T00:00:00.000Z", updatedAt: "2026-08-16T00:00:00.000Z",
});

/* ------------------------------------------------------------ link builders */

test("the branch link is built for GitHub remotes only", () => {
  assert.equal(branchUrl("https://github.com/o/r.git", "feat/x"), "https://github.com/o/r/tree/feat/x");
  assert.equal(branchUrl("https://github.com/o/r", "feat/x"), "https://github.com/o/r/tree/feat/x");
  assert.equal(branchUrl("git@github.com:o/r.git", "feat/x"), "https://github.com/o/r/tree/feat/x");
  // Any other forge falls back to plain text rather than a link that 404s.
  assert.equal(branchUrl("https://gitlab.com/o/r.git", "feat/x"), null);
  assert.equal(branchUrl(null, "feat/x"), null);
  assert.equal(branchUrl("https://github.com/o/r", null), null);
});

test("the pull-request label is the number, falling back to the whole URL", () => {
  assert.equal(pullRequestLabel("https://github.com/o/r/pull/39"), "#39");
  assert.equal(pullRequestLabel("https://github.com/o/r/pull/39/"), "#39");
  assert.equal(pullRequestLabel("https://github.com/o/r/pull/39/files"), "https://github.com/o/r/pull/39/files");
  assert.equal(pullRequestLabel("https://example.com/mr/7"), "https://example.com/mr/7");
});

test("structured task prompts lead with responsibility and collapse the common contract", () => {
  const description = "Product Contract: TC-UX v1.0\nShared behavior\n\nStep responsibility: Implement dependency guards.";
  assert.deepEqual(partitionTaskPrompt(description), {
    responsibility: "Implement dependency guards.",
    productContract: "Product Contract: TC-UX v1.0\nShared behavior",
  });
  const markup = renderToStaticMarkup(<TaskPrompt description={description} />);
  assert.ok(markup.indexOf("Implement dependency guards") < markup.indexOf("Product Contract"));
  assert.match(markup, /<details>/);
  assert.doesNotMatch(markup, /<details open/);
  assert.match(markup, /foundational prompt.*role prompt.*tool manifest.*prior outputs/i);
  assert.match(markup, /Task prompt/);
});

test("unstructured task prompts remain the responsibility verbatim", () => {
  assert.deepEqual(partitionTaskPrompt("  Free-form responsibility  "), {
    responsibility: "Free-form responsibility",
    productContract: null,
  });
});

/* --------------------------------------------------------- step output card */

test("a whitespace-only step output renders the empty state and no body", () => {
  const markup = renderToStaticMarkup(<StepOutput output={output("   \n\t\n")} />);
  assert.match(markup, /No output recorded\./);
  assert.doesNotMatch(markup, /Show more/);
  // The card, the kind pill and the Updated line stay so the operator can still
  // see that the step reported at all.
  assert.match(markup, /Step output/);
  assert.match(markup, /review/);
  assert.match(markup, /Updated /);
});

test("a non-empty step output renders markdown, not the empty state", () => {
  const markup = renderToStaticMarkup(<StepOutput output={output("# Title\n\nSome **bold** prose.")} />);
  assert.doesNotMatch(markup, /No output recorded\./);
  assert.match(markup, /Title/);
  assert.match(markup, /<strong[^>]*>bold<\/strong>/);
});

test("a long step output clamps and offers Show more; a short one does neither", () => {
  const long = renderToStaticMarkup(<StepOutput output={output(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"))} />);
  assert.match(long, /max-h-\[420px\]/);
  assert.match(long, /Show more/);

  const short = renderToStaticMarkup(<StepOutput output={output("one line")} />);
  assert.doesNotMatch(short, /max-h-\[420px\]/);
  assert.doesNotMatch(short, /Show more/);
});

/* ------------------------------------------------------------ static guards */

test("the raw event table has left the task page", () => {
  for (const symbol of ["RunEvents", "EVENT_LOG", "EVENT_ROW"]) {
    assert.doesNotMatch(source, new RegExp(`\\b${symbol}\\b`), symbol);
  }
  // The link moved to a dictionary key in batch 1, so the guard follows it: the
  // point of the assertion is that the session is reachable from the run row.
  assert.match(source, /taskDetail\.run\.openSession/);
});

test("the runs table's head count, cell count and expanded colSpan agree", () => {
  const heads = source.slice(source.indexOf("<TableHeader>"), source.indexOf("</TableHeader>"));
  const headCount = (heads.match(/<TableHead[ />]/g) ?? []).length;

  const row = source.slice(source.indexOf("const RunRow"), source.indexOf("const Activity"));
  const body = row.slice(0, row.indexOf("{expanded ?"));
  const cellCount = (body.match(/<TableCell[ />]/g) ?? []).length;

  const colSpan = Number(/colSpan=\{(\d+)\}/.exec(source)?.[1]);
  assert.equal(headCount, cellCount, "a head with no cell silently shifts every column right of it");
  assert.equal(colSpan, headCount, "the expanded row must span the whole table");
});

test("every run's pull request is reachable, not just the newest one's", () => {
  // The task Details card sources its anchor from `runs[0]` alone, so without a
  // per-run entry a retry or a review run whose PR is not the newest is
  // reachable from nowhere in the product.
  const row = source.slice(source.indexOf("const RunRow"), source.indexOf("const Activity"));
  const expanded = row.slice(row.indexOf("{expanded ?"));
  assert.match(expanded, /k: t\("taskDetail\.run\.pullRequest"\)/);
  assert.match(expanded, /run\.pullRequestUrl/);
  // Distinct from Push, which is the status word and never a link.
  assert.match(expanded, /k: t\("taskDetail\.run\.push"\)/);
});
