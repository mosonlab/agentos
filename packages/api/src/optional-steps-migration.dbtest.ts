import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@anneal/db";

import { testDatabaseUrl } from "./testdb.js";

const targetMigration = "20260902020000_optional_template_steps";
const dbDirectory = fileURLToPath(new URL("../../db", import.meta.url));

const execute = (url: string, sql: string): void => {
  execFileSync("npx", ["prisma", "db", "execute", "--url", url, "--stdin"], {
    cwd: dbDirectory,
    input: sql,
    stdio: ["pipe", "pipe", "pipe"],
  });
};

const deploy = (url: string, schemaPath: string): void => {
  execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", schemaPath], {
    cwd: dbDirectory,
    env: { ...process.env, DATABASE_URL: url },
    stdio: ["ignore", "pipe", "pipe"],
  });
};

test("the optional-steps migration defaults existing rows without changing chain shape", async () => {
  const base = new URL(testDatabaseUrl);
  const sourceSchema = base.searchParams.get("schema");
  assert.ok(sourceSchema && sourceSchema !== "public", "the test URL must use a dedicated schema");
  const schema = `optional_steps_upgrade_${process.pid}_${Date.now().toString(36)}`;
  base.searchParams.set("schema", schema);
  const url = base.toString();
  const quotedSchema = `"${schema.replaceAll('"', '""')}"`;
  const staging = mkdtempSync(join(tmpdir(), "agentos-optional-steps-migration."));
  const stagedPrisma = join(staging, "prisma");
  const db = new PrismaClient({ datasources: { db: { url } } });

  try {
    execute(url, `DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE; CREATE SCHEMA ${quotedSchema};`);
    cpSync(join(dbDirectory, "prisma"), stagedPrisma, { recursive: true });
    const stagedMigrations = join(stagedPrisma, "migrations");
    for (const migration of readdirSync(stagedMigrations, { withFileTypes: true })) {
      if (migration.isDirectory() && migration.name >= targetMigration) {
        rmSync(join(stagedMigrations, migration.name), { recursive: true, force: true });
      }
    }
    // Deploy the real migration history immediately before this feature.
    deploy(url, join(stagedPrisma, "schema.prisma"));

    execute(url, `
      INSERT INTO "Project" ("id", "name", "slug", "updatedAt")
      VALUES ('project-optional-upgrade', 'Optional upgrade project', 'optional-upgrade', NOW());
      INSERT INTO "TaskTemplate" ("id", "projectId", "name", "description", "variables", "updatedAt")
      VALUES ('template-optional-upgrade', 'project-optional-upgrade', 'Template', 'migration test', '{}', NOW());
      INSERT INTO "TaskTemplateStep" ("id", "taskTemplateId", "stepIndex", "name", "assigneeType", "prompt", "layer")
      VALUES ('step-optional-upgrade', 'template-optional-upgrade', 1, 'Step', 'agent'::"AssigneeType", 'migration test', 1);
      INSERT INTO "Task" ("id", "projectId", "name", "description", "status", "approvalGate", "chainId", "chainIndex", "chainLayer", "updatedAt")
      VALUES
        ('task-optional-upgrade-gated', 'project-optional-upgrade', 'Gated', 'migration test', 'done'::"TaskStatus", true, 'chain-optional-upgrade', 2, 3, NOW()),
        ('task-optional-upgrade-open', 'project-optional-upgrade', 'Open', 'migration test', 'todo'::"TaskStatus", false, 'chain-optional-upgrade', 4, 7, NOW());
    `);

    const beforeTasks = await db.task.findMany({
      where: { chainId: "chain-optional-upgrade" },
      orderBy: { chainIndex: "asc" },
      select: { id: true, approvalGate: true, chainIndex: true, chainLayer: true },
    });

    cpSync(join(dbDirectory, "prisma", "migrations", targetMigration), join(stagedMigrations, targetMigration), { recursive: true });
    deploy(url, join(stagedPrisma, "schema.prisma"));

    const project = await db.project.findUniqueOrThrow({ where: { id: "project-optional-upgrade" } });
    const step = await db.taskTemplateStep.findUniqueOrThrow({ where: { id: "step-optional-upgrade" } });
    const afterTasks = await db.task.findMany({
      where: { chainId: "chain-optional-upgrade" },
      orderBy: { chainIndex: "asc" },
      select: { id: true, approvalGate: true, chainIndex: true, chainLayer: true },
    });

    assert.equal(project.skipOptionalSteps, false);
    assert.equal(step.optional, false);
    assert.deepEqual(afterTasks, beforeTasks);
  } finally {
    await db.$disconnect();
    try { execute(url, `DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE;`); } catch { /* best-effort scratch cleanup */ }
    rmSync(staging, { recursive: true, force: true });
  }
});
