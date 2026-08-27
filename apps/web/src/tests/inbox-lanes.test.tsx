import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";

import { installDom, reactDom } from "./dom-harness";
import type { InboxMessage } from "../lib/types";

const now = "2026-08-26T00:00:00.000Z";

const card = (overrides: Partial<InboxMessage> & Pick<InboxMessage, "id" | "body">): InboxMessage => ({
  from: "AGENT", agentId: null, sessionId: null, taskId: null, goalId: null,
  gateTaskId: null, artifactTaskId: null, threadId: "thread-1", replyToMessageId: null,
  kind: "TEXT", choices: null, selectedChoiceId: null, status: "OPEN", channel: "FEISHU",
  deliveryStatus: "DELIVERED", deliveryAttempts: 1, lastDeliveryError: null,
  createdAt: now, answeredAt: null, decisions: [], replies: [],
  ...overrides,
});

/** The three shapes the lanes have to tell apart: a gate that blocks a task, a
 *  detached notification nobody is blocked on, and an archived deploy record. */
const gate = card({
  id: "gate-1", body: "审批闸门：合并 PR #44", kind: "MULTIPLE_CHOICE", agentId: "agent-1",
  taskId: "gate-task", gateTaskId: "gate-task", choices: [{ id: "approve", label: "批准" }],
});
const notice = card({ id: "notice-1", body: "Autonomous merge tail stopped: missing regression output" });
const deployed = card({
  id: "deploy-1", status: "CLOSED", answeredAt: now,
  body: "[auto-deploy] success: cd63e56186022274da18288bfd7ef36bd6b318ea -> cb46e4a003c3296fbd2f9ee49d6450ae7b7b3b3b; reason=deployed",
});

const settle = async (): Promise<void> => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
};

const serve = (messages: InboxMessage[], posted: string[] = []): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).replace(/^.*\/api/, "");
    if (init?.method === "POST") { posted.push(url); return new Response("{}", { status: 200 }); }
    if (url === "/inbox/messages") return new Response(JSON.stringify(messages), { status: 200 });
    return new Response("[]", { status: 200 });
  }) as typeof fetch;

const renderInbox = async (messages: InboxMessage[], posted: string[] = []) => {
  const { container } = installDom("http://127.0.0.1:5173/inbox");
  const [{ createRoot }, { InboxPage }, { ProjectProvider }] = await Promise.all([
    reactDom(), import("../pages/Inbox"), import("../lib/project"),
  ]);
  globalThis.fetch = serve(messages, posted);
  const root = createRoot(container);
  act(() => root.render(<ProjectProvider><InboxPage /></ProjectProvider>));
  await settle();
  return { container, root };
};

const lane = (container: Element, label: RegExp): HTMLButtonElement => {
  const found = [...container.querySelectorAll("button")].find((button) => label.test(button.textContent ?? ""));
  assert.ok(found, `no lane matching ${String(label)}`);
  return found as HTMLButtonElement;
};

test("the active lane holds only cards that owe a reply; a detached notification is not one", async () => {
  const { container, root } = await renderInbox([gate, notice, deployed]);
  try {
    const text = container.textContent ?? "";
    assert.match(text, /合并 PR/);
    // The lane the operator lands on must not be padded with cards that need
    // nothing from them — that is what made the badge read 145.
    assert.doesNotMatch(text, /merge tail stopped/);
  } finally {
    act(() => root.unmount());
  }
});

test("the notices lane lists the detached notification and dismisses it without a decision", async () => {
  const posted: string[] = [];
  const { container, root } = await renderInbox([gate, notice, deployed], posted);
  try {
    // The lane's own count tells the operator there is something there without
    // spending the sidebar badge on it.
    assert.match(lane(container, /^Notices/).textContent ?? "", /^Notices 1$/);
    act(() => { lane(container, /^Notices/).click(); });
    await settle();
    const text = container.textContent ?? "";
    assert.match(text, /merge tail stopped/);
    assert.doesNotMatch(text, /合并 PR/);

    const dismiss = [...container.querySelectorAll("button")]
      .find((button) => (button.textContent ?? "").trim() === "Dismiss");
    assert.ok(dismiss, "the notices lane offers a row-level dismiss");
    act(() => { (dismiss as HTMLButtonElement).click(); });
    await settle();
    assert.deepEqual(posted, ["/inbox/messages/notice-1/close"]);
  } finally {
    act(() => root.unmount());
  }
});

test("a deploy that succeeded reports where production is, without occupying a lane", async () => {
  const { container, root } = await renderInbox([deployed]);
  try {
    const text = container.textContent ?? "";
    assert.match(text, /cb46e4a/);
    // Archived on write, so it is not in the active lane it is rendered above.
    assert.match(text, /Nothing waiting on you/);
  } finally {
    act(() => root.unmount());
  }
});

test("the sidebar badge counts the reply-owing cards only", async () => {
  const { needsReply } = await import("../lib/inbox");
  assert.deepEqual([gate, notice, deployed].filter(needsReply).map((message) => message.id), ["gate-1"]);
});
