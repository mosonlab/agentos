import { PrismaClient } from "@prisma/client";

import { resolveVerifierDatabaseUrl, runVerifyStarterOnboardingCli } from "../src/verify-starter-onboarding.js";

// Everything this script decides lives in `runVerifyStarterOnboardingCli`, so a
// .dbtest can execute the checks, the report and the exit code instead of
// reading them. What is left is exactly what a test cannot reach: the import,
// the client and the disconnect.
const resolved = resolveVerifierDatabaseUrl(process.env);
if ("error" in resolved) {
  console.error(`STOP starter-onboarding ${resolved.error}`);
  process.exitCode = 1;
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: resolved.url } } });
  try {
    // NOT process.exit(1): the finally block must still $disconnect.
    process.exitCode = await runVerifyStarterOnboardingCli({ db: prisma });
  } finally {
    await prisma.$disconnect();
  }
}
