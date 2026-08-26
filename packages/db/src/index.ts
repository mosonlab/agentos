import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  agentosPrisma?: PrismaClient;
};

export const prisma = globalForPrisma.agentosPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.agentosPrisma = prisma;
}

export * from "@prisma/client";
export * from "./chain-branch.js";
export * from "./maintenance-lock.js";
export * from "./service-maintenance-lock.js";
export * from "./deploy-barrier.js";
export * from "./merge-integrator.js";
export * from "./merge-integrator-db.js";
export * from "./merge-tail.js";
export * from "./merge-tail-markers.js";
// Narrow on purpose: the release-authority module reads the filesystem at import
// time, and only the attested file's name is wanted outside the release path.
export { RELEASE_AUTHORITY_FILE } from "./release-authority.js";
export * from "./release-authority-coverage.js";
export * from "./workflow.js";
export * from "./usage.js";
export * from "./cost.js";
export * from "./task-source.js";
export * from "./failure-envelope.js";
export * from "./agent-sources.js";
export * from "./agent-contract.js";
export * from "./template-sources.js";
export * from "./canonical-template-transition.js";
export * from "./verify-starter-onboarding.js";
