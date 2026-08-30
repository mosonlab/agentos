import assert from "node:assert/strict";
import test from "node:test";
import { act, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ChainAggregateCard } from "../components/chain-aggregate-card";
import { BoardColumn } from "../components/desktop-board";
import { MobileTaskList } from "../components/mobile-task-list";
import { COLUMNS, type BoardEntry, boardEntries, boardEntriesByStatus, countByStatus } from "../lib/board";
import { translate } from "../lib/i18n-core";
import type { BoardTask, ChainAggregate, TaskStatus } from "../lib/types";
import { useTaskStartConfirmation } from "../pages/Tasks";
import { installDom, reactDom } from "./dom-harness";

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
  detailTaskId: "step-1",
  statusCounts: { BACKLOG: 0, TODO: 10, DOING: 0, REVIEW: 0, DONE: 2 }, status: "TODO",
  frontier: { taskId: "step-3", title: "Implement release", status: "TODO", latestRun: null, failureReason: null, position: 3 },
  activation: { state: "running", predecessor: null, taskId: "step-1" }, totalCost: null,
  createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T01:00:00.000Z", ...overrides,
});

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
  return renderToStaticMarkup(<BoardColumn column={definition} tasks={entries} loading={false} dragOver={null} onDragOver={noop} onDragLeave={noop} onDrop={noop} onArchiveDone={noop} actions={actions} />);
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
  assert.equal(entries[0]?.kind === "chain" ? entries[0].representativeTaskId : "", "step-1");
  assert.equal(entries[1]?.kind === "task" ? entries[1].task.id : "", "standalone");
});

test("aggregate placement follows API-derived frontier status and counts entries, not raw steps", () => {
  for (const [status, expectedColumn] of [
    ["TODO", "TODO"], ["DOING", "DOING"], ["REVIEW", "REVIEW"], ["DONE", "DONE"],
  ] as const) {
    const projection = aggregate({
      status,
      statusCounts: { BACKLOG: 0, TODO: status === "TODO" ? 12 : 0, DOING: status === "DOING" ? 1 : 0, REVIEW: status === "REVIEW" ? 1 : 0, DONE: status === "DONE" ? 12 : 0 },
      frontier: { taskId: "frontier", title: "Frontier", status, latestRun: null, failureReason: null, position: 3 },
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

test("mobile and desktop receive the same aggregate entry list", () => {
  const projection = aggregate({ status: "DOING", frontier: { taskId: "step-1", title: "Implement release", status: "DOING", latestRun: null, failureReason: null, position: 1 } });
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
  const { dom, container } = installDom();
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; path: string }> = [];
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    requests.push({ method, path });
    if (path === "/api/tasks/step-1/startability") return Response.json({
      startable: true,
      checklist: {
        repoBound: true, agentAssignee: true, repoAccessGrant: true,
        budgetRemaining: true, noActiveRun: true, predecessorsDone: true,
      },
      task: {
        id: "step-1", name: "Release: Build", agent: { id: "a1", title: "Senior dev" },
        repo: { id: "r1", name: "product" }, targetBranch: "main",
      },
    });
    if (path === "/api/tasks/step-1/start" && method === "POST") {
      return Response.json({ error: "This chain was already activated." }, { status: 409 });
    }
    return Response.json([], { status: 404 });
  } });
  const root = (await reactDom()).createRoot(container);
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 3; round += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
  };
  const press = async (label: string): Promise<void> => {
    const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent?.trim() === label);
    assert.ok(button, `no ${label} button`);
    await act(async () => button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    await settle();
  };
  try {
    await act(async () => root.render(<AggregateActivationHarness />));
    await press("Activate");
    assert.ok(container.querySelector("[data-aggregate-confirmation]"));
    await press("Confirm activation");
    assert.equal(requests.filter(({ method, path }) => method === "POST" && path === "/api/tasks/step-1/start").length, 1);
    assert.match(container.textContent ?? "", /already activated/u);
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    await act(async () => root.unmount());
    dom.window.close();
  }
});
