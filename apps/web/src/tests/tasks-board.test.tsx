import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { InfoNotice } from "../components/ui";
import {
  BOARD, BOARD_PAGE, BoardColumn, COLUMNS, TaskCard,
  archiveDoneNotice, dragEdgeStep, stableRows,
} from "../pages/Tasks";
import type { ChainProgress, Task, TaskStatus } from "../lib/types";

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
  chainId: "c1", done: 3, total: 9, activeStepName: "Implementation", activeStatus: "doing",
  position: 4, ...overrides,
});

const noop = (): void => undefined;
const CARD_PROPS = { onDelete: noop, onRetry: noop, onArchive: noop };

/** Renders one real column. Everything the board decides per column — the head,
 *  the count, `Archive All`, the drop invitation — is decided in here, so these
 *  assertions read markup rather than the page's source text. */
const column = (status: TaskStatus, tasks: Task[] = [], loading = false): string => {
  const found = COLUMNS.find((candidate) => candidate.status === status);
  assert.ok(found, `no ${status} column`);
  return renderToStaticMarkup(
    <BoardColumn
      column={found} tasks={tasks} loading={loading} dragOver={null}
      onDragOver={noop} onDragLeave={noop} onDrop={noop} onArchiveDone={noop} cardProps={CARD_PROPS}
    />,
  );
};

/* ------------------------------------------------------------- the columns */

test("the board has five columns, in order, with Backlog first", () => {
  assert.deepEqual(COLUMNS.map((c) => c.label), ["Backlog", "Todo", "Doing", "Review", "Done"]);
  assert.deepEqual(COLUMNS.map((c) => c.status), ["BACKLOG", "TODO", "DOING", "REVIEW", "DONE"]);
  // Each label reaches the DOM with its own count, so an added column cannot
  // pass by being present in the array and absent from the render.
  for (const { status, label } of COLUMNS) {
    assert.match(column(status), new RegExp(`${label}<span[^>]*>0</span>`));
  }
});

test("a BACKLOG task lands in the first column and nowhere else", () => {
  const parked = task({ status: "BACKLOG", name: "Parked work" });
  assert.match(column("BACKLOG", [parked]), /Parked work/);
  assert.doesNotMatch(column("TODO", []), /Parked work/);
});

test("an empty column still invites a drop, Backlog included (E16)", () => {
  // A positive assertion per column: the previous `doesNotMatch(/status !==
  // "BACKLOG"/)` could not fail, because it tested for a string nobody writes.
  for (const { status } of COLUMNS) {
    assert.match(column(status), /Drop tasks here/);
  }
  assert.match(column("BACKLOG", [], true), /Loading…/);
  assert.doesNotMatch(column("BACKLOG", [task({ status: "BACKLOG" })]), /Drop tasks here/);
});

test("Archive All is offered only on a non-empty Done column", () => {
  assert.match(column("DONE", [task({ status: "DONE" })]), /Archive All/);
  assert.doesNotMatch(column("DONE", []), /Archive All/);
  assert.doesNotMatch(column("TODO", [task()]), /Archive All/);
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

/* ---------------------------------------------------------- the board frame */

test("the board's height comes from the viewport, not from the card count", () => {
  // Measured before this: 85 Done cards grew the board to 20,926px and left its
  // horizontal scrollbar 19,600px below the fold — nominally scrollable, in
  // practice a permanently truncated fifth column.
  assert.match(BOARD_PAGE, /\bh-\[100dvh\]/);
  assert.match(BOARD_PAGE, /\boverflow-hidden\b/);
  // The board is the flex child that absorbs whatever the page head leaves, and
  // `min-h-0` is what lets it shrink below its content instead of growing.
  assert.match(BOARD, /\bflex-1\b/);
  assert.match(BOARD, /\bmin-h-0\b/);
  assert.match(BOARD, /\boverflow-x-auto\b/);
  // The board itself must never take vertical scroll: that is the columns' job,
  // and two vertical scrollers under one pointer is the scroll trap.
  assert.match(BOARD, /\boverflow-y-hidden\b/);
});

test("the column body is the only vertical scroller, and it does not trap", () => {
  const markup = column("DONE", [task({ status: "DONE" })]);
  assert.match(markup, /overflow-y-auto/);
  // No chaining to an ancestor when the column bottoms out...
  assert.match(markup, /overscroll-contain/);
  // ...and no claim on horizontal gestures, which belong to the board.
  assert.match(markup, /overflow-x-hidden/);
});

test("Archive All and the column count sit outside the scroller", () => {
  // Per-column scrolling would otherwise carry the head off-screen, and a board
  // whose Archive All you have to hunt for is the same defect in a new place.
  const markup = column("DONE", [task({ status: "DONE" })]);
  const head = markup.indexOf("Archive All");
  const scroller = markup.indexOf("overflow-y-auto");
  assert.ok(head >= 0, "Archive All is absent");
  assert.ok(scroller > head, "Archive All must render before the scrolling body, not inside it");
});

test("a drag scrolls the board only near its edges", () => {
  const box = { left: 248, right: 938 };
  assert.equal(dragEdgeStep(600, box), 0, "the middle of the board does not scroll");
  assert.ok(dragEdgeStep(260, box) < 0, "the left edge pulls the board left");
  assert.ok(dragEdgeStep(930, box) > 0, "the right edge pushes the board right");
  // Only ~2.5 of five columns fit at a 972px viewport, so without this a drag
  // from Todo can never reach Done: the pointer is busy holding the card.
  assert.equal(dragEdgeStep(box.left, box), dragEdgeStep(box.left + 1, box));
});

/* --------------------------------------------------------- the render cost */

test("a re-fetched but unchanged row keeps its object identity", () => {
  // The poll used to replace all 112 rows every 2.5s and re-render every card.
  // `TaskCard` is memoized, which is worth nothing unless the row it is handed
  // is the same object it was handed last time.
  const todo = task({ id: "a" });
  const done = task({ id: "b", status: "DONE" });
  const first = stableRows([todo, done], new Map());
  assert.deepEqual(first.rows, [todo, done]);

  // A fresh parse of the same bytes: structurally equal, referentially new.
  const second = stableRows([{ ...todo }, { ...done }], first.held);
  assert.equal(second.rows[0], todo);
  assert.equal(second.rows[1], done);

  // One row really moved: it — and only it — gets the new object.
  const moved: Task = { ...done, status: "REVIEW" };
  const third = stableRows([{ ...todo }, moved], second.held);
  assert.equal(third.rows[0], todo, "the untouched row must not be replaced");
  assert.equal(third.rows[1], moved);
  assert.notEqual(third.rows[1], done);
});

test("TaskCard is memoized", () => {
  assert.equal((TaskCard as unknown as { $$typeof: symbol }).$$typeof, Symbol.for("react.memo"));
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
