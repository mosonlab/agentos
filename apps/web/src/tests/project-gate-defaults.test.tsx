import assert from "node:assert/strict";
import test from "node:test";

import type { Project } from "../lib/types";
import { LocaleProvider } from "../lib/i18n";
import { ProjectProvider } from "../lib/project";
import { ProjectDetailPage } from "../pages/Projects";
import { mountPage } from "./dom-harness";

const project = (overrides: Partial<Project> = {}): Project => ({
  id: "project-1",
  name: "Gate project",
  slug: "gate-project",
  yamlDocument: "",
  maxDurationMin: 240,
  stallTimeoutMin: 10,
  maxSessionsPerTask: 3,
  specGateDefault: false,
  mergeGateDefault: false,
  spendCap: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

test("project detail renders independent gate defaults and sends one field per instant save", async () => {
  let current = project({ specGateDefault: true, mergeGateDefault: false });
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const page = await mountPage(
    <LocaleProvider initialLocale="en">
      <ProjectProvider initialProjects={[current]}><ProjectDetailPage projectId="project-1" /></ProjectProvider>
    </LocaleProvider>,
    { "*": ({ input, init, method }) => {
      const path = String(input).replace(/^.*\/api/u, "");
      const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
      requests.push({ method, path, body });
      if (method === "PATCH" && path === "/projects/project-1") {
        current = project({ ...current, ...(body as Partial<Project>) });
        return response(current);
      }
      if (path === "/projects/project-1") return response(current);
      if (path === "/projects") return response([current]);
      if (path === "/agents" || path === "/repos" || path === "/tasks?projectId=project-1&enrich=false") return response([]);
      return response([]);
    } },
    "http://127.0.0.1:5173/projects/project-1",
  );
  try {
    // The two approval gates are the whole project-level switch surface:
    // optional-step omission is a staffing decision made per instantiation.
    const switches = [...page.container.querySelectorAll('[role="switch"]')];
    assert.equal(switches.length, 2);
    assert.equal(switches[0]?.getAttribute("aria-label"), "Require approval after specification");
    assert.equal(switches[0]?.getAttribute("data-state"), "checked");
    assert.equal(switches[1]?.getAttribute("aria-label"), "Require approval before merge");
    assert.equal(switches[1]?.getAttribute("data-state"), "unchecked");

    await page.press("Require approval before merge");
    const patches = requests.filter(({ method, path }) => method === "PATCH" && path === "/projects/project-1");
    assert.deepEqual(patches.map(({ body }) => body), [{ mergeGateDefault: true }]);
    assert.equal(current.specGateDefault, true);
    assert.equal(current.mergeGateDefault, true);
  } finally {
    await page.dispose();
  }
});

test("project gate labels are translated in Chinese", async () => {
  const value = project({ specGateDefault: true, mergeGateDefault: true });
  const page = await mountPage(
    <LocaleProvider initialLocale="zh">
      <ProjectProvider initialProjects={[value]}><ProjectDetailPage projectId="project-1" /></ProjectProvider>
    </LocaleProvider>,
    { "*": ({ input }) => {
      const path = String(input).replace(/^.*\/api/u, "");
      if (path === "/projects/project-1") return response(value);
      if (path === "/projects") return response([value]);
      return response([]);
    } },
    "http://127.0.0.1:5173/projects/project-1",
  );
  try {
    const text = page.container.textContent ?? "";
    assert.match(text, /规格完成后需要审批/u);
    assert.match(text, /合并前需要审批/u);
  } finally {
    await page.dispose();
  }
});
