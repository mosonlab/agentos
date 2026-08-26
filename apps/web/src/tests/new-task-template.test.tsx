import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";

import { installDom, reactDom } from "./dom-harness";
import { translate } from "../lib/i18n-core";
import type { TaskTemplate } from "../lib/types";

const en = (key: string): string => translate("en", key);

/* The direct chain's review steps read the task brief as their specification
 * authority, so `instantiateTemplate` refuses a briefless instantiation. The
 * panel is the only place in this app that instantiates a template, and it
 * previously sent no `description` at all — nothing here proved the field was
 * on the wire, so a server-side requirement broke every template creation from
 * the New Task panel and no test noticed. */

const template = (): TaskTemplate => ({
  id: "tpl-1", projectId: "p1", name: "direct-engineer-workflow",
  description: null, variables: ["branchName"],
  webhookRepoId: null, webhookSecretId: null, webhookPausedAt: null,
  webhookReplayWindowSec: null, webhookPayloadMapping: null,
  createdAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-26T00:00:00.000Z",
  steps: [{
    id: "step-1", taskTemplateId: "tpl-1", stepIndex: 1, name: "Implementation",
    prompt: "work", outputKind: "implementation", attachmentsFromPrevious: false,
    assigneeType: "AGENT", assigneeAgentId: "agent-1", approvalGate: false,
    runner: null, baseFromStepIndex: null, assigneeAgent: null,
  }],
} as unknown as TaskTemplate);

const repo = { id: "repo-1", projectId: "p1", name: "agentos", remoteUrl: "https://github.com/o/r.git", defaultBranch: "main" };

const settle = async (): Promise<void> => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
};

/** Set a controlled field by its rendered `Field` label. */
const fill = async (container: Element, label: string, value: string): Promise<void> => {
  // `Field` renders the label and its control as siblings inside one wrapper.
  const field = [...container.querySelectorAll("label")].find((node) => (node.textContent ?? "").trim() === label);
  assert.ok(field, `no field labelled ${label}`);
  const control = field.parentElement?.querySelector("textarea, input");
  assert.ok(control, `field ${label} has no control`);
  const prototype = control.tagName === "TEXTAREA"
    ? globalThis.window.HTMLTextAreaElement.prototype
    : globalThis.window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
  await act(async () => {
    setter.call(control, value);
    control.dispatchEvent(new globalThis.Event("input", { bubbles: true }));
  });
};

const openPanel = async (): Promise<{ container: Element; posts: { url: string; body: unknown }[]; root: { unmount: () => void } }> => {
  const { container } = installDom("http://127.0.0.1:5173/tasks");
  const [{ createRoot }, { NewTask }, { ProjectProvider }] = await Promise.all([
    reactDom(), import("../components/new-task-panel"), import("../lib/project"),
  ]);
  const posts: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).replace(/^.*\/api/, "");
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ chainId: "c1", taskIds: ["t1"] }), { status: 201 });
    }
    if (url === "/projects/p1/task-templates") return new Response(JSON.stringify([template()]), { status: 200 });
    return new Response("[]", { status: 200 });
  }) as typeof fetch;

  const root = createRoot(container);
  act(() => root.render(
    <ProjectProvider>
      <NewTask projectId="p1" agents={[]} repos={[repo as never]} onClose={() => undefined} onCreated={() => undefined} />
    </ProjectProvider>,
  ));
  await settle();
  // The panel opens on the blank tab; the template tab is the one under test.
  const tab = [...container.querySelectorAll("button")].find((node) => node.textContent === en("newTask.tab.template"));
  assert.ok(tab, "the template tab is missing");
  await act(async () => { tab.dispatchEvent(new globalThis.MouseEvent("click", { bubbles: true })); });
  await settle();
  return { container, posts, root };
};

const create = async (container: Element): Promise<void> => {
  const button = [...container.querySelectorAll("button")].find((node) => node.textContent === en("newTask.create"));
  assert.ok(button, "the create button is missing");
  await act(async () => { button.dispatchEvent(new globalThis.MouseEvent("click", { bubbles: true })); });
  await settle();
};

test("the template tab offers a feature brief and puts it on the instantiate request", async () => {
  const { container, posts, root } = await openPanel();
  try {
    assert.match(container.textContent ?? "", new RegExp(en("newTask.field.brief.label")));
    await fill(container, "branchName", "feat/thing");
    await fill(container, en("newTask.field.brief.label"), "Problem: x\n\nAcceptance:\n- y");
    await create(container);

    assert.equal(posts.length, 1, "exactly one instantiate request");
    assert.equal(posts[0]!.url, "/projects/p1/task-templates/tpl-1/instantiate");
    assert.deepEqual(posts[0]!.body, {
      repoId: "repo-1",
      variables: { branchName: "feat/thing" },
      autoStart: false,
      description: "Problem: x\n\nAcceptance:\n- y",
    });
  } finally {
    act(() => root.unmount());
  }
});

test("a blank brief is omitted rather than sent empty, so briefless templates are unchanged", async () => {
  // An empty string composes the same description as an absent one, and sending
  // it would make every template creation look like it carried a brief.
  const { container, posts, root } = await openPanel();
  try {
    await fill(container, "branchName", "feat/thing");
    await fill(container, en("newTask.field.brief.label"), "   \n  ");
    await create(container);

    assert.equal(posts.length, 1);
    assert.ok(!Object.hasOwn(posts[0]!.body as object, "description"), "a whitespace-only brief is not sent");
  } finally {
    act(() => root.unmount());
  }
});
