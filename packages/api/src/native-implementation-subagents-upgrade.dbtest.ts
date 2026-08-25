import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { PrismaClient } from "@agentos/db";

import { testDatabaseUrl } from "./testdb.js";

const targetMigration = "20260824010000_native_implementation_subagents";
const dbDirectory = fileURLToPath(new URL("../../db", import.meta.url));

test("the native-subagent migration backfills only active canonical implementation Runs", async () => {
  const base = new URL(testDatabaseUrl);
  const schema = `${base.searchParams.get("schema") ?? "public"}_native_subagents_upgrade`;
  if (schema.startsWith("public")) throw new Error("the native-subagent upgrade fixture refuses the public schema");
  base.searchParams.set("schema", schema);
  const url = base.toString();
  const quoted = `"${schema.replaceAll('"', '""')}"`;
  const staging = mkdtempSync(join(tmpdir(), "native-subagents-upgrade-fixture."));

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
    execute(`DROP SCHEMA IF EXISTS ${quoted} CASCADE; CREATE SCHEMA ${quoted};`);
    cpSync(join(dbDirectory, "prisma"), join(staging, "prisma"), { recursive: true });
    const stagedMigrations = join(staging, "prisma", "migrations");
    for (const migration of readdirSync(stagedMigrations)) {
      if (migration >= targetMigration) rmSync(join(stagedMigrations, migration), { recursive: true });
    }
    deploy();

    execute(`
      INSERT INTO "Project" ("id", "name", "slug", "updatedAt")
      VALUES ('p-native', 'native upgrade', 'native-upgrade', NOW());
      INSERT INTO "Environment" ("id", "projectId", "name", "allowedHosts", "updatedAt")
      VALUES ('e-native', 'p-native', 'env', '{}', NOW());
      INSERT INTO "Agent" (
        "id", "projectId", "environmentId", "name", "title", "model", "runnerPreference",
        "foundationalPrompt", "rolePrompt", "updatedAt"
      ) VALUES (
        'a-native', 'p-native', 'e-native', 'implementation-plan-executioner', 'Executioner',
        'gpt-5.6-sol:high', 'codex', 'foundation', 'role', NOW()
      );
      INSERT INTO "TaskTemplate" ("id", "projectId", "name", "description", "variables", "updatedAt")
      VALUES
        ('tpl-compound', 'p-native', 'compound-engineer-workflow', 'compound', '{}', NOW()),
        ('tpl-direct', 'p-native', 'direct-engineer-workflow', 'direct', '{}', NOW());
      INSERT INTO "TaskTemplateStep" (
        "id", "taskTemplateId", "assigneeAgentId", "stepIndex", "name", "assigneeType", "prompt", "outputKind"
      ) VALUES
        ('step-plan', 'tpl-compound', 'a-native', 4, 'Plan', 'agent', 'plan', 'plan'),
        ('step-compound', 'tpl-compound', 'a-native', 5, 'Implementation', 'agent', 'implement', 'implementation'),
        ('step-direct', 'tpl-direct', 'a-native', 1, 'Implementation', 'agent', 'implement', 'implementation');
      INSERT INTO "Task" (
        "id", "projectId", "assigneeAgentId", "templateId", "templateStepId", "name", "description", "status", "updatedAt"
      ) VALUES
        ('t-compound-active', 'p-native', 'a-native', 'tpl-compound', 'step-compound', 'active compound', 'work', 'doing', NOW()),
        ('t-direct-active', 'p-native', 'a-native', 'tpl-direct', 'step-direct', 'active direct', 'work', 'doing', NOW()),
        ('t-plan-active', 'p-native', 'a-native', 'tpl-compound', 'step-plan', 'active plan', 'work', 'doing', NOW()),
        ('t-compound-failed', 'p-native', 'a-native', 'tpl-compound', 'step-compound', 'failed compound', 'work', 'review', NOW());
      INSERT INTO "Run" (
        "id", "projectId", "taskId", "agentId", "runNumber", "dedupeKey", "status", "runner", "model", "promptHash", "updatedAt"
      ) VALUES
        ('r-compound-active', 'p-native', 't-compound-active', 'a-native', 1, 'task:t-compound-active:run:1', 'queued', 'codex', 'gpt-5.6-sol:high', 'hash', NOW()),
        ('r-direct-active', 'p-native', 't-direct-active', 'a-native', 1, 'task:t-direct-active:run:1', 'running', 'codex', 'gpt-5.6-luna:max', 'hash', NOW()),
        ('r-plan-active', 'p-native', 't-plan-active', 'a-native', 1, 'task:t-plan-active:run:1', 'queued', 'codex', 'gpt-5.6-sol:high', 'hash', NOW()),
        ('r-compound-failed', 'p-native', 't-compound-failed', 'a-native', 1, 'task:t-compound-failed:run:1', 'failed', 'codex', 'gpt-5.6-sol:high', 'hash', NOW()),
        ('r-direct-claude', 'p-native', 't-direct-active', 'a-native', 2, 'task:t-direct-active:run:2', 'queued', 'claude', 'claude-opus-5:medium', 'hash', NOW());
    `);

    cpSync(
      join(dbDirectory, "prisma", "migrations", targetMigration),
      join(stagedMigrations, targetMigration),
      { recursive: true },
    );
    deploy();

    const client = new PrismaClient({ datasources: { db: { url } } });
    try {
      const runs = await client.run.findMany({ orderBy: { id: "asc" } });
      assert.deepEqual(runs.map(({ id, subagentModel, subagentMaxConcurrent }) => ({
        id, subagentModel, subagentMaxConcurrent,
      })), [
        { id: "r-compound-active", subagentModel: "gpt-5.6-luna:max", subagentMaxConcurrent: 8 },
        { id: "r-compound-failed", subagentModel: null, subagentMaxConcurrent: null },
        { id: "r-direct-active", subagentModel: "gpt-5.6-luna:max", subagentMaxConcurrent: 8 },
        { id: "r-direct-claude", subagentModel: null, subagentMaxConcurrent: null },
        { id: "r-plan-active", subagentModel: null, subagentMaxConcurrent: null },
      ]);
      const columns = await client.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name IN ('Agent', 'Run') ORDER BY column_name`,
        schema,
      );
      const names = new Set(columns.map(({ column_name }) => column_name));
      assert.equal(names.has("subagentModel"), true);
      assert.equal(names.has("subagentMaxConcurrent"), true);
      for (const removed of [
        "ordinarySubprocessModel", "ordinarySubprocessCodexServiceTier",
        "elevatedSubprocessModel", "elevatedSubprocessCodexServiceTier",
        "subprocessModel", "subprocessCodexServiceTier",
      ]) assert.equal(names.has(removed), false, removed);
    } finally {
      await client.$disconnect();
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
    try {
      execute(`DROP SCHEMA IF EXISTS ${quoted} CASCADE;`);
    } catch {
      // A disposable schema that will not drop must not hide the test verdict.
    }
  }
});
