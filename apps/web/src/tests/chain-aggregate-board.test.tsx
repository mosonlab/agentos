import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ChainAggregateCard } from "../components/chain-aggregate-card";
import { BoardColumn } from "../components/desktop-board";
import { MobileTaskList } from "../components/mobile-task-list";
import { COLUMNS, type BoardEntry, boardEntries, boardEntriesByStatus, countByStatus } from "../lib/board";
import { translate } from "../lib/i18n-core";
import type { BoardTask, ChainAggregate, TaskStatus } from "../lib/types";

const task = (overrides: Partial<BoardTask> = {}): BoardTask => ({
  id: "task-1", name: "Release: Build", displayName: "Build", status: "TODO", failureReason: null,
  assigneeType: "AGENT", createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T01:00:00.000Z",
  scheduleKind: "NOW", runAt: null, cron: null, timezone: null, approvalGate: false, templateId: null,
  source: "MANUAL", chainId: null, chainIndex: null, chainName: null, assigneeAgent: null,
  chainProgress: null, latestRun: null, taskCost: null, blockedOn: null, repairOf: null, ...overrides,
});

const aggregate = (overrides: Partial<ChainAggregate> = {}): ChainAggregate => ({
  chainId: "chain-1", chainName: "Release", stepCount: 12,
  statusCounts: { BACKLOG: 0, TODO: 10, DOING: 0, REVIEW: 0, DONE: 2 }, status: "TODO",
  frontier: { taskId: "step-3", title: "Implement release", status: "TODO", latestRun: null, failureReason: null, position: 3 },
  activation: { state: "running", predecessor: null }, totalCost: null,
  createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T01:00:00.000Z", ...overrides,
});

const chainStep = (id: string, position: number, status: TaskStatus, projection: ChainAggregate, overrides: Partial<BoardTask> = {}): BoardTask => task({
  id, name: `Release: ${id}`, displayName: id, chainId: projection.chainId, chainIndex: position - 1, chainName: projection.chainName,
  status, chainAggregate: projection, chainProgress: {
    chainId: projection.chainId, done: projection.statusCounts.DONE ?? 0, total: projection.stepCount,
    activeStepName: projection.frontier?.title ?? "", activeStatus: projection.frontier?.status ?? "done",
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
  assert.equal(entries[1]?.kind === "task" ? entries[1].task.id : "", "standalone");
});

test("aggregate placement follows API-derived frontier status and counts entries, not raw steps", () => {
  for (const [status, expectedColumn] of [
    ["TODO", "TODO"], ["DOING", "DOING"], ["REVIEW", "REVIEW"], ["DONE", "DONE"],
  ] as const) {
    const projection = aggregate({
      status,
      statusCounts: { TODO: status === "TODO" ? 12 : 0, DOING: status === "DOING" ? 1 : 0, REVIEW: status === "REVIEW" ? 1 : 0, DONE: status === "DONE" ? 12 : 0 },
      frontier: status === "DONE" ? null : { taskId: "frontier", title: "Frontier", status, latestRun: null, failureReason: null, position: 3 },
    });
    const rows = Array.from({ length: 12 }, (_, index) => chainStep(`step-${index}`, index + 1, status === "DONE" ? "DONE" : index === 2 ? status : "TODO", projection));
    const grouped = boardEntriesByStatus(boardEntries(rows));
    assert.equal(grouped.get(expectedColumn)?.length, 1, status);
    assert.equal(countByStatus(boardEntries(rows))[expectedColumn], 1, status);
  }
});

test("aggregate card exposes progress, frontier, activation/lock state, and no drag or Move To", () => {
  const parked = aggregate({ activation: { state: "parked-unactivated", predecessor: null } });
  const parkedMarkup = renderToStaticMarkup(<ChainAggregateCard aggregate={parked} />);
  assert.match(parkedMarkup, /Step 3\/12/);
  assert.match(parkedMarkup, /Implement release/);
  assert.match(parkedMarkup, />Activate<\/button>/);
  assert.doesNotMatch(parkedMarkup, /draggable/);
  assert.doesNotMatch(parkedMarkup, /Move to/);

  const waitingMarkup = renderToStaticMarkup(<ChainAggregateCard aggregate={aggregate({ activation: { state: "waiting-on-predecessor", predecessor: { taskId: "previous", taskName: "Prepare release" } } })} />);
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
