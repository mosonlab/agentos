import { execFileSync, execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@agentos/db";

export interface ScratchDatabaseConfig {
  sourceUrl: URL;
  maintenanceUrl: URL;
  schema: string | null;
  redactedServer: string;
}

const databaseName = (url: URL): string => decodeURIComponent(url.pathname.slice(1));
const sameServer = (left: URL, right: URL): boolean => (
  left.protocol === right.protocol && left.hostname === right.hostname && left.port === right.port
);

export const validateScratchDatabaseEnvironment = (
  environment: NodeJS.ProcessEnv,
): ScratchDatabaseConfig => {
  if (environment.AGENTOS_ALLOW_SCRATCH_DATABASES !== "1") throw new Error("scratch-database-opt-in-required");
  if (!environment.TEST_DATABASE_URL) throw new Error("scratch-test-database-url-required");
  if (!environment.TEST_DATABASE_MAINTENANCE_URL) throw new Error("scratch-maintenance-url-required");
  const sourceUrl = new URL(environment.TEST_DATABASE_URL);
  const maintenanceUrl = new URL(environment.TEST_DATABASE_MAINTENANCE_URL);
  if (!sourceUrl.protocol.startsWith("postgres") || !maintenanceUrl.protocol.startsWith("postgres")) {
    throw new Error("scratch-database-postgresql-required");
  }
  const sourceName = databaseName(sourceUrl);
  const maintenanceName = databaseName(maintenanceUrl);
  if (!sourceName || !maintenanceName || sourceName === "agentos" || maintenanceName === "agentos") {
    throw new Error("scratch-default-agentos-database-refused");
  }
  if (sourceName === maintenanceName) throw new Error("scratch-source-maintenance-must-differ");
  if (!sameServer(sourceUrl, maintenanceUrl)) throw new Error("scratch-database-server-mismatch");
  if (sourceUrl.username !== maintenanceUrl.username) throw new Error("scratch-database-role-mismatch");
  return {
    sourceUrl,
    maintenanceUrl,
    schema: sourceUrl.searchParams.get("schema"),
    redactedServer: `${sourceUrl.hostname}:${sourceUrl.port || "5432"}/${maintenanceName}`,
  };
};

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const scratchNamePattern = /^agentos_cp_a_[a-z0-9_]{8,48}$/u;

export interface ScratchDatabasePreflight {
  redactedServer: string;
  maintenanceDatabase: string;
  schema: string | null;
  role: string;
  roleCanCreateDatabase: boolean;
}

export class ScratchDatabaseManager {
  readonly config: ScratchDatabaseConfig;
  readonly allowedNames = new Set<string>();
  readonly maintenance: PrismaClient;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.config = validateScratchDatabaseEnvironment(environment);
    this.maintenance = new PrismaClient({ datasources: { db: { url: this.config.maintenanceUrl.toString() } } });
  }

  async preflight(): Promise<ScratchDatabasePreflight> {
    const [maintenanceIdentity] = await this.maintenance.$queryRawUnsafe<Array<{ role: string; rolcreatedb: boolean }>>(
      "SELECT current_user AS role, rolcreatedb FROM pg_roles WHERE rolname = current_user",
    );
    const source = new PrismaClient({ datasources: { db: { url: this.config.sourceUrl.toString() } } });
    try {
      const [sourceIdentity] = await source.$queryRawUnsafe<Array<{ role: string }>>("SELECT current_user AS role");
      if (!maintenanceIdentity || !sourceIdentity || maintenanceIdentity.role !== sourceIdentity.role) {
        throw new Error("scratch-database-effective-role-mismatch");
      }
    } finally {
      await source.$disconnect();
    }
    if (!maintenanceIdentity.rolcreatedb) throw new Error("scratch-database-role-missing-createdb");
    return {
      redactedServer: this.config.redactedServer,
      maintenanceDatabase: databaseName(this.config.maintenanceUrl),
      schema: this.config.schema,
      role: maintenanceIdentity.role,
      roleCanCreateDatabase: maintenanceIdentity.rolcreatedb,
    };
  }

  private allocateName(label: string): string {
    const normalized = label.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "_").slice(0, 12);
    const name = `agentos_cp_a_${normalized}_${process.pid}_${randomBytes(6).toString("hex")}`;
    if (!scratchNamePattern.test(name)) throw new Error("scratch-database-generated-name-invalid");
    if (this.allowedNames.has(name)) throw new Error("scratch-database-generated-name-collision");
    this.allowedNames.add(name);
    return name;
  }

  private derivedUrl(name: string): string {
    if (!this.allowedNames.has(name)) throw new Error("scratch-database-name-not-allowlisted");
    const url = new URL(this.config.sourceUrl);
    url.pathname = `/${name}`;
    return url.toString();
  }

  async createMigrated(label = "source"): Promise<{ name: string; url: string }> {
    await this.preflight();
    const name = this.allocateName(label);
    const existing = await this.maintenance.$queryRawUnsafe<Array<{ exists: boolean }>>(
      "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
      name,
    );
    if (existing[0]?.exists) throw new Error("scratch-database-target-already-exists");
    await this.maintenance.$executeRawUnsafe(`CREATE DATABASE ${quoteIdentifier(name)}`);
    const url = this.derivedUrl(name);
    const dbDirectory = fileURLToPath(new URL("../../db", import.meta.url));
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      cwd: dbDirectory,
      env: { ...process.env, DATABASE_URL: url },
      stdio: "inherit",
    });
    return { name, url };
  }

  async clone(sourceName: string, label = "copy"): Promise<{ name: string; url: string }> {
    if (!this.allowedNames.has(sourceName)) throw new Error("scratch-template-name-not-allowlisted");
    const active = await this.maintenance.$queryRawUnsafe<Array<{ count: bigint }>>(
      "SELECT count(*)::bigint AS count FROM pg_stat_activity WHERE datname = $1",
      sourceName,
    );
    if ((active[0]?.count ?? 0n) !== 0n) throw new Error("scratch-template-has-active-connections");
    const name = this.allocateName(label);
    if (name === sourceName) throw new Error("scratch-source-target-must-differ");
    const existing = await this.maintenance.$queryRawUnsafe<Array<{ exists: boolean }>>(
      "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
      name,
    );
    if (existing[0]?.exists) throw new Error("scratch-database-target-already-exists");
    await this.maintenance.$executeRawUnsafe(`CREATE DATABASE ${quoteIdentifier(name)} TEMPLATE ${quoteIdentifier(sourceName)}`);
    return { name, url: this.derivedUrl(name) };
  }

  async drop(name: string): Promise<void> {
    if (!this.allowedNames.has(name)) throw new Error("scratch-drop-name-not-allowlisted");
    if (!scratchNamePattern.test(name)) throw new Error("scratch-drop-name-invalid");
    await this.maintenance.$queryRawUnsafe(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      name,
    );
    await this.maintenance.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
    this.allowedNames.delete(name);
  }

  async disconnect(): Promise<void> {
    await this.maintenance.$disconnect();
  }
}

const defaultTestDatabaseUrl = new URL("postgresql://agentos:agentos@localhost:5432/agentos?schema=agentos_test");
// Every AgentOS workspace used to drop the same host-wide schema. The package's
// concurrency=1 flag serializes files only inside one workspace, so a sibling
// test process could still drop our tables mid-suite. Derive a stable,
// PostgreSQL-safe private schema unless the caller explicitly supplies one.
defaultTestDatabaseUrl.searchParams.set(
  "schema",
  `agentos_test_${createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16)}`,
);
export const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? defaultTestDatabaseUrl.toString();

const parsedTestDatabaseUrl = new URL(testDatabaseUrl);
export const testDatabaseSchema = parsedTestDatabaseUrl.searchParams.get("schema") ?? "public";

if (testDatabaseSchema === "public") {
  throw new Error("TEST_DATABASE_URL must name a dedicated non-public schema because the DB harness resets it");
}

let migrationsApplied = false;

/**
 * Drops and re-applies the dedicated test schema.
 *
 * This is what `prisma migrate reset` did, spelled out: drop the schema named in
 * TEST_DATABASE_URL, recreate it, then `migrate deploy`. It is written this way
 * because `migrate reset` refuses to run under an AI coding agent, which would
 * otherwise make every *.dbtest.ts unrunnable in an agent session. `deploy` is
 * non-interactive, needs no shadow database, and applies exactly the committed
 * migration folders — so this is the same reset with one fewer dependency.
 *
 * The blast radius is bounded above: the module refuses a `public` schema, so
 * the only thing this can drop is a schema created for these tests.
 */
const resetSchema = (): void => {
  const dbDirectory = fileURLToPath(new URL("../../db", import.meta.url));
  const quoted = `"${testDatabaseSchema.replaceAll('"', '""')}"`;
  execSync(
    `npx prisma db execute --url ${JSON.stringify(testDatabaseUrl)} --stdin`,
    {
      cwd: dbDirectory,
      input: `DROP SCHEMA IF EXISTS ${quoted} CASCADE; CREATE SCHEMA ${quoted};`,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  execSync("npx prisma migrate deploy", {
    cwd: dbDirectory,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    stdio: "inherit",
  });
};

export const setupTestDb = (): PrismaClient => {
  if (!migrationsApplied) {
    resetSchema();
    migrationsApplied = true;
  }
  return new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
};

export const resetTestDb = async (db: PrismaClient): Promise<void> => {
  const url = new URL(testDatabaseUrl);
  const schema = url.searchParams.get("schema") ?? "public";
  const tables = await db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = ${schema} AND tablename <> '_prisma_migrations'
  `;
  if (tables.length === 0) return;
  const quoted = tables.map(({ tablename }) => `"${tablename.replaceAll('"', '""')}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
};
