import assert from "node:assert/strict";
import test from "node:test";
import { act, type ReactNode, useState } from "react";

import { NewTask } from "../components/new-task-panel";
import { LocaleProvider } from "../lib/i18n";
import { translate } from "../lib/i18n-core";
import type { Project, TaskTemplate, TaskTemplateStep } from "../lib/types";
import { mountPage } from "./dom-harness";

const en = (key: string): string => translate("en", key);

const project = (overrides: Partial<Project> = {}): Project => ({
  id: "project-1",
  name: "Gate project",
  slug: "gate-project",
  yamlDocument: "",
  maxDurationMin: 240,
  stallTimeoutMin: 10,
  maxSessionsPerTask: 3,
  specGateDefault: true,
  mergeGateDefault: false,
  spendCap: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

const step = (stepIndex: number, outputKind: string): TaskTemplateStep => ({
  id: `step-${stepIndex}`,
  stepIndex,
  name: `Step ${stepIndex}`,
  assigneeType: "AGENT",
  prompt: "",
  approvalGate: false,
  optional: false,
  outputKind,
  priorOutputKinds: [],
  baseFromStepIndex: null,
  runner: null,
  assigneeAgentId: null,
  assigneeAgent: null,
});

const template = (id: string, name: string, steps: TaskTemplateStep[]): TaskTemplate => ({
  id,
  projectId: "project-1",
  name,
  description: "",
  variables: [],
  steps,
});

const compound = template("compound", "compound", [
  step(1, "spec"), step(2, "implementation"), step(3, "merge-authorization"),
]);
const direct = template("direct", "direct", [
  step(1, "implementation"), step(2, "merge-authorization"),
]);
const plain = template("plain", "plain", [
  step(1, "implementation"), step(2, "documentation"),
]);

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

const switchToTemplateMode = async (page: Awaited<ReturnType<typeof mountPage>>): Promise<void> => {
  await page.press(en("newTask.tab.template"));
};

const checks = (page: Awaited<ReturnType<typeof mountPage>>): HTMLElement[] => (
  [...page.container.querySelectorAll('[role="checkbox"]')] as HTMLElement[]
);

const selectTemplate = async (
  page: Awaited<ReturnType<typeof mountPage>>,
  id: string,
): Promise<void> => {
  const select = page.container.querySelector("select") as HTMLSelectElement | null;
  assert.ok(select, "the template picker should be present");
  await act(async () => {
    select.value = id;
    select.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
  });
  await page.settle();
};

const fillTitle = async (
  page: Awaited<ReturnType<typeof mountPage>>,
  value: string,
): Promise<void> => {
  const label = [...page.container.querySelectorAll("label")]
    .find((candidate) => candidate.textContent?.trim() === en("newTask.field.title.label"));
  assert.ok(label, "the title field should be present");
  const input = label.parentElement?.querySelector("input") as HTMLInputElement | null;
  assert.ok(input, "the title field should contain an input");
  const setter = Object.getOwnPropertyDescriptor(page.dom.window.HTMLInputElement.prototype, "value")?.set;
  assert.ok(setter, "the title input should expose its value setter");
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
  });
  await page.settle();
};

const mount = async (templates: TaskTemplate[] = [compound, direct, plain]) => {
  const posts: Array<Record<string, unknown>> = [];
  const page = await mountPage(
    <LocaleProvider initialLocale="en">
      <NewTask
        projectId="project-1"
        project={project()}
        agents={[]}
        repos={[]}
        onClose={() => undefined}
        onCreated={() => undefined}
      />
    </LocaleProvider>,
    { "*": ({ input, init, method }) => {
      const path = String(input).replace(/^.*\/api/u, "");
      if (method === "POST") posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (path === "/projects/project-1/task-templates") return response(templates);
      return response({});
    } },
  );
  return { page, posts };
};

test("template gate checkboxes show only present slots and use project defaults", async () => {
  const { page } = await mount();
  try {
    await switchToTemplateMode(page);
    let visible = checks(page);
    assert.equal(visible.length, 2);
    assert.deepEqual(visible.map((control) => control.getAttribute("aria-label")), [
      en("newTask.gates.spec"), en("newTask.gates.merge"),
    ]);
    assert.deepEqual(visible.map((control) => control.getAttribute("data-state")), ["checked", "unchecked"]);

    await selectTemplate(page, direct.id);
    visible = checks(page);
    assert.equal(visible.length, 1);
    assert.equal(visible[0]?.getAttribute("aria-label"), en("newTask.gates.merge"));

    await selectTemplate(page, plain.id);
    assert.equal(checks(page).length, 0);
  } finally {
    await page.dispose();
  }
});

test("template instantiate requires a title and sends it in the request", async () => {
  const empty = await mount();
  try {
    await switchToTemplateMode(empty.page);
    const create = [...empty.page.container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === en("newTask.create")) as HTMLButtonElement | undefined;
    assert.ok(create, "the create button should be present");
    assert.equal(create.disabled, true, "an empty template title cannot be submitted");
    assert.equal(empty.posts.length, 0);
  } finally {
    await empty.page.dispose();
  }

  const named = await mount();
  try {
    await switchToTemplateMode(named.page);
    await fillTitle(named.page, "Ship the named chain");
    const create = [...named.page.container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === en("newTask.create")) as HTMLButtonElement | undefined;
    assert.ok(create, "the create button should be present");
    assert.equal(create.disabled, false, "a non-blank template title can be submitted");
    await named.page.press(en("newTask.create"));
    assert.equal(named.posts.length, 1);
    assert.equal(named.posts[0]?.name, "Ship the named chain");
  } finally {
    await named.page.dispose();
  }
});

test("instantiate sends only changed gate keys and drops gates when a change is restored", async () => {
  const first = await mount();
  try {
    await switchToTemplateMode(first.page);
    await fillTitle(first.page, "Gate defaults");
    await first.page.press(en("newTask.create"));
    assert.equal("gates" in (first.posts[0] ?? {}), false);
  } finally {
    await first.page.dispose();
  }

  const changed = await mount();
  try {
    await switchToTemplateMode(changed.page);
    await fillTitle(changed.page, "Gate changes");
    await changed.page.press(en("newTask.gates.spec"));
    await changed.page.press(en("newTask.create"));
    assert.deepEqual(changed.posts[0]?.gates, { spec: false });
  } finally {
    await changed.page.dispose();
  }

  const restored = await mount();
  try {
    await switchToTemplateMode(restored.page);
    await fillTitle(restored.page, "Gate restore");
    await restored.page.press(en("newTask.gates.spec"));
    await restored.page.press(en("newTask.gates.spec"));
    await restored.page.press(en("newTask.create"));
    assert.equal("gates" in (restored.posts[0] ?? {}), false);
  } finally {
    await restored.page.dispose();
  }
});

test("changing the template resets current gate choices to the new context", async () => {
  const { page } = await mount();
  try {
    await switchToTemplateMode(page);
    await page.press(en("newTask.gates.spec"));
    await selectTemplate(page, direct.id);
    await selectTemplate(page, compound.id);
    const visible = checks(page);
    assert.deepEqual(visible.map((control) => control.getAttribute("data-state")), ["checked", "unchecked"]);
  } finally {
    await page.dispose();
  }
});

test("changing project resets current gate choices to that project's defaults", async () => {
  const projectA = project({ id: "project-1", specGateDefault: true, mergeGateDefault: false });
  const projectB = project({ id: "project-2", specGateDefault: false, mergeGateDefault: true });
  const templates = [compound];
  const Wrapper = (): ReactNode => {
    const [selected, setSelected] = useState(projectA);
    return (
      <>
        <button type="button" onClick={() => setSelected(projectB)}>Switch project</button>
        <NewTask
          projectId={selected.id}
          project={selected}
          agents={[]}
          repos={[]}
          onClose={() => undefined}
          onCreated={() => undefined}
        />
      </>
    );
  };
  const page = await mountPage(
    <LocaleProvider initialLocale="en"><Wrapper /></LocaleProvider>,
    { "*": ({ input }) => {
      const path = String(input).replace(/^.*\/api/u, "");
      if (path === "/projects/project-1/task-templates" || path === "/projects/project-2/task-templates") {
        return response(templates);
      }
      return response({});
    } },
  );
  try {
    await page.press(en("newTask.tab.template"));
    assert.deepEqual(checks(page).map((control) => control.getAttribute("data-state")), ["checked", "unchecked"]);
    await page.press("Switch project");
    assert.deepEqual(checks(page).map((control) => control.getAttribute("data-state")), ["unchecked", "checked"]);
  } finally {
    await page.dispose();
  }
});

test("gate labels are translated in Chinese", async () => {
  const page = await mountPage(
    <LocaleProvider initialLocale="zh">
      <NewTask
        projectId="project-1"
        project={project()}
        agents={[]}
        repos={[]}
        onClose={() => undefined}
        onCreated={() => undefined}
      />
    </LocaleProvider>,
    { "*": ({ input }) => {
      const path = String(input).replace(/^.*\/api/u, "");
      return path === "/projects/project-1/task-templates" ? response([compound]) : response({});
    } },
  );
  try {
    await page.press(translate("zh", "newTask.tab.template"));
    const text = page.container.textContent ?? "";
    assert.match(text, /规格完成后需要审批/u);
    assert.match(text, /合并前需要审批/u);
  } finally {
    await page.dispose();
  }
});
