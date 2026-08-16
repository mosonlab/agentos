import { PrismaClient } from "@prisma/client";

import { recomputeSessionUsage } from "../src/usage.js";

const BATCH = 200;

const prisma = new PrismaClient();

try {
  // Every session with a terminal event, not just those whose totalTokens is
  // null: a cost-only session never gets a totalTokens, and a session whose
  // first attempt wrote columns but whose second attempt's write was lost to a
  // crash is exactly the case a backfill exists to repair. The no-write
  // comparison inside recomputeSessionUsage is what keeps a second pass honest.
  const sessions = await prisma.session.findMany({
    where: { events: { some: { type: "FINAL_OUTPUT" } } },
    select: { id: true },
    orderBy: { requestedAt: "asc" },
  });
  let updated = 0;
  for (let index = 0; index < sessions.length; index += BATCH) {
    for (const session of sessions.slice(index, index + BATCH)) {
      if (await recomputeSessionUsage(prisma, session.id)) updated += 1;
    }
  }
  console.log(`scanned ${sessions.length}, updated ${updated}`);
} finally {
  await prisma.$disconnect();
}
