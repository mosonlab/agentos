/**
 * The internal seed's template graphs are installed atomically.
 *
 * Requires a scratch PostgreSQL server. It creates and drops its own schema
 * and never touches an existing one.
 *
 *   AGENTOS_ALLOW_SCRATCH_DATABASES=1 \
 *   TEST_DATABASE_URL=postgresql://...:55777/...?schema=... \
 *     npm run test:db -w @agentos/db -- src/seed-template-steps.dbtest.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { PrismaClient } from "@prisma/client";

const packageRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/+$/u, "");

const scratchServer = (): URL => {
  if (process.env["AGENTOS_ALLOW_SCRATCH_DATABASES"] !== "1") throw new Error("scratch-database-opt-in-required");
  const raw = process.env["TEST_DATABASE_URL"];
  if (!raw) throw new Error("scratch-test-database-url-required");
  const url = new URL(raw);
  if (!url.protocol.startsWith("postgres")) throw new Error("scratch-database-postgresql-required");
  if ((url.port || "5432") === "5432") throw new Error("scratch-database-refuses-port-5432");
  return url;
};

const server = scratchServer();
const schema = `seed_template_steps_${randomBytes(4).toString("hex")}`;
const databaseUrl = (() => {
  const url = new URL(server.href);
  url.searchParams.set("schema", schema);
  return url.href;
})();
const command = (args: string[]) => {
  const result = spawnSync("npx", args, {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

let prisma: PrismaClient;

before(async () => {
  const migrated = command(["prisma", "migrate", "deploy"]);
  assert.equal(migrated.status, 0, migrated.output);
  const seeded = command(["tsx", "prisma/seed.ts"]);
  assert.equal(seeded.status, 0, seeded.output);
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.$connect();
});

after(async () => {
  await prisma?.$disconnect();
  const admin = new PrismaClient({ datasources: { db: { url: server.href } } });
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await admin.$disconnect();
  }
});

test("seed rolls back template creation and earlier steps when a later step fails", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const direct = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "direct-engineer-workflow" } },
    select: { id: true },
  });
  await prisma.taskTemplate.delete({ where: { id: direct.id } });

  const suffix = randomBytes(4).toString("hex");
  const functionName = `seed_template_steps_fail_${suffix}`;
  const triggerName = `seed_template_steps_fail_${suffix}`;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."stepIndex" = 4 AND EXISTS (
          SELECT 1 FROM "TaskTemplate"
          WHERE "id" = NEW."taskTemplateId"
            AND "name" = 'direct-engineer-workflow'
        ) THEN
          RAISE EXCEPTION 'injected template-step seed failure';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT OR UPDATE ON "TaskTemplateStep"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"();
    `);

    const failed = command(["tsx", "prisma/seed.ts"]);
    assert.notEqual(failed.status, 0, failed.output);
    assert.match(failed.output, /injected template-step seed failure/u);

    const rolledBack = await prisma.taskTemplate.findUnique({
      where: { projectId_name: { projectId: project.id, name: "direct-engineer-workflow" } },
      include: { steps: true },
    });
    assert.equal(rolledBack, null);
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "TaskTemplateStep"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
  }
});
