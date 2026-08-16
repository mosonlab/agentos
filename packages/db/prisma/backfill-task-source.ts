import { PrismaClient } from "@prisma/client";

import { backfillTaskSource } from "../src/task-source.js";

const prisma = new PrismaClient();

try {
  // Idempotent: re-running reports zeros rather than duplicating anything, so
  // this is safe to run again after a partial deploy.
  const result = await backfillTaskSource(prisma);
  console.log(
    `source=cron ${result.sourceCron}, source=webhook ${result.sourceWebhook}, `
    + `recurring links ${result.recurringLinked}, fires created ${result.firesCreated}`,
  );
} finally {
  await prisma.$disconnect();
}
