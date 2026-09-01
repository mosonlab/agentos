import { PrismaClient } from "@prisma/client";

import {
  runAuditPostDeliveryDisconnectCli,
  type PostDeliveryDisconnectAuditDatabase,
} from "../src/post-delivery-disconnect-audit.js";

const prisma = new PrismaClient();

try {
  // NOT process.exit(1): the finally block must still $disconnect.
  process.exitCode = await runAuditPostDeliveryDisconnectCli({
    db: prisma as unknown as PostDeliveryDisconnectAuditDatabase,
  });
} finally {
  await prisma.$disconnect();
}
