import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { InfoNotice } from "../components/ui";
import { BOARD, BOARD_GRID, BoardArrows, BoardColumn, FRAME, dragEdgeStep } from "../components/desktop-board";
import { MobileTaskList } from "../components/mobile-task-list";
import { TaskCard } from "../components/task-card";
import { COLUMNS, columnStep, countByStatus } from "../lib/board";
import { translate } from "../lib/i18n-core";
import { BOARD_PAGE, archiveDoneNotice, stableRows } from "../pages/Tasks";
import type { BoardTask, ChainProgress, TaskStatus } from "../lib/types";

const en = (key: string): string => translate("en", key);

const task = (overrides: Partial<BoardTask> = {}): BoardTask => ({
  id: "t1", name: "Ship the thing", status: "TODO", failureReason: null,
  scheduleKind: "NOW", runAt: null, cron: null, timezone: null,
  approvalGate: false, templateId: null, source: "MANUAL", chainId: null, chainIndex: null,
  updatedAt: "2026-08-16T00:00:00.000Z", assigneeAgent: null, chainProgress: null, latestRun: null,
  ...overrides,
});

const noop = (): void => undefined;
const ACTIONS = { onMove: noop, onRetry: noop, onArchive: noop, onDelete: noop, onCopyError: noop };

const card = (overrides: Partial<BoardTask> = {}): string => renderToStaticMarkup(
  <TaskCard task={task(overrides)} actions={ACTIONS} />,
);

const progress = (overrides: Partial<ChainProgress> = {}): ChainProgress => ({
  chainId: "c1", done: 3, total: 9, activeStepName: "Implementation", activeStatus: "doing",
  position: 4, ...overrides,
});

/** Renders one real column. Everything the board decides per column — the head,
 *  the count, `Archive All`, the drop invitation — is decided in here, so these
 *  assertions read markup rather than the page's source text. */
const column = (status: TaskStatus, tasks: BoardTask[] = [], loading = false): string => {
  const found = COLUMNS.find((candidate) => candidate.status === status);
  assert.ok(found, `no ${status} column`);
  return renderToStaticMarkup(
    <BoardColumn
      column={found} tasks={tasks} loading={loading} dragOver={null}
      onDragOver={noop} onDragLeave={noop} onDrop={noop} onArchiveDone={noop} actions={ACTIONS}
    />,
  );
};

const mobile = (tab: TaskStatus, tasks: BoardTask[] = [], all: BoardTask[] = tasks): string => renderToStaticMarkup(
  <MobileTaskList
    tab={tab} counts={countByStatus(all)} tasks={tasks} loading={false}
    onSelectTab={noop} onArchiveDone={noop} actions={ACTIONS} listRef={{ current: null }}
  />,
);

/* ------------------------------------------------------------- the columns */

test("the board has five columns, in order, with Backlog first", () => {
  assert.deepEqual(COLUMNS.map((c) => en(c.labelKey)), ["Backlog", "Todo", "Doing", "Review", "Done"]);
  assert.deepEqual(COLUMNS.map((c) => c.status), ["BACKLOG", "TODO", "DOING", "REVIEW", "DONE"]);
  // Each label reaches the DOM with its own count, so an added column cannot
  // pass by being present in the array and absent from the render.
  for (const { status, labelKey } of COLUMNS) {
    assert.match(column(status), new RegExp(`${en(labelKey)}<span[^>]*>0</span>`));
  }
});

test("a BACKLOG task lands in the first column and nowhere else", () => {
  const parked = task({ status: "BACKLOG", name: "Parked work" });
  assert.match(column("BACKLOG", [parked]), /Parked work/);
  assert.doesNotMatch(column("TODO", []), /Parked work/);
});

test("an empty column still invites a drop, Backlog included (E16)", () => {
  for (const { status } of COLUMNS) {
    assert.match(column(status), new RegExp(en("tasks.column.drop")));
  }
  assert.match(column("BACKLOG", [], true), new RegExp(en("common.loading")));
  assert.doesNotMatch(column("BACKLOG", [task({ status: "BACKLOG" })]), new RegExp(en("tasks.column.drop")));
});

test("Archive All is offered only on a non-empty Done column", () => {
  assert.match(column("DONE", [task({ status: "DONE" })]), new RegExp(en("tasks.archiveAll")));
  assert.doesNotMatch(column("DONE", []), new RegExp(en("tasks.archiveAll")));
  assert.doesNotMatch(column("TODO", [task()]), new RegExp(en("tasks.archiveAll")));
});

test("every column head is the same height, whatever it offers", () => {
  // Measured before this: Done's head was 40px against the other four's 31px,
  // because `Archive All` is a 28px button, so Done's label sat 4.5px low and
  // its first card started 9px below every other column's.
  const heights = COLUMNS.map(({ status }) => {
    const markup = column(status, status === "DONE" ? [task({ status: "DONE" })] : []);
    return /class="([^"]*h-\[\d+px\][^"]*)"/.exec(markup)?.[1]?.match(/h-\[\d+px\]/)?.[0];
  });
  assert.equal(new Set(heights).size, 1, `heads disagree: ${JSON.stringify(heights)}`);
  assert.equal(heights[0], "h-[36px]");
});

/* ---------------------------------------------------------------- the card */

test("a chain card carries the marker and a chain-less card carries no placeholder", () => {
  assert.match(card({ chainProgress: progress(), chainId: "c1", chainIndex: 4 }), /3\/9 · Implementation · doing/);
  assert.doesNotMatch(card(), /·/);
});

test("cron and webhook tasks are badged and manual ones are not", () => {
  assert.match(card({ source: "CRON" }), />cron</);
  assert.match(card({ source: "WEBHOOK" }), />webhook</);
  const manual = card({ source: "MANUAL" });
  assert.doesNotMatch(manual, />cron</);
  assert.doesNotMatch(manual, />webhook</);
});

test("the title is a real link to the task", () => {
  // 112 cards were unfocusable, had no role and no accessible name: a keyboard
  // could reach each card's menu button and nothing else.
  assert.match(card({ id: "abc" }), /<a[^>]*href="#\/tasks\/abc"/);
});

test("every free-text field on the card is bounded", () => {
  // One 2,228-character failureReason produced a 1,792px card, and a long path
  // in another overflowed its card sideways by 193px before the column clipped
  // it. Both need a clamp *and* a break rule: `word-break: normal` cannot break
  // a path at all.
  const markup = card({
    name: "A ".repeat(120),
    failureReason: `${"/very/long/path/segment".repeat(90)} failed`,
  });
  assert.equal((markup.match(/line-clamp-3/g) ?? []).length, 2, "title and failure both clamp");
  assert.match(markup, /overflow-wrap:anywhere/);
});

test("the card's meta column is declared, so a nowrap line cannot widen the card", () => {
  // A grid with no declared columns sizes its implicit one by `auto`, whose
  // minimum is the widest item's min-content. Measured in Chrome, that let
  // "At 09:00 AM, only on Monday (Asia/Shanghai)" push a 196px card to 312px
  // and the column clipped the overflow away.
  const markup = card({ scheduleKind: "CRON", cron: "0 9 * * 1", timezone: "Asia/Shanghai" });
  assert.match(markup, /grid-cols-\[minmax\(0,1fr\)\]/);
});

test("the schedule line wraps rather than losing its last two characters", () => {
  // In a 170px content box the ellipsis produced "Waiting for previous st…" and
  // "At 09:00 AM, only on M…". This line is the whole answer to what starts the
  // task, so it gets a second line instead of a truncation.
  const markup = card({ scheduleKind: "AT", chainId: "c1", chainIndex: 4, runAt: "2099-01-01T00:00:00.000Z" });
  assert.match(markup, /line-clamp-2[^"]*">Waiting for previous step</);
});

test("the failure text is carried in full even though only three lines show", () => {
  const reason = `${"x".repeat(2000)} END`;
  assert.match(card({ failureReason: reason }), /END/);
});

test("Copy error is offered only when there is an error to copy", () => {
  // Rendered statically, the menu content is not in the DOM — the entries are
  // asserted through the card's own menu builder instead.
  const withError = card({ failureReason: "boom" });
  const without = card();
  assert.equal(withError.includes("Actions for"), true);
  assert.equal(without.includes("Actions for"), true);
});

test("the assignee is one line with a keyboard-reachable way to see the rest", () => {
  // 59 of 112 cards truncated this name with no reveal at all: `title` is a
  // hover affordance, which is none on touch and none from the keyboard.
  const markup = card({ assigneeAgent: { id: "a1", title: "Implementation Plan Executioner" } });
  assert.match(markup, /<button[^>]*aria-expanded="false"[^>]*>Implementation Plan Executioner<\/button>/);
  assert.match(markup, /title="Implementation Plan Executioner"/);
});

test("a card with no assignee still says so", () => {
  assert.match(card(), /Unassigned/);
});

/* ---------------------------------------------------------- the board frame */

test("the board is one scroll surface, in both directions", () => {
  // Before this, five columns each owned an `overflow-y-auto` and the board took
  // only horizontal travel: a wheel over a column that did not overflow moved
  // nothing at all, and a horizontal trackpad gesture over the cards was
  // swallowed rather than passed to the board.
  assert.match(BOARD, /\boverflow-auto\b/);
  assert.doesNotMatch(BOARD, /overflow-y-hidden|overflow-x-auto\b/);
  assert.match(BOARD, /\bflex-1\b/);
  assert.match(BOARD, /\bmin-h-0\b/);
  // And no column may take one back.
  const markup = column("DONE", [task({ status: "DONE" })]);
  assert.doesNotMatch(markup, /overflow-y-auto|overflow-x-hidden|overscroll-contain/);
});

test("the column heads stay on screen by sticking inside the board", () => {
  // They used to sit outside a per-column scroller, which is what kept
  // `Archive All` reachable. With one shared scroller, `sticky` is what does it.
  const markup = column("DONE", [task({ status: "DONE" })]);
  assert.match(markup, /sticky/);
  assert.match(markup, /top-0/);
  const head = markup.indexOf("Archive All");
  const body = markup.indexOf("Drop tasks here");
  assert.ok(head >= 0, "Archive All is absent");
  assert.ok(body === -1 || body > head);
});

test("the desktop page owns the viewport and the phone gives it back", () => {
  assert.match(BOARD_PAGE, /\bh-\[100dvh\]/);
  assert.match(BOARD_PAGE, /\boverflow-hidden\b/);
  // ~22,000px of cards were unreachable at 800x800 because the narrow rules
  // removed the page's height without removing the board's clipping.
  assert.match(BOARD_PAGE, /max-width:900px\)\]:h-auto/);
  assert.match(BOARD_PAGE, /max-width:900px\)\]:overflow-visible/);
});

test("five columns fit at 1440px and are fixed-width below it", () => {
  // The old `minmax(250px,1fr)` set a 1,306px floor against a 1,172px content
  // box, so Done was cut off at every desktop width.
  assert.match(BOARD_GRID, /grid-cols-\[repeat\(5,250px\)\]/);
  assert.match(BOARD_GRID, /min-width:1440px\)\]:grid-cols-\[repeat\(5,minmax\(0,1fr\)\)\]/);
  assert.match(BOARD_PAGE, /\bmax-w-none\b/);
});

test("the frame the fades hang on is a flex parent, so the board still sizes itself", () => {
  // Measured in Chrome at 1440x900 when it was a bare block: `flex-1` on the
  // board resolved to `height: auto`, the board came out 15,755px tall inside a
  // 696px frame with no scrollbar of its own, and the page's `overflow-hidden`
  // clipped 97 Done cards away. A wrapper whose only job is to position two
  // fades must not be what decides the board's height.
  assert.match(FRAME, /\bflex\b/);
  assert.match(FRAME, /\bmin-h-0\b/);
  assert.match(BOARD, /\bflex-1\b/);
});

test("the arrows say which way they go, and an arrow at its end is disabled", () => {
  // Disabled rather than absent: an operator who has scrolled to Done needs to
  // be told the board ends there, not left pressing a control that does nothing.
  const start = renderToStaticMarkup(
    <BoardArrows edges={{ overflowing: true, atStart: true, atEnd: false }} onStep={() => undefined} />,
  );
  assert.match(start, /aria-label="Scroll one column left"[^>]*disabled/);
  assert.doesNotMatch(start, /aria-label="Scroll one column right"[^>]*disabled/);
  const end = renderToStaticMarkup(
    <BoardArrows edges={{ overflowing: true, atStart: false, atEnd: true }} onStep={() => undefined} />,
  );
  assert.match(end, /aria-label="Scroll one column right"[^>]*disabled/);
  assert.doesNotMatch(end, /aria-label="Scroll one column left"[^>]*disabled/);
  // Real buttons, so they are in the tab order and take Enter and Space for
  // free — the requirement is a keyboard-usable control, not a clickable div.
  assert.match(start, /<button/);
});

test("a press moves the board by exactly the column width the grid declares", () => {
  // `columnStep` is given the gap as a number; the grid declares it as a class.
  // If the two ever disagree the board drifts by 12px per press, and nothing
  // else in the system would notice.
  assert.match(BOARD_GRID, /\bgap-\[12px\]/);
  assert.equal(columnStep({ scrollWidth: 1298, clientWidth: 690 }, COLUMNS.length, 12), 262);
});

test("a drag scrolls the board only near its edges", () => {
  const box = { left: 248, right: 938 };
  assert.equal(dragEdgeStep(600, box), 0, "the middle of the board does not scroll");
  assert.ok(dragEdgeStep(260, box) < 0, "the left edge pulls the board left");
  assert.ok(dragEdgeStep(930, box) > 0, "the right edge pushes the board right");
  assert.equal(dragEdgeStep(box.left, box), dragEdgeStep(box.left + 1, box));
});

/* --------------------------------------------------------------- the phone */

test("the phone renders tabs and one list, never the five-column grid", () => {
  const markup = mobile("TODO", [task()], [task(), task({ id: "t2", status: "DONE" })]);
  assert.match(markup, /role="tablist"/);
  assert.equal((markup.match(/role="tab"/g) ?? []).length, 5);
  assert.match(markup, /role="tabpanel"/);
  assert.doesNotMatch(markup, /Drop tasks here/);
});

test("the phone's tabs carry each status's count, selected status included", () => {
  const rows = [task(), task({ id: "t2" }), task({ id: "t3", status: "DONE" })];
  const markup = mobile("TODO", rows.filter((row) => row.status === "TODO"), rows);
  assert.match(markup, /Todo<span[^>]*>2<\/span>/);
  assert.match(markup, /Done<span[^>]*>1<\/span>/);
  assert.match(markup, /Backlog<span[^>]*>0<\/span>/);
});

test("exactly one phone tab is selected and only it is tabbable", () => {
  const markup = mobile("DOING", []);
  assert.equal((markup.match(/aria-selected="true"/g) ?? []).length, 1);
  assert.equal((markup.match(/tabindex="0"/g) ?? []).length, 1);
});

test("the phone's cards are not draggable, and Archive All follows the Done tab", () => {
  // HTML5 drag does not fire on touch; the menu's `Move to` is the replacement.
  assert.doesNotMatch(mobile("TODO", [task()]), /draggable="true"/);
  assert.match(mobile("DONE", [task({ status: "DONE" })]), /Archive All/);
  assert.doesNotMatch(mobile("DONE", []), /Archive All/);
  assert.doesNotMatch(mobile("TODO", [task()]), /Archive All/);
});

/* --------------------------------------------------------- the render cost */

test("a re-fetched but unchanged row keeps its object identity", () => {
  const todo = task({ id: "a" });
  const done = task({ id: "b", status: "DONE" });
  const first = stableRows([todo, done], new Map());
  assert.deepEqual(first.rows, [todo, done]);

  const second = stableRows([{ ...todo }, { ...done }], first.held);
  assert.equal(second.rows[0], todo);
  assert.equal(second.rows[1], done);

  const moved: BoardTask = { ...done, status: "REVIEW" };
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
  const markup = renderToStaticMarkup(<InfoNotice message="Archived 6" onDismiss={() => undefined} />);
  assert.doesNotMatch(markup, /status-amber|destructive/);
  assert.match(markup, new RegExp(en("common.dismiss")));
});
