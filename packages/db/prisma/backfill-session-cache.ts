import { PrismaClient } from "@prisma/client";

import {
  runBackfillSessionCacheUsageCli,
  type SessionCacheBackfillDatabase,
} from "../src/session-cache-backfill.js";

// The generated client on a release-tail checkout predates the nullable
// cache-creation column. The maintenance module owns the narrow compatible
// interface and the deployed client supplies the field at runtime.
const prisma = new PrismaClient();

try {
  // NOT process.exit(1): the finally block must still $disconnect.
  process.exitCode = await runBackfillSessionCacheUsageCli({
    db: prisma as unknown as SessionCacheBackfillDatabase,
  });
} finally {
  await prisma.$disconnect();
}
