import assert from "node:assert/strict";
import test from "node:test";
import { act, type ReactNode, useCallback, useState } from "react";

import type { CardActions } from "../components/task-card";
import { operatorMoveTargets } from "../lib/board";
import type { BoardTask, TaskStatus } from "../lib/types";
import { installDom, reactDom } from "./dom-harness";

const task = (overrides: Partial<BoardTask> = {}): BoardTask => ({
  id: "t1", name: "Ship the thing", displayName: overrides.displayName ?? overrides.name ?? "Ship the thing", status: "TODO",
  assigneeType: "HUMAN", failureReason: null, createdAt: "2026-08-15T00:00:00.000Z",
  scheduleKind: "NOW", runAt: null, cron: null, timezone: null,
  approvalGate: false, templateId: null, source: "MANUAL", chainId: null, chainIndex: null,
  chainName: null, updatedAt: "2026-08-16T00:00:00.000Z", assigneeAgent: null, chainProgress: null, blockedOn: null, latestRun: null, taskCost: null,
  ...overrides,
});

const noop = (): void => undefined;
const actions = (onMove: CardActions["onMove"] = noop): CardActions => ({
  onMove, onRetry: noop, onArchive: noop, onDelete: noop, onCopyError: noop, onFilterChain: noop,
});

test("operator move targets keep machine statuses out of ordinary menus", () => {
  assert.deepEqual(operatorMoveTargets(task({ assigneeType: "HUMAN", status: "TODO" })), ["BACKLOG", "DONE"]);
  assert.deepEqual(operatorMoveTargets(task({ assigneeType: "HUMAN", status: "DOING" })), ["DONE"]);
  assert.deepEqual(operatorMoveTargets(task({ assigneeType: "HUMAN", status: "REVIEW" })), ["DONE"]);
  assert.deepEqual(operatorMoveTargets(task({ assigneeType: "HUMAN", status: "DONE" })), []);

  // Doing is present only as the agent's start action. The menu never offers a
  // Review or Done PATCH for an agent, and a callback below proves Doing cannot
  // silently become one either.
  assert.deepEqual(operatorMoveTargets(task({ assigneeType: "AGENT", status: "TODO" })), ["BACKLOG", "DOING"]);
  assert.deepEqual(operatorMoveTargets(task({ assigneeType: "AGENT", status: "BACKLOG" })), ["TODO", "DOING"]);
  assert.deepEqual(operatorMoveTargets(task({ assigneeType: "AGENT", status: "DOING" })), []);
  assert.deepEqual(operatorMoveTargets(task({ assigneeType: "AGENT", status: "REVIEW" })), []);
  assert.deepEqual(operatorMoveTargets(task({ assigneeType: "AGENT", status: "DONE" })), []);
});

test("predecessor-bound and chain-derived cards have no operator status targets", () => {
  assert.deepEqual(operatorMoveTargets(task({ blockedOn: { taskId: "p1", taskName: "Build first" } })), []);
  assert.deepEqual(operatorMoveTargets(task({ chainId: "c1", chainName: "Release", chainIndex: 0 })), []);
  assert.deepEqual(operatorMoveTargets(task({ chainProgress: { chainId: "c1", done: 0, total: 1, activeStepName: "Build", activeStatus: "todo", currentLayer: 1, layerCount: 1, position: 1 } })), []);
  assert.deepEqual(operatorMoveTargets(task({ repairOf: { chainId: "c1", chainName: "Release", repairKind: "gate-fix" } })), []);
});

type TaskCardComponent = typeof import("../components/task-card").TaskCard;
type UseTaskStartConfirmation = typeof import("../pages/Tasks").useTaskStartConfirmation;

const StartMenuHarness = ({ Card, useStart, row, onMutation }: { Card: TaskCardComponent; useStart: UseTaskStartConfirmation; row: BoardTask; onMutation: (status: TaskStatus) => void }): ReactNode => {
  const start = useStart(() => undefined);
  const [error, setError] = useState<string | null>(null);
  const onMove = useCallback((selected: BoardTask, status: TaskStatus, origin: "menu" | "drop" = "menu"): void => {
    void (async () => {
      if (status === "DOING" && await start.requestForMove(origin, selected.id, selected.assigneeType === "AGENT")) return;
      onMutation(status);
    })().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [onMutation, start.requestForMove]);
  return <>
    <Card task={row} actions={actions(onMove)} />
    {start.request === null ? null : <section data-confirmation="">
      <span>{start.request.task.name}</span>
      {start.error === null ? null : <div role="alert">{start.error}</div>}
      <button type="button" onClick={() => void start.confirm()}>Start task</button>
    </section>}
    {error === null ? null : <div role="alert">{error}</div>}
  </>;
};

const startability = (startable: boolean) => ({
  startable,
  checklist: {
    repoBound: startable, agentAssignee: startable, repoAccessGrant: startable,
    budgetRemaining: startable, noActiveRun: startable, predecessorsDone: startable,
  },
  task: {
    id: "t1", name: "Ship the thing", agent: { id: "a1", title: "Senior dev" },
    repo: { id: "r1", name: "product" }, targetBranch: "main",
  },
});

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let round = 0; round < 4; round += 1) await Promise.resolve();
  });
};

const installComputedStyle = (dom: ReturnType<typeof installDom>["dom"]): void => {
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: dom.window.getComputedStyle.bind(dom.window),
  });
  Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: dom.window.CustomEvent });
  Object.defineProperty(globalThis, "PointerEvent", { configurable: true, value: dom.window.MouseEvent });
  Object.defineProperty(globalThis, "DOMRect", { configurable: true, value: dom.window.DOMRect });
};

const openDoing = async (dom: ReturnType<typeof installDom>["dom"]): Promise<HTMLElement> => {
  const trigger = dom.window.document.querySelector<HTMLButtonElement>("button[aria-label^='Actions for']");
  assert.ok(trigger, dom.window.document.body.innerHTML);
  await act(async () => trigger.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 })));
  const doing = [...dom.window.document.querySelectorAll<HTMLElement>("[role='menuitem']")]
    .find((item) => item.textContent?.trim() === "Doing");
  assert.ok(doing, dom.window.document.body.innerHTML);
  return doing;
};

test("the agent menu Doing action opens confirmation and never PATCHes", async () => {
  const { dom, container } = installDom();
  installComputedStyle(dom);
  const { useTaskStartConfirmation } = await import("../pages/Tasks");
  const { TaskCard } = await import("../components/task-card");
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; path: string }> = [];
  const mutations: TaskStatus[] = [];
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    const path = String(input);
    requests.push({ method: init?.method ?? "GET", path });
    if (path === "/api/tasks/t1/startability") return Response.json(startability(true));
    if (path === "/api/tasks/t1/start") return Response.json({ runId: "r1", runNumber: 1 }, { status: 201 });
    return Response.json([], { status: 404 });
  } });
  const root = (await reactDom()).createRoot(container);
  try {
    await act(async () => root.render(<StartMenuHarness Card={TaskCard} useStart={useTaskStartConfirmation} row={task({ assigneeType: "AGENT", assigneeAgent: { id: "a1", title: "Senior dev", model: "gpt-5.6-luna:max" } })} onMutation={(status) => mutations.push(status)} />));
    await settle();
    const doing = await openDoing(dom);
    await act(async () => doing.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    await settle();
    assert.ok(container.querySelector("[data-confirmation]"), container.innerHTML);
    assert.equal(requests.filter(({ method, path }) => method === "GET" && path === "/api/tasks/t1/startability").length, 1);
    assert.equal(requests.some(({ method }) => method === "PATCH"), false);
    assert.deepEqual(mutations, []);

    assert.ok([...dom.window.document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Start task"));
    const confirm = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Start task");
    assert.ok(confirm);
    await act(async () => confirm.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    await settle();
    assert.equal(requests.filter(({ method, path }) => method === "POST" && path === "/api/tasks/t1/start").length, 1);
    assert.equal(requests.some(({ method }) => method === "PATCH"), false);
    assert.equal(container.querySelector("[data-confirmation]"), null);
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("a non-startable agent Doing action surfaces refusal without a status PATCH", async () => {
  const { dom, container } = installDom();
  installComputedStyle(dom);
  const { useTaskStartConfirmation } = await import("../pages/Tasks");
  const { TaskCard } = await import("../components/task-card");
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; path: string }> = [];
  const mutations: TaskStatus[] = [];
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    const path = String(input);
    requests.push({ method: init?.method ?? "GET", path });
    if (path === "/api/tasks/t1/startability") return Response.json(startability(false));
    return Response.json([], { status: 404 });
  } });
  const root = (await reactDom()).createRoot(container);
  try {
    await act(async () => root.render(<StartMenuHarness Card={TaskCard} useStart={useTaskStartConfirmation} row={task({ assigneeType: "AGENT", assigneeAgent: { id: "a1", title: "Senior dev", model: "gpt-5.6-luna:max" } })} onMutation={(status) => mutations.push(status)} />));
    await settle();
    const doing = await openDoing(dom);
    await act(async () => doing.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    await settle();
    assert.match(container.textContent ?? "", /not currently startable/);
    assert.equal(requests.some(({ method }) => method === "PATCH"), false);
    assert.deepEqual(mutations, []);
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    await act(async () => root.unmount());
    dom.window.close();
  }
});
