import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@anneal/db";

import { testDatabaseUrl } from "./testdb.js";

const targetMigration = "20260901020000_project_gate_defaults";
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

test("the additive migration defaults existing projects without changing chain approval values", async () => {
  const base = new URL(testDatabaseUrl);
  const sourceSchema = base.searchParams.get("schema");
  assert.ok(sourceSchema && sourceSchema !== "public", "the test URL must use a dedicated schema");
  const schema = `project_gate_upgrade_${process.pid}_${Date.now().toString(36)}`;
  base.searchParams.set("schema", schema);
  const url = base.toString();
  const quotedSchema = `"${schema.replaceAll('"', '""')}"`;
  const staging = mkdtempSync(join(tmpdir(), "agentos-project-gates-migration."));
  const stagedPrisma = join(staging, "prisma");
  const db = new PrismaClient({ datasources: { db: { url } } });

  try {
    execute(url, `DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE; CREATE SCHEMA ${quotedSchema};`);
    cpSync(join(dbDirectory, "prisma"), stagedPrisma, { recursive: true });
    const stagedMigrations = join(stagedPrisma, "migrations");
    for (const migration of readdirSync(stagedMigrations)) {
      if (migration >= targetMigration) rmSync(join(stagedMigrations, migration), { recursive: true, force: true });
    }
    // This is the real deploy path against the migration history immediately
    // before this feature, rather than an in-memory schema approximation.
    deploy(url, join(stagedPrisma, "schema.prisma"));

    execute(url, `
      INSERT INTO "Project" ("id", "name", "slug", "updatedAt")
      VALUES ('project-upgrade-gates', 'Upgrade gate project', 'upgrade-gates', NOW());
      INSERT INTO "Task" ("id", "projectId", "name", "description", "status", "approvalGate", "chainId", "chainIndex", "chainLayer", "updatedAt")
      VALUES
        ('task-upgrade-gated', 'project-upgrade-gates', 'Gated task', 'preserve true', 'done'::"TaskStatus", true, 'chain-upgrade-gates', 1, 1, NOW()),
        ('task-upgrade-open', 'project-upgrade-gates', 'Open task', 'preserve false', 'todo'::"TaskStatus", false, 'chain-upgrade-gates', 2, 2, NOW());
    `);

    cpSync(join(dbDirectory, "prisma", "migrations", targetMigration), join(stagedMigrations, targetMigration), { recursive: true });
    deploy(url, join(stagedPrisma, "schema.prisma"));

    const project = await db.project.findUniqueOrThrow({ where: { id: "project-upgrade-gates" } });
    assert.deepEqual(
      { specGateDefault: project.specGateDefault, mergeGateDefault: project.mergeGateDefault },
      { specGateDefault: false, mergeGateDefault: false },
    );
    const tasks = await db.task.findMany({
      where: { chainId: "chain-upgrade-gates" },
      orderBy: { chainIndex: "asc" },
      select: { id: true, approvalGate: true },
    });
    assert.deepEqual(tasks, [
      { id: "task-upgrade-gated", approvalGate: true },
      { id: "task-upgrade-open", approvalGate: false },
    ]);
  } finally {
    await db.$disconnect();
    try { execute(url, `DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE;`); } catch { /* best-effort scratch cleanup */ }
    rmSync(staging, { recursive: true, force: true });
  }
});
