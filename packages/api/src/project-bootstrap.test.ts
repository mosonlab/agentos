import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  Prisma,
  PR_TEMPLATE_NAME,
  RunnerPreference,
  type AgentSources,
  type PrismaClient,
  type TemplateStepSource,
} from "@anneal/db";

import {
  createProjectBootstrap,
  defaultProjectBootstrapLoaders,
  type ProjectBootstrapLoaders,
  PROJECT_BOOTSTRAP_ROLE_NAMES,
  PROJECT_SLUG_TAKEN,
  PROJECT_SLUG_TAKEN_MESSAGE,
} from "./project-bootstrap.js";
import { createApp } from "./test-app.js";

const input = { name: "New Project", slug: "new-project", yamlDocument: "" };

const agentSources = (): AgentSources => ({
  foundationalPrompt: "foundation",
  roles: PROJECT_BOOTSTRAP_ROLE_NAMES.map((name) => ({
    name,
    title: `${name} title`,
    model: `${name}-model`,
    runnerPreference: RunnerPreference.CODEX,
    inboxAccess: false,
    collaborators: [],
    rolePrompt: `${name} prompt`,
  })),
});

const templateSteps = (): TemplateStepSource[] => PROJECT_BOOTSTRAP_ROLE_NAMES.map((agentName, index) => ({
  stepIndex: index + 1,
  name: `Step ${index + 1}`,
  layer: index + 1,
  agentName,
  approvalGate: false,
  outputKind: `output-${index + 1}`,
  attachmentsFromPrevious: false,
  priorOutputKinds: [],
  opensPullRequest: false,
  requiresCommit: false,
  provisionDependencies: true,
  baseFromStepIndex: null,
  spawnPolicy: null,
  prompt: `Prompt ${index + 1}`,
}));

const loaders = (overrides: Partial<ProjectBootstrapLoaders> = {}): ProjectBootstrapLoaders => ({
  loadAgentSources: async () => agentSources(),
  loadAllTemplateStepSources: async () => new Map([[PR_TEMPLATE_NAME, templateSteps()]]),
  ...overrides,
});

const transactionOnly = (error?: unknown): PrismaClient => ({
  $transaction: async () => {
    if (error) throw error;
    throw new Error("transaction must not be opened");
  },
} as unknown as PrismaClient);

test("the release template loader reads only the PR workflow needed by project bootstrap", async () => {
  const sources = await defaultProjectBootstrapLoaders.loadAllTemplateStepSources();
  assert.deepEqual([...sources.keys()], [PR_TEMPLATE_NAME]);
  assert.equal(sources.get(PR_TEMPLATE_NAME)?.length, 4);
});

test("project input validation runs before source loaders and the transaction", async () => {
  let loaderCalls = 0;
  let transactionCalls = 0;
  const database = {
    $transaction: async () => {
      transactionCalls += 1;
      throw new Error("unexpected transaction");
    },
  } as unknown as PrismaClient;
  await assert.rejects(
    () => createProjectBootstrap(database, { ...input, name: "" }, {
      loadAgentSources: async () => { loaderCalls += 1; return agentSources(); },
      loadAllTemplateStepSources: async () => { loaderCalls += 1; return new Map([[PR_TEMPLATE_NAME, templateSteps()]]); },
    }),
    /Too small/u,
  );
  assert.equal(loaderCalls, 0);
  assert.equal(transactionCalls, 0);
});

test("project bootstrap validates source inventories before opening its transaction", async () => {
  let transactionCalls = 0;
  const database = {
    $transaction: async () => {
      transactionCalls += 1;
      throw new Error("unexpected transaction");
    },
  } as unknown as PrismaClient;

  await assert.rejects(
    () => createProjectBootstrap(database, input, loaders({
      loadAgentSources: async () => ({ foundationalPrompt: "foundation", roles: [] }),
    })),
    /senior-dev-luna/u,
  );
  assert.equal(transactionCalls, 0);

  await assert.rejects(
    () => createProjectBootstrap(database, input, loaders({
      loadAllTemplateStepSources: async () => new Map(),
    })),
    /pr-engineer-workflow/u,
  );
  assert.equal(transactionCalls, 0);

  await assert.rejects(
    () => createProjectBootstrap(database, input, loaders({
      loadAllTemplateStepSources: async () => new Map([[PR_TEMPLATE_NAME, templateSteps().map((step, index) => (
        index === 3 ? { ...step, agentName: "replacement-review-fixer" } : step
      ))]]),
    })),
    /role set/u,
  );
  assert.equal(transactionCalls, 0);
});

test("a source-loader failure is raised before any transaction can write", async () => {
  let transactionCalls = 0;
  const database = {
    $transaction: async () => {
      transactionCalls += 1;
      throw new Error("unexpected transaction");
    },
  } as unknown as PrismaClient;
  await assert.rejects(
    () => createProjectBootstrap(database, input, loaders({
      loadAgentSources: async () => { throw new Error("role source unavailable"); },
    })),
    /role source unavailable/u,
  );
  await assert.rejects(
    () => createProjectBootstrap(database, input, loaders({
      loadAllTemplateStepSources: async () => { throw new Error("template source unavailable"); },
    })),
    /template source unavailable/u,
  );
  assert.equal(transactionCalls, 0);
});

test("P2002 and P2034 become the stable project-slug-taken result without retry", async () => {
  for (const code of ["P2002", "P2034"] as const) {
    const error = new Prisma.PrismaClientKnownRequestError("project conflict", {
      code,
      clientVersion: "6.19.0",
    });
    const result = await createProjectBootstrap(transactionOnly(error), input, loaders());
    assert.deepEqual(result, {
      ok: false,
      code: PROJECT_SLUG_TAKEN,
      message: PROJECT_SLUG_TAKEN_MESSAGE,
    });
  }
});

test("the project route maps bootstrap slug conflicts to 409", async () => {
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "operator-project-bootstrap-unit-token";
  try {
    for (const code of ["P2002", "P2034"] as const) {
      const error = new Prisma.PrismaClientKnownRequestError("project conflict", {
        code,
        clientVersion: "6.19.0",
      });
      const response = await createApp(transactionOnly(error), {
        workspaceRoot: mkdtempSync(join(tmpdir(), "anneal-project-bootstrap-route-")),
        projectBootstrapLoaders: loaders(),
      }).request("/projects", {
        method: "POST",
        headers: {
          Authorization: "Bearer operator-project-bootstrap-unit-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error: PROJECT_SLUG_TAKEN_MESSAGE,
        code: PROJECT_SLUG_TAKEN,
      });
    }
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = prior;
  }
});
