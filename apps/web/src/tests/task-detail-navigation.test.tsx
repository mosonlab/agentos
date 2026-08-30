import assert from "node:assert/strict";
import test from "node:test";

import { act, type ReactNode, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ApiError } from "../lib/api";
import type { Chain, Run, Task, TaskStepOutput } from "../lib/types";
import { RunRow, TaskDetailPage, TaskOutput } from "../pages/TaskDetail";
import { mountPage } from "./dom-harness";
import prompts from "./fixtures/tc-ux-v1-prompts.json";

const now = "2026-08-17T00:00:00.000Z";
const task = (id: string, name: string, promptIndex: number, chainId: string | null = null): Task => ({
  id, projectId: "project-1", assigneeAgentId: "agent-1", repoId: "repo-1",
  templateId: null, templateStepId: null, name,
  description: prompts[promptIndex]!.prompt,
  workingDirectory: null, targetBranch: "main", failureReason: null, status: "TODO",
  moveTargets: chainId === null
    ? [{ status: "BACKLOG", via: "patch" }, { status: "DOING", via: "start" }]
    : [],
  assigneeType: "AGENT", executionOwner: "agent", approvalGate: false, scheduleKind: "NOW", runAt: null,
  cron: null, timezone: null, maxDurationMin: 120, stallTimeoutMin: 10,
  maxSessionsPerTask: 3, createdAt: now, updatedAt: now, assigneeAgent: null,
  repo: null, runs: [], chainId, chainIndex: chainId ? 0 : null, source: "MANUAL",
  archivedAt: null, schedulePausedAt: null, recurringSourceTaskId: null,
  templateStep: null, chainProgress: null, recurringLastFiredAt: null, recurringFireCount: 0,
});

const output = (taskId: string, body: string): TaskStepOutput => ({
  id: `output-${taskId}`, taskId, runId: `run-${taskId}`, kind: "revised-plan", body,
  createdAt: now, updatedAt: now,
});

const sourceRun = (taskId: string): Run => ({
  id: `run-${taskId}`, projectId: "project-1", taskId, goalId: null, agentId: "agent-1", repoId: "repo-1",
  runNumber: 1, status: "SUCCEEDED", runner: "CLAUDE", runnerId: "runner-source", model: "claude",
  codexServiceTier: "DEFAULT", subagentModel: null, subagentMaxConcurrent: null,
  leaseGeneration: 1, cancelRequestId: null, cancelReason: null, cancelRequestedAt: null, cancelAcknowledgedAt: null,
  workspacePath: "/source-only-workspace", workspaceRetained: true,
  targetBranch: "main", branch: "source-branch", baseSha: "1111111111111111", headSha: "2222222222222222",
  pushStatus: "SUCCEEDED", pullRequestUrl: null, maxDurationMin: 120, stallTimeoutMin: 10,
  maxRunsPerTask: 3, failureClass: null, failureReason: null, retryable: null, retryAt: null,
  terminationReason: null, queuedAt: now, claimedAt: now, startedAt: now, endedAt: now, session: null,
});

const emptyChain = (): Chain => ({ chainId: null, total: 0, done: 0, steps: [] });
const chainFor = (taskId: string): Chain => ({
  chainId: "chain-c", total: 1, done: 0, steps: [{
    taskId, position: 1, chainIndex: 0, layer: null, name: "Chain C", stepName: "Chain C",
    status: "TODO", approvalGate: false, assigneeType: "AGENT", executionOwner: "agent",
    agent: { id: "agent-1", title: "Builder" }, archivedAt: null,
    failureReason: null, latestRun: null, startable: true, startAction: "start", holdRefusal: null,
    blockedOn: null, currentExecution: false, mergeRecovery: null,
  }],
});

test("a resumed run identifies Duration as wall-clock time that includes Inbox wait", () => {
  const run = sourceRun("task-1");
  run.startedAt = "2026-08-17T00:00:00.000Z";
  run.endedAt = "2026-08-17T00:05:00.000Z";
  run.session = { executionStatus: "SUCCEEDED", resumeAttempt: 1 } as NonNullable<Run["session"]>;
  const markup = renderToStaticMarkup(<table><tbody><RunRow run={run} remoteUrl={null} expanded={false} onToggle={() => undefined} /></tbody></table>);
  assert.match(markup, /5m 0s wall-clock \(includes Inbox wait\)/);
});

let replaceSubject: ((subject: ReactNode) => void) | null = null;

const SubjectHarness = ({ initial }: { initial: ReactNode }): ReactNode => {
  const [subject, setSubject] = useState(initial);
  replaceSubject = (next) => setSubject(next);
  return subject;
};

test("task-id switches expose a clean loading shell and destination-scoped actions", async () => {
  const mutations: Array<{ url: string; method: string; body: string }> = [];
  let resolveB: ((response: Response) => void) | null = null;
  let resolveAActivity: ((response: Response) => void) | null = null;
  let firstB = true;
  let firstAActivity = true;
  const tasks = { a: task("a", "Source A", 0), b: task("b", "Destination B", 1), c: task("c", "Destination C", 2, "chain-c") };
  tasks.a.runs = [sourceRun("a")];
  const page = await mountPage(<SubjectHarness initial={<TaskDetailPage taskId="a" />} />, { "*": ({ input, init, method }) => {
    const url = String(input).replace(/^.*\/api/, "");
    if (method !== "GET") {
      mutations.push({ url, method, body: String(init.body ?? "") });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/tasks/b" && firstB) {
      firstB = false;
      return new Promise<Response>((resolve) => { resolveB = resolve; });
    }
    const main = /^\/tasks\/([^/]+)$/.exec(url);
    if (main) return new Response(JSON.stringify(tasks[main[1] as keyof typeof tasks]), { status: 200 });
    const out = /^\/tasks\/([^/]+)\/output$/.exec(url);
    if (out) {
      if (out[1] === "a") return new Response(JSON.stringify(output("a", "revised-plan source artifact")), { status: 200 });
      return new Response(JSON.stringify({ error: "Output not found" }), { status: 404 });
    }
    const activity = /^\/tasks\/([^/]+)\/activity$/.exec(url);
    if (activity) {
      if (activity[1] === "a" && firstAActivity) {
        firstAActivity = false;
        return new Promise<Response>((resolve) => { resolveAActivity = resolve; });
      }
      return new Response("[]", { status: 200 });
    }
    const chain = /^\/tasks\/([^/]+)\/chain$/.exec(url);
    if (chain) return new Response(JSON.stringify(chain[1] === "c" ? chainFor("c") : emptyChain()), { status: 200 });
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  } }, "http://localhost/tasks/a");
  const { dom, container } = page;
  try {
    assert.match(container.textContent ?? "", /Source A/);
    assert.match(container.textContent ?? "", /revised-plan source artifact/);

    const sourceInput = container.querySelector("input[placeholder='Add a comment...']") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(sourceInput, "unsent source draft");
      sourceInput.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "unsent source draft" }));
    });
    const sourceRunRow = [...container.querySelectorAll("tr")].find((row) => row.textContent?.includes("#1"))!;
    await act(async () => { sourceRunRow.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    assert.match(container.textContent ?? "", /source-only-workspace/);
    assert.equal(sourceInput.value, "unsent source draft");

    act(() => replaceSubject?.(<TaskDetailPage taskId="b" />));
    assert.match(container.textContent ?? "", /Loading/);
    assert.doesNotMatch(container.textContent ?? "", /Source A|revised-plan source artifact|unsent source draft|source-only-workspace/);
    assert.equal(container.querySelector("button"), null, "destination shell exposes no source action");
    assert.equal(container.querySelector("input"), null, "destination shell exposes no source draft field");

    resolveB!(new Response(JSON.stringify(tasks.b), { status: 200 }));
    await page.settle();
    assert.match(container.textContent ?? "", /Destination B/);
    assert.match(container.textContent ?? "", /No output recorded/);
    assert.match(container.textContent ?? "", /independently review the persisted plan/);
    assert.doesNotMatch(container.textContent ?? "", /revised-plan source artifact/);
    const destinationInput = container.querySelector("input[placeholder='Add a comment...']") as HTMLInputElement;
    assert.equal(destinationInput.value, "", "the unsent source draft must not cross task identity");
    resolveAActivity!(new Response(JSON.stringify([{
      id: "late-a", taskId: "a", actorType: "operator", actorId: null,
      body: "late source activity", metadata: null, createdAt: now,
    }]), { status: 200 }));
    await page.settle();
    assert.doesNotMatch(container.textContent ?? "", /late source activity/);
    assert.equal(destinationInput.value, "", "a late source response must not restore the source draft");
    assert.doesNotMatch(container.textContent ?? "", /source-only-workspace/);

    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "DOING";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await page.settle();
    const archive = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Archive"))!;
    await act(async () => { archive.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await page.settle();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(destinationInput, "destination comment");
      destinationInput.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "destination comment" }));
      destinationInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await page.settle();
    const send = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Send"))!;
    assert.equal(send.disabled, false, `comment=${destinationInput.value}`);
    await act(async () => { send.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await page.settle();

    act(() => replaceSubject?.(<TaskDetailPage taskId="c" />));
    assert.doesNotMatch(container.textContent ?? "", /Destination B|destination comment/);
    await page.settle();
    const start = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Start next step"))!;
    await act(async () => { start.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await page.settle();

    assert.ok(mutations.some((item) => item.url === "/tasks/b/start" && item.method === "POST"));
    assert.ok(mutations.some((item) => item.url === "/tasks/b/archive" && item.method === "POST"));
    assert.ok(mutations.some((item) => item.url === "/tasks/b/activity" && item.body.includes("destination comment")), JSON.stringify(mutations));
    assert.ok(mutations.some((item) => item.url === "/tasks/c/start" && item.method === "POST"));
    assert.equal(mutations.some((item) => item.url.includes("/tasks/a")), false);

    const heldOutput = {
      data: output("b", "same-resource artifact"), error: null, loading: false, missing: false,
      lastSuccessAt: now, reload: () => undefined,
    };
    act(() => replaceSubject?.(<TaskOutput poll={heldOutput} />));
    assert.match(container.textContent ?? "", /same-resource artifact/);
    act(() => replaceSubject?.(<TaskOutput poll={{
      ...heldOutput, error: new ApiError(404, "/tasks/b/output", "Output not found"), missing: true,
    }} />));
    assert.match(container.textContent ?? "", /No output recorded/);
    assert.doesNotMatch(container.textContent ?? "", /same-resource artifact|Output not found/);
    for (const status of [405, 501]) {
      act(() => replaceSubject?.(<TaskOutput poll={{
        ...heldOutput, data: null, error: new ApiError(status, "/tasks/b/output", `HTTP ${status}`), missing: true,
      }} />));
      assert.match(container.textContent ?? "", new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(container.textContent ?? "", /No output recorded/);
    }
  } finally {
    replaceSubject = null;
    await page.dispose();
  }
});

test("the task-detail Chain card reflects a completed held layer on the next poll and deduplicates Resume", async () => {
  const holdTask = task("hold", "Held task", 0, "chain-hold");
  const runningChain = chainFor("hold");
  runningChain.chainId = "chain-hold";
  runningChain.steps[0] = { ...runningChain.steps[0]!, layer: 1, status: "DOING", startable: false, startAction: null, currentExecution: true };
  runningChain.control = {
    state: "held", heldLayer: 1,
    heldAt: now, holdRequestId: "hold-1", holdReason: "inspect output",
    releasedAt: null,
  };
  const completedChain: Chain = {
    ...runningChain,
    done: 1,
    steps: [{ ...runningChain.steps[0]!, status: "DONE", currentExecution: false }],
  };
  let latestChain = runningChain;
  let chainPolls = 0;
  const mutations: Array<{ url: string; method: string; body: string }> = [];
  const page = await mountPage(<TaskDetailPage taskId="hold" />, { "*": ({ input, init, method }) => {
    const url = String(input).replace(/^.*\/api/, "");
    if (method !== "GET") {
      mutations.push({ url, method, body: String(init.body ?? "") });
      return new Response("{}", { status: 200 });
    }
    if (url === "/tasks/hold") return new Response(JSON.stringify(holdTask), { status: 200 });
    if (url === "/tasks/hold/output") return new Response("null", { status: 200 });
    if (url === "/tasks/hold/startability") return new Response(JSON.stringify({
      startable: false,
      checklist: { repoBound: true, agentAssignee: true, repoAccessGrant: true, budgetRemaining: true, noActiveRun: true, predecessorsDone: true },
      task: { id: "hold", name: "Held task", agent: { id: "agent-1", title: "Builder" }, repo: { id: "repo-1", name: "repo" }, targetBranch: "main" },
    }), { status: 200 });
    if (url === "/tasks/hold/activity") return new Response("[]", { status: 200 });
    if (url === "/tasks/hold/chain") {
      chainPolls += 1;
      return new Response(JSON.stringify(latestChain), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  } }, "http://localhost/tasks/hold");
  const { dom, container } = page;
  try {
    assert.ok(chainPolls >= 1);
    assert.match(container.textContent ?? "", /Current execution/);
    assert.doesNotMatch(container.textContent ?? "", /Waiting for the operator to resume/);

    latestChain = completedChain;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_600)); });
    await page.settle();
    assert.ok(chainPolls >= 2, `expected a poll after the initial response, got ${chainPolls}`);
    assert.match(container.textContent ?? "", /Waiting for the operator to resume/);

    const toggle = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Resume Chain"));
    assert.ok(toggle);
    latestChain = { ...completedChain, control: null };
    await act(async () => {
      toggle!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      toggle!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await page.settle();
    const resumes = mutations.filter((item) => item.url === "/tasks/hold/chain/resume");
    assert.equal(resumes.length, 1, JSON.stringify(mutations));
    assert.match(JSON.parse(resumes[0]!.body).requestId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/u);

    const stop = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Stop after current layer"));
    assert.ok(stop);
    await act(async () => {
      stop!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      stop!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await page.settle();
    const holds = mutations.filter((item) => item.url === "/tasks/hold/chain/hold");
    assert.equal(holds.length, 1, JSON.stringify(mutations));
    assert.match(JSON.parse(holds[0]!.body).requestId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/u);
  } finally {
    await page.dispose();
  }
});
