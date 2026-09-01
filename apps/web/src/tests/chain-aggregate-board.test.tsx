import assert from "node:assert/strict";
import test from "node:test";
import { act, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ChainAggregateCard } from "../components/chain-aggregate-card";
import { BoardColumn } from "../components/desktop-board";
import { MobileTaskList } from "../components/mobile-task-list";
import { COLUMNS, type BoardEntry, boardEntries, boardEntriesByStatus, countByStatus } from "../lib/board";
import { LocaleProvider } from "../lib/i18n";
import { translate } from "../lib/i18n-core";
import type { BoardTask, ChainAggregate, TaskStatus } from "../lib/types";
import { useTaskStartConfirmation } from "../pages/Tasks";
import { installDom, mountPage, reactDom } from "./dom-harness";

const task = (overrides: Partial<BoardTask> = {}): BoardTask => ({
  id: "task-1", name: "Release: Build", displayName: "Build", status: "TODO", moveTargets: [], failureReason: null,
  assigneeType: "AGENT", createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T01:00:00.000Z",
  scheduleKind: "NOW", runAt: null, cron: null, timezone: null, approvalGate: false, templateId: null,
  source: "MANUAL", chainId: null, chainIndex: null, chainName: null, assigneeAgent: null,
  chainProgress: null, latestRun: null, taskCost: null, blockedOn: null, mergeOutcome: null,
  repairOf: null, chainAggregate: null, ...overrides,
});

const aggregate = (overrides: Partial<ChainAggregate> = {}): ChainAggregate => ({
  chainId: "chain-1", chainName: "Release", stepCount: 12,
  detailTaskId: "step-3",
  statusCounts: { BACKLOG: 0, TODO: 10, DOING: 0, REVIEW: 0, DONE: 2 }, status: "TODO",
  frontier: { taskId: "step-3", title: "Implement release", status: "TODO", latestRun: null, mergeOutcome: null, failureReason: null, position: 3 },
  activeRepair: null,
  activation: { state: "running", predecessor: null, taskId: "step-1" }, totalCost: null,
  createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T01:00:00.000Z", ...overrides,
});

type RunWithTier = NonNullable<BoardTask["latestRun"]> & { codexServiceTier: "DEFAULT" | "FAST" };
type AggregateWithRepair = ChainAggregate & {
  activeRepair: { repairKind: string; latestRun: RunWithTier };
};

const runWithTier = (overrides: Partial<RunWithTier> = {}): RunWithTier => ({
  id: "run-1", runNumber: 1, status: "SUCCEEDED", model: "gpt-5.6-sol:high", codexServiceTier: "DEFAULT",
  costUsd: null, startedAt: null, endedAt: null, ...overrides,
});

const activeRepairAggregate = (overrides: Partial<ChainAggregate> = {}): AggregateWithRepair => ({
  ...aggregate(overrides),
  activeRepair: {
    repairKind: "gate-fix",
    latestRun: runWithTier({ id: "repair-run", runNumber: 3, status: "RUNNING", codexServiceTier: "FAST", startedAt: new Date(Date.now() - 4 * 60_000).toISOString() }),
  },
});

const visibleText = (markup: string): string => markup.replace(/<[^>]*>/gu, "").replace(/\s+/gu, " ");

const chainStep = (id: string, position: number, status: TaskStatus, projection: ChainAggregate, overrides: Partial<BoardTask> = {}): BoardTask => task({
  id, name: `Release: ${id}`, displayName: id, chainId: projection.chainId, chainIndex: position - 1, chainName: projection.chainName,
  status, chainAggregate: projection, chainProgress: {
    chainId: projection.chainId, done: projection.statusCounts.DONE, total: projection.stepCount,
    activeStepName: projection.frontier.title, activeStatus: projection.frontier.status,
    currentLayer: position, layerCount: projection.stepCount, position,
  }, ...overrides,
});

const noop = (): void => undefined;
const actions = { onMove: noop, onRetry: noop, onArchive: noop, onDelete: noop, onCopyError: noop, onFilterChain: noop };
const column = (status: TaskStatus, entries: readonly BoardEntry[] = []): string => {
  const definition = COLUMNS.find((candidate) => candidate.status === status)!;
  return renderToStaticMarkup(<BoardColumn column={definition} tasks={entries} loading={false} dragOver={null} onDragOver={noop} onDragLeave={noop} onDrop={noop} onArchiveDone={noop} onActivateAll={noop} actions={actions} />);
};

test("one aggregate entry owns chain steps and a detached repair, while standalone tasks remain cards", () => {
  const projection = aggregate();
  const rows = [
    chainStep("step-1", 1, "DONE", projection),
    chainStep("step-3", 3, "TODO", projection),
    task({ id: "repair", displayName: "Merge-tail repair", status: "DOING", repairOf: { chainId: "chain-1", chainName: "Release", repairKind: "gate-fix" } }),
    task({ id: "standalone", displayName: "Standalone" }),
  ];
  const entries = boardEntries(rows);
  assert.deepEqual(entries.map((entry) => entry.kind), ["chain", "task"]);
  assert.equal(entries[0]?.kind === "chain" ? entries[0].members.length : 0, 3);
  assert.equal(entries[0]?.kind === "chain" ? entries[0].representativeTaskId : "", "step-3");
  assert.equal(entries[1]?.kind === "task" ? entries[1].task.id : "", "standalone");
});

test("clicking an aggregate card opens the frontier Step, not the first one", async () => {
  // The API sets `detailTaskId` to the frontier; the board carries it through as
  // the representative, so the operator lands on the Step that is actually
  // moving instead of walking the chain list down from Step 1.
  const projection = aggregate();
  const entries = boardEntries([
    chainStep("step-1", 1, "DONE", projection),
    chainStep("step-2", 2, "DONE", projection),
    chainStep("step-3", 3, "TODO", projection),
  ]);
  const entry = entries[0];
  assert.ok(entry?.kind === "chain");
  assert.equal(entry.representativeTaskId, projection.frontier.taskId);

  const { dom, container } = installDom();
  Object.defineProperty(dom.window, "getSelection", { configurable: true, value: () => ({ toString: () => "" }) });
  const root = (await reactDom()).createRoot(container);
  try {
    dom.window.location.hash = "#/tasks/origin";
    await act(async () => root.render(
      <ChainAggregateCard aggregate={entry.aggregate} members={entry.members} representativeTaskId={entry.representativeTaskId} />,
    ));
    const card = container.querySelector("[data-chain-card]");
    assert.ok(card);
    await act(async () => card.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(dom.window.location.hash, "#/tasks/step-3");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("aggregate placement follows API-derived frontier status and counts entries, not raw steps", () => {
  for (const [status, expectedColumn] of [
    ["TODO", "TODO"], ["DOING", "DOING"], ["REVIEW", "REVIEW"], ["DONE", "DONE"],
  ] as const) {
    const projection = aggregate({
      status,
      statusCounts: { BACKLOG: 0, TODO: status === "TODO" ? 12 : 0, DOING: status === "DOING" ? 1 : 0, REVIEW: status === "REVIEW" ? 1 : 0, DONE: status === "DONE" ? 12 : 0 },
      frontier: { taskId: "frontier", title: "Frontier", status, latestRun: null, mergeOutcome: null, failureReason: null, position: 3 },
    });
    const rows = Array.from({ length: 12 }, (_, index) => chainStep(`step-${index}`, index + 1, status === "DONE" ? "DONE" : index === 2 ? status : "TODO", projection));
    const grouped = boardEntriesByStatus(boardEntries(rows));
    assert.equal(grouped.get(expectedColumn)?.length, 1, status);
    assert.equal(countByStatus(boardEntries(rows))[expectedColumn], 1, status);
  }
});

test("aggregate card exposes progress, frontier, activation/lock state, and no drag or Move To", () => {
  const parked = aggregate({ activation: { state: "parked-unactivated", predecessor: null, taskId: "step-1" } });
  const parkedMarkup = renderToStaticMarkup(<ChainAggregateCard aggregate={parked} />);
  assert.match(parkedMarkup, /Step 3\/12/);
  assert.match(parkedMarkup, /Implement release/);
  assert.match(parkedMarkup, />Activate<\/button>/);
  assert.doesNotMatch(parkedMarkup, /draggable/);
  assert.doesNotMatch(parkedMarkup, /Move to/);

  const waitingMarkup = renderToStaticMarkup(<ChainAggregateCard aggregate={aggregate({ activation: { state: "waiting-on-predecessor", predecessor: { taskId: "previous", taskName: "Prepare release" }, taskId: "step-1" } })} />);
  assert.match(waitingMarkup, /Prepare release/);
  assert.match(waitingMarkup, /Locked by/);
  assert.doesNotMatch(waitingMarkup, />Activate<\/button>/);
});

test("aggregate card renders an active repair line and omits it when no repair is active", () => {
  const activeMarkup = renderToStaticMarkup(<ChainAggregateCard aggregate={activeRepairAggregate()} />);
  const activeText = visibleText(activeMarkup);
  assert.match(activeMarkup, /data-chain-repair=""/u);
  assert.match(activeText, /gate-fix · .*run 3 · gpt-5\.6-sol · high · fast · running \d+m/u);

  const settledMarkup = renderToStaticMarkup(<ChainAggregateCard aggregate={aggregate()} />);
  assert.doesNotMatch(settledMarkup, /data-chain-repair=/u);
});

test("aggregate run lines split model effort, mark FAST only, and avoid duplicate localized running status", () => {
  const finished = aggregate({
    frontier: {
      taskId: "step-3", title: "Implement release", status: "DONE", latestRun: runWithTier(),
      mergeOutcome: null, failureReason: null, position: 3,
    },
  });
  const finishedText = visibleText(renderToStaticMarkup(<ChainAggregateCard aggregate={finished} />));
  assert.match(finishedText, /run 1 · gpt-5\.6-sol · high · succeeded/u);
  assert.doesNotMatch(finishedText, /fast/u);

  const active = activeRepairAggregate();
  const englishText = visibleText(renderToStaticMarkup(<ChainAggregateCard aggregate={active} />));
  assert.equal((englishText.match(/running/gu) ?? []).length, 1, englishText);

  const chineseText = visibleText(renderToStaticMarkup(
    <LocaleProvider initialLocale="zh"><ChainAggregateCard aggregate={active} /></LocaleProvider>,
  ));
  assert.equal((chineseText.match(/运行中/gu) ?? []).length, 1, chineseText);
  assert.match(chineseText, /第 3 次运行 · gpt-5\.6-sol · high · fast · 已运行 \d+ 分/u);
});

test("active elapsed preserves non-running statuses and merge-outcome badges", () => {
  const waiting = {
    ...activeRepairAggregate(),
    activeRepair: {
      repairKind: "review-fix",
      latestRun: runWithTier({ status: "WAITING_INBOX", startedAt: new Date(Date.now() - 4 * 60_000).toISOString() }),
    },
  };
  const waitingText = visibleText(renderToStaticMarkup(
    <LocaleProvider initialLocale="en"><ChainAggregateCard aggregate={waiting} /></LocaleProvider>,
  ));
  assert.match(waitingText, /review-fix · .*waiting inbox · running \d+m/u);

  const stopped = aggregate({
    status: "DOING",
    frontier: {
      taskId: "step-3", title: "Merge", status: "DOING",
      latestRun: runWithTier({ status: "RUNNING", startedAt: new Date(Date.now() - 4 * 60_000).toISOString() }),
      mergeOutcome: { outcome: "stopped", condition: "head-drift", incident: false },
      failureReason: null, position: 3,
    },
  });
  const stoppedText = visibleText(renderToStaticMarkup(
    <LocaleProvider initialLocale="en"><ChainAggregateCard aggregate={stopped} /></LocaleProvider>,
  ));
  assert.match(stoppedText, /Stopped · running \d+m/u);
});

test("the shared card shell does not navigate a Chain card while text is selected", async () => {
  const { dom, container } = installDom();
  let selection = "Release";
  Object.defineProperty(dom.window, "getSelection", {
    configurable: true,
    value: () => ({ toString: () => selection }),
  });
  const root = (await reactDom()).createRoot(container);
  try {
    dom.window.location.hash = "#/tasks/origin";
    await act(async () => root.render(<ChainAggregateCard aggregate={aggregate()} />));
    const progress = container.querySelector("[data-chain-progress]");
    assert.ok(progress);
    await act(async () => progress.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(dom.window.location.hash, "#/tasks/origin");

    selection = "";
    await act(async () => progress.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(dom.window.location.hash, "#/tasks/step-3");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("mobile and desktop receive the same aggregate entry list", () => {
  const projection = aggregate({ status: "DOING", frontier: { taskId: "step-1", title: "Implement release", status: "DOING", latestRun: null, mergeOutcome: null, failureReason: null, position: 1 } });
  const entries = boardEntries([chainStep("step-1", 1, "DOING", projection), chainStep("step-2", 2, "TODO", projection)]);
  assert.equal(entries.length, 1);
  const grouped = boardEntriesByStatus(entries);
  const desktop = column("DOING", grouped.get("DOING"));
  const mobile = renderToStaticMarkup(<MobileTaskList tab="DOING" counts={countByStatus(entries)} tasks={grouped.get("DOING") ?? []} loading={false} onSelectTab={noop} onArchiveDone={noop} actions={actions} listRef={{ current: null }} />);
  assert.equal((desktop.match(/data-chain-card=/gu) ?? []).length, 1);
  assert.equal((mobile.match(/data-chain-card=/gu) ?? []).length, 1);
  assert.match(desktop, /Implement release/);
  assert.match(mobile, /Implement release/);
});

test("aggregate translations keep the state and action copy localized", () => {
  assert.equal(translate("en", "tasks.aggregate.activate"), "Activate");
  assert.notEqual(translate("zh", "tasks.aggregate.activate"), "Activate");
});

const AggregateActivationHarness = (): ReactNode => {
  const start = useTaskStartConfirmation(noop);
  const projection = aggregate({ activation: { state: "parked-unactivated", predecessor: null, taskId: "step-1" } });
  return <>
    <ChainAggregateCard
      aggregate={projection}
      representativeTaskId="step-1"
      actions={{
        onActivate: (taskId) => { void start.requestForMove(taskId); },
        onFilter: noop,
        onArchive: noop,
      }}
    />
    {start.request === null ? null : (
      <section data-aggregate-confirmation="">
        {start.error === null ? null : <div role="alert">{start.error}</div>}
        <button type="button" onClick={() => void start.confirm()}>Confirm activation</button>
      </section>
    )}
  </>;
};

test("aggregate Activate starts step zero and keeps a stale-view 4xx visible", async () => {
  const requests: Array<{ method: string; path: string }> = [];
  const page = await mountPage(<AggregateActivationHarness />, { "*": ({ input, method }) => {
    const path = String(input);
    requests.push({ method, path });
    if (path === "/api/tasks/step-1/startability") return {
      startable: true,
      checklist: {
        repoBound: true, agentAssignee: true, repoAccessGrant: true,
        budgetRemaining: true, noActiveRun: true, predecessorsDone: true,
      },
      task: {
        id: "step-1", name: "Release: Build", agent: { id: "a1", title: "Senior dev" },
        repo: { id: "r1", name: "product" }, targetBranch: "main",
      },
    };
    if (path === "/api/tasks/step-1/start" && method === "POST") {
      return Response.json({ error: "This chain was already activated." }, { status: 409 });
    }
    return Response.json([], { status: 404 });
  } });
  try {
    await page.press("Activate");
    assert.ok(page.container.querySelector("[data-aggregate-confirmation]"));
    await page.press("Confirm activation");
    assert.equal(requests.filter(({ method, path }) => method === "POST" && path === "/api/tasks/step-1/start").length, 1);
    assert.match(page.container.textContent ?? "", /already activated/u);
  } finally {
    await page.dispose();
  }
});
