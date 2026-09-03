import "../test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
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
