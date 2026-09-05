import "../test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  templateRolloverName,
  Prisma,
  type PrismaClient,
} from "@anneal/db";

import { createApp } from "../test-app.js";
import { withTokens } from "./test-support.js";

test("template instantiate route refuses missing and malformed names before database access", async () => {
  await withTokens(async () => {
    const database = new Proxy({}, {
      get: () => { throw new Error("database must not be read for invalid name"); },
    }) as unknown as PrismaClient;
    const cases: Array<{ body: Record<string, unknown>; code: string }> = [
      { body: { repoId: "repo-1", variables: {} }, code: "instantiate_name_required" },
      { body: { repoId: "repo-1", variables: {}, name: "" }, code: "instantiate_name_required" },
      { body: { repoId: "repo-1", variables: {}, name: "   \t" }, code: "instantiate_name_required" },
      { body: { repoId: "repo-1", variables: {}, name: "x".repeat(121) }, code: "instantiate_name_invalid" },
      { body: { repoId: "repo-1", variables: {}, name: "line one\nline two" }, code: "instantiate_name_invalid" },
    ];
    for (const { body, code } of cases) {
      const response = await createApp(database).request("/projects/project-1/task-templates/template-1/instantiate", {
        method: "POST",
        headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal((await response.json() as { code?: string }).code, code, JSON.stringify(body));
    }
  });
});

test("template instantiate route maps an archived step agent to a named 400", async () => {
  await withTokens(async () => {
    const archivedAt = new Date();
    const template = {
      id: "template-1",
      name: "Template",
      variables: [],
      steps: [{
        id: "step-1", stepIndex: 1, name: "Implementation", prompt: "work", outputKind: "result",
        attachmentsFromPrevious: false, priorOutputKinds: [], assigneeType: "AGENT", assigneeAgentId: "agent-1",
        assigneeAgent: { id: "agent-1", name: "Archived Ada", archivedAt },
        approvalGate: false, opensPullRequest: true, runner: null,
      }],
    };
    const database = {
      $transaction: async (operation: (client: unknown) => Promise<unknown>) => operation({
        $queryRaw: async (query: TemplateStringsArray | Prisma.Sql) => {
          const sql = "sql" in query ? query.sql : query.join(" ");
          return sql.includes('"TaskTemplate"')
            ? [{ id: template.id, projectId: "project-1", name: template.name }]
            : [{ id: "agent-1", name: "Archived Ada", projectId: "project-1", archivedAt }];
        },
        staffingProfile: { findFirst: async () => null },
        taskTemplate: { findFirst: async () => template },
        repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
      }),
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/projects/project-1/task-templates/template-1/instantiate", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ repoId: "repo-1", variables: {}, name: "archived agent", autoStart: false }),
    });
    assert.equal(response.status, 400);
    assert.match(String((await response.json() as { error: string }).error), /Implementation.*Archived Ada.*archived/);
  });
});
test("template instantiate route rejects blank variables and invalid Git refs before database access", async () => {
  await withTokens(async () => {
    const database = new Proxy({}, {
      get: () => { throw new Error("database must not be read for invalid input"); },
    }) as unknown as PrismaClient;
    const cases = [
      { branchName: "" },
      { branchName: "   " },
      { branchName: "bad..branch" },
      { branchName: "refs/heads/main" },
      { branchName: "feature/.hidden" },
      { branchName: "feature/main.lock" },
      { branchName: "bad\nbranch" },
    ];
    for (const variables of cases) {
      const response = await createApp(database).request("/projects/project-1/task-templates/template-1/instantiate", {
        method: "POST",
        headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
        body: JSON.stringify({ repoId: "repo-1", variables, name: "branch validation", autoStart: false }),
      });
      assert.equal(response.status, 400, JSON.stringify(variables));
    }
  });
});

test("template instantiate route rejects unknown gate keys before database access", async () => {
  await withTokens(async () => {
    const database = new Proxy({}, {
      get: () => { throw new Error("database must not be read for invalid gates"); },
    }) as unknown as PrismaClient;
    const response = await createApp(database).request("/projects/project-1/task-templates/template-1/instantiate", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ repoId: "repo-1", variables: {}, name: "gate validation", gates: { spec: true, unexpected: false } }),
    });
    assert.equal(response.status, 400);
  });
});

test("template step replacement requires optional and rejects unknown fields before database access", async () => {
  await withTokens(async () => {
    const database = new Proxy({}, {
      get: () => { throw new Error("database must not be read for invalid template steps"); },
    }) as unknown as PrismaClient;
    const validStep = {
      name: "Implementation",
      assigneeType: "AGENT",
      assigneeAgentId: "agent-1",
      prompt: "work",
      approvalGate: false,
      attachmentsFromPrevious: false,
      priorOutputKinds: [],
      spawnPolicy: null,
      runner: null,
      outputKind: "implementation",
      opensPullRequest: true,
      requiresCommit: true,
      baseFromStepIndex: null,
      layer: 1,
    };
    const cases = [
      { steps: [validStep] },
      { steps: [{ ...validStep, optional: false, unexpected: true }] },
    ];
    for (const body of cases) {
      const response = await createApp(database).request("/projects/project-1/task-templates/template-1/steps", {
        method: "PUT",
        headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400, JSON.stringify(body));
    }
  });
});

test("listed and single templates carry retired, true only for a renamed retired generation", async () => {
  await withTokens(async () => {
    const row = (id: string, name: string) => ({
      id, name, projectId: "project-1", description: "", variables: [], steps: [],
    });
    const rows = [
      row("template-1", "direct-engineer-workflow"),
      row("template-2", templateRolloverName("direct-engineer-workflow", "pre-adjudication", "template-1")),
      row("template-3", "my own clone of the direct chain"),
    ];
    const database = {
      taskTemplate: {
        findMany: async () => rows,
        findUnique: async ({ where }: { where: { id: string } }) => rows.find((candidate) => candidate.id === where.id) ?? null,
      },
    } as unknown as PrismaClient;
    const app = createApp(database);
    const headers = { Authorization: "Bearer operator-unit-token" };

    const listed = await app.request("/projects/project-1/task-templates", { headers });
    assert.equal(listed.status, 200);
    const listedRows = await listed.json() as Array<{ id: string; name: string; retired: boolean }>;
    // Ordering and every other field of the row are unchanged by the new field.
    assert.deepEqual(listedRows.map((template) => template.id), ["template-1", "template-2", "template-3"]);
    assert.deepEqual(listedRows.map((template) => template.retired), [false, true, false]);
    for (const [index, listedRow] of listedRows.entries()) {
      const { retired, ...rest } = listedRow;
      assert.deepEqual(rest, rows[index]);
      assert.equal(typeof retired, "boolean");
    }

    for (const expected of rows.map((candidate, index) => ({ id: candidate.id, retired: index === 1 }))) {
      const single = await app.request(`/task-templates/${expected.id}`, { headers });
      assert.equal(single.status, 200);
      assert.equal((await single.json() as { retired: boolean }).retired, expected.retired, expected.id);
    }
  });
});

test("both template reads answer executionOwner per step from the step itself", async () => {
  await withTokens(async () => {
    // Every step binds an Agent, including the two no Agent executes: a task row
    // needs an assignee, and that binding is exactly what the field must not be
    // read as an answer to.
    const step = (stepIndex: number, name: string, outputKind: string, assigneeType = "AGENT") => ({
      id: `step-${stepIndex}`, stepIndex, name, outputKind, assigneeType,
      assigneeAgentId: "agent-1", assigneeAgent: { id: "agent-1", name: "Bound Agent" },
    });
    const rows = [{
      id: "template-1",
      name: "direct-engineer-workflow",
      projectId: "project-1",
      description: "",
      variables: [],
      steps: [
        step(1, "Implementation", "implementation"),
        step(2, "Human PR review", "human-review", "HUMAN"),
        step(6, "Merge readiness", "merge-authorization"),
        step(7, "Merge execution", "merge-result"),
      ],
    }];
    const database = {
      taskTemplate: {
        findMany: async () => rows,
        findUnique: async ({ where }: { where: { id: string } }) => rows.find((candidate) => candidate.id === where.id) ?? null,
      },
    } as unknown as PrismaClient;
    const app = createApp(database);
    const headers = { Authorization: "Bearer operator-unit-token" };
    const expected = [
      ["implementation", "agent"],
      ["human-review", "human"],
      ["merge-authorization", "control-plane"],
      ["merge-result", "merge-executor"],
    ];

    type Read = { steps: Array<{ outputKind: string; executionOwner: string; assigneeAgentId: string }> };
    const listed = await app.request("/projects/project-1/task-templates", { headers });
    assert.equal(listed.status, 200);
    const listedSteps = (await listed.json() as Read[])[0]!.steps;
    assert.deepEqual(listedSteps.map((row) => [row.outputKind, row.executionOwner]), expected);
    // The binding is reported unchanged next to the owner that contradicts it.
    assert.deepEqual([...new Set(listedSteps.map((row) => row.assigneeAgentId))], ["agent-1"]);

    const single = await app.request("/task-templates/template-1", { headers });
    assert.equal(single.status, 200);
    assert.deepEqual(
      (await single.json() as Read).steps.map((row) => [row.outputKind, row.executionOwner]),
      expected,
    );
  });
});
