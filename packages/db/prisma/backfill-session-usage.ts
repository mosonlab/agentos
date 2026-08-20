import { PrismaClient } from "@prisma/client";

import { runBackfillSessionUsageCli } from "../src/usage.js";

// Everything this script used to do lives in `runBackfillSessionUsageCli`, so a
// .dbtest can execute the scan, the summary and the exit code instead of reading
// them. What is left is exactly what a test cannot reach: the import, the client
// and the disconnect — which `usage.dbtest.ts` covers by spawning this file.
const prisma = new PrismaClient();

try {
  // NOT process.exit(1): the finally block must still $disconnect.
  process.exitCode = await runBackfillSessionUsageCli({ db: prisma });
} finally {
  await prisma.$disconnect();
}
