import assert from "node:assert/strict";
import test from "node:test";

import { NewTask } from "../components/new-task-panel";
import { LocaleProvider } from "../lib/i18n";
import { translate } from "../lib/i18n-core";
import type { TaskTemplate, TaskTemplateStep } from "../lib/types";
import { mountPage } from "./dom-harness";

const step = (stepIndex: number, name: string, optional: boolean): TaskTemplateStep => ({
  id: `step-${stepIndex}`,
  stepIndex,
  name,
  assigneeType: "HUMAN",
  prompt: "",
  approvalGate: false,
  optional,
  outputKind: "implementation",
  priorOutputKinds: [],
  baseFromStepIndex: null,
  runner: null,
  assigneeAgentId: null,
  assigneeAgent: null,
});

const template: TaskTemplate = {
  id: "template-1",
  projectId: "project-1",
  name: "Optional workflow",
  description: "",
  variables: [],
  retired: false,
  steps: [step(1, "Required step", false), step(2, "Optional step", true), step(3, "Another required step", false)],
};

const response = (body: unknown): Response => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});

for (const locale of ["en", "zh"] as const) {
  test(`template preview marks only optional steps in ${locale}`, async () => {
    const page = await mountPage(
      <LocaleProvider initialLocale={locale}>
        <NewTask projectId="project-1" agents={[]} repos={[]} onClose={() => undefined} onCreated={() => undefined} />
      </LocaleProvider>,
      { "*": ({ input }) => {
        const path = String(input).replace(/^.*\/api/u, "");
        if (path === "/projects/project-1/task-templates") return response([template]);
        return path.endsWith("/staffing-profiles") ? response([]) : response({});
      } },
    );
    try {
      await page.press(translate(locale, "newTask.tab.template"));
      const preview = page.container.querySelector<HTMLElement>('[class*="whitespace-pre-wrap"]');
      assert.ok(preview, "the template preview should be rendered");
      const text = preview.textContent ?? "";
      const marker = translate(locale, "newTask.preview.optional");
      assert.equal(text.split(marker).length - 1, 1);
      const blockFor = (name: string): string => text.split(/(?=- )/u).find((block) => block.includes(name)) ?? "";
      assert.match(blockFor("Optional step"), /Optional step/u);
      assert.ok(blockFor("Optional step").includes(marker));
      assert.ok(!blockFor("Required step").includes(marker));
      assert.ok(!blockFor("Another required step").includes(marker));
    } finally {
      await page.dispose();
    }
  });
}
