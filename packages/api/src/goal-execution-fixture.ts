import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { testDatabaseUrl } from "./testdb.js";

/**
 * A disposable database staged at the migration *before* the Goal 5a0 kernel.
 *
 * Both the migration-upgrade tests and the preflight tests need the same thing:
 * a schema holding pre-kernel rows, because the preflight runs before the kernel
 * migration and the migration's own ordering can only be tested against rows
 * that existed before it. The dedicated test schema is already fully migrated,
 * so neither can use it.
 */

const dbDirectory = fileURLToPath(new URL("../../db", import.meta.url));
export const kernelMigration = "20260818000000_goal_execution_safety_kernel";
export const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

export interface PreKernelDatabase {
  url: string;
  schema: string;
  quoted: string;
  /** Runs SQL against the staged schema. */
  execute: (sql: string) => void;
  /** Applies the kernel migration through the real `prisma migrate deploy`. */
  applyKernelMigration: () => void;
  cleanup: () => void;
}

export const stageAtPreviousMigration = (label: string): PreKernelDatabase => {
  const base = new URL(testDatabaseUrl);
  const schema = `${base.searchParams.get("schema") ?? "public"}_${label}`;
  if (schema.startsWith("public")) throw new Error("the pre-kernel fixture refuses to touch the public schema");
  base.searchParams.set("schema", schema);
  const url = base.toString();
  const quoted = `"${schema.replaceAll('"', '""')}"`;

  const execute = (sql: string): void => {
    execFileSync("npx", ["prisma", "db", "execute", "--url", url, "--stdin"], {
      cwd: dbDirectory,
      input: sql,
      stdio: ["pipe", "pipe", "pipe"],
    });
  };

  execute(`DROP SCHEMA IF EXISTS ${quoted} CASCADE; CREATE SCHEMA ${quoted};`);
  const staging = mkdtempSync(join(tmpdir(), "goal5a0-fixture."));
  cpSync(join(dbDirectory, "prisma"), join(staging, "prisma"), { recursive: true });
  // This fixture is staged *before* the kernel. Remove the kernel and every
  // later migration, not just the named kernel directory: later migrations may
  // depend on constraints the pre-kernel schema intentionally does not have.
  for (const entry of readdirSync(join(staging, "prisma", "migrations"), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name >= kernelMigration) {
      rmSync(join(staging, "prisma", "migrations", entry.name), { recursive: true, force: true });
    }
  }

  const deploy = (): void => {
    execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", join(staging, "prisma", "schema.prisma")], {
      cwd: dbDirectory,
      env: { ...process.env, DATABASE_URL: url },
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  deploy();

  return {
    url,
    schema,
    quoted,
    execute,
    applyKernelMigration: () => {
      cpSync(
        join(dbDirectory, "prisma", "migrations", kernelMigration),
        join(staging, "prisma", "migrations", kernelMigration),
        { recursive: true },
      );
      deploy();
    },
    cleanup: () => {
      rmSync(staging, { recursive: true, force: true });
      try {
        execute(`DROP SCHEMA IF EXISTS ${quoted} CASCADE;`);
      } catch {
        // A test schema that will not drop must not fail the suite.
      }
    },
  };
};

/** Pre-kernel history: a Task carried no Goal link, only its Runs did. */
export const preKernelSeed = `
  INSERT INTO "Project" ("id", "name", "slug", "updatedAt")
  VALUES ('p-up', 'upgrade', 'upgrade', NOW());
  INSERT INTO "Environment" ("id", "projectId", "name", "updatedAt")
  VALUES ('e-up', 'p-up', 'env', NOW());
  INSERT INTO "Agent" ("id", "projectId", "environmentId", "name", "title", "model",
                       "foundationalPrompt", "rolePrompt", "updatedAt")
  VALUES ('a-up', 'p-up', 'e-up', 'agent', 'Agent', 'claude', '', '', NOW());
  INSERT INTO "Goal" ("id", "projectId", "title", "spec", "updatedAt")
  VALUES ('g-up', 'p-up', 'Goal', 'a secret-looking spec string', NOW());
  INSERT INTO "Task" ("id", "projectId", "name", "description", "status", "createdAt", "updatedAt")
  VALUES ('t-old', 'p-up', 'first', 'a secret-looking description', 'done', '2026-08-01T00:00:00Z', NOW()),
         ('t-new', 'p-up', 'second', 'desc', 'done', '2026-08-02T00:00:00Z', NOW());
`;

export const preKernelRun = (
  id: string, taskId: string | null, goalId: string | null, runNumber: number, status = "succeeded",
): string => `
  INSERT INTO "Run" ("id", "projectId", "taskId", "agentId", "goalId", "runNumber", "dedupeKey",
                     "runner", "model", "promptHash", "status", "updatedAt")
  VALUES ('${id}', 'p-up', ${taskId === null ? "NULL" : `'${taskId}'`}, 'a-up',
          ${goalId === null ? "NULL" : `'${goalId}'`}, ${runNumber}, 'dedupe:${id}',
          'claude', 'claude', 'hash', '${status}', NOW());`;
