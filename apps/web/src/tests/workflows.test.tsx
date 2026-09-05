// Radix decides at import time whether portals may mount; see dom-preload.ts.
import "./dom-preload";

import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import type { JSDOM } from "jsdom";

import { ROUTES } from "../App";
import { LocaleProvider } from "../lib/i18n";
import { translate } from "../lib/i18n-core";
import { ProjectProvider } from "../lib/project";
import { matchRoute } from "../lib/router";
import { storage } from "../lib/storage";
import type { Agent, Project, StaffingProfile, TaskTemplate, TaskTemplateStep } from "../lib/types";
import { StaffingProfileEditor } from "../pages/Workflows";
import { mountPage, type PageHarness, type PageRoutes } from "./dom-harness";

const t = (locale: "en" | "zh", key: string, vars?: Record<string, string | number>): string =>
  translate(locale, key, vars);

/* ------------------------------------------------------------------ fixtures */

const PROJECT: Project = {
  id: "project-1",
  name: "Staffing project",
  slug: "staffing-project",
  yamlDocument: "",
  maxDurationMin: 240,
  stallTimeoutMin: 10,
  maxSessionsPerTask: 3,
  specGateDefault: false,
  mergeGateDefault: false,
  spendCap: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const agent = (overrides: Partial<Agent> & Pick<Agent, "id" | "name" | "title">): Agent => ({
  projectId: PROJECT.id,
  environmentId: "env-1",
  canonicalRole: null,
  customizedFields: [],
  model: "claude-opus-5:medium",
  codexServiceTier: "DEFAULT",
  foundationalPrompt: "",
  rolePrompt: "",
  runnerPreference: "CLAUDE",
  inboxAccess: false,
  disabledTools: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  archivedAt: null,
  ...overrides,
});

const SENIOR = agent({ id: "a-senior", name: "senior-dev-opus-medium", title: "Senior Developer" });
const RETIRED = agent({
  id: "a-retired", name: "retired-dev-sol-high", title: "Retired Developer",
  archivedAt: "2026-09-02T00:00:00.000Z",
});
const SENTINEL = agent({ id: "a-merge", name: "merge-integrator", title: "Merge Integrator", assignable: false });
const AGENTS = [SENIOR, RETIRED, SENTINEL];

const step = (overrides: Partial<TaskTemplateStep> & Pick<TaskTemplateStep, "stepIndex" | "name" | "outputKind">): TaskTemplateStep => ({
  id: `step-${overrides.stepIndex}`,
  assigneeType: "AGENT",
  prompt: "",
  approvalGate: false,
  optional: false,
  priorOutputKinds: [],
  baseFromStepIndex: null,
  runner: null,
  assigneeAgentId: null,
  assigneeAgent: null,
  ...overrides,
});

const TEMPLATE: TaskTemplate = {
  id: "template-1",
  projectId: PROJECT.id,
  name: "Direct engineering",
  description: "Seven steps without a spec phase",
  variables: [],
  steps: [
    step({ stepIndex: 1, name: "Implementation", outputKind: "implementation", assigneeAgentId: SENIOR.id, assigneeAgent: SENIOR }),
    step({ stepIndex: 2, name: "Blind review", outputKind: "blind-findings", optional: true }),
    step({ stepIndex: 3, name: "Human PR review", outputKind: "human-review", assigneeType: "HUMAN" }),
  ],
};

const profile = (overrides: Partial<StaffingProfile> & Pick<StaffingProfile, "id" | "name">): StaffingProfile => ({
  projectId: PROJECT.id,
  taskTemplateId: TEMPLATE.id,
  isDefault: false,
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
  entries: [],
  ...overrides,
});

const FAST_LANE = profile({
  id: "p-fast",
  name: "Fast lane",
  isDefault: true,
  entries: [{ outputKind: "implementation", assigneeAgentId: SENIOR.id, include: null }],
});
const CAREFUL = profile({ id: "p-careful", name: "Careful lane" });

const PROFILES_PATH = `/projects/${PROJECT.id}/task-templates/${TEMPLATE.id}/staffing-profiles`;

/* -------------------------------------------------------------------- helpers */

const scoped = (dom: JSDOM): void => {
  storage.set("agentos.projectId", PROJECT.id);
  Object.defineProperty(dom.window, "confirm", { configurable: true, value: () => true });
};

/** Mounts whichever route owns `path`, exactly as `Routed` would pick it. */
const mountRoute = async (path: string, routes: PageRoutes, locale: "en" | "zh" = "en"): Promise<PageHarness> => {
  const matched = ROUTES.map((route) => ({ route, params: matchRoute(route.pattern, path) }))
    .find((candidate) => candidate.params !== null);
  assert.ok(matched, `no route matches ${path}`);
  return await mountPage(
    <LocaleProvider initialLocale={locale}>
      <ProjectProvider>{matched.route.render(matched.params ?? {})}</ProjectProvider>
    </LocaleProvider>,
    { "/projects": [PROJECT], ...routes },
    `http://127.0.0.1:5173/#${path}`,
    scoped,
  );
};

const templateRoutes = (profiles: StaffingProfile[]): PageRoutes => ({
  [`/projects/${PROJECT.id}/task-templates`]: [TEMPLATE],
  [PROFILES_PATH]: profiles,
  [`/projects/${PROJECT.id}/agents`]: AGENTS,
});

const rowFor = (page: PageHarness, outputKind: string): Element => {
  const row = page.container.querySelector(`[data-output-kind="${outputKind}"]`);
  assert.ok(row, `missing step row ${outputKind}`);
  return row;
};

const selectIn = async (page: PageHarness, row: Element, value: string): Promise<void> => {
  const select = row.querySelector("select");
  assert.ok(select, "the row should carry an agent picker");
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
  });
  await page.settle();
};

const bodyOf = (page: PageHarness, method: string, path: string): Record<string, unknown> => {
  const request = page.requests.find((entry) => entry.method === method && entry.path === path);
  assert.ok(request, `no ${method} ${path} was sent`);
  return JSON.parse(String(request.init.body)) as Record<string, unknown>;
};

/* ---------------------------------------------------------------------- pages */

test("the three Workflows routes are registered and the list renders its templates", async () => {
  for (const path of ["/workflows", "/workflows/template-1", "/workflows/template-1/profiles/p-fast"]) {
    assert.ok(ROUTES.some((route) => matchRoute(route.pattern, path) !== null), `no route for ${path}`);
  }
  const page = await mountRoute("/workflows", templateRoutes([FAST_LANE]));
  try {
    const text = page.container.textContent ?? "";
    assert.match(text, /Direct engineering/u);
    assert.ok(text.includes(t("en", "workflows.template.steps", { n: 3 })));
    assert.ok(page.container.querySelector('a[href="#/workflows/template-1"]'), "the template should link to its profiles");
  } finally {
    await page.dispose();
  }
});

test("the profile list shows the default badge and refuses to delete the default while others exist", async () => {
  const page = await mountRoute("/workflows/template-1", templateRoutes([FAST_LANE, CAREFUL]));
  try {
    const text = page.container.textContent ?? "";
    assert.match(text, /Fast lane/u);
    assert.match(text, /Careful lane/u);
    assert.ok(text.includes(t("en", "workflows.profile.default")));
    assert.ok(text.includes(t("en", "workflows.profile.delete.refused")), "the refusal hint should be on screen");
    const deletes = [...page.container.querySelectorAll("button")]
      .filter((node) => node.textContent?.trim() === t("en", "common.delete"));
    assert.equal(deletes.length, 2);
    // The default is the one the control plane answers 409 for; the other is free.
    assert.deepEqual(deletes.map((node) => (node as HTMLButtonElement).disabled), [true, false]);
  } finally {
    await page.dispose();
  }
});

test("a template with no profile says instantiation falls back to the canonical bindings", async () => {
  const page = await mountRoute("/workflows/template-1", templateRoutes([]));
  try {
    const text = page.container.textContent ?? "";
    assert.ok(text.includes(t("en", "workflows.profiles.empty")));
    assert.ok(text.includes(t("en", "workflows.profiles.empty.hint")));
  } finally {
    await page.dispose();
  }
});

test("promoting a profile sends PATCH { isDefault: true }", async () => {
  const page = await mountRoute("/workflows/template-1", {
    ...templateRoutes([FAST_LANE, CAREFUL]),
    "PATCH /staffing-profiles/p-careful": CAREFUL,
  });
  try {
    const promotes = [...page.container.querySelectorAll("button")]
      .filter((node) => node.textContent?.trim() === t("en", "workflows.profile.setDefault"));
    // The profile that is already the default has nothing to promote.
    assert.deepEqual(promotes.map((node) => (node as HTMLButtonElement).disabled), [true, false]);
    const promote = promotes[1];
    assert.ok(promote);
    await act(async () => promote.dispatchEvent(new page.dom.window.MouseEvent("click", { bubbles: true })));
    await page.settle();
    assert.deepEqual(bodyOf(page, "PATCH", "/staffing-profiles/p-careful"), { isDefault: true });
  } finally {
    await page.dispose();
  }
});

test("duplicating a profile posts a copy of its entries under a new name", async () => {
  const page = await mountRoute("/workflows/template-1", {
    ...templateRoutes([FAST_LANE]),
    [`POST ${PROFILES_PATH}`]: { profile: FAST_LANE, warnings: [] },
  });
  try {
    await page.press(t("en", "workflows.profile.duplicate"));
    assert.deepEqual(bodyOf(page, "POST", PROFILES_PATH), {
      name: t("en", "workflows.profile.copyName", { name: "Fast lane" }),
      entries: FAST_LANE.entries,
    });
  } finally {
    await page.dispose();
  }
});

test("a refused write reaches the operator as the control plane's own message", async () => {
  const page = await mountRoute("/workflows/template-1", {
    ...templateRoutes([FAST_LANE]),
    [`POST ${PROFILES_PATH}`]: new Response(
      JSON.stringify({ error: "A profile of this template is already named that", code: "staffing_profile_name_taken" }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    ),
  });
  try {
    await page.press(t("en", "workflows.profile.duplicate"));
    assert.match(page.container.textContent ?? "", /409 A profile of this template is already named that/u);
  } finally {
    await page.dispose();
  }
});

/* --------------------------------------------------------------------- editor */

const mountEditor = async (locale: "en" | "zh", routes: PageRoutes = {}): Promise<{
  page: PageHarness;
  saves: () => number;
}> => {
  let saved = 0;
  const page = await mountPage(
    <LocaleProvider initialLocale={locale}>
      <StaffingProfileEditor template={TEMPLATE} profile={FAST_LANE} agents={AGENTS} onSaved={() => { saved += 1; }} />
    </LocaleProvider>,
    routes,
  );
  return { page, saves: () => saved };
};

for (const locale of ["en", "zh"] as const) {
  test(`the editor renders one row per step, staffable agents only, and an include toggle only on optional steps in ${locale}`, async () => {
    const { page } = await mountEditor(locale);
    try {
      const rows = page.container.querySelectorAll("[data-output-kind]");
      assert.equal(rows.length, TEMPLATE.steps.length);

      // The canonical binding is the placeholder, so a row with no opinion still
      // says who runs it today.
      const implementation = rowFor(page, "implementation");
      const options = [...implementation.querySelectorAll("option")].map((node) => node.textContent);
      assert.deepEqual(options, [
        t(locale, "workflows.editor.canonical", { name: SENIOR.title }),
        `${SENIOR.title} · Claude Opus 5 medium`,
      ]);
      assert.equal((implementation.querySelector("select") as HTMLSelectElement).value, SENIOR.id);

      // Archived and non-assignable agents are absent from every picker.
      const everyOption = [...page.container.querySelectorAll("option")].map((node) => node.textContent ?? "");
      assert.ok(!everyOption.some((label) => label.includes(RETIRED.title)));
      assert.ok(!everyOption.some((label) => label.includes(SENTINEL.title)));

      // A human step is not staffable at all.
      assert.equal(rowFor(page, "human-review").querySelector("select"), null);
      assert.ok((rowFor(page, "human-review").textContent ?? "").includes(t(locale, "workflows.editor.human")));

      const toggles = page.container.querySelectorAll('[role="switch"]');
      assert.equal(toggles.length, 1);
      assert.ok(rowFor(page, "blind-findings").contains(toggles[0] ?? null));
      assert.equal(toggles[0]?.getAttribute("aria-label"), t(locale, "workflows.editor.include.aria", { name: "Blind review" }));
    } finally {
      await page.dispose();
    }
  });
}

test("saving sends PUT with the profile name and exactly the entries the operator staffed", async () => {
  const { page, saves } = await mountEditor("en", {
    "PUT /staffing-profiles/p-fast": { profile: FAST_LANE, warnings: [] },
  });
  try {
    await selectIn(page, rowFor(page, "blind-findings"), SENIOR.id);
    const toggle = page.container.querySelector('[role="switch"]');
    assert.ok(toggle);
    await act(async () => toggle.dispatchEvent(new page.dom.window.MouseEvent("click", { bubbles: true })));
    await page.settle();

    await page.press(t("en", "workflows.editor.save"));
    assert.deepEqual(bodyOf(page, "PUT", "/staffing-profiles/p-fast"), {
      name: "Fast lane",
      entries: [
        // Untouched rows keep no opinion at all: a PUT replaces the list whole,
        // so an omitted kind means "the template's own binding stands".
        { outputKind: "implementation", assigneeAgentId: SENIOR.id, include: null },
        { outputKind: "blind-findings", assigneeAgentId: SENIOR.id, include: false },
      ],
    });
    assert.equal(saves(), 1);
  } finally {
    await page.dispose();
  }
});

test("the warnings a save answers with are shown without blocking it", async () => {
  const message = "Senior Developer both implements and reviews under this plan";
  const { page } = await mountEditor("en", {
    "PUT /staffing-profiles/p-fast": {
      profile: FAST_LANE,
      warnings: [{ code: "same_agent_implements_and_reviews", message }],
    },
  });
  try {
    await page.press(t("en", "workflows.editor.save"));
    assert.match(page.container.textContent ?? "", new RegExp(message, "u"));
  } finally {
    await page.dispose();
  }
});

test("a refused save keeps the draft and shows the refusal", async () => {
  const { page, saves } = await mountEditor("en", {
    "PUT /staffing-profiles/p-fast": new Response(
      JSON.stringify({ error: "merge-integrator binds nothing else", code: "staffing_profile_integrator_binding" }),
      { status: 422, headers: { "Content-Type": "application/json" } },
    ),
  });
  try {
    await selectIn(page, rowFor(page, "blind-findings"), SENIOR.id);
    await page.press(t("en", "workflows.editor.save"));
    assert.match(page.container.textContent ?? "", /422 merge-integrator binds nothing else/u);
    assert.equal(saves(), 0, "a refused save must not report success");
    // The draft survives the refusal, so the operator can correct it in place.
    assert.equal((rowFor(page, "blind-findings").querySelector("select") as HTMLSelectElement).value, SENIOR.id);
  } finally {
    await page.dispose();
  }
});
