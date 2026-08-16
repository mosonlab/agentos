import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

import { InfoNotice } from "../components/ui";
import { TaskCard, archiveDoneNotice } from "../pages/Tasks";
import type { ChainProgress, Task } from "../lib/types";

const source = readFileSync(fileURLToPath(new URL("../pages/Tasks.tsx", import.meta.url)), "utf8");

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "t1", projectId: "p1", assigneeAgentId: null, repoId: null, templateId: null, templateStepId: null,
  followUpTaskId: null, name: "Ship the thing", description: "d", workingDirectory: null, targetBranch: null,
  failureReason: null, status: "TODO", assigneeType: "AGENT", approvalGate: false, scheduleKind: "NOW",
  runAt: null, cron: null, timezone: null,
  maxDurationMin: 120, stallTimeoutMin: 10, maxSessionsPerTask: 5,
  createdAt: "2026-08-16T00:00:00.000Z", updatedAt: "2026-08-16T00:00:00.000Z",
  assigneeAgent: null, repo: null, runs: [],
  chainId: null, chainIndex: null, source: "MANUAL", archivedAt: null,
  schedulePausedAt: null, recurringSourceTaskId: null, templateStep: null, chainProgress: null,
  recurringLastFiredAt: null, recurringFireCount: 0,
  ...overrides,
});

const card = (overrides: Partial<Task> = {}): string => renderToStaticMarkup(
  <TaskCard task={task(overrides)} onDelete={() => undefined} onRetry={() => undefined} onArchive={() => undefined} />,
);

const progress = (overrides: Partial<ChainProgress> = {}): ChainProgress => ({
  chainId: "c1", done: 3, total: 9, activeStepName: "Implementation", activeStatus: "doing", ...overrides,
});

/* ------------------------------------------------------------- the columns */

test("the board has five columns and Backlog comes first", () => {
  const columns = source.slice(source.indexOf("const COLUMNS"), source.indexOf("// The board card"));
  const labels = [...columns.matchAll(/label: "([A-Za-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(labels, ["Backlog", "Todo", "Doing", "Review", "Done"]);
  const statuses = [...columns.matchAll(/status: "([A-Z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(statuses, ["BACKLOG", "TODO", "DOING", "REVIEW", "DONE"]);
});

test("an empty column still invites a drop, Backlog included (E16)", () => {
  // The column body renders the same placeholder for every status; nothing in
  // the board special-cases Backlog out of the drop target.
  assert.match(source, /Drop tasks here/);
  assert.doesNotMatch(source, /status !== "BACKLOG"/);
});

test("Archive All is offered only on a non-empty Done column", () => {
  assert.match(source, /column\.status === "DONE" && columnTasks\.length > 0/);
});

/* ---------------------------------------------------------------- the card */

test("a chain card carries the marker and a chain-less card carries no placeholder", () => {
  assert.match(card({ chainProgress: progress() }), /3\/9 · Implementation · doing/);
  assert.doesNotMatch(card(), /·/);
});

test("cron and webhook tasks are badged and manual ones are not", () => {
  assert.match(card({ source: "CRON" }), />cron</);
  assert.match(card({ source: "WEBHOOK" }), />webhook</);
  const manual = card({ source: "MANUAL" });
  assert.doesNotMatch(manual, />cron</);
  assert.doesNotMatch(manual, />webhook</);
});

/* -------------------------------------------------------------- the notice */

test("the Archive All notice reports skips only when there were some", () => {
  assert.equal(archiveDoneNotice({ archived: 6, skipped: 1 }), "Archived 6, skipped 1 (running)");
  const clean = archiveDoneNotice({ archived: 6, skipped: 0 });
  assert.equal(clean, "Archived 6");
  assert.doesNotMatch(clean, /skipped/);
});

test("both notice shapes render through InfoNotice", () => {
  const withSkips = renderToStaticMarkup(<InfoNotice message={archiveDoneNotice({ archived: 6, skipped: 1 })} />);
  assert.match(withSkips, /Archived 6, skipped 1 \(running\)/);
  const withoutSkips = renderToStaticMarkup(<InfoNotice message={archiveDoneNotice({ archived: 6, skipped: 0 })} />);
  assert.match(withoutSkips, /Archived 6/);
  assert.doesNotMatch(withoutSkips, /skipped/);
});

test("InfoNotice borrows neither the amber nor the destructive palette", () => {
  // It is the app's only success surface; a neutral result must not read as a
  // warning.
  const markup = renderToStaticMarkup(<InfoNotice message="Archived 6" onDismiss={() => undefined} />);
  assert.doesNotMatch(markup, /status-amber|destructive/);
  assert.match(markup, /Dismiss/);
});
