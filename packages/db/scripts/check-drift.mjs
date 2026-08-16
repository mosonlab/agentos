import { spawnSync } from "node:child_process";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required and must point at the migrated schema to check");
  process.exit(2);
}

const result = spawnSync("npx", [
  "prisma", "migrate", "diff", "--from-url", databaseUrl,
  "--to-schema-datamodel", "prisma/schema.prisma", "--exit-code",
], { cwd: new URL("..", import.meta.url), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "inherit" });

if (result.error) throw result.error;
process.exit(result.status ?? 1);
