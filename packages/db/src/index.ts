import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  agentosPrisma?: PrismaClient;
};

export const prisma = globalForPrisma.agentosPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.agentosPrisma = prisma;
}

export * from "@prisma/client";
export * from "./workflow.js";
