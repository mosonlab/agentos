import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  enqueueTaskRun,
  LEGACY_ALL_PRIOR_OUTPUTS,
  loadAgentSources,
  loadAllTemplateStepSources,
  PrismaClient,
  RunStatus,
  TaskStatus,
} from "@agentos/db";

import { createApp } from "./test-app.js";
import { testDatabaseUrl } from "./testdb.js";

const targetMigration = "20260827000000_prior_output_kinds";
const dbDirectory = fileURLToPath(new URL("../../db", import.meta.url));
const RUNNER_TOKEN = "prior-outputs-upgrade-runner-token";

test("the whitelist migration preserves legacy claims and canonical sync adopts current declarations", async () => {
  const base = new URL(testDatabaseUrl);
  const sourceSchema = base.searchParams.get("schema");
  if (!sourceSchema || sourceSchema === "public") throw new Error("prior-output upgrade fixture refuses public schema");
  const schema = `prior_outputs_upgrade_${process.pid}_${Date.now().toString(36)}`;
  base.searchParams.set("schema", schema);
  const url = base.toString();
  const quotedSchema = `"${schema.replaceAll('"', '""')}"`;
  const staging = mkdtempSync(join(tmpdir(), "prior-outputs-upgrade-fixture."));
  const priorRunnerToken = process.env.RUNNER_TOKEN;

  const execute = (sql: string): void => {
    execFileSync("npx", ["prisma", "db", "execute", "--url", url, "--stdin"], {
      cwd: dbDirectory,
      input: sql,
      stdio: ["pipe", "pipe", "pipe"],
    });
  };
  const deploy = (): void => {
    execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", join(staging, "prisma", "schema.prisma")], {
      cwd: dbDirectory,
      env: { ...process.env, DATABASE_URL: url },
      stdio: ["ignore", "pipe", "pipe"],
    });
  };

  try {
    execute(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE; CREATE SCHEMA ${quotedSchema};`);
    cpSync(join(dbDirectory, "prisma"), join(staging, "prisma"), { recursive: true });
    const stagedMigrations = join(staging, "prisma", "migrations");
    for (const migration of readdirSync(stagedMigrations)) {
      if (migration >= targetMigration) rmSync(join(stagedMigrations, migration), { recursive: true, force: true });
    }
    deploy();

    const [agentSources, templateSources] = await Promise.all([loadAgentSources(), loadAllTemplateStepSources()]);
    const preMigration = new PrismaClient({ datasources: { db: { url } } });
    try {
      await preMigration.$executeRawUnsafe(
        `INSERT INTO "Project" ("id", "name", "slug", "updatedAt") VALUES ($1, $2, $3, NOW())`,
        "project-upgrade", "Upgrade fixture", "agentos-example",
      );
      await preMigration.$executeRawUnsafe(
        `INSERT INTO "Environment" ("id", "projectId", "name", "allowedHosts", "updatedAt") VALUES ($1, $2, $3, $4, NOW())`,
        "environment-upgrade", "project-upgrade", "Upgrade environment", [],
      );
      await preMigration.$executeRawUnsafe(
        `INSERT INTO "Repo" ("id", "projectId", "name", "remoteUrl", "mountPath", "updatedAt") VALUES ($1, $2, $3, $4, $5, NOW())`,
        "repo-upgrade", "project-upgrade", "Upgrade repo", "https://example.test/upgrade.git", "/repo",
      );

      const agentIds = new Map<string, string>();
      for (const [index, role] of agentSources.roles.entries()) {
        const id = `agent-upgrade-${index + 1}`;
        agentIds.set(role.name, id);
        await preMigration.$executeRawUnsafe(
          `INSERT INTO "Agent" (
            "id", "projectId", "environmentId", "name", "title", "model", "runnerPreference",
            "inboxAccess", "foundationalPrompt", "rolePrompt", "updatedAt"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7::"RunnerPreference", $8, $9, $10, NOW())`,
          id, "project-upgrade", "environment-upgrade", role.name, role.title, role.model,
          role.runnerPreference.toLowerCase(), role.inboxAccess, agentSources.foundationalPrompt, role.rolePrompt,
        );
        await preMigration.$executeRawUnsafe(
          `INSERT INTO "AgentRepoAccess" ("agentId", "repoId", "projectId", "mountPath", "permissions")
           VALUES ($1, $2, $3, $4, 'git-write'::"RepoPermission")`,
          id, "repo-upgrade", "project-upgrade", "/repo",
        );
      }
      for (const role of agentSources.roles) {
        for (const collaborator of role.collaborators) {
          await preMigration.$executeRawUnsafe(
            `INSERT INTO "AgentCollaboration" ("agentId", "allowedAgentId", "projectId") VALUES ($1, $2, $3)`,
            agentIds.get(role.name), agentIds.get(collaborator), "project-upgrade",
          );
        }
      }

      for (const [templateName, steps] of templateSources) {
        const templateId = `template-${templateName}`;
        await preMigration.$executeRawUnsafe(
          `INSERT INTO "TaskTemplate" ("id", "projectId", "name", "description", "variables", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          templateId, "project-upgrade", templateName, "Canonical upgrade fixture", ["branchName"],
        );
        for (const step of steps) {
          await preMigration.$executeRawUnsafe(
            `INSERT INTO "TaskTemplateStep" (
              "id", "taskTemplateId", "assigneeAgentId", "stepIndex", "name", "assigneeType", "prompt",
              "approvalGate", "attachmentsFromPrevious", "spawnPolicy", "outputKind", "opensPullRequest",
              "baseFromStepIndex", "layer"
            ) VALUES ($1, $2, $3, $4, $5, $6::"AssigneeType", $7, $8, $9, $10::jsonb, $11, $12, $13, $14)`,
            `${templateId}-step-${step.stepIndex}`, templateId,
            step.agentName ? agentIds.get(step.agentName) : null, step.stepIndex, `Step ${step.stepIndex}`,
            step.agentName ? "agent" : "human", step.prompt, step.approvalGate,
            step.attachmentsFromPrevious, step.spawnPolicy === null ? null : JSON.stringify(step.spawnPolicy),
            step.outputKind, step.opensPullRequest, step.baseFromStepIndex, step.layer,
          );
        }
      }

      await preMigration.$executeRawUnsafe(
        `INSERT INTO "TaskTemplate" ("id", "projectId", "name", "description", "variables", "updatedAt")
         VALUES ('template-legacy', 'project-upgrade', 'legacy-custom-workflow', 'Legacy fixture', '{}', NOW())`,
      );
      for (const [index, outputKind] of ["legacy-spec", "legacy-plan", "legacy-target"].entries()) {
        await preMigration.$executeRawUnsafe(
          `INSERT INTO "TaskTemplateStep" (
            "id", "taskTemplateId", "assigneeAgentId", "stepIndex", "name", "assigneeType", "prompt", "outputKind", "layer"
          ) VALUES ($1, 'template-legacy', $2, $3, $4, 'agent', $5, $6, $3)`,
          `legacy-step-${index + 1}`, agentIds.get("senior-dev"), index + 1,
          `Legacy step ${index + 1}`, `legacy prompt ${index + 1}`, outputKind,
        );
      }

      const taskRows = [
        ["current-spec-task", "template-compound-engineer-workflow", "template-compound-engineer-workflow-step-1", "current-chain", 1, 1, "done", agentIds.get("spec")],
        ["current-plan-task", "template-compound-engineer-workflow", "template-compound-engineer-workflow-step-2", "current-chain", 2, 2, "todo", agentIds.get("plan")],
        ["legacy-spec-task", "template-legacy", "legacy-step-1", "legacy-chain", 1, 1, "done", agentIds.get("senior-dev")],
        ["legacy-plan-task", "template-legacy", "legacy-step-2", "legacy-chain", 2, 2, "done", agentIds.get("senior-dev")],
        ["legacy-target-task", "template-legacy", "legacy-step-3", "legacy-chain", 3, 3, "todo", agentIds.get("senior-dev")],
      ] as const;
      for (const [id, templateId, templateStepId, chainId, chainIndex, chainLayer, status, agentId] of taskRows) {
        await preMigration.$executeRawUnsafe(
          `INSERT INTO "Task" (
            "id", "projectId", "assigneeAgentId", "repoId", "templateId", "templateStepId", "name", "description",
            "status", "targetBranch", "chainId", "chainIndex", "chainLayer", "updatedAt"
          ) VALUES ($1, 'project-upgrade', $2, 'repo-upgrade', $3, $4, $5, $5, $6::"TaskStatus", 'feature/upgrade', $7, $8, $9, NOW())`,
          id, agentId, templateId, templateStepId, id, status, chainId, chainIndex, chainLayer,
        );
      }
      for (const [taskId, kind, body] of [
        ["current-spec-task", "spec", "current-spec-marker"],
        ["legacy-spec-task", "legacy-spec", "legacy-spec-marker"],
        ["legacy-plan-task", "legacy-plan", "legacy-plan-marker"],
      ]) {
        await preMigration.$executeRawUnsafe(
          `INSERT INTO "TaskStepOutput" ("id", "taskId", "kind", "body", "updatedAt") VALUES ($1, $2, $3, $4, NOW())`,
          `output-${taskId}`, taskId, kind, body,
        );
      }
    } finally {
      await preMigration.$disconnect();
    }

    cpSync(join(dbDirectory, "prisma", "migrations", targetMigration), join(stagedMigrations, targetMigration), { recursive: true });
    deploy();
    const synced = spawnSync("npx", ["tsx", "prisma/sync-canonical-prompts.ts"], {
      cwd: dbDirectory,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: url },
    });
    assert.equal(synced.status, 0, `${synced.stdout ?? ""}${synced.stderr ?? ""}`);

    process.env.RUNNER_TOKEN = RUNNER_TOKEN;
    const db = new PrismaClient({ datasources: { db: { url } } });
    try {
      const currentPlan = await db.taskTemplateStep.findUniqueOrThrow({
        where: { taskTemplateId_stepIndex: { taskTemplateId: "template-compound-engineer-workflow", stepIndex: 2 } },
      });
      const legacyTarget = await db.taskTemplateStep.findUniqueOrThrow({
        where: { taskTemplateId_stepIndex: { taskTemplateId: "template-legacy", stepIndex: 3 } },
      });
      assert.deepEqual(currentPlan.priorOutputKinds, ["spec"]);
      assert.deepEqual(legacyTarget.priorOutputKinds, [LEGACY_ALL_PRIOR_OUTPUTS]);

      const claim = () => createApp(db).request("/runner/tasks/claim", {
        method: "POST",
        headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ runnerId: "prior-outputs-upgrade-runner", leaseSeconds: 60 }),
      });

      const currentRun = await db.$transaction((tx) => enqueueTaskRun(tx, "current-plan-task"));
      let response = await claim();
      let body = await response.json() as { run: { id: string }; priorOutputs: Array<{ kind: string; body: string }> };
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.run.id, currentRun.id);
      assert.deepEqual(body.priorOutputs.map(({ kind }) => kind), ["spec"]);
      assert.deepEqual(body.priorOutputs.map(({ body: outputBody }) => outputBody), ["current-spec-marker"]);
      await db.run.update({ where: { id: currentRun.id }, data: { status: RunStatus.SUCCEEDED, endedAt: new Date() } });
      await db.task.update({ where: { id: "current-plan-task" }, data: { status: TaskStatus.DONE } });

      const legacyRun = await db.$transaction((tx) => enqueueTaskRun(tx, "legacy-target-task"));
      response = await claim();
      body = await response.json() as typeof body;
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.run.id, legacyRun.id);
      assert.deepEqual(body.priorOutputs.map(({ kind }) => kind), ["legacy-spec", "legacy-plan"]);
      assert.deepEqual(body.priorOutputs.map(({ body: outputBody }) => outputBody), ["legacy-spec-marker", "legacy-plan-marker"]);
    } finally {
      await db.$disconnect();
    }
  } finally {
    if (priorRunnerToken === undefined) delete process.env.RUNNER_TOKEN;
    else process.env.RUNNER_TOKEN = priorRunnerToken;
    rmSync(staging, { recursive: true, force: true });
    try {
      execute(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE;`);
    } catch {
      // A disposable schema that will not drop must not hide the test verdict.
    }
  }
});
