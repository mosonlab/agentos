import { PrismaClient } from "@prisma/client";

import {
  runBackfillMergeStopQuestionsCli,
  type MergeStopQuestionBackfillDatabase,
} from "../src/merge-stop-question-backfill.js";

const prisma = new PrismaClient();

try {
  // NOT process.exit(1): the finally block must still $disconnect.
  process.exitCode = await runBackfillMergeStopQuestionsCli({
    db: prisma as unknown as MergeStopQuestionBackfillDatabase,
  });
} finally {
  await prisma.$disconnect();
}
