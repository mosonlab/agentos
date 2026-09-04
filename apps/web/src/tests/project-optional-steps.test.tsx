import assert from "node:assert/strict";
import test from "node:test";

import type { Project } from "../lib/types";
import { LocaleProvider } from "../lib/i18n";
import { ProjectProvider } from "../lib/project";
import { ProjectDetailPage } from "../pages/Projects";
import { mountPage } from "./dom-harness";

const project = (overrides: Partial<Project> = {}): Project => ({
  id: "project-1",
  name: "Optional project",
  slug: "optional-project",
  yamlDocument: "",
  maxDurationMin: 240,
  stallTimeoutMin: 10,
  maxSessionsPerTask: 3,
  specGateDefault: false,
  mergeGateDefault: false,
  skipOptionalSteps: false,
  spendCap: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

test("skip optional template steps is an independent single-key project patch", async () => {
  let current = project();
  const patches: unknown[] = [];
  const page = await mountPage(
    <LocaleProvider initialLocale="en">
      <ProjectProvider initialProjects={[current]}><ProjectDetailPage projectId="project-1" /></ProjectProvider>
    </LocaleProvider>,
    { "*": ({ input, init, method }) => {
      const path = String(input).replace(/^.*\/api/u, "");
      const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
      if (method === "PATCH" && path === "/projects/project-1") {
        patches.push(body);
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
    const optional = page.container.querySelector<HTMLElement>('[aria-label="Skip optional template steps"]');
    assert.ok(optional);
    assert.equal(optional.getAttribute("data-state"), "unchecked");

    await page.press("Skip optional template steps");

    assert.deepEqual(patches, [{ skipOptionalSteps: true }]);
    assert.equal(current.skipOptionalSteps, true);
    assert.equal(current.specGateDefault, false);
    assert.equal(current.mergeGateDefault, false);
  } finally {
    await page.dispose();
  }
});
